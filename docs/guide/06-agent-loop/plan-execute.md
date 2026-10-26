---
title: Plan-and-Execute
description: 先让模型制定完整计划，再逐步执行，必要时重新规划。理解它和 ReAct 的取舍，并动手实现一个最小版本。
---

# Plan-and-Execute

::: info 学习目标
- 理解 Plan-and-Execute 的三个角色：Planner、Executor、Replanner
- 知道它相比 ReAct 解决了什么问题、又引入了什么新问题
- 用结构化输出实现一个"规划 → 执行 → 汇总"的最小 Agent
- 能判断一个任务该用 ReAct 还是 Plan-and-Execute
:::

## ReAct 的短板

[ReAct](/guide/06-agent-loop/react) 是"走一步看一步"：每一轮只决定下一个动作。对于三五步就能完成的任务，这很灵活。但任务一长，问题就出来了：

- 目光短浅。模型每次只关注眼前一步，容易在细枝末节上反复打转，忘了整体目标。
- 每一步都要用最强的模型。因为每一轮既要理解全局又要决定动作，没法把简单步骤交给便宜的模型。
- 难以审查。用户只能等 Agent 跑完才知道它做了什么，中途无法确认"你打算怎么做"。

Plan-and-Execute 的思路来自人类做项目的方式：先列计划，再按计划执行，执行中发现计划不对就调整。这一思想在 Plan-and-Solve（Wang et al., 2023）等研究中被系统讨论过，后来被 LangGraph 等框架做成了标准模式。

## 三个角色

```text
 task ──► Planner ──► plan = [step1, step2, step3]
                           │
                           ▼
              ┌──► Executor(step_i, previous results) ──► result_i
              │                                              │
              │                                              ▼
              └──── remaining steps ◄──── Replanner(task, plan, results)
                                                │
                                                └──► done? ──► final answer
```

| 角色 | 输入 | 输出 | 模型选择 |
| --- | --- | --- | --- |
| Planner | 用户任务 | 有序的步骤列表（结构化 JSON） | 推理能力强的模型 |
| Executor | 单个步骤 + 之前步骤的结果 | 这一步的结果 | 可以用便宜的模型；复杂步骤内部可以是一个 ReAct Agent |
| Replanner | 原任务 + 原计划 + 已完成结果 | 新的剩余步骤，或者最终答案 | 同 Planner |

Replanner 是可选的。很多实际系统只做"规划一次 + 顺序执行 + 汇总"，遇到失败再触发重新规划。

## 动手实现

下面实现一个最小的 Plan-and-Execute：Planner 用 JSON 模式输出计划，程序校验格式；Executor 逐步执行，每一步都能看到前面步骤的结果；最后由一次汇总调用整合成完整答案。

为了把注意力放在结构上，这里的 Executor 只是一次普通的模型调用。真实系统里，Executor 通常是一个带工具的 Agent，也就是把 [不用框架手写 Agent](/guide/06-agent-loop/handwritten-agent) 里的 `run_agent` 放进来。

`response_format={"type": "json_object"}` 是 OpenAI 兼容接口中常见的 JSON 模式，使用时提示词里需要出现 "JSON" 字样；各厂商支持程度不同，以官方文档为准。更严格的做法见 [结构化输出与 JSON Schema](/guide/04-prompt/structured-output)。

::: code-group
```python [Python]
import json
import os

from openai import OpenAI

client = OpenAI(api_key=os.environ["OPENAI_API_KEY"],
                base_url=os.getenv("OPENAI_BASE_URL") or None, timeout=120)
MODEL = os.getenv("LLM_MODEL", "gpt-4o-mini")
MAX_PLAN_STEPS = 6

PLANNER = """你是任务规划器。把用户任务拆成 2~6 个按顺序执行的步骤，每个步骤一句话，可以独立完成。
只输出 JSON，格式：{"steps": ["步骤1", "步骤2"]}"""
EXECUTOR = "你是执行者。只完成【当前步骤】，直接输出这一步的产出，不要提前做后面的步骤。"
SYNTHESIZER = "你是汇总者。根据各步骤的产出，为用户整理出一份完整、连贯的最终答复。"


def llm(system: str, user: str, json_mode: bool = False) -> str:
    extra = {"response_format": {"type": "json_object"}} if json_mode else {}
    resp = client.chat.completions.create(
        model=MODEL,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        **extra,
    )
    return resp.choices[0].message.content or ""


def make_plan(task: str) -> list[str]:
    raw = llm(PLANNER, task, json_mode=True)
    data = json.loads(raw)
    steps = data.get("steps") if isinstance(data, dict) else None
    if not isinstance(steps, list) or not steps or not all(isinstance(s, str) and s.strip() for s in steps):
        raise ValueError(f"计划格式不合法：{raw}")
    return steps[:MAX_PLAN_STEPS]  # 不信任模型给的长度，硬性截断


def format_done(done: list[tuple[str, str]]) -> str:
    return "\n\n".join(f"[{i}] {s}\n产出：{r}" for i, (s, r) in enumerate(done, 1)) or "（无）"


def plan_and_execute(task: str) -> str:
    steps = make_plan(task)
    print("计划：\n" + "\n".join(f"  {i}. {s}" for i, s in enumerate(steps, 1)))
    done: list[tuple[str, str]] = []
    for i, step in enumerate(steps, 1):
        prompt = f"总任务：{task}\n\n已完成的步骤：\n{format_done(done)}\n\n【当前步骤】{step}"
        result = llm(EXECUTOR, prompt)
        print(f"\n--- 步骤 {i} 完成：{step}\n{result[:200]}")
        done.append((step, result))
    return llm(SYNTHESIZER, f"总任务：{task}\n\n各步骤产出：\n{format_done(done)}")


if __name__ == "__main__":
    print("\n=== 最终答复 ===\n" + plan_and_execute("为一个 5 人后端团队制定一份引入 Code Review 的两周推行方案"))
```

```go [Go]
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

const maxPlanSteps = 6

const (
	planner = `你是任务规划器。把用户任务拆成 2~6 个按顺序执行的步骤，每个步骤一句话，可以独立完成。
只输出 JSON，格式：{"steps": ["步骤1", "步骤2"]}`
	executor    = "你是执行者。只完成【当前步骤】，直接输出这一步的产出，不要提前做后面的步骤。"
	synthesizer = "你是汇总者。根据各步骤的产出，为用户整理出一份完整、连贯的最终答复。"
)

var httpClient = &http.Client{Timeout: 120 * time.Second}

func llm(system, user string, jsonMode bool) (string, error) {
	base := os.Getenv("OPENAI_BASE_URL")
	if base == "" {
		base = "https://api.openai.com/v1"
	}
	model := os.Getenv("LLM_MODEL")
	if model == "" {
		model = "gpt-4o-mini"
	}
	payload := map[string]any{"model": model, "messages": []map[string]string{
		{"role": "system", "content": system}, {"role": "user", "content": user}}}
	if jsonMode {
		payload["response_format"] = map[string]string{"type": "json_object"}
	}
	body, _ := json.Marshal(payload)
	req, err := http.NewRequest("POST", strings.TrimRight(base, "/")+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+os.Getenv("OPENAI_API_KEY"))
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("HTTP %d: %s", resp.StatusCode, data)
	}
	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(data, &out); err != nil || len(out.Choices) == 0 {
		return "", fmt.Errorf("无法解析响应: %s", data)
	}
	return out.Choices[0].Message.Content, nil
}

func makePlan(task string) ([]string, error) {
	raw, err := llm(planner, task, true)
	if err != nil {
		return nil, err
	}
	var plan struct {
		Steps []string `json:"steps"`
	}
	if err := json.Unmarshal([]byte(raw), &plan); err != nil || len(plan.Steps) == 0 {
		return nil, fmt.Errorf("计划格式不合法：%s", raw)
	}
	for _, s := range plan.Steps {
		if strings.TrimSpace(s) == "" {
			return nil, fmt.Errorf("计划包含空步骤：%s", raw)
		}
	}
	if len(plan.Steps) > maxPlanSteps { // 不信任模型给的长度，硬性截断
		plan.Steps = plan.Steps[:maxPlanSteps]
	}
	return plan.Steps, nil
}

type done struct{ step, result string }

func formatDone(ds []done) string {
	if len(ds) == 0 {
		return "（无）"
	}
	parts := make([]string, len(ds))
	for i, d := range ds {
		parts[i] = fmt.Sprintf("[%d] %s\n产出：%s", i+1, d.step, d.result)
	}
	return strings.Join(parts, "\n\n")
}

func planAndExecute(task string) (string, error) {
	steps, err := makePlan(task)
	if err != nil {
		return "", err
	}
	fmt.Println("计划：")
	for i, s := range steps {
		fmt.Printf("  %d. %s\n", i+1, s)
	}
	var results []done
	for i, step := range steps {
		prompt := fmt.Sprintf("总任务：%s\n\n已完成的步骤：\n%s\n\n【当前步骤】%s", task, formatDone(results), step)
		result, err := llm(executor, prompt, false)
		if err != nil {
			return "", fmt.Errorf("步骤 %d 失败: %w", i+1, err)
		}
		preview := []rune(result)
		if len(preview) > 200 {
			preview = preview[:200]
		}
		fmt.Printf("\n--- 步骤 %d 完成：%s\n%s\n", i+1, step, string(preview))
		results = append(results, done{step, result})
	}
	return llm(synthesizer, fmt.Sprintf("总任务：%s\n\n各步骤产出：\n%s", task, formatDone(results)), false)
}

func main() {
	answer, err := planAndExecute("为一个 5 人后端团队制定一份引入 Code Review 的两周推行方案")
	if err != nil {
		fmt.Fprintln(os.Stderr, "出错:", err)
		os.Exit(1)
	}
	fmt.Println("\n=== 最终答复 ===\n" + answer)
}
```

```java [Java]
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.stream.Collectors;
import java.util.stream.IntStream;

public class PlanExecute {
    static final int MAX_PLAN_STEPS = 6;
    static final ObjectMapper JSON = new ObjectMapper();
    static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();

    static final String PLANNER = """
            你是任务规划器。把用户任务拆成 2~6 个按顺序执行的步骤，每个步骤一句话，可以独立完成。
            只输出 JSON，格式：{"steps": ["步骤1", "步骤2"]}""";
    static final String EXECUTOR = "你是执行者。只完成【当前步骤】，直接输出这一步的产出，不要提前做后面的步骤。";
    static final String SYNTHESIZER = "你是汇总者。根据各步骤的产出，为用户整理出一份完整、连贯的最终答复。";

    record Done(String step, String result) {}

    static String llm(String system, String user, boolean jsonMode) throws Exception {
        String base = Objects.requireNonNullElse(System.getenv("OPENAI_BASE_URL"), "https://api.openai.com/v1");
        Map<String, Object> payload = new HashMap<>();
        payload.put("model", Objects.requireNonNullElse(System.getenv("LLM_MODEL"), "gpt-4o-mini"));
        payload.put("messages", List.of(Map.of("role", "system", "content", system),
                Map.of("role", "user", "content", user)));
        if (jsonMode) payload.put("response_format", Map.of("type", "json_object"));
        HttpRequest req = HttpRequest.newBuilder(URI.create(base.replaceAll("/+$", "") + "/chat/completions"))
                .timeout(Duration.ofSeconds(120))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + System.getenv("OPENAI_API_KEY"))
                .POST(HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(payload))).build();
        HttpResponse<String> resp = HTTP.send(req, HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() != 200) throw new RuntimeException("HTTP " + resp.statusCode() + ": " + resp.body());
        return JSON.readTree(resp.body()).path("choices").path(0).path("message").path("content").asText("");
    }

    static List<String> makePlan(String task) throws Exception {
        String raw = llm(PLANNER, task, true);
        JsonNode steps = JSON.readTree(raw).path("steps");
        if (!steps.isArray() || steps.isEmpty()) throw new IllegalStateException("计划格式不合法：" + raw);
        List<String> plan = new ArrayList<>();
        for (JsonNode s : steps) {
            if (!s.isTextual() || s.asText().isBlank()) throw new IllegalStateException("计划包含非法步骤：" + raw);
            if (plan.size() < MAX_PLAN_STEPS) plan.add(s.asText()); // 不信任模型给的长度，硬性截断
        }
        return plan;
    }

    static String formatDone(List<Done> done) {
        if (done.isEmpty()) return "（无）";
        return IntStream.range(0, done.size())
                .mapToObj(i -> "[" + (i + 1) + "] " + done.get(i).step() + "\n产出：" + done.get(i).result())
                .collect(Collectors.joining("\n\n"));
    }

    static String planAndExecute(String task) throws Exception {
        List<String> steps = makePlan(task);
        System.out.println("计划：");
        for (int i = 0; i < steps.size(); i++) System.out.printf("  %d. %s%n", i + 1, steps.get(i));
        List<Done> done = new ArrayList<>();
        for (int i = 0; i < steps.size(); i++) {
            String step = steps.get(i);
            String prompt = "总任务：" + task + "\n\n已完成的步骤：\n" + formatDone(done) + "\n\n【当前步骤】" + step;
            String result = llm(EXECUTOR, prompt, false);
            System.out.printf("%n--- 步骤 %d 完成：%s%n%s%n", i + 1, step,
                    result.substring(0, Math.min(200, result.length())));
            done.add(new Done(step, result));
        }
        return llm(SYNTHESIZER, "总任务：" + task + "\n\n各步骤产出：\n" + formatDone(done), false);
    }

    public static void main(String[] args) throws Exception {
        System.out.println("\n=== 最终答复 ===\n" + planAndExecute("为一个 5 人后端团队制定一份引入 Code Review 的两周推行方案"));
    }
}
```
:::

一次运行的输出大致如下（内容因模型而异，已截断）：

```text
计划：
  1. 分析 5 人后端团队引入 Code Review 的目标与常见阻力
  2. 制定 Code Review 规范：PR 大小、响应时限、评论分级
  3. 设计第一周的试点安排
  4. 设计第二周的全员推广与复盘安排
  5. 列出衡量推行效果的指标

--- 步骤 1 完成：分析 5 人后端团队引入 Code Review 的目标与常见阻力
目标：减少线上缺陷、促进知识共享……阻力：担心拖慢交付、评论引发摩擦……
……
=== 最终答复 ===
# 两周 Code Review 推行方案
……
```

### 代码里的几个关键点

- 计划必须校验。模型可能返回空列表、非字符串元素，甚至 20 个步骤。解析失败直接报错，步骤数量硬性截断，这是给 Agent 设置预算的一种形式。
- Executor 只看"当前步骤 + 已完成结果"。它不需要也不应该重新思考整体计划，这让它可以用更便宜、更快的模型。
- 已完成结果会越来越长。步骤多时要对前面的产出做摘要，而不是全部原文塞进去，见 [压缩与摘要](/guide/07-context-engineering/compression)。
- 计划可以先给人看。在执行前把计划展示给用户确认，是 Plan-and-Execute 最实用的副产品，参见 [权限控制与人在环路](/guide/15-production/permissions-hitl)。

## 加上重新规划

上面的实现"一条路走到黑"。如果第 2 步发现前提不成立（比如查到团队已经在用 Code Review），后面的步骤就白做了。加入 Replanner 后，每执行完一步都让模型决定：

```text
输入：原任务 + 原计划 + 已完成步骤及结果
输出（JSON，二选一）：
  {"action": "continue", "steps": ["修订后的剩余步骤", ...]}
  {"action": "finish",   "answer": "最终答案"}
```

实现上只需要把 `for step in steps` 改成 `while steps:`，每轮执行 `steps.pop(0)` 后调用 Replanner 更新 `steps`。代价是每一步多一次强模型调用，所以常见的折中是：只在步骤失败或结果明显偏离预期时才触发重新规划，并且限制总的重新规划次数。

## ReAct 还是 Plan-and-Execute

| 维度 | ReAct | Plan-and-Execute |
| --- | --- | --- |
| 决策方式 | 每一步临场决定 | 先全局规划，再逐步执行 |
| 适合任务 | 短任务、探索性任务、下一步依赖上一步结果 | 长任务、步骤相对可预期的任务 |
| 成本 | 每一步都用同一个模型 | 规划用强模型，执行可以用便宜模型 |
| 可审查性 | 只能事后看轨迹 | 执行前就能审查计划 |
| 应对意外 | 天然灵活 | 需要 Replanner，否则僵化 |
| 典型失败 | 原地打转、忘记目标 | 计划脱离实际、步骤之间信息丢失 |

实践中两者经常组合：外层 Plan-and-Execute 管全局，每个步骤内部用一个 ReAct Agent 去调用工具完成。很多 Coding Agent 先输出待办列表再逐项完成，就是这种组合，见 [Coding Agent 原理](/guide/13-coding-agent/coding-agents)。

## 常见坑

- 计划过细或过粗。过细（十几步）让成本和延迟成倍增加，过粗（"第一步：完成任务"）等于没规划。在提示词里明确步骤数量范围，并给一个示例。
- 规划时缺少信息。Planner 没有工具，只能凭想象规划，计划可能建立在错误前提上。可以先让一个 ReAct 步骤收集背景信息，再规划。
- 步骤之间信息断裂。Executor 只看到步骤描述，不知道前面做了什么。务必把前序结果（或摘要）传进去。
- 把计划当作不可违背的指令。执行中发现计划不对仍然照做，结果离题。至少要允许"失败时重新规划"。
- 不校验结构化输出。直接 `json.loads` 后取 `["steps"]`，模型一旦返回格式稍有不同就崩溃。

## 小测

1. Plan-and-Execute 为什么可以降低成本？

::: details 查看答案
规划和执行被拆开了：只有 Planner（和 Replanner）需要强推理能力，Executor 只需要完成一个明确的小步骤，可以换成更便宜、更快的模型。而 ReAct 的每一轮都要理解全局并决策，通常只能全程使用同一个强模型。
:::

2. 任务是"排查一个线上接口偶发超时的原因"，你会选 ReAct 还是 Plan-and-Execute？为什么？

::: details 查看答案
更适合 ReAct（或以 ReAct 为主）。排查是探索性的：下一步查什么完全取决于上一步看到了什么日志或指标，事先很难列出靠谱的计划。硬要先规划，计划很快就会和实际情况脱节，需要频繁重新规划。
:::

3. 不加 Replanner 的 Plan-and-Execute 有什么风险？怎样低成本地缓解？

::: details 查看答案
风险是计划一旦基于错误前提，后续步骤会全部偏离，且没有纠正机会。低成本的缓解：执行前让用户确认计划；只在步骤失败或结果触发某些条件时才调用 Replanner；限制重新规划的次数以控制成本。
:::

## 延伸阅读

- [ReAct：推理与行动](/guide/06-agent-loop/react)
- [Reflection 自我反思](/guide/06-agent-loop/reflection)
- [LangGraph](/guide/11-frameworks/langgraph)：用图结构实现 Planner / Executor / Replanner
- [Plan-and-Solve Prompting（arXiv）](https://arxiv.org/abs/2305.04091)

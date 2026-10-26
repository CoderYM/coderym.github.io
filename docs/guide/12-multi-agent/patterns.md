---
title: 编排模式：主从、流水线、交接、辩论
description: 四种最常用的多 Agent 编排拓扑，以及不依赖框架的主从（Orchestrator-Worker）实现。
---

# 编排模式：主从、流水线、交接、辩论

::: info 学习目标
- 掌握四种常用编排模式：主从、流水线、交接、辩论，以及它们各自的适用场景
- 不依赖任何框架，用 Python / Go / Java 实现一个可运行的主从（Orchestrator-Worker）系统
- 理解"子任务必须自包含"、并发上限、单点失败隔离这几个工程细节
- 能根据任务特征选择合适的拓扑
:::

多 Agent 系统的差异，主要在 **谁决定下一步交给谁**，以及 **信息怎么流动**。下面四种模式覆盖了绝大多数实际系统。开始前建议先读 [为什么需要多 Agent](/guide/12-multi-agent/why-multi-agent)，确认你的任务确实值得拆。

## 四种模式一览

| 模式 | 谁决定流程 | 信息流 | 适合 | 主要风险 |
| --- | --- | --- | --- | --- |
| 主从（Orchestrator-Worker） | 主 Agent 动态拆分 | 星型：主 → 从 → 主 | 可并行的调研、批量分析 | 拆分质量决定上限；汇总丢信息 |
| 流水线（Pipeline） | 代码写死顺序 | 线性：A → B → C | 步骤固定的内容生产 | 错误逐级放大 |
| 交接（Handoff） | 当前 Agent 决定转交 | 接力：控制权转移 | 客服分流、多领域助手 | 来回踢皮球、上下文断裂 |
| 辩论（Debate） | 轮次由代码控制 | 多方互评 + 裁判 | 高风险判断、方案评审 | 成本高、可能趋同 |

## 主从模式（Orchestrator-Worker）

```text
                    ┌───────────────────────┐
     用户任务  ───▶ │  Orchestrator（主）     │
                    │  1. 拆分成子任务         │
                    └──┬─────────┬─────────┬┘
              子任务 s1 │   s2    │    s3   │      并发执行
                    ┌──▼──┐   ┌──▼──┐   ┌──▼──┐
                    │Worker│   │Worker│   │Worker│  各自独立上下文
                    └──┬──┘   └──┬──┘   └──┬──┘
                结果 r1 │   r2    │    r3   │
                    ┌──▼─────────▼─────────▼┐
                    │  Orchestrator（主）     │
                    │  2. 汇总成最终答案       │ ───▶ 最终输出
                    └───────────────────────┘
```

主从模式是多 Agent 里性价比最高的一种。它的流程只有三步：

1. **规划（Plan）**：主 Agent 读用户任务，输出一组 JSON 格式的子任务。
2. **执行（Execute）**：每个子任务交给一个 Worker，并发运行。Worker 只看到自己的子任务说明，看不到原始任务和其他 Worker。
3. **汇总（Synthesize）**：主 Agent 读取所有 Worker 的结果，写出最终答案。

有几个设计点直接决定效果：

- **子任务必须自包含。** Worker 看不到原始任务，所以子任务说明里要写清目标、范围、输出格式。"调研一下第二个数据库"这种指令，Worker 根本不知道第二个是谁。规划提示词里要明确要求这一点。
- **校验规划输出。** 规划结果是模型生成的 JSON，必须校验字段和数量上限，防止模型一口气拆出 50 个子任务把预算烧光。
- **限制并发。** 用信号量或固定大小线程池控制同时在跑的 Worker 数，避免触发厂商限流（429）。
- **失败隔离。** 单个 Worker 失败时记录失败信息，而不是让整个任务崩溃。汇总时把"哪个子任务失败了"告诉主 Agent，让它在答案里如实说明。

下面的实现为了聚焦编排逻辑，Worker 只是一次 LLM 调用。实际系统里，Worker 通常是一个带工具的完整 Agent 循环（比如能搜索网页），把 `chat` 换成 [手写 Agent](/guide/06-agent-loop/handwritten-agent) 里的循环即可。

环境变量：`OPENAI_API_KEY`、`OPENAI_BASE_URL`（可选）、`LLM_MODEL`。规划步骤使用了 `response_format: json_object`（JSON 模式），大多数 OpenAI 兼容厂商都支持，个别不支持的可以去掉该参数，靠提示词约束输出。

::: code-group
```python [Python]
import asyncio
import json
import os

from openai import AsyncOpenAI

client = AsyncOpenAI(
    api_key=os.environ["OPENAI_API_KEY"],
    base_url=os.getenv("OPENAI_BASE_URL") or None,
    timeout=60,
)
MODEL = os.getenv("LLM_MODEL", "gpt-4o-mini")
MAX_SUBTASKS = 5
MAX_CONCURRENCY = 3

PLANNER_PROMPT = """你是任务编排者。把用户任务拆成 2~5 个可以独立并行完成的子任务。
每个子任务必须自包含：写清目标、范围和期望的输出格式，因为执行者看不到原始任务。
只输出 JSON：{"subtasks": [{"id": "s1", "instruction": "..."}]}"""

WORKER_PROMPT = "你是一名研究员，只完成分配给你的子任务。输出不超过 300 字的要点，不确定的内容要标注。"

SYNTH_PROMPT = "你是总编。根据各子任务的结果，写出完整、结构清晰的最终答案。若结果之间有矛盾，明确指出。"


async def chat(system: str, user: str, json_mode: bool = False) -> str:
    kwargs = {"response_format": {"type": "json_object"}} if json_mode else {}
    resp = await client.chat.completions.create(
        model=MODEL,
        messages=[{"role": "system", "content": system},
                  {"role": "user", "content": user}],
        temperature=0.3,
        **kwargs,
    )
    return resp.choices[0].message.content or ""


async def plan(task: str) -> list[dict]:
    raw = await chat(PLANNER_PROMPT, task, json_mode=True)
    data = json.loads(raw)
    subtasks = data.get("subtasks", [])
    # 校验模型输出：类型、数量上限、字段齐全
    valid = [s for s in subtasks
             if isinstance(s, dict) and isinstance(s.get("instruction"), str)]
    if not valid:
        raise ValueError("planner 没有返回有效子任务")
    return valid[:MAX_SUBTASKS]


async def run_worker(sub: dict, sem: asyncio.Semaphore) -> dict:
    async with sem:  # 限制并发，避免触发限流
        try:
            result = await chat(WORKER_PROMPT, sub["instruction"])
            return {"id": sub.get("id"), "ok": True, "result": result}
        except Exception as e:  # 单个 worker 失败不拖垮整体
            return {"id": sub.get("id"), "ok": False, "result": f"失败：{e}"}


async def orchestrate(task: str) -> str:
    subtasks = await plan(task)
    print(f"拆分出 {len(subtasks)} 个子任务")
    sem = asyncio.Semaphore(MAX_CONCURRENCY)
    results = await asyncio.gather(*(run_worker(s, sem) for s in subtasks))

    report = "\n\n".join(
        f"## 子任务 {r['id']}（{'成功' if r['ok'] else '失败'}）\n"
        f"指令：{s['instruction']}\n结果：{r['result']}"
        for s, r in zip(subtasks, results)
    )
    return await chat(SYNTH_PROMPT, f"原始任务：{task}\n\n{report}")


if __name__ == "__main__":
    task = "对比 Milvus、Qdrant、pgvector 三个向量数据库的索引类型、部署方式和适用场景"
    print(asyncio.run(orchestrate(task)))
```

```go [Go]
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	maxSubtasks    = 5
	maxConcurrency = 3
	plannerPrompt  = `你是任务编排者。把用户任务拆成 2~5 个可以独立并行完成的子任务。
每个子任务必须自包含：写清目标、范围和期望的输出格式，因为执行者看不到原始任务。
只输出 JSON：{"subtasks": [{"id": "s1", "instruction": "..."}]}`
	workerPrompt = "你是一名研究员，只完成分配给你的子任务。输出不超过 300 字的要点，不确定的内容要标注。"
	synthPrompt  = "你是总编。根据各子任务的结果，写出完整、结构清晰的最终答案。若结果之间有矛盾，明确指出。"
)

var httpClient = &http.Client{Timeout: 60 * time.Second}

type message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatRequest struct {
	Model          string            `json:"model"`
	Messages       []message         `json:"messages"`
	Temperature    float64           `json:"temperature"`
	ResponseFormat map[string]string `json:"response_format,omitempty"`
}

type chatResponse struct {
	Choices []struct {
		Message message `json:"message"`
	} `json:"choices"`
}

type subtask struct {
	ID          string `json:"id"`
	Instruction string `json:"instruction"`
}

type result struct {
	ID     string
	OK     bool
	Output string
}

func chat(ctx context.Context, system, user string, jsonMode bool) (string, error) {
	baseURL := os.Getenv("OPENAI_BASE_URL")
	if baseURL == "" {
		baseURL = "https://api.openai.com/v1"
	}
	model := os.Getenv("LLM_MODEL")
	if model == "" {
		model = "gpt-4o-mini"
	}
	req := chatRequest{
		Model:       model,
		Messages:    []message{{"system", system}, {"user", user}},
		Temperature: 0.3,
	}
	if jsonMode {
		req.ResponseFormat = map[string]string{"type": "json_object"}
	}
	body, err := json.Marshal(req)
	if err != nil {
		return "", err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		strings.TrimRight(baseURL, "/")+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+os.Getenv("OPENAI_API_KEY"))

	resp, err := httpClient.Do(httpReq)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 10<<20))
	if err != nil {
		return "", err
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("HTTP %d: %s", resp.StatusCode, data)
	}
	var cr chatResponse
	if err := json.Unmarshal(data, &cr); err != nil {
		return "", err
	}
	if len(cr.Choices) == 0 {
		return "", errors.New("empty choices")
	}
	return cr.Choices[0].Message.Content, nil
}

func plan(ctx context.Context, task string) ([]subtask, error) {
	raw, err := chat(ctx, plannerPrompt, task, true)
	if err != nil {
		return nil, err
	}
	var parsed struct {
		Subtasks []subtask `json:"subtasks"`
	}
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return nil, fmt.Errorf("planner 输出不是合法 JSON: %w", err)
	}
	var valid []subtask
	for _, s := range parsed.Subtasks {
		if strings.TrimSpace(s.Instruction) != "" {
			valid = append(valid, s)
		}
	}
	if len(valid) == 0 {
		return nil, errors.New("planner 没有返回有效子任务")
	}
	if len(valid) > maxSubtasks {
		valid = valid[:maxSubtasks]
	}
	return valid, nil
}

func orchestrate(ctx context.Context, task string) (string, error) {
	subtasks, err := plan(ctx, task)
	if err != nil {
		return "", err
	}
	fmt.Printf("拆分出 %d 个子任务\n", len(subtasks))

	results := make([]result, len(subtasks))
	sem := make(chan struct{}, maxConcurrency) // 限制并发
	var wg sync.WaitGroup
	for i, s := range subtasks {
		wg.Add(1)
		go func(i int, s subtask) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			out, err := chat(ctx, workerPrompt, s.Instruction, false)
			if err != nil { // 单个 worker 失败不拖垮整体
				results[i] = result{s.ID, false, "失败：" + err.Error()}
				return
			}
			results[i] = result{s.ID, true, out}
		}(i, s)
	}
	wg.Wait()

	var sb strings.Builder
	for i, r := range results {
		status := "成功"
		if !r.OK {
			status = "失败"
		}
		fmt.Fprintf(&sb, "## 子任务 %s（%s）\n指令：%s\n结果：%s\n\n",
			r.ID, status, subtasks[i].Instruction, r.Output)
	}
	return chat(ctx, synthPrompt, "原始任务："+task+"\n\n"+sb.String(), false)
}

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	task := "对比 Milvus、Qdrant、pgvector 三个向量数据库的索引类型、部署方式和适用场景"
	answer, err := orchestrate(ctx, task)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
	fmt.Println(answer)
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
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class Orchestrator {
    static final int MAX_SUBTASKS = 5;
    static final int MAX_CONCURRENCY = 3;
    static final String PLANNER_PROMPT = """
            你是任务编排者。把用户任务拆成 2~5 个可以独立并行完成的子任务。
            每个子任务必须自包含：写清目标、范围和期望的输出格式，因为执行者看不到原始任务。
            只输出 JSON：{"subtasks": [{"id": "s1", "instruction": "..."}]}""";
    static final String WORKER_PROMPT = "你是一名研究员，只完成分配给你的子任务。输出不超过 300 字的要点，不确定的内容要标注。";
    static final String SYNTH_PROMPT = "你是总编。根据各子任务的结果，写出完整、结构清晰的最终答案。若结果之间有矛盾，明确指出。";

    static final ObjectMapper MAPPER = new ObjectMapper();
    static final HttpClient HTTP = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10)).build();

    record Message(String role, String content) {}
    record Subtask(String id, String instruction) {}
    record Result(String id, boolean ok, String output) {}

    static String chat(String system, String user, boolean jsonMode) throws Exception {
        String baseUrl = Objects.requireNonNullElse(System.getenv("OPENAI_BASE_URL"), "https://api.openai.com/v1");
        String model = Objects.requireNonNullElse(System.getenv("LLM_MODEL"), "gpt-4o-mini");
        Map<String, Object> body = new HashMap<>();
        body.put("model", model);
        body.put("messages", List.of(new Message("system", system), new Message("user", user)));
        body.put("temperature", 0.3);
        if (jsonMode) body.put("response_format", Map.of("type", "json_object"));

        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(baseUrl.replaceAll("/+$", "") + "/chat/completions"))
                .timeout(Duration.ofSeconds(60))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + System.getenv("OPENAI_API_KEY"))
                .POST(HttpRequest.BodyPublishers.ofString(MAPPER.writeValueAsString(body)))
                .build();
        HttpResponse<String> resp = HTTP.send(req, HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() != 200) {
            throw new RuntimeException("HTTP " + resp.statusCode() + ": " + resp.body());
        }
        return MAPPER.readTree(resp.body()).path("choices").path(0).path("message").path("content").asText();
    }

    static List<Subtask> plan(String task) throws Exception {
        JsonNode root = MAPPER.readTree(chat(PLANNER_PROMPT, task, true));
        List<Subtask> valid = new ArrayList<>();
        for (JsonNode n : root.path("subtasks")) {
            String instruction = n.path("instruction").asText("");
            if (!instruction.isBlank() && valid.size() < MAX_SUBTASKS) {
                valid.add(new Subtask(n.path("id").asText("s" + (valid.size() + 1)), instruction));
            }
        }
        if (valid.isEmpty()) throw new IllegalStateException("planner 没有返回有效子任务");
        return valid;
    }

    static String orchestrate(String task) throws Exception {
        List<Subtask> subtasks = plan(task);
        System.out.println("拆分出 " + subtasks.size() + " 个子任务");

        // 固定大小线程池即并发上限
        ExecutorService pool = Executors.newFixedThreadPool(MAX_CONCURRENCY);
        try {
            List<CompletableFuture<Result>> futures = subtasks.stream()
                    .map(s -> CompletableFuture.supplyAsync(() -> {
                        try {
                            return new Result(s.id(), true, chat(WORKER_PROMPT, s.instruction(), false));
                        } catch (Exception e) { // 单个 worker 失败不拖垮整体
                            return new Result(s.id(), false, "失败：" + e.getMessage());
                        }
                    }, pool))
                    .toList();

            StringBuilder report = new StringBuilder();
            for (int i = 0; i < subtasks.size(); i++) {
                Result r = futures.get(i).join();
                report.append("## 子任务 ").append(r.id()).append(r.ok() ? "（成功）" : "（失败）")
                        .append("\n指令：").append(subtasks.get(i).instruction())
                        .append("\n结果：").append(r.output()).append("\n\n");
            }
            return chat(SYNTH_PROMPT, "原始任务：" + task + "\n\n" + report, false);
        } finally {
            pool.shutdown();
        }
    }

    public static void main(String[] args) throws Exception {
        String task = "对比 Milvus、Qdrant、pgvector 三个向量数据库的索引类型、部署方式和适用场景";
        System.out.println(orchestrate(task));
    }
}
```
:::

Python 版本使用 `AsyncOpenAI` 配合 `asyncio.gather` 并发；Go 版本用 goroutine 加带缓冲 channel 做信号量；Java 版本用固定大小线程池加 `CompletableFuture`。三个版本的结构完全一致，可以对照阅读。

### 让主 Agent 决定"要不要再派一轮"

上面的实现是"拆一次、跑一轮、汇总"。更强的版本会让主 Agent 在汇总前先判断信息是否足够，不够就再规划一轮子任务，形成循环。这时一定要加 **轮数上限** 和 **Token 预算**，否则很容易无限派活。预算控制的做法见 [多 Agent 的坑与成本控制](/guide/12-multi-agent/pitfalls)。

## 流水线模式（Pipeline）

```text
  输入 ──▶ ┌────────┐ ──▶ ┌────────┐ ──▶ ┌────────┐ ──▶ ┌────────┐ ──▶ 输出
           │ 大纲    │     │ 撰写    │     │ 审校    │     │ 排版    │
           └────────┘     └────────┘     └───┬────┘     └────────┘
                                ▲            │ 不合格（最多 N 次）
                                └────────────┘
```

流水线的顺序由代码写死，每个 Agent 只负责一步，上一步的输出就是下一步的输入。严格说这更接近 [Workflow](/guide/00-intro/agent-vs-workflow)，只是每一步内部可能是一个带工具的 Agent。

适合步骤稳定、每步职责清晰的任务，比如"抓取资料 → 写初稿 → 事实核查 → 改写风格"。要点：

- **每步之间加校验关卡（gate）。** 例如审校步骤输出 `{"pass": false, "issues": [...]}`，不通过就带着问题退回撰写步骤，并限制最大返工次数。
- **传结构化数据。** 步骤之间传 JSON 而不是自由文本，下游更容易校验。
- **警惕错误放大。** 第一步的大纲偏了，后面每一步都在错误基础上加工。关键的早期步骤值得用更强的模型。

## 交接模式（Handoff）

```text
                 ┌───────────────┐
   用户 ───────▶ │  分流 Agent     │
                 └──┬─────────┬──┘
     transfer_to_   │         │  transfer_to_
       billing      │         │   tech_support
              ┌─────▼───┐ ┌───▼────────┐
              │ 账单 Agent│ │ 技术支持 Agent│ ──▶ 直接回复用户
              └─────────┘ └────────────┘
                  │  transfer_to_tech_support（必要时再转）
                  └──────────────▶
```

交接模式里没有中心调度者。当前 Agent 判断问题超出自己的职责时，调用一个特殊工具（通常命名为 `transfer_to_xxx`）把 **控制权** 交给另一个 Agent，由接手的 Agent 继续和用户对话。OpenAI Agents SDK 的 handoffs 就是这个思路，见 [Claude Agent SDK 与 OpenAI Agents SDK](/guide/11-frameworks/agent-sdks)。

实现上，交接就是一次工具调用：工具的执行逻辑不是调外部 API，而是把"当前活跃 Agent"切换掉，然后用新 Agent 的系统提示词和工具集继续循环。要点：

- **交接时传什么上下文。** 通常把对话历史整体带过去，或者由前一个 Agent 写一段交接摘要。只传摘要会丢信息，整体带过去会把无关内容也带过去，要按场景取舍。
- **防止来回踢皮球。** 记录交接次数，超过阈值就转人工。
- **职责边界写进系统提示词。** 每个 Agent 都要清楚"什么情况该转给谁"。

## 辩论模式（Debate）

```text
             ┌──────────┐        ┌──────────┐
   问题 ───▶ │ 正方 Agent │ ◀────▶ │ 反方 Agent │   第 1..N 轮：
             └────┬─────┘  互评   └────┬─────┘   读对方观点，修正自己
                  │                   │
                  └────────┬──────────┘
                      ┌────▼─────┐
                      │ 裁判 Agent │ ──▶ 最终结论 + 理由
                      └──────────┘
```

多个 Agent 对同一问题独立给出答案，然后互相阅读、批评、修正，最后由裁判 Agent（或投票）给出结论。它是 [Reflection](/guide/06-agent-loop/reflection) 的多方版本。

适合需要多角度审视的高风险判断：方案评审、合同风险识别、代码安全审查。要点：

- **给不同 Agent 不同的立场或视角。** 比如一个专注安全、一个专注性能。同一个提示词跑三遍，得到的往往是三份相似的答案。
- **固定轮数。** 一般 1~2 轮就足够，轮数多了 Agent 容易互相附和，观点趋同。
- **裁判要看证据，不看票数。** 让裁判基于各方给出的具体理由判断，而不是简单多数表决。

成本是辩论模式最大的问题：N 个 Agent、M 轮，至少是 N×M+1 次调用。只在错误代价很高的环节使用。

## 如何选择

```text
子任务能并行、彼此独立？ ──是──▶ 主从
        │否
步骤顺序固定、可预先写死？ ──是──▶ 流水线
        │否
需要按用户意图转给不同领域的专家？ ──是──▶ 交接
        │否
单次判断错误代价很高、需要多方审视？ ──是──▶ 辩论
        │否
        └──▶ 回到单 Agent
```

真实系统经常组合使用：外层是流水线，其中"调研"一步内部是主从，"审校"一步内部是辩论。

## 常见坑

- **子任务不自包含。** 规划出来的子任务引用了"上面提到的""第二个"，Worker 看不懂。在规划提示词里明确要求，并在汇总前检查结果是否答非所问。
- **子任务互相重叠。** 两个 Worker 调研了同一件事，浪费成本还产生矛盾。规划提示词里要求"子任务之间不重叠"，并写明各自边界。
- **不校验规划 JSON。** 模型偶尔会返回空列表、缺字段或几十个子任务。必须做类型校验和数量截断。
- **无并发上限。** 一次 `gather` 发出 20 个请求，很容易触发 429。用信号量限流，并参考 [计费、限流与错误重试](/guide/03-llm-api/cost-errors) 加重试。
- **一个失败全盘失败。** Worker 异常要在 Worker 内部捕获，转成失败结果交给汇总步骤。

## 小测

1. 主从模式中，为什么要求"子任务必须自包含"？

::: details 查看答案
Worker 拥有独立上下文，只能看到分配给自己的子任务说明，看不到原始任务和其他子任务。如果子任务描述依赖外部上下文（"第二个方案""上面提到的"），Worker 无法正确理解，产出就会偏离。
:::

2. 客服系统需要根据用户问题转给账单、技术、售后三类专员继续对话，适合哪种模式？和主从模式的关键区别是什么？

::: details 查看答案
交接模式。关键区别在于控制权：交接模式中控制权转移给接手的 Agent，由它直接与用户继续对话；主从模式中主 Agent 始终掌握控制权，Worker 只返回结果给主 Agent。
:::

3. 辩论模式中三个 Agent 用完全相同的提示词和模型，效果通常不好，为什么？

::: details 查看答案
相同的提示词和模型往往产出高度相似的答案，互评时也倾向互相认同，达不到"多角度审视"的目的。应给不同 Agent 设置不同的立场、关注点或使用不同模型，并限制轮数防止观点趋同。
:::

## 延伸阅读

- [Building effective agents（Anthropic）](https://www.anthropic.com/engineering/building-effective-agents)：Orchestrator-Workers、Prompt Chaining 等模式的原始描述
- [How we built our multi-agent research system（Anthropic）](https://www.anthropic.com/engineering/multi-agent-research-system)
- [OpenAI Agents SDK 文档](https://openai.github.io/openai-agents-python/)：Handoffs 的官方实现
- [Improving Factuality and Reasoning in Language Models through Multiagent Debate](https://arxiv.org/abs/2305.14325)：多 Agent 辩论论文
- 本站：[状态共享与通信](/guide/12-multi-agent/state-sharing)、[项目 07：多 Agent 写作团队](/projects/07-writing-team)

---
title: Reflection 自我反思
description: 让 Agent 检查并修正自己的输出：生成、评审、修改循环，以及为什么外部反馈比"自己觉得"更可靠。
---

# Reflection 自我反思

::: info 学习目标
- 理解 Reflection 的基本循环：生成 → 评审 → 修改
- 区分三种反馈来源：规则校验、外部执行结果、模型自评，并知道它们的可靠性差异
- 实现一个"规则检查 + LLM 评审"的反思循环，并设置合理的终止条件
- 了解 Reflexion 论文的跨轮次记忆思想
:::

## 为什么要反思

人写东西很少一稿成型：写完读一遍，发现问题，再改。大模型也一样，一次生成的结果常常有遗漏、格式错误或者没满足某条约束。Reflection 就是把"读一遍再改"变成 Agent 循环的一部分：

```text
task ──► Generator ──► draft
                         │
                         ▼
               ┌──► Critic(draft) ──► issues == [] ? ──yes──► output
               │                          │
               │                          no
               │                          ▼
               └──── draft ◄──── Generator(draft + issues)
                    (round += 1; stop at max_rounds)
```

它和 [ReAct](/guide/06-agent-loop/react) 是正交的：ReAct 关心"下一步做什么"，Reflection 关心"做出来的东西对不对"。一个 ReAct Agent 在给出最终答案前加一轮反思，就是两者的组合。

## 反馈从哪里来

反思的效果几乎完全取决于反馈的质量。按可靠性从高到低：

| 反馈来源 | 例子 | 可靠性 | 成本 |
| --- | --- | --- | --- |
| 外部执行结果 | 运行单元测试、编译代码、执行 SQL 看是否报错 | 高，客观事实 | 需要沙箱或执行环境 |
| 规则校验 | 字数限制、JSON Schema 校验、敏感词检查、必含关键词 | 高，但只能覆盖可形式化的要求 | 很低 |
| 另一个模型评审 | 用独立提示词（或更强的模型）当审核员 | 中，能发现语义问题，也会误报 | 一次额外调用 |
| 同一个模型自评 | "检查一下你刚才的回答有没有错" | 低，容易自我肯定或乱改 | 一次额外调用 |

有研究发现，在没有外部反馈的情况下，让模型对自己的推理"自我纠正"，效果并不稳定，有时甚至会把对的改错。工程上的结论很直接：能用程序检查的就别让模型判断，模型评审只用于程序覆盖不到的部分。

这也是 [Coding Agent](/guide/13-coding-agent/coding-agents) 效果好的原因之一：代码能跑测试，测试失败信息就是质量最高的反馈。

## 动手实现

任务：为一款降噪耳机写电商文案，要求 80~120 字、必须提到"降噪"和"续航"、不能出现"最"和"第一"（广告法风险）。

反馈分两层：先用程序做规则检查，规则全部通过后，再让一个独立的"审核员"提示词检查语气和事实夸大。任何一层有问题，就把问题清单交给生成器修改。最多 3 轮，用完仍未通过就返回最后一稿并标记。

::: code-group
```python [Python]
import json
import os

from openai import OpenAI

client = OpenAI(api_key=os.environ["OPENAI_API_KEY"],
                base_url=os.getenv("OPENAI_BASE_URL") or None, timeout=60)
MODEL = os.getenv("LLM_MODEL", "gpt-4o-mini")
MAX_ROUNDS = 3

TASK = "为一款头戴式降噪耳机写一段电商详情页文案，80~120 字，必须提到降噪和续航，不能出现“最”“第一”。"
REQUIRED = ["降噪", "续航"]
BANNED = ["最", "第一"]
CRITIC = """你是电商文案审核员。检查文案是否有：夸大或无法证实的功效承诺、语句不通顺、与任务无关的内容。
只报告会阻止发布的问题，不要为了挑错而挑错。
只输出 JSON：{"issues": ["问题1", "问题2"]}，没有问题时输出 {"issues": []}"""


def chat(system: str, user: str, json_mode: bool = False) -> str:
    extra = {"response_format": {"type": "json_object"}} if json_mode else {}
    resp = client.chat.completions.create(
        model=MODEL,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        **extra)
    return (resp.choices[0].message.content or "").strip()


def rule_check(text: str) -> list[str]:
    """确定性检查：便宜、可靠，优先于模型评审。"""
    issues = []
    if not 80 <= len(text) <= 120:
        issues.append(f"字数为 {len(text)}，要求 80~120 字")
    issues += [f"缺少关键词“{w}”" for w in REQUIRED if w not in text]
    issues += [f"包含禁用词“{w}”" for w in BANNED if w in text]
    return issues


def llm_critique(text: str) -> list[str]:
    try:
        issues = json.loads(chat(CRITIC, f"任务：{TASK}\n\n文案：\n{text}", json_mode=True)).get("issues", [])
        return [str(i) for i in issues] if isinstance(issues, list) else []
    except (json.JSONDecodeError, AttributeError):
        return []  # 评审本身出错时不阻塞流程，由规则检查兜底


def reflect_loop() -> tuple[str, bool]:
    draft = chat("你是资深电商文案。只输出文案正文。", TASK)
    for round_no in range(1, MAX_ROUNDS + 1):
        issues = rule_check(draft) or llm_critique(draft)  # 规则不过就不浪费模型评审
        print(f"[第 {round_no} 轮] {len(draft)} 字，问题：{issues or '无'}")
        if not issues:
            return draft, True
        feedback = "\n".join(f"- {i}" for i in issues)
        draft = chat("你是资深电商文案。根据审核意见修改文案，只输出修改后的正文。",
                     f"任务：{TASK}\n\n上一稿：\n{draft}\n\n审核意见：\n{feedback}")
    return draft, not rule_check(draft)  # 轮数用完：至少保证返回的稿子过了规则检查才算通过


if __name__ == "__main__":
    text, ok = reflect_loop()
    print(("通过" if ok else "未完全通过，需要人工复核") + "：\n" + text)
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
	"unicode/utf8"
)

const (
	maxRounds = 3
	task      = "为一款头戴式降噪耳机写一段电商详情页文案，80~120 字，必须提到降噪和续航，不能出现“最”“第一”。"
	critic    = `你是电商文案审核员。检查文案是否有：夸大或无法证实的功效承诺、语句不通顺、与任务无关的内容。
只报告会阻止发布的问题，不要为了挑错而挑错。
只输出 JSON：{"issues": ["问题1", "问题2"]}，没有问题时输出 {"issues": []}`
)

var (
	required   = []string{"降噪", "续航"}
	banned     = []string{"最", "第一"}
	httpClient = &http.Client{Timeout: 60 * time.Second}
)

func chat(system, user string, jsonMode bool) (string, error) {
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
	return strings.TrimSpace(out.Choices[0].Message.Content), nil
}

// ruleCheck：确定性检查，便宜、可靠，优先于模型评审
func ruleCheck(text string) []string {
	var issues []string
	if n := utf8.RuneCountInString(text); n < 80 || n > 120 { // 按字符计数，不是按字节
		issues = append(issues, fmt.Sprintf("字数为 %d，要求 80~120 字", n))
	}
	for _, w := range required {
		if !strings.Contains(text, w) {
			issues = append(issues, "缺少关键词“"+w+"”")
		}
	}
	for _, w := range banned {
		if strings.Contains(text, w) {
			issues = append(issues, "包含禁用词“"+w+"”")
		}
	}
	return issues
}

func llmCritique(text string) []string {
	raw, err := chat(critic, "任务："+task+"\n\n文案：\n"+text, true)
	var out struct {
		Issues []string `json:"issues"`
	}
	if err != nil || json.Unmarshal([]byte(raw), &out) != nil {
		return nil // 评审本身出错时不阻塞流程，由规则检查兜底
	}
	return out.Issues
}

func reflectLoop() (string, bool, error) {
	draft, err := chat("你是资深电商文案。只输出文案正文。", task, false)
	if err != nil {
		return "", false, err
	}
	for round := 1; round <= maxRounds; round++ {
		issues := ruleCheck(draft)
		if len(issues) == 0 { // 规则不过就不浪费模型评审
			issues = llmCritique(draft)
		}
		fmt.Printf("[第 %d 轮] %d 字，问题：%v\n", round, utf8.RuneCountInString(draft), issues)
		if len(issues) == 0 {
			return draft, true, nil
		}
		feedback := "- " + strings.Join(issues, "\n- ")
		draft, err = chat("你是资深电商文案。根据审核意见修改文案，只输出修改后的正文。",
			"任务："+task+"\n\n上一稿：\n"+draft+"\n\n审核意见：\n"+feedback, false)
		if err != nil {
			return "", false, err
		}
	}
	return draft, len(ruleCheck(draft)) == 0, nil // 轮数用完：至少要过规则检查
}

func main() {
	text, ok, err := reflectLoop()
	if err != nil {
		fmt.Fprintln(os.Stderr, "出错:", err)
		os.Exit(1)
	}
	status := "通过"
	if !ok {
		status = "未完全通过，需要人工复核"
	}
	fmt.Println(status + "：\n" + text)
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

public class Reflection {
    static final int MAX_ROUNDS = 3;
    static final String TASK = "为一款头戴式降噪耳机写一段电商详情页文案，80~120 字，必须提到降噪和续航，不能出现“最”“第一”。";
    static final List<String> REQUIRED = List.of("降噪", "续航");
    static final List<String> BANNED = List.of("最", "第一");
    static final String CRITIC = """
            你是电商文案审核员。检查文案是否有：夸大或无法证实的功效承诺、语句不通顺、与任务无关的内容。
            只报告会阻止发布的问题，不要为了挑错而挑错。
            只输出 JSON：{"issues": ["问题1", "问题2"]}，没有问题时输出 {"issues": []}""";
    static final ObjectMapper JSON = new ObjectMapper();
    static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();

    record Result(String text, boolean passed) {}

    static String chat(String system, String user, boolean jsonMode) throws Exception {
        String base = Objects.requireNonNullElse(System.getenv("OPENAI_BASE_URL"), "https://api.openai.com/v1");
        Map<String, Object> payload = new HashMap<>();
        payload.put("model", Objects.requireNonNullElse(System.getenv("LLM_MODEL"), "gpt-4o-mini"));
        payload.put("messages", List.of(Map.of("role", "system", "content", system),
                Map.of("role", "user", "content", user)));
        if (jsonMode) payload.put("response_format", Map.of("type", "json_object"));
        HttpRequest req = HttpRequest.newBuilder(URI.create(base.replaceAll("/+$", "") + "/chat/completions"))
                .timeout(Duration.ofSeconds(60))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + System.getenv("OPENAI_API_KEY"))
                .POST(HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(payload))).build();
        HttpResponse<String> resp = HTTP.send(req, HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() != 200) throw new RuntimeException("HTTP " + resp.statusCode() + ": " + resp.body());
        return JSON.readTree(resp.body()).path("choices").path(0).path("message").path("content").asText("").strip();
    }

    /** 确定性检查：便宜、可靠，优先于模型评审。 */
    static List<String> ruleCheck(String text) {
        List<String> issues = new ArrayList<>();
        int n = text.codePointCount(0, text.length()); // 按字符计数
        if (n < 80 || n > 120) issues.add("字数为 " + n + "，要求 80~120 字");
        for (String w : REQUIRED) if (!text.contains(w)) issues.add("缺少关键词“" + w + "”");
        for (String w : BANNED) if (text.contains(w)) issues.add("包含禁用词“" + w + "”");
        return issues;
    }

    static List<String> llmCritique(String text) {
        List<String> issues = new ArrayList<>();
        try {
            JsonNode arr = JSON.readTree(chat(CRITIC, "任务：" + TASK + "\n\n文案：\n" + text, true)).path("issues");
            for (JsonNode i : arr) issues.add(i.asText());
        } catch (Exception e) {
            // 评审本身出错时不阻塞流程，由规则检查兜底
        }
        return issues;
    }

    static Result reflectLoop() throws Exception {
        String draft = chat("你是资深电商文案。只输出文案正文。", TASK, false);
        for (int round = 1; round <= MAX_ROUNDS; round++) {
            List<String> issues = ruleCheck(draft);
            if (issues.isEmpty()) issues = llmCritique(draft); // 规则不过就不浪费模型评审
            System.out.printf("[第 %d 轮] %d 字，问题：%s%n", round, draft.codePointCount(0, draft.length()), issues);
            if (issues.isEmpty()) return new Result(draft, true);
            String feedback = "- " + String.join("\n- ", issues);
            draft = chat("你是资深电商文案。根据审核意见修改文案，只输出修改后的正文。",
                    "任务：" + TASK + "\n\n上一稿：\n" + draft + "\n\n审核意见：\n" + feedback, false);
        }
        return new Result(draft, ruleCheck(draft).isEmpty()); // 轮数用完：至少要过规则检查
    }

    public static void main(String[] args) throws Exception {
        Result r = reflectLoop();
        System.out.println((r.passed() ? "通过" : "未完全通过，需要人工复核") + "：\n" + r.text());
    }
}
```
:::

一次典型运行（不同模型差异很大）：

```text
[第 1 轮] 134 字，问题：['字数为 134，要求 80~120 字', '包含禁用词“最”']
[第 2 轮] 103 字，问题：['“彻底隔绝一切噪音”属于无法证实的功效承诺']
[第 3 轮] 98 字，问题：无
通过：
……
```

### 设计要点

- 规则在前，模型在后。`rule_check(draft) or llm_critique(draft)` 这一行是整个设计的核心：字数、关键词、禁用词这类要求，程序判断零成本且百分百准确，没必要也不应该交给模型。
- 生成者和评审者分开。评审用独立的系统提示词，只负责挑问题，不负责改。让同一段提示词"写完再自己检查"，模型往往倾向于认为自己写得不错。条件允许时，评审可以换一个不同的模型。
- 反馈要具体。"字数为 134，要求 80~120 字"比"不符合要求"有用得多。问题越具体，修改越有针对性。
- 必须有轮数上限。评审可能永远能挑出问题，或者修改在两个版本之间来回摇摆。用完轮数后返回最后一稿并明确标记"需要人工复核"，而不是假装通过。
- 评审出错不阻塞。评审返回了非法 JSON 就当作没有问题，由规则检查兜底。反过来的策略（评审出错就判失败）也合理，取决于业务对质量和可用性的权衡。

## Reflexion：带记忆的反思

上面的反思发生在一次任务内部。Reflexion（Shinn et al., 2023）更进一步：Agent 完成一次尝试后，根据结果（比如单元测试失败）用自然语言写一段"反思笔记"，存进记忆；下一次尝试同类任务时，把这些笔记放进提示词。

```text
attempt 1 ──► fail (tests) ──► reflection: "我忽略了空列表的边界情况"
                                      │ save to memory
attempt 2 ◄── prompt + memory ◄───────┘
```

它的本质是用文字代替梯度更新：不改模型参数，只改上下文。论文解读见 [Reflexion 论文精读](/papers/reflexion)，记忆的实现方式见 [记忆的分类](/guide/08-memory/memory-types)。

## 常见坑

- 没有外部反馈的自我纠正。只问模型"你确定吗？"，它可能把正确答案改错。尽量引入测试、校验、检索等客观信号。
- 评审过于苛刻。评审总能找到"可以更好"的地方，导致每次都跑满轮数。在评审提示词里明确"只报告阻止发布的问题"，并用评估集观察通过率。
- 修改引入新问题。修好了字数，又把关键词删了。每一轮都要重新跑完整的检查，而不是只检查上次报告的问题。
- 成本翻倍。每轮反思至少多一次评审和一次修改调用。只在质量要求高、能自动检查的环节用反思，并且统计每个任务的平均轮数。
- 把评审当成评估。线上反思循环里的评审是让输出变好的手段，不能代替离线评估，见 [LLM-as-Judge](/guide/14-evaluation/llm-judge)。

## 小测

1. 为什么代码里先执行 `rule_check`，只有规则全部通过才调用 `llm_critique`？

::: details 查看答案
规则检查是确定性的，零成本、结果可靠。规则不通过时，稿子必然要改，此时再调用模型评审既浪费钱，也可能产生和规则问题混在一起的噪音反馈。先用便宜可靠的检查过滤，再用昂贵的模型处理程序覆盖不到的语义问题。
:::

2. 达到最大轮数仍未通过时，应该怎么处理？

::: details 查看答案
不能假装通过。返回最后一稿（或历轮中问题最少的一稿），并明确标记未通过，由调用方决定降级：交给人工复核、提示用户、或者重试其他策略。同时记录日志，用于分析哪些任务经常跑满轮数。
:::

3. Reflection 和 Reflexion 的主要区别是什么？

::: details 查看答案
Reflection 通常指单次任务内的"生成 → 评审 → 修改"循环。Reflexion 强调跨尝试的学习：把失败后的反思写成文字存入记忆，在后续尝试中作为上下文使用，相当于用语言形式的经验代替参数更新。
:::

## 延伸阅读

- [Reflexion 论文精读](/papers/reflexion)
- [Reflexion: Language Agents with Verbal Reinforcement Learning（arXiv）](https://arxiv.org/abs/2303.11366)
- [Self-Refine: Iterative Refinement with Self-Feedback（arXiv）](https://arxiv.org/abs/2303.17651)
- [LLM-as-Judge](/guide/14-evaluation/llm-judge)
- [护栏与内容安全](/guide/15-production/guardrails)

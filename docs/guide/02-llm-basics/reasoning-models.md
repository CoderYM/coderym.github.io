---
title: 推理模型与扩展思考
description: 理解推理模型"先思考再回答"的机制、它与普通模型在 API 和成本上的差异，以及在 Agent 中何时使用。
---

# 推理模型与扩展思考

::: info 学习目标
- 理解推理模型（reasoning model）与普通对话模型的区别
- 了解推理 Token、思考预算、推理强度等概念
- 会通过 API 调用推理模型，并读取思考内容和推理 Token 用量
- 能判断 Agent 中哪些环节适合用推理模型，哪些不适合
:::

普通对话模型拿到问题后直接开始输出答案。推理模型则会先生成一段（通常很长的）"思考过程"，在其中分解问题、尝试方案、检查错误，然后再给出最终回答。OpenAI 的 o 系列、DeepSeek-R1、Claude 的扩展思考（extended thinking）、Qwen 的思考模式等都属于这一类。

## 为什么"先想再答"有用

回忆 [Transformer 的直觉理解](/guide/02-llm-basics/transformer)：模型每生成一个 Token 只做固定量的计算。对复杂问题来说，直接输出答案意味着"一步到位"，没有给模型留出计算空间。

让模型先写出中间步骤，相当于给它更多的"草稿纸"。早期这是一种提示词技巧（思维链 Chain-of-Thought，见 [Few-shot 与思维链](/guide/04-prompt/few-shot-cot)）。推理模型则是通过强化学习等方法，**专门训练**模型产生有效的长推理过程，包括自我检查、回溯、换一种思路等行为。

```text
普通模型：
  问题 ──▶ 答案

推理模型：
  问题 ──▶ [思考：拆解问题 → 尝试方案 A → 发现错误 → 改用方案 B → 验证] ──▶ 答案
            └──────────── 推理 Token（计费，通常不完全可见）────────────┘
```

这带来一个重要变化：**模型能力不仅取决于参数规模，也取决于推理时投入多少计算**，即所谓的测试时计算（test-time compute）。思考得越多，复杂问题的正确率通常越高，但耗时和成本也越高。

## 推理模型在 API 层面的差异

各家的实现方式不同，但大致有以下共同点：

| 方面 | 普通模型 | 推理模型 |
| --- | --- | --- |
| 输出结构 | 只有回答 | 思考内容 + 回答（思考可能被隐藏、摘要或完整返回） |
| 用量 | 输入 + 输出 Token | 输出 Token 里包含推理 Token，往往占大头 |
| 控制方式 | temperature、top_p 等 | 推理强度或思考预算；采样参数常被限制或忽略 |
| 首 Token 延迟 | 较短 | 可能长达数秒到数分钟 |
| 适合任务 | 对话、改写、简单抽取 | 数学、复杂代码、多步规划、疑难分析 |

具体到各厂商（字段名以官方文档为准）：

- **OpenAI 推理模型**：通过 `reasoning_effort`（如 `low`、`medium`、`high`）控制推理强度；推理过程不直接返回，用量中的 `usage.completion_tokens_details.reasoning_tokens` 显示推理消耗了多少 Token。输出上限要用 `max_completion_tokens`，而不是 `max_tokens`。
- **DeepSeek 推理模型**：使用 OpenAI 兼容接口，响应消息中额外有 `reasoning_content` 字段返回思考过程。多轮对话时，官方要求不要把 `reasoning_content` 放回下一轮的输入。
- **Claude 扩展思考**：在 Messages API 中通过 `thinking` 参数开启并设置思考预算，响应的 `content` 中会出现 `thinking` 类型的内容块。
- **混合模型**：越来越多的模型同时支持"思考"和"不思考"两种模式，由请求参数切换。

## 动手：调用推理模型

下面的代码通过 OpenAI 兼容接口调用推理模型，兼容两种常见的返回方式：如果响应带有 `reasoning_content`（如 DeepSeek），就打印思考过程；如果用量中带有 `reasoning_tokens`（如 OpenAI），就打印推理 Token 数。

把 `LLM_MODEL` 设置为你所用厂商的推理模型名称。可选环境变量 `REASONING_EFFORT` 只在厂商支持该参数时设置，不支持的厂商可能会报错。

::: code-group
```python [Python]
import os

from openai import OpenAI

QUESTION = "一个水池有进水管和出水管。单开进水管 6 小时注满，单开出水管 9 小时放空。两管同时开，几小时注满？"


def main() -> None:
    client = OpenAI(
        api_key=os.environ["OPENAI_API_KEY"],
        base_url=os.getenv("OPENAI_BASE_URL") or None,
        timeout=300,  # 推理模型可能思考很久，超时要设得更长
    )
    extra = {}
    if effort := os.getenv("REASONING_EFFORT"):
        extra["reasoning_effort"] = effort  # 仅部分厂商支持

    resp = client.chat.completions.create(
        model=os.environ["LLM_MODEL"],
        messages=[{"role": "user", "content": QUESTION}],
        **extra,
    )
    msg = resp.choices[0].message

    # reasoning_content 不是 OpenAI 标准字段，用 getattr 安全读取
    reasoning = getattr(msg, "reasoning_content", None)
    if reasoning:
        print("=== 思考过程 ===\n" + reasoning)
    print("=== 回答 ===\n" + (msg.content or ""))

    usage = resp.usage
    details = getattr(usage, "completion_tokens_details", None) if usage else None
    if usage:
        print(f"输出 Token: {usage.completion_tokens}")
    if details and details.reasoning_tokens:
        print(f"其中推理 Token: {details.reasoning_tokens}")


if __name__ == "__main__":
    main()
```

```go [Go]
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"time"
)

const question = "一个水池有进水管和出水管。单开进水管 6 小时注满，单开出水管 9 小时放空。两管同时开，几小时注满？"

type message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatRequest struct {
	Model           string    `json:"model"`
	Messages        []message `json:"messages"`
	ReasoningEffort string    `json:"reasoning_effort,omitempty"` // 为空时不发送
}

type chatResponse struct {
	Choices []struct {
		Message struct {
			Content          string `json:"content"`
			ReasoningContent string `json:"reasoning_content"` // 非标准字段，没有则为空
		} `json:"message"`
	} `json:"choices"`
	Usage struct {
		CompletionTokens        int `json:"completion_tokens"`
		CompletionTokensDetails struct {
			ReasoningTokens int `json:"reasoning_tokens"`
		} `json:"completion_tokens_details"`
	} `json:"usage"`
}

func main() {
	apiKey := os.Getenv("OPENAI_API_KEY")
	model := os.Getenv("LLM_MODEL")
	if apiKey == "" || model == "" {
		log.Fatal("请设置 OPENAI_API_KEY 和 LLM_MODEL")
	}
	baseURL := os.Getenv("OPENAI_BASE_URL")
	if baseURL == "" {
		baseURL = "https://api.openai.com/v1"
	}

	body, err := json.Marshal(chatRequest{
		Model:           model,
		Messages:        []message{{Role: "user", Content: question}},
		ReasoningEffort: os.Getenv("REASONING_EFFORT"),
	})
	if err != nil {
		log.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPost, baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		log.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := (&http.Client{Timeout: 300 * time.Second}).Do(req)
	if err != nil {
		log.Fatal(err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		log.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		log.Fatalf("HTTP %d: %s", resp.StatusCode, raw)
	}

	var out chatResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		log.Fatal(err)
	}
	if len(out.Choices) == 0 {
		log.Fatal("empty choices")
	}
	m := out.Choices[0].Message
	if m.ReasoningContent != "" {
		fmt.Println("=== 思考过程 ===\n" + m.ReasoningContent)
	}
	fmt.Println("=== 回答 ===\n" + m.Content)
	fmt.Println("输出 Token:", out.Usage.CompletionTokens)
	if rt := out.Usage.CompletionTokensDetails.ReasoningTokens; rt > 0 {
		fmt.Println("其中推理 Token:", rt)
	}
}
```

```java [Java]
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;

public class ReasoningDemo {
    static final String QUESTION = "一个水池有进水管和出水管。单开进水管 6 小时注满，单开出水管 9 小时放空。两管同时开，几小时注满？";

    record Message(String role, String content) {}

    // reasoning_effort 为 null 时不序列化，避免发给不支持的厂商
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record ChatRequest(String model, List<Message> messages,
                       @JsonProperty("reasoning_effort") String reasoningEffort) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    record RespMessage(String content,
                       @JsonProperty("reasoning_content") String reasoningContent) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    record Choice(RespMessage message) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    record Details(@JsonProperty("reasoning_tokens") Integer reasoningTokens) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    record Usage(@JsonProperty("completion_tokens") int completionTokens,
                 @JsonProperty("completion_tokens_details") Details details) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    record ChatResponse(List<Choice> choices, Usage usage) {}

    public static void main(String[] args) throws Exception {
        String apiKey = System.getenv("OPENAI_API_KEY");
        String model = System.getenv("LLM_MODEL");
        if (apiKey == null || apiKey.isBlank() || model == null || model.isBlank()) {
            throw new IllegalStateException("请设置 OPENAI_API_KEY 和 LLM_MODEL");
        }
        String baseUrl = System.getenv().getOrDefault("OPENAI_BASE_URL", "https://api.openai.com/v1");
        String effort = System.getenv("REASONING_EFFORT");
        if (effort != null && effort.isBlank()) effort = null;

        ObjectMapper mapper = new ObjectMapper();
        var body = new ChatRequest(model, List.of(new Message("user", QUESTION)), effort);

        HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(baseUrl + "/chat/completions"))
                .timeout(Duration.ofSeconds(300)) // 推理模型耗时更长
                .header("Authorization", "Bearer " + apiKey)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(body)))
                .build();
        HttpResponse<String> resp = client.send(req, HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() != 200) {
            throw new RuntimeException("HTTP " + resp.statusCode() + ": " + resp.body());
        }

        ChatResponse out = mapper.readValue(resp.body(), ChatResponse.class);
        if (out.choices() == null || out.choices().isEmpty()) {
            throw new RuntimeException("empty choices");
        }
        RespMessage m = out.choices().get(0).message();
        if (m.reasoningContent() != null && !m.reasoningContent().isBlank()) {
            System.out.println("=== 思考过程 ===\n" + m.reasoningContent());
        }
        System.out.println("=== 回答 ===\n" + m.content());
        if (out.usage() != null) {
            System.out.println("输出 Token: " + out.usage().completionTokens());
            Details d = out.usage().details();
            if (d != null && d.reasoningTokens() != null && d.reasoningTokens() > 0) {
                System.out.println("其中推理 Token: " + d.reasoningTokens());
            }
        }
    }
}
```
:::

### Claude 的扩展思考

Claude 使用 Anthropic 原生的 Messages API，扩展思考通过 `thinking` 参数开启。下面是使用官方 `anthropic` Python SDK 的示例（`pip install anthropic`，环境变量 `ANTHROPIC_API_KEY`）。思考预算 `budget_tokens` 必须小于 `max_tokens`。不同模型支持的思考配置方式可能有差异，API 以 [官方文档](https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking) 为准。

```python
import os

import anthropic

client = anthropic.Anthropic()  # 自动读取 ANTHROPIC_API_KEY

resp = client.messages.create(
    model=os.environ["CLAUDE_MODEL"],
    max_tokens=16000,
    thinking={"type": "enabled", "budget_tokens": 8000},
    messages=[{"role": "user", "content": "证明根号 2 是无理数。"}],
)

for block in resp.content:
    if block.type == "thinking":
        print("=== 思考 ===\n" + block.thinking)
    elif block.type == "text":
        print("=== 回答 ===\n" + block.text)
```

## Agent 中如何使用推理模型

推理模型并不是"全面升级版"。它更强，但也更慢、更贵。在 Agent 里，常见的做法是**按环节选模型**：

```text
┌──────────────┐     ┌──────────────────┐     ┌──────────────┐
│ 规划 / 拆解   │ ──▶ │ 执行：工具调用    │ ──▶ │ 汇总 / 检查   │
│ 推理模型      │     │ 快速的普通模型     │     │ 视难度而定    │
└──────────────┘     └──────────────────┘     └──────────────┘
```

| 适合推理模型 | 不太适合 |
| --- | --- |
| 制定多步计划（见 [Plan-and-Execute](/guide/06-agent-loop/plan-execute)） | 闲聊、简单问答 |
| 复杂代码修改、调试 | 格式转换、改写、翻译 |
| 数学、逻辑、数据分析 | 对延迟敏感的实时交互 |
| 审查和判断（如 [LLM-as-Judge](/guide/14-evaluation/llm-judge)） | 高频、大批量的简单抽取 |

提示词写法也有区别：对推理模型，通常**不需要**再写"请一步一步思考"，也不必给出详细的推理步骤示范。把目标、约束和期望输出格式说清楚，让模型自己规划思考过程，效果往往更好。

## 常见坑

- **超时设置太短**：推理模型可能思考几十秒甚至更久，沿用普通模型的超时会频繁失败。可以配合流式输出改善体验。
- **输出上限不够**：推理 Token 计入输出上限。上限设小了，可能思考还没结束就被截断，最终回答为空。
- **用错参数**：在推理模型上设置 temperature 可能被忽略或报错；OpenAI 推理模型要用 `max_completion_tokens`。
- **把思考内容回传**：DeepSeek 等厂商要求多轮对话时不要把 `reasoning_content` 放回输入；Claude 则在工具调用场景下要求原样回传 thinking 块。规则各家不同，务必查阅文档。
- **把思考过程直接展示给用户或当作事实**：思考内容可能包含中间的错误尝试，也不保证与最终答案完全一致。
- **所有环节都用推理模型**：成本和延迟会成倍增长，而简单步骤几乎没有收益。

## 小测

**1. 一个推理模型请求的 `completion_tokens` 是 3000，但可见回答只有 200 字左右，为什么？**

::: details 查看答案
输出 Token 包含了推理 Token。大部分 Token 消耗在了思考过程上，可见回答只占一小部分。推理 Token 同样计费。
:::

**2. 一个客服 Agent 需要在 1 秒内回复常见问题，应该用推理模型吗？**

::: details 查看答案
一般不应该。推理模型首 Token 延迟较长，而常见问题不需要复杂推理。可以用普通模型处理大部分请求，只在识别到复杂问题时再路由到推理模型。
:::

**3. 对推理模型写提示词时，"请一步步思考"还有必要吗？**

::: details 查看答案
通常没有必要。推理模型已经被训练成会主动进行长推理，额外的步骤指令有时反而会限制它。更重要的是把目标、约束和输出格式描述清楚。
:::

## 延伸阅读

- [Chain-of-Thought Prompting Elicits Reasoning in Large Language Models](https://arxiv.org/abs/2201.11903)
- [DeepSeek-R1 论文](https://arxiv.org/abs/2501.12948)
- [OpenAI Reasoning 指南](https://platform.openai.com/docs/guides/reasoning)
- [Claude Extended Thinking 文档](https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking)
- 下一篇：[如何选择模型](/guide/02-llm-basics/choosing-models)

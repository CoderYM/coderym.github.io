---
title: Token 与上下文窗口
description: 理解 Token 是什么、如何计数，以及上下文窗口对成本、延迟和 Agent 设计的影响。
---

# Token 与上下文窗口

::: info 学习目标
- 理解 Token 和分词器（Tokenizer）的工作方式，知道中英文 Token 数为什么不同
- 会用 tiktoken 在本地估算 Token 数，会从 API 响应中读取真实用量
- 理解上下文窗口包含哪些内容，以及输入、输出 Token 的区别
- 掌握在请求前预估和控制 Token 的基本方法
:::

Token 是大模型世界的"计量单位"：计费按 Token，限流按 Token，上下文窗口按 Token，延迟也和 Token 数直接相关。做 Agent 开发，你会频繁地和它打交道。

## Token 是什么

模型不直接处理字符，而是先用**分词器**（Tokenizer）把文本切成一个个 Token，每个 Token 对应词表中的一个整数 ID。主流模型多使用 BPE（Byte Pair Encoding）类算法：高频的字符组合会被合并成一个 Token，低频的则被拆成更小的片段。

```text
"Hello, world!"  →  ["Hello", ",", " world", "!"]         → 4 个 Token
"unbelievable"   →  ["un", "believ", "able"]              → 3 个 Token（示意）
"你好，世界"     →  ["你好", "，", "世界"]                  → 约 3~5 个 Token（取决于分词器）
```

几个经验规律：

- 英文中，1 个 Token 平均约 4 个字符，约 0.75 个单词。
- 中文中，1 个汉字大约对应 0.5~2 个 Token，差异很大，取决于分词器对中文的优化程度。国内厂商的模型通常对中文更"省 Token"。
- 空格、换行、标点、缩进都算 Token。JSON 和代码往往比同等长度的自然语言更"费 Token"。
- **不同模型的分词器不同**，同一段文本在不同模型下的 Token 数可能相差明显。所以精确计数只能以对应模型的分词器或 API 返回的用量为准。

## 上下文窗口

**上下文窗口**（context window）是模型单次请求能处理的 Token 总上限，**输入和输出共享**这个上限。

```text
┌──────────────────────── 上下文窗口（如 128K Token）────────────────────────┐
│ system prompt │ 工具定义 │ 历史消息 │ 检索到的文档 │ 本轮用户输入 │ 模型输出 │
└────────────────────────────────────────────────────────────────────────────┘
 └──────────────────────── 输入 Token ─────────────────────────┘ └ 输出 Token ┘
```

几个容易混淆的概念：

| 概念 | 含义 | 说明 |
| --- | --- | --- |
| 上下文窗口 | 输入 + 输出的总上限 | 超出会直接报错或被截断 |
| 最大输出 Token | 单次能生成的上限 | 通常远小于上下文窗口，由 `max_tokens` 等参数控制 |
| 输入 Token | 你发送的所有内容 | 包括 system、历史、工具定义、图片等 |
| 输出 Token | 模型生成的内容 | 一般单价更高，生成速度更慢 |

在 Agent 里，上下文消耗得非常快：工具定义每次都要发送，每次工具调用的参数和结果都会进入历史，几轮下来就可能有数万 Token。所以上下文窗口不仅是"能塞多少"的问题，更直接影响：

- **成本**：每次请求都会把全部历史重新计费一次。对话越长，单轮成本越高。
- **延迟**：输入越长，首 Token 返回越慢。
- **质量**：上下文越长，模型越容易忽略中间的信息（参见 [Transformer 的直觉理解](/guide/02-llm-basics/transformer)）。

这就是为什么后面专门有一章 [上下文工程](/guide/07-context-engineering/overview)。

## 动手：本地计数 Token

OpenAI 开源的 [tiktoken](https://github.com/openai/tiktoken) 是一个高性能的分词库，可以在本地计算 OpenAI 系列模型的 Token 数。安装：

```bash
pip install tiktoken
```

下面的脚本对比中英文、JSON 的 Token 数，并演示编码和解码。这一段只提供 Python 版本，因为 tiktoken 是 Python 库（Go、Java 社区有移植版，但不是官方维护）。

```python
import tiktoken


def get_encoding(model: str) -> tiktoken.Encoding:
    """按模型名取分词器；不认识的模型（如其他厂商）回退到 o200k_base 作为近似。"""
    try:
        return tiktoken.encoding_for_model(model)
    except KeyError:
        return tiktoken.get_encoding("o200k_base")


def main() -> None:
    enc = get_encoding("gpt-4o")
    samples = {
        "英文": "Large language models predict the next token.",
        "中文": "大语言模型的本质是预测下一个 Token。",
        "JSON": '{"name": "get_weather", "arguments": {"city": "北京"}}',
    }
    for label, text in samples.items():
        ids = enc.encode(text)
        print(f"{label}: {len(text)} 字符 -> {len(ids)} Token")

    # 看看文本被切成了什么样
    ids = enc.encode("你好，世界")
    pieces = [enc.decode_single_token_bytes(i).decode("utf-8", errors="replace") for i in ids]
    print(ids, pieces)  # 一个汉字可能被拆到多个 Token 里，单独解码会出现替换字符
    assert enc.decode(ids) == "你好，世界"


if __name__ == "__main__":
    main()
```

需要注意：

- 本地计数只对使用同一分词器的模型准确。用 DeepSeek、通义千问等模型时，tiktoken 的结果只能当作粗略估算。
- 聊天消息除了文本本身，每条消息还有角色标记等额外开销（每条大约几个 Token），工具定义也会被转换成文本计入输入。所以本地估算通常会略低于真实值。

## 动手：从 API 响应读取真实用量

最准确的数字来自 API 本身。OpenAI 兼容接口的非流式响应里都有 `usage` 字段：

```json
"usage": { "prompt_tokens": 25, "completion_tokens": 12, "total_tokens": 37 }
```

下面三个版本发送一个请求，并打印输入、输出 Token 数。环境变量：`OPENAI_API_KEY`、`OPENAI_BASE_URL`（可选）、`LLM_MODEL`。

::: code-group
```python [Python]
import os

from openai import OpenAI


def main() -> None:
    client = OpenAI(
        api_key=os.environ["OPENAI_API_KEY"],
        base_url=os.getenv("OPENAI_BASE_URL") or None,
        timeout=60,
    )
    resp = client.chat.completions.create(
        model=os.getenv("LLM_MODEL", "gpt-4o-mini"),
        messages=[
            {"role": "system", "content": "你是一个简洁的助手。"},
            {"role": "user", "content": "用一句话解释什么是 Token。"},
        ],
        max_tokens=200,  # 限制输出长度，防止意外的长输出
    )
    print(resp.choices[0].message.content)
    u = resp.usage
    if u is not None:
        print(f"输入 {u.prompt_tokens} / 输出 {u.completion_tokens} / 合计 {u.total_tokens}")


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

type message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatRequest struct {
	Model     string    `json:"model"`
	Messages  []message `json:"messages"`
	MaxTokens int       `json:"max_tokens,omitempty"`
}

type chatResponse struct {
	Choices []struct {
		Message message `json:"message"`
	} `json:"choices"`
	Usage struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
		TotalTokens      int `json:"total_tokens"`
	} `json:"usage"`
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" {
		log.Fatal("请设置 OPENAI_API_KEY")
	}
	baseURL := getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")

	body, err := json.Marshal(chatRequest{
		Model: getenv("LLM_MODEL", "gpt-4o-mini"),
		Messages: []message{
			{Role: "system", Content: "你是一个简洁的助手。"},
			{Role: "user", Content: "用一句话解释什么是 Token。"},
		},
		MaxTokens: 200,
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

	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Do(req)
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
	if len(out.Choices) > 0 {
		fmt.Println(out.Choices[0].Message.Content)
	}
	u := out.Usage
	fmt.Printf("输入 %d / 输出 %d / 合计 %d\n", u.PromptTokens, u.CompletionTokens, u.TotalTokens)
}
```

```java [Java]
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;

public class TokenUsage {
    record Message(String role, String content) {}

    record ChatRequest(String model, List<Message> messages,
                       @JsonProperty("max_tokens") int maxTokens) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    record Choice(Message message) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    record Usage(@JsonProperty("prompt_tokens") int promptTokens,
                 @JsonProperty("completion_tokens") int completionTokens,
                 @JsonProperty("total_tokens") int totalTokens) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    record ChatResponse(List<Choice> choices, Usage usage) {}

    static String getenv(String key, String def) {
        String v = System.getenv(key);
        return (v == null || v.isBlank()) ? def : v;
    }

    public static void main(String[] args) throws Exception {
        String apiKey = System.getenv("OPENAI_API_KEY");
        if (apiKey == null || apiKey.isBlank()) {
            throw new IllegalStateException("请设置 OPENAI_API_KEY");
        }
        String baseUrl = getenv("OPENAI_BASE_URL", "https://api.openai.com/v1");
        ObjectMapper mapper = new ObjectMapper();

        var body = new ChatRequest(getenv("LLM_MODEL", "gpt-4o-mini"), List.of(
                new Message("system", "你是一个简洁的助手。"),
                new Message("user", "用一句话解释什么是 Token。")), 200);

        HttpClient client = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10)).build();
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(baseUrl + "/chat/completions"))
                .timeout(Duration.ofSeconds(60))
                .header("Authorization", "Bearer " + apiKey)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(body)))
                .build();

        HttpResponse<String> resp = client.send(request, HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() != 200) {
            throw new RuntimeException("HTTP " + resp.statusCode() + ": " + resp.body());
        }
        ChatResponse out = mapper.readValue(resp.body(), ChatResponse.class);
        if (out.choices() != null && !out.choices().isEmpty()) {
            System.out.println(out.choices().get(0).message().content());
        }
        Usage u = out.usage();
        if (u != null) {
            System.out.printf("输入 %d / 输出 %d / 合计 %d%n",
                    u.promptTokens(), u.completionTokens(), u.totalTokens());
        }
    }
}
```
:::

在生产系统里，建议把每次调用的 `usage` 都记录到日志或监控中，这是后续做成本分析和预算控制的基础（见 [计费、限流与错误重试](/guide/03-llm-api/cost-errors)）。流式响应默认不返回用量，需要额外参数，详见 [流式响应实战](/guide/03-llm-api/streaming)。

## 请求前控制 Token 的几个方法

1. **设置 `max_tokens`**：限制输出上限，防止模型"刹不住车"。注意设得太小会导致回答被截断，此时 `finish_reason` 为 `length`。
2. **预留输出空间**：输入 Token + `max_tokens` 不能超过上下文窗口。拼装上下文时要为输出留出余量。
3. **裁剪历史**：只保留最近 N 轮，或把早期对话压缩成摘要（见 [压缩与摘要](/guide/07-context-engineering/compression)）。
4. **精简工具结果**：工具返回的大段 HTML、日志、JSON 先过滤再放进上下文，这往往是 Agent 中最大的 Token 来源。

## 常见坑

- **用字符数代替 Token 数**：中文、代码、JSON 的比例差别很大，按字符数估算容易严重偏差。
- **只算输入不算输出**：上下文窗口是输入输出共享的。输入已经接近上限时，模型可能只能输出很少内容。
- **忽略工具定义的开销**：几十个工具的 JSON Schema 可能占几千 Token，并且每次请求都会计费。
- **把 tiktoken 的结果当作所有模型的真实值**：其他厂商使用不同分词器，以 API 返回的 `usage` 为准。
- **截断时切坏结构**：按 Token 数硬截断文本，可能把 JSON 或多字节字符切成一半。应该按消息或段落为单位裁剪。

## 小测

**1. 某模型上下文窗口为 128K，你的输入已经有 126K Token，`max_tokens` 设为 4K，会发生什么？**

::: details 查看答案
输入加输出上限超过了上下文窗口。不同厂商处理不同：有的直接返回 400 错误，有的会自动把输出上限压缩到剩余的约 2K。无论哪种，都应在发送前预估 Token 并裁剪输入，而不是依赖服务端行为。
:::

**2. 为什么同一段中文，在 GPT 系列和某国产模型上的 Token 数可能不同？**

::: details 查看答案
两者使用的分词器和词表不同。对中文优化更多的词表会把常见词组合并成单个 Token，Token 数就更少。所以计费和上下文估算都要以对应模型的分词器或 API 返回的 `usage` 为准。
:::

**3. 一个 Agent 跑了 10 轮工具调用，为什么后面几轮的单次请求明显更贵？**

::: details 查看答案
每轮请求都要重新发送全部历史，包括之前所有工具调用和结果。历史在累积，单次请求的输入 Token 越来越多，费用随之上涨。这就需要上下文压缩、结果精简以及 [Prompt Caching](/guide/07-context-engineering/prompt-caching) 等手段。
:::

## 延伸阅读

- [tiktoken（GitHub）](https://github.com/openai/tiktoken)
- [OpenAI Tokenizer 在线工具](https://platform.openai.com/tokenizer)
- 下一篇：[采样参数：temperature、top_p](/guide/02-llm-basics/sampling)

---
title: 第一次调用大模型
description: 从获取 API Key 到用 Python、Go、Java 发出第一个 Chat Completions 请求，并读懂完整的请求与响应。
---

# 第一次调用大模型

::: info 学习目标
- 配置 API Key、Base URL 和模型名，并安全地管理它们
- 用 Python、Go、Java 发出第一个 Chat Completions 请求
- 读懂请求和响应中的每个关键字段
- 学会检查 `finish_reason` 和处理基础错误
:::

本模块开始动手。本站所有示例都使用 **OpenAI 兼容的 Chat Completions API**：OpenAI、DeepSeek、通义千问、Kimi、智谱等厂商都提供了兼容接口，只需改 Base URL 和模型名就能切换。各家接口的细节差异见 [主流模型厂商 API 对比](/guide/03-llm-api/providers)。

## 准备工作

### 1. 获取 API Key

在你选择的厂商控制台创建 API Key。API Key 等同于账户密码，泄露后别人可以用你的额度调用模型。

- 不要写进代码，不要提交到 Git，不要发到聊天群里。
- 不要在日志中打印 Key。
- 给 Key 设置用量上限（如果控制台支持），并定期轮换。

### 2. 配置环境变量

本站统一使用三个环境变量：

| 变量 | 是否必需 | 说明 |
| --- | --- | --- |
| `OPENAI_API_KEY` | 必需 | 你的 API Key |
| `OPENAI_BASE_URL` | 可选 | 默认 `https://api.openai.com/v1`，使用其他厂商时改为对应地址 |
| `LLM_MODEL` | 建议设置 | 模型名，例如 `gpt-4o-mini`、`deepseek-chat` |

在项目根目录创建 `.env` 文件（并把 `.env` 加入 `.gitignore`）：

```bash
OPENAI_API_KEY=sk-你的key
# 使用 DeepSeek 时（Base URL 以厂商文档为准）
OPENAI_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-chat
```

Python 可以用 `python-dotenv` 加载 `.env`；Go 和 Java 的示例直接读取系统环境变量，可以在终端中先 `export`，或者使用 IDE 的运行配置。环境搭建的细节见 [开发环境：Python / Go / Java](/guide/01-programming/dev-env)。

### 3. 安装依赖

```bash
# Python 3.10+
pip install openai python-dotenv

# Go 1.22+：只用标准库，无需安装依赖
go mod init firstcall

# Java 17+：在 Maven 的 pom.xml 中加入 Jackson
# <dependency>
#   <groupId>com.fasterxml.jackson.core</groupId>
#   <artifactId>jackson-databind</artifactId>
#   <version>2.17.2</version>
# </dependency>
```

## 请求长什么样

无论用什么语言，最终都是向 `POST {BASE_URL}/chat/completions` 发送一个 JSON：

```json
{
  "model": "deepseek-chat",
  "messages": [
    {"role": "system", "content": "你是一个乐于助人的编程助手，回答简洁。"},
    {"role": "user", "content": "用一句话解释什么是 HTTP。"}
  ],
  "temperature": 0.7,
  "max_tokens": 500
}
```

请求头带上 `Authorization: Bearer <API Key>` 和 `Content-Type: application/json`。

- `model`：要调用的模型名。
- `messages`：对话消息列表，每条有 `role` 和 `content`。`system` 设定角色和规则，`user` 是用户输入，`assistant` 是模型之前的回复。多轮对话见 [多轮对话与消息结构](/guide/03-llm-api/multi-turn)。
- `temperature`、`max_tokens`：采样参数和输出上限，见 [采样参数](/guide/02-llm-basics/sampling)。

## 动手：三种语言的第一次调用

下面三段代码功能相同：读取环境变量，发送请求，打印回答、`finish_reason` 和 Token 用量。

::: code-group
```python [Python]
import os
import sys

from dotenv import load_dotenv
from openai import APIError, OpenAI

load_dotenv()  # 读取 .env，不存在也不会报错


def main() -> None:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        sys.exit("请设置 OPENAI_API_KEY")

    client = OpenAI(
        api_key=api_key,
        base_url=os.getenv("OPENAI_BASE_URL") or None,  # None 表示使用官方默认地址
        timeout=60,
    )
    try:
        resp = client.chat.completions.create(
            model=os.getenv("LLM_MODEL", "gpt-4o-mini"),
            messages=[
                {"role": "system", "content": "你是一个乐于助人的编程助手，回答简洁。"},
                {"role": "user", "content": "用一句话解释什么是 HTTP。"},
            ],
            temperature=0.7,
            max_tokens=500,
        )
    except APIError as e:
        sys.exit(f"调用失败: {e}")

    choice = resp.choices[0]
    print(choice.message.content)
    print("finish_reason:", choice.finish_reason)
    if resp.usage:
        print("tokens:", resp.usage.prompt_tokens, "+", resp.usage.completion_tokens)


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

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type ChatRequest struct {
	Model       string    `json:"model"`
	Messages    []Message `json:"messages"`
	Temperature float64   `json:"temperature"`
	MaxTokens   int       `json:"max_tokens,omitempty"`
}

type ChatResponse struct {
	ID      string `json:"id"`
	Model   string `json:"model"`
	Choices []struct {
		Index        int     `json:"index"`
		Message      Message `json:"message"`
		FinishReason string  `json:"finish_reason"`
	} `json:"choices"`
	Usage struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
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

	payload, err := json.Marshal(ChatRequest{
		Model: getenv("LLM_MODEL", "gpt-4o-mini"),
		Messages: []Message{
			{Role: "system", Content: "你是一个乐于助人的编程助手，回答简洁。"},
			{Role: "user", Content: "用一句话解释什么是 HTTP。"},
		},
		Temperature: 0.7,
		MaxTokens:   500,
	})
	if err != nil {
		log.Fatal(err)
	}

	req, err := http.NewRequest(http.MethodPost, baseURL+"/chat/completions", bytes.NewReader(payload))
	if err != nil {
		log.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 60 * time.Second} // 一定要设超时
	resp, err := client.Do(req)
	if err != nil {
		log.Fatalf("请求失败: %v", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 10<<20)) // 最多读 10MB
	if err != nil {
		log.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		log.Fatalf("调用失败: HTTP %d: %s", resp.StatusCode, body)
	}

	var out ChatResponse
	if err := json.Unmarshal(body, &out); err != nil {
		log.Fatalf("解析响应失败: %v", err)
	}
	if len(out.Choices) == 0 {
		log.Fatal("响应中没有 choices")
	}
	c := out.Choices[0]
	fmt.Println(c.Message.Content)
	fmt.Println("finish_reason:", c.FinishReason)
	fmt.Println("tokens:", out.Usage.PromptTokens, "+", out.Usage.CompletionTokens)
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

public class FirstCall {
    record Message(String role, String content) {}

    record ChatRequest(String model, List<Message> messages, double temperature,
                       @JsonProperty("max_tokens") int maxTokens) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    record Choice(int index, Message message,
                  @JsonProperty("finish_reason") String finishReason) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    record Usage(@JsonProperty("prompt_tokens") int promptTokens,
                 @JsonProperty("completion_tokens") int completionTokens) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    record ChatResponse(String id, String model, List<Choice> choices, Usage usage) {}

    static String getenv(String key, String def) {
        String v = System.getenv(key);
        return (v == null || v.isBlank()) ? def : v;
    }

    public static void main(String[] args) throws Exception {
        String apiKey = System.getenv("OPENAI_API_KEY");
        if (apiKey == null || apiKey.isBlank()) {
            System.err.println("请设置 OPENAI_API_KEY");
            System.exit(1);
        }
        String baseUrl = getenv("OPENAI_BASE_URL", "https://api.openai.com/v1");
        ObjectMapper mapper = new ObjectMapper();

        var body = new ChatRequest(
                getenv("LLM_MODEL", "gpt-4o-mini"),
                List.of(new Message("system", "你是一个乐于助人的编程助手，回答简洁。"),
                        new Message("user", "用一句话解释什么是 HTTP。")),
                0.7, 500);

        HttpClient client = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .build();
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(baseUrl + "/chat/completions"))
                .timeout(Duration.ofSeconds(60)) // 整个请求的超时
                .header("Authorization", "Bearer " + apiKey)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(body)))
                .build();

        HttpResponse<String> resp = client.send(request, HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() != 200) {
            System.err.println("调用失败: HTTP " + resp.statusCode() + ": " + resp.body());
            System.exit(1);
        }

        ChatResponse out = mapper.readValue(resp.body(), ChatResponse.class);
        if (out.choices() == null || out.choices().isEmpty()) {
            throw new IllegalStateException("响应中没有 choices");
        }
        Choice c = out.choices().get(0);
        System.out.println(c.message().content());
        System.out.println("finish_reason: " + c.finishReason());
        if (out.usage() != null) {
            System.out.println("tokens: " + out.usage().promptTokens() + " + " + out.usage().completionTokens());
        }
    }
}
```
:::

## 读懂响应

一个典型的响应如下（省略部分字段）：

```json
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "created": 1730000000,
  "model": "deepseek-chat",
  "choices": [
    {
      "index": 0,
      "message": {"role": "assistant", "content": "HTTP 是浏览器和服务器之间传输数据的应用层协议。"},
      "finish_reason": "stop"
    }
  ],
  "usage": {"prompt_tokens": 32, "completion_tokens": 18, "total_tokens": 50}
}
```

- `choices`：候选回答列表。默认只有一个（`n=1`），取 `choices[0]` 即可。
- `message`：模型的回复。在 Tool Calling 场景下，`content` 可能为空，而 `tool_calls` 有值，见 [工具调用原理](/guide/05-tool-calling/concept)。
- `usage`：Token 用量，用于计费和监控，见 [Token 与上下文窗口](/guide/02-llm-basics/tokens-context)。
- `finish_reason`：模型为什么停下来。**每次都应该检查它**：

| finish_reason | 含义 | 处理方式 |
| --- | --- | --- |
| `stop` | 正常结束，或命中了 `stop` 参数 | 正常使用 |
| `length` | 达到 `max_tokens` 或上下文上限，被截断 | 回答不完整，JSON 可能无法解析；调大上限或缩短输入 |
| `tool_calls` | 模型要求调用工具 | 执行工具并把结果发回去 |
| `content_filter` | 触发了内容安全过滤 | 内容被拦截或删减，需要友好提示用户 |

## 这次调用背后发生了什么

```text
你的程序                       厂商 API                          模型
   │  POST /chat/completions     │                                │
   │ ──────────────────────────▶ │  鉴权、限流检查                   │
   │                             │  拼接 messages 成模型输入 ───────▶ │
   │                             │                                │ 逐 Token 生成
   │                             │ ◀──────────────────── 完整输出 ── │
   │ ◀────────────── JSON 响应 ── │  统计 usage、计费                 │
```

整个过程是**无状态**的：服务端不会记住这次对话。下一次请求如果想让模型"记得"，需要把历史消息一起发过去。

## 常见坑

- **Base URL 写错**：最常见的是多写或少写 `/v1`。OpenAI SDK 会在 Base URL 后面拼接 `/chat/completions`，Base URL 应该写到 `/v1`（或厂商文档指定的路径）为止。报 404 时先检查这里。
- **模型名不存在**：不同厂商的模型名不同，从 OpenAI 切到其他厂商时忘了改 `LLM_MODEL`，会报 404 或 400。
- **没有设置超时**：Go 的 `http.DefaultClient` 和 Java 的 `HttpClient` 默认没有请求超时，网络卡住时程序会一直挂起。
- **不检查 `finish_reason`**：输出被截断却当作完整结果使用，尤其在解析 JSON 时会出错。
- **把 Key 打进日志**：打印整个请求对象或请求头时，Key 会一起泄露。只记录必要的字段。
- **Key 提交进仓库**：一旦提交，即使立刻删除也会留在 Git 历史中。应该立即在控制台吊销并重新生成。

## 小测

**1. 调用返回 `finish_reason: "length"`，说明什么？应该怎么处理？**

::: details 查看答案
输出达到了 `max_tokens` 上限或上下文窗口上限，被截断了，回答不完整。可以调大 `max_tokens`、缩短输入，或要求模型输出更简短的内容。需要结构化输出时，截断的 JSON 不能直接使用。
:::

**2. 从 OpenAI 切换到 DeepSeek，代码需要改哪些地方？**

::: details 查看答案
如果使用 OpenAI 兼容接口，一般只需要改三个配置：`OPENAI_API_KEY` 换成 DeepSeek 的 Key，`OPENAI_BASE_URL` 换成 DeepSeek 的地址，`LLM_MODEL` 换成 DeepSeek 的模型名。代码本身无需改动。不过仍需关注两家在参数支持上的细节差异。
:::

**3. 为什么说 Chat Completions API 是"无状态"的？这对开发有什么影响？**

::: details 查看答案
服务端不保存对话历史，每次请求独立处理。所以要实现多轮对话，客户端必须自己维护消息历史并在每次请求时完整发送。这也意味着对话越长，每次请求的 Token 越多。
:::

## 延伸阅读

- [OpenAI API Reference: Chat Completions](https://platform.openai.com/docs/api-reference/chat/create)
- [openai-python（GitHub）](https://github.com/openai/openai-python)
- [HTTP、JSON 与 REST API](/guide/01-programming/http-json)
- 下一篇：[主流模型厂商 API 对比](/guide/03-llm-api/providers)

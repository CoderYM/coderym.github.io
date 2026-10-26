---
title: HTTP、JSON 与 REST API
description: 拆解一次大模型 API 请求：HTTP 方法、头部、状态码、JSON 结构，并用三种语言手写带重试的调用代码。
---

# HTTP、JSON 与 REST API

::: info 学习目标
- 读懂一次大模型 API 调用的完整 HTTP 请求和响应
- 掌握 JSON 与各语言数据结构之间的映射，以及可选字段的处理方式
- 根据状态码区分「该重试」和「不该重试」的错误
- 不依赖 SDK，用 Python / Go / Java 手写一个带超时和指数退避重试的客户端
:::

## 为什么要懂底层

大模型 SDK 很方便，但 Agent 开发中你迟早会遇到这些情况：

- 某家厂商只提供 HTTP 接口，或 SDK 不支持你的语言
- 需要排查「SDK 报了个看不懂的错」到底是哪里出了问题
- 要把自己的 Agent 包装成 API 给别人调用（见 [服务化](/guide/15-production/serving)）
- MCP、A2A 等协议底层也是 HTTP + JSON

理解 HTTP 和 JSON，这些问题都有了抓手。

## 一次 LLM API 调用长什么样

用 curl 发一个 Chat Completions 请求：

```bash
curl "${OPENAI_BASE_URL:-https://api.openai.com/v1}/chat/completions" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "你好"}],
    "temperature": 0.2
  }'
```

拆开看：

```text
POST /v1/chat/completions HTTP/1.1          ← 方法 + 路径
Host: api.openai.com
Authorization: Bearer sk-...                ← 认证：Bearer Token
Content-Type: application/json              ← 请求体格式
                                            ← 空行分隔头部和请求体
{"model": "...", "messages": [...]}         ← 请求体（JSON）

HTTP/1.1 200 OK                             ← 状态码
Content-Type: application/json
x-request-id: req_...                       ← 请求 ID，排查问题时提供给厂商

{
  "id": "chatcmpl-...",
  "choices": [{
    "index": 0,
    "message": {"role": "assistant", "content": "你好！有什么可以帮你？"},
    "finish_reason": "stop"
  }],
  "usage": {"prompt_tokens": 9, "completion_tokens": 10, "total_tokens": 19}
}
```

响应里最常用的字段：`choices[0].message.content` 是回复内容；`finish_reason` 说明为什么停止（`stop` 正常结束，`length` 被长度截断，`tool_calls` 模型请求调用工具）；`usage` 用于统计 Token 和成本。不同厂商可能会额外返回一些字段，客户端应**忽略不认识的字段**。

## REST 与 HTTP 基础

REST 是一种 API 设计风格：用 URL 表示资源，用 HTTP 方法表示操作。

| 方法 | 语义 | LLM 场景示例 |
| --- | --- | --- |
| `GET` | 读取，不改变状态 | 列出可用模型 `GET /v1/models` |
| `POST` | 创建或执行操作 | 发起对话 `POST /v1/chat/completions` |
| `PUT` / `PATCH` | 整体 / 部分更新 | 更新知识库文档 |
| `DELETE` | 删除 | 删除上传的文件 |

状态码决定了你的错误处理策略：

| 状态码 | 含义 | 是否重试 |
| --- | --- | --- |
| 200 | 成功 | — |
| 400 | 请求参数错误（JSON 格式、字段不合法、上下文超长） | 否，修正请求 |
| 401 / 403 | 认证失败 / 无权限 | 否，检查 Key |
| 404 | 路径或模型不存在 | 否，检查 URL 和模型名 |
| 429 | 限流或额度不足 | 是，退避后重试（额度耗尽则重试无用） |
| 500 / 502 / 503 / 504 | 服务端错误或过载 | 是，退避后重试 |

**指数退避**：第 1 次失败等 1 秒，第 2 次等 2 秒，第 3 次等 4 秒……再加一点随机抖动（jitter），避免大量客户端同时重试。

## JSON 与数据结构的映射

| JSON | Python | Go | Java（Jackson） |
| --- | --- | --- | --- |
| object `{}` | `dict` | `struct` / `map[string]any` | record / `Map` / `JsonNode` |
| array `[]` | `list` | slice | `List` |
| string | `str` | `string` | `String` |
| number | `int` / `float` | `int` / `float64` | `int` / `double` |
| `true` / `false` | `True` / `False` | `bool` | `boolean` |
| `null` | `None` | 指针或接口的 `nil` | `null` |

两个实践要点：

1. **可选字段要能「不发送」**。例如不想设置 `temperature`，就不要发 `"temperature": 0`，因为 0 是一个有效值。Python 里不放进 dict；Go 用指针加 `omitempty`；Java 用包装类型加 `@JsonInclude(NON_NULL)`。
2. **解析响应时忽略未知字段**。Go 的 `encoding/json` 默认忽略；Jackson 默认会报错，需要关闭 `FAIL_ON_UNKNOWN_PROPERTIES` 或在类上加 `@JsonIgnoreProperties(ignoreUnknown = true)`。

## 动手：手写带重试的客户端

三个版本都实现同样的逻辑：构造请求 → 发送（带超时）→ 遇到 429 / 5xx 指数退避重试 → 其他错误直接报错 → 解析回复和 Token 用量。

::: code-group
```python [Python]
# 依赖：pip install httpx （openai SDK 本身也依赖它）
import os
import random
import sys
import time

import httpx

RETRYABLE = {429, 500, 502, 503, 504}


def chat(base_url: str, api_key: str, payload: dict, max_retries: int = 3) -> dict:
    url = base_url.rstrip("/") + "/chat/completions"
    headers = {"Authorization": f"Bearer {api_key}"}
    with httpx.Client(timeout=60.0) as client:
        for attempt in range(max_retries + 1):
            resp = client.post(url, headers=headers, json=payload)  # json= 自动序列化并设置 Content-Type
            if resp.status_code in RETRYABLE and attempt < max_retries:
                wait = 2 ** attempt + random.uniform(0, 0.5)
                print(f"HTTP {resp.status_code}，{wait:.1f}s 后重试 ({attempt + 1}/{max_retries})")
                time.sleep(wait)
                continue
            if resp.status_code != 200:
                raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:500]}")
            data = resp.json()
            if not data.get("choices"):
                raise RuntimeError("响应中没有 choices")
            return data
    raise RuntimeError("unreachable")


def main() -> None:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        sys.exit("缺少环境变量 OPENAI_API_KEY")
    data = chat(
        os.getenv("OPENAI_BASE_URL") or "https://api.openai.com/v1",
        api_key,
        {
            "model": os.getenv("LLM_MODEL", "gpt-4o-mini"),
            "messages": [{"role": "user", "content": "用一句话解释 REST API"}],
            "temperature": 0.2,
        },
    )
    print(data["choices"][0]["message"]["content"])
    usage = data.get("usage", {})
    print(f"tokens: in={usage.get('prompt_tokens')} out={usage.get('completion_tokens')}")


if __name__ == "__main__":
    main()
```
```go [Go]
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net/http"
	"os"
	"strings"
	"time"
)

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type ChatRequest struct {
	Model       string    `json:"model"`
	Messages    []Message `json:"messages"`
	Temperature *float64  `json:"temperature,omitempty"` // 指针 + omitempty：不设置就不发送
}

type ChatResponse struct {
	Choices []struct {
		Message      Message `json:"message"`
		FinishReason string  `json:"finish_reason"`
	} `json:"choices"`
	Usage struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
	} `json:"usage"`
}

var retryable = map[int]bool{429: true, 500: true, 502: true, 503: true, 504: true}

var httpClient = &http.Client{Timeout: 60 * time.Second}

func chat(baseURL, apiKey string, reqBody ChatRequest, maxRetries int) (*ChatResponse, error) {
	payload, err := json.Marshal(reqBody)
	if err != nil {
		return nil, err
	}
	url := strings.TrimRight(baseURL, "/") + "/chat/completions"

	for attempt := 0; ; attempt++ {
		req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(payload))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+apiKey)
		req.Header.Set("Content-Type", "application/json")

		resp, err := httpClient.Do(req)
		if err != nil {
			return nil, err // 网络错误：这里直接返回，也可以按需重试
		}
		body, err := io.ReadAll(io.LimitReader(resp.Body, 10<<20))
		resp.Body.Close() // 在循环里要立即关闭，不能用 defer
		if err != nil {
			return nil, err
		}

		if retryable[resp.StatusCode] && attempt < maxRetries {
			wait := time.Duration(1<<attempt)*time.Second + time.Duration(rand.Intn(500))*time.Millisecond
			log.Printf("HTTP %d，%v 后重试 (%d/%d)", resp.StatusCode, wait, attempt+1, maxRetries)
			time.Sleep(wait)
			continue
		}
		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, body)
		}

		var out ChatResponse
		if err := json.Unmarshal(body, &out); err != nil {
			return nil, fmt.Errorf("解析响应失败: %w", err)
		}
		if len(out.Choices) == 0 {
			return nil, errors.New("响应中没有 choices")
		}
		return &out, nil
	}
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
		log.Fatal("缺少环境变量 OPENAI_API_KEY")
	}
	temp := 0.2
	resp, err := chat(
		getenv("OPENAI_BASE_URL", "https://api.openai.com/v1"),
		apiKey,
		ChatRequest{
			Model:       getenv("LLM_MODEL", "gpt-4o-mini"),
			Messages:    []Message{{Role: "user", Content: "用一句话解释 REST API"}},
			Temperature: &temp,
		},
		3,
	)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(resp.Choices[0].Message.Content)
	fmt.Printf("tokens: in=%d out=%d\n", resp.Usage.PromptTokens, resp.Usage.CompletionTokens)
}
```
```java [Java]
// 依赖：com.fasterxml.jackson.core:jackson-databind（2.12+ 支持 record）
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ThreadLocalRandom;

public class Main {
    record Message(String role, String content) {}

    @JsonInclude(JsonInclude.Include.NON_NULL) // temperature 为 null 时不发送
    record ChatRequest(String model, List<Message> messages, Double temperature) {}

    record Choice(Message message, @JsonProperty("finish_reason") String finishReason) {}
    record Usage(@JsonProperty("prompt_tokens") int promptTokens,
                 @JsonProperty("completion_tokens") int completionTokens) {}
    record ChatResponse(List<Choice> choices, Usage usage) {}

    static final Set<Integer> RETRYABLE = Set.of(429, 500, 502, 503, 504);
    static final ObjectMapper MAPPER = new ObjectMapper()
            .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false); // 忽略未知字段
    static final HttpClient HTTP = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();

    static ChatResponse chat(String baseUrl, String apiKey, ChatRequest body, int maxRetries) throws Exception {
        String url = baseUrl.replaceAll("/+$", "") + "/chat/completions";
        HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofSeconds(60))
                .header("Authorization", "Bearer " + apiKey)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(MAPPER.writeValueAsString(body)))
                .build();

        for (int attempt = 0; ; attempt++) {
            HttpResponse<String> resp = HTTP.send(request, HttpResponse.BodyHandlers.ofString());
            int code = resp.statusCode();
            if (RETRYABLE.contains(code) && attempt < maxRetries) {
                long wait = (1L << attempt) * 1000 + ThreadLocalRandom.current().nextLong(500);
                System.err.printf("HTTP %d，%dms 后重试 (%d/%d)%n", code, wait, attempt + 1, maxRetries);
                Thread.sleep(wait);
                continue;
            }
            if (code != 200) {
                throw new RuntimeException("HTTP " + code + ": " + resp.body());
            }
            ChatResponse out = MAPPER.readValue(resp.body(), ChatResponse.class);
            if (out.choices() == null || out.choices().isEmpty()) {
                throw new RuntimeException("响应中没有 choices");
            }
            return out;
        }
    }

    static String getenv(String key, String def) {
        String v = System.getenv(key);
        return (v == null || v.isBlank()) ? def : v;
    }

    public static void main(String[] args) throws Exception {
        String apiKey = System.getenv("OPENAI_API_KEY");
        if (apiKey == null || apiKey.isBlank()) {
            System.err.println("缺少环境变量 OPENAI_API_KEY");
            System.exit(1);
        }
        ChatResponse resp = chat(
                getenv("OPENAI_BASE_URL", "https://api.openai.com/v1"),
                apiKey,
                new ChatRequest(getenv("LLM_MODEL", "gpt-4o-mini"),
                        List.of(new Message("user", "用一句话解释 REST API")), 0.2),
                3);
        System.out.println(resp.choices().get(0).message().content());
        if (resp.usage() != null) {
            System.out.printf("tokens: in=%d out=%d%n",
                    resp.usage().promptTokens(), resp.usage().completionTokens());
        }
    }
}
```
:::

这段代码是教学版本。生产环境还可以：优先遵循响应头 `Retry-After` 指定的等待时间；对网络超时也做有限次重试；把重试次数和耗时写入日志或监控。官方 SDK 一般已内置重试（例如 OpenAI Python SDK 的 `max_retries` 参数），用 SDK 时不必自己再套一层。

## 常见坑

- **把 Base URL 写成完整路径**。`OPENAI_BASE_URL` 只写到 `/v1`，路径 `/chat/completions` 由代码拼接，否则会得到 404。
- **对 400 错误重试**。参数错误重试多少次都一样，只会浪费额度。只有 429 和 5xx 才值得重试。
- **Go 中忘记关闭 `resp.Body`**。会导致连接无法复用、句柄泄漏。在循环里要立即 `Close()`，不要用 `defer`。
- **Jackson 遇到新字段报错**。厂商随时可能在响应里加字段，务必关闭 `FAIL_ON_UNKNOWN_PROPERTIES`。
- **把错误响应原样打印到日志**。一般没问题，但要确保日志里**不出现请求头**中的 Key。
- **不限制响应体大小**。调用不可信的第三方服务时，用 `io.LimitReader` 之类的方式防止异常大的响应耗尽内存。

## 小测

**1. 调用接口返回 `400`，错误信息提示上下文超长。应该重试吗？如何处理？**

::: details 查看答案
不应该重试，同样的请求会得到同样的错误。应该缩短输入：裁剪历史消息、压缩或摘要旧对话、减少检索内容。这是 [上下文窗口管理](/guide/07-context-engineering/window-management) 的范畴。
:::

**2. 在 Go 里，为什么 `Temperature` 字段用 `*float64` 而不是 `float64`？**

::: details 查看答案
`float64` 的零值是 0，配合 `omitempty` 时，用户明确设置的 `temperature: 0` 也会被省略，而不设置时又无法区分。用指针后，`nil` 表示「不发送」，指向 0 的指针表示「明确设为 0」，语义清晰。
:::

**3. 为什么指数退避还要加随机抖动？**

::: details 查看答案
如果大量客户端在同一时刻遇到限流，并按完全相同的间隔重试，它们会在同一时刻再次涌入，形成「重试风暴」。加入随机抖动可以把重试请求在时间上打散，提高整体成功率。
:::

## 延伸阅读

- [MDN：HTTP 概述](https://developer.mozilla.org/zh-CN/docs/Web/HTTP/Overview)
- [MDN：HTTP 响应状态码](https://developer.mozilla.org/zh-CN/docs/Web/HTTP/Status)
- [OpenAI API Reference](https://platform.openai.com/docs/api-reference)
- [HTTPX 文档](https://www.python-httpx.org/)
- 本站：[计费、限流与错误重试](/guide/03-llm-api/cost-errors)、[主流模型厂商 API 对比](/guide/03-llm-api/providers)

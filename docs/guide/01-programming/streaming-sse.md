---
title: 流式输出与 SSE
description: 理解大模型流式输出的原理和 SSE 协议格式，用 Python / Go / Java 解析流式响应，并了解如何把流转发给前端。
---

# 流式输出与 SSE

::: info 学习目标
- 理解为什么大模型应用几乎都使用流式输出
- 读懂 SSE（Server-Sent Events）的报文格式，以及 OpenAI 兼容接口的流式数据结构
- 用 Python / Go / Java 解析流式响应，正确处理 `[DONE]`、空行和注释行
- 了解服务端如何把模型的流转发给浏览器
:::

## 为什么需要流式输出

模型是一个 Token 一个 Token 生成内容的。一段 500 字的回答可能要十几秒才能生成完。非流式调用要等全部生成完才返回，用户只能盯着空白界面；流式调用则在生成第一个 Token 后就开始返回。

```text
非流式：  请求 ─────────── 等待 12s ───────────▶ 一次性返回全部内容
流式：    请求 ─ 0.5s ▶ 你 ▶ 好 ▶ ， ▶ 我 ▶ 是 ▶ ... ▶ [DONE]
                 ↑ 首 Token 延迟（TTFT）
```

衡量交互体验的关键指标是**首 Token 延迟**（Time To First Token），而不是总耗时。流式输出不会让总耗时变短，但会让用户感觉快很多。

在 Agent 中，流式还有额外价值：可以实时展示 Agent 正在思考什么、调用了哪个工具，而不是让用户等几分钟后才看到结果。

## SSE 协议格式

OpenAI 兼容接口在请求体中设置 `"stream": true` 后，会以 **SSE**（Server-Sent Events）格式返回。SSE 是基于 HTTP 的单向推送协议：一个普通的 HTTP 响应，`Content-Type` 为 `text/event-stream`，连接保持打开，服务端不断写入文本。

报文规则很简单：

```text
: 以冒号开头的是注释行，常用作心跳，客户端忽略

event: message          ← 可选，事件类型
data: {"a": 1}          ← 数据行，可以有多行
                        ← 空行表示一个事件结束

data: {"a": 2}

data: [DONE]            ← OpenAI 兼容接口约定的结束标记（不是 SSE 标准的一部分）
```

一个真实的 Chat Completions 流式响应：

```text
data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}

data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"！"},"finish_reason":null}]}

data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

和非流式响应的区别：

| 非流式 | 流式 |
| --- | --- |
| `choices[0].message.content` 是完整内容 | `choices[0].delta.content` 是增量片段，需要自己拼接 |
| 一个 JSON | 多个 `data:` 行，每行一个 JSON |
| `usage` 在响应里 | 默认没有 `usage`；部分厂商支持 `stream_options: {"include_usage": true}`，在最后一个 chunk 返回，此时 `choices` 为空数组 |
| 工具调用一次给全 | `delta.tool_calls` 分片到达，`arguments` 要按 index 拼接后才是完整 JSON |

## 动手：解析流式响应

Python 使用 OpenAI SDK，它已经帮你解析好 SSE，直接迭代即可。Go 和 Java 手动解析 SSE，能看清协议本身。

::: code-group
```python [Python]
# 依赖：pip install openai
import os
import sys

from openai import OpenAI


def main() -> None:
    if not os.getenv("OPENAI_API_KEY"):
        sys.exit("缺少环境变量 OPENAI_API_KEY")
    client = OpenAI(  # api_key 默认从 OPENAI_API_KEY 读取
        base_url=os.getenv("OPENAI_BASE_URL") or None,
        timeout=300.0,  # 流式输出可能持续较久，超时要设得足够长
    )
    stream = client.chat.completions.create(
        model=os.getenv("LLM_MODEL", "gpt-4o-mini"),
        messages=[{"role": "user", "content": "用三句话介绍 SSE"}],
        stream=True,
    )

    parts: list[str] = []
    for chunk in stream:          # 每个 chunk 对应一个 data: 行
        if not chunk.choices:     # 例如只携带 usage 的最后一个 chunk
            continue
        delta = chunk.choices[0].delta.content
        if delta:                 # 第一个 chunk 的 content 可能为空字符串或 None
            print(delta, end="", flush=True)
            parts.append(delta)

    full_text = "".join(parts)
    print(f"\n\n共收到 {len(full_text)} 个字符")


if __name__ == "__main__":
    main()
```
```go [Go]
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

type message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatRequest struct {
	Model    string    `json:"model"`
	Messages []message `json:"messages"`
	Stream   bool      `json:"stream"`
}

// 流式响应中每个 data 行的结构：增量内容在 delta 里
type streamChunk struct {
	Choices []struct {
		Delta struct {
			Content string `json:"content"`
		} `json:"delta"`
		FinishReason *string `json:"finish_reason"`
	} `json:"choices"`
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
	baseURL := strings.TrimRight(getenv("OPENAI_BASE_URL", "https://api.openai.com/v1"), "/")

	body, err := json.Marshal(chatRequest{
		Model:    getenv("LLM_MODEL", "gpt-4o-mini"),
		Messages: []message{{Role: "user", Content: "用三句话介绍 SSE"}},
		Stream:   true,
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
	req.Header.Set("Accept", "text/event-stream")

	// 注意：Client.Timeout 包含读取响应体的时间，流式输出要设得足够长
	client := &http.Client{Timeout: 5 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		log.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
		log.Fatalf("HTTP %d: %s", resp.StatusCode, msg)
	}

	var full strings.Builder
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024) // 默认单行上限 64KB，调大以防长行
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue // 跳过空行、注释行（以 : 开头）和 event: 等字段
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			break
		}
		var chunk streamChunk
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			log.Printf("跳过无法解析的数据: %v", err)
			continue
		}
		for _, c := range chunk.Choices {
			fmt.Print(c.Delta.Content)
			full.WriteString(c.Delta.Content)
		}
	}
	if err := scanner.Err(); err != nil {
		log.Fatal(err)
	}
	fmt.Printf("\n\n共收到 %d 个字符\n", len([]rune(full.String())))
}
```
```java [Java]
// 依赖：com.fasterxml.jackson.core:jackson-databind
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Iterator;
import java.util.List;
import java.util.stream.Collectors;
import java.util.stream.Stream;

public class Main {
    record Message(String role, String content) {}
    record ChatRequest(String model, List<Message> messages, boolean stream) {}

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
        String baseUrl = getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").replaceAll("/+$", "");
        ObjectMapper mapper = new ObjectMapper();
        String body = mapper.writeValueAsString(new ChatRequest(
                getenv("LLM_MODEL", "gpt-4o-mini"),
                List.of(new Message("user", "用三句话介绍 SSE")),
                true));

        HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
        HttpRequest request = HttpRequest.newBuilder(URI.create(baseUrl + "/chat/completions"))
                .timeout(Duration.ofSeconds(60)) // 等待响应头的超时
                .header("Authorization", "Bearer " + apiKey)
                .header("Content-Type", "application/json")
                .header("Accept", "text/event-stream")
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();

        // ofLines：按行惰性读取响应体，数据到达一行就处理一行
        HttpResponse<Stream<String>> resp = client.send(request, HttpResponse.BodyHandlers.ofLines());
        StringBuilder full = new StringBuilder();
        try (Stream<String> lines = resp.body()) {
            if (resp.statusCode() != 200) {
                System.err.println("HTTP " + resp.statusCode() + ": " + lines.collect(Collectors.joining("\n")));
                System.exit(1);
            }
            Iterator<String> it = lines.iterator();
            while (it.hasNext()) {
                String line = it.next();
                if (!line.startsWith("data:")) continue; // 跳过空行、注释行和其他字段
                String data = line.substring(5).trim();
                if (data.equals("[DONE]")) break;

                JsonNode choices = mapper.readTree(data).path("choices");
                for (JsonNode c : choices) {
                    String delta = c.path("delta").path("content").asText("");
                    System.out.print(delta);
                    System.out.flush();
                    full.append(delta);
                }
            }
        }
        System.out.printf("%n%n共收到 %d 个字符%n", full.codePointCount(0, full.length()));
    }
}
```
:::

三个版本都遵循同样的解析规则：只处理 `data:` 开头的行；遇到 `[DONE]` 结束；每个 chunk 的 `delta.content` 追加到结果中；跳过无法解析或没有 `choices` 的 chunk。流式工具调用的拼接方法见 [流式响应实战](/guide/03-llm-api/streaming)。

## 把流转发给前端

Agent 服务通常位于浏览器和模型之间：浏览器请求你的服务，你的服务流式调用模型，再把内容转成 SSE 写回浏览器。

```text
浏览器 ◀── SSE ── 你的服务 ◀── SSE ── 模型 API
         (自定义事件：token / tool / done)
```

用 FastAPI 实现一个最小的转发端点（框架细节见 [服务化：FastAPI / Gin / Spring Boot](/guide/15-production/serving)）：

```python
# 依赖：pip install fastapi uvicorn openai
import json
import os

from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from openai import AsyncOpenAI
from pydantic import BaseModel, Field

app = FastAPI()
client = AsyncOpenAI(base_url=os.getenv("OPENAI_BASE_URL") or None, timeout=300.0)


class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=4000)  # 校验输入长度


@app.post("/chat")
async def chat(body: ChatIn):
    async def event_stream():
        stream = await client.chat.completions.create(
            model=os.getenv("LLM_MODEL", "gpt-4o-mini"),
            messages=[{"role": "user", "content": body.message}],
            stream=True,
        )
        async for chunk in stream:
            if chunk.choices and chunk.choices[0].delta.content:
                payload = json.dumps({"text": chunk.choices[0].delta.content}, ensure_ascii=False)
                yield f"event: token\ndata: {payload}\n\n"
        yield "event: done\ndata: {}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
```

这个示例没有任何认证，只适合本地调试。对外提供服务前必须加上认证和限流，否则任何人都能消耗你的模型额度。

前端注意：浏览器原生的 `EventSource` 只支持 GET 请求，且不能自定义请求头。需要 POST 消息体或携带认证头时，用 `fetch` 读取 `response.body` 流并自己按行解析，逻辑与上面的 Go / Java 版本相同。

## 常见坑

- **超时设置过短**。Go 的 `http.Client.Timeout` 包含读取整个响应体的时间，设 30 秒可能把长回答截断。流式场景要分别考虑「连接 / 首字节超时」和「总时长上限」。
- **被代理缓冲**。Nginx 等反向代理默认会缓冲响应，前端收到的是一整块而不是逐字输出。关闭代理缓冲（如 Nginx 的 `proxy_buffering off`，或响应头 `X-Accel-Buffering: no`）。
- **按字节切分中文**。自己处理原始字节流时，一个汉字的 UTF-8 编码可能被拆到两次读取中。按行读取（如 `bufio.Scanner`、`ofLines`）可以避免这个问题，因为完整的一行一定包含完整字符。
- **假设每个 chunk 都有内容**。第一个 chunk 常常只有 `role`，最后一个只有 `finish_reason`，携带 usage 的 chunk 的 `choices` 为空。都要做空值判断。
- **忽略 `finish_reason`**。值为 `length` 时说明输出被截断，应提示用户或续写，而不是当作正常结束。
- **流中途断开**。网络中断时已收到的部分内容要能保留或妥善提示，不要直接丢弃。

## 小测

**1. 流式输出会让模型生成完整回答的总时间变短吗？它优化的是哪个指标？**

::: details 查看答案
不会明显变短，生成的 Token 数和速度基本不变。它优化的是首 Token 延迟（TTFT）：用户在第一个 Token 生成后立即看到内容，感知等待时间大大缩短。
:::

**2. 下面这段 SSE 数据，客户端最终应拼出什么文本？**

```text
: ping

data: {"choices":[{"delta":{"role":"assistant"}}]}

data: {"choices":[{"delta":{"content":"Hi"}}]}

data: {"choices":[{"delta":{"content":" there"}}]}

data: {"choices":[{"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

::: details 查看答案
`Hi there`。注释行 `: ping` 和空行被忽略；第一个 chunk 只有 role、没有 content；倒数第二个 chunk 只有 `finish_reason`；`[DONE]` 表示结束。
:::

**3. 前端想用 `EventSource` 直接连接你的 `/chat` POST 接口，并在请求头中携带 Token，可行吗？**

::: details 查看答案
不可行。`EventSource` 只能发 GET 请求，也不能设置自定义请求头。应改用 `fetch` 发 POST 请求，通过 `response.body.getReader()` 逐块读取并按 SSE 规则解析；或者调整接口设计，用 GET 加短期有效的会话凭证。
:::

## 延伸阅读

- [MDN：使用服务器发送事件](https://developer.mozilla.org/zh-CN/docs/Web/API/Server-sent_events/Using_server-sent_events)
- [HTML 标准：Server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html)
- [OpenAI API Reference](https://platform.openai.com/docs/api-reference)
- 本站：[流式响应实战](/guide/03-llm-api/streaming)、[服务化：FastAPI / Gin / Spring Boot](/guide/15-production/serving)

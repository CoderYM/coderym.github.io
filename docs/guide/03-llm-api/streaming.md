---
title: 流式响应实战
description: 用 stream=true 让模型边生成边返回，三种语言解析 SSE 数据流、拼接增量内容并获取用量。
---

# 流式响应实战

::: info 学习目标
- 理解流式响应为什么能改善体验，以及它不能改善什么
- 读懂 Chat Completions 流式返回的 chunk 结构
- 用 Python、Go、Java 实现流式输出、内容拼接和用量统计
- 掌握流式场景下的超时、中断和错误处理
:::

模型是逐 Token 生成的（见 [Transformer 的直觉理解](/guide/02-llm-basics/transformer)）。非流式调用要等全部生成完才返回，一段长回答可能让用户盯着空白屏幕十几秒。流式调用则在每生成一小段时就推送给客户端，用户几百毫秒内就能看到第一个字。

## 流式改善的是什么

```text
非流式：
  请求 ──────────────────── 等待 12 秒 ────────────────────▶ 一次性显示全部

流式：
  请求 ── 0.5 秒 ──▶ 显示 "大" ▶ "模型" ▶ "的" ▶ "本质" ▶ ... ▶ 结束（总共仍约 12 秒）
         └ 首 Token 时间（TTFT）┘
```

流式**不会让总耗时变短**，它缩短的是**首 Token 时间**（Time To First Token, TTFT），也就是用户感知到的等待时间。对聊天界面、长文本生成来说，这几乎是必需的。对后台批处理任务来说，流式没有意义，反而增加了解析的复杂度。

## 协议：SSE 与 chunk 结构

在请求中设置 `"stream": true`，服务端会以 SSE（Server-Sent Events）格式返回，每个事件是一行 `data: <JSON>`，以空行分隔，最后以 `data: [DONE]` 结束。SSE 协议本身的细节见 [流式输出与 SSE](/guide/01-programming/streaming-sse)。

```text
data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"大模型"},"finish_reason":null}]}

data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"的本质是"},"finish_reason":null}]}

data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: {"id":"chatcmpl-1","choices":[],"usage":{"prompt_tokens":15,"completion_tokens":42,"total_tokens":57}}

data: [DONE]
```

和非流式响应的区别：

| 非流式 | 流式 |
| --- | --- |
| `choices[0].message` 是完整消息 | `choices[0].delta` 是**增量**，需要自己拼接 |
| `finish_reason` 在唯一的响应中 | `finish_reason` 出现在最后一个有内容的 chunk 中 |
| 一定带 `usage` | 默认**不带**；设置 `stream_options: {"include_usage": true}` 后，在最后一个 chunk 中返回，且该 chunk 的 `choices` 为空数组 |

`stream_options.include_usage` 是 OpenAI 定义的选项，大部分兼容厂商支持，但也有厂商默认就返回或者不支持，以厂商文档为准。代码要能处理 `choices` 为空和 `usage` 缺失两种情况。

## 动手：三种语言的流式输出

三段代码功能相同：边接收边打印，同时把增量拼成完整文本，最后输出 `finish_reason`、首 Token 时间和用量。Python 使用 SDK 自带的流式迭代器，Go 和 Java 手动解析 SSE。

::: code-group
```python [Python]
import os
import time

from openai import OpenAI


def main() -> None:
    client = OpenAI(
        api_key=os.environ["OPENAI_API_KEY"],
        base_url=os.getenv("OPENAI_BASE_URL") or None,
        timeout=120,
    )
    start = time.perf_counter()
    ttft = None
    parts: list[str] = []
    finish_reason = None
    usage = None

    stream = client.chat.completions.create(
        model=os.getenv("LLM_MODEL", "gpt-4o-mini"),
        messages=[{"role": "user", "content": "用 200 字介绍一下大模型的发展历程。"}],
        stream=True,
        stream_options={"include_usage": True},  # 部分厂商不支持，报错时去掉
    )
    for chunk in stream:
        if chunk.usage:  # 最后一个 chunk 携带用量，choices 为空
            usage = chunk.usage
        if not chunk.choices:
            continue
        choice = chunk.choices[0]
        if choice.delta.content:
            if ttft is None:
                ttft = time.perf_counter() - start
            parts.append(choice.delta.content)
            print(choice.delta.content, end="", flush=True)
        if choice.finish_reason:
            finish_reason = choice.finish_reason

    full_text = "".join(parts)
    print(f"\n\n共 {len(full_text)} 字, finish_reason={finish_reason}")
    if ttft is not None:
        print(f"首 Token: {ttft:.2f}s, 总耗时: {time.perf_counter() - start:.2f}s")
    if usage:
        print(f"tokens: {usage.prompt_tokens} + {usage.completion_tokens}")


if __name__ == "__main__":
    main()
```

```go [Go]
package main

import (
	"bufio"
	"bytes"
	"context"
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

type streamOptions struct {
	IncludeUsage bool `json:"include_usage"`
}

type chatRequest struct {
	Model         string         `json:"model"`
	Messages      []message      `json:"messages"`
	Stream        bool           `json:"stream"`
	StreamOptions *streamOptions `json:"stream_options,omitempty"`
}

type usage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
}

type chunk struct {
	Choices []struct {
		Delta struct {
			Content string `json:"content"`
		} `json:"delta"`
		FinishReason *string `json:"finish_reason"`
	} `json:"choices"`
	Usage *usage `json:"usage"`
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

	payload, err := json.Marshal(chatRequest{
		Model:         getenv("LLM_MODEL", "gpt-4o-mini"),
		Messages:      []message{{Role: "user", Content: "用 200 字介绍一下大模型的发展历程。"}},
		Stream:        true,
		StreamOptions: &streamOptions{IncludeUsage: true},
	})
	if err != nil {
		log.Fatal(err)
	}

	// 整个流的总时长上限；http.Client.Timeout 同样会覆盖读取 body 的时间
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/chat/completions", bytes.NewReader(payload))
	if err != nil {
		log.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")

	start := time.Now()
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		log.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		log.Fatalf("HTTP %d: %s", resp.StatusCode, body)
	}

	var (
		sb           strings.Builder
		ttft         time.Duration
		finishReason string
		u            *usage
	)
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1<<20) // 单行最大 1MB，默认 64KB 可能不够
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue // 跳过空行、注释行（以冒号开头的心跳）等
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			break
		}
		var c chunk
		if err := json.Unmarshal([]byte(data), &c); err != nil {
			log.Fatalf("解析 chunk 失败: %v", err)
		}
		if c.Usage != nil {
			u = c.Usage
		}
		if len(c.Choices) == 0 {
			continue
		}
		if text := c.Choices[0].Delta.Content; text != "" {
			if ttft == 0 {
				ttft = time.Since(start)
			}
			sb.WriteString(text)
			fmt.Print(text)
		}
		if fr := c.Choices[0].FinishReason; fr != nil {
			finishReason = *fr
		}
	}
	if err := scanner.Err(); err != nil {
		log.Fatalf("读取流失败: %v", err)
	}

	fmt.Printf("\n\n共 %d 字, finish_reason=%s\n", len([]rune(sb.String())), finishReason)
	fmt.Printf("首 Token: %.2fs, 总耗时: %.2fs\n", ttft.Seconds(), time.Since(start).Seconds())
	if u != nil {
		fmt.Printf("tokens: %d + %d\n", u.PromptTokens, u.CompletionTokens)
	}
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
import java.util.Iterator;
import java.util.List;
import java.util.stream.Collectors;
import java.util.stream.Stream;

public class StreamingChat {
    record Message(String role, String content) {}

    record StreamOptions(@JsonProperty("include_usage") boolean includeUsage) {}

    record ChatRequest(String model, List<Message> messages, boolean stream,
                       @JsonProperty("stream_options") StreamOptions streamOptions) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    record Delta(String content) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    record Choice(Delta delta, @JsonProperty("finish_reason") String finishReason) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    record Usage(@JsonProperty("prompt_tokens") int promptTokens,
                 @JsonProperty("completion_tokens") int completionTokens) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    record Chunk(List<Choice> choices, Usage usage) {}

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
        var body = new ChatRequest(getenv("LLM_MODEL", "gpt-4o-mini"),
                List.of(new Message("user", "用 200 字介绍一下大模型的发展历程。")),
                true, new StreamOptions(true));

        HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(baseUrl + "/chat/completions"))
                .timeout(Duration.ofSeconds(60)) // 等待响应头的超时，不限制后续读流
                .header("Authorization", "Bearer " + apiKey)
                .header("Content-Type", "application/json")
                .header("Accept", "text/event-stream")
                .POST(HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(body)))
                .build();

        long start = System.nanoTime();
        HttpResponse<Stream<String>> resp = client.send(req, HttpResponse.BodyHandlers.ofLines());

        try (Stream<String> lines = resp.body()) {
            if (resp.statusCode() != 200) {
                String err = lines.collect(Collectors.joining("\n"));
                throw new RuntimeException("HTTP " + resp.statusCode() + ": " + err);
            }
            StringBuilder sb = new StringBuilder();
            long ttftNanos = -1;
            String finishReason = null;
            Usage usage = null;

            Iterator<String> it = lines.iterator();
            while (it.hasNext()) {
                String line = it.next();
                if (!line.startsWith("data:")) continue; // 跳过空行和心跳注释
                String data = line.substring(5).strip();
                if (data.equals("[DONE]")) break;

                Chunk chunk = mapper.readValue(data, Chunk.class);
                if (chunk.usage() != null) usage = chunk.usage();
                if (chunk.choices() == null || chunk.choices().isEmpty()) continue;

                Choice choice = chunk.choices().get(0);
                if (choice.delta() != null && choice.delta().content() != null
                        && !choice.delta().content().isEmpty()) {
                    if (ttftNanos < 0) ttftNanos = System.nanoTime() - start;
                    sb.append(choice.delta().content());
                    System.out.print(choice.delta().content());
                    System.out.flush();
                }
                if (choice.finishReason() != null) finishReason = choice.finishReason();
            }

            System.out.printf("%n%n共 %d 字, finish_reason=%s%n",
                    sb.codePointCount(0, sb.length()), finishReason);
            System.out.printf("首 Token: %.2fs, 总耗时: %.2fs%n",
                    Math.max(ttftNanos, 0) / 1e9, (System.nanoTime() - start) / 1e9);
            if (usage != null) {
                System.out.printf("tokens: %d + %d%n", usage.promptTokens(), usage.completionTokens());
            }
        }
    }
}
```
:::

## 流式场景下的工程问题

**超时要分层设置**。流式请求可能持续一两分钟，不能套用"整个请求 30 秒"的思路。更合理的是三层超时：

| 超时 | 含义 | 参考值 |
| --- | --- | --- |
| 连接超时 | 建立 TCP/TLS 连接 | 5~10 秒 |
| 首字节超时 | 发出请求到收到第一个 chunk | 30~60 秒（推理模型更长） |
| 空闲超时 | 两个 chunk 之间的最长间隔 | 30 秒左右 |
| 总时长上限 | 整个流的最长时间 | 按业务定，例如 2~5 分钟 |

示例代码只演示了连接超时和总时长上限。注意 Go 的 `http.Client.Timeout` 包括读取 body 的时间，设得太短会把正常的长回答切断；Java 的 `HttpRequest.timeout` 只约束收到响应头之前的阶段。生产中通常还需要自己实现空闲超时，例如用一个定时器，每收到一个 chunk 就重置。

**错误可能出现在流的中间**。HTTP 状态码是 200 不代表一定成功：服务端可能在流中途断开，或者推送一个错误事件。处理原则：

- 网络中断时，已收到的部分内容要么丢弃，要么明确标记为"不完整"，不要当作完整答案。
- 流式请求的重试比较麻烦：已经展示给用户的内容无法撤回。通常只在**还没收到任何内容时**自动重试，否则提示用户重新生成。重试策略见 [计费、限流与错误重试](/guide/03-llm-api/cost-errors)。

**用户中断**。用户点了"停止生成"时，应该关闭连接（Python 中调用 `stream.close()`，Go 中 `cancel()` context，Java 中关闭 body 流）。大多数厂商在连接断开后会停止生成，但已生成部分的计费规则以厂商说明为准。

**转发给前端**。后端拿到模型的流后，常见做法是再以 SSE 的形式推给浏览器。中间如果有 Nginx 等反向代理，要关闭响应缓冲，否则流会被攒成一整块，失去流式效果。服务化的细节见 [服务化：FastAPI / Gin / Spring Boot](/guide/15-production/serving)。

**工具调用也会流式返回**。开启流式时，`tool_calls` 的参数也是分片到达的：第一个分片带 `id` 和函数名，后续分片在 `arguments` 中追加 JSON 字符串片段，需要按 `index` 拼接后再解析。这部分会在 Tool Calling 章节展开。

## 常见坑

- **直接打印 `delta.content` 却没有判空**：首个 chunk 通常只有 `role`，最后的 chunk 只有 `finish_reason` 或 `usage`，`content` 为空或不存在。
- **默认取 `choices[0]`**：开启 `include_usage` 后，最后一个 chunk 的 `choices` 是空数组，直接取下标会越界。
- **Go 的 `bufio.Scanner` 行长度限制**：默认单行上限 64KB，遇到较大的 chunk 会报 `token too long`，需要调大 buffer。
- **按字节切分多字节字符**：自己实现解析时，如果按固定字节数读取再解码，中文字符可能被切成两半。按行读取可以避免这个问题。
- **代理缓冲导致"假流式"**：本地测试正常，上线后前端变成一次性显示全部，多半是网关或反向代理开启了缓冲。
- **忘记统计用量**：流式默认不返回 usage，不加 `include_usage` 时成本监控会漏掉这部分。

## 小测

**1. 开启流式后，一个 1000 Token 的回答总耗时会明显缩短吗？**

::: details 查看答案
不会明显缩短。生成速度没有变，总耗时基本相同。流式缩短的是首 Token 时间，让用户更早看到内容，改善的是感知体验。
:::

**2. 你的代码在收到最后一个 chunk 时抛出了数组越界异常，最可能的原因是什么？**

::: details 查看答案
开启了 `stream_options.include_usage`，最后一个 chunk 只携带 `usage`，`choices` 为空数组。代码没有判空就访问了 `choices[0]`。
:::

**3. 流式输出到一半时网络断开，已经给用户展示了 300 字，此时应该自动重试吗？**

::: details 查看答案
一般不建议静默自动重试。重新生成的内容和已展示的部分很可能不一致，拼接起来会混乱。更好的做法是标记回答不完整，提示用户并提供"重新生成"按钮。只有在尚未收到任何内容时，自动重试才比较安全。
:::

## 延伸阅读

- [OpenAI Streaming 指南](https://platform.openai.com/docs/api-reference/chat-streaming)
- [MDN: Server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
- [Anthropic Streaming Messages](https://docs.anthropic.com/en/docs/build-with-claude/streaming)
- 下一篇：[多模态输入：图片与文档](/guide/03-llm-api/multimodal)

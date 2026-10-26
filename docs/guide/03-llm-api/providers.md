---
title: 主流模型厂商 API 对比
description: 对比 OpenAI 兼容接口、Anthropic Messages API 和国内厂商接口的结构差异，学会用一套代码对接多家模型。
---

# 主流模型厂商 API 对比

::: info 学习目标
- 理解为什么 OpenAI Chat Completions 成了事实上的通用接口
- 掌握 Anthropic Messages API 与 OpenAI 接口在结构上的关键差异
- 了解 DeepSeek、通义千问、Kimi、智谱等国内厂商的接入方式与常见差异
- 学会用配置切换厂商，并知道兼容层的边界在哪里
:::

市面上的大模型 API 看起来五花八门，但从"接口形状"上看，主要就两大类：**OpenAI 兼容的 Chat Completions** 和 **Anthropic 的 Messages API**。国内主流厂商基本都提供了 OpenAI 兼容接口。本文只比较接口结构，不涉及价格和模型能力，这些变化很快，请以官方信息为准。

## 两大接口家族

```text
┌──────────────────────────────────────────┐   ┌──────────────────────────────┐
│ OpenAI 兼容 Chat Completions              │   │ Anthropic Messages API        │
│ POST {base}/chat/completions              │   │ POST /v1/messages             │
│                                          │   │                              │
│ OpenAI、DeepSeek、通义千问（兼容模式）、    │   │ Claude 系列                   │
│ Kimi、智谱、各类开源推理服务（vLLM 等）     │   │                              │
└──────────────────────────────────────────┘   └──────────────────────────────┘
```

OpenAI 的 Chat Completions 是最早被广泛使用的接口，生态里的 SDK、框架、工具几乎都支持它，于是各厂商和开源推理框架（如 vLLM、Ollama）纷纷提供兼容实现。这让"改个 Base URL 就能换模型"成为可能。

此外，OpenAI 还推出了更新的 Responses API，Google Gemini 也有自己的原生接口。它们都有各自的特色功能，但本站以 Chat Completions 为主线，因为它的兼容范围最广。

## OpenAI 兼容接口：国内厂商一览

下表中的 Base URL 是撰写时各厂商文档中的兼容接口地址，可能调整，**以官方文档为准**。

| 厂商 | 兼容接口 Base URL | 说明 |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | 标准实现 |
| DeepSeek | `https://api.deepseek.com` | 也可以使用带 `/v1` 的地址；推理模型额外返回 `reasoning_content` |
| 通义千问（阿里云百炼） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 除兼容模式外还有 DashScope 原生接口 |
| Kimi（月之暗面） | `https://api.moonshot.cn/v1` | 文件上传等能力有自己的扩展接口 |
| 智谱 | `https://open.bigmodel.cn/api/paas/v4` | 注意路径是 `v4`；也有官方原生 SDK |

"兼容"通常意味着核心字段一致：`model`、`messages`、`temperature`、`max_tokens`、`stream`、`tools`，响应里的 `choices`、`usage`。但细节上常有差异：

| 差异点 | 常见情况 |
| --- | --- |
| 参数取值范围 | 例如 temperature 上限可能是 1 或 2，超出范围可能报错 |
| 不支持的参数 | 有的会被静默忽略，有的会返回 400 |
| 扩展字段 | 推理内容、联网搜索、思考开关等用自定义字段表示 |
| 多模态格式 | 图片、视频、文件的传入方式不完全一致 |
| 流式用量 | `stream_options.include_usage` 等选项的支持程度不同 |
| 错误格式 | 错误码和错误消息的结构各不相同 |
| 结构化输出 | JSON Mode、JSON Schema 的支持程度不同 |

用 Python SDK 切换厂商，只需要改配置：

```python
import os

from openai import OpenAI

# 一组示例预设：Base URL 以各厂商官方文档为准
PRESETS = {
    "openai": "https://api.openai.com/v1",
    "deepseek": "https://api.deepseek.com",
    "qwen": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "kimi": "https://api.moonshot.cn/v1",
    "zhipu": "https://open.bigmodel.cn/api/paas/v4",
}

provider = os.getenv("LLM_PROVIDER", "openai")
if provider not in PRESETS:
    raise SystemExit(f"未知厂商: {provider}")

client = OpenAI(
    api_key=os.environ["OPENAI_API_KEY"],
    base_url=os.getenv("OPENAI_BASE_URL") or PRESETS[provider],
    timeout=60,
)
resp = client.chat.completions.create(
    model=os.environ["LLM_MODEL"],
    messages=[{"role": "user", "content": "你好，请介绍一下你自己。"}],
)
print(resp.choices[0].message.content)
```

一个厂商一个 Key，生产环境中通常会为每个厂商配置单独的环境变量，再由配置层映射到客户端。

## Anthropic Messages API

Claude 的原生接口是 Messages API。它和 Chat Completions 思路相似，但在结构上有几处关键不同。先看同一个请求的两种写法：

```jsonc
// OpenAI 兼容：POST {base}/chat/completions
{
  "model": "gpt-4o-mini",
  "max_tokens": 500,
  "messages": [
    {"role": "system", "content": "你是翻译助手。"},
    {"role": "user", "content": "把 hello 翻译成中文"}
  ]
}

// Anthropic：POST https://api.anthropic.com/v1/messages
{
  "model": "claude-sonnet-5-5",
  "max_tokens": 500,
  "system": "你是翻译助手。",
  "messages": [
    {"role": "user", "content": "把 hello 翻译成中文"}
  ]
}
```

响应的差异更明显：

```jsonc
// OpenAI 兼容
{"choices": [{"message": {"role": "assistant", "content": "你好"}, "finish_reason": "stop"}],
 "usage": {"prompt_tokens": 20, "completion_tokens": 2}}

// Anthropic
{"content": [{"type": "text", "text": "你好"}], "stop_reason": "end_turn",
 "usage": {"input_tokens": 20, "output_tokens": 2}}
```

| 对比项 | OpenAI 兼容 | Anthropic Messages |
| --- | --- | --- |
| 鉴权头 | `Authorization: Bearer <key>` | `x-api-key: <key>`，另需 `anthropic-version` 头 |
| 系统提示词 | `messages` 中 `role: system` 的消息 | 顶层 `system` 字段 |
| `max_tokens` | 可选 | **必填** |
| 回复内容 | `choices[0].message.content`（字符串） | `content` 是内容块数组，如 `text`、`tool_use`、`thinking` |
| 停止原因 | `finish_reason`：`stop`、`length`、`tool_calls` | `stop_reason`：`end_turn`、`max_tokens`、`tool_use` |
| 用量字段 | `prompt_tokens` / `completion_tokens` | `input_tokens` / `output_tokens` |
| 工具调用 | `message.tool_calls`，结果用 `role: tool` 消息返回 | `tool_use` 内容块，结果用 user 消息中的 `tool_result` 块返回 |
| 消息顺序 | 较宽松 | 首条须为 user，user 与 assistant 交替 |
| 流式格式 | 每个 chunk 是一个 delta，以 `data: [DONE]` 结束 | 带类型的事件序列，如 `message_start`、`content_block_delta`、`message_stop` |

"内容块数组"是 Anthropic 接口的核心设计：一条消息可以同时包含文本、图片、工具调用、思考等多个块，结构更统一，处理时要按 `type` 遍历。

### 动手：调用 Claude

Python 使用官方 `anthropic` SDK（`pip install anthropic`）；Go 和 Java 直接请求 HTTP 接口。环境变量 `ANTHROPIC_API_KEY`、`CLAUDE_MODEL`。

::: code-group
```python [Python]
import os

import anthropic


def main() -> None:
    client = anthropic.Anthropic(timeout=60)  # 自动读取 ANTHROPIC_API_KEY
    resp = client.messages.create(
        model=os.environ["CLAUDE_MODEL"],
        max_tokens=500,
        system="你是翻译助手，只输出译文。",
        messages=[{"role": "user", "content": "把 hello world 翻译成中文"}],
    )
    # content 是内容块列表，只取文本块
    text = "".join(b.text for b in resp.content if b.type == "text")
    print(text)
    print("stop_reason:", resp.stop_reason)
    print("tokens:", resp.usage.input_tokens, "+", resp.usage.output_tokens)


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
	"strings"
	"time"
)

type message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type messagesRequest struct {
	Model     string    `json:"model"`
	MaxTokens int       `json:"max_tokens"`
	System    string    `json:"system,omitempty"`
	Messages  []message `json:"messages"`
}

type messagesResponse struct {
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
	StopReason string `json:"stop_reason"`
	Usage      struct {
		InputTokens  int `json:"input_tokens"`
		OutputTokens int `json:"output_tokens"`
	} `json:"usage"`
}

func main() {
	apiKey, model := os.Getenv("ANTHROPIC_API_KEY"), os.Getenv("CLAUDE_MODEL")
	if apiKey == "" || model == "" {
		log.Fatal("请设置 ANTHROPIC_API_KEY 和 CLAUDE_MODEL")
	}
	payload, err := json.Marshal(messagesRequest{
		Model:     model,
		MaxTokens: 500,
		System:    "你是翻译助手，只输出译文。",
		Messages:  []message{{Role: "user", Content: "把 hello world 翻译成中文"}},
	})
	if err != nil {
		log.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPost, "https://api.anthropic.com/v1/messages", bytes.NewReader(payload))
	if err != nil {
		log.Fatal(err)
	}
	req.Header.Set("x-api-key", apiKey)
	req.Header.Set("anthropic-version", "2023-06-01")
	req.Header.Set("content-type", "application/json")

	resp, err := (&http.Client{Timeout: 60 * time.Second}).Do(req)
	if err != nil {
		log.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		log.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		log.Fatalf("HTTP %d: %s", resp.StatusCode, body)
	}
	var out messagesResponse
	if err := json.Unmarshal(body, &out); err != nil {
		log.Fatal(err)
	}
	var sb strings.Builder
	for _, b := range out.Content {
		if b.Type == "text" {
			sb.WriteString(b.Text)
		}
	}
	fmt.Println(sb.String())
	fmt.Println("stop_reason:", out.StopReason)
	fmt.Println("tokens:", out.Usage.InputTokens, "+", out.Usage.OutputTokens)
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

public class ClaudeCall {
    record Message(String role, String content) {}

    record MessagesRequest(String model, @JsonProperty("max_tokens") int maxTokens,
                           String system, List<Message> messages) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    record ContentBlock(String type, String text) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    record Usage(@JsonProperty("input_tokens") int inputTokens,
                 @JsonProperty("output_tokens") int outputTokens) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    record MessagesResponse(List<ContentBlock> content,
                            @JsonProperty("stop_reason") String stopReason, Usage usage) {}

    public static void main(String[] args) throws Exception {
        String apiKey = System.getenv("ANTHROPIC_API_KEY");
        String model = System.getenv("CLAUDE_MODEL");
        if (apiKey == null || apiKey.isBlank() || model == null || model.isBlank()) {
            throw new IllegalStateException("请设置 ANTHROPIC_API_KEY 和 CLAUDE_MODEL");
        }
        ObjectMapper mapper = new ObjectMapper();
        var body = new MessagesRequest(model, 500, "你是翻译助手，只输出译文。",
                List.of(new Message("user", "把 hello world 翻译成中文")));

        HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create("https://api.anthropic.com/v1/messages"))
                .timeout(Duration.ofSeconds(60))
                .header("x-api-key", apiKey)
                .header("anthropic-version", "2023-06-01")
                .header("content-type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(body)))
                .build();
        HttpResponse<String> resp = client.send(req, HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() != 200) {
            throw new RuntimeException("HTTP " + resp.statusCode() + ": " + resp.body());
        }

        MessagesResponse out = mapper.readValue(resp.body(), MessagesResponse.class);
        StringBuilder sb = new StringBuilder();
        for (ContentBlock b : out.content()) {
            if ("text".equals(b.type())) sb.append(b.text());
        }
        System.out.println(sb);
        System.out.println("stop_reason: " + out.stopReason());
        System.out.println("tokens: " + out.usage().inputTokens() + " + " + out.usage().outputTokens());
    }
}
```
:::

`anthropic-version` 是 API 版本头，`2023-06-01` 是目前文档中使用的稳定版本。另外，Anthropic 也提供了 OpenAI SDK 兼容端点，便于快速试用，但官方建议生产环境使用原生 Messages API 以获得完整功能。

## 怎么选接口

| 场景 | 建议 |
| --- | --- |
| 需要在多家模型之间切换、对比 | 用 OpenAI 兼容接口，配置化 Base URL |
| 主要使用 Claude，并需要扩展思考、Prompt Caching 等特性 | 用 Anthropic 原生 SDK |
| 用到某厂商的专有能力（联网搜索、文件解析等） | 用该厂商的原生接口或扩展字段，封装在适配层里 |
| 多厂商并存的生产系统 | 自己定义统一的内部消息结构，为每个厂商写一个适配器 |

最后一种做法的结构大致如下：

```text
          业务代码 / Agent 循环
                  │  内部统一格式：Message、ToolCall、Usage
                  ▼
         ┌──────────────────┐
         │   LLM 适配层       │
         └──────────────────┘
          │        │        │
          ▼        ▼        ▼
     OpenAI 兼容  Anthropic  其他原生接口
```

LangChain、LiteLLM 以及各语言的 Agent 框架做的就是这件事，见 [框架全景与选型](/guide/11-frameworks/overview)。在学习阶段，建议先直接调用接口，理解各家差异，再决定是否引入框架。

## 常见坑

- **以为"兼容"就是"完全一样"**：核心对话功能基本一致，但工具调用、多模态、流式用量、结构化输出这些细节常有差异。切换厂商后要重新跑测试。
- **把 system 消息放进 Anthropic 的 messages**：Messages API 的 messages 只接受 `user` 和 `assistant`，系统提示词要放在顶层 `system` 字段。
- **忘记 Anthropic 的 `max_tokens` 是必填项**：缺少时会返回 400。
- **直接读 `content[0].text`**：Anthropic 响应的第一个块不一定是文本（开启扩展思考时可能是 `thinking` 块），应按 `type` 过滤。
- **Base URL 路径不一致**：智谱是 `/api/paas/v4`，通义千问是 `/compatible-mode/v1`。照抄 OpenAI 的 `/v1` 会 404。
- **用错 Key**：每个厂商的 Key 只能用于自己的接口，切换 Base URL 时要同时切换 Key。

## 小测

**1. 把一段 OpenAI 兼容格式的 messages 迁移到 Anthropic，system 消息该怎么处理？**

::: details 查看答案
从 messages 中取出 `role: system` 的消息，把内容放到请求顶层的 `system` 字段，剩下的 user 和 assistant 消息保持交替顺序放进 `messages`。同时记得设置必填的 `max_tokens`。
:::

**2. OpenAI 的 `finish_reason: "length"` 在 Anthropic 中对应什么？**

::: details 查看答案
对应 `stop_reason: "max_tokens"`，表示输出达到了 `max_tokens` 上限被截断。类似地，`stop` 大致对应 `end_turn`，`tool_calls` 对应 `tool_use`。
:::

**3. 为什么生产系统通常会自己定义内部消息结构，而不是在业务代码里直接使用某个厂商的格式？**

::: details 查看答案
为了让业务逻辑与厂商解耦。各厂商的消息、工具调用、用量字段不完全一致，统一的内部结构加上适配层，可以让切换厂商、多厂商容灾、A/B 对比只需改动适配层，而不必修改 Agent 主逻辑。
:::

## 延伸阅读

- [OpenAI API Reference](https://platform.openai.com/docs/api-reference/chat/create)
- [Anthropic Messages API](https://docs.anthropic.com/en/api/messages)
- [anthropic-sdk-python（GitHub）](https://github.com/anthropics/anthropic-sdk-python)
- [DeepSeek API 文档](https://api-docs.deepseek.com/)
- 下一篇：[多轮对话与消息结构](/guide/03-llm-api/multi-turn)

---
title: 多轮对话与消息结构
description: 理解 messages 数组中各角色的含义，自己维护对话历史，并实现一个带历史裁剪的命令行多轮对话程序。
---

# 多轮对话与消息结构

::: info 学习目标
- 理解 system、user、assistant、tool 四种角色的作用
- 理解"多轮对话 = 客户端维护历史 + 每次全量发送"
- 动手实现一个带历史裁剪的命令行聊天程序
- 掌握消息结构的常见约束和陷阱
:::

在 [第一次调用大模型](/guide/03-llm-api/first-call) 中我们发现，Chat Completions API 是无状态的。那么 ChatGPT 这类产品是怎么"记得"前面聊过什么的？答案很简单：**每次请求都把完整的对话历史发过去**。

## messages：模型看到的全部世界

`messages` 是一个按时间排序的消息数组，模型每次回答时能参考的上下文就是它。

| 角色 | 谁写的 | 作用 |
| --- | --- | --- |
| `system` | 开发者 | 设定身份、规则、输出格式。通常放在最前面，只有一条 |
| `user` | 用户 | 用户的输入，也可以是程序代用户构造的内容 |
| `assistant` | 模型 | 模型之前的回复。由你回填到历史中 |
| `tool` | 你的程序 | 工具执行结果，必须对应前面 assistant 消息中的某个 `tool_call_id` |

部分厂商还支持 `developer` 角色（OpenAI 新模型中用来替代 system），用法类似，以厂商文档为准。工具相关的消息会在 [工具调用原理](/guide/05-tool-calling/concept) 中详细展开。

一次三轮对话的请求序列：

```text
第 1 次请求                第 2 次请求                    第 3 次请求
┌─────────────────┐       ┌─────────────────┐            ┌─────────────────┐
│ system          │       │ system          │            │ system          │
│ user: 我叫小明   │       │ user: 我叫小明   │            │ user: 我叫小明   │
└─────────────────┘       │ assistant: 你好…│            │ assistant: 你好…│
        │                 │ user: 推荐本书   │            │ user: 推荐本书   │
        ▼                 └─────────────────┘            │ assistant: 推荐…│
 assistant: 你好，小明…             │                     │ user: 我叫什么？ │
                                   ▼                     └─────────────────┘
                          assistant: 推荐…                        │
                                                                 ▼
                                                     assistant: 你叫小明
```

可以看到：

- 模型"记得"你叫小明，仅仅因为第 3 次请求里包含了第 1 轮的内容。
- 每一轮的输入 Token 都在增长，费用和延迟也随之增长。
- 你完全可以**修改**历史：删掉某些轮次、把早期对话替换成摘要，甚至伪造一条 assistant 消息来引导模型。这也是 [上下文工程](/guide/07-context-engineering/overview) 的基础。

## 管理历史：不能无限增长

历史总会超出上下文窗口，即便没有超出，过长的历史也会推高成本。常见策略：

| 策略 | 做法 | 优缺点 |
| --- | --- | --- |
| 滑动窗口 | 只保留最近 N 轮 | 简单可靠；早期信息会丢失 |
| Token 预算 | 从最新往前累加，超过预算就停止 | 更精确地控制成本 |
| 摘要压缩 | 把早期对话总结成一段文字 | 保留要点；需要额外调用、可能丢细节 |
| 检索召回 | 历史存入向量库，按需取回 | 适合超长会话；实现复杂 |

不管用哪种策略，有两条规则：

1. **system 消息永远保留**，它是规则和身份的来源。
2. **按"轮"裁剪，而不是按"条"裁剪**。一轮是一条 user 加上它引出的所有 assistant 和 tool 消息。如果只删掉一半，可能留下孤立的 tool 消息或以 assistant 开头的历史，部分厂商会直接报错。

更完整的方案见 [短期记忆与会话管理](/guide/08-memory/short-term) 和 [上下文窗口管理](/guide/07-context-engineering/window-management)。

## 动手：命令行多轮对话

下面实现一个最小的多轮聊天程序：

- 维护 `history`，每轮追加 user 和 assistant 消息；
- 每次请求前按轮次裁剪，只保留 system 和最近 `MAX_TURNS` 轮；
- 请求失败时撤回本轮的 user 消息，避免历史中出现"没有回复的提问"；
- 输入 `/reset` 清空历史，`/exit` 退出。

::: code-group
```python [Python]
import os

from openai import APIError, OpenAI

SYSTEM_PROMPT = "你是一个友好的中文助手，回答简洁。"
MAX_TURNS = 10  # 保留最近 10 轮


def trim_history(history: list[dict], max_turns: int) -> list[dict]:
    """保留 system 消息和最近 max_turns 轮（每轮以 user 消息开头）。"""
    system = [m for m in history if m["role"] == "system"]
    rest = [m for m in history if m["role"] != "system"]
    user_idx = [i for i, m in enumerate(rest) if m["role"] == "user"]
    if len(user_idx) > max_turns:
        rest = rest[user_idx[-max_turns]:]
    return system + rest


def main() -> None:
    client = OpenAI(
        api_key=os.environ["OPENAI_API_KEY"],
        base_url=os.getenv("OPENAI_BASE_URL") or None,
        timeout=60,
    )
    model = os.getenv("LLM_MODEL", "gpt-4o-mini")
    history: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT}]

    while True:
        try:
            text = input("你> ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if not text:
            continue
        if text == "/exit":
            break
        if text == "/reset":
            history = history[:1]
            print("（历史已清空）")
            continue

        history.append({"role": "user", "content": text})
        history = trim_history(history, MAX_TURNS)
        try:
            resp = client.chat.completions.create(model=model, messages=history)
        except APIError as e:
            history.pop()  # 撤回本轮提问
            print(f"[错误] {e}")
            continue

        reply = resp.choices[0].message.content or ""
        history.append({"role": "assistant", "content": reply})
        print(f"助手> {reply}")
        if resp.usage:
            print(f"（本轮输入 {resp.usage.prompt_tokens} Token）")


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
	"net/http"
	"os"
	"strings"
	"time"
)

const (
	systemPrompt = "你是一个友好的中文助手，回答简洁。"
	maxTurns     = 10
)

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatRequest struct {
	Model    string    `json:"model"`
	Messages []Message `json:"messages"`
}

type chatResponse struct {
	Choices []struct {
		Message Message `json:"message"`
	} `json:"choices"`
	Usage struct {
		PromptTokens int `json:"prompt_tokens"`
	} `json:"usage"`
}

type Client struct {
	baseURL, apiKey, model string
	http                   *http.Client
}

func (c *Client) Chat(messages []Message) (*chatResponse, error) {
	data, err := json.Marshal(chatRequest{Model: c.model, Messages: messages})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequest(http.MethodPost, c.baseURL+"/chat/completions", bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, raw)
	}
	var out chatResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	if len(out.Choices) == 0 {
		return nil, fmt.Errorf("empty choices")
	}
	return &out, nil
}

// trimHistory 保留 system 消息和最近 maxTurns 轮（每轮以 user 消息开头）。
func trimHistory(history []Message, maxTurns int) []Message {
	var system, rest []Message
	for _, m := range history {
		if m.Role == "system" {
			system = append(system, m)
		} else {
			rest = append(rest, m)
		}
	}
	var userIdx []int
	for i, m := range rest {
		if m.Role == "user" {
			userIdx = append(userIdx, i)
		}
	}
	if len(userIdx) > maxTurns {
		rest = rest[userIdx[len(userIdx)-maxTurns]:]
	}
	return append(system, rest...)
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
		fmt.Fprintln(os.Stderr, "请设置 OPENAI_API_KEY")
		os.Exit(1)
	}
	client := &Client{
		baseURL: getenv("OPENAI_BASE_URL", "https://api.openai.com/v1"),
		apiKey:  apiKey,
		model:   getenv("LLM_MODEL", "gpt-4o-mini"),
		http:    &http.Client{Timeout: 60 * time.Second},
	}
	history := []Message{{Role: "system", Content: systemPrompt}}
	scanner := bufio.NewScanner(os.Stdin)

	for {
		fmt.Print("你> ")
		if !scanner.Scan() {
			break
		}
		text := strings.TrimSpace(scanner.Text())
		switch text {
		case "":
			continue
		case "/exit":
			return
		case "/reset":
			history = history[:1]
			fmt.Println("（历史已清空）")
			continue
		}

		history = append(history, Message{Role: "user", Content: text})
		history = trimHistory(history, maxTurns)
		resp, err := client.Chat(history)
		if err != nil {
			history = history[:len(history)-1] // 撤回本轮提问
			fmt.Println("[错误]", err)
			continue
		}
		reply := resp.Choices[0].Message.Content
		history = append(history, Message{Role: "assistant", Content: reply})
		fmt.Println("助手>", reply)
		fmt.Printf("（本轮输入 %d Token）\n", resp.Usage.PromptTokens)
	}
}
```

```java [Java]
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

public class MultiTurnChat {
    static final String SYSTEM_PROMPT = "你是一个友好的中文助手，回答简洁。";
    static final int MAX_TURNS = 10;
    static final ObjectMapper MAPPER = new ObjectMapper();
    static final HttpClient HTTP = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10)).build();

    record Message(String role, String content) {}

    record ChatRequest(String model, List<Message> messages) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    record Choice(Message message) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    record Usage(@JsonProperty("prompt_tokens") int promptTokens) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    record ChatResponse(List<Choice> choices, Usage usage) {}

    static String getenv(String key, String def) {
        String v = System.getenv(key);
        return (v == null || v.isBlank()) ? def : v;
    }

    /** 保留 system 消息和最近 maxTurns 轮（每轮以 user 消息开头）。 */
    static List<Message> trimHistory(List<Message> history, int maxTurns) {
        List<Message> system = new ArrayList<>();
        List<Message> rest = new ArrayList<>();
        for (Message m : history) {
            (m.role().equals("system") ? system : rest).add(m);
        }
        List<Integer> userIdx = new ArrayList<>();
        for (int i = 0; i < rest.size(); i++) {
            if (rest.get(i).role().equals("user")) userIdx.add(i);
        }
        if (userIdx.size() > maxTurns) {
            rest = rest.subList(userIdx.get(userIdx.size() - maxTurns), rest.size());
        }
        List<Message> out = new ArrayList<>(system);
        out.addAll(rest);
        return out;
    }

    static ChatResponse chat(String baseUrl, String apiKey, String model, List<Message> messages)
            throws Exception {
        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(baseUrl + "/chat/completions"))
                .timeout(Duration.ofSeconds(60))
                .header("Authorization", "Bearer " + apiKey)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(
                        MAPPER.writeValueAsString(new ChatRequest(model, messages))))
                .build();
        HttpResponse<String> resp = HTTP.send(req, HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() != 200) {
            throw new RuntimeException("HTTP " + resp.statusCode() + ": " + resp.body());
        }
        ChatResponse out = MAPPER.readValue(resp.body(), ChatResponse.class);
        if (out.choices() == null || out.choices().isEmpty()) {
            throw new RuntimeException("empty choices");
        }
        return out;
    }

    public static void main(String[] args) throws Exception {
        String apiKey = System.getenv("OPENAI_API_KEY");
        if (apiKey == null || apiKey.isBlank()) {
            throw new IllegalStateException("请设置 OPENAI_API_KEY");
        }
        String baseUrl = getenv("OPENAI_BASE_URL", "https://api.openai.com/v1");
        String model = getenv("LLM_MODEL", "gpt-4o-mini");

        List<Message> history = new ArrayList<>();
        history.add(new Message("system", SYSTEM_PROMPT));
        var in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));

        while (true) {
            System.out.print("你> ");
            String line = in.readLine();
            if (line == null) break;
            String text = line.strip();
            if (text.isEmpty()) continue;
            if (text.equals("/exit")) break;
            if (text.equals("/reset")) {
                history = new ArrayList<>(history.subList(0, 1));
                System.out.println("（历史已清空）");
                continue;
            }

            history.add(new Message("user", text));
            history = trimHistory(history, MAX_TURNS);
            try {
                ChatResponse resp = chat(baseUrl, apiKey, model, history);
                String reply = resp.choices().get(0).message().content();
                history.add(new Message("assistant", reply == null ? "" : reply));
                System.out.println("助手> " + reply);
                if (resp.usage() != null) {
                    System.out.println("（本轮输入 " + resp.usage().promptTokens() + " Token）");
                }
            } catch (Exception e) {
                history.remove(history.size() - 1); // 撤回本轮提问
                System.out.println("[错误] " + e.getMessage());
            }
        }
    }
}
```
:::

运行后试试：先告诉它"我叫小明，喜欢科幻小说"，聊几轮别的，再问"我叫什么？"。把 `MAX_TURNS` 改成 2 再试一次，就能直观看到"遗忘"是怎么发生的。观察每轮打印的输入 Token，也能看到历史增长带来的成本变化。

## 消息结构的约束与技巧

**常见约束**（不同厂商严格程度不同）：

- 第一条非 system 消息通常应该是 user。
- user 与 assistant 一般交替出现，连续两条 user 有的厂商会合并，有的会报错。
- `tool` 消息必须紧跟在包含对应 `tool_calls` 的 assistant 消息之后，且 `tool_call_id` 要能对上。
- `content` 可以是字符串，也可以是内容块数组（用于图片等多模态输入，见 [多模态输入：图片与文档](/guide/03-llm-api/multimodal)）。

**实用技巧**：

- **预填充回复**：部分接口（如 Anthropic）允许最后一条消息是 assistant，模型会接着它往下写。例如预填 `{`，引导模型直接输出 JSON。OpenAI 兼容接口对此的支持情况不一，以厂商文档为准。
- **注入上下文**：检索到的资料、当前时间、用户信息，可以作为 system 的一部分，或者放进 user 消息里。放在 user 消息中更利于缓存 system 前缀（见 [Prompt Caching](/guide/07-context-engineering/prompt-caching)）。
- **持久化**：生产环境中，历史一般存在数据库或 Redis 中，以会话 ID 为键。服务端不要依赖进程内存。

## 常见坑

- **忘记把 assistant 回复加入历史**：下一轮模型看不到自己说过什么，对话就"断片"了。
- **按条数裁剪导致结构错误**：裁剪后第一条是 assistant，或者 tool 消息失去了对应的 tool_calls，会导致 400 错误。
- **裁剪时误删 system**：模型失去了规则约束，行为突然变化。
- **请求失败后不清理**：历史里残留没有回复的 user 消息，重试时会出现连续两条 user。
- **信任客户端传来的历史**：如果前端把整个 messages 数组发给后端，用户可以伪造 system 或 assistant 消息。服务端应自己保存历史，只接收用户的新输入。参见 [Prompt 注入与防护](/guide/15-production/prompt-injection)。

## 小测

**1. 用户在第 1 轮说了自己的名字，聊了 20 轮后模型忘记了。使用的是保留最近 10 轮的滑动窗口，原因是什么？有什么改进方法？**

::: details 查看答案
第 1 轮已经被滑动窗口裁剪掉，模型看不到了。改进方法：把关键信息（如用户名、偏好）提取出来放到 system 中长期保留；或者把早期对话压缩为摘要；或者使用长期记忆，见 [长期记忆与用户画像](/guide/08-memory/long-term)。
:::

**2. 为什么要按"轮"而不是按"条"裁剪历史？**

::: details 查看答案
一轮内的消息之间有依赖关系，特别是 assistant 的 tool_calls 和后续的 tool 消息必须成对出现。按条数裁剪可能拆散它们，或者让历史以 assistant 消息开头，导致请求报错或模型理解混乱。
:::

**3. 一个 Web 聊天应用，前端每次把完整的 messages 数组发给后端，后端原样转发给模型。这有什么安全问题？**

::: details 查看答案
用户可以篡改 messages，例如修改 system 提示词、伪造 assistant 的历史回复，从而绕过规则限制。正确的做法是由服务端保存和拼装历史，前端只发送本轮用户输入和会话 ID。
:::

## 延伸阅读

- [OpenAI Chat Completions：messages 参数](https://platform.openai.com/docs/api-reference/chat/create)
- [Anthropic Messages API](https://docs.anthropic.com/en/api/messages)
- 实战项目：[命令行聊天助手](/projects/01-cli-chat)
- 下一篇：[流式响应实战](/guide/03-llm-api/streaming)

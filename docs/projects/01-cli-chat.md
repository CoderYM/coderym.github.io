---
title: 01 命令行聊天助手
description: 30 分钟写一个支持流式输出、多轮对话和 /reset 命令的终端聊天助手，打通调用大模型的完整链路。
---

# 01 命令行聊天助手

::: info 项目信息
- 难度：★☆☆☆☆
- 预计时间：30 分钟
- 前置知识：[开发环境：Python / Go / Java](/guide/01-programming/dev-env)、[第一次调用大模型](/guide/03-llm-api/first-call)、[多轮对话与消息结构](/guide/03-llm-api/multi-turn)、[流式响应实战](/guide/03-llm-api/streaming)
- 你将学会：配置 OpenAI 兼容 API；维护多轮对话历史；解析流式响应（SSE）；用简单的命令控制会话；限制历史长度避免上下文无限增长
:::

这是整个实战系列的起点。它不是 Agent，只是一个"会聊天的终端程序"，但后面 9 个项目都建立在这里打下的三件事上：**消息列表、API 调用、流式输出**。

## 需求说明

做一个在终端里运行的聊天助手：

1. 启动后显示提示符 `你>`，用户输入一句话，助手**逐字流式**输出回答。
2. 支持多轮对话：助手记得之前聊过什么。
3. 支持命令：
   - `/reset`：清空对话历史，重新开始
   - `/exit`：退出程序（`Ctrl+D` / `Ctrl+C` 也能退出）
4. 历史消息超过上限时，只保留最近的若干条，防止 Token 无限增长。
5. API Key 从环境变量读取，绝不写进代码，也不打印出来。
6. 网络错误时给出友好提示，程序不崩溃，本轮失败的提问不进入历史。

## 架构设计

```text
┌──────────────────────────── CLI 进程 ────────────────────────────┐
│                                                                   │
│  stdin ──▶ 读取一行 ──▶ 是命令？──是──▶ /reset 清空历史 / /exit 退出  │
│                          │否                                      │
│                          ▼                                        │
│              messages.append({role: user})                        │
│                          │                                        │
│                          ▼                                        │
│        POST /chat/completions  (stream: true) ───────────────┐    │
│                                                              │    │
│  stdout ◀── 逐块打印 delta.content ◀── SSE: data: {...} ◀─────┘    │
│                          │                                        │
│                          ▼                                        │
│          messages.append({role: assistant}) ──▶ 裁剪历史           │
└───────────────────────────────────────────────────────────────────┘
```

核心数据结构只有一个：**消息列表** `messages`。第一条是 `system` 消息，之后 `user` / `assistant` 交替出现。每次请求都把整个列表发给模型。模型本身是无状态的，"记忆"完全来自你每次发过去的历史。

## 分步实现

### Step 1：准备环境变量

在项目根目录创建 `.env`（记得把它加进 `.gitignore`）：

```bash
# .env 示例：任选一家 OpenAI 兼容的服务
OPENAI_API_KEY=sk-xxxxxxxx
# 使用 OpenAI 官方时可不填；DeepSeek / 通义千问 / Kimi 等填各自文档给出的兼容地址
OPENAI_BASE_URL=https://api.deepseek.com/v1
LLM_MODEL=deepseek-chat
```

Python 版会用 `python-dotenv` 自动加载 `.env`。Go 和 Java 版只读进程环境变量，运行前先导出：

```bash
set -a; source .env; set +a   # macOS / Linux，把 .env 里的变量导出到当前 shell
```

::: warning 保护你的 Key
`.env` 一定要加进 `.gitignore`。不要把 Key 写进代码、日志或截图里。下面的代码只读取 Key，从不打印它。
:::

### Step 2：初始化项目

::: code-group
```bash [Python]
mkdir cli-chat && cd cli-chat
python3 -m venv .venv && source .venv/bin/activate
pip install openai python-dotenv
# 代码保存为 chat.py
```
```bash [Go]
mkdir cli-chat && cd cli-chat
go mod init cli-chat
# 代码保存为 main.go，只用标准库，无需安装依赖
```
```bash [Java]
mkdir -p cli-chat/src/main/java && cd cli-chat
# 代码保存为 src/main/java/ChatCli.java，pom.xml 见下方
```
:::

Java 版用 Maven 管理 Jackson 依赖，最小的 `pom.xml`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>lab.maxai</groupId>
  <artifactId>cli-chat</artifactId>
  <version>1.0.0</version>

  <properties>
    <maven.compiler.release>17</maven.compiler.release>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>

  <dependencies>
    <dependency>
      <groupId>com.fasterxml.jackson.core</groupId>
      <artifactId>jackson-databind</artifactId>
      <version>2.17.2</version>
    </dependency>
  </dependencies>

  <build>
    <plugins>
      <plugin>
        <groupId>org.codehaus.mojo</groupId>
        <artifactId>exec-maven-plugin</artifactId>
        <version>3.1.0</version>
        <configuration>
          <mainClass>ChatCli</mainClass>
        </configuration>
      </plugin>
    </plugins>
  </build>
</project>
```

依赖版本仅作示例，可换成 Maven Central 上的当前稳定版。

### Step 3：维护消息列表

先把"历史"这件事想清楚，它是后面所有项目的地基：

- 历史以一条 `system` 消息开头，规定助手的角色和风格。
- 用户每说一句，追加一条 `user` 消息；模型回答完，追加一条 `assistant` 消息。
- `/reset` 就是把列表恢复成只剩 `system` 消息。
- 列表会越来越长，每次请求都要把它全部发过去，Token 消耗和延迟随之上涨。这里用最简单的策略：只保留最近 `MAX_HISTORY` 条，并保证裁剪后第一条是 `user` 消息。更好的做法（摘要压缩等）见 [上下文窗口管理](/guide/07-context-engineering/window-management)。

### Step 4：流式输出

设置 `stream: true` 后，服务端不再一次性返回完整 JSON，而是通过 SSE 持续推送：

```text
data: {"choices":[{"delta":{"role":"assistant","content":""}}]}

data: {"choices":[{"delta":{"content":"你好"}}]}

data: {"choices":[{"delta":{"content":"，我是"}}]}

data: [DONE]
```

每个 `data:` 行是一个 JSON 块，把 `choices[0].delta.content` 依次拼起来就是完整回答。Python SDK 已经帮你解析好了；Go 和 Java 版需要自己按行读取、去掉 `data:` 前缀、遇到 `[DONE]` 结束。原理详见 [流式输出与 SSE](/guide/01-programming/streaming-sse)。

### Step 5：完整代码

三个版本功能完全一致，可以只看你熟悉的语言。

::: code-group
```python [Python]
"""01 命令行聊天助手：流式输出 + 多轮对话 + /reset 命令。"""
import os
import sys

from dotenv import load_dotenv
from openai import OpenAI, OpenAIError

load_dotenv()  # 读取当前目录下的 .env（没有也不报错）

SYSTEM_PROMPT = "你是一个简洁、友好的中文助手。回答尽量控制在 300 字以内。"
MAX_HISTORY = 20  # 除 system 外最多保留的消息条数


def new_history() -> list[dict]:
    return [{"role": "system", "content": SYSTEM_PROMPT}]


def trim_history(messages: list[dict]) -> list[dict]:
    """保留 system 消息 + 最近 MAX_HISTORY 条消息。"""
    rest = messages[1:]
    if len(rest) <= MAX_HISTORY:
        return messages
    rest = rest[-MAX_HISTORY:]
    # 保证裁剪后第一条是 user 消息，避免以 assistant 开头
    while rest and rest[0]["role"] != "user":
        rest = rest[1:]
    return [messages[0]] + rest


def stream_reply(client: OpenAI, model: str, messages: list[dict]) -> str:
    """流式请求模型，边收边打印，返回完整回复文本。"""
    stream = client.chat.completions.create(
        model=model,
        messages=messages,
        stream=True,
    )
    parts: list[str] = []
    for chunk in stream:
        if not chunk.choices:  # 部分厂商最后会发一个没有 choices 的块
            continue
        delta = chunk.choices[0].delta.content
        if delta:
            print(delta, end="", flush=True)
            parts.append(delta)
    print()
    return "".join(parts)


def main() -> None:
    if not os.getenv("OPENAI_API_KEY"):
        sys.exit("请先设置环境变量 OPENAI_API_KEY（可写在 .env 中）")
    model = os.getenv("LLM_MODEL", "gpt-4o-mini")
    # base_url 为 None 时使用 OpenAI 官方地址；timeout 防止请求无限挂起
    client = OpenAI(base_url=os.getenv("OPENAI_BASE_URL") or None, timeout=60)

    messages = new_history()
    print(f"已连接模型 {model}。输入 /reset 清空历史，/exit 退出。")

    while True:
        try:
            user_input = input("\n你> ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n再见")
            break

        if not user_input:
            continue
        if user_input == "/exit":
            print("再见")
            break
        if user_input == "/reset":
            messages = new_history()
            print("（历史已清空）")
            continue

        messages.append({"role": "user", "content": user_input})
        print("助手> ", end="", flush=True)
        try:
            reply = stream_reply(client, model, messages)
        except OpenAIError as e:
            messages.pop()  # 本轮失败，不把这条提问留在历史里
            print(f"\n[请求失败] {type(e).__name__}: {e}")
            continue
        except KeyboardInterrupt:
            messages.pop()
            print("\n（已中断本次回答）")
            continue

        messages.append({"role": "assistant", "content": reply})
        messages = trim_history(messages)


if __name__ == "__main__":
    main()
```
```go [Go]
// 01 命令行聊天助手（Go 版）：只用标准库实现流式输出 + 多轮对话。
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

const (
	systemPrompt = "你是一个简洁、友好的中文助手。回答尽量控制在 300 字以内。"
	maxHistory   = 20 // 除 system 外最多保留的消息条数
)

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatRequest struct {
	Model    string    `json:"model"`
	Messages []Message `json:"messages"`
	Stream   bool      `json:"stream"`
}

// 流式响应中每个 data: 行的结构（只取需要的字段）
type streamChunk struct {
	Choices []struct {
		Delta struct {
			Content string `json:"content"`
		} `json:"delta"`
	} `json:"choices"`
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func newHistory() []Message {
	return []Message{{Role: "system", Content: systemPrompt}}
}

func trimHistory(msgs []Message) []Message {
	rest := msgs[1:]
	if len(rest) <= maxHistory {
		return msgs
	}
	rest = rest[len(rest)-maxHistory:]
	for len(rest) > 0 && rest[0].Role != "user" {
		rest = rest[1:]
	}
	return append([]Message{msgs[0]}, rest...)
}

// streamReply 发送流式请求，边收边打印，返回完整回复。
func streamReply(client *http.Client, baseURL, apiKey, model string, msgs []Message) (string, error) {
	body, err := json.Marshal(chatRequest{Model: model, Messages: msgs, Stream: true})
	if err != nil {
		return "", err
	}
	req, err := http.NewRequest(http.MethodPost, baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return "", fmt.Errorf("HTTP %d: %s", resp.StatusCode, b)
	}

	var sb strings.Builder
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue // 跳过空行和注释行
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			break
		}
		var chunk streamChunk
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			continue
		}
		if len(chunk.Choices) > 0 && chunk.Choices[0].Delta.Content != "" {
			text := chunk.Choices[0].Delta.Content
			fmt.Print(text)
			sb.WriteString(text)
		}
	}
	fmt.Println()
	if err := scanner.Err(); err != nil {
		return "", err
	}
	return sb.String(), nil
}

func main() {
	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" {
		fmt.Fprintln(os.Stderr, "请先设置环境变量 OPENAI_API_KEY")
		os.Exit(1)
	}
	baseURL := strings.TrimRight(getenv("OPENAI_BASE_URL", "https://api.openai.com/v1"), "/")
	model := getenv("LLM_MODEL", "gpt-4o-mini")
	// Timeout 覆盖整个请求（含读取流式 body），按需调大
	client := &http.Client{Timeout: 120 * time.Second}

	msgs := newHistory()
	fmt.Printf("已连接模型 %s。输入 /reset 清空历史，/exit 退出。\n", model)

	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for {
		fmt.Print("\n你> ")
		if !in.Scan() {
			fmt.Println("\n再见")
			return
		}
		input := strings.TrimSpace(in.Text())
		switch input {
		case "":
			continue
		case "/exit":
			fmt.Println("再见")
			return
		case "/reset":
			msgs = newHistory()
			fmt.Println("（历史已清空）")
			continue
		}

		msgs = append(msgs, Message{Role: "user", Content: input})
		fmt.Print("助手> ")
		reply, err := streamReply(client, baseURL, apiKey, model, msgs)
		if err != nil {
			msgs = msgs[:len(msgs)-1] // 本轮失败，移除这条提问
			var netErr interface{ Timeout() bool }
			if errors.As(err, &netErr) && netErr.Timeout() {
				fmt.Println("\n[请求超时] 请稍后重试")
			} else {
				fmt.Printf("\n[请求失败] %v\n", err)
			}
			continue
		}
		msgs = append(msgs, Message{Role: "assistant", Content: reply})
		msgs = trimHistory(msgs)
	}
}
```
```java [Java]
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.stream.Stream;

/** 01 命令行聊天助手（Java 版）：HttpClient + Jackson 实现流式输出与多轮对话。 */
public class ChatCli {
    static final String SYSTEM_PROMPT = "你是一个简洁、友好的中文助手。回答尽量控制在 300 字以内。";
    static final int MAX_HISTORY = 20; // 除 system 外最多保留的消息条数
    static final ObjectMapper MAPPER = new ObjectMapper();

    record Message(String role, String content) {}

    record ChatRequest(String model, List<Message> messages, boolean stream) {}

    static String getenv(String key, String def) {
        String v = System.getenv(key);
        return (v == null || v.isBlank()) ? def : v;
    }

    static List<Message> newHistory() {
        List<Message> list = new ArrayList<>();
        list.add(new Message("system", SYSTEM_PROMPT));
        return list;
    }

    static List<Message> trimHistory(List<Message> msgs) {
        List<Message> rest = msgs.subList(1, msgs.size());
        if (rest.size() <= MAX_HISTORY) return msgs;
        int start = rest.size() - MAX_HISTORY;
        // 保证裁剪后第一条是 user 消息
        while (start < rest.size() && !rest.get(start).role().equals("user")) start++;
        List<Message> out = new ArrayList<>();
        out.add(msgs.get(0));
        out.addAll(rest.subList(start, rest.size()));
        return out;
    }

    /** 发送流式请求，边收边打印，返回完整回复。 */
    static String streamReply(HttpClient client, String baseUrl, String apiKey, String model,
                              List<Message> messages) throws IOException, InterruptedException {
        String body = MAPPER.writeValueAsString(new ChatRequest(model, messages, true));
        HttpRequest req = HttpRequest.newBuilder(URI.create(baseUrl + "/chat/completions"))
                .timeout(Duration.ofSeconds(60)) // 等待响应头的超时
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + apiKey)
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();

        HttpResponse<Stream<String>> resp = client.send(req, HttpResponse.BodyHandlers.ofLines());
        if (resp.statusCode() != 200) {
            String err;
            try (Stream<String> lines = resp.body()) {
                err = String.join("\n", lines.limit(20).toList());
            }
            throw new IOException("HTTP " + resp.statusCode() + ": " + err);
        }

        StringBuilder sb = new StringBuilder();
        try (Stream<String> lines = resp.body()) {
            Iterator<String> it = lines.iterator();
            while (it.hasNext()) {
                String line = it.next();
                if (!line.startsWith("data:")) continue; // 跳过空行和注释行
                String data = line.substring(5).trim();
                if (data.equals("[DONE]")) break;
                JsonNode content;
                try {
                    content = MAPPER.readTree(data)
                            .path("choices").path(0).path("delta").path("content");
                } catch (IOException e) {
                    continue; // 忽略无法解析的块
                }
                if (content.isTextual()) {
                    System.out.print(content.asText());
                    System.out.flush();
                    sb.append(content.asText());
                }
            }
        }
        System.out.println();
        return sb.toString();
    }

    public static void main(String[] args) throws Exception {
        String apiKey = System.getenv("OPENAI_API_KEY");
        if (apiKey == null || apiKey.isBlank()) {
            System.err.println("请先设置环境变量 OPENAI_API_KEY");
            System.exit(1);
        }
        String baseUrl = getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").replaceAll("/+$", "");
        String model = getenv("LLM_MODEL", "gpt-4o-mini");
        HttpClient client = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .build();

        List<Message> messages = newHistory();
        System.out.printf("已连接模型 %s。输入 /reset 清空历史，/exit 退出。%n", model);

        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        while (true) {
            System.out.print("\n你> ");
            System.out.flush();
            String line = in.readLine();
            if (line == null) { // Ctrl+D
                System.out.println("\n再见");
                break;
            }
            String input = line.strip();
            if (input.isEmpty()) continue;
            if (input.equals("/exit")) {
                System.out.println("再见");
                break;
            }
            if (input.equals("/reset")) {
                messages = newHistory();
                System.out.println("（历史已清空）");
                continue;
            }

            messages.add(new Message("user", input));
            System.out.print("助手> ");
            try {
                String reply = streamReply(client, baseUrl, apiKey, model, messages);
                messages.add(new Message("assistant", reply));
                messages = trimHistory(messages);
            } catch (IOException e) {
                messages.remove(messages.size() - 1); // 本轮失败，移除这条提问
                System.out.println("\n[请求失败] " + e.getMessage());
            }
        }
    }
}
```
:::

几个值得注意的细节：

- **超时**：三个版本都设置了超时，网络异常时不会永远卡住。Go 的 `http.Client.Timeout` 覆盖整个请求（包括读完流式 body），回答特别长时可以调大；Java 的 `HttpRequest.timeout` 只约束等待响应头的时间。
- **失败回滚**：请求失败时把刚追加的 `user` 消息移除，保证历史里 `user` / `assistant` 成对出现。
- **兼容性**：部分厂商在流的最后会发送没有 `choices` 的块（例如携带 usage 统计），代码里都做了判空。
- **Key 安全**：Key 只出现在 `Authorization` 请求头里，错误信息只打印 HTTP 状态码和响应体，不会带出 Key。

## 运行与测试

::: code-group
```bash [Python]
python chat.py
```
```bash [Go]
go run main.go
```
```bash [Java]
mvn -q compile exec:java
```
:::

按下面的脚本手动验证三个需求点：

```text
已连接模型 deepseek-chat。输入 /reset 清空历史，/exit 退出。

你> 我叫小明，是一名后端工程师
助手> 你好小明！很高兴认识你。作为后端工程师，平时主要用什么语言呢？

你> 我叫什么？做什么工作？
助手> 你叫小明，是一名后端工程师。

你> /reset
（历史已清空）

你> 我叫什么？
助手> 抱歉，我不知道你的名字。你愿意告诉我吗？

你> /exit
再见
```

检查清单：

- [ ] 回答是一段一段"流"出来的，而不是等很久后一次性出现
- [ ] 第二轮能回答出第一轮提供的信息（多轮历史生效）
- [ ] `/reset` 之后模型"忘记"了之前的内容
- [ ] 把 `OPENAI_BASE_URL` 改成一个错误地址，程序打印 `[请求失败]` 后仍能继续输入
- [ ] 不设置 `OPENAI_API_KEY` 时，程序给出提示并退出

::: tip 常见问题
- 返回 401：Key 错误，或 Key 与 `OPENAI_BASE_URL` 不是同一家厂商。
- 返回 404：`OPENAI_BASE_URL` 通常要以 `/v1` 之类的版本路径结尾，以厂商文档为准；`LLM_MODEL` 也要填该厂商支持的模型名。
- Windows 终端中文乱码：先执行 `chcp 65001` 切换到 UTF-8。
:::

## 扩展挑战

1. **更多命令**：加 `/history` 打印当前历史条数和估算 Token 数，`/system 新的人设` 动态修改系统提示词。
2. **持久化会话**：退出时把 `messages` 存成 JSON 文件，下次启动时询问是否恢复。
3. **按 Token 裁剪**：用 Token 数而不是消息条数控制历史长度，参考 [Token 与上下文窗口](/guide/02-llm-basics/tokens-context)。
4. **错误重试**：对 429 和 5xx 做指数退避重试，参考 [计费、限流与错误重试](/guide/03-llm-api/cost-errors)。
5. **多厂商切换**：加 `/model 名称` 命令，在不同模型间切换，对比回答风格和速度。

## 下一步

现在你的程序已经能"说话"，但还只能用模型自带的知识回答问题，无法查询实时信息，也无法替你做事。下一个项目 [02 天气日程工具 Agent](/projects/02-tool-agent) 会在这份代码的基础上加入 Tool Calling，让模型学会调用你写的函数，这是从 Chatbot 走向 Agent 的关键一步。

---
title: 短期记忆与会话管理
description: 用滑动窗口加滚动摘要管理会话历史，让多轮对话既不丢重点也不撑爆上下文。
---

# 短期记忆与会话管理

::: info 学习目标
- 理解短期记忆就是"每次请求重新组装的 messages"
- 掌握三种常见策略：全量保留、滑动窗口、滚动摘要
- 动手实现一个带自动摘要的 Session 类（Python / Go / Java）
- 知道多用户场景下会话存储与并发要注意什么
:::

## 短期记忆是什么

在 [多轮对话与消息结构](/guide/03-llm-api/multi-turn) 里我们已经知道：模型是无状态的，多轮对话靠客户端每次把历史消息重新发过去。所谓**短期记忆**，就是这份历史，加上 Agent 在执行任务过程中产生的中间状态（工具调用结果、当前计划、草稿等）。

短期记忆的问题很朴素：**它会一直长**。一个跑了 30 步的 Agent，光工具返回值就可能有几万 Token。窗口迟早会满，即使没满，成本和延迟也会随长度上升，而且太长的上下文里，模型更容易忽略中间部分的信息。

所以短期记忆管理的核心问题只有一个：**窗口放不下时，丢什么、留什么**。

## 三种基本策略

```text
全量保留:   [sys][u1][a1][u2][a2][u3][a3][u4][a4][u5]      简单，但会撑爆

滑动窗口:   [sys]               [u3][a3][u4][a4][u5]      丢掉最早的轮次

滚动摘要:   [sys + 摘要(u1..a2)] [u3][a3][u4][a4][u5]      早期内容压缩成摘要
```

| 策略 | 实现成本 | 信息损失 | 额外开销 | 适合场景 |
| --- | --- | --- | --- | --- |
| 全量保留 | 最低 | 无 | 无（但 Token 线性增长） | 短对话、一次性任务 |
| 滑动窗口 | 低 | 早期内容完全丢失 | 无 | 闲聊、客服等话题较独立的场景 |
| 滚动摘要 | 中 | 细节丢失，要点保留 | 每次压缩多一次 LLM 调用 | 长对话、长任务 Agent |

实际系统里常见的是组合：**保留最近 N 轮原文 + 更早内容的摘要**。最近的轮次细节最重要，原样保留；更早的只留下目标、结论和待办事项。

窗口大小可以按"轮数"算，也可以按"Token 数"算。按 Token 算更准确，但需要分词器（如 OpenAI 的 `tiktoken`），而且不同厂商的分词器不同。入门阶段用**字符数近似**就够了：中文大约 1 个汉字对应 1~2 个 Token，留足余量即可。更精细的做法见 [上下文窗口管理](/guide/07-context-engineering/window-management) 和 [压缩与摘要](/guide/07-context-engineering/compression)。

## 动手：带滚动摘要的 Session

下面实现一个 `Session`：

- 历史只保存 `user` / `assistant` 消息，`system` 每次请求时现组装
- 总字符数超过 `max_chars` 时，把除最近 `keep_recent` 条之外的消息交给模型压缩成摘要
- 摘要是**增量**的：新摘要 = 旧摘要 + 新被挤出的消息，不会重复压缩已压缩的内容
- 摘要拼进 system prompt，而不是伪造成一条 `assistant` 消息，避免模型把它当成自己说过的话

环境变量：`OPENAI_API_KEY`、`OPENAI_BASE_URL`（可选，用于 DeepSeek、通义千问等兼容接口）、`LLM_MODEL`。

::: code-group
```python [Python]
import os

from openai import OpenAI

client = OpenAI(
    api_key=os.environ["OPENAI_API_KEY"],
    base_url=os.getenv("OPENAI_BASE_URL"),  # 为空时使用官方地址
    timeout=60,
)
MODEL = os.getenv("LLM_MODEL", "gpt-4o-mini")

SUMMARY_PROMPT = (
    "你是对话压缩器。请把下面的对话压缩成一段摘要，保留：用户的目标、"
    "已确认的事实与决定、尚未完成的事项。不要编造，不超过 300 字。"
)


class Session:
    """带滚动摘要的短期记忆。用字符数近似 Token 数。"""

    def __init__(self, system: str, max_chars: int = 6000, keep_recent: int = 6):
        self.system = system
        self.summary = ""
        self.history: list[dict] = []  # 只存 user / assistant 消息
        self.max_chars = max_chars
        self.keep_recent = keep_recent  # 压缩时保留的最近消息条数

    def _size(self) -> int:
        return len(self.summary) + sum(len(m["content"]) for m in self.history)

    def build_messages(self) -> list[dict]:
        system = self.system
        if self.summary:
            system += f"\n\n# 之前对话的摘要\n{self.summary}"
        return [{"role": "system", "content": system}, *self.history]

    def _compress(self) -> None:
        old = self.history[: -self.keep_recent]
        if not old:
            return
        transcript = "\n".join(f"{m['role']}: {m['content']}" for m in old)
        if self.summary:
            transcript = f"已有摘要：{self.summary}\n\n新增对话：\n{transcript}"
        resp = client.chat.completions.create(
            model=MODEL,
            messages=[
                {"role": "system", "content": SUMMARY_PROMPT},
                {"role": "user", "content": transcript},
            ],
            temperature=0,
        )
        self.summary = resp.choices[0].message.content or self.summary
        self.history = self.history[-self.keep_recent :]

    def chat(self, user_input: str) -> str:
        user_input = user_input.strip()
        if not user_input:
            raise ValueError("输入不能为空")
        self.history.append({"role": "user", "content": user_input})
        if self._size() > self.max_chars:
            self._compress()
        try:
            resp = client.chat.completions.create(model=MODEL, messages=self.build_messages())
        except Exception:
            self.history.pop()  # 调用失败时回滚本轮输入，避免历史里出现孤立的 user 消息
            raise
        answer = resp.choices[0].message.content or ""
        self.history.append({"role": "assistant", "content": answer})
        return answer


if __name__ == "__main__":
    s = Session("你是一个简洁的编程助手。", max_chars=2000, keep_recent=4)
    while True:
        try:
            text = input("你> ")
        except (EOFError, KeyboardInterrupt):
            break
        if text.strip() in {"exit", "quit"}:
            break
        if text.strip():
            print("AI>", s.chat(text))
            print(f"   [历史 {len(s.history)} 条，摘要 {len(s.summary)} 字]")
```

```go [Go]
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

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

var httpClient = &http.Client{Timeout: 60 * time.Second}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// chat 调用 OpenAI 兼容的 /chat/completions 接口
func chat(msgs []Message, temperature float64) (string, error) {
	body, _ := json.Marshal(map[string]any{
		"model":       getenv("LLM_MODEL", "gpt-4o-mini"),
		"messages":    msgs,
		"temperature": temperature,
	})
	url := strings.TrimRight(getenv("OPENAI_BASE_URL", "https://api.openai.com/v1"), "/") + "/chat/completions"
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
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
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("HTTP %d: %s", resp.StatusCode, data)
	}
	var out struct {
		Choices []struct {
			Message Message `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return "", err
	}
	if len(out.Choices) == 0 {
		return "", errors.New("empty choices")
	}
	return out.Choices[0].Message.Content, nil
}

const summaryPrompt = "你是对话压缩器。请把下面的对话压缩成一段摘要，保留：用户的目标、" +
	"已确认的事实与决定、尚未完成的事项。不要编造，不超过 300 字。"

// Session 带滚动摘要的短期记忆，用字符数近似 Token 数
type Session struct {
	System     string
	Summary    string
	History    []Message
	MaxChars   int
	KeepRecent int
}

func (s *Session) size() int {
	n := len([]rune(s.Summary))
	for _, m := range s.History {
		n += len([]rune(m.Content))
	}
	return n
}

func (s *Session) buildMessages() []Message {
	sys := s.System
	if s.Summary != "" {
		sys += "\n\n# 之前对话的摘要\n" + s.Summary
	}
	return append([]Message{{Role: "system", Content: sys}}, s.History...)
}

func (s *Session) compress() error {
	if len(s.History) <= s.KeepRecent {
		return nil
	}
	cut := len(s.History) - s.KeepRecent
	var b strings.Builder
	if s.Summary != "" {
		b.WriteString("已有摘要：" + s.Summary + "\n\n新增对话：\n")
	}
	for _, m := range s.History[:cut] {
		b.WriteString(m.Role + ": " + m.Content + "\n")
	}
	summary, err := chat([]Message{
		{Role: "system", Content: summaryPrompt},
		{Role: "user", Content: b.String()},
	}, 0)
	if err != nil {
		return err // 压缩失败时保留原历史，下次再试
	}
	s.Summary = summary
	s.History = append([]Message(nil), s.History[cut:]...)
	return nil
}

func (s *Session) Chat(input string) (string, error) {
	input = strings.TrimSpace(input)
	if input == "" {
		return "", errors.New("输入不能为空")
	}
	s.History = append(s.History, Message{Role: "user", Content: input})
	if s.size() > s.MaxChars {
		if err := s.compress(); err != nil {
			fmt.Fprintln(os.Stderr, "压缩失败:", err)
		}
	}
	answer, err := chat(s.buildMessages(), 0.7)
	if err != nil {
		s.History = s.History[:len(s.History)-1] // 回滚本轮输入
		return "", err
	}
	s.History = append(s.History, Message{Role: "assistant", Content: answer})
	return answer, nil
}

func main() {
	s := &Session{System: "你是一个简洁的编程助手。", MaxChars: 2000, KeepRecent: 4}
	sc := bufio.NewScanner(os.Stdin)
	for fmt.Print("你> "); sc.Scan(); fmt.Print("你> ") {
		text := strings.TrimSpace(sc.Text())
		if text == "exit" || text == "quit" {
			return
		}
		if text == "" {
			continue
		}
		answer, err := s.Chat(text)
		if err != nil {
			fmt.Println("错误:", err)
			continue
		}
		fmt.Println("AI>", answer)
		fmt.Printf("   [历史 %d 条，摘要 %d 字]\n", len(s.History), len([]rune(s.Summary)))
	}
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
import java.util.List;
import java.util.Map;
import java.util.Scanner;

public class Main {
    record Message(String role, String content) {}

    static final ObjectMapper MAPPER = new ObjectMapper();
    static final HttpClient HTTP = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10)).build();

    static String env(String key, String def) {
        String v = System.getenv(key);
        return (v == null || v.isBlank()) ? def : v;
    }

    /** 调用 OpenAI 兼容的 /chat/completions 接口 */
    static String chat(List<Message> messages, double temperature) throws Exception {
        String body = MAPPER.writeValueAsString(Map.of(
                "model", env("LLM_MODEL", "gpt-4o-mini"),
                "messages", messages,
                "temperature", temperature));
        String base = env("OPENAI_BASE_URL", "https://api.openai.com/v1").replaceAll("/+$", "");
        HttpRequest req = HttpRequest.newBuilder(URI.create(base + "/chat/completions"))
                .timeout(Duration.ofSeconds(60))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + System.getenv("OPENAI_API_KEY"))
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();
        HttpResponse<String> resp = HTTP.send(req, HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() != 200) {
            throw new RuntimeException("HTTP " + resp.statusCode() + ": " + resp.body());
        }
        JsonNode root = MAPPER.readTree(resp.body());
        return root.path("choices").path(0).path("message").path("content").asText("");
    }

    static final String SUMMARY_PROMPT = "你是对话压缩器。请把下面的对话压缩成一段摘要，保留：用户的目标、"
            + "已确认的事实与决定、尚未完成的事项。不要编造，不超过 300 字。";

    /** 带滚动摘要的短期记忆，用字符数近似 Token 数 */
    static class Session {
        final String system;
        final int maxChars;
        final int keepRecent;
        String summary = "";
        List<Message> history = new ArrayList<>();

        Session(String system, int maxChars, int keepRecent) {
            this.system = system;
            this.maxChars = maxChars;
            this.keepRecent = keepRecent;
        }

        int size() {
            return summary.length() + history.stream().mapToInt(m -> m.content().length()).sum();
        }

        List<Message> buildMessages() {
            String sys = summary.isEmpty() ? system : system + "\n\n# 之前对话的摘要\n" + summary;
            List<Message> msgs = new ArrayList<>();
            msgs.add(new Message("system", sys));
            msgs.addAll(history);
            return msgs;
        }

        void compress() throws Exception {
            if (history.size() <= keepRecent) return;
            int cut = history.size() - keepRecent;
            StringBuilder sb = new StringBuilder();
            if (!summary.isEmpty()) sb.append("已有摘要：").append(summary).append("\n\n新增对话：\n");
            for (Message m : history.subList(0, cut)) {
                sb.append(m.role()).append(": ").append(m.content()).append("\n");
            }
            // 内部类里有同名方法 chat(String)，这里必须写 Main.chat 才能调用外层方法
            summary = Main.chat(List.of(new Message("system", SUMMARY_PROMPT),
                    new Message("user", sb.toString())), 0);
            history = new ArrayList<>(history.subList(cut, history.size()));
        }

        String chat(String input) throws Exception {
            input = input.strip();
            if (input.isEmpty()) throw new IllegalArgumentException("输入不能为空");
            history.add(new Message("user", input));
            if (size() > maxChars) {
                try {
                    compress();
                } catch (Exception e) {
                    System.err.println("压缩失败: " + e.getMessage()); // 保留原历史，下次再试
                }
            }
            String answer;
            try {
                answer = Main.chat(buildMessages(), 0.7);
            } catch (Exception e) {
                history.remove(history.size() - 1); // 回滚本轮输入
                throw e;
            }
            history.add(new Message("assistant", answer));
            return answer;
        }
    }

    public static void main(String[] args) {
        Session s = new Session("你是一个简洁的编程助手。", 2000, 4);
        Scanner sc = new Scanner(System.in);
        while (true) {
            System.out.print("你> ");
            if (!sc.hasNextLine()) break;
            String text = sc.nextLine().strip();
            if (text.equals("exit") || text.equals("quit")) break;
            if (text.isEmpty()) continue;
            try {
                System.out.println("AI> " + s.chat(text));
                System.out.printf("   [历史 %d 条，摘要 %d 字]%n", s.history.size(), s.summary.length());
            } catch (Exception e) {
                System.out.println("错误: " + e.getMessage());
            }
        }
    }
}
```
:::

Java 依赖：`com.fasterxml.jackson.core:jackson-databind`（2.12 以上版本支持直接序列化 record）。

把 `max_chars` 设小一点（比如 2000）多聊几轮，就能看到"历史条数"回落、"摘要字数"增长。几个设计细节值得注意：

- **`keep_recent` 取偶数**：保证留下的是完整的"问—答"对。如果切在一对中间，可能留下一条孤立的 `assistant` 消息，部分厂商的 API 会因此报错。
- **压缩失败不致命**：摘要调用失败时保留原历史，下一轮再试。主流程不能因为"记忆整理"失败而中断。
- **摘要用 `temperature=0`**：压缩是信息保真任务，不需要创造性。

## 从单机到多用户

上面的 `Session` 存在进程内存里，进程重启就没了，也无法多实例部署。上线时一般这样改：

```text
  请求(session_id) ──► 加载会话 ──► 组装 messages ──► 调用 LLM ──► 追加并保存
                         │                                        │
                         └──────────── Redis / 数据库 ◄────────────┘
```

| 关注点 | 建议 |
| --- | --- |
| 存储 | Redis（设置 TTL，自动过期）或关系库的 `messages` 表；摘要单独一个字段 |
| 会话 ID | 服务端生成随机 ID，并校验它属于当前登录用户，防止越权读取他人会话 |
| 并发 | 同一会话的两个请求同时到达会互相覆盖历史，用分布式锁或乐观锁（版本号）串行化 |
| 审计 | 原始消息可另存一份完整日志，摘要只用于组装上下文，便于排查问题 |

## Agent 循环里的短期记忆

在 Agent 场景，`messages` 里大头往往不是对话，而是**工具结果**：一次网页抓取、一次 SQL 查询就可能几千 Token。除了摘要，还有几种针对性手段：

- **截断工具输出**：返回给模型前就限制长度，例如只保留前 N 行，再附一句"已截断，共 M 行"。
- **清理旧工具结果**：已经被后续步骤消化过的工具结果，可以替换成一行占位符，例如"[已省略：search 结果，共 12 条]"。
- **把状态外置**：计划清单、已收集的资料写进文件或"草稿本"，上下文里只保留引用，需要时再读回来。

这些属于 [上下文工程](/guide/07-context-engineering/overview) 的范畴，短期记忆管理本质上是它的一个子问题。

## 常见坑

- **工具调用消息被拆散**：带 `tool_calls` 的 `assistant` 消息和对应的 `tool` 消息必须同进同出。滑动窗口如果只删掉其中之一，API 会报错。裁剪时要以"完整的一轮"为单位。
- **把 system prompt 也算进裁剪范围**：system 消息要始终保留，否则角色设定和安全约束会在长对话中"失效"。
- **摘要漂移**：摘要反复压缩摘要，细节会逐渐失真甚至被改写。关键事实（订单号、用户确认过的参数）应提取成结构化字段单独保存，而不是只依赖摘要。
- **每轮都压缩**：阈值设得太低会导致频繁调用摘要，成本反而上升。建议在接近上限时一次性压缩一大段。
- **忽略 Prompt Caching**：频繁改写上下文开头会让缓存失效。把稳定内容放前面、变化内容放后面，参见 [Prompt Caching](/guide/07-context-engineering/prompt-caching)。

## 小测

**1.** 滑动窗口和滚动摘要各自的主要缺点是什么？

::: details 查看答案
滑动窗口会完全丢失早期信息，用户在开头说过的约束可能被"忘掉"；滚动摘要每次压缩多一次 LLM 调用，增加成本和延迟，而且摘要会丢细节，多次压缩后可能失真。
:::

**2.** 为什么示例中把摘要放进 system 消息，而不是作为一条 `assistant` 消息插入？

::: details 查看答案
放在 `assistant` 里，模型会把摘要当成"自己说过的话"，可能模仿它的风格，或者在用户追问时混淆来源。放在 system 里，语义更清楚：这是背景信息。另外也避免破坏 user / assistant 交替的消息结构。
:::

**3.** 同一个用户在两个浏览器标签页同时发消息，基于 Redis 的会话存储可能出什么问题？

::: details 查看答案
两个请求都读到旧历史，各自追加后写回，后写的会覆盖先写的，导致一轮对话丢失。需要用锁或带版本号的乐观并发控制，把同一会话的写操作串行化。
:::

## 延伸阅读

- [OpenAI Chat Completions API 文档](https://platform.openai.com/docs/api-reference/chat)
- [tiktoken](https://github.com/openai/tiktoken)：OpenAI 的分词器，可用于精确计算 Token 数
- 本站：[Token 与上下文窗口](/guide/02-llm-basics/tokens-context)、[压缩与摘要](/guide/07-context-engineering/compression)、[长期记忆与用户画像](/guide/08-memory/long-term)

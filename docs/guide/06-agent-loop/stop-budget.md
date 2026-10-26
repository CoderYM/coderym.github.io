---
title: 终止条件、步数与预算控制
description: 给 Agent 装上刹车：最大步数、Token 预算、墙钟超时、重复调用检测，以及预算耗尽时如何体面收尾。
---

# 终止条件、步数与预算控制

::: info 学习目标
- 区分 Agent 的"正常结束"和"被迫停止"，知道各自的触发条件
- 实现四种硬性限制：最大步数、Token 预算、墙钟超时、重复调用检测
- 预算耗尽时让 Agent 基于已有信息体面收尾，而不是直接报错
- 知道各项预算怎么定、怎么监控
:::

## Agent 为什么停不下来

在 [不用框架手写 Agent](/guide/06-agent-loop/handwritten-agent) 里，循环结束的唯一正常条件是"模型不再调用工具"。这意味着什么时候停，完全由模型决定。实际运行中，模型会以各种方式停不下来：

- 原地打转：搜索没结果，换个空格再搜一次，再搜一次……
- 无限细化：每次都觉得"再查一点会更好"。
- 工具卡住：某个外部 API 一直不返回，整个请求挂着。
- 上下文膨胀：每一步都把长结果追加进历史，越往后单次调用越贵、越慢。

一个失控的 Agent 消耗的不只是钱，还有用户的耐心和下游系统的配额。所以生产环境的 Agent 必须有不依赖模型判断的硬性刹车。

## 终止条件全景

| 类型 | 条件 | 由谁判断 | 结束后怎么做 |
| --- | --- | --- | --- |
| 正常完成 | 模型返回没有 `tool_calls` 的回答 | 模型 | 直接返回答案 |
| 主动放弃 | 模型说明无法完成（可以提供一个 `give_up` 工具） | 模型 | 返回原因，可转人工 |
| 步数上限 | 循环轮数达到 `max_steps` | 程序 | 收尾总结 |
| Token 预算 | 累计 Token 达到上限 | 程序 | 收尾总结 |
| 墙钟超时 | 从开始到现在超过 N 秒 | 程序 | 收尾总结或直接返回 |
| 重复调用 | 同一工具、同样参数被反复调用 | 程序 | 先提醒，再停止 |
| 外部取消 | 用户点了"停止"、请求断开 | 调用方 | 立即停止，保存状态 |

前两种是"软终止"，依赖模型；后面几种是"硬终止"，由程序强制执行。软终止决定了 Agent 的质量，硬终止决定了 Agent 的下限。

## 四种硬性限制

### 1. 最大步数

最简单也最重要的一道防线。一"步"通常定义为一次模型调用（一次调用里的多个并行工具算同一步）。步数的取值可以参考评估集：统计正常任务的步数分布，把上限设在 P99 的 1.5~2 倍左右，既不误伤正常任务，又能拦住失控的情况。

### 2. Token 预算

每次响应的 `usage` 字段会告诉你这一轮的 `prompt_tokens`、`completion_tokens` 和 `total_tokens`。累加 `total_tokens` 就是这次任务的消耗。注意 Agent 的每一轮都会重新发送完整历史，所以累计 Token 大致随步数平方增长，第 10 步的一次调用可能比前 3 步加起来还贵。

只在调用后检查会超出一点（最多超一次调用的量）。要求严格时，可以在调用前估算这次请求的输入 Token，超出就不发，估算方法见 [Token 与上下文窗口](/guide/02-llm-basics/tokens-context)。

### 3. 墙钟超时

步数和 Token 都限制不住"慢"：一次工具调用卡 5 分钟，步数只算一步。墙钟超时从任务开始计时，每次模型调用和工具调用的超时都取"单次上限"和"剩余时间"中的较小值。Go 里这正是 `context.WithTimeout` 的用法。

### 4. 重复调用检测

模型陷入循环最典型的信号是：同一个工具，同样的参数，调用了第二次、第三次。相同参数的调用通常会得到相同结果，再调用没有意义。检测方法是把 `工具名 + 规范化后的参数` 作为键计数：

- 第 2 次：照常执行，但在结果后附上提醒"你已经用相同参数调用过该工具，结果不会变化，请换一种思路"。很多时候模型看到这句话就会调整。
- 超过阈值：直接停止。

参数规范化很重要：`{"q":"a","n":1}` 和 `{"n":1,"q":"a"}` 应该算同一个调用，所以要先解析 JSON 再按键排序序列化。更进一步还可以检测"A、B、A、B"式的交替循环，这里不展开。

## 体面收尾

预算耗尽时，Agent 往往已经收集了一些有用信息。直接抛错丢掉这些信息很可惜。更好的做法是再发一次请求，告诉模型"预算用完了，不要再调用工具，基于已有信息给出最好的回答，并说明哪些部分没完成"。这次请求带上 `tool_choice: "none"`，禁止模型继续调用工具。

收尾调用本身也要有超时，并且失败时要有一个固定的兜底文案。另外，返回结果时带上停止原因（`completed` / `max_steps` / `timeout` 等），方便日志统计和前端展示。

## 动手实现

下面把四种限制封装成一个 `Budget` 对象，嵌入 Agent 循环。为了能稳定复现"停不下来"，示例里的 `search_docs` 工具永远返回"没有找到"，模型很可能会不断换说法重试。

注意检查的位置：重复调用检测在追加 assistant 消息之前完成。如果在追加之后、工具结果写完之前抛出，历史里会留下没有对应 `tool` 消息的 `tool_calls`，收尾请求会被 API 拒绝。

::: code-group
```python [Python]
import json
import os
import time

from openai import APITimeoutError, OpenAI

client = OpenAI(api_key=os.environ["OPENAI_API_KEY"], base_url=os.getenv("OPENAI_BASE_URL") or None)
MODEL = os.getenv("LLM_MODEL", "gpt-4o-mini")

TOOLS = [{"type": "function", "function": {
    "name": "search_docs", "description": "搜索内部文档",
    "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}}]


def search_docs(query: str) -> str:
    return "没有找到相关文档"  # 故意永远搜不到，诱发模型反复重试


class BudgetExceeded(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


class Budget:
    def __init__(self, max_steps=6, max_tokens=20_000, max_seconds=60.0, max_repeats=2):
        self.max_steps, self.max_tokens, self.max_repeats = max_steps, max_tokens, max_repeats
        self.deadline = time.monotonic() + max_seconds
        self.steps = self.tokens = 0
        self.seen: dict[str, int] = {}

    def remaining_seconds(self) -> float:
        return self.deadline - time.monotonic()

    def before_step(self):
        if self.steps >= self.max_steps:
            raise BudgetExceeded("max_steps")
        if self.tokens >= self.max_tokens:
            raise BudgetExceeded("max_tokens")
        if self.remaining_seconds() <= 0:
            raise BudgetExceeded("timeout")
        self.steps += 1

    def add_usage(self, usage):
        self.tokens += usage.total_tokens if usage else 0

    def record_call(self, name: str, raw_args: str) -> int:
        try:  # 规范化参数：键排序后再比较，避免顺序不同被当成不同调用
            key = name + json.dumps(json.loads(raw_args or "{}"), sort_keys=True, ensure_ascii=False)
        except json.JSONDecodeError:
            key = name + raw_args
        self.seen[key] = self.seen.get(key, 0) + 1
        if self.seen[key] > self.max_repeats:
            raise BudgetExceeded("repeated_tool_call")
        return self.seen[key]


REPEAT_HINT = "\n[提醒] 你已经用相同参数调用过该工具，结果不会变化，请换一种思路或直接回答。"
WRAP_UP = "预算已用完。不要再调用工具，基于目前已有的信息给出最好的回答，并说明哪些部分没有完成。"
FALLBACK = "抱歉，这个问题在限定时间内没能完成，请稍后重试或联系人工。"


def run_tool(name: str, raw_args: str) -> str:
    if name != "search_docs":
        return f"错误：未知工具 {name}"
    try:
        args = json.loads(raw_args or "{}")
        return search_docs(str(args.get("query", "")))
    except (json.JSONDecodeError, AttributeError) as e:
        return f"错误：参数不合法 {e}"


def wrap_up(messages: list) -> str:
    """预算耗尽后的收尾：禁止再调用工具，让模型基于已有信息作答。"""
    try:
        resp = client.chat.completions.create(
            model=MODEL, messages=messages + [{"role": "user", "content": WRAP_UP}],
            tools=TOOLS, tool_choice="none", timeout=20)
        return resp.choices[0].message.content or FALLBACK
    except Exception:
        return FALLBACK


def run_agent(question: str, budget: Budget) -> tuple[str, str]:
    messages = [{"role": "system", "content": "你是公司内部助手，回答前先用 search_docs 查文档。"},
                {"role": "user", "content": question}]
    try:
        while True:
            budget.before_step()
            step_timeout = max(1.0, min(30.0, budget.remaining_seconds()))  # 单次超时不超过剩余时间
            resp = client.chat.completions.create(
                model=MODEL, messages=messages, tools=TOOLS, timeout=step_timeout)
            budget.add_usage(resp.usage)
            msg = resp.choices[0].message
            if not msg.tool_calls:
                return msg.content or "", "completed"
            # 先做重复检测再追加消息，保证历史里每个 tool_call 都有对应结果
            counts = [budget.record_call(tc.function.name, tc.function.arguments) for tc in msg.tool_calls]
            messages.append({"role": "assistant", "content": msg.content, "tool_calls": [
                {"id": tc.id, "type": "function",
                 "function": {"name": tc.function.name, "arguments": tc.function.arguments}}
                for tc in msg.tool_calls]})
            for tc, n in zip(msg.tool_calls, counts):
                result = run_tool(tc.function.name, tc.function.arguments) + (REPEAT_HINT if n > 1 else "")
                print(f"[step {budget.steps}] {tc.function.name}({tc.function.arguments}) x{n}")
                messages.append({"role": "tool", "tool_call_id": tc.id, "content": result})
    except BudgetExceeded as e:
        reason = e.reason
    except APITimeoutError:
        reason = "timeout"
    print(f"[budget] 停止原因：{reason}，步数 {budget.steps}，累计 Token {budget.tokens}")
    return wrap_up(messages), reason


if __name__ == "__main__":
    answer, reason = run_agent("出差住宿的报销标准是多少？", Budget())
    print(f"({reason}) {answer}")
```

```go [Go]
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

type ToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type Message struct {
	Role       string     `json:"role"`
	Content    string     `json:"content"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
}

var tools = []map[string]any{{"type": "function", "function": map[string]any{
	"name": "search_docs", "description": "搜索内部文档",
	"parameters": map[string]any{"type": "object",
		"properties": map[string]any{"query": map[string]any{"type": "string"}}, "required": []string{"query"}},
}}}

const (
	repeatHint = "\n[提醒] 你已经用相同参数调用过该工具，结果不会变化，请换一种思路或直接回答。"
	wrapUpMsg  = "预算已用完。不要再调用工具，基于目前已有的信息给出最好的回答，并说明哪些部分没有完成。"
	fallback   = "抱歉，这个问题在限定时间内没能完成，请稍后重试或联系人工。"
)

// ---------- 预算 ----------
type BudgetExceeded struct{ Reason string }

func (e *BudgetExceeded) Error() string { return "budget exceeded: " + e.Reason }

type Budget struct {
	MaxSteps, MaxTokens, MaxRepeats int
	Steps, Tokens                   int
	seen                            map[string]int
}

func NewBudget() *Budget {
	return &Budget{MaxSteps: 6, MaxTokens: 20000, MaxRepeats: 2, seen: map[string]int{}}
}

func (b *Budget) BeforeStep(ctx context.Context) error {
	switch {
	case b.Steps >= b.MaxSteps:
		return &BudgetExceeded{"max_steps"}
	case b.Tokens >= b.MaxTokens:
		return &BudgetExceeded{"max_tokens"}
	case ctx.Err() != nil: // 墙钟超时由 context 的 deadline 负责
		return &BudgetExceeded{"timeout"}
	}
	b.Steps++
	return nil
}

func (b *Budget) RecordCall(name, rawArgs string) (int, error) {
	key := name + rawArgs
	var v any
	if json.Unmarshal([]byte(rawArgs), &v) == nil {
		norm, _ := json.Marshal(v) // Go 序列化 map 时按键排序，相当于规范化
		key = name + string(norm)
	}
	b.seen[key]++
	if b.seen[key] > b.MaxRepeats {
		return 0, &BudgetExceeded{"repeated_tool_call"}
	}
	return b.seen[key], nil
}

// ---------- 模型调用：超时由 ctx 控制 ----------
func chat(ctx context.Context, messages []Message, toolChoice string) (Message, int, error) {
	base := os.Getenv("OPENAI_BASE_URL")
	if base == "" {
		base = "https://api.openai.com/v1"
	}
	model := os.Getenv("LLM_MODEL")
	if model == "" {
		model = "gpt-4o-mini"
	}
	body, _ := json.Marshal(map[string]any{"model": model, "messages": messages, "tools": tools, "tool_choice": toolChoice})
	req, err := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(base, "/")+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return Message{}, 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+os.Getenv("OPENAI_API_KEY"))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return Message{}, 0, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return Message{}, 0, fmt.Errorf("HTTP %d: %s", resp.StatusCode, data)
	}
	var out struct {
		Choices []struct {
			Message Message `json:"message"`
		} `json:"choices"`
		Usage struct {
			TotalTokens int `json:"total_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(data, &out); err != nil || len(out.Choices) == 0 {
		return Message{}, 0, fmt.Errorf("无法解析响应: %s", data)
	}
	return out.Choices[0].Message, out.Usage.TotalTokens, nil
}

func runTool(name, rawArgs string) string {
	if name != "search_docs" {
		return "错误：未知工具 " + name
	}
	var args struct {
		Query string `json:"query"`
	}
	if err := json.Unmarshal([]byte(rawArgs), &args); err != nil {
		return "错误：参数不合法 " + err.Error()
	}
	return "没有找到相关文档" // 故意永远搜不到，诱发模型反复重试
}

// wrapUp：预算耗尽后的收尾，用独立的短超时，禁止再调用工具
func wrapUp(messages []Message) string {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	msg, _, err := chat(ctx, append(messages, Message{Role: "user", Content: wrapUpMsg}), "none")
	if err != nil || msg.Content == "" {
		return fallback
	}
	return msg.Content
}

func runAgent(question string, b *Budget, maxDuration time.Duration) (string, string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), maxDuration) // 整个任务的墙钟预算
	defer cancel()
	messages := []Message{
		{Role: "system", Content: "你是公司内部助手，回答前先用 search_docs 查文档。"},
		{Role: "user", Content: question},
	}
	err := func() error {
		for {
			if err := b.BeforeStep(ctx); err != nil {
				return err
			}
			stepCtx, stepCancel := context.WithTimeout(ctx, 30*time.Second) // 取单次上限与剩余时间的较小值
			msg, used, err := chat(stepCtx, messages, "auto")
			stepCancel()
			if err != nil {
				return err
			}
			b.Tokens += used
			if len(msg.ToolCalls) == 0 {
				messages = append(messages, msg)
				return nil
			}
			// 先做重复检测再追加消息，保证历史里每个 tool_call 都有对应结果
			counts := make([]int, len(msg.ToolCalls))
			for i, tc := range msg.ToolCalls {
				if counts[i], err = b.RecordCall(tc.Function.Name, tc.Function.Arguments); err != nil {
					return err
				}
			}
			messages = append(messages, msg)
			for i, tc := range msg.ToolCalls {
				result := runTool(tc.Function.Name, tc.Function.Arguments)
				if counts[i] > 1 {
					result += repeatHint
				}
				fmt.Printf("[step %d] %s(%s) x%d\n", b.Steps, tc.Function.Name, tc.Function.Arguments, counts[i])
				messages = append(messages, Message{Role: "tool", ToolCallID: tc.ID, Content: result})
			}
		}
	}()

	var be *BudgetExceeded
	switch {
	case err == nil:
		return messages[len(messages)-1].Content, "completed", nil
	case errors.As(err, &be):
		err = nil
	case errors.Is(err, context.DeadlineExceeded):
		be, err = &BudgetExceeded{"timeout"}, nil
	default:
		return "", "error", err // 鉴权失败等非预算错误，直接交给调用方
	}
	fmt.Printf("[budget] 停止原因：%s，步数 %d，累计 Token %d\n", be.Reason, b.Steps, b.Tokens)
	return wrapUp(messages), be.Reason, nil
}

func main() {
	answer, reason, err := runAgent("出差住宿的报销标准是多少？", NewBudget(), 60*time.Second)
	if err != nil {
		fmt.Fprintln(os.Stderr, "出错:", err)
		os.Exit(1)
	}
	fmt.Printf("(%s) %s\n", reason, answer)
}
```

```java [Java]
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

public class BudgetAgent {
    static final ObjectMapper JSON = new ObjectMapper();
    // 规范化参数用：序列化 Map 时按键排序
    static final ObjectMapper SORTED = new ObjectMapper().configure(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS, true);
    static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    static final List<Map<String, Object>> TOOLS = List.of(Map.of("type", "function", "function", Map.of(
            "name", "search_docs", "description", "搜索内部文档",
            "parameters", Map.of("type", "object",
                    "properties", Map.of("query", Map.of("type", "string")), "required", List.of("query")))));
    static final String REPEAT_HINT = "\n[提醒] 你已经用相同参数调用过该工具，结果不会变化，请换一种思路或直接回答。";
    static final String WRAP_UP = "预算已用完。不要再调用工具，基于目前已有的信息给出最好的回答，并说明哪些部分没有完成。";
    static final String FALLBACK = "抱歉，这个问题在限定时间内没能完成，请稍后重试或联系人工。";

    record Result(String answer, String reason) {}

    static final class BudgetExceeded extends Exception {
        final String reason;
        BudgetExceeded(String reason) { super(reason); this.reason = reason; }
    }

    static final class Budget {
        final int maxSteps = 6, maxTokens = 20_000, maxRepeats = 2;
        final Instant deadline;
        int steps, tokens;
        final Map<String, Integer> seen = new HashMap<>();

        Budget(Duration maxDuration) { deadline = Instant.now().plus(maxDuration); }

        Duration remaining() { return Duration.between(Instant.now(), deadline); }

        void beforeStep() throws BudgetExceeded {
            if (steps >= maxSteps) throw new BudgetExceeded("max_steps");
            if (tokens >= maxTokens) throw new BudgetExceeded("max_tokens");
            if (remaining().isNegative() || remaining().isZero()) throw new BudgetExceeded("timeout");
            steps++;
        }

        int recordCall(String name, String rawArgs) throws BudgetExceeded {
            String key;
            try {
                key = name + SORTED.writeValueAsString(SORTED.readValue(rawArgs, Map.class));
            } catch (Exception e) {
                key = name + rawArgs;
            }
            int n = seen.merge(key, 1, Integer::sum);
            if (n > maxRepeats) throw new BudgetExceeded("repeated_tool_call");
            return n;
        }
    }

    /** 返回完整响应 JSON；timeout 取单次上限与剩余时间的较小值。 */
    static JsonNode chat(ArrayNode messages, String toolChoice, Duration timeout) throws Exception {
        String base = Objects.requireNonNullElse(System.getenv("OPENAI_BASE_URL"), "https://api.openai.com/v1");
        ObjectNode body = JSON.createObjectNode();
        body.put("model", Objects.requireNonNullElse(System.getenv("LLM_MODEL"), "gpt-4o-mini"));
        body.set("messages", messages);
        body.set("tools", JSON.valueToTree(TOOLS));
        body.put("tool_choice", toolChoice);
        HttpRequest req = HttpRequest.newBuilder(URI.create(base.replaceAll("/+$", "") + "/chat/completions"))
                .timeout(timeout)
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + System.getenv("OPENAI_API_KEY"))
                .POST(HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(body))).build();
        HttpResponse<String> resp = HTTP.send(req, HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() != 200) throw new RuntimeException("HTTP " + resp.statusCode() + ": " + resp.body());
        return JSON.readTree(resp.body());
    }

    static String runTool(String name, String rawArgs) {
        if (!name.equals("search_docs")) return "错误：未知工具 " + name;
        try {
            JSON.readTree(rawArgs);
            return "没有找到相关文档"; // 故意永远搜不到，诱发模型反复重试
        } catch (Exception e) {
            return "错误：参数不合法 " + e.getMessage();
        }
    }

    /** 预算耗尽后的收尾：独立的短超时，禁止再调用工具。 */
    static String wrapUp(ArrayNode messages) {
        try {
            ArrayNode copy = messages.deepCopy();
            copy.addObject().put("role", "user").put("content", WRAP_UP);
            String text = chat(copy, "none", Duration.ofSeconds(20))
                    .path("choices").path(0).path("message").path("content").asText("");
            return text.isBlank() ? FALLBACK : text;
        } catch (Exception e) {
            return FALLBACK;
        }
    }

    static Result runAgent(String question, Budget b) throws Exception {
        ArrayNode messages = JSON.createArrayNode();
        messages.addObject().put("role", "system").put("content", "你是公司内部助手，回答前先用 search_docs 查文档。");
        messages.addObject().put("role", "user").put("content", question);
        String reason;
        try {
            while (true) {
                b.beforeStep();
                Duration remaining = b.remaining();
                Duration stepTimeout = remaining.compareTo(Duration.ofSeconds(30)) < 0 ? remaining : Duration.ofSeconds(30);
                JsonNode resp = chat(messages, "auto", stepTimeout);
                b.tokens += resp.path("usage").path("total_tokens").asInt(0);
                JsonNode msg = resp.path("choices").path(0).path("message");
                JsonNode calls = msg.path("tool_calls");
                if (!calls.isArray() || calls.isEmpty()) return new Result(msg.path("content").asText(""), "completed");
                // 先做重复检测再追加消息，保证历史里每个 tool_call 都有对应结果
                int[] counts = new int[calls.size()];
                for (int i = 0; i < calls.size(); i++) {
                    JsonNode fn = calls.get(i).path("function");
                    counts[i] = b.recordCall(fn.path("name").asText(), fn.path("arguments").asText());
                }
                messages.add(msg);
                for (int i = 0; i < calls.size(); i++) {
                    JsonNode tc = calls.get(i);
                    String name = tc.path("function").path("name").asText();
                    String args = tc.path("function").path("arguments").asText();
                    String result = runTool(name, args) + (counts[i] > 1 ? REPEAT_HINT : "");
                    System.out.printf("[step %d] %s(%s) x%d%n", b.steps, name, args, counts[i]);
                    messages.addObject().put("role", "tool").put("tool_call_id", tc.path("id").asText()).put("content", result);
                }
            }
        } catch (BudgetExceeded e) {
            reason = e.reason;
        } catch (HttpTimeoutException e) {
            reason = "timeout";
        }
        System.out.printf("[budget] 停止原因：%s，步数 %d，累计 Token %d%n", reason, b.steps, b.tokens);
        return new Result(wrapUp(messages), reason);
    }

    public static void main(String[] args) throws Exception {
        Result r = runAgent("出差住宿的报销标准是多少？", new Budget(Duration.ofSeconds(60)));
        System.out.printf("(%s) %s%n", r.reason(), r.answer());
    }
}
```
:::

一次典型的运行（模型行为因模型而异）：

```text
[step 1] search_docs({"query": "出差住宿报销标准"}) x1
[step 2] search_docs({"query": "住宿费报销"}) x1
[step 3] search_docs({"query": "出差住宿报销标准"}) x2     ← 重复，结果后附上提醒
[step 4] search_docs({"query": "差旅费管理办法"}) x1
[budget] 停止原因：repeated_tool_call，步数 5，累计 Token 3842
(repeated_tool_call) 很抱歉，我在内部文档中多次检索"出差住宿报销标准""差旅费管理办法"等关键词，都没有找到相关内容。建议直接咨询财务部门……
```

第 5 步模型第三次用"出差住宿报销标准"搜索，超过了 `max_repeats=2`，在执行之前就被拦下（所以没有打印 step 5）。如果模型每次都换关键词，就会在第 6 步之后撞上 `max_steps`。不管被哪条规则拦下，用户最终拿到的都是一段说明情况的回答，而不是一个报错页面。

## 预算怎么定

| 预算项 | 参考做法 | 监控指标 |
| --- | --- | --- |
| `max_steps` | 评估集上正常任务步数的 P99 × 1.5~2 | 撞上限的任务比例 |
| `max_tokens` | 按单个任务可接受的成本反推 | 每任务 Token 的分布、平均值 |
| `max_seconds` | 按产品体验定：同步对话通常几十秒，后台任务可以几分钟到几十分钟 | P95 延迟、超时比例 |
| `max_repeats` | 2~3 次 | 重复检测触发次数 |

几个经验：

- 预算按场景分层。客服问答和后台研究报告的预算可以差几十倍，不要全局一个值。
- 撞上限的比例是重要的质量信号。比例突然升高，往往说明工具坏了、提示词改坏了，或者模型换了版本。这类指标应接入 [轨迹追踪与可观测性](/guide/14-evaluation/observability)。
- 预算要和 [上下文窗口管理](/guide/07-context-engineering/window-management) 配合：控制每一轮的上下文长度，才能让 Token 预算撑得更久。成本优化的整体思路见 [成本与延迟优化](/guide/15-production/cost-optimization)。
- 多 Agent 系统里，预算要在整个任务层面统一扣减，否则子 Agent 各自"合规"，加起来却失控，见 [多 Agent 的坑与成本控制](/guide/12-multi-agent/pitfalls)。

## 常见坑

- 只有步数没有超时。一个卡住的工具调用就能让请求挂起几分钟。每个外部调用都要有超时，整体还要有墙钟预算。
- 超时只设在最外层。外层超时了，内层的 HTTP 请求还在跑，浪费资源。Go 用同一个 `context` 往下传，Python / Java 把剩余时间传给每次调用。
- 预算耗尽直接抛异常。用户看到"Internal Server Error"，已经收集到的信息全部丢失。应该收尾总结，并带上停止原因。
- 收尾时历史不完整。assistant 消息里有 `tool_calls`，却缺少对应的 `tool` 消息，收尾请求会被 API 拒绝。检测要放在追加消息之前，或者在收尾前补齐占位结果。
- 重复检测不规范化参数。键顺序不同、多一个空格，就绕过了检测。至少要解析 JSON 后按键排序再比较。
- 把重复调用一律当错误。轮询类工具（"查询任务状态"）本来就需要重复调用。这类工具应该豁免，或者改用"结果没有变化"来判断。

## 小测

1. 已经有了 `max_steps`，为什么还需要墙钟超时和 Token 预算？

::: details 查看答案
三者限制的是不同维度。步数限制不了"慢"：一步里的工具调用可能卡住很久。步数也限制不了"贵"：每一轮都会重发完整历史，后面的步骤单次 Token 远高于前面，同样的步数在不同任务上成本差异很大。只有三者同时存在，才能同时兜住次数、时间和成本。
:::

2. 示例代码为什么要在追加 assistant 消息之前做重复检测？

::: details 查看答案
API 要求 assistant 消息里的每个 `tool_call` 都有一条对应的 `tool` 消息。如果先追加 assistant 消息，再在处理工具调用的过程中因为重复检测抛出异常，历史里就会留下没有结果的 `tool_calls`，随后的收尾请求会因为消息结构不合法而失败。先检测再追加，保证历史始终是合法的。
:::

3. 预算耗尽后，收尾请求为什么要设置 `tool_choice: "none"`？

::: details 查看答案
收尾的目的是让模型基于已有信息直接作答。不禁止工具，模型很可能再发起一次工具调用，此时你既不能执行（预算已耗尽），又拿不到文字回答。设置 `tool_choice: "none"` 强制模型输出文本。
:::

## 延伸阅读

- [不用框架手写 Agent](/guide/06-agent-loop/handwritten-agent)
- [工具错误处理与重试](/guide/05-tool-calling/error-handling)
- [计费、限流与错误重试](/guide/03-llm-api/cost-errors)
- [OpenAI Chat Completions API 参考](https://platform.openai.com/docs/api-reference/chat)（`tool_choice`、`usage` 等字段以官方文档为准）

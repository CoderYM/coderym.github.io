---
title: 上下文窗口管理
description: 给上下文窗口做预算：Token 估算、工具结果截断、按 Token 预算裁剪历史，以及裁剪时不能拆散的消息对。
---

# 上下文窗口管理

::: info 学习目标
- 学会给一次调用的上下文做预算：窗口上限、输出预留、固定开销
- 掌握三种基础手段：工具结果截断、滑动窗口、按 Token 预算裁剪
- 理解为什么 assistant 的 `tool_calls` 和对应的 `tool` 消息必须作为整体保留或丢弃
- 动手实现一个可复用的 `fit_to_budget` 函数
:::

## 先算账：窗口预算

模型的上下文窗口（比如 128K Token）是输入和输出共享的。真正留给对话历史的空间要扣掉好几块：

```text
context limit (e.g. 128K)
├── reserved output       max_tokens for the reply       e.g. 4K
├── fixed overhead        system prompt + tool schemas   e.g. 3K
├── retrieved context     RAG chunks / memory            e.g. 6K
└── history budget        everything else                = the rest
```

实际项目里很少把窗口用满。更常见的做法是给历史设一个远低于上限的软预算（比如 1.6 万或 3.2 万 Token），原因在 [什么是上下文工程](/guide/07-context-engineering/overview) 里讲过：成本、延迟和注意力稀释都会在接近上限之前就开始恶化。

### Token 怎么数

精确计数要用模型对应的 tokenizer，比如 OpenAI 模型可以用 `tiktoken`；其他厂商的 tokenizer 不同，同一段中文的 Token 数可能差不少。每次响应的 `usage.prompt_tokens` 是最准确的事后数据。

做预算时，粗略估算通常就够了：

- 中文：大约 1 个汉字 1 个 Token 左右（因 tokenizer 而异，可能更少也可能更多）
- 英文和代码：大约 4 个字符 1 个 Token
- 每条消息还有角色、分隔符等少量固定开销

估算的误差用"预算留余量"来吸收，比如预算按窗口的 70% 算。Token 的基础知识见 [Token 与上下文窗口](/guide/02-llm-basics/tokens-context)。

## 三种基础手段

### 1. 在入口截断工具结果

工具结果是窗口最大的消耗者，也是最容易控制的。原则是：在结果进入 `messages` 之前就截断，而不是等窗口满了再处理。

- 日志、命令输出：保留开头和结尾，中间用"省略 N 字符"标记。错误信息通常出现在结尾，上下文出现在开头。
- 列表类结果：只返回前 N 条，并告诉模型总数和如何翻页。
- 网页、文档：只返回正文的相关段落，或者先摘要，见 [压缩与摘要](/guide/07-context-engineering/compression)。
- 超大结果：存到文件或对象存储，只返回路径和摘要，让模型需要时再用工具读取局部。

截断时一定要明确告诉模型"这里被截断了"，否则模型会以为看到的就是全部。

### 2. 滑动窗口

只保留最近 N 轮对话。实现最简单，适合闲聊类应用。缺点也明显：按"轮"计数不考虑每轮长短，一轮里有个大工具结果就可能超标；而且最早的用户需求会被滑出窗口。

### 3. 按 Token 预算裁剪

更稳妥的做法：

1. 固定保留开头的系统提示词和用户的原始任务。
2. 把剩余消息切成"不可拆分的单元"。
3. 从最新的单元往回装，装到预算用完为止。
4. 如果丢弃了内容，插入一条说明，让模型知道前面有省略。

第 2 步是最容易出错的地方。OpenAI 兼容接口要求：每条带 `tool_calls` 的 assistant 消息后面，必须跟着每个调用对应的 `tool` 消息；反过来，`tool` 消息前面也必须有发起它的 assistant 消息。按条数裁剪很容易把这一对拆开，API 会直接返回 400。所以要把"assistant(tool_calls) + 它的所有 tool 结果"绑成一个单元，要么整体保留，要么整体丢弃。

```text
messages:  [sys] [user task] [asst+calls] [tool] [tool] [asst+calls] [tool] [asst] [user] ...
units:     ─head─────────── │──────── unit ──────────│──── unit ─────│ unit │ unit │
                                                            keep from newest ◄──────────
```

## 动手实现

下面的代码实现三个函数：`estimate_tokens`（粗略估算）、`truncate_middle`（工具结果截断）、`fit_to_budget`（按预算裁剪并保证消息对完整）。代码不调用模型，可以直接运行；接入 Agent 时，在每次 `chat.completions.create` 之前调用 `fit_to_budget(messages, budget)` 即可。

注意 `fit_to_budget` 返回一个新列表用于本次请求，完整历史仍然保留在原列表里，方便日志和后续摘要。

::: code-group
```python [Python]
def estimate_tokens(text: str) -> int:
    """粗略估算：汉字约 1 Token/字，其他字符约 4 字符/Token。精确计数请用对应模型的 tokenizer。"""
    cjk = sum(1 for ch in text if "一" <= ch <= "鿿")  # CJK 统一汉字基本区
    return cjk + (len(text) - cjk) // 4 + 1


def message_tokens(msg: dict) -> int:
    n = 4 + estimate_tokens(msg.get("content") or "")  # 4：角色和分隔符的固定开销
    for tc in msg.get("tool_calls") or []:
        n += estimate_tokens(tc["function"]["name"] + tc["function"]["arguments"])
    return n


def truncate_middle(text: str, max_chars: int = 2000) -> str:
    """保留开头和结尾，中间替换为省略标记。用于工具结果进入 messages 之前。"""
    if len(text) <= max_chars:
        return text
    half = max_chars // 2
    return f"{text[:half]}\n...[已省略 {len(text) - max_chars} 字符]...\n{text[-half:]}"


def split_units(messages: list[dict]) -> list[list[dict]]:
    """把 assistant(tool_calls) 和紧随其后的 tool 消息绑成一个不可拆分的单元。"""
    units: list[list[dict]] = []
    for msg in messages:
        if msg["role"] == "tool" and units:
            units[-1].append(msg)
        else:
            units.append([msg])
    return units


def fit_to_budget(messages: list[dict], budget: int, head: int = 2) -> list[dict]:
    """固定保留前 head 条（system + 原始任务），其余从新到旧装入，直到用完预算。"""
    fixed, rest = messages[:head], messages[head:]
    remaining = budget - sum(message_tokens(m) for m in fixed) - 50  # 50：为省略说明预留
    kept: list[list[dict]] = []
    units = split_units(rest)
    for unit in reversed(units):
        cost = sum(message_tokens(m) for m in unit)
        if cost > remaining:
            break  # 一旦装不下就停止，保证保留的是连续的最近历史
        kept.append(unit)
        remaining -= cost
    kept.reverse()
    dropped = len(units) - len(kept)
    note = [{"role": "user", "content": f"[系统提示] 为节省上下文，已省略较早的 {dropped} 段历史。"}] if dropped else []
    return fixed + note + [m for unit in kept for m in unit]


if __name__ == "__main__":
    log = "\n".join(f"2025-06-01 10:{i % 60:02d} INFO request ok id={i}" for i in range(500)) + "\nERROR db timeout"
    messages = [{"role": "system", "content": "你是运维助手。"},
                {"role": "user", "content": "排查订单服务今天的报错，原因找到后给出修复建议。"}]
    for step in range(30):  # 模拟 30 步工具调用
        call_id = f"call_{step}"
        messages.append({"role": "assistant", "content": None, "tool_calls": [{
            "id": call_id, "type": "function",
            "function": {"name": "read_log", "arguments": f'{{"service": "order", "page": {step}}}'}}]})
        messages.append({"role": "tool", "tool_call_id": call_id, "content": truncate_middle(log)})

    before = sum(message_tokens(m) for m in messages)
    fitted = fit_to_budget(messages, budget=8000)
    after = sum(message_tokens(m) for m in fitted)
    print(f"原始：{len(messages)} 条，约 {before} Token；裁剪后：{len(fitted)} 条，约 {after} Token")
    print(fitted[2]["content"])
    assert fitted[3]["role"] == "assistant"  # 保留部分从完整的 assistant(tool_calls) 开始
```

```go [Go]
package main

import (
	"fmt"
	"strings"
	"unicode/utf8"
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

// estimateTokens：汉字约 1 Token/字，其他字符约 4 字符/Token。精确计数请用对应模型的 tokenizer。
func estimateTokens(text string) int {
	cjk, total := 0, 0
	for _, r := range text {
		total++
		if r >= 0x4E00 && r <= 0x9FFF { // CJK 统一汉字基本区
			cjk++
		}
	}
	return cjk + (total-cjk)/4 + 1
}

func messageTokens(m Message) int {
	n := 4 + estimateTokens(m.Content) // 4：角色和分隔符的固定开销
	for _, tc := range m.ToolCalls {
		n += estimateTokens(tc.Function.Name + tc.Function.Arguments)
	}
	return n
}

// truncateMiddle：保留开头和结尾（按字符而非字节），中间替换为省略标记
func truncateMiddle(text string, maxChars int) string {
	n := utf8.RuneCountInString(text)
	if n <= maxChars {
		return text
	}
	r, half := []rune(text), maxChars/2
	return fmt.Sprintf("%s\n...[已省略 %d 字符]...\n%s", string(r[:half]), n-maxChars, string(r[n-half:]))
}

// splitUnits：把 assistant(tool_calls) 和紧随其后的 tool 消息绑成一个不可拆分的单元
func splitUnits(messages []Message) [][]Message {
	var units [][]Message
	for _, m := range messages {
		if m.Role == "tool" && len(units) > 0 {
			units[len(units)-1] = append(units[len(units)-1], m)
		} else {
			units = append(units, []Message{m})
		}
	}
	return units
}

// fitToBudget：固定保留前 head 条（system + 原始任务），其余从新到旧装入，直到用完预算
func fitToBudget(messages []Message, budget, head int) []Message {
	head = min(head, len(messages))
	fixed, rest := messages[:head], messages[head:]
	remaining := budget - 50 // 50：为省略说明预留
	for _, m := range fixed {
		remaining -= messageTokens(m)
	}
	units := splitUnits(rest)
	start := len(units)
	for start > 0 {
		cost := 0
		for _, m := range units[start-1] {
			cost += messageTokens(m)
		}
		if cost > remaining {
			break // 一旦装不下就停止，保证保留的是连续的最近历史
		}
		remaining -= cost
		start--
	}
	out := append([]Message{}, fixed...)
	if start > 0 {
		out = append(out, Message{Role: "user", Content: fmt.Sprintf("[系统提示] 为节省上下文，已省略较早的 %d 段历史。", start)})
	}
	for _, u := range units[start:] {
		out = append(out, u...)
	}
	return out
}

func total(ms []Message) int {
	n := 0
	for _, m := range ms {
		n += messageTokens(m)
	}
	return n
}

func main() {
	var b strings.Builder
	for i := 0; i < 500; i++ {
		fmt.Fprintf(&b, "2025-06-01 10:%02d INFO request ok id=%d\n", i%60, i)
	}
	log := b.String() + "ERROR db timeout"
	messages := []Message{
		{Role: "system", Content: "你是运维助手。"},
		{Role: "user", Content: "排查订单服务今天的报错，原因找到后给出修复建议。"},
	}
	for step := 0; step < 30; step++ { // 模拟 30 步工具调用
		tc := ToolCall{ID: fmt.Sprintf("call_%d", step), Type: "function"}
		tc.Function.Name = "read_log"
		tc.Function.Arguments = fmt.Sprintf(`{"service": "order", "page": %d}`, step)
		messages = append(messages,
			Message{Role: "assistant", ToolCalls: []ToolCall{tc}},
			Message{Role: "tool", ToolCallID: tc.ID, Content: truncateMiddle(log, 2000)})
	}
	fitted := fitToBudget(messages, 8000, 2)
	fmt.Printf("原始：%d 条，约 %d Token；裁剪后：%d 条，约 %d Token\n", len(messages), total(messages), len(fitted), total(fitted))
	fmt.Println(fitted[2].Content)
}
```

```java [Java]
import java.util.ArrayList;
import java.util.List;

public class WindowManager {
    record ToolCall(String id, String name, String arguments) {}

    record Message(String role, String content, List<ToolCall> toolCalls, String toolCallId) {
        static Message of(String role, String content) { return new Message(role, content, List.of(), null); }
    }

    /** 汉字约 1 Token/字，其他字符约 4 字符/Token。精确计数请用对应模型的 tokenizer。 */
    static int estimateTokens(String text) {
        if (text == null) return 1;
        int cjk = (int) text.codePoints().filter(c -> c >= 0x4E00 && c <= 0x9FFF).count(); // CJK 统一汉字基本区
        int total = text.codePointCount(0, text.length());
        return cjk + (total - cjk) / 4 + 1;
    }

    static int messageTokens(Message m) {
        int n = 4 + estimateTokens(m.content()); // 4：角色和分隔符的固定开销
        for (ToolCall tc : m.toolCalls()) n += estimateTokens(tc.name() + tc.arguments());
        return n;
    }

    static int total(List<Message> ms) { return ms.stream().mapToInt(WindowManager::messageTokens).sum(); }

    /** 保留开头和结尾，中间替换为省略标记（示例文本不含代理对，按 char 截取即可）。 */
    static String truncateMiddle(String text, int maxChars) {
        if (text.length() <= maxChars) return text;
        int half = maxChars / 2;
        return text.substring(0, half) + "\n...[已省略 " + (text.length() - maxChars) + " 字符]...\n"
                + text.substring(text.length() - half);
    }

    /** 把 assistant(tool_calls) 和紧随其后的 tool 消息绑成一个不可拆分的单元。 */
    static List<List<Message>> splitUnits(List<Message> messages) {
        List<List<Message>> units = new ArrayList<>();
        for (Message m : messages) {
            if (m.role().equals("tool") && !units.isEmpty()) units.get(units.size() - 1).add(m);
            else units.add(new ArrayList<>(List.of(m)));
        }
        return units;
    }

    /** 固定保留前 head 条（system + 原始任务），其余从新到旧装入，直到用完预算。 */
    static List<Message> fitToBudget(List<Message> messages, int budget, int head) {
        head = Math.min(head, messages.size());
        List<Message> fixed = messages.subList(0, head);
        int remaining = budget - total(fixed) - 50; // 50：为省略说明预留
        List<List<Message>> units = splitUnits(messages.subList(head, messages.size()));
        int start = units.size();
        while (start > 0) {
            int cost = total(units.get(start - 1));
            if (cost > remaining) break; // 一旦装不下就停止，保证保留的是连续的最近历史
            remaining -= cost;
            start--;
        }
        List<Message> out = new ArrayList<>(fixed);
        if (start > 0) out.add(Message.of("user", "[系统提示] 为节省上下文，已省略较早的 " + start + " 段历史。"));
        units.subList(start, units.size()).forEach(out::addAll);
        return out;
    }

    public static void main(String[] args) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 500; i++) sb.append(String.format("2025-06-01 10:%02d INFO request ok id=%d%n", i % 60, i));
        String log = sb + "ERROR db timeout";
        List<Message> messages = new ArrayList<>(List.of(
                Message.of("system", "你是运维助手。"),
                Message.of("user", "排查订单服务今天的报错，原因找到后给出修复建议。")));
        for (int step = 0; step < 30; step++) { // 模拟 30 步工具调用
            String id = "call_" + step;
            messages.add(new Message("assistant", null,
                    List.of(new ToolCall(id, "read_log", "{\"service\": \"order\", \"page\": " + step + "}")), null));
            messages.add(new Message("tool", truncateMiddle(log, 2000), List.of(), id));
        }
        List<Message> fitted = fitToBudget(messages, 8000, 2);
        System.out.printf("原始：%d 条，约 %d Token；裁剪后：%d 条，约 %d Token%n",
                messages.size(), total(messages), fitted.size(), total(fitted));
        System.out.println(fitted.get(2).content());
    }
}
```
:::

输出（三个版本一致）：

```text
原始：62 条，约 15928 Token；裁剪后：31 条，约 7484 Token
[系统提示] 为节省上下文，已省略较早的 16 段历史。
```

Java 版用 record 表示消息，发送请求时用 Jackson 转成 API 需要的 JSON 结构即可。

### 几个设计取舍

- 为什么"装不下就停"而不是"跳过这个，继续装更早的小单元"？跳着保留会让历史出现断层，模型看到第 3 步和第 10 步却不知道中间发生了什么，反而更容易困惑。保留连续的最近历史更安全。
- 为什么固定保留原始任务？长任务后期，最容易丢的就是用户最初的目标和约束。这里只固定了一条，真实系统还可能要固定"关键决策"或"已确认的约束"，更好的做法是把它们写进摘要或状态，见 [压缩与摘要](/guide/07-context-engineering/compression)。
- 省略说明为什么用 user 角色？部分厂商不允许 system 消息出现在对话中间。用 user 角色加"[系统提示]"前缀兼容性最好；如果你用的服务支持，也可以用 system 角色。
- 裁剪会破坏缓存。每次丢弃最早的单元，被保留部分的前缀就变了，[Prompt Caching](/guide/07-context-engineering/prompt-caching) 会失效。一种折中是"批量裁剪"：超出预算时一次性裁到预算的一半，而不是每轮都裁一点，这样相邻几次请求能共享前缀。

## 不同场景怎么选

| 场景 | 推荐做法 |
| --- | --- |
| 闲聊、简单问答 | 滑动窗口（最近 N 轮）即可 |
| 工具调用较多的 Agent | 工具结果入口截断 + 按 Token 预算裁剪 |
| 长任务（几十步以上） | 上面两项 + 历史摘要 + 外部状态文件 |
| 长期多会话的助手 | 会话内裁剪 + [长期记忆](/guide/08-memory/long-term) 按需召回 |
| 需要完整审计的场景 | 请求时裁剪，但完整历史落库保存 |

## 常见坑

- 按条数裁剪拆散了消息对。保留了 `tool` 消息却丢了发起它的 assistant 消息，或者反过来，API 直接返回 400。一定要按单元裁剪。
- 只裁历史，不截工具结果。一个工具结果就超出预算时，裁剪函数只能把它整个丢掉，模型拿不到任何信息。截断要在入口做。
- 截断不留标记。模型以为看到了完整的日志或列表，基于不完整的信息下结论。
- 丢掉了用户的原始需求。滑动窗口把第一条 user 消息滑出去了，Agent 在第 20 步忘了自己在做什么。
- 估算不留余量。估算偏低几百 Token 就可能超出窗口上限。预算按上限的 60%~80% 设，并用 `usage.prompt_tokens` 校准估算。
- 在原列表上就地裁剪。裁掉的历史就永远找不回来了，也无法用于事后摘要和调试。请求时裁剪副本，原始历史另存。

## 小测

1. 为什么不能简单地"只保留最后 20 条消息"？

::: details 查看答案
有两个问题。第一，按条数切可能正好切在 assistant(tool_calls) 和它的 tool 结果之间，留下孤立的 tool 消息或没有结果的 tool_calls，API 会报错。第二，条数和 Token 没有固定关系，20 条消息可能只有 1000 Token，也可能有 10 万 Token。另外，最早的用户需求也会被丢掉。
:::

2. 一次工具调用返回了 5 万字的日志，应该在哪个环节处理？怎么处理？

::: details 查看答案
在工具结果追加进 `messages` 之前处理。可以保留开头和结尾、只保留错误行及其上下文，或者把完整日志存到文件只返回路径和摘要，并且明确标注"已截断"。不要等到裁剪历史时再处理，那时只能把整条结果丢掉。
:::

3. `fit_to_budget` 在裁剪时遇到一个装不下的单元就停止，而不是跳过它继续装更早的单元。这样做的理由是什么？

::: details 查看答案
保证保留下来的历史是连续的。跳过中间某个单元会造成历史断层，模型看到前后的步骤却缺少中间的过程，容易误解当前状态。连续的最近历史加上一条"已省略较早内容"的说明，比零散的片段更可靠。
:::

## 延伸阅读

- [Token 与上下文窗口](/guide/02-llm-basics/tokens-context)
- [多轮对话与消息结构](/guide/03-llm-api/multi-turn)
- [短期记忆与会话管理](/guide/08-memory/short-term)
- [tiktoken（GitHub）](https://github.com/openai/tiktoken)

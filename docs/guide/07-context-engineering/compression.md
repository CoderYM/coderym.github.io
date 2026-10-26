---
title: 压缩与摘要
description: 裁剪会丢信息，压缩尽量不丢：工具结果压缩、滚动摘要、结构化状态三个层次，以及一份能保住关键约束的摘要提示词。
---

# 压缩与摘要

::: info 学习目标
- 理解裁剪和压缩的区别，以及各自适用的场景
- 掌握三个层次的压缩：工具结果、对话历史、任务状态
- 写出一份能保住目标、约束和关键结论的摘要提示词
- 实现一个"旧历史摘要 + 最近几步原文"的滚动压缩函数
:::

## 裁剪不够用的时候

[上下文窗口管理](/guide/07-context-engineering/window-management) 里的裁剪是"丢掉旧的"。对闲聊来说没问题，但对长任务 Agent 来说，旧历史里往往有后面还用得上的东西：

- 第 3 步查到的"酒店已满，只剩 B 酒店"，第 15 步订票时还要用。
- 第 5 步试过"方法 A 不行"，被裁掉后 Agent 在第 20 步又试了一次。
- 用户在第二轮补充的"不吃辣"，被滑出窗口后 Agent 推荐了川菜馆。

压缩（Compression）的目标是用更少的 Token 保留这些信息。代价是一次额外的模型调用，以及摘要不可避免的信息损失。

| 方式 | 做法 | 信息损失 | 额外成本 | 适合 |
| --- | --- | --- | --- | --- |
| 裁剪 | 直接丢弃旧消息 | 大，被丢的部分完全没了 | 无 | 短对话、旧信息不重要 |
| 截断 | 保留长文本的头尾 | 中，中间部分丢失 | 无 | 日志、命令输出 |
| 摘要 | 用模型把旧内容概括成短文 | 小到中，取决于摘要质量 | 一次模型调用 | 长任务、多轮对话 |
| 外部化 | 写到文件或记忆里，按需读回 | 小，原文还在 | 读写工具调用 | 很长的任务、跨会话 |

## 三个层次的压缩

### 1. 工具结果层：只留有用的部分

工具结果在进入上下文之前就可以压缩。比截断更进一步的做法：

- 结构化提取：网页抓取后只保留标题、正文和发布日期，去掉导航、广告、脚本。
- 按任务提取：用一次便宜模型的调用，"从下面的页面中提取与问题 X 相关的信息"，只把提取结果交给主 Agent。
- 引用替代原文：完整结果存起来，只给模型一个 ID 和摘要，模型需要细节时再调用 `read_result(id, range)`。

### 2. 对话历史层：滚动摘要

当历史超过阈值时，把较早的部分交给模型总结成一段摘要，替换掉原文；最近几步保留原文，因为它们和下一步关系最紧密。

```text
before:  [sys] [task] [u1 a1 t1] [u2 a2 t2] ... [u9 a9 t9] [u10 a10 t10] [u11 a11 t11]
                      └────────────── summarize ─────────┘ └──── keep verbatim ────┘

after:   [sys] [task] [summary of steps 1-9] [u10 a10 t10] [u11 a11 t11]
```

下一次再压缩时，上一次的摘要也在"旧历史"里，会和新的旧消息一起再总结一次，这就是"滚动"的含义。好处是实现简单；风险是多次摘要后细节会逐渐丢失，所以关键约束最好放在第 3 层。

### 3. 任务状态层：结构化笔记

对于真正的长任务，可以让 Agent 自己维护一份结构化的状态，比如一个 JSON 或 Markdown 笔记：目标、约束、已确认事实、待办、失败记录。每一步更新它，每次调用都把最新版本放进上下文。历史可以大胆压缩甚至丢弃，因为关键信息已经在状态里。

这就是 [什么是上下文工程](/guide/07-context-engineering/overview) 里"写入"策略的具体做法，也和 [长期记忆与用户画像](/guide/08-memory/long-term) 的思路相通。

## 摘要提示词怎么写

摘要质量决定压缩的成败。一句"请总结以上对话"通常不够，模型会写出一段通顺但丢了关键数字的概述。有效的摘要提示词要明确：

1. 摘要的用途：给后续步骤"交接工作"，不是给人看的会议纪要。
2. 必须保留什么：用户目标和硬性约束（数字、日期、禁止事项原样保留）、已确认的事实及来源、已完成和未完成的事项、失败过的尝试及原因。
3. 禁止什么：不要编造历史中没有的信息，不要加入自己的推测。
4. 格式和长度：条目式，限制字数，方便模型下一步快速定位。

## 动手实现

`compress_history` 把历史切成单元（assistant 的 `tool_calls` 和对应 `tool` 结果是一个单元，原因见上一篇），保留前两条（system 和原始任务）和最近 `keep_last` 个单元，中间部分渲染成文本交给模型总结，再用一条摘要消息替换。示例构造了一段出差规划的历史，运行后可以检查摘要是否保住了"预算""不吃辣"这些约束。

::: code-group
```python [Python]
import json
import os

from openai import OpenAI

client = OpenAI(api_key=os.environ["OPENAI_API_KEY"],
                base_url=os.getenv("OPENAI_BASE_URL") or None, timeout=60)
MODEL = os.getenv("LLM_MODEL", "gpt-4o-mini")

SUMMARY_PROMPT = """你在为一个正在执行任务的 AI Agent 压缩工作记录，摘要会替代原始记录，供它继续工作。
按以下条目输出，总长度不超过 300 字：
1. 用户目标与硬性约束（数字、日期、禁止事项必须原样保留）
2. 已确认的事实（注明来自哪个工具）
3. 已完成的事项
4. 失败的尝试及原因
5. 尚未完成的事项
只依据记录内容，不要编造或推测。"""


def split_units(messages: list[dict]) -> list[list[dict]]:
    units: list[list[dict]] = []
    for m in messages:
        if m["role"] == "tool" and units:
            units[-1].append(m)
        else:
            units.append([m])
    return units


def render(messages: list[dict], max_chars: int = 1000) -> str:
    """把消息渲染成纯文本给摘要模型看，单条过长时截断。"""
    lines = []
    for m in messages:
        text = m.get("content") or ""
        for tc in m.get("tool_calls") or []:
            text += f"[调用 {tc['function']['name']}({tc['function']['arguments']})]"
        lines.append(f"{m['role']}: {text[:max_chars]}")
    return "\n".join(lines)


def compress_history(messages: list[dict], keep_last: int = 2, head: int = 2) -> list[dict]:
    units = split_units(messages[head:])
    if len(units) <= keep_last:
        return messages  # 没什么可压缩的
    old = [m for u in units[:-keep_last] for m in u]
    recent = [m for u in units[-keep_last:] for m in u]
    resp = client.chat.completions.create(
        model=MODEL, temperature=0,
        messages=[{"role": "system", "content": SUMMARY_PROMPT},
                  {"role": "user", "content": render(messages[:head] + old)}])
    summary = resp.choices[0].message.content or ""
    note = {"role": "user", "content": f"[系统提示] 以下是较早工作记录的摘要：\n{summary}"}
    return messages[:head] + [note] + recent


def call(i: int, name: str, args: dict) -> dict:
    return {"role": "assistant", "content": None, "tool_calls": [{
        "id": f"call_{i}", "type": "function",
        "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)}}]}


def result(i: int, content: str) -> dict:
    return {"role": "tool", "tool_call_id": f"call_{i}", "content": content}


if __name__ == "__main__":
    history = [
        {"role": "system", "content": "你是差旅助手。"},
        {"role": "user", "content": "下周三去杭州出差两天，帮我订酒店并安排晚餐。住宿每晚不超过 500 元，我不吃辣。"},
        call(1, "search_hotels", {"city": "杭州", "max_price": 500}),
        result(1, "A 酒店 460 元/晚（西湖边）；B 酒店 420 元/晚（距西湖 2 公里）；C 酒店 380 元/晚（城东）"),
        {"role": "assistant", "content": "找到 3 家符合预算的酒店，正在预订离西湖最近的 A 酒店。"},
        call(2, "book_hotel", {"hotel": "A 酒店", "nights": 2}),
        result(2, "预订失败：A 酒店下周三已满房"),
        call(3, "book_hotel", {"hotel": "B 酒店", "nights": 2}),
        result(3, "预订成功：B 酒店，2 晚，订单号 H20250611"),
        call(4, "search_restaurants", {"near": "B 酒店", "exclude": "辣"}),
        result(4, "知味观（杭帮菜）；外婆家（杭帮菜）；绿茶餐厅（融合菜，部分辣）"),
        call(5, "get_weather", {"city": "杭州", "date": "下周三"}),
        result(5, "小雨，18~24°C"),
    ]
    compressed = compress_history(history, keep_last=2)
    print(f"压缩前 {len(history)} 条，压缩后 {len(compressed)} 条\n")
    print(compressed[2]["content"])
```

```go [Go]
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

const summaryPrompt = `你在为一个正在执行任务的 AI Agent 压缩工作记录，摘要会替代原始记录，供它继续工作。
按以下条目输出，总长度不超过 300 字：
1. 用户目标与硬性约束（数字、日期、禁止事项必须原样保留）
2. 已确认的事实（注明来自哪个工具）
3. 已完成的事项
4. 失败的尝试及原因
5. 尚未完成的事项
只依据记录内容，不要编造或推测。`

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

var httpClient = &http.Client{Timeout: 60 * time.Second}

func chat(messages []Message) (string, error) {
	base := os.Getenv("OPENAI_BASE_URL")
	if base == "" {
		base = "https://api.openai.com/v1"
	}
	model := os.Getenv("LLM_MODEL")
	if model == "" {
		model = "gpt-4o-mini"
	}
	body, _ := json.Marshal(map[string]any{"model": model, "temperature": 0, "messages": messages})
	req, err := http.NewRequest("POST", strings.TrimRight(base, "/")+"/chat/completions", bytes.NewReader(body))
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
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("HTTP %d: %s", resp.StatusCode, data)
	}
	var out struct {
		Choices []struct {
			Message Message `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(data, &out); err != nil || len(out.Choices) == 0 {
		return "", fmt.Errorf("无法解析响应: %s", data)
	}
	return out.Choices[0].Message.Content, nil
}

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

// render：把消息渲染成纯文本给摘要模型看，单条过长时截断
func render(messages []Message, maxChars int) string {
	var b strings.Builder
	for _, m := range messages {
		text := m.Content
		for _, tc := range m.ToolCalls {
			text += fmt.Sprintf("[调用 %s(%s)]", tc.Function.Name, tc.Function.Arguments)
		}
		if r := []rune(text); len(r) > maxChars {
			text = string(r[:maxChars])
		}
		fmt.Fprintf(&b, "%s: %s\n", m.Role, text)
	}
	return b.String()
}

func compressHistory(messages []Message, keepLast, head int) ([]Message, error) {
	units := splitUnits(messages[head:])
	if len(units) <= keepLast {
		return messages, nil // 没什么可压缩的
	}
	var old, recent []Message
	for i, u := range units {
		if i < len(units)-keepLast {
			old = append(old, u...)
		} else {
			recent = append(recent, u...)
		}
	}
	toSummarize := append(append([]Message{}, messages[:head]...), old...)
	summary, err := chat([]Message{
		{Role: "system", Content: summaryPrompt},
		{Role: "user", Content: render(toSummarize, 1000)},
	})
	if err != nil {
		return messages, err // 压缩失败时返回原历史，由调用方决定是否改用裁剪
	}
	out := append([]Message{}, messages[:head]...)
	out = append(out, Message{Role: "user", Content: "[系统提示] 以下是较早工作记录的摘要：\n" + summary})
	return append(out, recent...), nil
}

func call(i int, name, args string) Message {
	tc := ToolCall{ID: fmt.Sprintf("call_%d", i), Type: "function"}
	tc.Function.Name, tc.Function.Arguments = name, args
	return Message{Role: "assistant", ToolCalls: []ToolCall{tc}}
}

func result(i int, content string) Message {
	return Message{Role: "tool", ToolCallID: fmt.Sprintf("call_%d", i), Content: content}
}

func main() {
	history := []Message{
		{Role: "system", Content: "你是差旅助手。"},
		{Role: "user", Content: "下周三去杭州出差两天，帮我订酒店并安排晚餐。住宿每晚不超过 500 元，我不吃辣。"},
		call(1, "search_hotels", `{"city": "杭州", "max_price": 500}`),
		result(1, "A 酒店 460 元/晚（西湖边）；B 酒店 420 元/晚（距西湖 2 公里）；C 酒店 380 元/晚（城东）"),
		{Role: "assistant", Content: "找到 3 家符合预算的酒店，正在预订离西湖最近的 A 酒店。"},
		call(2, "book_hotel", `{"hotel": "A 酒店", "nights": 2}`),
		result(2, "预订失败：A 酒店下周三已满房"),
		call(3, "book_hotel", `{"hotel": "B 酒店", "nights": 2}`),
		result(3, "预订成功：B 酒店，2 晚，订单号 H20250611"),
		call(4, "search_restaurants", `{"near": "B 酒店", "exclude": "辣"}`),
		result(4, "知味观（杭帮菜）；外婆家（杭帮菜）；绿茶餐厅（融合菜，部分辣）"),
		call(5, "get_weather", `{"city": "杭州", "date": "下周三"}`),
		result(5, "小雨，18~24°C"),
	}
	compressed, err := compressHistory(history, 2, 2)
	if err != nil {
		fmt.Fprintln(os.Stderr, "压缩失败:", err)
		os.Exit(1)
	}
	fmt.Printf("压缩前 %d 条，压缩后 %d 条\n\n%s\n", len(history), len(compressed), compressed[2].Content)
}
```

```java [Java]
import com.fasterxml.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;

public class Compressor {
    static final ObjectMapper JSON = new ObjectMapper();
    static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    static final String SUMMARY_PROMPT = """
            你在为一个正在执行任务的 AI Agent 压缩工作记录，摘要会替代原始记录，供它继续工作。
            按以下条目输出，总长度不超过 300 字：
            1. 用户目标与硬性约束（数字、日期、禁止事项必须原样保留）
            2. 已确认的事实（注明来自哪个工具）
            3. 已完成的事项
            4. 失败的尝试及原因
            5. 尚未完成的事项
            只依据记录内容，不要编造或推测。""";

    record ToolCall(String id, String name, String arguments) {}

    record Message(String role, String content, List<ToolCall> toolCalls, String toolCallId) {
        static Message of(String role, String content) { return new Message(role, content, List.of(), null); }
    }

    static Message call(int i, String name, String args) {
        return new Message("assistant", null, List.of(new ToolCall("call_" + i, name, args)), null);
    }

    static Message result(int i, String content) { return new Message("tool", content, List.of(), "call_" + i); }

    static String summarize(String text) throws Exception {
        String base = Objects.requireNonNullElse(System.getenv("OPENAI_BASE_URL"), "https://api.openai.com/v1");
        String body = JSON.writeValueAsString(Map.of(
                "model", Objects.requireNonNullElse(System.getenv("LLM_MODEL"), "gpt-4o-mini"),
                "temperature", 0,
                "messages", List.of(Map.of("role", "system", "content", SUMMARY_PROMPT),
                        Map.of("role", "user", "content", text))));
        HttpRequest req = HttpRequest.newBuilder(URI.create(base.replaceAll("/+$", "") + "/chat/completions"))
                .timeout(Duration.ofSeconds(60))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + System.getenv("OPENAI_API_KEY"))
                .POST(HttpRequest.BodyPublishers.ofString(body)).build();
        HttpResponse<String> resp = HTTP.send(req, HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() != 200) throw new RuntimeException("HTTP " + resp.statusCode() + ": " + resp.body());
        return JSON.readTree(resp.body()).path("choices").path(0).path("message").path("content").asText("");
    }

    static List<List<Message>> splitUnits(List<Message> messages) {
        List<List<Message>> units = new ArrayList<>();
        for (Message m : messages) {
            if (m.role().equals("tool") && !units.isEmpty()) units.get(units.size() - 1).add(m);
            else units.add(new ArrayList<>(List.of(m)));
        }
        return units;
    }

    /** 把消息渲染成纯文本给摘要模型看，单条过长时截断。 */
    static String render(List<Message> messages, int maxChars) {
        StringBuilder sb = new StringBuilder();
        for (Message m : messages) {
            StringBuilder text = new StringBuilder(Objects.requireNonNullElse(m.content(), ""));
            for (ToolCall tc : m.toolCalls()) text.append("[调用 ").append(tc.name()).append("(").append(tc.arguments()).append(")]");
            String t = text.length() > maxChars ? text.substring(0, maxChars) : text.toString();
            sb.append(m.role()).append(": ").append(t).append("\n");
        }
        return sb.toString();
    }

    static List<Message> compressHistory(List<Message> messages, int keepLast, int head) throws Exception {
        List<List<Message>> units = splitUnits(messages.subList(head, messages.size()));
        if (units.size() <= keepLast) return messages; // 没什么可压缩的
        List<Message> toSummarize = new ArrayList<>(messages.subList(0, head));
        List<Message> recent = new ArrayList<>();
        for (int i = 0; i < units.size(); i++) (i < units.size() - keepLast ? toSummarize : recent).addAll(units.get(i));
        String summary = summarize(render(toSummarize, 1000));
        List<Message> out = new ArrayList<>(messages.subList(0, head));
        out.add(Message.of("user", "[系统提示] 以下是较早工作记录的摘要：\n" + summary));
        out.addAll(recent);
        return out;
    }

    public static void main(String[] args) throws Exception {
        List<Message> history = List.of(
                Message.of("system", "你是差旅助手。"),
                Message.of("user", "下周三去杭州出差两天，帮我订酒店并安排晚餐。住宿每晚不超过 500 元，我不吃辣。"),
                call(1, "search_hotels", "{\"city\": \"杭州\", \"max_price\": 500}"),
                result(1, "A 酒店 460 元/晚（西湖边）；B 酒店 420 元/晚（距西湖 2 公里）；C 酒店 380 元/晚（城东）"),
                Message.of("assistant", "找到 3 家符合预算的酒店，正在预订离西湖最近的 A 酒店。"),
                call(2, "book_hotel", "{\"hotel\": \"A 酒店\", \"nights\": 2}"),
                result(2, "预订失败：A 酒店下周三已满房"),
                call(3, "book_hotel", "{\"hotel\": \"B 酒店\", \"nights\": 2}"),
                result(3, "预订成功：B 酒店，2 晚，订单号 H20250611"),
                call(4, "search_restaurants", "{\"near\": \"B 酒店\", \"exclude\": \"辣\"}"),
                result(4, "知味观（杭帮菜）；外婆家（杭帮菜）；绿茶餐厅（融合菜，部分辣）"),
                call(5, "get_weather", "{\"city\": \"杭州\", \"date\": \"下周三\"}"),
                result(5, "小雨，18~24°C"));
        List<Message> compressed = compressHistory(history, 2, 2);
        System.out.printf("压缩前 %d 条，压缩后 %d 条%n%n%s%n", history.size(), compressed.size(), compressed.get(2).content());
    }
}
```
:::

摘要的样子大致如下（具体措辞取决于模型）：

```text
压缩前 13 条，压缩后 7 条

[系统提示] 以下是较早工作记录的摘要：
1. 目标：下周三去杭州出差两天，订酒店并安排晚餐。约束：住宿每晚不超过 500 元；用户不吃辣。
2. 已确认：search_hotels 返回 A 酒店 460 元、B 酒店 420 元、C 酒店 380 元。
3. 已完成：B 酒店 2 晚预订成功，订单号 H20250611。
4. 失败：A 酒店下周三满房，预订失败。
5. 未完成：晚餐安排。
```

压缩后保留的是最近两个单元（餐厅搜索和天气查询）的原文，Agent 可以接着安排晚餐，并且仍然知道"不吃辣"。

### 什么时候触发

- 按阈值：估算的历史 Token 超过预算的某个比例（比如 70%）时触发。最常用。
- 按阶段：一个子任务完成时（比如"酒店订好了"）压缩该阶段的过程，只留结论。摘要质量通常更好，因为阶段边界清晰。
- 不要每一步都压缩：每次都多一次调用，而且每次摘要都会改变前缀，[Prompt Caching](/guide/07-context-engineering/prompt-caching) 永远命中不了。

压缩调用本身也可能失败。Go 版的处理是返回原历史，交给调用方降级为 [上下文窗口管理](/guide/07-context-engineering/window-management) 中的按预算裁剪。压缩可以用比主 Agent 更便宜的模型，但太弱的模型容易漏掉约束，值得用评估集验证。

### 怎么判断摘要好不好

摘要的质量问题往往要到很多步之后才暴露出来，所以要专门评估：

1. 从真实轨迹中截取压缩点，保存压缩前的完整历史。
2. 为每个压缩点准备几个"后续步骤需要知道的问题"：预算是多少？哪家酒店订过失败了？订单号是什么？
3. 分别基于原文和摘要回答这些问题，对比正确率。

这本质上是一个小型的问答评估，方法见 [评估集与指标设计](/guide/14-evaluation/eval-design)。

## 常见坑

- 约束被"概括"掉。"每晚不超过 500 元，不吃辣"被总结成"用户对住宿和饮食有一些要求"。提示词要明确要求数字和禁止事项原样保留。
- 失败记录被省略。摘要只写成功的事，Agent 忘了"A 酒店已满"，又去订一次。提示词里单列"失败的尝试"。
- 摘要里出现幻觉。摘要模型补充了历史中没有的细节，后续步骤把它当成事实。要求"只依据记录"，并用较低的 temperature。
- 压缩时拆散了消息对。把 assistant(tool_calls) 放进摘要、对应的 tool 结果留在原文里，同样会导致 API 报错。按单元切分。
- 反复摘要导致信息漂移。滚动摘要经过多次压缩后，早期细节越来越模糊。关键信息应写入结构化状态，不依赖摘要传递。
- 压缩后丢弃原始记录。调试、审计、重新压缩都需要原文。压缩只影响发给模型的上下文，完整历史另行保存。

## 小测

1. 裁剪和摘要分别适合什么场景？

::: details 查看答案
裁剪适合旧信息基本不再需要的场景，比如闲聊、互相独立的问答，优点是零成本、不引入幻觉。摘要适合旧信息后续仍然有用的长任务，比如多步规划、长对话中的约束和已确认的事实，代价是一次额外的模型调用和一定的信息损失。
:::

2. 为什么压缩时要保留最近几步的原文，而不是把全部历史都摘要掉？

::: details 查看答案
最近几步和下一步决策关系最紧密，经常需要精确的细节，比如刚返回的工具结果中的具体字段。摘要会丢失细节，全部摘要掉会让 Agent 失去当前工作的精确上下文。保留近期原文、摘要远期历史是在精确性和长度之间的折中。
:::

3. 一个 Agent 压缩历史后，开始反复尝试一个之前已经失败过的方案。最可能的原因是什么？怎么修复？

::: details 查看答案
最可能是摘要没有保留失败记录，只写了已完成的事项。修复方法：在摘要提示词中明确要求列出"失败的尝试及原因"；对于长任务，把失败记录写入结构化的任务状态，不依赖摘要传递；并在评估集里加入"之前哪个方案失败了"这类检查问题。
:::

## 延伸阅读

- [什么是上下文工程](/guide/07-context-engineering/overview)
- [上下文窗口管理](/guide/07-context-engineering/window-management)
- [记忆读写策略与方案对比](/guide/08-memory/memory-strategy)
- [Anthropic：Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)

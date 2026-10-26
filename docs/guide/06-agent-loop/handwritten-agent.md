---
title: 不用框架手写 Agent
description: 用百来行代码、零框架实现一个完整的工具调用 Agent：工具、循环、步数上限和一次真实运行的完整轨迹。
---

# 不用框架手写 Agent

::: info 学习目标
- 理解一个 Agent 最小需要哪几个部件：模型、工具、消息历史、循环、终止条件
- 不依赖任何 Agent 框架，用 Python / Go / Java 各写一个能跑的 Agent
- 学会安全地实现工具（不用 `eval`）、把工具错误回传给模型
- 能读懂一次 Agent 运行的完整消息轨迹，为以后调试框架打基础
:::

市面上的 Agent 框架很多，但它们的核心都是同一个循环。先亲手写一遍，你会发现"Agent"并没有那么神秘：它就是一个 `while` 循环，里面反复调用模型、执行模型点名的工具、把结果塞回对话，直到模型说"我答完了"。

理解了这个循环，再去看 [框架全景与选型](/guide/11-frameworks/overview) 里的 LangGraph、Agents SDK，你就知道它们帮你做了什么、没做什么。

## 一个 Agent 由什么组成

```text
 user question
      │
      ▼
 messages = [system, user]
      │
      ▼
 ┌─► LLM(messages, tools) ──► has tool_calls? ── no ──► final answer
 │                                  │
 │                                 yes
 │                                  ▼
 │                       run_tool(name, args)  for each call
 │                                  │
 │                                  ▼
 └──── append assistant msg + tool results to messages
       (step += 1; stop if step > MAX_STEPS)
```

| 部件 | 作用 | 本文的实现 |
| --- | --- | --- |
| 模型 | 决定下一步：调工具，还是直接回答 | OpenAI 兼容的 Chat Completions API |
| 工具表 | 告诉模型"你能做什么"，并真正执行 | `calculator`、`get_time`、`search_notes` |
| 消息历史 | Agent 的工作记忆，每轮都完整发给模型 | 一个 `messages` 列表 |
| 循环 | 驱动"思考 → 行动 → 观察"反复进行 | `for step in range(MAX_STEPS)` |
| 终止条件 | 模型不再调用工具，或者步数用完 | `if not msg.tool_calls` / `MAX_STEPS` |

这其实就是 [ReAct](/guide/06-agent-loop/react) 模式的现代写法：推理隐含在模型内部，行动通过原生 Tool Calling 表达。工具调用的协议细节见 [工具调用原理](/guide/05-tool-calling/concept)。

## 准备工作

本文代码使用 OpenAI 兼容接口，换成 DeepSeek、通义千问、Kimi 等只需要改环境变量。模型需要支持 Tool Calling。

```bash
# .env 或直接 export，不要把 Key 写进代码
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1   # 可选，换成其他厂商的兼容地址
LLM_MODEL=gpt-4o-mini                        # 示例，换成你使用的模型
```

依赖：Python 需要 `pip install openai`；Go 只用标准库；Java 需要 Jackson（`com.fasterxml.jackson.core:jackson-databind`）。

## 三个模拟工具

为了让注意力集中在循环本身，工具都是本地实现、不依赖外部服务：

- `calculator(expression)`：四则运算。大模型的心算不可靠，涉及数字就该交给工具。
- `get_time()`：返回当前 UTC 时间。模型本身不知道"现在"是什么时候。
- `search_notes(query)`：在内存里的几条团队笔记中做关键词搜索，模拟知识库检索。

`calculator` 是最容易写出安全漏洞的地方。很多教程直接 `eval(expression)`，这等于让模型（以及能影响模型输入的任何人）在你的机器上执行任意代码。本文的做法：

- Python：用 `ast.parse(..., mode="eval")` 只做语法解析，然后自己遍历语法树，只放行数字和 `+ - * / %`，其他节点一律报错。`ast.parse` 本身不执行代码。
- Go / Java：手写一个几十行的递归下降解析器，只认数字、运算符和括号。

## 完整代码

三个版本结构完全一致：工具实现 → 工具 Schema → `run_tool` → `run_agent` 循环 → `main`。Go 和 Java 因为要自己写表达式解析器和 HTTP 调用，行数会多一些。

::: code-group
```python [Python]
import ast
import json
import operator
import os
from datetime import datetime, timezone

from openai import OpenAI

client = OpenAI(
    api_key=os.environ["OPENAI_API_KEY"],
    base_url=os.getenv("OPENAI_BASE_URL") or None,
    timeout=60,
)
MODEL = os.getenv("LLM_MODEL", "gpt-4o-mini")
MAX_STEPS = 8

# ---------- 工具实现 ----------
_OPS = {
    ast.Add: operator.add, ast.Sub: operator.sub,
    ast.Mult: operator.mul, ast.Div: operator.truediv,
    ast.Mod: operator.mod, ast.USub: operator.neg, ast.UAdd: operator.pos,
}


def _eval_node(node):
    if isinstance(node, ast.Constant) and type(node.value) in (int, float):
        return node.value
    if isinstance(node, ast.BinOp) and type(node.op) in _OPS:
        return _OPS[type(node.op)](_eval_node(node.left), _eval_node(node.right))
    if isinstance(node, ast.UnaryOp) and type(node.op) in _OPS:
        return _OPS[type(node.op)](_eval_node(node.operand))
    raise ValueError("只支持数字和 + - * / % ( )")


def calculator(expression: str) -> str:
    if len(expression) > 200:
        raise ValueError("表达式过长")
    tree = ast.parse(expression, mode="eval")  # 只解析，不执行
    return str(_eval_node(tree.body))


def get_time() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


NOTES = [
    "周会改到每周三下午 3 点，地点 A301。",
    "项目 Phoenix 的预算是 120000 元，已花费 45000 元。",
    "张三负责 Phoenix 的后端，李四负责前端。",
]


def search_notes(query: str) -> str:
    hits = [n for n in NOTES if query.lower() in n.lower()]
    return json.dumps(hits, ensure_ascii=False) if hits else "没有找到相关笔记"


TOOLS = {"calculator": calculator, "get_time": get_time, "search_notes": search_notes}


def fn_schema(name, desc, props=None, required=None):
    return {"type": "function", "function": {
        "name": name, "description": desc,
        "parameters": {"type": "object", "properties": props or {},
                       "required": required or []}}}


TOOL_SCHEMAS = [
    fn_schema("calculator", "计算四则运算表达式，例如 (120000-45000)/120000",
              {"expression": {"type": "string"}}, ["expression"]),
    fn_schema("get_time", "获取当前 UTC 时间（ISO 8601）"),
    fn_schema("search_notes", "按关键词搜索团队笔记，返回匹配的笔记列表",
              {"query": {"type": "string", "description": "关键词，越短越好"}}, ["query"]),
]


# ---------- 工具执行：永远返回字符串，错误也交给模型 ----------
def run_tool(name: str, raw_args: str) -> str:
    if name not in TOOLS:
        return f"错误：未知工具 {name}"
    try:
        args = json.loads(raw_args or "{}")
        if not isinstance(args, dict):
            return "错误：参数必须是 JSON 对象"
        return TOOLS[name](**args)
    except Exception as e:  # 参数错、计算错都回传给模型，让它自己修正
        return f"错误：{type(e).__name__}: {e}"


# ---------- Agent 循环 ----------
def run_agent(question: str) -> str:
    messages = [
        {"role": "system", "content": "你是团队助理。需要事实或计算时调用工具，不要编造。回答用中文，简洁。"},
        {"role": "user", "content": question},
    ]
    for step in range(1, MAX_STEPS + 1):
        resp = client.chat.completions.create(
            model=MODEL, messages=messages, tools=TOOL_SCHEMAS)
        msg = resp.choices[0].message
        if not msg.tool_calls:  # 没有工具调用 = 模型认为可以作答了
            return msg.content or ""
        messages.append({
            "role": "assistant", "content": msg.content,
            "tool_calls": [{"id": tc.id, "type": "function",
                            "function": {"name": tc.function.name,
                                         "arguments": tc.function.arguments}}
                           for tc in msg.tool_calls],
        })
        for tc in msg.tool_calls:
            result = run_tool(tc.function.name, tc.function.arguments)
            print(f"[step {step}] {tc.function.name}({tc.function.arguments}) -> {result}")
            messages.append({"role": "tool", "tool_call_id": tc.id, "content": result})
    return f"已达到最大步数 {MAX_STEPS}，任务未完成。"


if __name__ == "__main__":
    q = "Phoenix 项目的预算还剩多少？剩余比例是多少？顺便告诉我现在的 UTC 时间。"
    print(run_agent(q))
```

```go [Go]
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

const maxSteps = 8

// ---------- 消息结构（OpenAI 兼容） ----------
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

// ---------- 工具实现 ----------
var notes = []string{
	"周会改到每周三下午 3 点，地点 A301。",
	"项目 Phoenix 的预算是 120000 元，已花费 45000 元。",
	"张三负责 Phoenix 的后端，李四负责前端。",
}

func searchNotes(query string) string {
	var hits []string
	for _, n := range notes {
		if strings.Contains(strings.ToLower(n), strings.ToLower(query)) {
			hits = append(hits, n)
		}
	}
	if len(hits) == 0 {
		return "没有找到相关笔记"
	}
	b, _ := json.Marshal(hits)
	return string(b)
}

// calculator：递归下降解析器，只认数字、+ - * / % 和括号，绝不执行代码
type parser struct {
	s   string
	pos int
}

func (p *parser) peek() byte {
	for p.pos < len(p.s) && p.s[p.pos] == ' ' {
		p.pos++
	}
	if p.pos < len(p.s) {
		return p.s[p.pos]
	}
	return 0
}

func (p *parser) expr() (float64, error) { // expr := term (('+'|'-') term)*
	v, err := p.term()
	for err == nil {
		op := p.peek()
		if op != '+' && op != '-' {
			break
		}
		p.pos++
		var r float64
		if r, err = p.term(); err == nil {
			if op == '+' {
				v += r
			} else {
				v -= r
			}
		}
	}
	return v, err
}

func (p *parser) term() (float64, error) { // term := factor (('*'|'/'|'%') factor)*
	v, err := p.factor()
	for err == nil {
		op := p.peek()
		if op != '*' && op != '/' && op != '%' {
			break
		}
		p.pos++
		var r float64
		if r, err = p.factor(); err != nil {
			break
		}
		if op != '*' && r == 0 {
			return 0, errors.New("除数不能为 0")
		}
		switch op {
		case '*':
			v *= r
		case '/':
			v /= r
		default:
			v = math.Mod(v, r)
		}
	}
	return v, err
}

func (p *parser) factor() (float64, error) { // factor := ('-'|'+') factor | '(' expr ')' | number
	switch c := p.peek(); {
	case c == '-' || c == '+':
		p.pos++
		v, err := p.factor()
		if c == '-' {
			v = -v
		}
		return v, err
	case c == '(':
		p.pos++
		v, err := p.expr()
		if err == nil && p.peek() != ')' {
			return 0, errors.New("缺少右括号")
		}
		p.pos++
		return v, err
	}
	start := p.pos
	for p.pos < len(p.s) && (p.s[p.pos] == '.' || (p.s[p.pos] >= '0' && p.s[p.pos] <= '9')) {
		p.pos++
	}
	if start == p.pos {
		return 0, fmt.Errorf("位置 %d 处出现非法字符", p.pos)
	}
	return strconv.ParseFloat(p.s[start:p.pos], 64)
}

func calculator(expression string) (string, error) {
	if len(expression) > 200 {
		return "", errors.New("表达式过长")
	}
	p := &parser{s: expression}
	v, err := p.expr()
	if err == nil && p.peek() != 0 {
		err = fmt.Errorf("位置 %d 处有多余字符", p.pos)
	}
	if err != nil {
		return "", err
	}
	return strconv.FormatFloat(v, 'f', -1, 64), nil
}

// ---------- 工具执行：永远返回字符串，错误也交给模型 ----------
func runTool(name, rawArgs string) string {
	var args map[string]string
	if rawArgs == "" {
		rawArgs = "{}"
	}
	if err := json.Unmarshal([]byte(rawArgs), &args); err != nil {
		return "错误：参数不是合法 JSON 对象: " + err.Error()
	}
	switch name {
	case "calculator":
		out, err := calculator(args["expression"])
		if err != nil {
			return "错误：" + err.Error()
		}
		return out
	case "get_time":
		return time.Now().UTC().Format(time.RFC3339)
	case "search_notes":
		return searchNotes(args["query"])
	}
	return "错误：未知工具 " + name
}

func fnSchema(name, desc string, props map[string]any, required []string) map[string]any {
	if props == nil {
		props = map[string]any{}
	}
	if required == nil {
		required = []string{}
	}
	return map[string]any{"type": "function", "function": map[string]any{
		"name": name, "description": desc,
		"parameters": map[string]any{"type": "object", "properties": props, "required": required},
	}}
}

var toolSchemas = []map[string]any{
	fnSchema("calculator", "计算四则运算表达式，例如 (120000-45000)/120000",
		map[string]any{"expression": map[string]any{"type": "string"}}, []string{"expression"}),
	fnSchema("get_time", "获取当前 UTC 时间（ISO 8601）", nil, nil),
	fnSchema("search_notes", "按关键词搜索团队笔记，返回匹配的笔记列表",
		map[string]any{"query": map[string]any{"type": "string", "description": "关键词，越短越好"}}, []string{"query"}),
}

// ---------- 调用模型 ----------
var httpClient = &http.Client{Timeout: 60 * time.Second}

func chat(messages []Message) (Message, error) {
	baseURL := os.Getenv("OPENAI_BASE_URL")
	if baseURL == "" {
		baseURL = "https://api.openai.com/v1"
	}
	model := os.Getenv("LLM_MODEL")
	if model == "" {
		model = "gpt-4o-mini"
	}
	body, _ := json.Marshal(map[string]any{"model": model, "messages": messages, "tools": toolSchemas})
	req, err := http.NewRequest("POST", strings.TrimRight(baseURL, "/")+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return Message{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+os.Getenv("OPENAI_API_KEY"))
	resp, err := httpClient.Do(req)
	if err != nil {
		return Message{}, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return Message{}, fmt.Errorf("HTTP %d: %s", resp.StatusCode, data)
	}
	var out struct {
		Choices []struct {
			Message Message `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(data, &out); err != nil || len(out.Choices) == 0 {
		return Message{}, fmt.Errorf("无法解析响应: %s", data)
	}
	return out.Choices[0].Message, nil
}

// ---------- Agent 循环 ----------
func runAgent(question string) (string, error) {
	messages := []Message{
		{Role: "system", Content: "你是团队助理。需要事实或计算时调用工具，不要编造。回答用中文，简洁。"},
		{Role: "user", Content: question},
	}
	for step := 1; step <= maxSteps; step++ {
		msg, err := chat(messages)
		if err != nil {
			return "", err
		}
		if len(msg.ToolCalls) == 0 { // 没有工具调用 = 模型认为可以作答了
			return msg.Content, nil
		}
		messages = append(messages, msg) // 原样保留 assistant 的 tool_calls
		for _, tc := range msg.ToolCalls {
			result := runTool(tc.Function.Name, tc.Function.Arguments)
			fmt.Printf("[step %d] %s(%s) -> %s\n", step, tc.Function.Name, tc.Function.Arguments, result)
			messages = append(messages, Message{Role: "tool", ToolCallID: tc.ID, Content: result})
		}
	}
	return fmt.Sprintf("已达到最大步数 %d，任务未完成。", maxSteps), nil
}

func main() {
	if os.Getenv("OPENAI_API_KEY") == "" {
		fmt.Fprintln(os.Stderr, "请先设置 OPENAI_API_KEY")
		os.Exit(1)
	}
	answer, err := runAgent("Phoenix 项目的预算还剩多少？剩余比例是多少？顺便告诉我现在的 UTC 时间。")
	if err != nil {
		fmt.Fprintln(os.Stderr, "出错:", err)
		os.Exit(1)
	}
	fmt.Println(answer)
}
```

```java [Java]
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import java.util.Objects;

public class Agent {
    static final int MAX_STEPS = 8;
    static final ObjectMapper JSON = new ObjectMapper();
    static final HttpClient HTTP = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10)).build();

    // ---------- 工具实现 ----------
    static final List<String> NOTES = List.of(
            "周会改到每周三下午 3 点，地点 A301。",
            "项目 Phoenix 的预算是 120000 元，已花费 45000 元。",
            "张三负责 Phoenix 的后端，李四负责前端。");

    static String searchNotes(String query) throws Exception {
        String q = query.toLowerCase();
        List<String> hits = NOTES.stream().filter(n -> n.toLowerCase().contains(q)).toList();
        return hits.isEmpty() ? "没有找到相关笔记" : JSON.writeValueAsString(hits);
    }

    /** 递归下降解析器：只认数字、+ - * / % 和括号，绝不执行代码。 */
    static final class Calc {
        private final String s;
        private int pos;

        Calc(String s) { this.s = s; }

        static String evaluate(String expression) {
            if (expression == null || expression.length() > 200) {
                throw new IllegalArgumentException("表达式为空或过长");
            }
            Calc c = new Calc(expression);
            double v = c.expr();
            if (c.peek() != 0) throw new IllegalArgumentException("位置 " + c.pos + " 处有多余字符");
            return (v == Math.rint(v) && Math.abs(v) < 1e15) ? String.valueOf((long) v) : String.valueOf(v);
        }

        char peek() {
            while (pos < s.length() && s.charAt(pos) == ' ') pos++;
            return pos < s.length() ? s.charAt(pos) : 0;
        }

        double expr() { // expr := term (('+'|'-') term)*
            double v = term();
            for (char op = peek(); op == '+' || op == '-'; op = peek()) {
                pos++;
                v = op == '+' ? v + term() : v - term();
            }
            return v;
        }

        double term() { // term := factor (('*'|'/'|'%') factor)*
            double v = factor();
            for (char op = peek(); op == '*' || op == '/' || op == '%'; op = peek()) {
                pos++;
                double r = factor();
                if (op != '*' && r == 0) throw new ArithmeticException("除数不能为 0");
                v = switch (op) { case '*' -> v * r; case '/' -> v / r; default -> v % r; };
            }
            return v;
        }

        double factor() { // factor := ('-'|'+') factor | '(' expr ')' | number
            char c = peek();
            if (c == '-' || c == '+') { pos++; double v = factor(); return c == '-' ? -v : v; }
            if (c == '(') {
                pos++;
                double v = expr();
                if (peek() != ')') throw new IllegalArgumentException("缺少右括号");
                pos++;
                return v;
            }
            int start = pos;
            while (pos < s.length() && (Character.isDigit(s.charAt(pos)) || s.charAt(pos) == '.')) pos++;
            if (start == pos) throw new IllegalArgumentException("位置 " + pos + " 处出现非法字符");
            return Double.parseDouble(s.substring(start, pos));
        }
    }

    // ---------- 工具执行：永远返回字符串，错误也交给模型 ----------
    static String runTool(String name, String rawArgs) {
        try {
            JsonNode args = JSON.readTree(rawArgs == null || rawArgs.isBlank() ? "{}" : rawArgs);
            return switch (name) {
                case "calculator" -> Calc.evaluate(args.path("expression").asText(null));
                case "get_time" -> Instant.now().truncatedTo(ChronoUnit.SECONDS).toString();
                case "search_notes" -> searchNotes(args.path("query").asText(""));
                default -> "错误：未知工具 " + name;
            };
        } catch (Exception e) {
            return "错误：" + e.getClass().getSimpleName() + ": " + e.getMessage();
        }
    }

    static Map<String, Object> fnSchema(String name, String desc, Map<String, Object> props, List<String> required) {
        return Map.of("type", "function", "function", Map.of(
                "name", name, "description", desc,
                "parameters", Map.of("type", "object", "properties", props, "required", required)));
    }

    static final List<Map<String, Object>> TOOL_SCHEMAS = List.of(
            fnSchema("calculator", "计算四则运算表达式，例如 (120000-45000)/120000",
                    Map.of("expression", Map.of("type", "string")), List.of("expression")),
            fnSchema("get_time", "获取当前 UTC 时间（ISO 8601）", Map.of(), List.of()),
            fnSchema("search_notes", "按关键词搜索团队笔记，返回匹配的笔记列表",
                    Map.of("query", Map.of("type", "string", "description", "关键词，越短越好")), List.of("query")));

    // ---------- 调用模型：返回 assistant message 的原始 JSON ----------
    static JsonNode chat(ArrayNode messages) throws Exception {
        String baseUrl = Objects.requireNonNullElse(System.getenv("OPENAI_BASE_URL"), "https://api.openai.com/v1");
        String model = Objects.requireNonNullElse(System.getenv("LLM_MODEL"), "gpt-4o-mini");
        ObjectNode body = JSON.createObjectNode();
        body.put("model", model);
        body.set("messages", messages);
        body.set("tools", JSON.valueToTree(TOOL_SCHEMAS));
        HttpRequest req = HttpRequest.newBuilder(URI.create(baseUrl.replaceAll("/+$", "") + "/chat/completions"))
                .timeout(Duration.ofSeconds(60))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + System.getenv("OPENAI_API_KEY"))
                .POST(HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(body)))
                .build();
        HttpResponse<String> resp = HTTP.send(req, HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() != 200) throw new RuntimeException("HTTP " + resp.statusCode() + ": " + resp.body());
        return JSON.readTree(resp.body()).path("choices").path(0).path("message");
    }

    // ---------- Agent 循环 ----------
    static String runAgent(String question) throws Exception {
        ArrayNode messages = JSON.createArrayNode();
        messages.addObject().put("role", "system").put("content", "你是团队助理。需要事实或计算时调用工具，不要编造。回答用中文，简洁。");
        messages.addObject().put("role", "user").put("content", question);

        for (int step = 1; step <= MAX_STEPS; step++) {
            JsonNode msg = chat(messages);
            JsonNode toolCalls = msg.path("tool_calls");
            if (!toolCalls.isArray() || toolCalls.isEmpty()) { // 没有工具调用 = 模型认为可以作答了
                return msg.path("content").asText("");
            }
            messages.add(msg); // 原样保留 assistant 的 tool_calls
            for (JsonNode tc : toolCalls) {
                String name = tc.path("function").path("name").asText();
                String args = tc.path("function").path("arguments").asText();
                String result = runTool(name, args);
                System.out.printf("[step %d] %s(%s) -> %s%n", step, name, args, result);
                messages.addObject().put("role", "tool")
                        .put("tool_call_id", tc.path("id").asText())
                        .put("content", result);
            }
        }
        return "已达到最大步数 " + MAX_STEPS + "，任务未完成。";
    }

    public static void main(String[] args) throws Exception {
        if (System.getenv("OPENAI_API_KEY") == null) {
            System.err.println("请先设置 OPENAI_API_KEY");
            System.exit(1);
        }
        System.out.println(runAgent("Phoenix 项目的预算还剩多少？剩余比例是多少？顺便告诉我现在的 UTC 时间。"));
    }
}
```
:::

运行方式：Python `python agent.py`；Go `go run main.go`；Java 把 Jackson 加入依赖后用 Maven/Gradle 运行，或者把 `jackson-databind` 及其依赖 `jackson-core`、`jackson-annotations` 放进 classpath 后执行 `java -cp "libs/*" Agent.java`（Java 11+ 支持直接运行单文件源码）。

## 逐段拆解

循环只有十几行，但每一行都有讲究。

1. 每一轮都把完整的 `messages` 发给模型。模型是无状态的，它对"之前发生了什么"的全部认知都来自这份列表。这也意味着步数越多，每次请求越长，这是后面 [上下文窗口管理](/guide/07-context-engineering/window-management) 要解决的问题。
2. 判断结束的依据是"这一轮有没有 `tool_calls`"，而不是 `finish_reason` 或者回答里有没有某个关键词。不同厂商对 `finish_reason` 的处理有细微差异，直接看 `tool_calls` 最稳。
3. assistant 消息要原样追加，包括 `tool_calls` 里的 `id`。下一条 `tool` 消息通过 `tool_call_id` 和它对应，少了或者对不上，API 会直接报 400。
4. 一轮可能有多个 `tool_calls`（并行调用），每个都要回一条 `tool` 消息，见 [并行工具调用](/guide/05-tool-calling/parallel-tools)。
5. `run_tool` 永远返回字符串，不向外抛异常。参数 JSON 写错、除数为 0、工具名拼错，都变成一条"错误：..."的观察结果交还给模型，模型通常能在下一轮自己修正。这是 Agent 比普通程序更"抗造"的关键，更多策略见 [工具错误处理与重试](/guide/05-tool-calling/error-handling)。
6. `MAX_STEPS` 是最后一道保险。没有它，一个反复调用同一工具的模型会一直烧 Token。更完整的预算控制见 [终止条件、步数与预算控制](/guide/06-agent-loop/stop-budget)。

## 一次运行的完整轨迹

问题："Phoenix 项目的预算还剩多少？剩余比例是多少？顺便告诉我现在的 UTC 时间。"

终端输出（不同模型的调用顺序和措辞会有差异）：

```text
[step 1] search_notes({"query": "Phoenix"}) -> ["项目 Phoenix 的预算是 120000 元，已花费 45000 元。", "张三负责 Phoenix 的后端，李四负责前端。"]
[step 1] get_time({}) -> 2025-06-01T08:30:12+00:00
[step 2] calculator({"expression": "120000-45000"}) -> 75000
[step 2] calculator({"expression": "75000/120000"}) -> 0.625
Phoenix 项目预算 120000 元，已花费 45000 元，还剩 75000 元，剩余比例 62.5%。当前 UTC 时间是 2025-06-01 08:30:12。
```

对应的 `messages` 演变如下（省略了 system 和工具结果的具体内容）：

```text
#0 system     你是团队助理……
#1 user       Phoenix 项目的预算还剩多少？……
#2 assistant  tool_calls=[search_notes(Phoenix), get_time()]      ← 第 1 轮：并行调用两个工具
#3 tool       (call_1) ["项目 Phoenix 的预算是 120000 元……"]
#4 tool       (call_2) 2025-06-01T08:30:12+00:00
#5 assistant  tool_calls=[calculator(120000-45000), calculator(75000/120000)]  ← 第 2 轮
#6 tool       (call_3) 75000
#7 tool       (call_4) 0.625
#8 assistant  content="Phoenix 项目预算 120000 元……"              ← 第 3 轮：没有 tool_calls，结束
```

可以看到模型做了三件事：先检索事实，再用计算器算数，最后组织语言。我们一行"规划"代码都没写，这些决策全部由模型根据工具描述和对话历史做出。这就是 Agent 和写死流程的 Workflow 最大的区别，参见 [Agent、Chatbot 与 Workflow 的区别](/guide/00-intro/agent-vs-workflow)。

## 动手扩展

- 加一个 `add_note(text)` 工具，让 Agent 能写入笔记。思考：写操作要不要先征求用户确认？（参见 [权限控制与人在环路](/guide/15-production/permissions-hitl)）
- 把 `print` 换成结构化日志，记录每一步的耗时和 Token 用量（响应里的 `usage` 字段），这就是最朴素的 [轨迹追踪](/guide/14-evaluation/observability)。
- 把 `MAX_STEPS` 改成 1，观察 Agent 如何"半途而废"，再思考怎样给用户一个体面的降级回答。

## 常见坑

| 坑 | 现象 | 解决 |
| --- | --- | --- |
| 用 `eval` 实现计算器 | 模型或攻击者可以执行任意代码 | 用 AST 白名单或手写解析器 |
| 没把 assistant 的 `tool_calls` 追加回历史 | 下一轮报 400：tool 消息找不到对应的调用 | assistant 消息原样追加，再追加 tool 结果 |
| 只处理第一个 `tool_calls` | 并行调用时漏回结果，同样报 400 | 遍历全部 `tool_calls`，每个都回一条 |
| 工具异常直接抛出 | 一个参数错误就让整个 Agent 崩溃 | 捕获异常，把错误信息作为观察结果返回 |
| 没有步数上限 | 模型陷入重复调用，Token 无限消耗 | 设置 `MAX_STEPS`，生产环境再加 Token 和时间预算 |
| 工具描述含糊 | 模型不知道什么时候该用，或者参数乱传 | 描述里写清用途、参数格式和示例，见 [工具设计原则](/guide/05-tool-calling/tool-design) |
| HTTP 调用没有超时 | 网络抖动时整个 Agent 卡死 | 客户端统一设置超时，配合重试 |

## 小测

1. 在本文的循环里，Agent 靠什么判断"任务完成了"？这种判断方式有什么风险？

::: details 查看答案
靠"本轮模型回复里没有 `tool_calls`"。风险是完全信任模型的自我判断：它可能过早结束（没查资料就编答案），也可能永远不结束（反复调用工具）。前者靠系统提示词、评估和 [Reflection](/guide/06-agent-loop/reflection) 缓解，后者靠 `MAX_STEPS` 等硬性预算兜底。
:::

2. 为什么 `run_tool` 要把异常转换成字符串返回，而不是直接抛出？

::: details 查看答案
工具错误往往是模型可以自己修正的，比如参数格式不对、关键词太长没搜到。把错误作为观察结果交还给模型，它下一轮就能换个参数重试；直接抛出会中断整个循环，用户只能看到一个报错。当然，鉴权失败、配额耗尽这类模型无法修复的错误，应该在外层单独处理。
:::

3. 模型返回 `calculator({"expression": "__import__('os').system('rm -rf /')"})`，三个版本的代码会怎样？

::: details 查看答案
都会返回一条错误信息，不会执行任何代码。Python 版 `ast.parse` 只构造语法树，遇到 `Call`、`Attribute` 等节点时 `_eval_node` 直接抛 `ValueError`；Go 和 Java 版的解析器在第一个字母处就报"非法字符"。
:::

## 延伸阅读

- [ReAct：推理与行动](/guide/06-agent-loop/react)：本文循环背后的思想来源
- [终止条件、步数与预算控制](/guide/06-agent-loop/stop-budget)：让循环在生产环境里可控
- [项目 03：手写 ReAct Agent](/projects/03-react-agent)：在本文基础上做一个更完整的项目
- [OpenAI Function Calling 指南](https://platform.openai.com/docs/guides/function-calling)（API 以官方文档为准）
- [Anthropic：Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)


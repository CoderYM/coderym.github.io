---
title: 02 天气日程工具 Agent
description: 给聊天助手加上天气查询和日历工具，亲手实现 Tool Calling 循环，迈出从 Chatbot 到 Agent 的第一步。
---

# 02 天气日程工具 Agent

::: info 项目信息
- 难度：★★☆☆☆
- 预计时间：1～1.5 小时
- 前置知识：[01 命令行聊天助手](/projects/01-cli-chat)、[工具调用原理](/guide/05-tool-calling/concept)、[实现第一个工具](/guide/05-tool-calling/first-tool)、[工具设计原则](/guide/05-tool-calling/tool-design)
- 你将学会：用 JSON Schema 描述工具；处理模型返回的 `tool_calls`；把工具结果以 `role: tool` 回传；实现多步工具调用循环与步数上限；把工具错误交还给模型而不是让程序崩溃
:::

上一个项目的助手只能"说"。这个项目让它能"做"：查天气、往日历里加日程、列出某天的安排。为了让你专注于 Tool Calling 本身，天气用确定性的模拟数据，日历存在内存里，不依赖任何第三方 API。

## 需求说明

实现一个终端里的日程助理，支持三个工具：

| 工具 | 参数 | 作用 |
|------|------|------|
| `get_weather` | `city`, `date` | 返回模拟天气（同一城市同一天结果固定，方便测试） |
| `add_event` | `date`, `time`, `title` | 往内存日历添加一条日程 |
| `list_events` | `date` | 列出某天的全部日程，按时间排序 |

功能要求：

1. 用户用自然语言提问，例如"明天上海天气怎么样？如果不下雨，帮我下午 3 点加个跑步"。模型自己决定调用哪些工具、调用几次。
2. 每次工具调用都在终端打印一行轨迹，便于观察 Agent 的行为。
3. 支持相对日期："明天""下周五"要换算成具体日期。做法是在系统提示词里注入今天的日期。
4. 工具参数非法（日期格式错、缺参数）时，把错误信息返回给模型，让它自己修正或向用户确认。
5. 单轮对话最多调用模型 5 次，防止死循环。
6. 保留 `/reset`、`/exit` 命令；请求失败时回滚本轮产生的所有消息。

## 架构设计

```text
            用户输入
               │
               ▼
┌──────────────────────────────┐
│ messages += user             │
└──────────────┬───────────────┘
               ▼
┌──────────────────────────────┐   tools = [get_weather, add_event, list_events]
│ POST /chat/completions       │◀──────────────────────────────────────────────
└──────────────┬───────────────┘
               ▼
        有 tool_calls 吗？ ──否──▶ 输出 content，本轮结束
               │是
               ▼
┌──────────────────────────────┐
│ messages += assistant        │  (原样保留 tool_calls)
│ 逐个执行工具                   │──▶ get_weather / add_event / list_events
│ messages += tool × N         │  (tool_call_id 一一对应)
└──────────────┬───────────────┘
               │ step < MAX_STEPS
               └──────────▶ 回到 POST，让模型看到工具结果后继续

```

关键点：**模型从不直接执行工具**。它只是返回"我想调用某个函数、参数是什么"，真正执行的是你的代码。执行结果再作为一条消息发回去，模型据此决定下一步是继续调用工具，还是直接回答。

## 分步实现

### Step 1：初始化项目

`.env` 沿用项目 01 的配置。注意：要选一个**支持 Tool Calling** 的模型，主流厂商的通用对话模型一般都支持，以厂商文档为准。

::: code-group
```bash [Python]
mkdir tool-agent && cd tool-agent
python3 -m venv .venv && source .venv/bin/activate
pip install openai python-dotenv
# 代码保存为 agent.py
```
```bash [Go]
mkdir tool-agent && cd tool-agent
go mod init tool-agent
# 代码保存为 main.go，只用标准库
```
```bash [Java]
mkdir -p tool-agent/src/main/java && cd tool-agent
# 代码保存为 src/main/java/ToolAgent.java
# pom.xml 与项目 01 相同，只需把 exec 插件的 mainClass 改成 ToolAgent
```
:::

Java 版依赖仍然只有 Jackson：

```xml
<dependency>
  <groupId>com.fasterxml.jackson.core</groupId>
  <artifactId>jackson-databind</artifactId>
  <version>2.17.2</version>
</dependency>
```

### Step 2：用 JSON Schema 描述工具

模型通过 `tools` 参数"看到"你的工具。每个工具三要素：`name`、`description`、`parameters`（JSON Schema）。其中 **description 是写给模型看的说明书**，直接决定模型什么时候调用它：

```json
{
  "type": "function",
  "function": {
    "name": "get_weather",
    "description": "查询某城市某一天的天气预报。用户问天气、或安排户外活动前需要了解天气时使用。",
    "parameters": {
      "type": "object",
      "properties": {
        "city": {"type": "string", "description": "城市名，如 北京"},
        "date": {"type": "string", "description": "日期，格式 YYYY-MM-DD"}
      },
      "required": ["city", "date"]
    }
  }
}
```

写 description 的经验（更多见 [工具设计原则](/guide/05-tool-calling/tool-design)）：

- 说清"什么时候用"，而不只是"做什么"。
- 参数格式写进 description（如 `YYYY-MM-DD`），模型会照着填。
- 工具数量少而精，职责不重叠，模型才不会选错。

### Step 3：实现工具，并做好校验

**模型给的参数不可信**：可能格式错、缺字段、多字段，甚至是一段不合法的 JSON。所以工具函数要自己校验，并且把错误包装成 `{"error": "..."}` 返回给模型，而不是抛异常让程序崩溃。模型看到错误信息后，通常会修正参数重试，或者向用户追问。

模拟天气用"城市名 + 日期的字符编码之和"做种子，三个语言版本对同样的输入返回同样的结果，方便写测试。

### Step 4：理解消息协议

一次带工具调用的完整往返，消息列表会变成这样：

```json
[
  {"role": "system", "content": "你是一个日程助理……今天是 2025-06-01（星期日）……"},
  {"role": "user", "content": "明天北京天气怎么样？"},
  {"role": "assistant", "content": null, "tool_calls": [
    {"id": "call_abc123", "type": "function",
     "function": {"name": "get_weather", "arguments": "{\"city\":\"北京\",\"date\":\"2025-06-02\"}"}}
  ]},
  {"role": "tool", "tool_call_id": "call_abc123",
   "content": "{\"city\":\"北京\",\"date\":\"2025-06-02\",\"condition\":\"晴\",\"temp_low\":12,\"temp_high\":25,\"source\":\"mock\"}"},
  {"role": "assistant", "content": "明天（6 月 2 日）北京晴，12～25°C，适合出门。"}
]
```

三条硬规则，违反任何一条 API 都会报错：

1. 带 `tool_calls` 的 assistant 消息必须**原样**放回历史。
2. 每个 `tool_call` 都要有一条对应的 `role: tool` 消息，`tool_call_id` 一致。
3. `arguments` 是 **JSON 字符串**，不是对象，需要自己 `json.loads` / `json.Unmarshal` / `readTree`。

模型可能在一次响应里返回多个 `tool_calls`（例如同时查两个城市的天气），代码里用循环逐个执行即可。并行执行的做法见 [并行工具调用](/guide/05-tool-calling/parallel-tools)。

### Step 5：Agent 循环与步数上限

`run_turn` 是整个项目的核心：调用模型 → 有工具调用就执行并追加结果 → 再调用模型，直到模型给出纯文本回答，或者达到 `MAX_STEPS`。步数上限是 Agent 的安全带，防止模型反复调用工具停不下来，原理见 [终止条件、步数与预算控制](/guide/06-agent-loop/stop-budget)。

### Step 6：完整代码

::: code-group
```python [Python]
"""02 天气日程工具 Agent：模拟天气 + 内存日历，演示 Tool Calling 循环。"""
import json
import os
import sys
from datetime import date as Date, datetime

from dotenv import load_dotenv
from openai import OpenAI, OpenAIError

load_dotenv()

MAX_STEPS = 5  # 单轮对话中最多调用模型的次数，防止无限循环

# ---------- 工具实现 ----------
CONDITIONS = ["晴", "多云", "阴", "小雨", "雷阵雨"]
EVENTS: list[dict] = []  # 内存日历，进程退出即丢失


def check_date(s: str) -> str:
    datetime.strptime(s, "%Y-%m-%d")  # 格式不对会抛 ValueError
    return s


def get_weather(city: str, date: str) -> dict:
    """模拟天气：同一城市同一天总是返回相同结果，便于测试。"""
    city = city.strip()
    if not city or len(city) > 20:
        raise ValueError("city 不能为空且不超过 20 个字符")
    check_date(date)
    seed = sum(ord(c) for c in city + date)
    return {
        "city": city,
        "date": date,
        "condition": CONDITIONS[seed % len(CONDITIONS)],
        "temp_low": 10 + seed % 10,
        "temp_high": 18 + seed % 12,
        "source": "mock",
    }


def add_event(date: str, time: str, title: str) -> dict:
    check_date(date)
    time = datetime.strptime(time, "%H:%M").strftime("%H:%M")  # 统一成 09:30 格式
    title = title.strip()
    if not title or len(title) > 100:
        raise ValueError("title 不能为空且不超过 100 个字符")
    event = {"id": len(EVENTS) + 1, "date": date, "time": time, "title": title}
    EVENTS.append(event)
    return {"ok": True, "event": event}


def list_events(date: str) -> dict:
    check_date(date)
    items = sorted((e for e in EVENTS if e["date"] == date), key=lambda e: e["time"])
    return {"date": date, "events": items}


TOOL_FUNCS = {"get_weather": get_weather, "add_event": add_event, "list_events": list_events}

DATE_PARAM = {"type": "string", "description": "日期，格式 YYYY-MM-DD"}
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "查询某城市某一天的天气预报。用户问天气、或安排户外活动前需要了解天气时使用。",
            "parameters": {
                "type": "object",
                "properties": {
                    "city": {"type": "string", "description": "城市名，如 北京"},
                    "date": DATE_PARAM,
                },
                "required": ["city", "date"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "add_event",
            "description": "在用户日历中新增一个日程。",
            "parameters": {
                "type": "object",
                "properties": {
                    "date": DATE_PARAM,
                    "time": {"type": "string", "description": "开始时间，24 小时制 HH:MM"},
                    "title": {"type": "string", "description": "日程标题"},
                },
                "required": ["date", "time", "title"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_events",
            "description": "列出用户某一天的全部日程。",
            "parameters": {
                "type": "object",
                "properties": {"date": DATE_PARAM},
                "required": ["date"],
            },
        },
    },
]


def run_tool(name: str, arguments: str) -> str:
    """执行工具，任何错误都转成 JSON 返回给模型，而不是让程序崩溃。"""
    func = TOOL_FUNCS.get(name)
    if func is None:
        return json.dumps({"error": f"未知工具 {name}"}, ensure_ascii=False)
    try:
        args = json.loads(arguments or "{}")
        if not isinstance(args, dict):
            raise ValueError("参数必须是 JSON 对象")
        result = func(**args)
    except (ValueError, TypeError, AttributeError) as e:  # JSON 错误、参数缺失/多余/类型不对
        result = {"error": f"{type(e).__name__}: {e}"}
    return json.dumps(result, ensure_ascii=False)


# ---------- Agent 循环 ----------
def system_prompt() -> str:
    today = Date.today()
    return (
        "你是一个日程助理，可以查询天气、管理用户日历。"
        f"今天是 {today.isoformat()}（星期{'一二三四五六日'[today.weekday()]}）。"
        "用户说“明天”“周五”等相对日期时，先换算成 YYYY-MM-DD 再调用工具。"
        "信息不足（例如没说时间）时先向用户确认，不要猜。回答用简洁的中文。"
    )


def run_turn(client: OpenAI, model: str, messages: list[dict]) -> str:
    for _ in range(MAX_STEPS):
        resp = client.chat.completions.create(model=model, messages=messages, tools=TOOLS)
        msg = resp.choices[0].message
        if not msg.tool_calls:
            messages.append({"role": "assistant", "content": msg.content or ""})
            return msg.content or ""

        # 1. 把模型的"调用请求"原样放回历史
        messages.append({
            "role": "assistant",
            "content": msg.content,
            "tool_calls": [
                {
                    "id": tc.id,
                    "type": "function",
                    "function": {"name": tc.function.name, "arguments": tc.function.arguments},
                }
                for tc in msg.tool_calls
            ],
        })
        # 2. 逐个执行工具，把结果以 role=tool 追加，tool_call_id 必须对应
        for tc in msg.tool_calls:
            result = run_tool(tc.function.name, tc.function.arguments)
            print(f"  [工具] {tc.function.name}({tc.function.arguments}) -> {result}")
            messages.append({"role": "tool", "tool_call_id": tc.id, "content": result})
    return "（已达到最大步数，停止本轮）"


def main() -> None:
    if not os.getenv("OPENAI_API_KEY"):
        sys.exit("请先设置环境变量 OPENAI_API_KEY（可写在 .env 中）")
    model = os.getenv("LLM_MODEL", "gpt-4o-mini")
    client = OpenAI(base_url=os.getenv("OPENAI_BASE_URL") or None, timeout=60)

    messages = [{"role": "system", "content": system_prompt()}]
    print(f"日程助理已启动（模型 {model}）。输入 /reset 清空历史，/exit 退出。")
    while True:
        try:
            user_input = input("\n你> ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n再见")
            break
        if not user_input:
            continue
        if user_input == "/exit":
            break
        if user_input == "/reset":
            messages = [{"role": "system", "content": system_prompt()}]
            print("（历史已清空，日历保留）")
            continue

        checkpoint = len(messages)
        messages.append({"role": "user", "content": user_input})
        try:
            print("助手>", run_turn(client, model, messages))
        except OpenAIError as e:
            del messages[checkpoint:]  # 回滚本轮产生的所有消息
            print(f"[请求失败] {type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
```
```go [Go]
// 02 天气日程工具 Agent（Go 版）：标准库实现 Tool Calling 循环。
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
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

const maxSteps = 5 // 单轮对话中最多调用模型的次数

type FunctionCall struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type ToolCall struct {
	ID       string       `json:"id"`
	Type     string       `json:"type"`
	Function FunctionCall `json:"function"`
}

type Message struct {
	Role       string     `json:"role"`
	Content    string     `json:"content"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
}

type chatRequest struct {
	Model    string          `json:"model"`
	Messages []Message       `json:"messages"`
	Tools    json.RawMessage `json:"tools"`
}

type chatResponse struct {
	Choices []struct {
		Message Message `json:"message"`
	} `json:"choices"`
}

// 工具定义：与 Python 版相同的 JSON Schema
var toolsJSON = json.RawMessage(`[
 {"type":"function","function":{"name":"get_weather",
  "description":"查询某城市某一天的天气预报。用户问天气、或安排户外活动前需要了解天气时使用。",
  "parameters":{"type":"object","properties":{
    "city":{"type":"string","description":"城市名，如 北京"},
    "date":{"type":"string","description":"日期，格式 YYYY-MM-DD"}},
   "required":["city","date"]}}},
 {"type":"function","function":{"name":"add_event","description":"在用户日历中新增一个日程。",
  "parameters":{"type":"object","properties":{
    "date":{"type":"string","description":"日期，格式 YYYY-MM-DD"},
    "time":{"type":"string","description":"开始时间，24 小时制 HH:MM"},
    "title":{"type":"string","description":"日程标题"}},
   "required":["date","time","title"]}}},
 {"type":"function","function":{"name":"list_events","description":"列出用户某一天的全部日程。",
  "parameters":{"type":"object","properties":{
    "date":{"type":"string","description":"日期，格式 YYYY-MM-DD"}},
   "required":["date"]}}}
]`)

// ---------- 工具实现 ----------

type Event struct {
	ID    int    `json:"id"`
	Date  string `json:"date"`
	Time  string `json:"time"`
	Title string `json:"title"`
}

var (
	events     []Event // 内存日历
	conditions = []string{"晴", "多云", "阴", "小雨", "雷阵雨"}
)

func checkDate(s string) error {
	if _, err := time.Parse("2006-01-02", s); err != nil {
		return fmt.Errorf("date 格式应为 YYYY-MM-DD: %q", s)
	}
	return nil
}

func getWeather(city, date string) (any, error) {
	city = strings.TrimSpace(city)
	if city == "" || utf8.RuneCountInString(city) > 20 {
		return nil, errors.New("city 不能为空且不超过 20 个字符")
	}
	if err := checkDate(date); err != nil {
		return nil, err
	}
	seed := 0
	for _, r := range city + date {
		seed += int(r)
	}
	return map[string]any{
		"city": city, "date": date,
		"condition": conditions[seed%len(conditions)],
		"temp_low":  10 + seed%10, "temp_high": 18 + seed%12,
		"source": "mock",
	}, nil
}

func addEvent(date, hm, title string) (any, error) {
	if err := checkDate(date); err != nil {
		return nil, err
	}
	t, err := time.Parse("15:04", hm)
	if err != nil {
		return nil, fmt.Errorf("time 格式应为 HH:MM: %q", hm)
	}
	title = strings.TrimSpace(title)
	if title == "" || utf8.RuneCountInString(title) > 100 {
		return nil, errors.New("title 不能为空且不超过 100 个字符")
	}
	ev := Event{ID: len(events) + 1, Date: date, Time: t.Format("15:04"), Title: title}
	events = append(events, ev)
	return map[string]any{"ok": true, "event": ev}, nil
}

func listEvents(date string) (any, error) {
	if err := checkDate(date); err != nil {
		return nil, err
	}
	items := []Event{}
	for _, e := range events {
		if e.Date == date {
			items = append(items, e)
		}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Time < items[j].Time })
	return map[string]any{"date": date, "events": items}, nil
}

// runTool 解析参数并执行工具；任何错误都转成 {"error": ...} 返回给模型。
func runTool(name, arguments string) string {
	var args struct {
		City  string `json:"city"`
		Date  string `json:"date"`
		Time  string `json:"time"`
		Title string `json:"title"`
	}
	var result any
	err := json.Unmarshal([]byte(arguments), &args)
	if err == nil {
		switch name {
		case "get_weather":
			result, err = getWeather(args.City, args.Date)
		case "add_event":
			result, err = addEvent(args.Date, args.Time, args.Title)
		case "list_events":
			result, err = listEvents(args.Date)
		default:
			err = fmt.Errorf("未知工具 %s", name)
		}
	}
	if err != nil {
		result = map[string]string{"error": err.Error()}
	}
	b, _ := json.Marshal(result)
	return string(b)
}

// ---------- Agent 循环 ----------

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func systemPrompt() string {
	now := time.Now()
	weekdays := []string{"日", "一", "二", "三", "四", "五", "六"}
	return fmt.Sprintf("你是一个日程助理，可以查询天气、管理用户日历。今天是 %s（星期%s）。"+
		"用户说“明天”“周五”等相对日期时，先换算成 YYYY-MM-DD 再调用工具。"+
		"信息不足（例如没说时间）时先向用户确认，不要猜。回答用简洁的中文。",
		now.Format("2006-01-02"), weekdays[now.Weekday()])
}

type Agent struct {
	client  *http.Client
	baseURL string
	apiKey  string
	model   string
}

func (a *Agent) chat(msgs []Message) (Message, error) {
	body, err := json.Marshal(chatRequest{Model: a.model, Messages: msgs, Tools: toolsJSON})
	if err != nil {
		return Message{}, err
	}
	req, err := http.NewRequest(http.MethodPost, a.baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return Message{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+a.apiKey)
	resp, err := a.client.Do(req)
	if err != nil {
		return Message{}, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return Message{}, err
	}
	if resp.StatusCode != http.StatusOK {
		return Message{}, fmt.Errorf("HTTP %d: %.500s", resp.StatusCode, data)
	}
	var cr chatResponse
	if err := json.Unmarshal(data, &cr); err != nil {
		return Message{}, err
	}
	if len(cr.Choices) == 0 {
		return Message{}, errors.New("响应中没有 choices")
	}
	return cr.Choices[0].Message, nil
}

// runTurn 执行一轮对话：反复调用模型，直到模型不再请求工具。
func (a *Agent) runTurn(msgs []Message) ([]Message, string, error) {
	for step := 0; step < maxSteps; step++ {
		msg, err := a.chat(msgs)
		if err != nil {
			return nil, "", err
		}
		if len(msg.ToolCalls) == 0 {
			msgs = append(msgs, Message{Role: "assistant", Content: msg.Content})
			return msgs, msg.Content, nil
		}
		// 1. 模型的调用请求原样放回历史
		msgs = append(msgs, Message{Role: "assistant", Content: msg.Content, ToolCalls: msg.ToolCalls})
		// 2. 执行工具，结果以 role=tool 追加
		for _, tc := range msg.ToolCalls {
			result := runTool(tc.Function.Name, tc.Function.Arguments)
			fmt.Printf("  [工具] %s(%s) -> %s\n", tc.Function.Name, tc.Function.Arguments, result)
			msgs = append(msgs, Message{Role: "tool", ToolCallID: tc.ID, Content: result})
		}
	}
	return msgs, "（已达到最大步数，停止本轮）", nil
}

func main() {
	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" {
		fmt.Fprintln(os.Stderr, "请先设置环境变量 OPENAI_API_KEY")
		os.Exit(1)
	}
	agent := &Agent{
		client:  &http.Client{Timeout: 60 * time.Second},
		baseURL: strings.TrimRight(getenv("OPENAI_BASE_URL", "https://api.openai.com/v1"), "/"),
		apiKey:  apiKey,
		model:   getenv("LLM_MODEL", "gpt-4o-mini"),
	}

	msgs := []Message{{Role: "system", Content: systemPrompt()}}
	fmt.Printf("日程助理已启动（模型 %s）。输入 /reset 清空历史，/exit 退出。\n", agent.model)
	in := bufio.NewScanner(os.Stdin)
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
			return
		case "/reset":
			msgs = []Message{{Role: "system", Content: systemPrompt()}}
			fmt.Println("（历史已清空，日历保留）")
			continue
		}
		// 在副本上执行本轮，失败时直接丢弃，相当于回滚
		turn := append(append([]Message{}, msgs...), Message{Role: "user", Content: input})
		newMsgs, reply, err := agent.runTurn(turn)
		if err != nil {
			fmt.Printf("[请求失败] %v\n", err)
			continue
		}
		msgs = newMsgs
		fmt.Println("助手>", reply)
	}
}
```
```java [Java]
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.UncheckedIOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;

/** 02 天气日程工具 Agent（Java 版）：HttpClient + Jackson 实现 Tool Calling 循环。 */
public class ToolAgent {
    static final int MAX_STEPS = 5; // 单轮对话中最多调用模型的次数
    static final ObjectMapper MAPPER = new ObjectMapper()
            .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false); // 响应里有很多用不到的字段
    static final String[] CONDITIONS = {"晴", "多云", "阴", "小雨", "雷阵雨"};
    static final List<Event> EVENTS = new ArrayList<>(); // 内存日历
    static final DateTimeFormatter HM_IN = DateTimeFormatter.ofPattern("H:mm");
    static final DateTimeFormatter HM_OUT = DateTimeFormatter.ofPattern("HH:mm");

    record FunctionCall(String name, String arguments) {}

    record ToolCall(String id, String type, FunctionCall function) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    record Message(String role, String content,
                   @JsonProperty("tool_calls") List<ToolCall> toolCalls,
                   @JsonProperty("tool_call_id") String toolCallId) {
        static Message of(String role, String content) {
            return new Message(role, content, null, null);
        }
    }

    record ChatRequest(String model, List<Message> messages, JsonNode tools) {}

    record Event(int id, String date, String time, String title) {}

    // 工具定义：与 Python 版相同的 JSON Schema
    static final JsonNode TOOLS = parse("""
        [
          {"type":"function","function":{"name":"get_weather",
            "description":"查询某城市某一天的天气预报。用户问天气、或安排户外活动前需要了解天气时使用。",
            "parameters":{"type":"object","properties":{
              "city":{"type":"string","description":"城市名，如 北京"},
              "date":{"type":"string","description":"日期，格式 YYYY-MM-DD"}},
            "required":["city","date"]}}},
          {"type":"function","function":{"name":"add_event","description":"在用户日历中新增一个日程。",
            "parameters":{"type":"object","properties":{
              "date":{"type":"string","description":"日期，格式 YYYY-MM-DD"},
              "time":{"type":"string","description":"开始时间，24 小时制 HH:MM"},
              "title":{"type":"string","description":"日程标题"}},
            "required":["date","time","title"]}}},
          {"type":"function","function":{"name":"list_events","description":"列出用户某一天的全部日程。",
            "parameters":{"type":"object","properties":{
              "date":{"type":"string","description":"日期，格式 YYYY-MM-DD"}},
            "required":["date"]}}}
        ]
        """);

    static JsonNode parse(String json) {
        try {
            return MAPPER.readTree(json);
        } catch (JsonProcessingException e) {
            throw new UncheckedIOException(e);
        }
    }

    // ---------- 工具实现 ----------

    static void checkDate(String s) {
        try {
            LocalDate.parse(s); // ISO 格式 yyyy-MM-dd
        } catch (DateTimeParseException e) {
            throw new IllegalArgumentException("date 格式应为 YYYY-MM-DD: " + s);
        }
    }

    static Map<String, Object> getWeather(String city, String date) {
        city = city.strip();
        if (city.isEmpty() || city.codePointCount(0, city.length()) > 20) {
            throw new IllegalArgumentException("city 不能为空且不超过 20 个字符");
        }
        checkDate(date);
        int seed = (city + date).codePoints().sum();
        return Map.of(
                "city", city, "date", date,
                "condition", CONDITIONS[seed % CONDITIONS.length],
                "temp_low", 10 + seed % 10, "temp_high", 18 + seed % 12,
                "source", "mock");
    }

    static Map<String, Object> addEvent(String date, String time, String title) {
        checkDate(date);
        String hm;
        try {
            hm = LocalTime.parse(time, HM_IN).format(HM_OUT); // 统一成 09:30 格式
        } catch (DateTimeParseException e) {
            throw new IllegalArgumentException("time 格式应为 HH:MM: " + time);
        }
        title = title.strip();
        if (title.isEmpty() || title.codePointCount(0, title.length()) > 100) {
            throw new IllegalArgumentException("title 不能为空且不超过 100 个字符");
        }
        Event ev = new Event(EVENTS.size() + 1, date, hm, title);
        EVENTS.add(ev);
        return Map.of("ok", true, "event", ev);
    }

    static Map<String, Object> listEvents(String date) {
        checkDate(date);
        List<Event> items = EVENTS.stream()
                .filter(e -> e.date().equals(date))
                .sorted(Comparator.comparing(Event::time))
                .toList();
        return Map.of("date", date, "events", items);
    }

    /** 解析参数并执行工具；任何错误都转成 {"error": ...} 返回给模型。 */
    static String runTool(String name, String arguments) {
        Object result;
        try {
            JsonNode args = MAPPER.readTree(arguments == null || arguments.isBlank() ? "{}" : arguments);
            if (!args.isObject()) throw new IllegalArgumentException("参数必须是 JSON 对象");
            result = switch (name) {
                case "get_weather" -> getWeather(args.path("city").asText(), args.path("date").asText());
                case "add_event" -> addEvent(args.path("date").asText(),
                        args.path("time").asText(), args.path("title").asText());
                case "list_events" -> listEvents(args.path("date").asText());
                default -> Map.of("error", "未知工具 " + name);
            };
        } catch (JsonProcessingException | IllegalArgumentException e) {
            result = Map.of("error", e.getClass().getSimpleName() + ": " + e.getMessage());
        }
        try {
            return MAPPER.writeValueAsString(result);
        } catch (JsonProcessingException e) {
            return "{\"error\":\"结果序列化失败\"}";
        }
    }

    // ---------- Agent 循环 ----------

    record Llm(HttpClient client, String baseUrl, String apiKey, String model) {
        @Override
        public String toString() { // 覆盖默认 toString，避免把 Key 打进日志
            return "Llm[model=" + model + "]";
        }

        Message chat(List<Message> messages) throws IOException, InterruptedException {
            String body = MAPPER.writeValueAsString(new ChatRequest(model, messages, TOOLS));
            HttpRequest req = HttpRequest.newBuilder(URI.create(baseUrl + "/chat/completions"))
                    .timeout(Duration.ofSeconds(60))
                    .header("Content-Type", "application/json")
                    .header("Authorization", "Bearer " + apiKey)
                    .POST(HttpRequest.BodyPublishers.ofString(body))
                    .build();
            HttpResponse<String> resp = client.send(req, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (resp.statusCode() != 200) {
                String b = resp.body();
                throw new IOException("HTTP " + resp.statusCode() + ": " + b.substring(0, Math.min(500, b.length())));
            }
            JsonNode msg = MAPPER.readTree(resp.body()).path("choices").path(0).path("message");
            if (msg.isMissingNode()) throw new IOException("响应中没有 choices");
            return MAPPER.treeToValue(msg, Message.class);
        }
    }

    static String getenv(String key, String def) {
        String v = System.getenv(key);
        return (v == null || v.isBlank()) ? def : v;
    }

    static String systemPrompt() {
        LocalDate today = LocalDate.now();
        char weekday = "一二三四五六日".charAt(today.getDayOfWeek().getValue() - 1);
        return "你是一个日程助理，可以查询天气、管理用户日历。今天是 " + today + "（星期" + weekday + "）。"
                + "用户说“明天”“周五”等相对日期时，先换算成 YYYY-MM-DD 再调用工具。"
                + "信息不足（例如没说时间）时先向用户确认，不要猜。回答用简洁的中文。";
    }

    /** 执行一轮对话：反复调用模型，直到模型不再请求工具。 */
    static String runTurn(Llm llm, List<Message> messages) throws IOException, InterruptedException {
        for (int step = 0; step < MAX_STEPS; step++) {
            Message msg = llm.chat(messages);
            if (msg.toolCalls() == null || msg.toolCalls().isEmpty()) {
                String content = msg.content() == null ? "" : msg.content();
                messages.add(Message.of("assistant", content));
                return content;
            }
            // 1. 模型的调用请求原样放回历史
            messages.add(new Message("assistant", msg.content(), msg.toolCalls(), null));
            // 2. 执行工具，结果以 role=tool 追加，tool_call_id 必须对应
            for (ToolCall tc : msg.toolCalls()) {
                String result = runTool(tc.function().name(), tc.function().arguments());
                System.out.printf("  [工具] %s(%s) -> %s%n", tc.function().name(), tc.function().arguments(), result);
                messages.add(new Message("tool", result, null, tc.id()));
            }
        }
        return "（已达到最大步数，停止本轮）";
    }

    public static void main(String[] args) throws Exception {
        String apiKey = System.getenv("OPENAI_API_KEY");
        if (apiKey == null || apiKey.isBlank()) {
            System.err.println("请先设置环境变量 OPENAI_API_KEY");
            System.exit(1);
        }
        Llm llm = new Llm(
                HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build(),
                getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").replaceAll("/+$", ""),
                apiKey,
                getenv("LLM_MODEL", "gpt-4o-mini"));

        List<Message> messages = new ArrayList<>(List.of(Message.of("system", systemPrompt())));
        System.out.printf("日程助理已启动（模型 %s）。输入 /reset 清空历史，/exit 退出。%n", llm.model());
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        while (true) {
            System.out.print("\n你> ");
            System.out.flush();
            String line = in.readLine();
            if (line == null) {
                System.out.println("\n再见");
                break;
            }
            String input = line.strip();
            if (input.isEmpty()) continue;
            if (input.equals("/exit")) break;
            if (input.equals("/reset")) {
                messages = new ArrayList<>(List.of(Message.of("system", systemPrompt())));
                System.out.println("（历史已清空，日历保留）");
                continue;
            }
            int checkpoint = messages.size();
            messages.add(Message.of("user", input));
            try {
                System.out.println("助手> " + runTurn(llm, messages));
            } catch (IOException e) {
                messages.subList(checkpoint, messages.size()).clear(); // 回滚本轮产生的所有消息
                System.out.println("[请求失败] " + e.getMessage());
            }
        }
    }
}
```
:::

各语言实现里值得注意的细节：

- **Python**：`func(**args)` 直接把模型参数展开成关键字参数，缺参数或多参数会抛 `TypeError`，被统一转成错误 JSON 返回给模型。
- **Go**：把所有可能的参数放进一个结构体统一反序列化，缺失字段为空字符串，由各工具函数自己校验。
- **Java**：响应里有很多用不到的字段，所以关闭了 `FAIL_ON_UNKNOWN_PROPERTIES`；`Message` 用 `@JsonInclude(NON_NULL)` 让普通消息不带 `tool_calls: null`。`Llm` record 覆盖了 `toString`，避免把 Key 打进日志。

## 运行与测试

::: code-group
```bash [Python]
python agent.py
```
```bash [Go]
go run main.go
```
```bash [Java]
mvn -q compile exec:java
```
:::

### 测试 1：单工具调用

```text
你> 明天北京天气怎么样？
  [工具] get_weather({"city":"北京","date":"2025-06-02"}) -> {"city": "北京", "date": "2025-06-02", "condition": "晴", ...}
助手> 明天（6 月 2 日）北京晴，气温 12～25°C，适合出行。
```

### 测试 2：多步、多工具

```text
你> 帮我看看周六上海的天气，不下雨的话下午 3 点加个跑步，然后列出那天的安排
  [工具] get_weather({"city":"上海","date":"2025-06-07"}) -> {..., "condition": "多云", ...}
  [工具] add_event({"date":"2025-06-07","time":"15:00","title":"跑步"}) -> {"ok": true, "event": {...}}
  [工具] list_events({"date":"2025-06-07"}) -> {"date": "2025-06-07", "events": [...]}
助手> 周六上海多云，不下雨。已为你添加 15:00 的跑步，当天安排：15:00 跑步。
```

### 测试 3：信息不足时追问

```text
你> 帮我加个会议
助手> 好的，请告诉我会议的日期、开始时间和标题。
```

### 测试 4：工具报错后自我修正

在 `get_weather` 开头临时加一行代码，让它对第一次调用总是报"日期格式错误"，观察模型是否会换个参数重试。也可以直接让用户输入"帮我在 2025-13-40 加个日程"，看模型如何处理工具返回的错误。

::: tip 关于示例输出
天气是模拟数据，具体数值取决于城市和日期；日期取决于你运行当天。模型的措辞每次也可能不同，重点看工具调用轨迹是否合理。
:::

检查清单：

- [ ] 问天气时，终端打印了 `[工具] get_weather(...)` 轨迹
- [ ] "明天""周六"被换算成了正确的 `YYYY-MM-DD`
- [ ] 一句话里的多个任务能在一轮内通过多次工具调用完成
- [ ] 参数错误时程序不崩溃，模型能看到错误信息
- [ ] `/reset` 后对话历史清空，但日历里的日程还在（日历和对话历史是两份独立的状态）

::: warning 常见报错
- `400 ... tool_call_id`：带 `tool_calls` 的 assistant 消息没放回历史，或某个 tool 消息的 id 对不上。
- 模型从不调用工具：确认所选模型支持 Tool Calling；检查工具的 description 是否说清了使用时机。
:::

## 扩展挑战

1. **加一个删除工具**：实现 `delete_event(id)`。这是有副作用的操作，可以在执行前让用户在终端输入 `y` 确认，体会 [权限控制与人在环路](/guide/15-production/permissions-hitl)。
2. **接入真实天气 API**：保持 `get_weather` 的签名不变，把内部实现换成真实服务，并加上超时和错误处理。由于工具接口没变，Agent 代码一行都不用改。
3. **日历持久化**：把 `EVENTS` 存到 JSON 文件或 SQLite，程序重启后日程仍在。
4. **冲突检测**：`add_event` 发现同一时间已有日程时返回冲突信息，让模型询问用户是否仍要添加。
5. **流式 + 工具**：把项目 01 的流式输出合并进来。提示：流式模式下 `tool_calls` 也是分块到达的，需要按 `index` 拼接 `arguments`。

## 下一步

这个项目里，"决定下一步做什么"完全交给了模型的 Tool Calling 能力。项目 [03 手写 ReAct Agent](/projects/03-react-agent) 会把这个循环拆开，让模型显式输出"思考 → 行动 → 观察"，并打印完整的推理轨迹，帮你真正看清 Agent 循环的内部结构。

---
title: 03 手写 ReAct Agent
description: 不用任何框架，用约 150 行代码实现 Thought → Action → Observation 循环，带步数上限和轨迹打印。
---

# 03 手写 ReAct Agent

::: info 项目信息
- 难度：★★☆☆☆
- 预计时间：1.5 小时
- 前置知识：[ReAct：推理与行动](/guide/06-agent-loop/react)、[不用框架手写 Agent](/guide/06-agent-loop/handwritten-agent)、[多轮对话与消息结构](/guide/03-llm-api/multi-turn)
- 你将学会：
  - 用纯文本协议（Thought / Action / Observation）驱动模型使用工具
  - 用 `stop` 参数阻止模型"自问自答"编造工具结果
  - 解析模型输出、把格式错误反馈给模型自我修正
  - 用步数上限和观察截断控制循环，打印完整推理轨迹
:::

## 需求说明

[项目 02](/projects/02-tool-agent) 里我们用了模型原生的 Tool Calling。这一次反过来：**假设模型不支持 Tool Calling**，只靠提示词和字符串解析，自己实现 ReAct 循环。这样做能让你看清 Agent 循环的每一个零件，以后读任何框架源码都不会觉得神秘。

功能要求：

1. 提供两个工具：`search`（模拟百科搜索）和 `calculator`（安全的四则运算）。
2. 模型按 `Thought → Action → Action Input` 格式输出，程序执行工具后把结果以 `Observation:` 回填。
3. 模型输出 `Final Answer:` 时结束。
4. 最多执行 8 步，超出则放弃并告知用户。
5. 每一步打印 Thought、Action、Observation，方便调试。
6. 格式错误、未知工具、参数错误都不能让程序崩溃，而是作为 Observation 告诉模型。

::: tip 为什么还要学手写 ReAct
原生 Tool Calling 更稳定，生产环境优先用它。但 ReAct 文本协议在这些场景仍然有用：模型不支持工具调用、需要让推理过程可读、做论文复现或教学。更重要的是，它是理解所有 Agent 框架的最小模型。
:::

## 架构设计

```text
              ┌───────────────────────────────────────────┐
  用户问题 ──▶ │ messages = [system(协议+工具), user(问题)] │
              └───────────────────────┬───────────────────┘
                                      ▼
            ┌──────────────── for step in 1..MAX_STEPS ────────────────┐
            │                                                           │
            │   调用 LLM（stop=["Observation:"]）                        │
            │        │                                                  │
            │        ▼                                                  │
            │   解析输出 ──▶ Final Answer? ──是──▶ 返回答案               │
            │        │否                                                │
            │        ▼                                                  │
            │   Action + Action Input ──▶ 查工具表 ──▶ 执行工具           │
            │        │（格式错误/未知工具/参数错误 也变成 Observation）      │
            │        ▼                                                  │
            │   messages += assistant(输出) + user("Observation: ...")  │
            │                                                           │
            └───────────────────────────────────────────────────────────┘
                                      ▼
                         超过步数 ──▶ 返回"未能得出答案"
```

整个程序只有四个部件：

| 部件 | 职责 |
|------|------|
| 工具表 | 工具名 → 函数 + 描述，描述会被写进系统提示词 |
| 系统提示词 | 定义输出协议，告诉模型有哪些工具 |
| 解析器 | 用正则从模型输出里取出 Thought / Action / Action Input / Final Answer |
| 循环 | 调模型、解析、执行、回填，直到结束或超出步数 |

## 分步实现

### Step 1：准备环境

::: code-group
```bash [Python]
mkdir react-agent && cd react-agent
python3 -m venv .venv && source .venv/bin/activate
pip install openai
```
```bash [Go]
mkdir react-agent && cd react-agent
go mod init react-agent
# 只用标准库，无需额外依赖
```
```bash [Java]
# Maven 项目，pom.xml 中加入 Jackson 依赖（见下）
mvn archetype:generate -DgroupId=demo -DartifactId=react-agent \
  -DarchetypeArtifactId=maven-archetype-quickstart -DinteractiveMode=false
```
:::

Java 版把 `ReactAgent.java` 放在 `src/main/java/` 下（不带 package），并在 `pom.xml` 的 `properties` 里设置 `maven.compiler.release` 为 `17`（record 和文本块需要 Java 17）。需要的依赖：

```xml
<dependency>
  <groupId>com.fasterxml.jackson.core</groupId>
  <artifactId>jackson-databind</artifactId>
  <version>2.17.2</version>
</dependency>
```

配置环境变量（三种语言通用）：

```bash
export OPENAI_API_KEY="sk-..."          # 你的 Key，不要提交到 Git
export OPENAI_BASE_URL="https://api.openai.com/v1"   # 可选，换成 DeepSeek / 通义千问等的兼容地址
export LLM_MODEL="gpt-4o-mini"          # 示例，换成你的模型名
```

### Step 2：定义工具

我们用一个本地小词典模拟搜索，避免依赖外部 API；计算器只接受固定的运算符和两个数字。

::: warning 不要用 eval 实现计算器
很多 ReAct 教程让模型输出 `2+3*4` 这样的表达式，再用 `eval` 计算。这等于把代码执行权交给了模型，而模型的输入可能被用户或网页内容操控。这里改为结构化参数 `{"op": "mul", "a": 3, "b": 4}`，程序只做白名单内的运算。
:::

下面是 Python 版的工具部分，Go / Java 版逻辑相同，完整代码见 Step 5。

```python
FAKE_KB = {
    "埃菲尔铁塔": "埃菲尔铁塔位于法国巴黎，含天线高约 330 米，1889 年建成。",
    "东方明珠": "东方明珠广播电视塔位于上海浦东，高约 468 米，1994 年建成。",
    "广州塔": "广州塔位于广州海珠区，总高约 600 米，2010 年建成。",
}

def search(query: str) -> str:
    hits = [text for key, text in FAKE_KB.items() if key in query]
    return "\n".join(hits) if hits else f"没有找到与「{query}」相关的结果"

def calculator(op: str, a: float, b: float) -> str:
    a, b = float(a), float(b)
    if op == "add": return str(a + b)
    ...

TOOLS = {
    "search": (search, '搜索百科知识。输入: {"query": "关键词"}'),
    "calculator": (calculator, '四则运算。输入: {"op": "add|sub|mul|div", "a": 数字, "b": 数字}'),
}
```

工具描述里直接写出输入的 JSON 样例。模型没有 JSON Schema 可参考，样例就是它唯一的"接口文档"。

### Step 3：设计输出协议

系统提示词要把格式讲死，并且明确"Observation 由系统提供"：

```text
严格按以下格式输出，每次只做一步：
Thought: 你对当前情况的思考
Action: 工具名（只能是 search, calculator 之一）
Action Input: 一行 JSON 参数

拿到 Observation 后继续下一轮 Thought。当你已经可以回答时，输出：
Thought: 我已经知道答案了
Final Answer: 给用户的最终回答

不要自己编写 Observation，它由系统提供。
```

光靠提示词还不够。模型常常会顺着格式继续往下写，自己"想象"一个 Observation 出来，然后基于假数据给出答案。解决办法是调用时传 `stop=["Observation:"]`：模型一写到这个词，生成就被截断，控制权回到我们手里。

::: tip 关于 stop 参数
`stop` 是 Chat Completions API 的标准参数，主流 OpenAI 兼容服务都支持。部分推理模型可能不支持或忽略它，遇到这种情况换一个普通对话模型，或者在解析时丢弃 `Observation:` 之后的内容。参数支持情况以各厂商官方文档为准。
:::

### Step 4：解析输出与容错

解析规则很简单，按优先级：

1. 出现 `Final Answer:`，取它后面的全部文本作为答案，结束循环。
2. 出现 `Action:` 和 `Action Input:`，取出工具名和 JSON 参数，执行工具。
3. 两者都没有，说明模型没按格式输出。

关键在第 3 种情况以及各种执行错误的处理方式：**不抛异常，而是把错误写成 Observation 回填给模型**。模型看到"格式错误：Action Input 不是合法 JSON"后，通常下一步就会自己改正。这是 Agent 自我修正能力的来源，也是 [工具错误处理与重试](/guide/05-tool-calling/error-handling) 里讲的核心思想。

```python
ACTION_RE = re.compile(r"Action:\s*(\w+)\s*Action Input:\s*(\{.*\})", re.S)
FINAL_RE = re.compile(r"Final Answer:\s*(.*)", re.S)

def run_tool(name: str, args: dict) -> str:
    if name not in TOOLS:
        return f"错误：未知工具 {name}，可用工具：{', '.join(TOOLS)}"
    func, _ = TOOLS[name]
    try:
        return func(**args)
    except (TypeError, ValueError) as e:  # 参数缺失、类型不对、业务错误
        return f"工具执行出错：{e}"
```

循环还有两道保险：

- **步数上限** `MAX_STEPS = 8`：模型可能陷入反复搜索同一个词的死循环，上限保证程序一定会结束，也控制了 Token 成本。详见 [终止条件、步数与预算控制](/guide/06-agent-loop/stop-budget)。
- **观察截断** `MAX_OBS_CHARS = 2000`：真实工具（网页抓取、数据库查询）可能返回很长的结果，截断后再回填，避免撑爆上下文窗口。

### Step 5：完整代码

把上面的部件和主循环组合起来。三个版本的行为完全一致，可以任选一个运行。

::: code-group
```python [Python]
"""手写 ReAct Agent：不依赖任何 Agent 框架。"""
import json
import os
import re
import sys

from openai import OpenAI

MAX_STEPS = 8          # 最多推理-行动几轮
MAX_OBS_CHARS = 2000   # 单条 Observation 最多回填多少字符

# ---------- 工具 ----------
FAKE_KB = {
    "埃菲尔铁塔": "埃菲尔铁塔位于法国巴黎，含天线高约 330 米，1889 年建成。",
    "东方明珠": "东方明珠广播电视塔位于上海浦东，高约 468 米，1994 年建成。",
    "广州塔": "广州塔位于广州海珠区，总高约 600 米，2010 年建成。",
}


def search(query: str) -> str:
    """模拟搜索：在本地小词典里做关键词匹配。"""
    hits = [text for key, text in FAKE_KB.items() if key in query]
    return "\n".join(hits) if hits else f"没有找到与「{query}」相关的结果"


def calculator(op: str, a: float, b: float) -> str:
    """四则运算。只接受数字和固定运算符，绝不 eval 模型输出。"""
    a, b = float(a), float(b)
    if op == "add":
        return str(a + b)
    if op == "sub":
        return str(a - b)
    if op == "mul":
        return str(a * b)
    if op == "div":
        if b == 0:
            raise ValueError("除数不能为 0")
        return str(a / b)
    raise ValueError(f"不支持的运算符: {op}")


TOOLS = {
    "search": (search, '搜索百科知识。输入: {"query": "关键词"}'),
    "calculator": (calculator, '四则运算。输入: {"op": "add|sub|mul|div", "a": 数字, "b": 数字}'),
}

SYSTEM_PROMPT = """你是一个会使用工具解决问题的助手。可用工具：
{tools}

严格按以下格式输出，每次只做一步：
Thought: 你对当前情况的思考
Action: 工具名（只能是 {names} 之一）
Action Input: 一行 JSON 参数

拿到 Observation 后继续下一轮 Thought。当你已经可以回答时，输出：
Thought: 我已经知道答案了
Final Answer: 给用户的最终回答

不要自己编写 Observation，它由系统提供。"""

ACTION_RE = re.compile(r"Action:\s*(\w+)\s*Action Input:\s*(\{.*\})", re.S)
FINAL_RE = re.compile(r"Final Answer:\s*(.*)", re.S)
THOUGHT_RE = re.compile(r"Thought:\s*(.*?)(?:\n(?:Action|Final Answer):|$)", re.S)


def parse(text: str):
    """返回 ("final", answer) / ("action", name, args) / ("error", 原因)。"""
    if m := FINAL_RE.search(text):
        return ("final", m.group(1).strip())
    if m := ACTION_RE.search(text):
        try:
            args = json.loads(m.group(2))
        except json.JSONDecodeError as e:
            return ("error", f"Action Input 不是合法 JSON: {e}")
        if not isinstance(args, dict):
            return ("error", "Action Input 必须是 JSON 对象")
        return ("action", m.group(1), args)
    return ("error", "没有找到 Action 或 Final Answer，请严格按格式输出")


def run_tool(name: str, args: dict) -> str:
    if name not in TOOLS:
        return f"错误：未知工具 {name}，可用工具：{', '.join(TOOLS)}"
    func, _ = TOOLS[name]
    try:
        return func(**args)
    except (TypeError, ValueError) as e:  # 参数缺失、类型不对、业务错误
        return f"工具执行出错：{e}"


def run_agent(client: OpenAI, model: str, question: str) -> str:
    tools_desc = "\n".join(f"- {n}: {d}" for n, (_, d) in TOOLS.items())
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT.format(tools=tools_desc, names=", ".join(TOOLS))},
        {"role": "user", "content": f"问题：{question}"},
    ]
    for step in range(1, MAX_STEPS + 1):
        resp = client.chat.completions.create(
            model=model,
            messages=messages,
            temperature=0,
            stop=["Observation:"],  # 防止模型自己编造工具结果
        )
        text = (resp.choices[0].message.content or "").strip()
        messages.append({"role": "assistant", "content": text})

        print(f"\n===== Step {step} =====")
        if m := THOUGHT_RE.search(text):
            print(f"[Thought] {m.group(1).strip()}")

        result = parse(text)
        if result[0] == "final":
            print(f"[Final]   {result[1]}")
            return result[1]
        if result[0] == "action":
            _, name, args = result
            print(f"[Action]  {name} {json.dumps(args, ensure_ascii=False)}")
            observation = run_tool(name, args)
        else:
            observation = f"格式错误：{result[1]}"
        observation = observation[:MAX_OBS_CHARS]
        print(f"[Observe] {observation}")
        messages.append({"role": "user", "content": f"Observation: {observation}"})

    return f"抱歉，{MAX_STEPS} 步内没有得出答案。"


def main() -> None:
    model = os.environ.get("LLM_MODEL", "gpt-4o-mini")
    client = OpenAI(  # 自动读取 OPENAI_API_KEY
        base_url=os.environ.get("OPENAI_BASE_URL") or None,
        timeout=60,
    )
    question = " ".join(sys.argv[1:]) or "东方明珠比埃菲尔铁塔高多少米？"
    answer = run_agent(client, model, question)
    print(f"\n答案：{answer}")


if __name__ == "__main__":
    main()
```
```go [Go]
// 手写 ReAct Agent（Go 标准库版）
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	maxSteps    = 8
	maxObsRunes = 2000
)

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatRequest struct {
	Model       string    `json:"model"`
	Messages    []Message `json:"messages"`
	Temperature float64   `json:"temperature"`
	Stop        []string  `json:"stop,omitempty"`
}

type chatResponse struct {
	Choices []struct {
		Message Message `json:"message"`
	} `json:"choices"`
}

var httpClient = &http.Client{Timeout: 60 * time.Second}

func chat(messages []Message) (string, error) {
	baseURL := os.Getenv("OPENAI_BASE_URL")
	if baseURL == "" {
		baseURL = "https://api.openai.com/v1"
	}
	model := os.Getenv("LLM_MODEL")
	if model == "" {
		model = "gpt-4o-mini"
	}
	body, _ := json.Marshal(chatRequest{Model: model, Messages: messages, Temperature: 0,
		Stop: []string{"Observation:"}})
	req, err := http.NewRequest(http.MethodPost, strings.TrimRight(baseURL, "/")+"/chat/completions", bytes.NewReader(body))
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
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("API 返回 %d: %s", resp.StatusCode, data)
	}
	var cr chatResponse
	if err := json.Unmarshal(data, &cr); err != nil {
		return "", err
	}
	if len(cr.Choices) == 0 {
		return "", errors.New("响应中没有 choices")
	}
	return strings.TrimSpace(cr.Choices[0].Message.Content), nil
}

// ---------- 工具 ----------
var fakeKB = map[string]string{
	"埃菲尔铁塔": "埃菲尔铁塔位于法国巴黎，含天线高约 330 米，1889 年建成。",
	"东方明珠":  "东方明珠广播电视塔位于上海浦东，高约 468 米，1994 年建成。",
	"广州塔":   "广州塔位于广州海珠区，总高约 600 米，2010 年建成。",
}

type Tool struct {
	Desc string
	Run  func(args map[string]any) (string, error)
}

func search(args map[string]any) (string, error) {
	q, ok := args["query"].(string)
	if !ok || q == "" {
		return "", errors.New("缺少字符串参数 query")
	}
	var hits []string
	for k, v := range fakeKB {
		if strings.Contains(q, k) {
			hits = append(hits, v)
		}
	}
	if len(hits) == 0 {
		return fmt.Sprintf("没有找到与「%s」相关的结果", q), nil
	}
	return strings.Join(hits, "\n"), nil
}

func calculator(args map[string]any) (string, error) {
	op, _ := args["op"].(string)
	a, okA := args["a"].(float64) // encoding/json 把数字解析为 float64
	b, okB := args["b"].(float64)
	if !okA || !okB {
		return "", errors.New("a 和 b 必须是数字")
	}
	var r float64
	switch op {
	case "add":
		r = a + b
	case "sub":
		r = a - b
	case "mul":
		r = a * b
	case "div":
		if b == 0 {
			return "", errors.New("除数不能为 0")
		}
		r = a / b
	default:
		return "", fmt.Errorf("不支持的运算符: %s", op)
	}
	return strconv.FormatFloat(r, 'f', -1, 64), nil
}

var tools = map[string]Tool{
	"search":     {`搜索百科知识。输入: {"query": "关键词"}`, search},
	"calculator": {`四则运算。输入: {"op": "add|sub|mul|div", "a": 数字, "b": 数字}`, calculator},
}

const systemPrompt = `你是一个会使用工具解决问题的助手。可用工具：
%s
严格按以下格式输出，每次只做一步：
Thought: 你对当前情况的思考
Action: 工具名（只能是 search, calculator 之一）
Action Input: 一行 JSON 参数

拿到 Observation 后继续下一轮 Thought。当你已经可以回答时，输出：
Thought: 我已经知道答案了
Final Answer: 给用户的最终回答

不要自己编写 Observation，它由系统提供。`

var (
	actionRe  = regexp.MustCompile(`(?s)Action:\s*(\w+)\s*Action Input:\s*(\{.*\})`)
	finalRe   = regexp.MustCompile(`(?s)Final Answer:\s*(.*)`)
	thoughtRe = regexp.MustCompile(`(?s)Thought:\s*(.*?)(?:\n(?:Action|Final Answer):|$)`)
)

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

// step 解析一次模型输出：返回最终答案（done=true）或 Observation。
func step(text string) (answer string, done bool) {
	if m := finalRe.FindStringSubmatch(text); m != nil {
		return strings.TrimSpace(m[1]), true
	}
	m := actionRe.FindStringSubmatch(text)
	if m == nil {
		return "格式错误：没有找到 Action 或 Final Answer，请严格按格式输出", false
	}
	name, rawArgs := m[1], m[2]
	var args map[string]any
	if err := json.Unmarshal([]byte(rawArgs), &args); err != nil {
		return "格式错误：Action Input 不是合法 JSON 对象: " + err.Error(), false
	}
	fmt.Printf("[Action]  %s %s\n", name, rawArgs)
	tool, ok := tools[name]
	if !ok {
		return "错误：未知工具 " + name + "，可用工具：search, calculator", false
	}
	out, err := tool.Run(args)
	if err != nil {
		return "工具执行出错：" + err.Error(), false
	}
	return out, false
}

func runAgent(question string) (string, error) {
	var desc strings.Builder
	for _, n := range []string{"search", "calculator"} { // 固定顺序，便于复现
		fmt.Fprintf(&desc, "- %s: %s\n", n, tools[n].Desc)
	}
	messages := []Message{
		{Role: "system", Content: fmt.Sprintf(systemPrompt, desc.String())},
		{Role: "user", Content: "问题：" + question},
	}
	for i := 1; i <= maxSteps; i++ {
		text, err := chat(messages)
		if err != nil {
			return "", err
		}
		messages = append(messages, Message{Role: "assistant", Content: text})
		fmt.Printf("\n===== Step %d =====\n", i)
		if m := thoughtRe.FindStringSubmatch(text); m != nil {
			fmt.Printf("[Thought] %s\n", strings.TrimSpace(m[1]))
		}
		result, done := step(text)
		if done {
			fmt.Printf("[Final]   %s\n", result)
			return result, nil
		}
		obs := truncate(result, maxObsRunes)
		fmt.Printf("[Observe] %s\n", obs)
		messages = append(messages, Message{Role: "user", Content: "Observation: " + obs})
	}
	return fmt.Sprintf("抱歉，%d 步内没有得出答案。", maxSteps), nil
}

func main() {
	question := strings.Join(os.Args[1:], " ")
	if question == "" {
		question = "东方明珠比埃菲尔铁塔高多少米？"
	}
	answer, err := runAgent(question)
	if err != nil {
		fmt.Fprintln(os.Stderr, "出错：", err)
		os.Exit(1)
	}
	fmt.Println("\n答案：" + answer)
}
```
```java [Java]
// 手写 ReAct Agent（Java 17 + Jackson）
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class ReactAgent {
    static final int MAX_STEPS = 8;
    static final int MAX_OBS_CHARS = 2000;
    static final ObjectMapper MAPPER = new ObjectMapper();
    static final HttpClient HTTP = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10)).build();

    record Message(String role, String content) {}

    record Tool(String desc, Function<JsonNode, String> run) {}

    static String env(String key, String def) {
        String v = System.getenv(key);
        return (v == null || v.isBlank()) ? def : v;
    }

    static String chat(List<Message> messages) throws Exception {
        String baseUrl = env("OPENAI_BASE_URL", "https://api.openai.com/v1").replaceAll("/+$", "");
        Map<String, Object> body = Map.of(
                "model", env("LLM_MODEL", "gpt-4o-mini"),
                "messages", messages,
                "temperature", 0,
                "stop", List.of("Observation:"));
        HttpRequest req = HttpRequest.newBuilder(URI.create(baseUrl + "/chat/completions"))
                .timeout(Duration.ofSeconds(60))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + env("OPENAI_API_KEY", ""))
                .POST(HttpRequest.BodyPublishers.ofString(MAPPER.writeValueAsString(body)))
                .build();
        HttpResponse<String> resp = HTTP.send(req, HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() != 200) {
            throw new RuntimeException("API 返回 " + resp.statusCode() + ": " + resp.body());
        }
        JsonNode content = MAPPER.readTree(resp.body()).path("choices").path(0).path("message").path("content");
        return content.asText("").strip();
    }

    // ---------- 工具 ----------
    static final Map<String, String> FAKE_KB = Map.of(
            "埃菲尔铁塔", "埃菲尔铁塔位于法国巴黎，含天线高约 330 米，1889 年建成。",
            "东方明珠", "东方明珠广播电视塔位于上海浦东，高约 468 米，1994 年建成。",
            "广州塔", "广州塔位于广州海珠区，总高约 600 米，2010 年建成。");

    static String search(JsonNode args) {
        String q = args.path("query").asText("");
        if (q.isBlank()) throw new IllegalArgumentException("缺少字符串参数 query");
        List<String> hits = new ArrayList<>();
        FAKE_KB.forEach((k, v) -> { if (q.contains(k)) hits.add(v); });
        return hits.isEmpty() ? "没有找到与「" + q + "」相关的结果" : String.join("\n", hits);
    }

    static String calculator(JsonNode args) {
        if (!args.path("a").isNumber() || !args.path("b").isNumber()) {
            throw new IllegalArgumentException("a 和 b 必须是数字");
        }
        double a = args.get("a").asDouble(), b = args.get("b").asDouble();
        double r = switch (args.path("op").asText("")) {
            case "add" -> a + b;
            case "sub" -> a - b;
            case "mul" -> a * b;
            case "div" -> {
                if (b == 0) throw new IllegalArgumentException("除数不能为 0");
                yield a / b;
            }
            default -> throw new IllegalArgumentException("不支持的运算符: " + args.path("op").asText());
        };
        return String.valueOf(r);
    }

    static final Map<String, Tool> TOOLS = new LinkedHashMap<>();
    static {
        TOOLS.put("search", new Tool("搜索百科知识。输入: {\"query\": \"关键词\"}", ReactAgent::search));
        TOOLS.put("calculator", new Tool(
                "四则运算。输入: {\"op\": \"add|sub|mul|div\", \"a\": 数字, \"b\": 数字}", ReactAgent::calculator));
    }

    static final String SYSTEM_PROMPT = """
            你是一个会使用工具解决问题的助手。可用工具：
            %s
            严格按以下格式输出，每次只做一步：
            Thought: 你对当前情况的思考
            Action: 工具名（只能是 search, calculator 之一）
            Action Input: 一行 JSON 参数

            拿到 Observation 后继续下一轮 Thought。当你已经可以回答时，输出：
            Thought: 我已经知道答案了
            Final Answer: 给用户的最终回答

            不要自己编写 Observation，它由系统提供。""";

    static final Pattern ACTION_RE = Pattern.compile("Action:\\s*(\\w+)\\s*Action Input:\\s*(\\{.*\\})", Pattern.DOTALL);
    static final Pattern FINAL_RE = Pattern.compile("Final Answer:\\s*(.*)", Pattern.DOTALL);
    static final Pattern THOUGHT_RE = Pattern.compile("Thought:\\s*(.*?)(?:\\n(?:Action|Final Answer):|$)", Pattern.DOTALL);

    /** 执行模型选择的 Action，返回 Observation 文本。 */
    static String act(String text) {
        Matcher m = ACTION_RE.matcher(text);
        if (!m.find()) return "格式错误：没有找到 Action 或 Final Answer，请严格按格式输出";
        String name = m.group(1);
        JsonNode args;
        try {
            args = MAPPER.readTree(m.group(2));
        } catch (Exception e) {
            return "格式错误：Action Input 不是合法 JSON: " + e.getMessage();
        }
        if (!args.isObject()) return "格式错误：Action Input 必须是 JSON 对象";
        System.out.println("[Action]  " + name + " " + args);
        Tool tool = TOOLS.get(name);
        if (tool == null) return "错误：未知工具 " + name + "，可用工具：" + String.join(", ", TOOLS.keySet());
        try {
            return tool.run().apply(args);
        } catch (IllegalArgumentException e) {
            return "工具执行出错：" + e.getMessage();
        }
    }

    static String runAgent(String question) throws Exception {
        StringBuilder desc = new StringBuilder();
        TOOLS.forEach((n, t) -> desc.append("- ").append(n).append(": ").append(t.desc()).append("\n"));
        List<Message> messages = new ArrayList<>();
        messages.add(new Message("system", SYSTEM_PROMPT.formatted(desc)));
        messages.add(new Message("user", "问题：" + question));

        for (int step = 1; step <= MAX_STEPS; step++) {
            String text = chat(messages);
            messages.add(new Message("assistant", text));
            System.out.println("\n===== Step " + step + " =====");
            Matcher t = THOUGHT_RE.matcher(text);
            if (t.find()) System.out.println("[Thought] " + t.group(1).strip());

            Matcher f = FINAL_RE.matcher(text);
            if (f.find()) {
                String answer = f.group(1).strip();
                System.out.println("[Final]   " + answer);
                return answer;
            }
            String obs = act(text);
            if (obs.length() > MAX_OBS_CHARS) obs = obs.substring(0, MAX_OBS_CHARS);
            System.out.println("[Observe] " + obs);
            messages.add(new Message("user", "Observation: " + obs));
        }
        return "抱歉，" + MAX_STEPS + " 步内没有得出答案。";
    }

    public static void main(String[] args) throws Exception {
        String question = args.length > 0 ? String.join(" ", args) : "东方明珠比埃菲尔铁塔高多少米？";
        System.out.println("\n答案：" + runAgent(question));
    }
}
```
:::

几个值得注意的细节：

- 回填 Observation 时用的是 `user` 角色。ReAct 文本协议里没有专门的工具角色，`user` 是最通用的选择。
- `temperature=0` 让格式更稳定，便于复现轨迹。
- Go 的 `encoding/json` 把 JSON 数字解析成 `float64`，所以计算器用类型断言 `args["a"].(float64)` 检查参数；Java 版用 Jackson 的 `isNumber()` 做同样的检查。
- Go 版截断按 rune 计数，避免把中文字符截成半个。

## 运行与测试

::: code-group
```bash [Python]
python react_agent.py "东方明珠比埃菲尔铁塔高多少米？"
```
```bash [Go]
go run . "东方明珠比埃菲尔铁塔高多少米？"
```
```bash [Java]
# 用 Maven 运行（需要 exec-maven-plugin），或在 IDE 里直接运行 main
mvn -q compile exec:java -Dexec.mainClass=ReactAgent -Dexec.args="东方明珠比埃菲尔铁塔高多少米？"
```
:::

预期输出类似下面这样（不同模型的 Thought 措辞会不同，步数也可能多一两步）：

```text
===== Step 1 =====
[Thought] 我需要先查东方明珠和埃菲尔铁塔的高度。
[Action]  search {"query": "东方明珠"}
[Observe] 东方明珠广播电视塔位于上海浦东，高约 468 米，1994 年建成。

===== Step 2 =====
[Thought] 接下来查埃菲尔铁塔的高度。
[Action]  search {"query": "埃菲尔铁塔"}
[Observe] 埃菲尔铁塔位于法国巴黎，含天线高约 330 米，1889 年建成。

===== Step 3 =====
[Thought] 用 468 减去 330。
[Action]  calculator {"op": "sub", "a": 468, "b": 330}
[Observe] 138.0

===== Step 4 =====
[Thought] 我已经知道答案了
[Final]   东方明珠比埃菲尔铁塔高约 138 米（468 米 vs 330 米）。

答案：东方明珠比埃菲尔铁塔高约 138 米（468 米 vs 330 米）。
```

建议再跑几个用例，观察 Agent 在边界情况下的表现：

| 输入 | 观察点 |
|------|--------|
| `广州塔有多高？` | 只需一次搜索，不应调用计算器 |
| `1 除以 0 等于多少？` | 计算器返回"除数不能为 0"，模型应如实告知 |
| `珠穆朗玛峰有多高？` | 搜索无结果，模型应承认查不到，而不是编造 |
| `你好` | 不需要工具，应直接给出 Final Answer |

### 离线测试解析器

解析和工具执行不依赖网络，可以单独测试。把下面的文件放在 `react_agent.py` 旁边，运行 `python -m pytest -q`（需要 `pip install pytest`）：

```python
# test_react_agent.py
from react_agent import parse, run_tool


def test_parse_action():
    text = 'Thought: 查一下\nAction: search\nAction Input: {"query": "东方明珠"}'
    assert parse(text) == ("action", "search", {"query": "东方明珠"})


def test_parse_final():
    assert parse("Thought: 好了\nFinal Answer: 138 米") == ("final", "138 米")


def test_parse_bad_json():
    kind, msg = parse("Action: search\nAction Input: {query: 东方明珠}")
    assert kind == "error" and "JSON" in msg


def test_tool_errors_do_not_raise():
    assert "除数不能为 0" in run_tool("calculator", {"op": "div", "a": 1, "b": 0})
    assert "未知工具" in run_tool("rm_rf", {})
    assert "出错" in run_tool("calculator", {"op": "add", "a": 1})  # 缺参数
```

## 扩展挑战

1. **对比原生 Tool Calling**：用 [项目 02](/projects/02-tool-agent) 的方式实现同样的两个工具，在 10 个问题上比较两种方案的成功率、步数和 Token 用量。
2. **重复动作检测**：如果模型连续两次用相同参数调用同一工具，在 Observation 里提醒它"你已经查过了，请换一个思路"。
3. **Token 预算**：从响应的 `usage` 字段累计 Token，超过预算时提前终止，并让模型基于已有信息给出最佳回答。
4. **轨迹落盘**：把每一步的 Thought / Action / Observation 以 JSON Lines 写入文件，为 [轨迹追踪与可观测性](/guide/14-evaluation/observability) 做准备。
5. **加入 Reflection**：给出 Final Answer 前，再调用一次模型检查答案是否被 Observation 支持，参考 [Reflection 自我反思](/guide/06-agent-loop/reflection)。

下一步：[项目 04 个人 PDF 知识库](/projects/04-pdf-rag) 会把"工具"换成向量检索，让 Agent 基于你自己的文档回答问题。

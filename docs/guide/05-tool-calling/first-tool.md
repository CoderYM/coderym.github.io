---
title: 实现第一个工具
description: 用 Python、Go、Java 从零实现一个可运行的 get_weather 工具调用程序：定义 Schema、执行工具、回传结果、循环直到模型给出答案。
---

# 实现第一个工具

::: info 学习目标
- 亲手写出一个完整可运行的 Tool Calling 程序（三种语言任选）
- 掌握工具调用代码的三个组成部分：工具实现、工具定义（Schema）、调用循环
- 学会用"注册表"把工具名映射到函数，并安全地解析模型给出的参数
- 能通过打印消息历史，观察一次工具调用的完整过程
:::

## 我们要做什么

做一个能回答天气问题的小助手。为了让你不需要申请任何天气 API Key 就能跑起来，`get_weather` 使用内存中的模拟数据。把它换成真实 API，只需要改函数内部，其他代码完全不变。

如果你还没读过 [工具调用原理](/guide/05-tool-calling/concept)，建议先读一遍，本文代码就是那张往返图的实现。

代码由三部分组成：

```text
┌──────────────────────┐   ┌───────────────────────────┐   ┌──────────────────────────┐
│ ① 工具实现             │   │ ② 工具定义（给模型看的）     │   │ ③ 调用循环                 │
│ get_weather(city,unit)│   │ name / description /       │   │ 请求 → 有 tool_calls?     │
│ 普通函数，返回 dict     │   │ parameters (JSON Schema)   │   │   是：执行并回传，继续      │
│                      │   │                           │   │   否：输出最终回答          │
└──────────┬───────────┘   └─────────────┬─────────────┘   └────────────┬─────────────┘
           └────────── 通过工具注册表（name → 函数）连接起来 ───────────────┘
```

## 准备环境

```bash
# .env 或直接 export，三种语言共用
OPENAI_API_KEY=sk-xxxx
OPENAI_BASE_URL=https://api.openai.com/v1   # 可选，换成 DeepSeek、通义千问等兼容地址
LLM_MODEL=gpt-4o-mini                       # 示例，换成你所用厂商支持工具调用的模型
```

- Python：`pip install openai`
- Go：只用标准库，`go run main.go`
- Java：需要 `com.fasterxml.jackson.core:jackson-databind`，用 Maven 或 Gradle 引入

::: tip 选择支持工具调用的模型
不是所有模型都支持 `tools` 参数。使用国内厂商时，请在其文档中确认模型支持 Function Calling，并使用 OpenAI 兼容接口地址。
:::

## 完整代码

::: code-group
```python [Python]
# weather_agent.py    pip install openai
import json
import os

from openai import OpenAI

# ---------- ① 工具实现：模拟数据，无需真实天气 API ----------
MOCK_WEATHER = {
    "北京": {"condition": "晴", "temp_c": 26, "humidity": 30},
    "上海": {"condition": "小雨", "temp_c": 22, "humidity": 85},
    "广州": {"condition": "多云", "temp_c": 31, "humidity": 70},
}


def get_weather(city: str, unit: str = "celsius") -> dict:
    data = MOCK_WEATHER.get(city)
    if data is None:
        return {"error": f"没有城市 {city} 的天气数据", "supported": list(MOCK_WEATHER)}
    temp = data["temp_c"] if unit == "celsius" else round(data["temp_c"] * 9 / 5 + 32, 1)
    return {"city": city, "condition": data["condition"], "temperature": temp,
            "unit": unit, "humidity": data["humidity"]}


# ---------- ② 工具定义：给模型看的说明书 ----------
TOOLS = [{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "查询指定城市当前的天气（天气状况、温度、湿度）。用户询问天气、温度、是否下雨时使用。",
        "parameters": {
            "type": "object",
            "properties": {
                "city": {"type": "string", "description": "城市中文名，如 北京、上海"},
                "unit": {"type": "string", "enum": ["celsius", "fahrenheit"],
                         "description": "温度单位，默认 celsius"},
            },
            "required": ["city"],
        },
    },
}]

# 工具注册表：模型给出的名字 → 本地函数。只有注册过的函数才能被调用
REGISTRY = {"get_weather": get_weather}


def execute_tool(name: str, arguments: str) -> str:
    """执行一次工具调用，无论成功失败都返回字符串，交给模型。"""
    func = REGISTRY.get(name)
    if func is None:
        return json.dumps({"error": f"未知工具 {name}"}, ensure_ascii=False)
    try:
        args = json.loads(arguments or "{}")
        if not isinstance(args, dict):
            raise ValueError("arguments must be a JSON object")
        result = func(**args)
    except Exception as e:  # 参数错误、执行异常都回传给模型，而不是让程序崩溃
        result = {"error": f"{type(e).__name__}: {e}"}
    return json.dumps(result, ensure_ascii=False)


# ---------- ③ 调用循环 ----------
client = OpenAI(
    api_key=os.environ["OPENAI_API_KEY"],
    base_url=os.getenv("OPENAI_BASE_URL"),
    timeout=30,
)
MODEL = os.getenv("LLM_MODEL", "gpt-4o-mini")
MAX_TURNS = 5  # 防止模型无限调用工具


def chat(user_input: str) -> str:
    messages = [
        {"role": "system", "content": "你是天气助手。天气数据必须来自工具，不要编造。"},
        {"role": "user", "content": user_input},
    ]
    for _ in range(MAX_TURNS):
        resp = client.chat.completions.create(model=MODEL, messages=messages, tools=TOOLS)
        msg = resp.choices[0].message
        # assistant 消息（含 tool_calls）必须原样加入历史
        messages.append(msg.model_dump(exclude_none=True))

        if not msg.tool_calls:
            return msg.content or ""

        for call in msg.tool_calls:
            print(f"  [调用] {call.function.name}({call.function.arguments})")
            result = execute_tool(call.function.name, call.function.arguments)
            print(f"  [结果] {result}")
            messages.append({"role": "tool", "tool_call_id": call.id, "content": result})
    return "抱歉，工具调用次数超过上限。"


if __name__ == "__main__":
    print(chat("北京和上海今天天气怎么样？需要带伞吗？"))
```
```go [Go]
// main.go    go run main.go
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"
)

// ---------- ① 工具实现：模拟数据 ----------
type weather struct {
	Condition string
	TempC     float64
	Humidity  int
}

var mockWeather = map[string]weather{
	"北京": {"晴", 26, 30},
	"上海": {"小雨", 22, 85},
	"广州": {"多云", 31, 70},
}

type weatherArgs struct {
	City string `json:"city"`
	Unit string `json:"unit"`
}

func getWeather(raw string) (any, error) {
	var a weatherArgs
	if err := json.Unmarshal([]byte(raw), &a); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	if a.City == "" {
		return nil, errors.New("city is required")
	}
	if a.Unit == "" {
		a.Unit = "celsius"
	}
	w, ok := mockWeather[a.City]
	if !ok {
		return nil, fmt.Errorf("没有城市 %s 的天气数据，支持：北京、上海、广州", a.City)
	}
	temp := w.TempC
	if a.Unit == "fahrenheit" {
		temp = w.TempC*9/5 + 32
	}
	return map[string]any{"city": a.City, "condition": w.Condition,
		"temperature": temp, "unit": a.Unit, "humidity": w.Humidity}, nil
}

// ---------- ② 工具定义 ----------
var tools = []map[string]any{{
	"type": "function",
	"function": map[string]any{
		"name":        "get_weather",
		"description": "查询指定城市当前的天气（天气状况、温度、湿度）。用户询问天气、温度、是否下雨时使用。",
		"parameters": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"city": map[string]any{"type": "string", "description": "城市中文名，如 北京、上海"},
				"unit": map[string]any{"type": "string", "enum": []string{"celsius", "fahrenheit"},
					"description": "温度单位，默认 celsius"},
			},
			"required": []string{"city"},
		},
	},
}}

// 工具注册表：参数以原始 JSON 字符串传入，由各工具自己解析和校验
var registry = map[string]func(string) (any, error){"get_weather": getWeather}

func executeTool(name, args string) string {
	fn, ok := registry[name]
	var result any
	if !ok {
		result = map[string]string{"error": "未知工具 " + name}
	} else if out, err := fn(args); err != nil {
		result = map[string]string{"error": err.Error()}
	} else {
		result = out
	}
	b, _ := json.Marshal(result)
	return string(b)
}

// ---------- 消息结构 ----------
type toolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type message struct {
	Role       string     `json:"role"`
	Content    *string    `json:"content"` // 指针：assistant 发起调用时 content 可能为 null
	ToolCalls  []toolCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
}

func text(s string) *string { return &s }

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

var httpClient = &http.Client{Timeout: 60 * time.Second}

func callLLM(messages []message) (message, error) {
	body, _ := json.Marshal(map[string]any{
		"model":    env("LLM_MODEL", "gpt-4o-mini"),
		"messages": messages,
		"tools":    tools,
	})
	url := strings.TrimRight(env("OPENAI_BASE_URL", "https://api.openai.com/v1"), "/") + "/chat/completions"
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return message{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+os.Getenv("OPENAI_API_KEY"))
	resp, err := httpClient.Do(req)
	if err != nil {
		return message{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return message{}, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	var out struct {
		Choices []struct {
			Message message `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return message{}, err
	}
	if len(out.Choices) == 0 {
		return message{}, errors.New("no choices in response")
	}
	return out.Choices[0].Message, nil
}

// ---------- ③ 调用循环 ----------
const maxTurns = 5

func chat(userInput string) (string, error) {
	messages := []message{
		{Role: "system", Content: text("你是天气助手。天气数据必须来自工具，不要编造。")},
		{Role: "user", Content: text(userInput)},
	}
	for i := 0; i < maxTurns; i++ {
		msg, err := callLLM(messages)
		if err != nil {
			return "", err
		}
		messages = append(messages, msg) // assistant 消息原样加入历史
		if len(msg.ToolCalls) == 0 {
			if msg.Content == nil {
				return "", nil
			}
			return *msg.Content, nil
		}
		for _, c := range msg.ToolCalls {
			fmt.Printf("  [调用] %s(%s)\n", c.Function.Name, c.Function.Arguments)
			result := executeTool(c.Function.Name, c.Function.Arguments)
			fmt.Printf("  [结果] %s\n", result)
			messages = append(messages, message{Role: "tool", ToolCallID: c.ID, Content: text(result)})
		}
	}
	return "抱歉，工具调用次数超过上限。", nil
}

func main() {
	answer, err := chat("北京和上海今天天气怎么样？需要带伞吗？")
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
	fmt.Println(answer)
}
```
```java [Java]
// WeatherAgent.java    依赖 com.fasterxml.jackson.core:jackson-databind
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

public class WeatherAgent {
    static final ObjectMapper MAPPER = new ObjectMapper();
    static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    static final int MAX_TURNS = 5;

    // ---------- ① 工具实现：模拟数据 ----------
    record Weather(String condition, double tempC, int humidity) {}
    record WeatherArgs(String city, String unit) {}

    static final Map<String, Weather> MOCK_WEATHER = Map.of(
            "北京", new Weather("晴", 26, 30),
            "上海", new Weather("小雨", 22, 85),
            "广州", new Weather("多云", 31, 70));

    static Object getWeather(JsonNode rawArgs) {
        WeatherArgs a = MAPPER.convertValue(rawArgs, WeatherArgs.class);
        if (a.city() == null || a.city().isBlank()) throw new IllegalArgumentException("city is required");
        String unit = a.unit() == null ? "celsius" : a.unit();
        Weather w = MOCK_WEATHER.get(a.city());
        if (w == null) throw new IllegalArgumentException("没有城市 " + a.city() + " 的天气数据，支持：北京、上海、广州");
        double temp = "fahrenheit".equals(unit) ? w.tempC() * 9 / 5 + 32 : w.tempC();
        return Map.of("city", a.city(), "condition", w.condition(),
                "temperature", temp, "unit", unit, "humidity", w.humidity());
    }

    // ---------- ② 工具定义 ----------
    static final List<Map<String, Object>> TOOLS = List.of(Map.of(
            "type", "function",
            "function", Map.of(
                    "name", "get_weather",
                    "description", "查询指定城市当前的天气（天气状况、温度、湿度）。用户询问天气、温度、是否下雨时使用。",
                    "parameters", Map.of(
                            "type", "object",
                            "properties", Map.of(
                                    "city", Map.of("type", "string", "description", "城市中文名，如 北京、上海"),
                                    "unit", Map.of("type", "string", "enum", List.of("celsius", "fahrenheit"),
                                            "description", "温度单位，默认 celsius")),
                            "required", List.of("city")))));

    // 工具注册表
    static final Map<String, Function<JsonNode, Object>> REGISTRY = Map.of("get_weather", WeatherAgent::getWeather);

    static String executeTool(String name, String arguments) {
        Object result;
        var fn = REGISTRY.get(name);
        if (fn == null) {
            result = Map.of("error", "未知工具 " + name);
        } else {
            try {
                JsonNode args = MAPPER.readTree(arguments == null || arguments.isBlank() ? "{}" : arguments);
                if (!args.isObject()) throw new IllegalArgumentException("arguments must be a JSON object");
                result = fn.apply(args);
            } catch (Exception e) { // 参数错误、执行异常都回传给模型
                result = Map.of("error", e.getClass().getSimpleName() + ": " + e.getMessage());
            }
        }
        try {
            return MAPPER.writeValueAsString(result);
        } catch (Exception e) {
            return "{\"error\":\"serialize failed\"}";
        }
    }

    static String env(String key, String def) {
        String v = System.getenv(key);
        return (v == null || v.isBlank()) ? def : v;
    }

    static JsonNode callLLM(ArrayNode messages) throws Exception {
        ObjectNode payload = MAPPER.createObjectNode();
        payload.put("model", env("LLM_MODEL", "gpt-4o-mini"));
        payload.set("messages", messages);
        payload.set("tools", MAPPER.valueToTree(TOOLS));
        String baseUrl = env("OPENAI_BASE_URL", "https://api.openai.com/v1").replaceAll("/+$", "");
        HttpRequest req = HttpRequest.newBuilder(URI.create(baseUrl + "/chat/completions"))
                .timeout(Duration.ofSeconds(60))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + System.getenv("OPENAI_API_KEY"))
                .POST(HttpRequest.BodyPublishers.ofString(MAPPER.writeValueAsString(payload)))
                .build();
        HttpResponse<String> resp = HTTP.send(req, HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() != 200) throw new IllegalStateException("HTTP " + resp.statusCode());
        JsonNode message = MAPPER.readTree(resp.body()).path("choices").path(0).path("message");
        if (message.isMissingNode()) throw new IllegalStateException("no choices in response");
        return message;
    }

    // ---------- ③ 调用循环 ----------
    static String chat(String userInput) throws Exception {
        ArrayNode messages = MAPPER.createArrayNode();
        messages.addObject().put("role", "system").put("content", "你是天气助手。天气数据必须来自工具，不要编造。");
        messages.addObject().put("role", "user").put("content", userInput);

        for (int i = 0; i < MAX_TURNS; i++) {
            JsonNode msg = callLLM(messages);
            messages.add(msg); // assistant 消息原样加入历史
            JsonNode toolCalls = msg.path("tool_calls");
            if (!toolCalls.isArray() || toolCalls.isEmpty()) {
                return msg.path("content").asText("");
            }
            for (JsonNode call : toolCalls) {
                String name = call.path("function").path("name").asText();
                String arguments = call.path("function").path("arguments").asText();
                System.out.printf("  [调用] %s(%s)%n", name, arguments);
                String result = executeTool(name, arguments);
                System.out.printf("  [结果] %s%n", result);
                messages.addObject()
                        .put("role", "tool")
                        .put("tool_call_id", call.path("id").asText())
                        .put("content", result);
            }
        }
        return "抱歉，工具调用次数超过上限。";
    }

    public static void main(String[] args) throws Exception {
        System.out.println(chat("北京和上海今天天气怎么样？需要带伞吗？"));
    }
}
```
:::

## 运行效果

输出大致如下（模型的措辞每次会有差异）：

```text
  [调用] get_weather({"city": "北京"})
  [结果] {"city": "北京", "condition": "晴", "temperature": 26, "unit": "celsius", "humidity": 30}
  [调用] get_weather({"city": "上海"})
  [结果] {"city": "上海", "condition": "小雨", "temperature": 22, "unit": "celsius", "humidity": 85}
北京今天晴，26°C，湿度 30%，不需要带伞；上海有小雨，22°C，湿度 85%，建议带伞。
```

注意模型在**一次响应**中请求了两个调用。这里我们是顺序执行的，后面的 [并行工具调用](/guide/05-tool-calling/parallel-tools) 会讲如何并发执行它们。

试试这几个输入，观察模型的不同行为：

| 输入 | 预期行为 |
|------|---------|
| "你好" | 不调用工具，直接回答 |
| "深圳天气如何？" | 调用工具，拿到错误信息后告诉用户暂无数据 |
| "北京现在多少华氏度？" | 调用时传入 `unit: "fahrenheit"` |
| "上海下雨吗？那北京呢？" | 可能一次调用两个，也可能分两轮 |

## 代码要点

**工具注册表是一道白名单。** 模型返回的 `name` 是不可信的字符串，只有在 `REGISTRY` 中注册过的函数才能执行。永远不要用 `getattr(module, name)`、反射或 `eval` 根据模型给出的名字动态调用函数。

**参数解析在工具边界完成。** `arguments` 可能是非法 JSON，可能缺字段，也可能多出意料之外的字段。Python 版本中 `func(**args)` 遇到未知参数会抛出 `TypeError`，并被转换成错误信息回传给模型。更严格的校验方式见 [工具错误处理与重试](/guide/05-tool-calling/error-handling)。

**错误也是结果。** 深圳没有数据时，我们返回 `{"error": ...}` 而不是抛异常让程序崩溃。模型读到错误后，通常能自己组织出合理的回复，比如告诉用户支持哪些城市。

**assistant 消息要原样保存。** Python 中用 `msg.model_dump(exclude_none=True)` 把 SDK 对象转成字典，Go 中直接追加反序列化得到的结构体，Java 中直接追加原始 JSON 节点。这三种做法都保证了 `tool_calls` 和其中的 `id` 被完整回传。

**循环要有上限。** `MAX_TURNS` 防止模型因为某种原因反复调用工具，把你的 Token 预算烧光。

## 常见坑

- **Go 中 content 用了 string 而不是指针。** assistant 发起调用时 `content` 通常是 `null`，用 `string` 也能反序列化，但回传时会变成 `""`。大多数厂商能接受，个别厂商对此较严格，用指针最稳妥。
- **只处理了第一个 tool_call。** 写成 `msg.tool_calls[0]`，模型一次请求两个调用时，第二个没有回传结果，下一次请求直接 400。
- **工具结果没有用 `ensure_ascii=False`。** Python 默认会把中文转义成 `\uXXXX`，模型能看懂，但调试日志很难读，也会多占一些 Token。
- **每轮都新建 HTTP 客户端。** 在循环中反复创建客户端会浪费连接，应该复用一个实例。
- **把模型换成了不支持工具调用的模型。** 有的模型会直接报错，有的会忽略 `tools` 参数然后编造天气数据。

## 小测

1. 为什么要用注册表（字典 / map）把工具名映射到函数，而不是根据名字用反射动态调用？

::: details 查看答案
模型返回的工具名是不可信输入。反射或 `getattr` 可能让模型调用到任何同名的函数或方法，造成安全问题。注册表是显式白名单，只有你允许的函数才能被调用，同时也便于统一做参数校验和日志。
:::

2. 用户问"深圳天气怎么样"，工具没有数据。为什么返回错误信息给模型，而不是直接抛异常？

::: details 查看答案
抛异常会中断整个对话，用户什么都得不到。把错误作为工具结果回传后，模型能理解发生了什么，并向用户给出有用的回复（比如"暂不支持深圳，目前支持北京、上海、广州"），甚至可以换一种方式重试。
:::

3. 如果去掉 `MAX_TURNS`，可能出现什么问题？

::: details 查看答案
如果模型由于工具反复报错或理解偏差而一直调用工具，循环将不会终止，不断消耗 Token 和时间。生产环境中还应结合 Token 预算和超时控制，见 [终止条件、步数与预算控制](/guide/06-agent-loop/stop-budget)。
:::

## 延伸阅读

- [OpenAI Function calling 指南](https://platform.openai.com/docs/guides/function-calling)
- [openai-python 仓库](https://github.com/openai/openai-python)
- 实战项目：[天气日程工具 Agent](/projects/02-tool-agent)
- 下一篇：[工具设计原则](/guide/05-tool-calling/tool-design)
:::


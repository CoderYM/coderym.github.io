---
title: 并行工具调用
description: 模型可以在一次响应中请求多个工具调用。本文讲解如何用 asyncio、goroutine 和 CompletableFuture 并发执行它们，并控制并发数与超时。
---

# 并行工具调用

::: info 学习目标
- 理解"并行工具调用"的含义：模型在一次响应中返回多个 `tool_calls`
- 能用 asyncio / goroutine / CompletableFuture 并发执行这些调用，并正确回传结果
- 掌握并发执行的三个控制点：结果顺序、并发上限、单个工具超时
- 知道什么时候不该并行，以及如何用 `parallel_tool_calls` 关闭它
:::

## 两个"并行"，别搞混

"并行工具调用"包含两层含义，它们由不同的角色负责：

| 层面 | 由谁决定 | 含义 |
|------|---------|------|
| 模型侧 | 模型 | 在**一次响应**中返回多个 `tool_calls`，而不是一次只请求一个 |
| 执行侧 | 你的代码 | 拿到多个调用后，**并发**执行它们，而不是一个接一个地执行 |

模型侧的并行省掉了 LLM 往返：查 3 个城市的天气，模型一次请求 3 个调用，比"调用、等结果、再调用"少了两次请求。执行侧的并发省掉了工具等待时间：3 个各需 1 秒的调用，顺序执行需要 3 秒，并发执行只需要约 1 秒。

在 [实现第一个工具](/guide/05-tool-calling/first-tool) 中，我们已经处理了模型侧的并行（循环遍历所有 `tool_calls`），但执行是顺序的。本文把执行改成并发。

```text
顺序执行：
  LLM ──▶ [北京 1s] ──▶ [上海 1s] ──▶ [广州 1s] ──▶ LLM        工具耗时 ≈ 3s

并发执行：
          ┌▶ [北京 1s] ┐
  LLM ──▶ ├▶ [上海 1s] ┼──▶ LLM                                工具耗时 ≈ 1s
          └▶ [广州 1s] ┘
```

## 回传规则不变

并发执行不改变消息格式。模型的那条 assistant 消息里有 N 个 `tool_calls`，你就要在它后面追加 N 条 `role: "tool"` 消息，用 `tool_call_id` 一一对应：

```json
[
  { "role": "assistant", "content": null, "tool_calls": [
      { "id": "call_a", "type": "function", "function": { "name": "get_weather", "arguments": "{\"city\":\"北京\"}" } },
      { "id": "call_b", "type": "function", "function": { "name": "get_weather", "arguments": "{\"city\":\"上海\"}" } },
      { "id": "call_c", "type": "function", "function": { "name": "get_weather", "arguments": "{\"city\":\"广州\"}" } }
  ]},
  { "role": "tool", "tool_call_id": "call_a", "content": "{\"city\":\"北京\",\"condition\":\"晴\",\"temp_c\":26}" },
  { "role": "tool", "tool_call_id": "call_b", "content": "{\"city\":\"上海\",\"condition\":\"小雨\",\"temp_c\":22}" },
  { "role": "tool", "tool_call_id": "call_c", "content": "{\"error\":\"工具 get_weather 执行超时\"}" }
]
```

API 靠 `tool_call_id` 配对，理论上 tool 消息的顺序不影响正确性。但**保持与 `tool_calls` 相同的顺序**是更稳妥的做法：日志更易读，也能避开个别兼容实现的怪癖。下面三个版本都按原顺序回传。

## 动手：并发执行多个工具调用

这个例子的 `get_weather` 会模拟 1 秒的网络延迟，方便你观察并发的效果。代码在 [实现第一个工具](/guide/05-tool-calling/first-tool) 的基础上增加了三点：

1. **并发执行**：Python 用 `asyncio.gather`，Go 用 goroutine + `sync.WaitGroup`，Java 用 `CompletableFuture`。
2. **并发上限**：Python 用 `asyncio.Semaphore`，Go 用带缓冲的 channel，Java 用固定大小的线程池。工具背后往往是有限流的外部 API，不能无限并发。
3. **单个工具超时**：一个慢工具不应该拖住整轮对话，超时就返回错误结果。

::: code-group
```python [Python]
# parallel_agent.py    pip install openai
import asyncio
import json
import os
import time

from openai import AsyncOpenAI

MOCK_WEATHER = {"北京": ("晴", 26), "上海": ("小雨", 22), "广州": ("多云", 31), "成都": ("阴", 24)}
TOOL_TIMEOUT_S = 5       # 单个工具超时
MAX_CONCURRENCY = 4      # 同时执行的工具调用上限


async def get_weather(city: str) -> dict:
    await asyncio.sleep(1)  # 模拟 1 秒网络延迟
    if city not in MOCK_WEATHER:
        return {"error": f"没有城市 {city} 的数据，支持：{'、'.join(MOCK_WEATHER)}"}
    condition, temp = MOCK_WEATHER[city]
    return {"city": city, "condition": condition, "temp_c": temp}


TOOLS = [{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "查询一个城市当前的天气。需要查询多个城市时，可以同时发起多次调用。",
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string", "description": "城市中文名"}},
            "required": ["city"],
        },
    },
}]
REGISTRY = {"get_weather": get_weather}

client = AsyncOpenAI(
    api_key=os.environ["OPENAI_API_KEY"],
    base_url=os.getenv("OPENAI_BASE_URL"),
    timeout=60,
)
MODEL = os.getenv("LLM_MODEL", "gpt-4o-mini")
semaphore = asyncio.Semaphore(MAX_CONCURRENCY)


async def execute_tool(call) -> dict:
    """执行单个调用，返回一条 tool 消息。任何异常都转成错误结果，不向外抛。"""
    name, raw_args = call.function.name, call.function.arguments
    func = REGISTRY.get(name)
    try:
        if func is None:
            raise ValueError(f"未知工具 {name}")
        args = json.loads(raw_args or "{}")
        async with semaphore:  # 限制并发数
            result = await asyncio.wait_for(func(**args), timeout=TOOL_TIMEOUT_S)
    except asyncio.TimeoutError:
        result = {"error": f"工具 {name} 执行超时（{TOOL_TIMEOUT_S}s）"}
    except Exception as e:
        result = {"error": f"{type(e).__name__}: {e}"}
    return {"role": "tool", "tool_call_id": call.id,
            "content": json.dumps(result, ensure_ascii=False)}


async def chat(user_input: str, max_turns: int = 5) -> str:
    messages = [{"role": "user", "content": user_input}]
    for _ in range(max_turns):
        resp = await client.chat.completions.create(model=MODEL, messages=messages, tools=TOOLS)
        msg = resp.choices[0].message
        messages.append(msg.model_dump(exclude_none=True))
        if not msg.tool_calls:
            return msg.content or ""

        start = time.perf_counter()
        # gather 按传入顺序返回结果，正好与 tool_calls 顺序一致
        tool_messages = await asyncio.gather(*(execute_tool(c) for c in msg.tool_calls))
        print(f"  并发执行 {len(tool_messages)} 个调用，耗时 {time.perf_counter() - start:.2f}s")
        messages.extend(tool_messages)
    return "抱歉，工具调用次数超过上限。"


if __name__ == "__main__":
    print(asyncio.run(chat("北京、上海、广州、成都今天的天气分别怎么样？")))
```
```go [Go]
// main.go    go run main.go
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	toolTimeout    = 5 * time.Second
	maxConcurrency = 4
	maxTurns       = 5
)

var mockWeather = map[string]struct {
	Condition string
	TempC     int
}{"北京": {"晴", 26}, "上海": {"小雨", 22}, "广州": {"多云", 31}, "成都": {"阴", 24}}

// 工具函数接收 context，以便响应超时取消
func getWeather(ctx context.Context, raw string) (any, error) {
	var a struct {
		City string `json:"city"`
	}
	if err := json.Unmarshal([]byte(raw), &a); err != nil || a.City == "" {
		return nil, errors.New("参数错误：需要 city 字段")
	}
	select {
	case <-time.After(1 * time.Second): // 模拟 1 秒网络延迟
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	w, ok := mockWeather[a.City]
	if !ok {
		return nil, fmt.Errorf("没有城市 %s 的数据", a.City)
	}
	return map[string]any{"city": a.City, "condition": w.Condition, "temp_c": w.TempC}, nil
}

var registry = map[string]func(context.Context, string) (any, error){"get_weather": getWeather}

var tools = []map[string]any{{
	"type": "function",
	"function": map[string]any{
		"name":        "get_weather",
		"description": "查询一个城市当前的天气。需要查询多个城市时，可以同时发起多次调用。",
		"parameters": map[string]any{
			"type":       "object",
			"properties": map[string]any{"city": map[string]any{"type": "string", "description": "城市中文名"}},
			"required":   []string{"city"},
		},
	},
}}

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
	Content    *string    `json:"content"`
	ToolCalls  []toolCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
}

func text(s string) *string { return &s }

func executeTool(ctx context.Context, c toolCall) message {
	ctx, cancel := context.WithTimeout(ctx, toolTimeout)
	defer cancel()
	var result any
	if fn, ok := registry[c.Function.Name]; !ok {
		result = map[string]string{"error": "未知工具 " + c.Function.Name}
	} else if out, err := fn(ctx, c.Function.Arguments); errors.Is(err, context.DeadlineExceeded) {
		result = map[string]string{"error": "工具执行超时"}
	} else if err != nil {
		result = map[string]string{"error": err.Error()}
	} else {
		result = out
	}
	b, _ := json.Marshal(result)
	return message{Role: "tool", ToolCallID: c.ID, Content: text(string(b))}
}

// executeAll 并发执行所有调用，结果按 tool_calls 原顺序返回
func executeAll(ctx context.Context, calls []toolCall) []message {
	results := make([]message, len(calls)) // 每个 goroutine 写自己的下标，无需加锁
	sem := make(chan struct{}, maxConcurrency)
	var wg sync.WaitGroup
	for i, c := range calls {
		wg.Add(1)
		go func(i int, c toolCall) {
			defer wg.Done()
			sem <- struct{}{}        // 获取并发名额
			defer func() { <-sem }() // 释放名额
			results[i] = executeTool(ctx, c)
		}(i, c)
	}
	wg.Wait()
	return results
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

var httpClient = &http.Client{Timeout: 60 * time.Second}

func callLLM(ctx context.Context, messages []message) (message, error) {
	body, _ := json.Marshal(map[string]any{
		"model": env("LLM_MODEL", "gpt-4o-mini"), "messages": messages, "tools": tools,
	})
	url := strings.TrimRight(env("OPENAI_BASE_URL", "https://api.openai.com/v1"), "/") + "/chat/completions"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
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
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil || len(out.Choices) == 0 {
		return message{}, fmt.Errorf("bad response: %v", err)
	}
	return out.Choices[0].Message, nil
}

func chat(ctx context.Context, userInput string) (string, error) {
	messages := []message{{Role: "user", Content: text(userInput)}}
	for i := 0; i < maxTurns; i++ {
		msg, err := callLLM(ctx, messages)
		if err != nil {
			return "", err
		}
		messages = append(messages, msg)
		if len(msg.ToolCalls) == 0 {
			if msg.Content == nil {
				return "", nil
			}
			return *msg.Content, nil
		}
		start := time.Now()
		toolMsgs := executeAll(ctx, msg.ToolCalls)
		fmt.Printf("  并发执行 %d 个调用，耗时 %.2fs\n", len(toolMsgs), time.Since(start).Seconds())
		messages = append(messages, toolMsgs...)
	}
	return "抱歉，工具调用次数超过上限。", nil
}

func main() {
	answer, err := chat(context.Background(), "北京、上海、广州、成都今天的天气分别怎么样？")
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
	fmt.Println(answer)
}
```
```java [Java]
// ParallelAgent.java    依赖 com.fasterxml.jackson.core:jackson-databind
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;

public class ParallelAgent {
    static final ObjectMapper MAPPER = new ObjectMapper();
    static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    static final int TOOL_TIMEOUT_S = 5;
    static final int MAX_CONCURRENCY = 4;
    static final int MAX_TURNS = 5;
    // 固定大小线程池同时起到"并发上限"的作用。Java 21+ 也可以用虚拟线程：
    // Executors.newVirtualThreadPerTaskExecutor()，配合 Semaphore 限制并发
    static final ExecutorService POOL = Executors.newFixedThreadPool(MAX_CONCURRENCY);

    record Weather(String condition, int tempC) {}
    static final Map<String, Weather> MOCK_WEATHER = Map.of(
            "北京", new Weather("晴", 26), "上海", new Weather("小雨", 22),
            "广州", new Weather("多云", 31), "成都", new Weather("阴", 24));

    static Object getWeather(JsonNode args) {
        String city = args.path("city").asText("");
        if (city.isBlank()) throw new IllegalArgumentException("参数错误：需要 city 字段");
        try {
            Thread.sleep(1000); // 模拟 1 秒网络延迟
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("interrupted");
        }
        Weather w = MOCK_WEATHER.get(city);
        if (w == null) throw new IllegalArgumentException("没有城市 " + city + " 的数据");
        return Map.of("city", city, "condition", w.condition(), "temp_c", w.tempC());
    }

    static final Map<String, Function<JsonNode, Object>> REGISTRY = Map.of("get_weather", ParallelAgent::getWeather);

    static final List<Map<String, Object>> TOOLS = List.of(Map.of(
            "type", "function",
            "function", Map.of(
                    "name", "get_weather",
                    "description", "查询一个城市当前的天气。需要查询多个城市时，可以同时发起多次调用。",
                    "parameters", Map.of(
                            "type", "object",
                            "properties", Map.of("city", Map.of("type", "string", "description", "城市中文名")),
                            "required", List.of("city")))));

    static String toJson(Object o) {
        try {
            return MAPPER.writeValueAsString(o);
        } catch (Exception e) {
            return "{\"error\":\"serialize failed\"}";
        }
    }

    // CompletableFuture 会把异常层层包装，取最内层的原因
    static String rootMessage(Throwable e) {
        while (e.getCause() != null) e = e.getCause();
        return String.valueOf(e.getMessage());
    }

    static String runTool(String name, String arguments) throws Exception {
        var fn = REGISTRY.get(name);
        if (fn == null) throw new IllegalArgumentException("未知工具 " + name);
        JsonNode args = MAPPER.readTree(arguments == null || arguments.isBlank() ? "{}" : arguments);
        return toJson(fn.apply(args));
    }

    static CompletableFuture<ObjectNode> executeAsync(JsonNode call) {
        String id = call.path("id").asText();
        String name = call.path("function").path("name").asText();
        String arguments = call.path("function").path("arguments").asText();
        return CompletableFuture
                .supplyAsync(() -> {
                    try {
                        return runTool(name, arguments);
                    } catch (Exception e) {
                        throw new RuntimeException(e);
                    }
                }, POOL)
                // 超时后返回错误结果（注意：底层任务不会被自动中断）
                .completeOnTimeout(toJson(Map.of("error", "工具 " + name + " 执行超时")), TOOL_TIMEOUT_S, TimeUnit.SECONDS)
                .exceptionally(e -> toJson(Map.of("error", rootMessage(e))))
                .thenApply(content -> {
                    ObjectNode msg = MAPPER.createObjectNode();
                    msg.put("role", "tool").put("tool_call_id", id).put("content", content);
                    return msg;
                });
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
        return MAPPER.readTree(resp.body()).path("choices").path(0).path("message");
    }

    static String chat(String userInput) throws Exception {
        ArrayNode messages = MAPPER.createArrayNode();
        messages.addObject().put("role", "user").put("content", userInput);
        for (int i = 0; i < MAX_TURNS; i++) {
            JsonNode msg = callLLM(messages);
            messages.add(msg);
            JsonNode toolCalls = msg.path("tool_calls");
            if (!toolCalls.isArray() || toolCalls.isEmpty()) return msg.path("content").asText("");

            long start = System.nanoTime();
            List<CompletableFuture<ObjectNode>> futures = new ArrayList<>();
            for (JsonNode call : toolCalls) futures.add(executeAsync(call));
            // 按 tool_calls 原顺序 join，保证回传顺序一致
            for (CompletableFuture<ObjectNode> f : futures) messages.add(f.join());
            System.out.printf("  并发执行 %d 个调用，耗时 %.2fs%n", futures.size(), (System.nanoTime() - start) / 1e9);
        }
        return "抱歉，工具调用次数超过上限。";
    }

    public static void main(String[] args) throws Exception {
        try {
            System.out.println(chat("北京、上海、广州、成都今天的天气分别怎么样？"));
        } finally {
            POOL.shutdown();
        }
    }
}
```
:::


运行后可以看到类似输出：

```text
  并发执行 4 个调用，耗时 1.01s
北京晴 26°C；上海小雨 22°C；广州多云 31°C；成都阴 24°C。
```

4 个各需 1 秒的调用，总耗时约 1 秒。把并发上限改成 1，耗时会变成约 4 秒，这是验证代码确实在并发执行的简单方法。

## 三个实现细节

**结果顺序。** 三个版本都保证回传顺序与 `tool_calls` 一致：`asyncio.gather` 按传入顺序返回结果；Go 版本预先分配切片，每个 goroutine 写入自己的下标；Java 版本按原顺序逐个 `join`。

**错误隔离。** 单个工具失败（参数错误、超时、异常）只影响它自己那条 tool 消息，不会让整批调用失败。Python 中 `execute_tool` 内部捕获了所有异常，所以 `gather` 不会因为一个任务失败而抛出异常。如果你的工具函数可能抛出未捕获的异常，可以使用 `gather(..., return_exceptions=True)` 作为兜底。

**超时与取消。** 不同语言的超时语义不同，值得注意：

| 语言 | 超时方式 | 超时后底层任务 |
|------|---------|--------------|
| Python | `asyncio.wait_for` | 被取消（协程收到 `CancelledError`） |
| Go | `context.WithTimeout` | 只有工具函数检查 `ctx.Done()` 才会停止 |
| Java | `completeOnTimeout` | 继续运行并占用线程，只是结果被丢弃 |

Go 的工具函数应该把 `ctx` 传给下游（如 `http.NewRequestWithContext`），这样超时才能真正中断网络请求。Java 中如果需要真正中断任务，可以改用 `ExecutorService.submit` 返回的 `Future`，超时后调用 `future.cancel(true)`。

## 什么时候不该并行

模型返回多个调用，不代表它们都适合并发执行：

- **有依赖关系的调用。** "查订单，再根据订单号查物流"，第二步依赖第一步的结果。通常模型会分两轮请求，但偶尔会在一轮中猜测参数。工具描述中写清楚依赖关系可以减少这种情况。
- **有副作用且有顺序要求的写操作。** 比如"先扣库存，再创建订单"，并发执行可能造成数据不一致。
- **共享同一个受限资源。** 外部 API 限流每秒 5 次，并发 20 个请求只会换来一堆 429 错误。

对于这些场景，可以在执行侧做区分：只读工具并发执行，写操作工具顺序执行。也可以在请求中设置 `parallel_tool_calls: false`，让模型每次最多只请求一个调用。该参数是 OpenAI 的扩展，兼容厂商的支持情况不一，API 以官方文档为准。

```text
           ┌─ 只读工具（get_weather、search_orders）──▶ 并发执行
tool_calls ┤
           └─ 写操作工具（cancel_order、send_email）──▶ 按顺序逐个执行，必要时人工确认
```

## 常见坑

- **只回传了先完成的那几个结果。** 并发执行后，必须等所有调用都结束（成功、失败或超时）再发起下一次 LLM 请求，每个 `tool_call_id` 都要有结果。
- **一个异常拖垮整批。** Python 中 `gather` 默认会在第一个异常时抛出，Java 中 `allOf().join()` 遇到异常也会抛出。每个任务都要自己处理异常。
- **在 async 函数中调用同步阻塞代码。** Python 中在协程里用 `requests.get` 或 `time.sleep`，会阻塞整个事件循环，并发就变成了顺序。用 `httpx.AsyncClient` 等异步库，或用 `asyncio.to_thread` 包装同步函数。
- **Go 中多个 goroutine 并发写同一个 map 或 slice 的 append。** 会导致数据竞争。预分配切片按下标写入，或者用 channel 收集结果。可以用 `go run -race` 检测。
- **没有并发上限。** 模型一次请求了 30 个调用，你同时发出 30 个外部请求，触发限流甚至被封禁。

## 小测

1. 模型返回了 3 个 `tool_calls`，其中一个执行超时。下一次请求应该包含几条 `role: "tool"` 消息？

::: details 查看答案
3 条。超时的那个调用也要回传一条 tool 消息，内容是超时的错误信息。缺少任何一个 `tool_call_id` 对应的结果，API 都会返回错误。
:::

2. 下面的 Python 代码为什么没有实现并发？

```python
async def get_weather(city: str) -> dict:
    time.sleep(1)
    return {"city": city}
```

::: details 查看答案
`time.sleep` 是同步阻塞调用，会阻塞整个事件循环，其他协程在此期间都无法运行。应该使用 `await asyncio.sleep(1)`；对真实的网络请求，使用异步 HTTP 库，或用 `await asyncio.to_thread(sync_func, ...)` 把同步函数放到线程中执行。
:::

3. "模型侧并行"和"执行侧并发"分别节省了什么？

::: details 查看答案
模型侧并行（一次响应返回多个调用）节省了 LLM 往返次数，减少了延迟和重复输入的 Token。执行侧并发（同时执行多个调用）节省了等待工具返回的时间，总耗时从各工具耗时之和降为最慢的那个工具的耗时。
:::

## 延伸阅读

- [OpenAI Function calling 指南](https://platform.openai.com/docs/guides/function-calling)
- [Python asyncio 文档](https://docs.python.org/3/library/asyncio-task.html)
- [Java CompletableFuture API](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/CompletableFuture.html)
- 相关：[异步与并发编程](/guide/01-programming/async)
- 下一篇：[工具错误处理与重试](/guide/05-tool-calling/error-handling)

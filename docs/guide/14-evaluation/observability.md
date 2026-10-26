---
title: 轨迹追踪与可观测性
description: 用 Trace 和 Span 记录 Agent 的每一次模型调用和工具调用，理解 OpenTelemetry 的核心概念，并用三种语言实现一个最小追踪器。
---

# 轨迹追踪与可观测性

::: info 学习目标
- 理解为什么 Agent 需要轨迹追踪，而不只是普通日志
- 掌握 Trace、Span、属性、上下文传播等 OpenTelemetry 核心概念
- 知道每个 LLM 调用和工具调用应该记录哪些字段
- 用 Python / Go / Java 实现一个最小追踪器，并了解 Langfuse、LangSmith 等工具的定位
:::

## 为什么普通日志不够

用户反馈："我问订单状态，Agent 回了一句'无法查询'。"你打开日志，看到的可能是这样：

```text
10:02:11 INFO  request received
10:02:12 INFO  calling LLM
10:02:14 INFO  calling LLM
10:02:14 INFO  tool get_order called
10:02:15 WARN  tool error
10:02:17 INFO  calling LLM
10:02:19 INFO  response sent
```

几个关键问题都回答不了：这几行是不是同一个请求？第一次模型调用的输入输出是什么？工具收到了什么参数、报了什么错？模型看到错误后是怎么决策的？哪一步最慢？

Agent 的一次请求是一棵**调用树**：一个顶层任务，下面有多轮模型调用，模型调用之间穿插工具调用，工具内部可能还有检索、子 Agent。排查问题需要看到这棵树的完整结构和每个节点的输入输出，这就是**轨迹（Trace）**。

```text
agent_run  "订单 A123 到哪了"                        4.8s
├── llm_call  #1  model=...  in=412 out=38 tok     1.9s  → tool_calls: get_order
├── tool_call get_order  {"order_id": "A123"}        0.4s  ✗ TimeoutError
├── llm_call  #2  in=480 out=25 tok                 0.6s  → tool_calls: get_order
├── tool_call get_order  {"order_id": "A123"}        0.3s  ✓
└── llm_call  #3  in=620 out=95 tok                 1.6s  → final answer
```

看到这样的轨迹，问题一目了然：第一次工具调用超时，模型重试成功。如果最终回答是"无法查询"，你能立刻看到是哪一步出的问题。

## OpenTelemetry 核心概念

[OpenTelemetry](https://opentelemetry.io/docs/)（简称 OTel）是 CNCF 下的可观测性标准，定义了 Trace、Metrics、Logs 三类数据的 API、SDK 和传输协议（OTLP）。Agent 场景最常用的是 Trace：

| 概念 | 含义 | Agent 中的对应 |
| --- | --- | --- |
| Trace | 一次完整请求的所有操作，由 `trace_id` 标识 | 一次用户提问的完整处理过程 |
| Span | 一个具体操作，有开始结束时间、父 Span | 一次 LLM 调用、一次工具调用、一次检索 |
| Attributes | Span 上的键值对 | 模型名、Token 数、工具名、参数 |
| Events | Span 内带时间戳的事件 | 首 Token 到达、重试发生 |
| Status | 成功或错误 | 工具抛异常、模型返回错误 |
| Context Propagation | 在函数、线程、服务之间传递当前 Span | 主 Agent 调用子 Agent 服务时，轨迹不断开 |
| Exporter / Collector | 把数据发送到后端存储 | 发送到 Jaeger、Langfuse 等后端 |

OTel 还在制定生成式 AI 的语义约定（GenAI semantic conventions），统一了 `gen_ai.request.model`、`gen_ai.usage.input_tokens` 这类属性名。这部分规范仍在演进中，具体字段以 [官方文档](https://opentelemetry.io/docs/specs/semconv/gen-ai/) 为准。即使自己实现追踪，属性名尽量向它靠拢，日后迁移会更容易。

## 每个 Span 记录什么

| Span 类型 | 必记字段 | 建议字段 |
| --- | --- | --- |
| `agent_run` | 用户输入、最终输出、总耗时、状态 | 用户 ID（脱敏）、会话 ID、版本号 |
| `llm_call` | 模型名、输入 / 输出 Token 数、耗时、finish_reason | 完整消息（可采样）、temperature、首 Token 延迟 |
| `tool_call` | 工具名、参数、结果摘要、耗时、是否出错 | 重试次数、下游请求 ID |
| `retrieval` | 查询、返回文档 ID 和分数 | Top-K、过滤条件 |

关于记录完整内容：提示词和回答是排查问题最有价值的数据，但也可能包含用户隐私和敏感业务信息。生产环境要做**脱敏**（手机号、身份证号等）、**截断**（超长内容只保留前后部分）和**访问控制**（不是所有人都能查看原文），必要时按比例采样记录全文。

## 动手：最小追踪器

在接入任何平台之前，先自己实现一个最小追踪器，能帮你真正理解 Trace 的工作方式。它做三件事：

1. 用"当前 Span"的上下文自动建立父子关系（Python 用 `contextvars`，Go 用 `context.Context`，Java 用 `ThreadLocal`）；
2. 记录耗时、状态、属性，异常时标记为 error；
3. Span 结束时以 JSONL 格式追加写入 `traces.jsonl`。

示例 Agent 先调用一个模拟的天气工具，再调用模型生成回答。第二次运行故意传入不存在的城市，让工具报错，观察错误如何体现在轨迹中。

::: code-group
```python [Python]
# tracing.py  依赖：pip install openai
import contextvars
import functools
import json
import os
import threading
import time
import uuid
from collections import defaultdict

from openai import OpenAI

TRACE_FILE = "traces.jsonl"
_current: contextvars.ContextVar["Span | None"] = contextvars.ContextVar("span", default=None)
_lock = threading.Lock()


def truncate(value, limit: int = 2000) -> str:
    s = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
    return s if len(s) <= limit else s[:limit] + f"...(共 {len(s)} 字符)"


class Span:
    def __init__(self, name: str, kind: str, **attrs):
        parent = _current.get()
        self.name, self.kind = name, kind
        self.trace_id = parent.trace_id if parent else uuid.uuid4().hex
        self.span_id = uuid.uuid4().hex[:16]
        self.parent_id = parent.span_id if parent else None
        self.attrs = dict(attrs)
        self.status = "ok"

    def set(self, **attrs) -> None:
        self.attrs.update(attrs)

    def __enter__(self) -> "Span":
        self.start = time.time()
        self._token = _current.set(self)
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        _current.reset(self._token)
        if exc is not None:
            self.status = "error"
            self.attrs["error"] = f"{exc_type.__name__}: {exc}"
        record = {
            "trace_id": self.trace_id, "span_id": self.span_id, "parent_id": self.parent_id,
            "name": self.name, "kind": self.kind, "start": self.start,
            "duration_ms": round((time.time() - self.start) * 1000),
            "status": self.status, "attrs": self.attrs,
        }
        with _lock, open(TRACE_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
        return False  # 不吞掉异常


def traced(kind: str):
    """装饰器：自动记录函数的输入、输出、耗时和异常。"""
    def deco(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            with Span(fn.__name__, kind, input=truncate({"args": args, "kwargs": kwargs})) as span:
                result = fn(*args, **kwargs)
                span.set(output=truncate(result))
                return result
        return wrapper
    return deco


client = OpenAI(api_key=os.environ["OPENAI_API_KEY"],
                base_url=os.getenv("OPENAI_BASE_URL") or None, timeout=60)
MODEL = os.getenv("LLM_MODEL", "gpt-4o-mini")


def chat(messages: list[dict]) -> str:
    with Span("chat", "llm", **{"gen_ai.request.model": MODEL}) as span:
        resp = client.chat.completions.create(model=MODEL, messages=messages)
        if resp.usage:
            span.set(**{"gen_ai.usage.input_tokens": resp.usage.prompt_tokens,
                        "gen_ai.usage.output_tokens": resp.usage.completion_tokens})
        span.set(finish_reason=resp.choices[0].finish_reason)
        return resp.choices[0].message.content or ""


@traced("tool")
def get_weather(city: str) -> dict:
    if city not in {"北京", "上海"}:
        raise ValueError(f"unknown city: {city}")
    return {"city": city, "weather": "晴", "temp_c": 22}


@traced("agent")
def agent_run(question: str, city: str) -> str:
    try:
        data = get_weather(city)
    except ValueError as e:
        data = {"error": str(e)}  # 工具错误作为结果交给模型处理
    return chat([
        {"role": "system", "content": "根据天气数据简短回答用户；数据有错误时如实说明。"},
        {"role": "user", "content": f"{question}\n天气数据：{json.dumps(data, ensure_ascii=False)}"},
    ])


def print_tree(path: str = TRACE_FILE) -> None:
    with open(path, encoding="utf-8") as f:
        spans = [json.loads(line) for line in f]
    children = defaultdict(list)
    for s in spans:
        children[s["parent_id"]].append(s)

    def walk(s: dict, depth: int) -> None:
        mark = "✗" if s["status"] == "error" else "✓"
        extra = s["attrs"].get("error") or s["attrs"].get("gen_ai.usage.output_tokens", "")
        print(f"{'  ' * depth}{mark} {s['kind']}:{s['name']} {s['duration_ms']}ms {extra}")
        for c in sorted(children[s["span_id"]], key=lambda x: x["start"]):
            walk(c, depth + 1)

    for root in sorted(children[None], key=lambda x: x["start"]):
        walk(root, 0)


if __name__ == "__main__":
    print(agent_run("今天适合跑步吗？", "北京"))
    print(agent_run("今天适合跑步吗？", "火星"))
    print_tree()
```
```go [Go]
// main.go  仅用标准库
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

type Span struct {
	TraceID    string         `json:"trace_id"`
	SpanID     string         `json:"span_id"`
	ParentID   string         `json:"parent_id,omitempty"`
	Name       string         `json:"name"`
	Kind       string         `json:"kind"`
	Start      time.Time      `json:"start"`
	DurationMs int64          `json:"duration_ms"`
	Status     string         `json:"status"`
	Attrs      map[string]any `json:"attrs"`
}

type spanKey struct{}

var fileMu sync.Mutex

func newID(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// StartSpan 从 ctx 中取父 Span，返回带有新 Span 的 ctx。
func StartSpan(ctx context.Context, name, kind string) (context.Context, *Span) {
	s := &Span{SpanID: newID(8), Name: name, Kind: kind, Start: time.Now(),
		Status: "ok", Attrs: map[string]any{}}
	if parent, ok := ctx.Value(spanKey{}).(*Span); ok {
		s.TraceID, s.ParentID = parent.TraceID, parent.SpanID
	} else {
		s.TraceID = newID(16)
	}
	return context.WithValue(ctx, spanKey{}, s), s
}

// End 记录耗时和错误，并追加写入 traces.jsonl。
func (s *Span) End(err error) {
	s.DurationMs = time.Since(s.Start).Milliseconds()
	if err != nil {
		s.Status = "error"
		s.Attrs["error"] = err.Error()
	}
	line, _ := json.Marshal(s)
	fileMu.Lock()
	defer fileMu.Unlock()
	f, ferr := os.OpenFile("traces.jsonl", os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if ferr != nil {
		fmt.Fprintln(os.Stderr, "trace write failed:", ferr)
		return
	}
	defer f.Close()
	f.Write(append(line, '\n'))
}

type message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

var httpClient = &http.Client{Timeout: 60 * time.Second}

func chat(ctx context.Context, messages []message) (_ string, err error) {
	model := os.Getenv("LLM_MODEL")
	if model == "" {
		model = "gpt-4o-mini"
	}
	_, span := StartSpan(ctx, "chat", "llm")
	span.Attrs["gen_ai.request.model"] = model
	defer func() { span.End(err) }()

	base := os.Getenv("OPENAI_BASE_URL")
	if base == "" {
		base = "https://api.openai.com/v1"
	}
	body, _ := json.Marshal(map[string]any{"model": model, "messages": messages})
	req, err := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(base, "/")+"/chat/completions", bytes.NewReader(body))
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
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("HTTP %d: %s", resp.StatusCode, raw)
	}
	var out struct {
		Choices []struct {
			Message      message `json:"message"`
			FinishReason string  `json:"finish_reason"`
		} `json:"choices"`
		Usage struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(raw, &out); err != nil || len(out.Choices) == 0 {
		return "", fmt.Errorf("bad response: %s", raw)
	}
	span.Attrs["gen_ai.usage.input_tokens"] = out.Usage.PromptTokens
	span.Attrs["gen_ai.usage.output_tokens"] = out.Usage.CompletionTokens
	span.Attrs["finish_reason"] = out.Choices[0].FinishReason
	return out.Choices[0].Message.Content, nil
}

func getWeather(ctx context.Context, city string) (_ map[string]any, err error) {
	_, span := StartSpan(ctx, "get_weather", "tool")
	span.Attrs["input"] = city
	defer func() { span.End(err) }()
	if city != "北京" && city != "上海" {
		return nil, fmt.Errorf("unknown city: %s", city)
	}
	result := map[string]any{"city": city, "weather": "晴", "temp_c": 22}
	span.Attrs["output"] = result
	return result, nil
}

func agentRun(ctx context.Context, question, city string) (_ string, err error) {
	ctx, span := StartSpan(ctx, "agent_run", "agent")
	span.Attrs["input"] = question
	defer func() { span.End(err) }()

	data, werr := getWeather(ctx, city)
	if werr != nil {
		data = map[string]any{"error": werr.Error()} // 工具错误作为结果交给模型处理
	}
	dataJSON, _ := json.Marshal(data)
	answer, err := chat(ctx, []message{
		{"system", "根据天气数据简短回答用户；数据有错误时如实说明。"},
		{"user", question + "\n天气数据：" + string(dataJSON)},
	})
	span.Attrs["output"] = answer
	return answer, err
}

func main() {
	ctx := context.Background()
	for _, city := range []string{"北京", "火星"} {
		answer, err := agentRun(ctx, "今天适合跑步吗？", city)
		if err != nil {
			fmt.Println("error:", err)
			continue
		}
		fmt.Println(answer)
	}
	fmt.Println("轨迹已写入 traces.jsonl")
}
```
```java [Java]
// TracingDemo.java  依赖：com.fasterxml.jackson.core:jackson-databind
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.Callable;

public class TracingDemo {

    static final ObjectMapper MAPPER = new ObjectMapper();
    static final ThreadLocal<Span> CURRENT = new ThreadLocal<>();
    static final Path TRACE_FILE = Path.of("traces.jsonl");

    /** 一个 Span；try-with-resources 结束时自动写入文件。 */
    static final class Span implements AutoCloseable {
        final String traceId, spanId, parentId, name, kind;
        final long startMs = System.currentTimeMillis();
        final Map<String, Object> attrs = new LinkedHashMap<>();
        final Span parent;
        String status = "ok";

        Span(String name, String kind) {
            this.parent = CURRENT.get();
            this.name = name;
            this.kind = kind;
            this.traceId = parent != null ? parent.traceId : UUID.randomUUID().toString().replace("-", "");
            this.spanId = UUID.randomUUID().toString().replace("-", "").substring(0, 16);
            this.parentId = parent != null ? parent.spanId : null;
            CURRENT.set(this);
        }

        Span set(String key, Object value) { attrs.put(key, value); return this; }

        void error(Exception e) {
            status = "error";
            attrs.put("error", e.getClass().getSimpleName() + ": " + e.getMessage());
        }

        @Override
        public void close() {
            if (parent != null) CURRENT.set(parent); else CURRENT.remove();
            Map<String, Object> rec = new LinkedHashMap<>();
            rec.put("trace_id", traceId);
            rec.put("span_id", spanId);
            rec.put("parent_id", parentId);
            rec.put("name", name);
            rec.put("kind", kind);
            rec.put("start", startMs);
            rec.put("duration_ms", System.currentTimeMillis() - startMs);
            rec.put("status", status);
            rec.put("attrs", attrs);
            synchronized (TracingDemo.class) {
                try {
                    Files.writeString(TRACE_FILE, MAPPER.writeValueAsString(rec) + "\n",
                            StandardCharsets.UTF_8, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
                } catch (IOException e) {
                    System.err.println("trace write failed: " + e.getMessage());
                }
            }
        }
    }

    /** 在 Span 中执行 body，异常时标记 error 后继续抛出。 */
    static <T> T traced(String name, String kind, Callable<T> body) throws Exception {
        try (Span span = new Span(name, kind)) {
            try {
                T result = body.call();
                span.set("output", String.valueOf(result));
                return result;
            } catch (Exception e) {
                span.error(e);
                throw e;
            }
        }
    }

    static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();

    static String env(String key, String def) {
        String v = System.getenv(key);
        return v == null || v.isBlank() ? def : v;
    }

    static String chat(List<Map<String, String>> messages) throws Exception {
        String model = env("LLM_MODEL", "gpt-4o-mini");
        return traced("chat", "llm", () -> {
            Span span = CURRENT.get().set("gen_ai.request.model", model);
            String base = env("OPENAI_BASE_URL", "https://api.openai.com/v1").replaceAll("/+$", "");
            String body = MAPPER.writeValueAsString(Map.of("model", model, "messages", messages));
            HttpRequest req = HttpRequest.newBuilder(URI.create(base + "/chat/completions"))
                    .timeout(Duration.ofSeconds(60))
                    .header("Content-Type", "application/json")
                    .header("Authorization", "Bearer " + System.getenv("OPENAI_API_KEY"))
                    .POST(HttpRequest.BodyPublishers.ofString(body)).build();
            HttpResponse<String> resp = HTTP.send(req, HttpResponse.BodyHandlers.ofString());
            if (resp.statusCode() != 200) {
                throw new RuntimeException("HTTP " + resp.statusCode() + ": " + resp.body());
            }
            JsonNode root = MAPPER.readTree(resp.body());
            span.set("gen_ai.usage.input_tokens", root.path("usage").path("prompt_tokens").asInt())
                .set("gen_ai.usage.output_tokens", root.path("usage").path("completion_tokens").asInt())
                .set("finish_reason", root.path("choices").path(0).path("finish_reason").asText());
            return root.path("choices").path(0).path("message").path("content").asText("");
        });
    }

    static Map<String, Object> getWeather(String city) throws Exception {
        return traced("get_weather", "tool", () -> {
            CURRENT.get().set("input", city);
            if (!Set.of("北京", "上海").contains(city)) {
                throw new IllegalArgumentException("unknown city: " + city);
            }
            return Map.<String, Object>of("city", city, "weather", "晴", "temp_c", 22);
        });
    }

    static String agentRun(String question, String city) throws Exception {
        return traced("agent_run", "agent", () -> {
            CURRENT.get().set("input", question);
            Map<String, Object> data;
            try {
                data = getWeather(city);
            } catch (IllegalArgumentException e) {
                data = Map.of("error", e.getMessage()); // 工具错误作为结果交给模型处理
            }
            return chat(List.of(
                    Map.of("role", "system", "content", "根据天气数据简短回答用户；数据有错误时如实说明。"),
                    Map.of("role", "user", "content", question + "\n天气数据：" + MAPPER.writeValueAsString(data))));
        });
    }

    public static void main(String[] args) throws Exception {
        for (String city : List.of("北京", "火星")) {
            System.out.println(agentRun("今天适合跑步吗？", city));
        }
        System.out.println("轨迹已写入 traces.jsonl");
    }
}
```
:::

Python 版本运行后，`print_tree` 会输出类似下面的树（耗时仅为示意）：

```text
✓ agent:agent_run 1530ms
  ✓ tool:get_weather 0ms
  ✓ llm:chat 1528ms 42
✓ agent:agent_run 1210ms
  ✗ tool:get_weather 0ms ValueError: unknown city: 火星
  ✓ llm:chat 1208ms 35
```

注意第二条轨迹：工具报错了，但 `agent_run` 仍然是 ✓，因为 Agent 把错误交给了模型处理。这正是轨迹的价值：只看最终状态码看不出这次请求经历过失败。

这个实现有几个已知局限，也是成熟方案要解决的问题：

- **跨线程 / 跨服务传播**。`ThreadLocal` 在线程池中不会自动传递；跨 HTTP 服务需要在请求头里传递 trace 上下文（OTel 使用 W3C `traceparent` 头）。
- **同步写文件**。高并发下应异步批量导出。
- **没有采样**。流量大时需要按比例采样，或只保留出错、慢的轨迹。

## 从手写到 OpenTelemetry 和 LLM 观测平台

生产环境建议使用 OTel SDK（Python、Go、Java 都有官方实现），它的 API 和上面的手写版本思路一致：获取 Tracer、开始 Span、设置属性、结束 Span，由 Exporter 发送到后端。好处是能和你现有的 HTTP、数据库追踪连在一起，看到从网关到模型调用的完整链路。

另一类是专门面向 LLM 应用的观测平台：

| 工具 | 定位 | 说明 |
| --- | --- | --- |
| [Langfuse](https://langfuse.com/docs) | 开源 LLM 工程平台 | 提供 Trace 查看、提示词管理、评估、成本统计等功能，可自托管；支持通过 OpenTelemetry 接入 |
| [LangSmith](https://docs.smith.langchain.com/) | LangChain 团队的商业平台 | 与 LangChain / LangGraph 集成紧密，也可用于非 LangChain 应用；提供追踪、数据集和评估 |
| [Jaeger](https://www.jaegertracing.io/) 等通用后端 | 通用分布式追踪 | 适合已有 OTel 基础设施的团队，但对提示词、Token 等 LLM 字段的展示不如专用平台 |

这些平台的具体接入方式和功能更新较快，以各自官方文档为准。选型时重点考虑：是否需要自托管（数据合规）、与现有框架的集成程度、是否同时需要评估和提示词管理功能。

## 常见坑

- **只记录最终输入输出**。中间步骤才是排查问题的关键，每次模型调用和工具调用都应该是独立的 Span。
- **不记录 Token 用量**。成本问题往往在账单出来之后才发现。每个 `llm_call` Span 都要记录输入输出 Token 数，并能按用户、功能聚合。
- **明文记录敏感信息**。用户手机号、API Key、内部文档原文写进轨迹后，查看轨迹的权限就成了数据泄露的入口。写入前脱敏，限制访问权限。
- **轨迹 ID 不和业务关联**。用户投诉时只知道会话 ID，查不到对应轨迹。应在 `agent_run` 上记录会话 ID 和请求 ID，并把 trace ID 返回给前端或写入业务日志。
- **吞掉异常**。追踪代码自己出错时不应影响业务，但也不应吞掉业务异常。上面的实现都在记录后继续抛出。

## 小测

1. 一次请求中，工具调用失败后模型重试成功，最终给出了正确回答。为什么仍然值得在轨迹中标记这次工具失败？

::: details 查看答案
因为它反映了潜在问题：工具不稳定会增加延迟和成本，失败率升高时可能导致最终失败。如果只看最终结果，这些问题不可见。按工具统计失败率是重要的运维指标。
:::

2. Python 中为什么用 `contextvars` 而不是全局变量保存当前 Span？

::: details 查看答案
全局变量在并发（多线程或 asyncio 多协程）时会被不同请求互相覆盖，导致父子关系错乱。`contextvars` 为每个线程、每个 asyncio 任务维护独立的上下文，`asyncio` 创建任务时会复制当前上下文，因此能正确传播。
:::

3. 轨迹中记录完整提示词和回答有什么好处和风险？如何平衡？

::: details 查看答案
好处是排查问题时能完整复现模型看到了什么、输出了什么。风险是包含用户隐私和敏感业务数据，存储量也大。平衡方式包括：脱敏、截断、采样记录全文、限制查看权限、设置保留期限。
:::

## 延伸阅读

- [OpenTelemetry 文档](https://opentelemetry.io/docs/)
- [OpenTelemetry GenAI 语义约定](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
- [Langfuse 文档](https://langfuse.com/docs)、[LangSmith 文档](https://docs.smith.langchain.com/)
- 本站：[部署、监控与运维](/guide/15-production/deployment)、[成本与延迟优化](/guide/15-production/cost-optimization)

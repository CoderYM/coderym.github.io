---
title: 工具错误处理与重试
description: 工具调用中的错误分为模型的错和工具的错。本文讲解参数校验、错误回传、指数退避重试、超时与失败上限，写出不会被一次异常击垮的工具层。
---

# 工具错误处理与重试

::: info 学习目标
- 能区分工具调用中的几类错误，并知道每一类由谁来处理：代码重试、模型自我修正，还是告知用户
- 掌握"把错误作为工具结果回传"的做法，并设计对模型友好的错误格式
- 用 pydantic / struct / record 严格校验模型给出的参数
- 实现带指数退避与抖动的重试、超时控制，以及循环层面的失败上限
:::

## 错误是常态

在 Demo 里，工具调用总是成功的。到了生产环境，你会遇到各种各样的失败：模型拼错工具名、参数少一个字段、日期格式不对；下游服务超时、限流、返回 503；用户要查的订单根本不存在。

一个健壮的工具层，目标不是"不出错"，而是**出错之后整个对话还能继续，并且尽可能自己恢复**。

## 错误分类与处理策略

| 错误类型 | 例子 | 谁来处理 | 处理方式 |
|---------|------|---------|---------|
| 未知工具 | 模型调用了 `get_wether` | 模型 | 回传错误并列出可用工具 |
| 参数不合法 | JSON 格式错误、缺少字段、枚举值不对 | 模型 | 回传具体的校验错误，让模型修正后重新调用 |
| 临时故障 | 超时、429 限流、503 | 代码 | 在工具层自动重试；仍失败再告诉模型 |
| 业务错误 | 订单不存在、余额不足 | 模型 / 用户 | 回传清晰的原因，由模型告知用户或换一种方式 |
| 权限错误 | 无权查看他人订单 | 用户 | 回传拒绝原因，不重试 |
| 程序 Bug | 空指针、未处理的异常 | 开发者 | 记录日志和告警；回传通用错误，不暴露堆栈 |

核心原则：**能由代码自动恢复的（临时故障），不要麻烦模型；需要改变决策的（参数错误、业务错误），交给模型；任何错误都不能让程序崩溃或让对话中断。**

LLM API 本身的错误（模型服务的限流、超时）是另一个层面的问题，处理方式见 [计费、限流与错误重试](/guide/03-llm-api/cost-errors)。

## 错误要作为结果回传

当工具执行失败时，正确的做法是仍然回传一条 `role: "tool"` 消息，内容是错误描述，而不是抛出异常中断循环。原因有三：

1. **API 要求**：每个 `tool_call_id` 都必须有对应的结果，否则下一次请求直接 400。
2. **模型能自我修正**：读到"date 必须是 YYYY-MM-DD 格式"之后，模型通常会在下一轮给出正确的参数。
3. **用户体验**：即使无法恢复，模型也能向用户解释发生了什么，而不是返回一个 500 页面。

一个对模型友好的错误格式应该包含错误类型、可读的原因，以及是否值得重试：

```json
{
  "ok": false,
  "error": {
    "type": "invalid_arguments",
    "message": "参数校验失败：unit: Input should be 'celsius' or 'fahrenheit'。请修正参数后重试。",
    "retryable": false
  }
}
```

成功时返回 `{"ok": true, "data": {...} }`。统一的结构让模型更容易分辨成功和失败，也方便你在日志中统计各类错误的比例。

## 参数校验：不要相信模型给的任何东西

模型生成的 `arguments` 和用户在表单里填的数据一样，都是**不可信输入**。即使在 Schema 中定义了类型和枚举，也要在代码里再校验一遍，原因是：

- 不是所有厂商都对工具参数做严格约束（OpenAI 的 `strict: true` 模式可以，但并非处处可用）。
- Schema 表达不了所有规则，比如"结束日期不能早于开始日期"。
- 参数会被用于查询数据库、调用外部服务，不校验就可能引发注入或越权。

校验失败时，错误信息要**具体到字段**，模型才知道改哪里。pydantic 的 `ValidationError` 天然包含字段路径和原因，Go 和 Java 需要自己组织错误信息。数据校验的更多细节见 [数据校验：pydantic / struct tag / record](/guide/01-programming/data-validation)。

## 重试：只重试该重试的

重试是把双刃剑。重试临时故障能显著提高成功率，但重试不该重试的错误只会浪费时间，甚至造成危害（比如重复扣款）。

| 应该重试 | 不应该重试 |
|---------|----------|
| 网络超时、连接被重置 | 参数错误（400） |
| 429 限流（最好遵守 `Retry-After`） | 鉴权失败、无权限（401 / 403） |
| 502 / 503 / 504 | 资源不存在（404） |
| | 非幂等的写操作（除非有幂等键） |

重试间隔使用**指数退避 + 随机抖动**：第 1 次等 0.5 秒，第 2 次等 1 秒，第 3 次等 2 秒，并在此基础上乘以一个随机系数。抖动可以避免大量客户端在同一时刻重试，再次把服务打垮。

```text
尝试1 ──✗──▶ 等 ~0.5s ──▶ 尝试2 ──✗──▶ 等 ~1s ──▶ 尝试3 ──✓──▶ 返回结果
                                                    └──✗──▶ 返回 retryable 错误给模型
```

## 动手：一个健壮的工具执行器

下面的代码实现了一个工具执行器，整合了上面所有的策略：白名单查找、严格参数校验、临时故障的指数退避重试、业务错误分类，以及统一的错误格式。为了让你不需要 API Key 就能运行，演示部分直接用几组"模型可能给出的参数"调用执行器。`get_weather` 被设计成前两次调用会遇到临时故障，用来演示重试。

::: code-group
```python [Python]
# robust_tools.py    pip install pydantic
import json
import logging
import random
import time
from typing import Callable, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("tools")


class TransientError(Exception):
    """临时故障：超时、限流、5xx，值得重试。"""


class ToolError(Exception):
    """业务错误：订单不存在、无权限等，不应重试，需要告诉模型。"""

    def __init__(self, type_: str, message: str):
        super().__init__(message)
        self.type = type_


# ---------- 工具参数模型：严格校验 ----------
class WeatherArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")  # 拒绝模型臆造的多余参数
    city: str = Field(min_length=1, max_length=20)
    unit: Literal["celsius", "fahrenheit"] = "celsius"


MOCK_WEATHER = {"北京": ("晴", 26), "上海": ("小雨", 22)}
_calls = {"n": 0}


def get_weather(args: WeatherArgs) -> dict:
    _calls["n"] += 1
    if _calls["n"] <= 2:  # 模拟：前两次调用遇到下游 503
        raise TransientError("weather service returned 503")
    if args.city not in MOCK_WEATHER:
        raise ToolError("not_found", f"没有城市 {args.city} 的数据，目前支持：{'、'.join(MOCK_WEATHER)}")
    condition, temp_c = MOCK_WEATHER[args.city]
    temp = temp_c if args.unit == "celsius" else round(temp_c * 9 / 5 + 32, 1)
    return {"city": args.city, "condition": condition, "temperature": temp, "unit": args.unit}


# 注册表：工具名 → (参数模型, 实现函数)
REGISTRY: dict[str, tuple[type[BaseModel], Callable]] = {
    "get_weather": (WeatherArgs, get_weather),
}


def with_retry(fn: Callable, *, attempts: int = 3, base_delay: float = 0.5):
    """只对 TransientError 做指数退避 + 抖动重试。"""
    for i in range(attempts):
        try:
            return fn()
        except TransientError as e:
            if i == attempts - 1:
                raise
            delay = base_delay * (2 ** i) * random.uniform(0.5, 1.5)
            log.info("transient error: %s, retry in %.2fs", e, delay)
            time.sleep(delay)


def error_result(type_: str, message: str, retryable: bool) -> str:
    return json.dumps({"ok": False, "error": {"type": type_, "message": message,
                                              "retryable": retryable}}, ensure_ascii=False)


def execute_tool(name: str, arguments: str) -> str:
    """执行一次工具调用。永远返回字符串，永远不抛异常。"""
    if name not in REGISTRY:
        return error_result("unknown_tool", f"不存在工具 {name}，可用工具：{', '.join(REGISTRY)}", False)
    model_cls, func = REGISTRY[name]

    try:  # 1. 严格校验参数（同时处理非法 JSON）
        args = model_cls.model_validate_json(arguments or "{}")
    except ValidationError as e:
        detail = "; ".join(f"{'.'.join(map(str, err['loc'])) or 'arguments'}: {err['msg']}"
                           for err in e.errors())
        return error_result("invalid_arguments", f"参数校验失败：{detail}。请修正参数后重试。", False)

    try:  # 2. 执行，临时故障自动重试
        data = with_retry(lambda: func(args))
    except TransientError as e:
        return error_result("unavailable", f"服务暂时不可用（{e}），已重试 3 次。", True)
    except ToolError as e:
        return error_result(e.type, str(e), False)
    except Exception:  # 3. 程序 Bug：完整堆栈写日志，模型只看到通用信息
        log.exception("tool %s crashed", name)
        return error_result("internal_error", "工具内部错误，请换一种方式或告知用户稍后再试。", False)
    return json.dumps({"ok": True, "data": data}, ensure_ascii=False)


if __name__ == "__main__":
    cases = [
        ("get_weather", '{"city": "北京"}'),                 # 前两次 503，第三次成功
        ("get_weather", '{"city": "北京", "unit": "K"}'),     # 枚举值不合法
        ("get_weather", '{"city": "北京", "date": "today"}'), # 多余参数
        ("get_weather", '{"city": 北京}'),                    # 非法 JSON
        ("get_weather", '{"city": "深圳"}'),                  # 业务错误
        ("get_wether", '{"city": "北京"}'),                   # 工具名拼错
    ]
    for name, raw in cases:
        print(f"{name}({raw})\n  -> {execute_tool(name, raw)}")
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
	"log"
	"math/rand/v2"
	"strings"
	"time"
)

// errTransient 标记临时故障，值得重试
var errTransient = errors.New("transient")

// ToolError 业务错误，不重试
type ToolError struct{ Type, Msg string }

func (e *ToolError) Error() string { return e.Msg }

// ---------- 工具参数：严格解码 + 手动校验 ----------
type weatherArgs struct {
	City string `json:"city"`
	Unit string `json:"unit"`
}

func (a *weatherArgs) validate() error {
	var problems []string
	if n := len([]rune(a.City)); n == 0 || n > 20 {
		problems = append(problems, "city: 必填，长度 1~20")
	}
	switch a.Unit {
	case "":
		a.Unit = "celsius"
	case "celsius", "fahrenheit":
	default:
		problems = append(problems, fmt.Sprintf("unit: 只能是 celsius 或 fahrenheit，收到 %q", a.Unit))
	}
	if len(problems) > 0 {
		return errors.New(strings.Join(problems, "; "))
	}
	return nil
}

// decodeStrict 拒绝非法 JSON 和未知字段
func decodeStrict(raw string, v any) error {
	if strings.TrimSpace(raw) == "" {
		raw = "{}"
	}
	dec := json.NewDecoder(bytes.NewReader([]byte(raw)))
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

var mockWeather = map[string]struct {
	Condition string
	TempC     float64
}{"北京": {"晴", 26}, "上海": {"小雨", 22}}

var calls int

func getWeather(ctx context.Context, raw string) (any, error) {
	var a weatherArgs
	if err := decodeStrict(raw, &a); err != nil {
		return nil, &ToolError{"invalid_arguments", "参数解析失败：" + err.Error() + "。请修正参数后重试。"}
	}
	if err := a.validate(); err != nil {
		return nil, &ToolError{"invalid_arguments", "参数校验失败：" + err.Error() + "。请修正参数后重试。"}
	}
	calls++
	if calls <= 2 { // 模拟：前两次调用遇到下游 503
		return nil, fmt.Errorf("weather service returned 503: %w", errTransient)
	}
	if err := ctx.Err(); err != nil { // 真实工具应把 ctx 传给 http.NewRequestWithContext
		return nil, fmt.Errorf("%v: %w", err, errTransient)
	}
	w, ok := mockWeather[a.City]
	if !ok {
		return nil, &ToolError{"not_found", "没有城市 " + a.City + " 的数据，目前支持：北京、上海"}
	}
	temp := w.TempC
	if a.Unit == "fahrenheit" {
		temp = w.TempC*9/5 + 32
	}
	return map[string]any{"city": a.City, "condition": w.Condition, "temperature": temp, "unit": a.Unit}, nil
}

type toolFunc func(context.Context, string) (any, error)

var registry = map[string]toolFunc{"get_weather": getWeather}

// withRetry 只重试 errTransient，每次尝试有独立超时
func withRetry(fn toolFunc, raw string, attempts int, perTry time.Duration) (any, error) {
	base := 500 * time.Millisecond
	var err error
	for i := 0; i < attempts; i++ {
		ctx, cancel := context.WithTimeout(context.Background(), perTry)
		var out any
		out, err = fn(ctx, raw)
		cancel()
		if err == nil || !errors.Is(err, errTransient) {
			return out, err
		}
		if i < attempts-1 {
			delay := time.Duration(float64(base<<i) * (0.5 + rand.Float64()))
			log.Printf("transient error: %v, retry in %v", err, delay.Round(time.Millisecond))
			time.Sleep(delay)
		}
	}
	return nil, err
}

func errorResult(typ, msg string, retryable bool) string {
	b, _ := json.Marshal(map[string]any{"ok": false,
		"error": map[string]any{"type": typ, "message": msg, "retryable": retryable}})
	return string(b)
}

// executeTool 永远返回字符串，永远不 panic
func executeTool(name, raw string) (result string) {
	defer func() {
		if r := recover(); r != nil { // 程序 Bug：记录日志，模型只看到通用信息
			log.Printf("tool %s panicked: %v", name, r)
			result = errorResult("internal_error", "工具内部错误，请换一种方式或告知用户稍后再试。", false)
		}
	}()
	fn, ok := registry[name]
	if !ok {
		return errorResult("unknown_tool", "不存在工具 "+name+"，可用工具：get_weather", false)
	}
	out, err := withRetry(fn, raw, 3, 5*time.Second)
	var te *ToolError
	switch {
	case err == nil:
		b, _ := json.Marshal(map[string]any{"ok": true, "data": out})
		return string(b)
	case errors.As(err, &te):
		return errorResult(te.Type, te.Msg, false)
	case errors.Is(err, errTransient):
		return errorResult("unavailable", "服务暂时不可用（"+err.Error()+"），已重试 3 次。", true)
	default:
		log.Printf("tool %s failed: %v", name, err)
		return errorResult("internal_error", "工具内部错误。", false)
	}
}

func main() {
	cases := [][2]string{
		{"get_weather", `{"city": "北京"}`},
		{"get_weather", `{"city": "北京", "unit": "K"}`},
		{"get_weather", `{"city": "北京", "date": "today"}`},
		{"get_weather", `{"city": 北京}`},
		{"get_weather", `{"city": "深圳"}`},
		{"get_wether", `{"city": "北京"}`},
	}
	for _, c := range cases {
		fmt.Printf("%s(%s)\n  -> %s\n", c[0], c[1], executeTool(c[0], c[1]))
	}
}
```
```java [Java]
// RobustTools.java    依赖 com.fasterxml.jackson.core:jackson-databind
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ThreadLocalRandom;
import java.util.function.Function;
import java.util.logging.Level;
import java.util.logging.Logger;

public class RobustTools {
    static final Logger LOG = Logger.getLogger("tools");
    static final ObjectMapper MAPPER = new ObjectMapper()
            .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, true); // 拒绝多余参数

    /** 临时故障：值得重试 */
    static class TransientException extends RuntimeException {
        TransientException(String msg) { super(msg); }
    }

    /** 业务错误：不重试，告诉模型 */
    static class ToolException extends RuntimeException {
        final String type;
        ToolException(String type, String msg) { super(msg); this.type = type; }
    }

    // ---------- 工具参数：record 紧凑构造器做校验 ----------
    record WeatherArgs(String city, String unit) {
        WeatherArgs {
            if (city == null || city.isBlank() || city.length() > 20)
                throw new IllegalArgumentException("city: 必填，长度 1~20");
            if (unit == null) unit = "celsius";
            if (!List.of("celsius", "fahrenheit").contains(unit))
                throw new IllegalArgumentException("unit: 只能是 celsius 或 fahrenheit，收到 " + unit);
        }
    }

    record Weather(String condition, double tempC) {}
    static final Map<String, Weather> MOCK_WEATHER = Map.of("北京", new Weather("晴", 26), "上海", new Weather("小雨", 22));
    static int calls = 0;

    static Object getWeather(WeatherArgs a) {
        calls++;
        if (calls <= 2) throw new TransientException("weather service returned 503"); // 模拟下游故障
        Weather w = MOCK_WEATHER.get(a.city());
        if (w == null) throw new ToolException("not_found", "没有城市 " + a.city() + " 的数据，目前支持：北京、上海");
        double temp = "fahrenheit".equals(a.unit()) ? w.tempC() * 9 / 5 + 32 : w.tempC();
        return Map.of("city", a.city(), "condition", w.condition(), "temperature", temp, "unit", a.unit());
    }

    /** 注册表项：参数类型 + 实现 */
    record Tool<A>(Class<A> argsType, Function<A, Object> impl) {
        Object invoke(String rawArgs) throws JsonProcessingException {
            A args = MAPPER.readValue(rawArgs == null || rawArgs.isBlank() ? "{}" : rawArgs, argsType);
            return withRetry(() -> impl.apply(args), 3);
        }
    }

    static final Map<String, Tool<?>> REGISTRY = Map.of("get_weather", new Tool<>(WeatherArgs.class, RobustTools::getWeather));

    /** 只对 TransientException 做指数退避 + 抖动重试 */
    static Object withRetry(java.util.function.Supplier<Object> fn, int attempts) {
        long baseMs = 500;
        for (int i = 0; ; i++) {
            try {
                return fn.get();
            } catch (TransientException e) {
                if (i == attempts - 1) throw e;
                long delay = (long) (baseMs * (1L << i) * ThreadLocalRandom.current().nextDouble(0.5, 1.5));
                LOG.info("transient error: " + e.getMessage() + ", retry in " + delay + "ms");
                try {
                    Thread.sleep(delay);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    throw e;
                }
            }
        }
    }

    static String toJson(Object o) {
        try {
            return MAPPER.writeValueAsString(o);
        } catch (JsonProcessingException e) {
            return "{\"ok\":false}";
        }
    }

    static String errorResult(String type, String message, boolean retryable) {
        Map<String, Object> err = new LinkedHashMap<>();
        err.put("type", type);
        err.put("message", message);
        err.put("retryable", retryable);
        return toJson(Map.of("ok", false, "error", err));
    }

    static String rootMessage(Throwable e) {
        while (e.getCause() != null) e = e.getCause();
        return e.getMessage();
    }

    /** 永远返回字符串，永远不抛异常 */
    static String executeTool(String name, String rawArgs) {
        Tool<?> tool = REGISTRY.get(name);
        if (tool == null) return errorResult("unknown_tool", "不存在工具 " + name + "，可用工具：" + REGISTRY.keySet(), false);
        try {
            return toJson(Map.of("ok", true, "data", tool.invoke(rawArgs)));
        } catch (JsonProcessingException e) { // 非法 JSON、未知字段、record 校验失败
            String reason = e.getCause() instanceof IllegalArgumentException ? rootMessage(e) : e.getOriginalMessage();
            return errorResult("invalid_arguments", "参数校验失败：" + reason + "。请修正参数后重试。", false);
        } catch (TransientException e) {
            return errorResult("unavailable", "服务暂时不可用（" + e.getMessage() + "），已重试 3 次。", true);
        } catch (ToolException e) {
            return errorResult(e.type, e.getMessage(), false);
        } catch (RuntimeException e) { // 程序 Bug：完整堆栈写日志，模型只看到通用信息
            LOG.log(Level.SEVERE, "tool " + name + " crashed", e);
            return errorResult("internal_error", "工具内部错误，请换一种方式或告知用户稍后再试。", false);
        }
    }

    public static void main(String[] args) {
        String[][] cases = {
                {"get_weather", "{\"city\": \"北京\"}"},
                {"get_weather", "{\"city\": \"北京\", \"unit\": \"K\"}"},
                {"get_weather", "{\"city\": \"北京\", \"date\": \"today\"}"},
                {"get_weather", "{\"city\": 北京}"},
                {"get_weather", "{\"city\": \"深圳\"}"},
                {"get_wether", "{\"city\": \"北京\"}"},
        };
        for (String[] c : cases) {
            System.out.printf("%s(%s)%n  -> %s%n", c[0], c[1], executeTool(c[0], c[1]));
        }
    }
}
```
:::


Python 版本的输出大致如下（Go 和 Java 版本的错误文字略有不同）：

```text
INFO transient error: weather service returned 503, retry in 0.41s
INFO transient error: weather service returned 503, retry in 1.27s
get_weather({"city": "北京"})
  -> {"ok": true, "data": {"city": "北京", "condition": "晴", "temperature": 26, "unit": "celsius"}}
get_weather({"city": "北京", "unit": "K"})
  -> {"ok": false, "error": {"type": "invalid_arguments", "message": "参数校验失败：unit: Input should be 'celsius' or 'fahrenheit'。请修正参数后重试。", "retryable": false}}
get_weather({"city": "北京", "date": "today"})
  -> {"ok": false, "error": {"type": "invalid_arguments", "message": "参数校验失败：date: Extra inputs are not permitted。请修正参数后重试。", "retryable": false}}
get_weather({"city": 北京})
  -> {"ok": false, "error": {"type": "invalid_arguments", "message": "参数校验失败：arguments: Invalid JSON: ...", "retryable": false}}
get_weather({"city": "深圳"})
  -> {"ok": false, "error": {"type": "not_found", "message": "没有城市 深圳 的数据，目前支持：北京、上海", "retryable": false}}
get_wether({"city": "北京"})
  -> {"ok": false, "error": {"type": "unknown_tool", "message": "不存在工具 get_wether，可用工具：get_weather", "retryable": false}}
```

把它接入 [实现第一个工具](/guide/05-tool-calling/first-tool) 中的调用循环，只需要用这个 `execute_tool` 替换原来的版本。循环本身不需要任何 try/except，因为执行器保证永远返回字符串。

## 超时：每一层都要有

一次工具调用涉及多个可能卡住的环节，每一层都需要超时：

| 层级 | 作用 | 示例 |
|------|------|------|
| 单次 HTTP 请求 | 防止一个连接卡死 | `httpx.Client(timeout=5)`、`http.Client{Timeout: ...}`、`HttpRequest.timeout(...)` |
| 单次工具执行（含重试） | 限制一个工具的总耗时 | `asyncio.wait_for`、`context.WithTimeout` |
| 一轮 Agent 循环 | 限制整个任务的总耗时 | 记录开始时间，超过预算就停止循环 |

注意它们的关系：单次请求超时 × 重试次数 + 退避时间，应该小于工具的总超时。否则重试还没结束，外层已经超时了。超时属于临时故障，可以重试，但要考虑总时间预算。并发执行时的超时处理见 [并行工具调用](/guide/05-tool-calling/parallel-tools)。

## 防止模型陷入失败循环

把错误交给模型修正，有时会出现另一个问题：模型反复用同样错误的参数调用同一个工具，每次都失败，直到用完最大轮数。解决方法是在循环层面统计失败次数：

```text
failures = {}                                   # 工具名 → 连续失败次数
for call in tool_calls:
    result = execute_tool(call.name, call.arguments)
    if result 表示失败:
        failures[call.name] += 1
        if failures[call.name] >= 3:
            result = 在错误信息后追加："该工具已连续失败 3 次，请停止调用它，直接告诉用户当前无法完成。"
    else:
        failures[call.name] = 0
```

再配合总轮数上限和 Token 预算（见 [终止条件、步数与预算控制](/guide/06-agent-loop/stop-budget)），就能保证 Agent 不会在错误中无限打转。

## 常见坑

- **工具抛出的异常中断了整个对话。** 循环中没有捕获异常，一次 503 就让用户看到"服务器错误"。执行器必须兜住所有异常。
- **把完整堆栈发给模型。** 堆栈既浪费 Token，又可能泄露内部路径、SQL 语句和配置信息。堆栈写日志，模型只看一句话的原因。
- **错误信息太笼统。** 返回 `"error": "invalid input"`，模型不知道哪里错了，只能瞎猜，下一次大概率还是错的。
- **重试非幂等的写操作。** "创建订单"请求超时，其实服务端已经成功了，重试会创建两个订单。写操作要么不自动重试，要么带上幂等键。
- **工具层和模型层重复重试。** 工具已经重试了 3 次，返回 `retryable: true`，模型又重试 3 次，实际请求了 9 次以上。返回给模型的错误中写明"已重试 3 次"，可以减少模型的盲目重试。
- **校验比 Schema 宽松。** Schema 里写了 `enum`，代码里却接受任意字符串，脏数据就会流入下游系统。

## 小测

1. 工具在调用下游服务时收到 404（订单不存在），应该自动重试吗？应该如何处理？

::: details 查看答案
不应该重试。404 是确定性的业务错误，重试结果不会改变。应该回传一条错误结果，例如 `{"ok": false, "error": {"type": "not_found", "message": "未找到订单 SO9999，请确认订单号", "retryable": false} }`，让模型告知用户或让用户提供正确的订单号。
:::

2. 为什么"参数校验失败"的错误要交给模型处理，而"503"要在工具层自动重试？

::: details 查看答案
参数错误是模型的决策问题，同样的参数重试一百次也会失败，只有模型修改参数才能解决，所以要把具体的校验错误告诉模型。503 是临时故障，与模型的决策无关，原样重试就有可能成功，在工具层自动处理可以节省 LLM 往返，也不会干扰模型的推理。
:::

3. 一个"发送邮件"工具调用超时了，你不知道邮件是否已经发出。应该怎么设计才安全？

::: details 查看答案
为每次发送生成一个幂等键（例如基于 `tool_call_id` 或业务 ID），下游服务据此去重，这样重试也不会重复发送。如果下游不支持幂等，就不要自动重试，而是回传"状态未知"的错误，让模型告知用户，或者先调用查询接口确认发送状态。
:::

## 延伸阅读

- [OpenAI Function calling 指南](https://platform.openai.com/docs/guides/function-calling)
- [Anthropic Tool use 文档](https://docs.anthropic.com/en/docs/build-with-claude/tool-use/overview)
- [AWS 架构博客：Exponential Backoff And Jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)
- [Pydantic 文档：Validation Errors](https://docs.pydantic.dev/latest/errors/validation_errors/)
- 下一模块：[ReAct：推理与行动](/guide/06-agent-loop/react)

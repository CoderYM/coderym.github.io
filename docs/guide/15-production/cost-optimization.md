---
title: 成本与延迟优化
description: 弄清 Agent 的成本和延迟从哪里来，用模型路由、缓存、上下文裁剪、批处理和流式输出把它们降下来，并用评估确保质量不受影响。
---

# 成本与延迟优化

::: info 学习目标
- 能拆解一次 Agent 请求的成本构成和延迟构成
- 掌握主要优化手段：模型路由、缓存、上下文裁剪、限制输出、批处理、并行与流式
- 理解"先小模型、失败再升级"的级联路由，以及缓存的适用边界
- 用 Python / Go / Java 实现一个带缓存的级联路由器
:::

## 钱和时间花在哪里

先建立直觉。以一个 5 步的 Agent 为例，每一步都要把**完整的上下文**重新发给模型：

```text
第 1 步  [系统提示 2k][工具定义 1.5k][用户问题 0.1k]                         → 输出 0.1k
第 2 步  [系统提示 2k][工具定义 1.5k][用户问题][第1步输出][工具结果 3k]         → 输出 0.1k
第 3 步  [系统提示 2k][工具定义 1.5k][...前两步全部内容...][工具结果 3k]        → 输出 0.1k
...
第 5 步  上下文已经超过 15k Token                                            → 最终回答 0.5k
```

几个结论：

1. **Agent 的输入 Token 通常远多于输出 Token**。上下文在循环中不断累积并被反复发送，总输入量随步数增长得比线性还快。
2. **步数是成本的放大器**。少一步不仅省一次调用，还省掉了之后每一步都要携带的那部分上下文。
3. **工具结果是最容易膨胀的部分**。一次网页抓取、一次数据库查询可能返回几千 Token，其中大部分与任务无关。

延迟的构成：

| 组成 | 影响因素 |
| --- | --- |
| 首 Token 延迟（TTFT） | 输入长度、模型大小、服务端负载、是否命中提示缓存 |
| 生成时间 | 输出 Token 数 ÷ 生成速度；推理模型的思考 Token 也算在内 |
| 工具执行时间 | 外部 API、数据库、网页加载 |
| 步数 | 每一步都是一次"首 Token 延迟 + 生成 + 工具"的串行累加 |

所以优化的方向很清楚：**减少步数、减少每步的输入、减少输出、用更便宜更快的模型、能并行的并行**。

## 优化手段一览

| 手段 | 降成本 | 降延迟 | 质量风险 | 说明 |
| --- | --- | --- | --- | --- |
| 模型路由 | 高 | 高 | 中 | 简单任务用小模型，复杂任务再用大模型 |
| 提示缓存（Prompt Caching） | 中~高 | 中 | 无 | 厂商对重复前缀计费更低、处理更快，见 [Prompt Caching](/guide/07-context-engineering/prompt-caching) |
| 响应缓存 | 高（命中时） | 高（命中时） | 低~中 | 相同请求直接返回缓存结果 |
| 上下文裁剪 | 中~高 | 中 | 中 | 截断工具结果、压缩历史，见 [压缩与摘要](/guide/07-context-engineering/compression) |
| 限制输出长度 | 中 | 中 | 低 | 设置 `max_tokens`，提示中要求简洁 |
| 减少步数 | 高 | 高 | 中 | 更好的工具设计、合并工具、预先提供必要信息 |
| 并行工具调用 | 无 | 高 | 无 | 互不依赖的工具同时执行，见 [并行工具调用](/guide/05-tool-calling/parallel-tools) |
| 批处理 API | 中 | 负（更慢） | 无 | 部分厂商提供异步批处理接口，以更长的完成时间换取更低的单价，适合离线任务 |
| 流式输出 | 无 | 体感高 | 无 | 总时间不变，但用户更早看到内容 |

下面展开最常用的几种。

## 模型路由

不同任务对模型能力的要求差别很大。意图分类、信息抽取、格式转换这类任务，小模型通常就能做好；多步推理、复杂代码生成才需要大模型。常见的路由方式：

| 方式 | 做法 | 优点 | 缺点 |
| --- | --- | --- | --- |
| 按任务类型静态路由 | 分类用小模型，回答生成用大模型 | 简单、可预测 | 同类任务难度不同时不够灵活 |
| 分类器路由 | 先用小模型或规则判断难度，再选择模型 | 灵活 | 分类本身有成本和误判 |
| 级联（Cascade） | 先用小模型，输出未通过校验时升级到大模型 | 只有困难样本才付大模型的钱 | 失败样本延迟增加；需要可靠的校验信号 |

级联的关键在于**校验信号是否可靠**。结构化输出能否解析、取值是否在允许范围内、工具调用参数是否合法，这些都是可靠的信号。让模型自报"置信度"则不太可靠，只能作为参考。

路由策略上线前，一定要在 [评估集](/guide/14-evaluation/eval-design) 上对比：全部用大模型、全部用小模型、使用路由，三者的质量和成本各是多少。

## 缓存

| 类型 | 原理 | 适用 | 风险 |
| --- | --- | --- | --- |
| 提示缓存 | 厂商侧缓存重复的提示前缀 | 系统提示、工具定义、长文档固定在前面 | 无质量风险；要把不变的内容放在前面 |
| 精确响应缓存 | 相同模型 + 相同消息 → 返回相同结果 | 分类、抽取、FAQ、确定性任务 | 命中率可能不高；缓存键必须包含所有影响输出的参数 |
| 语义缓存 | 用 Embedding 找相似的历史问题，返回其答案 | 高重复的 FAQ 场景 | 相似不等于相同，可能返回错误答案；需要严格阈值和评估 |
| 工具结果缓存 | 缓存外部 API 的结果 | 汇率、天气、文档检索 | 数据时效性；按数据特点设置过期时间 |

使用响应缓存时要特别注意**数据隔离**：如果消息中包含用户私有数据，缓存键必须包含用户或租户标识，否则可能把 A 用户的回答返回给 B 用户。

## 上下文裁剪

Agent 的上下文是成本的大头，裁剪往往立竿见影：

- **工具结果只返回需要的字段**。查询订单返回 5 个关键字段，而不是整条数据库记录；网页抓取返回正文摘要，而不是原始 HTML。
- **设置工具结果的长度上限**。超长时截断并告诉模型"结果已截断，共 N 条，可以用参数缩小范围"。
- **压缩历史**。较早的对话轮次和已完成的子任务替换为摘要。
- **按需加载工具**。工具很多时，每个工具的定义都要占用 Token；按任务只提供相关工具。
- **精简系统提示**。定期检查系统提示中是否有已经不再需要的规则和示例。

## 流式输出与体感延迟

对聊天类应用，用户感知的是"多久开始看到回答"，而不是"多久回答完"。流式输出让首个字在 1 秒左右出现，即使完整回答需要 10 秒，体验也明显好于等待 10 秒后一次性显示。Agent 执行工具期间，可以推送"正在查询订单…"这样的状态事件。实现方法见 [流式响应实战](/guide/03-llm-api/streaming) 和 [服务化](/guide/15-production/serving)。

## 动手：带缓存的级联路由器

任务是客服意图分类：把用户消息分到 `order`、`refund`、`shipping`、`other` 之一。流程：

1. 用 `model + messages` 的哈希查缓存，命中直接返回；
2. 先调用小模型（`SMALL_MODEL`），要求输出 JSON；
3. 校验：JSON 能解析、意图在允许列表中、模型自报置信度不低于阈值；
4. 校验失败则升级到大模型（`LARGE_MODEL`）；
5. 统计每个模型的调用次数和 Token 用量，最后打印。

`.env` 示例：`SMALL_MODEL=gpt-4o-mini`、`LARGE_MODEL=gpt-4o`（仅为示例，可换成任何兼容 OpenAI 接口的模型）。缓存只在 `temperature=0` 的确定性任务上使用，这里用进程内字典演示，生产环境一般用 Redis，并为缓存键加上租户标识。

::: code-group
```python [Python]
# router.py  依赖：pip install openai
import hashlib
import json
import os
import time
from collections import defaultdict

from openai import OpenAI

client = OpenAI(api_key=os.environ["OPENAI_API_KEY"],
                base_url=os.getenv("OPENAI_BASE_URL") or None, timeout=30)
SMALL = os.getenv("SMALL_MODEL", "gpt-4o-mini")
LARGE = os.getenv("LARGE_MODEL", "gpt-4o")
INTENTS = {"order", "refund", "shipping", "other"}
MIN_CONFIDENCE = 0.7
CACHE_TTL_S = 3600

SYSTEM = ('将用户消息分类为 order / refund / shipping / other 之一。'
          '只输出 JSON：{"intent": "...", "confidence": 0到1之间的数}')

_cache: dict[str, tuple[float, dict]] = {}
usage = defaultdict(lambda: {"calls": 0, "input_tokens": 0, "output_tokens": 0})


def cache_key(model: str, messages: list[dict]) -> str:
    raw = json.dumps({"model": model, "messages": messages}, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(raw.encode()).hexdigest()


def classify_with(model: str, text: str) -> dict | None:
    messages = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": text}]
    key = cache_key(model, messages)
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < CACHE_TTL_S:
        return {**hit[1], "cached": True}

    resp = client.chat.completions.create(model=model, messages=messages,
                                          temperature=0, max_tokens=50)
    u = usage[model]
    u["calls"] += 1
    if resp.usage:
        u["input_tokens"] += resp.usage.prompt_tokens
        u["output_tokens"] += resp.usage.completion_tokens
    try:
        data = json.loads(resp.choices[0].message.content or "")
        intent, conf = data["intent"], float(data["confidence"])
    except (json.JSONDecodeError, KeyError, TypeError, ValueError):
        return None  # 格式不合法，视为校验失败
    result = {"intent": intent, "confidence": conf, "model": model}
    if intent in INTENTS:
        _cache[key] = (time.time(), result)
    return result


def route(text: str) -> dict:
    small = classify_with(SMALL, text)
    if small and small["intent"] in INTENTS and small["confidence"] >= MIN_CONFIDENCE:
        return small
    large = classify_with(LARGE, text)  # 升级到大模型
    if large and large["intent"] in INTENTS:
        return large
    return {"intent": "other", "confidence": 0.0, "model": "fallback"}


if __name__ == "__main__":
    queries = ["我的快递到哪了", "这个耳机我想退", "订单能改地址吗，顺便问下发票怎么开",
               "我的快递到哪了"]  # 最后一条重复，应命中缓存
    for q in queries:
        print(q, "->", route(q))
    for model, u in usage.items():
        print(f"{model}: {u}")
```
```go [Go]
// main.go  仅用标准库
package main

import (
	"bytes"
	"crypto/sha256"
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

const (
	minConfidence = 0.7
	cacheTTL      = time.Hour
	systemPrompt  = `将用户消息分类为 order / refund / shipping / other 之一。只输出 JSON：{"intent": "...", "confidence": 0到1之间的数}`
)

var intents = map[string]bool{"order": true, "refund": true, "shipping": true, "other": true}

type message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type Result struct {
	Intent     string  `json:"intent"`
	Confidence float64 `json:"confidence"`
	Model      string  `json:"model"`
	Cached     bool    `json:"cached"`
}

type Usage struct{ Calls, InputTokens, OutputTokens int }

type cacheEntry struct {
	at     time.Time
	result Result
}

var (
	mu         sync.Mutex
	cache      = map[string]cacheEntry{}
	usage      = map[string]*Usage{}
	httpClient = &http.Client{Timeout: 30 * time.Second}
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func cacheKey(model string, msgs []message) string {
	raw, _ := json.Marshal(map[string]any{"model": model, "messages": msgs})
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func classifyWith(model, text string) (*Result, error) {
	msgs := []message{{"system", systemPrompt}, {"user", text}}
	key := cacheKey(model, msgs)
	mu.Lock()
	if e, ok := cache[key]; ok && time.Since(e.at) < cacheTTL {
		mu.Unlock()
		r := e.result
		r.Cached = true
		return &r, nil
	}
	mu.Unlock()

	body, _ := json.Marshal(map[string]any{"model": model, "messages": msgs, "temperature": 0, "max_tokens": 50})
	base := strings.TrimRight(env("OPENAI_BASE_URL", "https://api.openai.com/v1"), "/")
	req, err := http.NewRequest("POST", base+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+os.Getenv("OPENAI_API_KEY"))
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, raw)
	}
	var out struct {
		Choices []struct {
			Message message `json:"message"`
		} `json:"choices"`
		Usage struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(raw, &out); err != nil || len(out.Choices) == 0 {
		return nil, fmt.Errorf("bad response: %s", raw)
	}
	mu.Lock()
	u := usage[model]
	if u == nil {
		u = &Usage{}
		usage[model] = u
	}
	u.Calls++
	u.InputTokens += out.Usage.PromptTokens
	u.OutputTokens += out.Usage.CompletionTokens
	mu.Unlock()

	var r Result
	if err := json.Unmarshal([]byte(out.Choices[0].Message.Content), &r); err != nil {
		return nil, nil // 格式不合法，视为校验失败
	}
	r.Model = model
	if intents[r.Intent] {
		mu.Lock()
		cache[key] = cacheEntry{time.Now(), r}
		mu.Unlock()
	}
	return &r, nil
}

func route(text string) Result {
	small, err := classifyWith(env("SMALL_MODEL", "gpt-4o-mini"), text)
	if err == nil && small != nil && intents[small.Intent] && small.Confidence >= minConfidence {
		return *small
	}
	large, err := classifyWith(env("LARGE_MODEL", "gpt-4o"), text) // 升级到大模型
	if err == nil && large != nil && intents[large.Intent] {
		return *large
	}
	return Result{Intent: "other", Model: "fallback"}
}

func main() {
	queries := []string{"我的快递到哪了", "这个耳机我想退", "订单能改地址吗，顺便问下发票怎么开",
		"我的快递到哪了"} // 最后一条重复，应命中缓存
	for _, q := range queries {
		fmt.Printf("%s -> %+v\n", q, route(q))
	}
	for model, u := range usage {
		fmt.Printf("%s: %+v\n", model, *u)
	}
}
```
```java [Java]
// Router.java  依赖：com.fasterxml.jackson.core:jackson-databind
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

public class Router {

    record Result(String intent, double confidence, String model, boolean cached) {}
    record CacheEntry(long atMs, Result result) {}

    static final Set<String> INTENTS = Set.of("order", "refund", "shipping", "other");
    static final double MIN_CONFIDENCE = 0.7;
    static final long CACHE_TTL_MS = 3_600_000;
    static final String SYSTEM = "将用户消息分类为 order / refund / shipping / other 之一。"
            + "只输出 JSON：{\"intent\": \"...\", \"confidence\": 0到1之间的数}";

    static final ObjectMapper MAPPER = new ObjectMapper();
    static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    static final Map<String, CacheEntry> CACHE = new ConcurrentHashMap<>();
    // 每个模型：[调用次数, 输入 Token, 输出 Token]
    static final Map<String, AtomicLong[]> USAGE = new ConcurrentHashMap<>();

    static String env(String key, String def) {
        String v = System.getenv(key);
        return v == null || v.isBlank() ? def : v;
    }

    static String cacheKey(String model, List<Map<String, String>> messages) throws Exception {
        byte[] raw = MAPPER.writeValueAsBytes(Map.of("model", model, "messages", messages));
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(raw));
    }

    static Result classifyWith(String model, String text) throws Exception {
        List<Map<String, String>> messages = List.of(
                Map.of("role", "system", "content", SYSTEM), Map.of("role", "user", "content", text));
        String key = cacheKey(model, messages);
        CacheEntry hit = CACHE.get(key);
        if (hit != null && System.currentTimeMillis() - hit.atMs() < CACHE_TTL_MS) {
            Result r = hit.result();
            return new Result(r.intent(), r.confidence(), r.model(), true);
        }

        String body = MAPPER.writeValueAsString(Map.of(
                "model", model, "messages", messages, "temperature", 0, "max_tokens", 50));
        String base = env("OPENAI_BASE_URL", "https://api.openai.com/v1").replaceAll("/+$", "");
        HttpRequest req = HttpRequest.newBuilder(URI.create(base + "/chat/completions"))
                .timeout(Duration.ofSeconds(30))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + System.getenv("OPENAI_API_KEY"))
                .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8)).build();
        HttpResponse<String> resp = HTTP.send(req, HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() != 200) {
            throw new RuntimeException("HTTP " + resp.statusCode() + ": " + resp.body());
        }
        JsonNode root = MAPPER.readTree(resp.body());
        AtomicLong[] u = USAGE.computeIfAbsent(model,
                k -> new AtomicLong[]{new AtomicLong(), new AtomicLong(), new AtomicLong()});
        u[0].incrementAndGet();
        u[1].addAndGet(root.path("usage").path("prompt_tokens").asLong());
        u[2].addAndGet(root.path("usage").path("completion_tokens").asLong());

        JsonNode data;
        try {
            data = MAPPER.readTree(root.path("choices").path(0).path("message").path("content").asText(""));
        } catch (Exception e) {
            return null; // 格式不合法，视为校验失败
        }
        if (data == null || !data.path("confidence").isNumber()) return null;
        Result r = new Result(data.path("intent").asText(""), data.path("confidence").asDouble(), model, false);
        if (INTENTS.contains(r.intent())) CACHE.put(key, new CacheEntry(System.currentTimeMillis(), r));
        return r;
    }

    static Result route(String text) {
        try {
            Result small = classifyWith(env("SMALL_MODEL", "gpt-4o-mini"), text);
            if (small != null && INTENTS.contains(small.intent()) && small.confidence() >= MIN_CONFIDENCE) {
                return small;
            }
        } catch (Exception e) {
            System.err.println("small model failed: " + e.getMessage());
        }
        try {
            Result large = classifyWith(env("LARGE_MODEL", "gpt-4o"), text); // 升级到大模型
            if (large != null && INTENTS.contains(large.intent())) return large;
        } catch (Exception e) {
            System.err.println("large model failed: " + e.getMessage());
        }
        return new Result("other", 0, "fallback", false);
    }

    public static void main(String[] args) {
        List<String> queries = List.of("我的快递到哪了", "这个耳机我想退", "订单能改地址吗，顺便问下发票怎么开",
                "我的快递到哪了"); // 最后一条重复，应命中缓存
        for (String q : queries) System.out.println(q + " -> " + route(q));
        USAGE.forEach((model, u) -> System.out.printf("%s: calls=%d input=%d output=%d%n",
                model, u[0].get(), u[1].get(), u[2].get()));
    }
}
```
:::

运行后你会看到：前两条简单问题大概率由小模型处理；第三条包含多个意图，小模型可能给出较低置信度，从而升级到大模型；最后一条重复问题命中缓存，不产生调用。把这个路由器放到评估集上跑，就能得到"质量 vs 成本"的对比数据。

## 先测量，再优化

优化之前，先在 [轨迹](/guide/14-evaluation/observability) 中按请求统计这几个数字：

- 每次请求的平均输入 Token、输出 Token、步数；
- 上下文中各部分（系统提示、工具定义、历史、工具结果）的占比；
- 各步骤的耗时分布，P50 和 P95；
- 缓存命中率。

找到最大的那一块再动手。常见的情况是，工具结果占了一半以上的输入 Token，这时裁剪工具结果比换模型更有效。每做一项优化，都要在评估集上确认质量没有下降。

## 常见坑

- **只看单价不看总量**。小模型单价低，但如果它需要更多步骤、更多重试才能完成任务，总成本可能反而更高。比较的是"完成一个任务"的成本。
- **缓存键不完整**。缓存键漏掉了模型名、温度、工具定义或用户标识，导致返回不该返回的结果，甚至跨用户泄露数据。
- **对非确定性任务做响应缓存**。创作类、需要实时数据的请求不适合缓存。
- **裁剪丢掉了关键信息**。为了省 Token 截断工具结果，模型因为缺信息反复调用工具，成本更高。裁剪要配合评估。
- **级联的校验信号不可靠**。完全依赖模型自报的置信度来决定是否升级，小模型可能"自信地答错"。尽量使用可验证的信号。
- **没有预算上限**。单个请求因为循环失控消耗大量 Token。每个请求要设置步数和 Token 上限，见 [终止条件、步数与预算控制](/guide/06-agent-loop/stop-budget)。

## 小测

1. 一个 Agent 平均每次请求 8 步，输入 Token 是输出 Token 的 30 倍。你会优先从哪里入手降成本？

::: details 查看答案
优先减少输入 Token 和步数：检查上下文构成，裁剪工具结果、压缩历史、按需加载工具定义；把系统提示和工具定义放在前面以命中提示缓存；通过改进工具设计减少步数。限制输出长度的收益相对较小，因为输出只占很小一部分。
:::

2. 在多租户 SaaS 中为 Agent 加响应缓存，缓存键至少应该包含哪些内容？

::: details 查看答案
至少包含：模型名、完整消息（含系统提示）、影响输出的参数（温度、max_tokens、工具定义等）、租户或用户标识（当消息涉及私有数据时）。另外要设置过期时间，并只对确定性任务启用。
:::

3. 流式输出能降低成本吗？它解决的是什么问题？

::: details 查看答案
不能降低成本，生成的 Token 数量不变，总耗时也基本不变。它解决的是体感延迟：用户在首 Token 到达时就能开始阅读，不必等待完整回答生成。
:::

## 延伸阅读

- [OpenAI Prompt Caching 指南](https://platform.openai.com/docs/guides/prompt-caching)
- [Anthropic Prompt Caching 文档](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)
- [FrugalGPT（arXiv）](https://arxiv.org/abs/2305.05176)：关于 LLM 级联降低成本的研究
- 本站：[Prompt Caching](/guide/07-context-engineering/prompt-caching)、[计费、限流与错误重试](/guide/03-llm-api/cost-errors)、[如何选择模型](/guide/02-llm-basics/choosing-models)

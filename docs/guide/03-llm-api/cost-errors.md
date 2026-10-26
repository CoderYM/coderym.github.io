---
title: 计费、限流与错误重试
description: 理解大模型 API 的计费与限流规则，按错误类型决定是否重试，并用三种语言实现带抖动的指数退避与超时控制。
---

# 计费、限流与错误重试

::: info 学习目标
- 理解按 Token 计费的构成，学会估算和记录每次调用的成本
- 理解 RPM、TPM 等限流维度，以及 429 错误的含义
- 能区分哪些错误应该重试、哪些不应该
- 用 Python、Go、Java 实现"指数退避 + 随机抖动 + 超时"的重试逻辑
:::

Demo 阶段，调用失败了重新运行一下就好。到了生产环境，限流、超时、服务端偶发错误每天都会发生，Agent 一次任务可能要调用模型几十次，任何一次失败都可能导致整个任务失败。本文讲清楚这些问题的成因和标准处理方法。

## 计费：钱花在哪里

大模型 API 基本都按 Token 计费，具体单价各家不同且经常调整，以官方价格页为准。计费的结构大致如下：

```text
单次费用 = 输入 Token × 输入单价
         + 输出 Token × 输出单价（通常明显高于输入单价）
         - 命中缓存的输入 Token × 缓存折扣（如果厂商支持）
```

| 计费项 | 说明 |
| --- | --- |
| 输入 Token | system、历史、工具定义、检索文档、图片等全部输入 |
| 输出 Token | 回答内容；推理模型还包括推理 Token |
| 缓存命中 | 重复的前缀可以享受折扣，见 [Prompt Caching](/guide/07-context-engineering/prompt-caching) |
| 批处理 | 部分厂商提供异步批处理接口，价格更低但不保证实时 |
| 其他 | 联网搜索、代码执行等内置工具可能单独计费 |

Agent 的成本特点是**输入 Token 占大头**：每轮都要重发全部历史和工具定义。所以控制成本的重点通常在上下文管理，而不是缩短回答。

**一定要记录每次调用的用量**。建议的最小日志字段：请求 ID、模型名、输入 Token、输出 Token、缓存 Token、耗时、状态码、业务标识（用户、会话、任务）。有了这些数据，才能回答"哪个功能最费钱""某个用户是否在滥用"这类问题。单价建议放在配置里，按模型计算费用，不要写死在代码中。更多优化手段见 [成本与延迟优化](/guide/15-production/cost-optimization)。

## 限流：为什么会收到 429

厂商会从多个维度限制调用频率，具体额度与账户等级相关：

| 维度 | 含义 |
| --- | --- |
| RPM | Requests Per Minute，每分钟请求数 |
| TPM | Tokens Per Minute，每分钟 Token 数（输入 + 输出，计算方式因厂商而异） |
| RPD / TPD | 每天的请求数或 Token 数 |
| 并发数 | 同时进行中的请求数 |

触发任何一个限制，都会返回 HTTP **429 Too Many Requests**。部分厂商会在响应头中给出提示，例如 `Retry-After`（建议等待的秒数）或 `x-ratelimit-remaining-requests` 一类的剩余额度信息，具体头部名称以厂商文档为准。

需要注意，429 不一定都是"太快了"。例如 OpenAI 在**余额不足**时也返回 429，错误类型为 `insufficient_quota`。这种情况重试多少次都没用，应该直接报警。

## 错误分类：哪些该重试

| 错误 | 典型原因 | 是否重试 |
| --- | --- | --- |
| 400 Bad Request | 参数错误、超出上下文窗口、消息格式不对 | 否，修正请求 |
| 401 / 403 | Key 错误、过期、无权限 | 否，检查配置 |
| 404 | 模型名或 URL 错误 | 否 |
| 422 | 请求格式合法但语义不对 | 否 |
| 408 / 请求超时 | 网络慢、模型生成时间长 | 是 |
| 429（限流） | 超出 RPM、TPM | 是，优先遵循 `Retry-After` |
| 429（余额不足） | 账户额度用完 | 否，报警 |
| 500 / 502 / 503 / 504 | 服务端故障、网关错误、过载 | 是 |
| 529 | Anthropic 的"服务过载" | 是 |
| 连接错误 | DNS 失败、连接被重置 | 是 |

原则很简单：**客户端的错（4xx，除 408、429 外）不重试，临时性的错（429、5xx、网络问题）才重试**。对不该重试的错误反复重试，只会浪费时间并放大问题。

## 指数退避与随机抖动

重试不能"失败了立刻再来"。如果服务已经过载，大量客户端同时立即重试只会让情况更糟。标准做法是**指数退避**（exponential backoff）：每次失败后等待的时间翻倍，并设置上限。

只做指数退避还不够。假设 100 个客户端在同一时刻被限流，它们会在同一时刻等待 1 秒、2 秒、4 秒后一起重试，形成一波又一波的请求洪峰。解决办法是加入**随机抖动**（jitter），让重试时间分散开：

```text
无抖动（所有客户端同步重试）：
  t=1s  ████████████  t=2s  ████████████  t=4s  ████████████

全抖动 Full Jitter（等待时间 = random(0, min(上限, 基础 × 2^n))）：
  t=0~1s ██ █ ███ █ ██   t=0~2s █ ██ █ █ ██ █   t=0~4s █ █ ██ █ █ █
```

本文代码使用 Full Jitter 策略，并遵循三条规则：

1. 服务端返回了 `Retry-After` 时，优先按它等待（同样设置上限）。
2. 限制最大重试次数（例如 5 次）和单次最长等待（例如 30 秒）。
3. 设置**总时间预算**，超出就放弃，避免一个请求在重试中卡住几分钟。

超时也要分开考虑：**单次请求超时**防止一次调用挂起，**总预算**防止重试拖得太久。两者缺一不可。

## 动手：带重试的调用

Python 的 `openai` SDK **自带重试**：默认会对连接错误、408、409、429 和 5xx 自动重试 2 次，并带有退避，可以通过 `max_retries` 参数调整。大多数情况下，直接配置 SDK 就够了：

```python
client = OpenAI(max_retries=5, timeout=60)  # SDK 内置退避重试
```

如果需要自定义策略（例如识别余额不足、记录每次重试、控制总预算），可以把 SDK 的重试关掉，自己实现。下面三个版本的逻辑相同：最多尝试 5 次，单次超时 60 秒，总预算 120 秒，只重试临时性错误。

::: code-group
```python [Python]
import os
import random
import time

import openai
from openai import OpenAI

MAX_ATTEMPTS = 5
BASE_DELAY = 1.0   # 秒
MAX_DELAY = 30.0   # 单次最长等待
TOTAL_BUDGET = 120.0
RETRYABLE_STATUS = {408, 429, 500, 502, 503, 504, 529}

# 关闭 SDK 内置重试，避免与自定义重试叠加
client = OpenAI(
    api_key=os.environ["OPENAI_API_KEY"],
    base_url=os.getenv("OPENAI_BASE_URL") or None,
    timeout=60,
    max_retries=0,
)


def backoff_delay(attempt: int, retry_after: str | None) -> float:
    if retry_after:
        try:
            return min(float(retry_after), MAX_DELAY)
        except ValueError:
            pass  # Retry-After 也可能是 HTTP 日期格式，这里简化为回退到退避
    return random.uniform(0, min(MAX_DELAY, BASE_DELAY * 2**attempt))  # Full Jitter


def chat_with_retry(messages: list[dict]) -> str:
    deadline = time.monotonic() + TOTAL_BUDGET
    for attempt in range(MAX_ATTEMPTS):
        retry_after = None
        try:
            resp = client.chat.completions.create(
                model=os.getenv("LLM_MODEL", "gpt-4o-mini"), messages=messages
            )
            return resp.choices[0].message.content or ""
        except (openai.APITimeoutError, openai.APIConnectionError) as e:
            err = e  # 超时和网络错误：可重试
        except openai.APIStatusError as e:
            if e.status_code not in RETRYABLE_STATUS:
                raise  # 400/401/404 等：重试没有意义
            if getattr(e, "code", None) == "insufficient_quota":
                raise  # 余额不足，不重试
            err = e
            retry_after = e.response.headers.get("retry-after")

        if attempt == MAX_ATTEMPTS - 1:
            raise err
        delay = backoff_delay(attempt, retry_after)
        if time.monotonic() + delay > deadline:
            raise TimeoutError("超出重试总预算") from err
        print(f"第 {attempt + 1} 次失败（{type(err).__name__}），{delay:.1f}s 后重试")
        time.sleep(delay)
    raise RuntimeError("unreachable")


if __name__ == "__main__":
    print(chat_with_retry([{"role": "user", "content": "你好"}]))
```

```go [Go]
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/rand/v2"
	"net/http"
	"os"
	"strconv"
	"time"
)

const (
	maxAttempts = 5
	baseDelay   = time.Second
	maxDelay    = 30 * time.Second
	totalBudget = 120 * time.Second
)

type message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatRequest struct {
	Model    string    `json:"model"`
	Messages []message `json:"messages"`
}

type chatResponse struct {
	Choices []struct {
		Message message `json:"message"`
	} `json:"choices"`
}

// statusError 记录 HTTP 错误，便于判断是否可重试
type statusError struct {
	code       int
	body       string
	retryAfter string
}

func (e *statusError) Error() string { return fmt.Sprintf("HTTP %d: %s", e.code, e.body) }

var httpClient = &http.Client{Timeout: 60 * time.Second} // 单次请求超时

func retryable(err error) bool {
	var se *statusError
	if errors.As(err, &se) {
		switch se.code {
		case 408, 429, 500, 502, 503, 504, 529:
			return !bytes.Contains([]byte(se.body), []byte("insufficient_quota"))
		}
		return false
	}
	return true // 网络错误、超时等
}

func backoff(attempt int, err error) time.Duration {
	var se *statusError
	if errors.As(err, &se) && se.retryAfter != "" {
		if secs, perr := strconv.ParseFloat(se.retryAfter, 64); perr == nil && secs >= 0 {
			return min(time.Duration(secs*float64(time.Second)), maxDelay)
		}
	}
	ceiling := min(baseDelay<<attempt, maxDelay)
	return rand.N(ceiling + 1) // Full Jitter: [0, ceiling]
}

func doOnce(ctx context.Context, url, apiKey string, payload []byte) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 10<<20))
	if err != nil {
		return "", err
	}
	if resp.StatusCode != http.StatusOK {
		return "", &statusError{resp.StatusCode, string(body), resp.Header.Get("Retry-After")}
	}
	var out chatResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return "", err
	}
	if len(out.Choices) == 0 {
		return "", errors.New("empty choices")
	}
	return out.Choices[0].Message.Content, nil
}

func chatWithRetry(ctx context.Context, url, apiKey string, req chatRequest) (string, error) {
	payload, err := json.Marshal(req)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(ctx, totalBudget) // 总预算
	defer cancel()

	for attempt := 0; ; attempt++ {
		text, err := doOnce(ctx, url, apiKey, payload)
		if err == nil {
			return text, nil
		}
		if !retryable(err) || attempt == maxAttempts-1 || ctx.Err() != nil {
			return "", err
		}
		delay := backoff(attempt, err)
		if dl, ok := ctx.Deadline(); ok && time.Now().Add(delay).After(dl) {
			return "", fmt.Errorf("超出重试总预算: %w", err)
		}
		log.Printf("第 %d 次失败（%v），%.1fs 后重试", attempt+1, err, delay.Seconds())
		select {
		case <-time.After(delay):
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
}

func main() {
	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" {
		log.Fatal("请设置 OPENAI_API_KEY")
	}
	baseURL := os.Getenv("OPENAI_BASE_URL")
	if baseURL == "" {
		baseURL = "https://api.openai.com/v1"
	}
	model := os.Getenv("LLM_MODEL")
	if model == "" {
		model = "gpt-4o-mini"
	}
	text, err := chatWithRetry(context.Background(), baseURL+"/chat/completions", apiKey, chatRequest{
		Model:    model,
		Messages: []message{{Role: "user", Content: "你好"}},
	})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(text)
}
```

```java [Java]
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.time.Duration;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ThreadLocalRandom;

public class RetryDemo {
    static final int MAX_ATTEMPTS = 5;
    static final long BASE_DELAY_MS = 1_000;
    static final long MAX_DELAY_MS = 30_000;
    static final long TOTAL_BUDGET_MS = 120_000;
    static final Set<Integer> RETRYABLE = Set.of(408, 429, 500, 502, 503, 504, 529);

    static final ObjectMapper MAPPER = new ObjectMapper();
    static final HttpClient HTTP = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10)).build();

    record Message(String role, String content) {}

    record ChatRequest(String model, List<Message> messages) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    record Choice(Message message) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    record ChatResponse(List<Choice> choices) {}

    /** HTTP 状态错误，携带是否可重试和 Retry-After 信息。 */
    static class ApiException extends RuntimeException {
        final int status;
        final String retryAfter;

        ApiException(int status, String body, String retryAfter) {
            super("HTTP " + status + ": " + body);
            this.status = status;
            this.retryAfter = retryAfter;
        }

        boolean retryable() {
            return RETRYABLE.contains(status) && !getMessage().contains("insufficient_quota");
        }
    }

    static long backoffMillis(int attempt, String retryAfter) {
        if (retryAfter != null) {
            try {
                return Math.min((long) (Double.parseDouble(retryAfter) * 1000), MAX_DELAY_MS);
            } catch (NumberFormatException ignored) {
                // 也可能是 HTTP 日期格式，这里简化为回退到指数退避
            }
        }
        long ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS << attempt);
        return ThreadLocalRandom.current().nextLong(ceiling + 1); // Full Jitter
    }

    static String doOnce(String url, String apiKey, String payload) throws IOException, InterruptedException {
        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .timeout(Duration.ofSeconds(60)) // 单次请求超时
                .header("Authorization", "Bearer " + apiKey)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(payload))
                .build();
        HttpResponse<String> resp = HTTP.send(req, HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() != 200) {
            throw new ApiException(resp.statusCode(), resp.body(),
                    resp.headers().firstValue("retry-after").orElse(null));
        }
        ChatResponse out = MAPPER.readValue(resp.body(), ChatResponse.class);
        if (out.choices() == null || out.choices().isEmpty()) {
            throw new IOException("empty choices");
        }
        return out.choices().get(0).message().content();
    }

    static String chatWithRetry(String url, String apiKey, ChatRequest body) throws Exception {
        String payload = MAPPER.writeValueAsString(body);
        long deadline = System.currentTimeMillis() + TOTAL_BUDGET_MS;

        for (int attempt = 0; ; attempt++) {
            Exception err;
            String retryAfter = null;
            try {
                return doOnce(url, apiKey, payload);
            } catch (ApiException e) {
                if (!e.retryable()) throw e; // 4xx、余额不足：不重试
                err = e;
                retryAfter = e.retryAfter;
            } catch (HttpTimeoutException e) {
                err = e; // 超时：可重试
            } catch (IOException e) {
                err = e; // 连接错误等：可重试
            }

            if (attempt == MAX_ATTEMPTS - 1) throw err;
            long delay = backoffMillis(attempt, retryAfter);
            if (System.currentTimeMillis() + delay > deadline) {
                throw new RuntimeException("超出重试总预算", err);
            }
            System.err.printf("第 %d 次失败（%s），%.1fs 后重试%n", attempt + 1, err.getMessage(), delay / 1000.0);
            Thread.sleep(delay);
        }
    }

    public static void main(String[] args) throws Exception {
        String apiKey = System.getenv("OPENAI_API_KEY");
        if (apiKey == null || apiKey.isBlank()) {
            throw new IllegalStateException("请设置 OPENAI_API_KEY");
        }
        String baseUrl = System.getenv().getOrDefault("OPENAI_BASE_URL", "https://api.openai.com/v1");
        String model = System.getenv().getOrDefault("LLM_MODEL", "gpt-4o-mini");
        var body = new ChatRequest(model, List.of(new Message("user", "你好")));
        System.out.println(chatWithRetry(baseUrl + "/chat/completions", apiKey, body));
    }
}
```
:::

想要验证重试逻辑，可以故意把 `OPENAI_BASE_URL` 指向一个不存在的端口观察网络错误的重试，或者把 Key 改错，确认 401 不会被重试。

## 超越单次重试：生产环境的做法

重试只解决"偶发失败"。对于持续的限流或故障，还需要更系统的手段：

- **客户端限速**：在调用前用令牌桶等方式控制自己的 RPM 和 TPM，让请求平滑地发出去，而不是撞到 429 再退避。批处理任务尤其需要。
- **并发控制**：用信号量限制同时进行的请求数，例如 Python 的 `asyncio.Semaphore`、Go 的带缓冲 channel、Java 的 `Semaphore`。参见 [异步与并发编程](/guide/01-programming/async)。
- **降级与容灾**：主模型持续失败时，切换到备用模型或备用厂商。前提是有统一的适配层（见 [主流模型厂商 API 对比](/guide/03-llm-api/providers)）。
- **熔断**：短时间内失败率过高时，暂停调用一段时间，快速失败，避免所有请求都在重试中排队。
- **幂等与副作用**：重试模型调用本身是安全的，但如果 Agent 在两次调用之间执行了工具（发邮件、下订单），整个步骤的重试就要考虑幂等性。见 [工具错误处理与重试](/guide/05-tool-calling/error-handling)。
- **预算上限**：为每个任务、每个用户设置 Token 或费用上限，防止 Agent 陷入循环烧钱，见 [终止条件、步数与预算控制](/guide/06-agent-loop/stop-budget)。

## 常见坑

- **SDK 重试与自定义重试叠加**：SDK 默认重试 2 次，外层再重试 5 次，最坏情况下一个请求会被发送 15 次以上。自定义重试时把 SDK 的重试关掉。
- **对 400 错误重试**：上下文超限、参数错误重试多少次都一样，只会浪费时间。
- **不加抖动**：大量客户端同步重试，形成周期性的请求洪峰，服务迟迟恢复不了。
- **没有总预算**：每次 60 秒超时，重试 5 次加上等待时间，用户可能要等好几分钟。
- **余额不足当成限流**：疯狂重试却永远不会成功，还淹没了真正的报警信号。
- **只在 Demo 中忽略用量记录**：上线后才发现无法定位成本来源。从第一天就记录 `usage`。

## 小测

**1. 下面哪些错误应该重试：400 上下文超限、401 Key 无效、429 限流、503 服务不可用、连接被重置？**

::: details 查看答案
应该重试的是 429 限流、503 服务不可用、连接被重置，它们都是临时性的问题。400 和 401 是请求本身的问题，重试不会改变结果。
:::

**2. 为什么指数退避还需要加随机抖动？**

::: details 查看答案
没有抖动时，同一时刻失败的大量客户端会在完全相同的时间点重试，形成同步的请求洪峰，导致再次集体失败。随机抖动把重试时间分散开，让服务端负载更平滑，整体成功率更高。
:::

**3. 用 Python `openai` SDK 并配置 `max_retries=3`，外层又用自己的循环重试 3 次。一个持续返回 503 的请求最多会发送几次？**

::: details 查看答案
最多 16 次：外层每次尝试内部会发送 1 + 3 = 4 次，外层共 1 + 3 = 4 次尝试，4 × 4 = 16。重试层数叠加会让请求数成倍放大，所以应该只保留一层重试。
:::

## 延伸阅读

- [AWS Architecture Blog: Exponential Backoff And Jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)
- [OpenAI Rate Limits 指南](https://platform.openai.com/docs/guides/rate-limits)
- [OpenAI Error Codes](https://platform.openai.com/docs/guides/error-codes)
- [Anthropic Errors 文档](https://docs.anthropic.com/en/api/errors)
- 下一模块：[提示词基本原则](/guide/04-prompt/basics)

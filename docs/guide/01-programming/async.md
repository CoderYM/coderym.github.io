---
title: 异步与并发编程
description: 理解 Agent 为什么需要并发，掌握 Python asyncio、Go goroutine、Java 线程池三种并发写法，以及限流和超时控制。
---

# 异步与并发编程

::: info 学习目标
- 理解 Agent 场景是典型的 I/O 密集型，并发能显著缩短总耗时
- 掌握 Python `asyncio` 的核心用法：`async`/`await`、`gather`、`Semaphore`、超时
- 用 Go goroutine 和 Java 线程池写出等价的「限流并发 + 超时」代码
- 避开「在异步代码里调用阻塞函数」等常见陷阱
:::

## Agent 为什么需要并发

一次 LLM 调用通常要几秒到几十秒，这段时间 CPU 几乎在空等网络响应。这类任务叫 **I/O 密集型**。如果串行处理，等待时间会简单累加：

```text
串行：  [调用1 ███] [调用2 ███] [调用3 ███] [调用4 ███]      总耗时 ≈ 4 × 单次
并发：  [调用1 ███]
        [调用2 ███]
        [调用3 ███]
        [调用4 ███]                                          总耗时 ≈ 1 × 单次
```

Agent 开发中需要并发的典型场景：

| 场景 | 说明 |
| --- | --- |
| 并行工具调用 | 模型一次请求查 3 个城市的天气，3 个请求可以同时发，见 [并行工具调用](/guide/05-tool-calling/parallel-tools) |
| 批量处理 | 对 100 篇文档分别做摘要、对评估集批量跑 Agent |
| 多 Agent 协作 | 多个子 Agent 同时研究不同子问题 |
| 服务端 | 同一个服务同时处理多个用户的流式对话 |

## 并发、并行与 GIL

- **并发（Concurrency）**：多个任务交替推进，同一时刻不一定都在运行。适合 I/O 等待。
- **并行（Parallelism）**：多个任务同一时刻在多个 CPU 核上运行。适合计算密集型任务。

Python 有 GIL（全局解释器锁），同一时刻只有一个线程执行 Python 字节码，所以多线程无法加速纯计算。但等待网络时会释放 GIL，因此**对 LLM 调用这类 I/O 任务，asyncio 和多线程都有效**。Go 和 Java 没有这个限制。

## Python asyncio 核心概念

```text
            事件循环（Event Loop）
   ┌─────────────────────────────────────┐
   │ 任务A: 发请求 ──await──▶ (挂起，等网络)   │
   │ 任务B: 发请求 ──await──▶ (挂起，等网络)   │   一个线程，在多个任务之间切换
   │ 任务A: 响应到了，继续执行 ...            │
   └─────────────────────────────────────┘
```

| 写法 | 作用 |
| --- | --- |
| `async def f()` | 定义协程函数，调用它只得到协程对象，不会立即执行 |
| `await x` | 等待 x 完成；等待期间事件循环去执行别的任务 |
| `asyncio.run(main())` | 程序入口，启动事件循环 |
| `asyncio.gather(*coros)` | 并发运行多个协程，按传入顺序返回结果 |
| `asyncio.Semaphore(n)` | 限制同时运行的任务数，防止触发 API 限流 |
| `asyncio.wait_for(coro, timeout)` | 给单个任务加超时 |

## 动手：限流并发 + 超时

下面的程序并发处理 8 篇「文档」，最多同时 3 个请求，每个请求超时 3 秒。为了不消耗 API 额度，用 sleep 模拟 LLM 调用，其中「文档5」模拟一个卡住的请求。三种语言行为一致，可以直接运行。

::: code-group
```python [Python]
import asyncio
import random
import time


async def fake_llm(prompt: str) -> str:
    """模拟一次 LLM 调用：耗时 0.5~1.5 秒。"""
    delay = random.uniform(0.5, 1.5)
    if prompt.endswith("5"):
        delay = 10  # 模拟一次卡住的请求
    await asyncio.sleep(delay)  # 注意是 asyncio.sleep，不是 time.sleep
    return f"{prompt} 的摘要"


async def summarize(sem: asyncio.Semaphore, prompt: str) -> str:
    async with sem:  # 获取名额，离开时自动释放
        try:
            return await asyncio.wait_for(fake_llm(prompt), timeout=3)
        except asyncio.TimeoutError:
            return f"{prompt} 超时"


async def main() -> None:
    docs = [f"文档{i}" for i in range(1, 9)]
    sem = asyncio.Semaphore(3)  # 最多 3 个并发

    start = time.perf_counter()
    results = await asyncio.gather(*(summarize(sem, d) for d in docs))
    print(results)  # 顺序与 docs 一致
    print(f"并发耗时 {time.perf_counter() - start:.1f}s")


if __name__ == "__main__":
    asyncio.run(main())
```
```go [Go]
package main

import (
	"context"
	"fmt"
	"math/rand"
	"strings"
	"sync"
	"time"
)

// fakeLLM 模拟一次 LLM 调用：耗时 0.5~1.5 秒，并响应 ctx 取消。
func fakeLLM(ctx context.Context, prompt string) (string, error) {
	delay := time.Duration(500+rand.Intn(1000)) * time.Millisecond
	if strings.HasSuffix(prompt, "5") {
		delay = 10 * time.Second // 模拟一次卡住的请求
	}
	select {
	case <-time.After(delay):
		return prompt + " 的摘要", nil
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

func main() {
	docs := make([]string, 8)
	for i := range docs {
		docs[i] = fmt.Sprintf("文档%d", i+1)
	}

	results := make([]string, len(docs)) // 按下标写入，保持顺序
	sem := make(chan struct{}, 3)        // 带缓冲的 channel 充当信号量
	var wg sync.WaitGroup

	start := time.Now()
	for i, doc := range docs {
		wg.Add(1)
		go func(i int, doc string) {
			defer wg.Done()
			sem <- struct{}{}        // 获取名额
			defer func() { <-sem }() // 释放名额

			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			out, err := fakeLLM(ctx, doc)
			if err != nil {
				out = doc + " 超时"
			}
			results[i] = out
		}(i, doc)
	}
	wg.Wait()

	fmt.Println(results)
	fmt.Printf("并发耗时 %.1fs\n", time.Since(start).Seconds())
}
```
```java [Java]
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.*;

public class Main {
    // 模拟一次 LLM 调用：耗时 0.5~1.5 秒。
    static String fakeLlm(String prompt) throws InterruptedException {
        long delay = ThreadLocalRandom.current().nextLong(500, 1500);
        if (prompt.endsWith("5")) {
            delay = 10_000; // 模拟一次卡住的请求
        }
        Thread.sleep(delay);
        return prompt + " 的摘要";
    }

    public static void main(String[] args) throws Exception {
        List<String> docs = new ArrayList<>();
        for (int i = 1; i <= 8; i++) docs.add("文档" + i);

        ExecutorService pool = Executors.newFixedThreadPool(3);  // 最多 3 个并发
        ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor();
        long start = System.nanoTime();

        List<Callable<String>> tasks = new ArrayList<>();
        for (String doc : docs) {
            tasks.add(() -> {
                // 超时从任务真正开始执行时计时：到点就中断当前线程
                Thread worker = Thread.currentThread();
                ScheduledFuture<?> alarm = timer.schedule(worker::interrupt, 3, TimeUnit.SECONDS);
                try {
                    return fakeLlm(doc);
                } catch (InterruptedException e) {
                    return doc + " 超时";
                } finally {
                    alarm.cancel(false);
                    Thread.interrupted(); // 清除中断标记，避免影响线程池复用
                }
            });
        }

        List<String> results = new ArrayList<>();
        for (Future<String> f : pool.invokeAll(tasks)) { // 返回顺序与提交顺序一致
            results.add(f.get());
        }
        pool.shutdown();
        timer.shutdown();

        System.out.println(results);
        System.out.printf("并发耗时 %.1fs%n", (System.nanoTime() - start) / 1e9);
    }
}
```
:::

运行后会看到「文档5 超时」，其余正常，总耗时约 4 秒；串行则至少需要 3 秒（超时）加上 7 次约 1 秒的调用。

三种语言的对应关系：

| 概念 | Python | Go | Java |
| --- | --- | --- | --- |
| 并发单元 | 协程 `async def` | goroutine `go f()` | 线程池中的任务 |
| 等待全部完成 | `asyncio.gather` | `sync.WaitGroup` | `invokeAll` / `CompletableFuture.allOf` |
| 限制并发数 | `asyncio.Semaphore` | 带缓冲 channel | 固定大小线程池 / `Semaphore` |
| 超时 | `asyncio.wait_for` | `context.WithTimeout` | 定时中断 / `HttpRequest.timeout` |

真实项目中，超时通常直接交给 HTTP 客户端：Go 用 `http.NewRequestWithContext` 传入带超时的 ctx，Java 用 `HttpRequest.Builder.timeout(...)`。Java 21 起还可以用虚拟线程（`Executors.newVirtualThreadPerTaskExecutor()`），以同步写法支撑大量并发。

## 换成真实的 LLM 调用

OpenAI Python SDK 提供异步客户端 `AsyncOpenAI`，用法与同步版几乎相同，只是方法要 `await`：

```python
import asyncio
import os

from openai import AsyncOpenAI

client = AsyncOpenAI(
    api_key=os.environ["OPENAI_API_KEY"],
    base_url=os.getenv("OPENAI_BASE_URL") or None,
    timeout=30.0,  # SDK 层面的请求超时
)
MODEL = os.getenv("LLM_MODEL", "gpt-4o-mini")


async def ask(sem: asyncio.Semaphore, question: str) -> str:
    async with sem:
        resp = await client.chat.completions.create(
            model=MODEL,
            messages=[{"role": "user", "content": question}],
        )
        return resp.choices[0].message.content or ""


async def main() -> None:
    sem = asyncio.Semaphore(3)
    questions = ["什么是 Token？", "什么是 RAG？", "什么是 Tool Calling？"]
    answers = await asyncio.gather(*(ask(sem, q) for q in questions), return_exceptions=True)
    for q, a in zip(questions, answers):
        print(q, "→", a if not isinstance(a, Exception) else f"失败: {a}")


asyncio.run(main())
```

`return_exceptions=True` 让某个请求失败时不影响其他结果，失败项以异常对象返回。Go 和 Java 的真实调用只需把 `fakeLLM` 换成上一篇 [开发环境](/guide/01-programming/dev-env) 里的 HTTP 请求代码。

Python 3.11 起还有 `asyncio.TaskGroup` 和 `asyncio.timeout()`，语义更严格：组内任一任务失败，其余任务会被取消。需要「全部成功才有意义」时可以用它。

## 常见坑

- **在协程里调用阻塞函数**。`time.sleep`、同步版 `OpenAI` 客户端、`requests.get` 会卡住整个事件循环，所有任务都停下。改用异步版本，或用 `await asyncio.to_thread(blocking_func, ...)` 放到线程里执行。
- **忘记 `await`**。`client.chat.completions.create(...)` 前漏了 `await`，得到的是协程对象而不是结果，并伴随 `coroutine was never awaited` 警告。
- **不限并发**。一次性对 1000 篇文档 `gather`，会立即触发 API 的 429 限流。始终用 Semaphore 或固定线程池控制并发数。
- **Go 中并发写 map / slice 同一位置**。多个 goroutine 写同一个 map 会 panic；按下标写入 slice 的不同位置是安全的，否则要加 `sync.Mutex`。
- **没有超时**。一个卡住的请求会拖住整批任务。每个请求都要有超时，整体任务也最好有总超时。

## 小测

**1. 下面的代码能实现并发吗？为什么？**

```python
async def fetch(i):
    time.sleep(1)
    return i

async def main():
    await asyncio.gather(*(fetch(i) for i in range(5)))
```

::: details 查看答案
不能，总耗时约 5 秒。`time.sleep` 是阻塞调用，会卡住事件循环，协程之间无法切换。应改为 `await asyncio.sleep(1)`。对于无法改成异步的阻塞函数，用 `await asyncio.to_thread(...)`。
:::

**2. 既然 Python 有 GIL，为什么用 asyncio 并发调用 LLM 仍然能提速？**

::: details 查看答案
GIL 限制的是同一时刻只有一个线程执行 Python 字节码。LLM 调用的绝大部分时间在等待网络响应，等待期间不占用 CPU，事件循环可以切换去发起其他请求。所以 I/O 密集型任务用 asyncio 能有效提速，而 CPU 密集型任务则需要多进程。
:::

**3. 要对 500 条评估样例批量调用模型，API 限制每分钟 60 次请求。你会如何设计？**

::: details 查看答案
用 Semaphore（或固定大小的线程池）限制并发数；再加一个速率限制（例如每秒最多发 1 个请求的令牌桶）；每个请求设超时；遇到 429 按指数退避重试；用 `return_exceptions=True` 收集失败项，最后单独重跑。详见 [计费、限流与错误重试](/guide/03-llm-api/cost-errors)。
:::

## 延伸阅读

- [Python asyncio 官方文档](https://docs.python.org/3/library/asyncio.html)
- [Go 官方博客：Go Concurrency Patterns: Context](https://go.dev/blog/context)
- [Java `java.util.concurrent` 包文档](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/util/concurrent/package-summary.html)
- 本站：[并行工具调用](/guide/05-tool-calling/parallel-tools)、[流式输出与 SSE](/guide/01-programming/streaming-sse)

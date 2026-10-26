---
title: 多 Agent 的坑与成本控制
description: 多 Agent 系统常见的失败模式、成本放大的来源，以及全局预算、并发上限、模型分级等控制手段。
---

# 多 Agent 的坑与成本控制

::: info 学习目标
- 认识多 Agent 系统最常见的失败模式，并能对照轨迹判断问题出在哪一层
- 理解多 Agent 的 Token 成本为什么会成倍放大，学会做上线前的成本估算
- 实现一个所有 Agent 共享的全局预算（Token、调用次数、时间）
- 掌握模型分级、结果缓存、提前终止等降本手段
:::

前面三篇讲了多 Agent 能做什么。这一篇讲它会怎么坏、会花多少钱。建议上线任何多 Agent 系统前，把这一篇当检查清单过一遍。

## 失败模式清单

多 Agent 系统出问题时，先判断问题属于哪一层，再去对应位置修：

| 层次 | 典型症状 | 常见原因 | 修法 |
| --- | --- | --- | --- |
| 规划 | 子任务重叠、遗漏、拆得过细 | 规划提示词没有边界要求；没给示例 | 在提示词中要求不重叠、写清边界；按任务复杂度规定子任务数量 |
| 通信 | 子 Agent 答非所问 | 任务简报不自包含 | 简报包含目标、背景、范围、输出格式，见 [状态共享与通信](/guide/12-multi-agent/state-sharing) |
| 执行 | 子 Agent 无限搜索、反复调用同一工具 | 没有终止条件 | 每个 Agent 都有步数上限，见 [终止条件、步数与预算控制](/guide/06-agent-loop/stop-budget) |
| 协调 | 两个 Agent 结论矛盾，汇总时没发现 | 汇总提示词没要求对比矛盾 | 汇总时要求列出冲突点；关键事实放黑板 |
| 汇总 | 最终答案丢了子任务的关键细节 | 结果太长被压缩，或汇总模型太弱 | 子任务返回结构化结果；汇总用强模型 |
| 系统 | 成本失控、429 限流、整体超时 | 无全局预算、无并发上限 | 全局预算 + 信号量 + 超时 |

还有几种更隐蔽的问题：

- **过早结束。** 子 Agent 找到一个看起来像答案的结果就收工了，没有覆盖任务要求的全部范围。在任务简报里写清"完成标准"。
- **互相附和。** 辩论或评审模式中，Agent 倾向同意对方，审查形同虚设。给评审 Agent 明确的反对立场或检查清单。
- **错误级联。** 主 Agent 基于一个错误的子任务结果再派出下一轮任务，错误被放大。要求子任务结果附来源，主 Agent 对关键结论做抽查。
- **非确定性。** 同一个任务跑两次，拆分方式不同，结果差异很大。评估时必须对同一用例跑多次，看分布而不是看单次，见 [评估集与指标设计](/guide/14-evaluation/eval-design)。

## 成本为什么会放大

单 Agent 的成本大致是"步数 × 每步上下文长度"。多 Agent 在此基础上多了几个乘数：

```text
总 Token ≈ 规划调用
         + Σ(每个子 Agent 的步数 × 每步上下文长度)
         + 汇总调用（输入包含所有子 Agent 的结果）
         + 重试 / 返工 / 多轮派发

其中每个子 Agent 的每一步都要重复读：
  系统提示词 + 工具定义 + 任务简报 + 自己累积的工具结果
```

一个具体的估算例子（数字只是示意，用来说明量级关系）：

| 项目 | 单 Agent | 主从（5 个 Worker） |
| --- | --- | --- |
| 系统提示词 + 工具定义 | 2k × 15 步 = 30k | 主：2k × 2 次；从：2k × 8 步 × 5 = 84k |
| 工具结果累积 | 约 60k | 每个 Worker 约 40k，共 200k |
| 汇总输入 | 无 | 约 10k |
| 合计量级 | 约 90k | 约 300k |

结论：同一任务，多 Agent 的 Token 消耗是单 Agent 的数倍很正常。上线前用真实用例跑几次，从响应的 `usage` 字段统计实际消耗，再乘以预估调用量，确认业务能承受。

## 全局预算：所有 Agent 共享一份

每个 Agent 有自己的步数上限还不够。5 个 Worker 每个限 20 步，加上主 Agent 多轮派发，总量仍然可能失控。需要一个 **所有 Agent 共享** 的全局预算：任何 Agent 在调用 LLM 前都要先申请，超限就抛异常，由编排层捕获后进入"用已有结果收尾"的分支。

下面的实现同时限制 Token、调用次数和墙钟时间，用锁保证并发安全。示例用模拟的 Worker 演示多个并发 Agent 共享预算时的行为。

::: code-group
```python [Python]
import threading
import time
from dataclasses import dataclass, field


class BudgetExceeded(Exception):
    pass


@dataclass
class Budget:
    """所有 Agent 共享的一份预算：Token、调用次数、墙钟时间，任何一项超限都停止。"""
    max_tokens: int
    max_calls: int
    max_seconds: float
    used_tokens: int = 0
    calls: int = 0
    start: float = field(default_factory=time.monotonic)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def reserve(self, agent: str) -> None:
        """每次调用 LLM 之前调用：检查剩余预算并占用一次调用次数。"""
        with self._lock:
            if time.monotonic() - self.start > self.max_seconds:
                raise BudgetExceeded(f"{agent}: 超出时间预算")
            if self.calls >= self.max_calls:
                raise BudgetExceeded(f"{agent}: 超出调用次数 {self.max_calls}")
            if self.used_tokens >= self.max_tokens:
                raise BudgetExceeded(f"{agent}: 超出 Token 预算 {self.max_tokens}")
            self.calls += 1

    def charge(self, agent: str, prompt_tokens: int, completion_tokens: int) -> None:
        """每次调用之后，用响应里的 usage 记账。"""
        with self._lock:
            self.used_tokens += prompt_tokens + completion_tokens
            print(f"[{agent}] +{prompt_tokens + completion_tokens} tokens，"
                  f"累计 {self.used_tokens}/{self.max_tokens}，调用 {self.calls}/{self.max_calls}")


# 接入真实调用时：
#   budget.reserve(name)
#   resp = client.chat.completions.create(...)
#   if resp.usage:
#       budget.charge(name, resp.usage.prompt_tokens, resp.usage.completion_tokens)

if __name__ == "__main__":
    budget = Budget(max_tokens=10_000, max_calls=20, max_seconds=300)

    def fake_worker(name: str) -> None:
        try:
            while True:  # 模拟一个不知道该停的 Worker
                budget.reserve(name)
                budget.charge(name, prompt_tokens=1500, completion_tokens=300)
        except BudgetExceeded as e:
            print("停止：", e)

    threads = [threading.Thread(target=fake_worker, args=(f"worker-{i}",)) for i in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
```

```go [Go]
package main

import (
	"fmt"
	"sync"
	"time"
)

// Budget 所有 Agent 共享的一份预算：Token、调用次数、墙钟时间，任何一项超限都停止。
type Budget struct {
	mu         sync.Mutex
	MaxTokens  int
	MaxCalls   int
	Deadline   time.Time
	usedTokens int
	calls      int
}

type BudgetExceeded struct{ Reason string }

func (e *BudgetExceeded) Error() string { return "budget exceeded: " + e.Reason }

// Reserve 每次调用 LLM 之前调用：检查剩余预算并占用一次调用次数。
func (b *Budget) Reserve(agent string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	switch {
	case time.Now().After(b.Deadline):
		return &BudgetExceeded{agent + ": 超出时间预算"}
	case b.calls >= b.MaxCalls:
		return &BudgetExceeded{fmt.Sprintf("%s: 超出调用次数 %d", agent, b.MaxCalls)}
	case b.usedTokens >= b.MaxTokens:
		return &BudgetExceeded{fmt.Sprintf("%s: 超出 Token 预算 %d", agent, b.MaxTokens)}
	}
	b.calls++
	return nil
}

// Charge 每次调用之后，用响应里的 usage 字段记账。
func (b *Budget) Charge(agent string, promptTokens, completionTokens int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.usedTokens += promptTokens + completionTokens
	fmt.Printf("[%s] +%d tokens，累计 %d/%d，调用 %d/%d\n", agent,
		promptTokens+completionTokens, b.usedTokens, b.MaxTokens, b.calls, b.MaxCalls)
}

func main() {
	budget := &Budget{MaxTokens: 10_000, MaxCalls: 20, Deadline: time.Now().Add(5 * time.Minute)}

	var wg sync.WaitGroup
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func(name string) {
			defer wg.Done()
			for { // 模拟一个不知道该停的 Worker
				if err := budget.Reserve(name); err != nil {
					fmt.Println("停止：", err)
					return
				}
				// 真实场景：发起请求，解析 usage.prompt_tokens / usage.completion_tokens
				budget.Charge(name, 1500, 300)
			}
		}(fmt.Sprintf("worker-%d", i))
	}
	wg.Wait()
}
```

```java [Java]
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/** 所有 Agent 共享的一份预算：Token、调用次数、墙钟时间，任何一项超限都停止。 */
public class Budget {
    public static class BudgetExceededException extends RuntimeException {
        BudgetExceededException(String msg) { super(msg); }
    }

    private final int maxTokens;
    private final int maxCalls;
    private final Instant deadline;
    private int usedTokens = 0;
    private int calls = 0;

    public Budget(int maxTokens, int maxCalls, Duration maxDuration) {
        this.maxTokens = maxTokens;
        this.maxCalls = maxCalls;
        this.deadline = Instant.now().plus(maxDuration);
    }

    /** 每次调用 LLM 之前调用：检查剩余预算并占用一次调用次数。 */
    public synchronized void reserve(String agent) {
        if (Instant.now().isAfter(deadline)) throw new BudgetExceededException(agent + ": 超出时间预算");
        if (calls >= maxCalls) throw new BudgetExceededException(agent + ": 超出调用次数 " + maxCalls);
        if (usedTokens >= maxTokens) throw new BudgetExceededException(agent + ": 超出 Token 预算 " + maxTokens);
        calls++;
    }

    /** 每次调用之后，用响应里的 usage 字段记账。 */
    public synchronized void charge(String agent, int promptTokens, int completionTokens) {
        usedTokens += promptTokens + completionTokens;
        System.out.printf("[%s] +%d tokens，累计 %d/%d，调用 %d/%d%n", agent,
                promptTokens + completionTokens, usedTokens, maxTokens, calls, maxCalls);
    }

    public static void main(String[] args) throws InterruptedException {
        Budget budget = new Budget(10_000, 20, Duration.ofMinutes(5));
        List<Thread> threads = new ArrayList<>();
        for (int i = 0; i < 3; i++) {
            String name = "worker-" + i;
            Thread t = new Thread(() -> {
                try {
                    while (true) { // 模拟一个不知道该停的 Worker
                        budget.reserve(name);
                        // 真实场景：发起请求，解析 usage.prompt_tokens / usage.completion_tokens
                        budget.charge(name, 1500, 300);
                    }
                } catch (BudgetExceededException e) {
                    System.out.println("停止：" + e.getMessage());
                }
            });
            threads.add(t);
            t.start();
        }
        for (Thread t : threads) t.join();
    }
}
```
:::

运行后会看到三个 Worker 交替记账，Token 用尽后全部停止。注意输出里累计值会略超过 10000：`reserve` 只能检查"已经用了多少"，无法预知下一次调用会用多少，所以这是一个 **软上限**。需要硬上限时，在 `reserve` 里按"当前用量 + 本次请求的预估输入 + `max_tokens`"判断，同时给每次请求设置 `max_tokens` 参数。

接入编排层时有两点要注意：

- 捕获 `BudgetExceeded` 后不要直接报错退出，而是让主 Agent 用已经收回的结果写一个"部分完成"的答案，并说明哪些子任务没做完。
- 预算对象要随任务传递（一个用户请求一个预算），不要做成全局单例，否则不同用户的请求会互相挤占。

## 降本手段

| 手段 | 做法 | 效果与代价 |
| --- | --- | --- |
| 模型分级 | 规划和汇总用强模型，Worker 的检索、抽取用小模型 | 往往是最有效的一招；需要评估小模型在子任务上的质量 |
| 限制扇出 | 规划时按任务复杂度规定子任务数量（简单问题 1 个，复杂问题 3~5 个） | 避免为简单问题派出一大批 Worker |
| 精简共享前缀 | 缩短系统提示词，按需加载工具定义 | 每个 Agent、每一步都省 |
| Prompt Caching | 让各 Worker 的系统提示词和工具定义保持完全一致的前缀 | 命中缓存的输入更便宜、更快，见 [Prompt Caching](/guide/07-context-engineering/prompt-caching) |
| 结果缓存 | 相同子任务（同一查询、同一网页）的结果缓存复用 | 需要设计缓存键和过期时间 |
| 压缩回传 | 子 Agent 只返回结构化结论，大块内容写文件 | 汇总输入大幅减少 |
| 提前终止 | 主 Agent 判断信息已足够时，取消剩余子任务 | 需要支持取消（`asyncio` 任务取消、Go 的 `context`） |
| 先退回单 Agent | 评估证明多 Agent 收益不大时，直接换回单 Agent | 最省钱的方案 |

更系统的成本与延迟优化见 [成本与延迟优化](/guide/15-production/cost-optimization)。

## 可观测性：没有轨迹就无法调试

多 Agent 系统的调试难度远高于单 Agent，上线前至少要做到：

- 每个 Agent 的每次 LLM 调用、工具调用都记录日志，带上 `trace_id`（整个任务）和 `agent_id`、`parent_id`（谁派出的）。
- 记录每次调用的 `usage`，能按 Agent 汇总成本，找出最花钱的环节。
- 能回放：给定 `trace_id`，按时间线还原"主 Agent 拆了什么、每个 Worker 做了什么、汇总时看到了什么"。

```text
trace 7f3a
├─ orchestrator  plan        2.1k tokens   1.8s
├─ worker s1     6 steps    38.0k tokens  21.4s  ok
├─ worker s2     9 steps    52.3k tokens  33.0s  ok
├─ worker s3     20 steps   80.1k tokens  60.2s  hit step limit   ◀ 重点排查
└─ orchestrator  synthesize  9.7k tokens   6.5s
```

工具选型与做法见 [轨迹追踪与可观测性](/guide/14-evaluation/observability)。

## 常见坑

- **只有每个 Agent 的局部上限。** 局部上限防不住"多轮派发 × 多个 Worker"的乘法效应，必须有任务级的全局预算。
- **预算超限直接报错。** 用户等了一分钟，拿到一个错误。应该用已有结果收尾，并说明未完成的部分。
- **全局单例预算。** 多个用户请求共享一个预算对象，一个大任务会耗尽所有人的额度。
- **只看单次结果评估。** 多 Agent 系统非确定性更强，单次跑通不代表稳定，至少对同一用例跑多次。
- **不统计每个 Agent 的成本。** 不知道钱花在哪里，就无从优化。

## 小测

1. 每个 Worker 都设置了 20 步上限，为什么仍然需要全局预算？

::: details 查看答案
局部上限只约束单个 Agent。主 Agent 可能派出很多 Worker，还可能多轮派发，总调用量是"Worker 数 × 每个的步数 × 轮数"的乘积，仍可能失控。全局预算在任务层面统一约束所有 Agent 的 Token、调用次数和时间。
:::

2. 全局预算超限时，编排层最好怎么处理？

::: details 查看答案
捕获超限异常，让主 Agent 基于已收回的子任务结果生成一个部分完成的答案，明确说明哪些部分没有完成及原因，而不是直接向用户返回错误。
:::

3. 想在不明显降低质量的前提下降低多 Agent 系统的成本，你会优先尝试哪两种手段？

::: details 查看答案
常见的优先选项：模型分级（Worker 用小模型，规划和汇总用强模型）和限制扇出（按任务复杂度控制子任务数量）。另外，保持各 Worker 的提示词前缀一致以命中 Prompt Caching，以及让子 Agent 只回传结构化结论，也都是改动小、收益明显的做法。具体选哪种要用评估集验证质量没有下降。
:::

## 延伸阅读

- [How we built our multi-agent research system（Anthropic）](https://www.anthropic.com/engineering/multi-agent-research-system)：多 Agent 的 Token 消耗、扇出规则与调试经验
- [Why Do Multi-Agent LLM Systems Fail?](https://arxiv.org/abs/2503.13657)：多 Agent 系统失败模式的分类研究
- 本站：[终止条件、步数与预算控制](/guide/06-agent-loop/stop-budget)、[计费、限流与错误重试](/guide/03-llm-api/cost-errors)、[回归测试与持续评估](/guide/14-evaluation/regression)

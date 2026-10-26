---
title: RAG 评估
description: 把 RAG 拆成检索和生成两段分别度量：recall@k、MRR 看检索，忠实度、答案相关性看生成。
---

# RAG 评估

::: info 学习目标
- 理解为什么 RAG 要把检索和生成分开评估
- 掌握 recall@k、hit@k、MRR 的定义并动手实现（Python / Go / Java）
- 理解忠实度（Faithfulness）、答案相关性（Answer Relevance）等生成指标及其 LLM 评判方法
- 知道如何构建评估集，以及 Ragas 等工具的定位
:::

## 为什么要分段评估

"回答不对"可能有完全不同的原因：

```text
 问题 ──► 检索 ──► 片段 ──► 生成 ──► 答案
           │                 │
   ① 没检索到正确资料     ② 资料拿到了，但模型答错、漏答或编造
```

只看最终答案，你分不清是 ① 还是 ②，也就不知道该调切分和检索，还是该改提示词和换模型。所以 RAG 评估的基本方法是**分段度量**：

| 环节 | 回答的问题 | 典型指标 | 是否需要 LLM |
| --- | --- | --- | --- |
| 检索 | 该找的资料找到了吗？排得靠前吗？ | recall@k、hit@k、MRR、nDCG | 不需要（有标注即可） |
| 生成 | 回答是否忠于资料？是否切题？ | 忠实度、答案相关性、正确性 | 通常需要 LLM 评判 |
| 端到端 | 用户问题解决了吗？ | 答案正确率、人工满意度 | 人工或 LLM |

评估的通用方法论（为什么要先做评估、怎么设计评估集）见 [为什么评估是第一优先级](/guide/14-evaluation/why-evals) 和 [评估集与指标设计](/guide/14-evaluation/eval-design)，本文聚焦 RAG 特有的部分。

## 检索指标

假设对每个测试问题，都已经人工标注了"哪些块能回答它"（相关集合），检索系统返回了一个排序列表。

- **recall@k（召回率）**：Top-k 里命中了多少个相关块 ÷ 相关块总数。衡量"该找的找全了没有"。RAG 里最重要的检索指标，因为没召回的资料，后面无论如何都用不上。
- **hit@k（命中率）**：Top-k 里只要有一个相关块就记 1。当每个问题只有一个标准答案块时，它和 recall@k 相同。
- **MRR（Mean Reciprocal Rank，平均倒数排名）**：第一个相关块排在第 r 位，得分为 1/r，再对所有问题取平均。衡量"相关资料排得够不够靠前"。
- **precision@k（精确率）**：Top-k 里相关块的比例。RAG 中参考意义较小，因为 k 较大时它必然偏低，而少量无关片段对生成的影响有限。
- **nDCG**：考虑多级相关度（非常相关、部分相关）和排名位置，适合精细评估重排效果。

```text
 例：相关块 = {B, D}，检索结果 = [A, B, C, D, E]
   recall@2 = |{B}| / 2 = 0.5       recall@5 = |{B, D}| / 2 = 1.0
   hit@2    = 1                     第一个相关块 B 排第 2 → RR = 1/2
```

### 动手：计算检索指标

下面的实现只依赖标准库。实际使用时，`retrieved` 由你的检索函数（向量、混合、加重排）生成，就能对比不同方案的指标。

::: code-group
```python [Python]
from dataclasses import dataclass


@dataclass
class Case:
    query: str
    relevant: set[str]   # 人工标注：哪些块能回答这个问题
    retrieved: list[str]  # 检索系统返回的结果，按排名从高到低


def recall_at_k(c: Case, k: int) -> float:
    """Top-k 中命中的相关块数 / 相关块总数。"""
    hit = len(c.relevant & set(c.retrieved[:k]))
    return hit / len(c.relevant) if c.relevant else 0.0


def hit_at_k(c: Case, k: int) -> float:
    """Top-k 中至少有一个相关块记 1，否则记 0。"""
    return 1.0 if c.relevant & set(c.retrieved[:k]) else 0.0


def reciprocal_rank(c: Case) -> float:
    """第一个相关块排名的倒数；没有命中记 0。"""
    for rank, doc_id in enumerate(c.retrieved, start=1):
        if doc_id in c.relevant:
            return 1.0 / rank
    return 0.0


def evaluate(cases: list[Case], k: int) -> dict[str, float]:
    n = len(cases)
    return {
        f"recall@{k}": sum(recall_at_k(c, k) for c in cases) / n,
        f"hit@{k}": sum(hit_at_k(c, k) for c in cases) / n,
        "MRR": sum(reciprocal_rank(c) for c in cases) / n,
    }


if __name__ == "__main__":
    cases = [
        Case("一线城市住宿标准", {"travel-2"}, ["travel-2", "travel-1", "hr-1"]),
        Case("报销提交期限和住宿标准", {"travel-2", "travel-3"}, ["travel-1", "travel-3", "travel-2"]),
        Case("年假天数", {"hr-1"}, ["hr-3", "hr-2", "travel-1"]),
        Case("加班调休期限", {"hr-4"}, ["hr-2", "hr-4", "hr-1"]),
    ]
    for name, value in evaluate(cases, k=2).items():
        print(f"{name:>10}: {value:.3f}")
```

```go [Go]
package main

import "fmt"

type Case struct {
	Query     string
	Relevant  map[string]bool // 人工标注：哪些块能回答这个问题
	Retrieved []string        // 检索系统返回的结果，按排名从高到低
}

func set(ids ...string) map[string]bool {
	m := map[string]bool{}
	for _, id := range ids {
		m[id] = true
	}
	return m
}

func hits(c Case, k int) int {
	n, seen := 0, map[string]bool{}
	for _, id := range c.Retrieved[:min(k, len(c.Retrieved))] {
		if c.Relevant[id] && !seen[id] {
			n++
			seen[id] = true
		}
	}
	return n
}

// RecallAtK Top-k 中命中的相关块数 / 相关块总数
func RecallAtK(c Case, k int) float64 {
	if len(c.Relevant) == 0 {
		return 0
	}
	return float64(hits(c, k)) / float64(len(c.Relevant))
}

// HitAtK Top-k 中至少有一个相关块记 1，否则记 0
func HitAtK(c Case, k int) float64 {
	if hits(c, k) > 0 {
		return 1
	}
	return 0
}

// ReciprocalRank 第一个相关块排名的倒数；没有命中记 0
func ReciprocalRank(c Case) float64 {
	for i, id := range c.Retrieved {
		if c.Relevant[id] {
			return 1.0 / float64(i+1)
		}
	}
	return 0
}

func main() {
	cases := []Case{
		{"一线城市住宿标准", set("travel-2"), []string{"travel-2", "travel-1", "hr-1"}},
		{"报销提交期限和住宿标准", set("travel-2", "travel-3"), []string{"travel-1", "travel-3", "travel-2"}},
		{"年假天数", set("hr-1"), []string{"hr-3", "hr-2", "travel-1"}},
		{"加班调休期限", set("hr-4"), []string{"hr-2", "hr-4", "hr-1"}},
	}
	const k = 2
	var recall, hit, mrr float64
	for _, c := range cases {
		recall += RecallAtK(c, k)
		hit += HitAtK(c, k)
		mrr += ReciprocalRank(c)
	}
	n := float64(len(cases))
	fmt.Printf("%10s: %.3f\n", fmt.Sprintf("recall@%d", k), recall/n)
	fmt.Printf("%10s: %.3f\n", fmt.Sprintf("hit@%d", k), hit/n)
	fmt.Printf("%10s: %.3f\n", "MRR", mrr/n)
}
```

```java [Java]
import java.util.HashSet;
import java.util.List;
import java.util.Set;

public class Main {
    /** relevant：人工标注的相关块；retrieved：检索结果，按排名从高到低 */
    record Case(String query, Set<String> relevant, List<String> retrieved) {}

    static int hits(Case c, int k) {
        Set<String> top = new HashSet<>(c.retrieved().subList(0, Math.min(k, c.retrieved().size())));
        top.retainAll(c.relevant());
        return top.size();
    }

    /** Top-k 中命中的相关块数 / 相关块总数 */
    static double recallAtK(Case c, int k) {
        return c.relevant().isEmpty() ? 0 : (double) hits(c, k) / c.relevant().size();
    }

    /** Top-k 中至少有一个相关块记 1，否则记 0 */
    static double hitAtK(Case c, int k) {
        return hits(c, k) > 0 ? 1 : 0;
    }

    /** 第一个相关块排名的倒数；没有命中记 0 */
    static double reciprocalRank(Case c) {
        for (int i = 0; i < c.retrieved().size(); i++) {
            if (c.relevant().contains(c.retrieved().get(i))) return 1.0 / (i + 1);
        }
        return 0;
    }

    public static void main(String[] args) {
        List<Case> cases = List.of(
                new Case("一线城市住宿标准", Set.of("travel-2"), List.of("travel-2", "travel-1", "hr-1")),
                new Case("报销提交期限和住宿标准", Set.of("travel-2", "travel-3"), List.of("travel-1", "travel-3", "travel-2")),
                new Case("年假天数", Set.of("hr-1"), List.of("hr-3", "hr-2", "travel-1")),
                new Case("加班调休期限", Set.of("hr-4"), List.of("hr-2", "hr-4", "hr-1")));
        int k = 2;
        double n = cases.size();
        double recall = cases.stream().mapToDouble(c -> recallAtK(c, k)).sum() / n;
        double hit = cases.stream().mapToDouble(c -> hitAtK(c, k)).sum() / n;
        double mrr = cases.stream().mapToDouble(Main::reciprocalRank).sum() / n;
        System.out.printf("%10s: %.3f%n", "recall@" + k, recall);
        System.out.printf("%10s: %.3f%n", "hit@" + k, hit);
        System.out.printf("%10s: %.3f%n", "MRR", mrr);
    }
}
```
:::

输出：

```text
  recall@2: 0.625
     hit@2: 0.750
       MRR: 0.500
```

第 2 题有两个相关块，Top-2 只命中了一个，recall 为 0.5；第 3 题完全没命中，三项指标都是 0。**逐题查看得分为 0 的样本**，往往比盯着平均值更有收获：它们会直接告诉你是切分把答案切碎了、查询和文档用词差异太大，还是这类问题根本需要关键词检索。

## 生成指标

检索指标有标准答案可比对，生成指标则要判断开放文本的质量，通常用 [LLM-as-Judge](/guide/14-evaluation/llm-judge) 来评。最常用的几个：

| 指标 | 衡量什么 | 需要的输入 | 常见做法 |
| --- | --- | --- | --- |
| 忠实度（Faithfulness） | 回答中的说法是否都能在检索资料里找到依据 | 回答 + 检索片段 | 把回答拆成若干陈述，逐条判断是否被资料支持，计算支持比例 |
| 答案相关性（Answer Relevance） | 回答是否切题、是否答非所问 | 问题 + 回答 | LLM 打分；或根据回答反推可能的问题，与原问题比较语义相似度 |
| 上下文精确度 / 召回率 | 检索片段中有用信息的占比、是否覆盖参考答案 | 问题 + 片段 + 参考答案 | LLM 逐片段判断，是检索指标的"无标注"近似 |
| 答案正确性（Correctness） | 回答与参考答案是否一致 | 回答 + 参考答案 | LLM 比对关键事实 |

**忠实度和正确性不是一回事**。资料本身错了，模型忠实地复述了错误资料：忠实度高、正确性低。资料没提到，模型凭自身知识答对了：正确性高、忠实度低。在企业知识库场景，通常更看重忠实度，因为"没有依据的正确"同样不可控。

### 动手：一个最小的忠实度评判

下面用 LLM 把回答拆成陈述并逐条判断，算出"被支持的陈述占比"。这里只给出 Python 版，Go / Java 版的 HTTP 调用方式与 [长期记忆与用户画像](/guide/08-memory/long-term) 中的 JSON 模式调用相同。

```python [Python]
import json
import os

from openai import OpenAI

client = OpenAI(api_key=os.environ["OPENAI_API_KEY"], base_url=os.getenv("OPENAI_BASE_URL"), timeout=60)
JUDGE_MODEL = os.getenv("JUDGE_MODEL", os.getenv("LLM_MODEL", "gpt-4o-mini"))

JUDGE_PROMPT = """你是严格的事实核查员。
1. 把【回答】拆分成若干条独立的事实陈述；
2. 对每条陈述，判断它能否从【资料】中直接得到或合理推出；
3. 只依据资料判断，不要使用你自己的知识。
输出 JSON：{"claims": [{"claim": "...", "supported": true, "reason": "..."}]}"""


def faithfulness(answer: str, contexts: list[str]) -> float:
    ctx = "\n".join(f"[{i + 1}] {c}" for i, c in enumerate(contexts))
    resp = client.chat.completions.create(
        model=JUDGE_MODEL,
        messages=[
            {"role": "system", "content": JUDGE_PROMPT},
            {"role": "user", "content": f"【资料】\n{ctx}\n\n【回答】\n{answer}"},
        ],
        response_format={"type": "json_object"},
        temperature=0,
    )
    claims = json.loads(resp.choices[0].message.content or "{}").get("claims") or []
    if not claims:
        return 0.0
    return sum(1 for c in claims if c.get("supported") is True) / len(claims)


if __name__ == "__main__":
    contexts = ["国内出差住宿标准为一线城市每晚 600 元，其他城市每晚 400 元。"]
    good = "上海属于一线城市，住宿每晚最多报销 600 元。"
    bad = "上海住宿每晚最多报销 600 元，超出部分可以用餐补抵扣。"  # 后半句资料里没有
    print("good:", faithfulness(good, contexts))
    print("bad: ", faithfulness(bad, contexts))
```

`bad` 的后半句是模型"编"出来的，预期会被判为不支持，得分低于 `good`。LLM 评判本身也有误差：评判模型最好不弱于被测模型，并且要用一批人工标注的样本校验评判结果与人工判断的一致率。

## 用 Ragas 等工具

[Ragas](https://github.com/vibrantlabsai/ragas) 是一个专门用于 RAG 评估的开源 Python 库，内置了忠实度、答案相关性、上下文精确度 / 召回率等指标的 LLM 评判实现，也支持从文档自动生成测试集。它的价值在于提示词和计算方式经过了较多打磨，免去从零实现。此外，DeepEval、TruLens、Arize Phoenix，以及 LangSmith、Langfuse 等可观测平台也提供 RAG 评估能力。

使用这些工具时要注意：

- 各工具的 API 和指标定义在版本间变化较快，以官方文档为准，并固定依赖版本；
- 同名指标在不同工具里的计算方式可能不同，跨工具的分数不要直接比较；
- 它们默认调用 LLM 打分，大规模评估要预估成本，并确认数据可以发送给评判模型的服务商。

## 构建评估集

指标再好，没有评估集也算不出来。一条 RAG 评估样本通常包含：

```json
{
  "question": "去上海出差住酒店，一晚最多能报多少？",
  "relevant_chunk_ids": ["travel-policy-v3#chunk-2"],
  "reference_answer": "600 元（上海属于一线城市）。",
  "tags": ["finance", "single-hop"]
}
```

来源建议按以下顺序考虑：

1. **真实用户问题**：从日志中采样，最能代表线上分布。注意脱敏。
2. **专家编写**：让业务方针对核心文档写问题和标准答案，覆盖关键场景。
3. **LLM 合成**：让模型基于文档块生成问题，速度快、量大，但问题往往"太像原文"，偏简单，需要人工抽检和改写。

几条实践经验：

- **从 50~100 条开始**，覆盖主要类型：单跳事实、多跳、对比、"资料里没有"的问题（用来测试是否会拒答）。
- **标注到块 ID**，才能算检索指标。切分策略一变，块 ID 就会变，可以改为标注"答案所在的原文片段"，再自动映射到新的块。
- **每次改动都跑一遍**：改切分、换 Embedding 模型、调 Top-K、改提示词，都对比改动前后的指标，纳入 [回归测试](/guide/14-evaluation/regression)。

## 常见坑

- **只看端到端分数**：分数下降了，却不知道是检索还是生成出了问题。始终分段记录指标。
- **评估集太简单**：LLM 合成的问题往往和原文用词高度重合，检索指标虚高，上线后效果却很差。混入真实用户问题。
- **忽略"不该回答"的问题**：没有包含"资料里查不到"的样本，就无法发现模型在编造答案。
- **盲信 LLM 评判**：评判模型也会出错，有的偏好更长的回答。定期用人工标注校验，并固定评判模型和提示词，否则不同时期的分数不可比较。
- **只看平均值**：平均分提升了 2%，可能是某一类问题大幅提升、另一类明显下降。按标签分组看指标。

## 小测

**1.** 相关块为 {A, C}，检索结果为 [B, A, D, C]。recall@2、recall@4 和 RR 分别是多少？

::: details 查看答案
recall@2：Top-2 为 [B, A]，命中 A，1/2 = 0.5；recall@4：命中 A 和 C，2/2 = 1.0；RR：第一个相关块 A 排第 2，RR = 1/2 = 0.5。
:::

**2.** 某个回答忠实度很高，但答案是错的，可能是什么原因？

::: details 查看答案
最可能是检索到的资料本身有误或已过时（例如旧版制度），模型忠实地复述了它；也可能是检索到了相关但不正确的片段（比如其他城市的标准）。应当检查检索结果和知识库内容，而不是调整生成环节。
:::

**3.** 为什么评估集中要包含"资料里没有答案"的问题？

::: details 查看答案
用来测试系统在检索不到依据时能否如实回答"不知道"，而不是编造答案。没有这类样本，幻觉问题在评估中完全无法暴露，而它恰恰是 RAG 上线后最伤用户信任的问题之一。
:::

## 延伸阅读

- [Ragas（GitHub）](https://github.com/vibrantlabsai/ragas)、[Ragas 论文](https://arxiv.org/abs/2309.15217)
- [ARES: An Automated Evaluation Framework for RAG Systems](https://arxiv.org/abs/2311.09476)
- 本站：[LLM-as-Judge](/guide/14-evaluation/llm-judge)、[评估集与指标设计](/guide/14-evaluation/eval-design)、[RAG 面试题](/interview/rag)

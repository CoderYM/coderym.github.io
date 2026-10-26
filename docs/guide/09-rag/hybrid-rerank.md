---
title: 混合检索与重排
description: 用 BM25 补足向量检索的短板，用 RRF 融合多路结果，再用 Cross-Encoder 重排，构建两阶段检索流水线。
---

# 混合检索与重排

::: info 学习目标
- 理解向量检索和关键词检索各自擅长和不擅长的查询
- 了解 BM25 的直觉和中文分词的必要性
- 实现 Reciprocal Rank Fusion（RRF）融合多路检索结果（Python / Go / Java）
- 理解 Bi-Encoder 与 Cross-Encoder 的区别，以及"召回 + 重排"两阶段架构
:::

## 向量检索不是万能的

向量检索擅长**语义匹配**："上海出差住酒店"能找到"一线城市住宿标准"。但遇到下面这些查询，它经常失手：

| 查询 | 问题 |
| --- | --- |
| "错误码 E1024 怎么处理" | `E1024` 和 `E1025` 在向量空间里几乎一样近 |
| "型号 RTX-4090D 的功耗" | 型号、版本号、SKU 是精确匹配需求 |
| "张伟的报销单" | 人名、专有名词在 Embedding 训练数据中很少见 |
| "API 参数 `max_retries`" | 代码标识符、配置项 |

这些恰好是**关键词检索**的强项。反过来，关键词检索不理解同义词，"住酒店"匹配不到"住宿"。两者互补，所以生产级 RAG 几乎都是**混合检索（Hybrid Search）**。

## BM25：关键词检索的标准做法

BM25 是 TF-IDF 的改进版，至今仍是全文检索的默认算法（Elasticsearch、OpenSearch、Lucene 的默认相关性打分都是它）。直觉上它综合了三件事：

- **词频（TF）**：查询词在文档中出现越多，越相关，但有饱和上限，出现 10 次不会比出现 5 次重要一倍；
- **逆文档频率（IDF）**：越稀有的词越有区分度，"E1024"比"的""怎么"重要得多；
- **文档长度归一化**：长文档天然包含更多词，需要惩罚。

**中文必须先分词**。英文天然以空格分隔，中文"差旅报销标准"如果不分词，就只能整串匹配。常用 `jieba` 分词，ES 中可以安装 IK 等中文分词插件。

```python [Python]
# pip install rank_bm25 jieba
import jieba
from rank_bm25 import BM25Okapi

docs = [
    "错误码 E1024 表示数据库连接超时，请检查网络和连接池配置。",
    "错误码 E1025 表示磁盘空间不足。",
    "国内出差住宿标准为一线城市每晚 600 元。",
]
bm25 = BM25Okapi([jieba.lcut(d) for d in docs])
scores = bm25.get_scores(jieba.lcut("E1024 怎么处理"))
for score, doc in sorted(zip(scores, docs), reverse=True):
    print(f"{score:.3f}  {doc}")
```

`rank_bm25` 适合学习和小数据量。生产中，关键词检索一般交给 Elasticsearch / OpenSearch 或 PostgreSQL 全文检索来做。

## 怎么融合两路结果

两路检索各返回一个排序列表，接下来要合并成一个。直觉做法是把分数加权相加，但 **BM25 分数和余弦相似度的量纲完全不同**：BM25 可能是 0~30 的任意值，并且随查询变化；余弦相似度一般在 0~1 之间。直接相加，结果基本由 BM25 决定。要加权就得先归一化（如 min-max），而归一化又对异常值敏感。

**RRF（Reciprocal Rank Fusion，倒数排名融合）** 绕开了这个问题：**只看排名，不看分数**。

```text
              1
RRF(d) =  Σ  ─────────────        rank_i(d)：文档 d 在第 i 路结果中的排名（从 1 开始）
          i   k + rank_i(d)       k：平滑常数，常取 60；某一路没出现 d，则该项为 0
```

- 在多路结果中都排得靠前的文档，得分最高；
- 只在一路中出现、但排名很高的文档，也能得到不错的分数；
- `k` 越大，排名之间的差距被压得越平，排第 1 和第 5 的分差就越小。

RRF 简单、无需调参、对分数分布不敏感，所以成了混合检索的默认融合方法，Elasticsearch、OpenSearch、Milvus、Qdrant 等都内置了 RRF 或类似的融合方式。

::: code-group
```python [Python]
from collections import defaultdict


def rrf(rankings: list[list[str]], k: int = 60) -> list[tuple[str, float]]:
    """倒数排名融合：score(d) = Σ 1 / (k + rank_i(d))，rank 从 1 开始。"""
    scores: dict[str, float] = defaultdict(float)
    for ranking in rankings:
        for rank, doc_id in enumerate(ranking, start=1):
            scores[doc_id] += 1.0 / (k + rank)
    # 分数相同时按 ID 排序，保证结果稳定
    return sorted(scores.items(), key=lambda x: (-x[1], x[0]))


if __name__ == "__main__":
    # 假设这是同一个查询在两路检索中各自返回的 Top-5（按相关性从高到低）
    bm25 = ["doc_err_E1024", "doc_install", "doc_faq", "doc_network", "doc_license"]
    vector = ["doc_troubleshoot", "doc_err_E1024", "doc_network", "doc_faq", "doc_upgrade"]

    for doc_id, score in rrf([bm25, vector]):
        print(f"{score:.5f}  {doc_id}")
```

```go [Go]
package main

import (
	"fmt"
	"sort"
)

type Scored struct {
	ID    string
	Score float64
}

// RRF 倒数排名融合：score(d) = Σ 1 / (k + rank_i(d))，rank 从 1 开始
func RRF(rankings [][]string, k float64) []Scored {
	scores := map[string]float64{}
	for _, ranking := range rankings {
		for i, id := range ranking {
			scores[id] += 1.0 / (k + float64(i+1))
		}
	}
	out := make([]Scored, 0, len(scores))
	for id, s := range scores {
		out = append(out, Scored{id, s})
	}
	// 分数相同时按 ID 排序，保证结果稳定
	sort.Slice(out, func(i, j int) bool {
		if out[i].Score != out[j].Score {
			return out[i].Score > out[j].Score
		}
		return out[i].ID < out[j].ID
	})
	return out
}

func main() {
	// 假设这是同一个查询在两路检索中各自返回的 Top-5（按相关性从高到低）
	bm25 := []string{"doc_err_E1024", "doc_install", "doc_faq", "doc_network", "doc_license"}
	vector := []string{"doc_troubleshoot", "doc_err_E1024", "doc_network", "doc_faq", "doc_upgrade"}

	for _, r := range RRF([][]string{bm25, vector}, 60) {
		fmt.Printf("%.5f  %s\n", r.Score, r.ID)
	}
}
```

```java [Java]
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class Main {
    record Scored(String id, double score) {}

    /** 倒数排名融合：score(d) = Σ 1 / (k + rank_i(d))，rank 从 1 开始 */
    static List<Scored> rrf(List<List<String>> rankings, double k) {
        Map<String, Double> scores = new HashMap<>();
        for (List<String> ranking : rankings) {
            for (int i = 0; i < ranking.size(); i++) {
                scores.merge(ranking.get(i), 1.0 / (k + i + 1), Double::sum);
            }
        }
        List<Scored> out = new ArrayList<>();
        scores.forEach((id, s) -> out.add(new Scored(id, s)));
        // 分数相同时按 ID 排序，保证结果稳定
        out.sort(Comparator.comparingDouble(Scored::score).reversed().thenComparing(Scored::id));
        return out;
    }

    public static void main(String[] args) {
        // 假设这是同一个查询在两路检索中各自返回的 Top-5（按相关性从高到低）
        List<String> bm25 = List.of("doc_err_E1024", "doc_install", "doc_faq", "doc_network", "doc_license");
        List<String> vector = List.of("doc_troubleshoot", "doc_err_E1024", "doc_network", "doc_faq", "doc_upgrade");

        for (Scored s : rrf(List.of(bm25, vector), 60)) {
            System.out.printf("%.5f  %s%n", s.score(), s.id());
        }
    }
}
```
:::

输出：

```text
0.03252  doc_err_E1024
0.03150  doc_faq
0.03150  doc_network
0.01639  doc_troubleshoot
0.01613  doc_install
0.01538  doc_license
0.01538  doc_upgrade
```

`doc_err_E1024` 在 BM25 排第 1、向量排第 2，融合后稳居第一；`doc_troubleshoot` 虽然是向量检索的第 1 名，但 BM25 没有召回它，融合后落到第 4。这正是 RRF 的特点：**奖励多路共识**。

完整的混合检索流程大致如下（两路检索可以并行执行）：

```text
                 ┌──► BM25 检索 Top-50 ───┐
  用户问题 ──────┤                        ├──► RRF 融合 ──► 候选 Top-50 ──► 重排 ──► Top-5 ──► LLM
                 └──► 向量检索 Top-50 ────┘
```

## 重排：第二阶段精选

### Bi-Encoder 与 Cross-Encoder

向量检索用的 Embedding 模型叫 **Bi-Encoder（双塔）**：查询和文档**分别**编码成向量，再算相似度。文档向量可以提前算好，所以检索很快，但查询和文档在编码时"互相看不见"，细粒度的匹配信息会丢失。

**Cross-Encoder（交叉编码器）** 把"查询 + 文档"拼在一起输入模型，直接输出一个相关性分数。模型能逐词对比两者，精度明显更高；代价是每个（查询，文档）对都要跑一次模型，无法预先计算。

```text
Bi-Encoder（召回）                         Cross-Encoder（重排）
  查询 ──► 编码器 ──► 向量 q                 [查询] [SEP] [文档] ──► 编码器 ──► 相关性分数
  文档 ──► 编码器 ──► 向量 d                   每个候选文档都要跑一次
  score = cos(q, d)，文档向量可离线计算         只适合对少量候选打分
```

| | Bi-Encoder | Cross-Encoder |
| --- | --- | --- |
| 精度 | 中 | 高 |
| 速度 | 快，文档向量预计算 + ANN | 慢，O(候选数) 次模型推理 |
| 适用阶段 | 第一阶段：从百万级中召回几十条 | 第二阶段：从几十条中选出最好的几条 |

所以标准架构是**两阶段检索**：先用便宜的方法（BM25 + 向量）广撒网召回 Top-50，再用贵的 Cross-Encoder 精排出 Top-5。

### 重排模型的选择

- **开源模型自部署**：如 BAAI 的 `bge-reranker` 系列（对中文支持较好）、`cross-encoder/ms-marco-MiniLM-L-6-v2`（英文、轻量）。可以用 `sentence-transformers` 加载。
- **API 服务**：Cohere Rerank、Jina Reranker，以及国内部分云厂商提供的 rerank 接口。接入简单，按调用计费。
- **LLM 重排**：让大模型对候选打分或排序。灵活，可以理解复杂意图，但慢且贵，一般只在候选很少时使用。

下面是用 `sentence-transformers` 做重排的示例（仅 Python，首次运行会从 Hugging Face 下载模型）：

```python [Python]
# pip install sentence-transformers
from sentence_transformers import CrossEncoder

model = CrossEncoder("BAAI/bge-reranker-base", max_length=512)

query = "错误码 E1024 怎么处理"
candidates = [
    "错误码 E1025 表示磁盘空间不足。",
    "错误码 E1024 表示数据库连接超时，请检查网络和连接池配置。",
    "常见故障排查流程：先查看日志，再检查配置。",
]
scores = model.predict([(query, doc) for doc in candidates])  # 每个 (查询, 文档) 对一个分数
for score, doc in sorted(zip(scores, candidates), reverse=True):
    print(f"{score:.3f}  {doc}")
```

模型名称以 Hugging Face 上的实际仓库为准，API 以 sentence-transformers 官方文档为准。

## 参数怎么定

| 参数 | 常见起点 | 调整方向 |
| --- | --- | --- |
| 每路召回数 | 20~50 | 召回率不够就加大，但重排耗时随之线性增长 |
| RRF 的 k | 60 | 一般不用调 |
| 重排后保留数 | 3~8 | 看答案通常需要几个片段，以及上下文预算 |
| 重排分数阈值 | 视模型而定 | 低于阈值的直接丢弃，宁缺毋滥，配合"查不到就说不知道" |

这些参数都应该在评估集上确定，而不是凭感觉，见 [RAG 评估](/guide/09-rag/rag-eval)。

## 常见坑

- **中文 BM25 不分词**：整句当作一个词，关键词检索形同虚设。
- **直接相加原始分数**：BM25 和余弦相似度的量纲不同，加权融合前必须归一化，或者直接用 RRF。
- **RRF 前去重不一致**：同一个块在两路结果里的 ID 必须一致，否则会被当成两个文档，无法得到"共识"加分。
- **重排候选太多**：对 500 个候选做 Cross-Encoder 打分，延迟会大到不可接受。重排的输入一般控制在几十条。
- **重排模型与语言不匹配**：英文训练的重排模型处理中文效果很差，要选支持中文或多语言的模型。
- **只看最终答案**：加了重排之后，要单独评估"重排前后 Top-5 的召回率"，确认它真的带来了提升。

## 小测

**1.** 用户搜索"订单号 20240615001 的物流"，纯向量检索可能出现什么问题？如何解决？

::: details 查看答案
订单号这类精确字符串在向量空间中区分度很低，可能召回其他订单号相近的文档。解决方法是引入关键词检索（BM25）做混合检索，或者把订单号识别出来作为结构化过滤条件，更好的做法是通过工具直接查询订单系统。
:::

**2.** 某文档在 BM25 结果中排第 1，在向量结果中没有出现；另一文档在两路中都排第 3。用 k=60 的 RRF，谁的分数更高？

::: details 查看答案
第一个：1/(60+1) ≈ 0.01639；第二个：1/(60+3) + 1/(60+3) ≈ 0.03175。第二个更高，体现了 RRF 奖励多路共识的特点。
:::

**3.** 为什么不直接用 Cross-Encoder 对整个知识库做检索？

::: details 查看答案
Cross-Encoder 必须把查询和每个文档拼在一起推理，无法预先计算文档表示。对百万级文档库，每次查询都要做百万次模型推理，延迟和成本不可接受。所以它只适合在第一阶段召回的少量候选上做精排。
:::

## 延伸阅读

- [Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods](https://dl.acm.org/doi/10.1145/1571941.1572114)：RRF 原始论文（SIGIR 2009）
- [Elasticsearch 文档：Reciprocal rank fusion](https://www.elastic.co/guide/en/elasticsearch/reference/current/rrf.html)
- [sentence-transformers 文档](https://www.sbert.net/)
- [rank_bm25（GitHub）](https://github.com/dorianbrown/rank_bm25)、[jieba（GitHub）](https://github.com/fxsjy/jieba)
- 本站：[向量数据库](/guide/09-rag/vector-db)、[GraphRAG 与 Agentic RAG](/guide/09-rag/advanced-rag)

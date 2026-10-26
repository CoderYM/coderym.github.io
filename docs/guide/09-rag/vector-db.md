---
title: 向量数据库
description: ANN 索引的原理、距离度量的选择，以及 Chroma、Milvus、Qdrant、pgvector、Elasticsearch/OpenSearch 的对比与上手。
---

# 向量数据库

::: info 学习目标
- 理解为什么需要 ANN（近似最近邻）索引，以及 HNSW、IVF、PQ 的基本思路
- 知道余弦相似度、内积、欧氏距离的区别和选择方法
- 能根据规模、运维能力和现有技术栈选择向量库
- 用 Chroma 和 pgvector 完成写入、过滤和检索（Python）
:::

## 从暴力检索到 ANN

[RAG 全景](/guide/09-rag/overview) 里的最小实现是暴力检索：查询向量和每个文档向量都算一遍相似度。计算量是 N × d（N 为文档数，d 为向量维度）。按 100 万个 1536 维向量估算，一次查询要做约 15 亿次乘加运算，加上内存占用（100 万 × 1536 × 4 字节 ≈ 6 GB），在线服务很难承受。

向量数据库的核心是 **ANN（Approximate Nearest Neighbor）索引**：牺牲一点准确率（可能漏掉个别真正最近的向量），换取数量级的速度提升。常见的三类：

```text
HNSW（分层可导航小世界图）
  第 2 层:  A ───────────── F              稀疏的"高速公路"，大步跳跃
  第 1 层:  A ──── C ────── F ──── H
  第 0 层:  A ─ B ─ C ─ D ─ E ─ F ─ G ─ H   全部节点，局部精细搜索
  查询从顶层入口出发，每层贪心走向更近的邻居，再下到下一层

IVF（倒排文件）
  先用 k-means 把向量聚成若干簇，查询时只搜索最近的几个簇

PQ（乘积量化）
  把向量切成多段并分别量化成编码，大幅压缩内存，常与 IVF 组合（IVF-PQ）
```

| 索引 | 速度 | 召回率 | 内存 | 特点 |
| --- | --- | --- | --- | --- |
| Flat（暴力） | 慢 | 100% | 高 | 小数据集、作为评估基准 |
| HNSW | 很快 | 高 | 高（要存图结构） | 最常用的默认选择 |
| IVF | 快 | 中高，取决于搜索的簇数 | 中 | 需要训练聚类，适合大规模 |
| IVF-PQ | 快 | 中 | 很低 | 超大规模、内存受限 |

ANN 索引都有参数控制"速度 vs 召回率"，例如 HNSW 的 `M`（每个节点的邻居数）、`ef_construction`（建索引时的搜索宽度）和 `ef_search`（查询时的搜索宽度）。入门时用默认值即可，规模大了再在评估集上调。

## 距离度量怎么选

| 度量 | 含义 | 何时使用 |
| --- | --- | --- |
| 余弦相似度（cosine） | 只看方向，不看长度 | 文本 Embedding 最常用的选择 |
| 内积（dot / IP） | 方向和长度都影响 | 向量已归一化时与余弦等价，计算更快 |
| 欧氏距离（L2） | 空间中的直线距离 | 图像等部分场景；归一化后与余弦排序一致 |

最稳妥的原则：**使用 Embedding 模型文档推荐的度量**。许多文本 Embedding 模型输出的向量已经归一化，这时三种度量的排序结果一致。另外注意，有的数据库返回的是"距离"（越小越相似，例如余弦距离 = 1 − 余弦相似度），有的返回"相似度"（越大越相似），不要把阈值方向弄反。

## 主流方案对比

| | Chroma | Milvus | Qdrant | pgvector | Elasticsearch / OpenSearch |
| --- | --- | --- | --- | --- | --- |
| 形态 | 开源，可嵌入进程，也可独立部署 | 开源分布式向量数据库，有托管版（Zilliz Cloud） | 开源（Rust 编写），单机 / 集群，有托管版 | PostgreSQL 扩展 | 全文搜索引擎，内置向量检索 |
| 上手难度 | 最低，`pip install` 即用 | 中，集群版组件较多；有轻量的 Milvus Lite | 低，单个 Docker 容器即可启动 | 低（已有 PG 的话） | 中，需要熟悉 ES 生态 |
| 规模 | 中小规模 | 大规模（十亿级），支持多种索引和 GPU | 中大规模 | 中等规模，百万到千万级较常见 | 中大规模 |
| 元数据过滤 | 支持 | 支持，标量过滤丰富 | 强，payload 过滤是其特色 | 完整 SQL，可与业务表 JOIN | 强，复用 ES 查询 DSL |
| 混合检索 | 有限 | 支持稀疏向量和全文检索 | 支持稀疏向量 | 需配合 PG 全文检索或扩展自行组合 | 原生 BM25 + 向量，最成熟 |
| 多语言 SDK | Python、JS 为主 | Python、Go、Java、Node 等 | Python、Go、Java、Rust、JS 等 | 任何 PG 驱动 | 各语言官方客户端 |
| 适合 | 原型、个人项目、教学 | 大规模专用向量检索平台 | 中大规模、过滤需求多 | 已有 PG、希望少运维一个组件 | 已有 ES、重视关键词检索 |

各项目功能迭代很快，表中是定位层面的概括，具体能力以官方文档为准。此外还有 FAISS（Meta 开源的向量检索**库**，不是数据库，没有持久化和服务化能力）、Redis、Weaviate、各云厂商的托管服务等。

**选型建议**：

- **学习和原型**：Chroma，或者干脆用内存 + NumPy，先把切分和评估跑通。
- **已经在用 PostgreSQL**：优先考虑 pgvector。少一个组件，数据和业务表在一起，事务、备份、权限都复用现有体系。
- **已经在用 Elasticsearch / OpenSearch**：直接用它的向量能力，混合检索最方便。
- **数据量很大或检索是核心业务**：Milvus 或 Qdrant 这类专用向量数据库。

向量库很少是 RAG 的瓶颈。**切分、检索策略和评估对效果的影响，通常远大于换一个向量库**。

## 动手一：Chroma（Python）

Chroma 主要面向 Python 和 JavaScript，所以这一节只提供 Python 版本。Go 和 Java 项目可以选择 Qdrant、Milvus 的官方 SDK，或者直接用 pgvector。

```bash
pip install chromadb openai
```

我们自己调用 Embedding 接口得到向量，再交给 Chroma 存储，这样 Embedding 模型可以随意替换。Chroma 也支持配置内置的 embedding function，这里不展开。

```python [Python]
import os

import chromadb
from openai import OpenAI

oai = OpenAI(api_key=os.environ["OPENAI_API_KEY"], base_url=os.getenv("OPENAI_BASE_URL"), timeout=60)
EMBED_MODEL = os.getenv("EMBEDDING_MODEL", "text-embedding-3-small")


def embed(texts: list[str]) -> list[list[float]]:
    resp = oai.embeddings.create(model=EMBED_MODEL, input=texts)
    return [d.embedding for d in resp.data]


# 数据持久化到本地目录；PersistentClient 是 Chroma 的嵌入式客户端
db = chromadb.PersistentClient(path="./chroma_data")
col = db.get_or_create_collection(
    name="policies",
    metadata={"hnsw:space": "cosine"},  # 使用余弦距离；新版本也可通过 configuration 参数设置
)

docs = [
    ("travel-1", "国内出差住宿标准为一线城市每晚 600 元，其他城市每晚 400 元。", "finance"),
    ("travel-2", "差旅报销需在出差结束后 30 天内通过 OA 系统提交。", "finance"),
    ("hr-1", "入职满一年的员工享有 5 天带薪年假。", "hr"),
]
col.upsert(  # upsert：id 已存在则更新，便于重复导入
    ids=[d[0] for d in docs],
    documents=[d[1] for d in docs],
    embeddings=embed([d[1] for d in docs]),
    metadatas=[{"department": d[2]} for d in docs],
)

res = col.query(
    query_embeddings=embed(["去上海出差住酒店能报多少"]),
    n_results=2,
    where={"department": "finance"},  # 元数据过滤：只在财务类文档里检索
)
# 结果按查询分组，每个字段都是"列表的列表"；distances 是余弦距离，越小越相似
for doc_id, doc, dist in zip(res["ids"][0], res["documents"][0], res["distances"][0]):
    print(f"{dist:.3f}  {doc_id}  {doc}")
```

API 以 [Chroma 官方文档](https://docs.trychroma.com/) 为准，不同大版本之间的配置方式有过调整。

## 动手二：pgvector（SQL + Python）

pgvector 的好处是"只是 SQL"，任何语言的 PostgreSQL 驱动都能用（Go 用 `pgx`，Java 用 JDBC），下面的 SQL 是通用的。可以用官方镜像 `pgvector/pgvector` 在本地启动一个带扩展的 PostgreSQL。

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS chunks (
    id         bigserial PRIMARY KEY,
    source     text NOT NULL,
    department text NOT NULL,
    content    text NOT NULL,
    embedding  vector(1536) NOT NULL      -- 维度必须与 Embedding 模型一致
);

-- HNSW 索引，vector_cosine_ops 对应余弦距离
CREATE INDEX IF NOT EXISTS chunks_embedding_idx
    ON chunks USING hnsw (embedding vector_cosine_ops);

-- <=> 是余弦距离运算符（<-> 为 L2 距离，<#> 为负内积）
SELECT id, content, embedding <=> $1 AS distance
FROM chunks
WHERE department = 'finance'
ORDER BY embedding <=> $1
LIMIT 5;
```

Python 端用 `psycopg`（v3）。向量以 `'[0.1,0.2,...]'` 文本形式传参，再在 SQL 里 `::vector` 转换，不依赖额外的包；也可以使用 `pgvector` 官方提供的 Python 适配包。

```python [Python]
import os

import psycopg
from openai import OpenAI

oai = OpenAI(api_key=os.environ["OPENAI_API_KEY"], base_url=os.getenv("OPENAI_BASE_URL"), timeout=60)
EMBED_MODEL = os.getenv("EMBEDDING_MODEL", "text-embedding-3-small")


def embed_one(text: str) -> str:
    vec = oai.embeddings.create(model=EMBED_MODEL, input=[text]).data[0].embedding
    return "[" + ",".join(f"{x:.6f}" for x in vec) + "]"  # pgvector 的文本格式


# 例如 postgresql://user:pass@localhost:5432/rag，连接串放在环境变量里，不要写进代码
with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
    conn.execute(
        "INSERT INTO chunks (source, department, content, embedding) VALUES (%s, %s, %s, %s::vector)",
        ("差旅管理办法.pdf", "finance", "国内出差住宿标准为一线城市每晚 600 元。", embed_one("国内出差住宿标准为一线城市每晚 600 元。")),
    )
    rows = conn.execute(
        """SELECT content, embedding <=> %s::vector AS distance
           FROM chunks WHERE department = %s
           ORDER BY distance LIMIT %s""",
        (embed_one("上海出差住宿能报多少"), "finance", 5),  # 全部参数化，避免 SQL 注入
    ).fetchall()
    for content, distance in rows:
        print(f"{distance:.3f}  {content}")
```

注意：带 `WHERE` 过滤的 ANN 查询，可能出现"先取近邻、再过滤，结果不足 LIMIT 条"的情况。pgvector 提供了相关参数（如 HNSW 的 `ef_search`、迭代扫描等）来缓解，具体以 [pgvector 文档](https://github.com/pgvector/pgvector) 为准。

## 生产中的几个问题

- **增量更新与删除**：文档修改后，按 `source` 删除旧块，再写入新块。每个块都要有稳定的 ID 和来源字段。
- **Embedding 模型升级**：新旧模型的向量不可混用。常见做法是新建一个集合 / 表，后台全量重建，切流后再删除旧的。
- **多租户隔离**：按租户分集合，或在每条记录上加 `tenant_id` 并在所有查询中强制过滤。后者实现更简单，但要确保过滤条件不会被遗漏。
- **备份与恢复**：向量可以从原文重新计算，但成本不低。原文和元数据一定要有可靠备份。

## 常见坑

- **维度不匹配**：表结构写了 `vector(1536)`，换了一个 1024 维的模型，写入直接报错。维度跟着模型走。
- **度量和索引不一致**：建索引用 L2，查询用余弦，索引可能用不上，或者结果不符合预期。
- **距离和相似度方向搞反**：Chroma、pgvector 返回的是距离（越小越相似），设置阈值时别写反。
- **过早优化**：几万条数据就上分布式集群。先用最简单的方案，测出瓶颈再升级。
- **只存向量不存原文**：检索出来只有 ID，还要回源查询；原文丢失后也无法用新模型重建索引。

## 小测

**1.** HNSW 为什么比暴力检索快？代价是什么？

::: details 查看答案
HNSW 构建了分层的近邻图，查询时从顶层稀疏图出发贪心地逼近目标，再逐层细化，只需访问很少的节点，而不是计算全部 N 个向量。代价是结果是近似的（可能漏掉少量真正的近邻），以及需要额外内存存储图结构、建索引需要时间。
:::

**2.** 团队已经用 PostgreSQL 存业务数据，知识库约 50 万个块，是否需要单独引入一个向量数据库？

::: details 查看答案
通常不需要，优先考虑 pgvector。这个规模在 pgvector + HNSW 的能力范围内，还能和业务表 JOIN、复用现有的权限、备份和运维体系。当规模或性能需求明显超出时，再评估专用向量库。
:::

**3.** 为什么更换 Embedding 模型后必须重建索引？

::: details 查看答案
不同模型的向量空间不同（维度可能也不同），旧模型生成的文档向量和新模型生成的查询向量之间计算相似度没有意义，检索结果会完全错乱。
:::

## 延伸阅读

- [HNSW 论文](https://arxiv.org/abs/1603.09320)
- [Chroma 文档](https://docs.trychroma.com/)、[Milvus 文档](https://milvus.io/docs)、[Qdrant 文档](https://qdrant.tech/documentation/)
- [pgvector（GitHub）](https://github.com/pgvector/pgvector)
- [FAISS（GitHub）](https://github.com/facebookresearch/faiss)
- 本站：[混合检索与重排](/guide/09-rag/hybrid-rerank)

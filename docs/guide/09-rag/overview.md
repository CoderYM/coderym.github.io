---
title: RAG 全景
description: RAG 的完整流程、与微调和长上下文的取舍，以及一个不依赖任何向量库的最小实现。
---

# RAG 全景

::: info 学习目标
- 理解 RAG 解决什么问题，以及它和微调、长上下文的区别
- 掌握"离线索引 + 在线检索生成"的完整流程和每个环节的作用
- 用 Embedding 接口和余弦相似度，从零实现一个最小 RAG（Python / Go / Java）
- 建立整个模块的知识地图，知道后续每篇解决哪个环节的问题
:::

## RAG 解决什么问题

大模型有三个先天短板：

1. **知识有截止日期**：训练数据之后发生的事，它不知道。
2. **不知道你的私有数据**：公司制度、产品文档、内部代码，它从没见过。
3. **会一本正经地编**：不知道答案时，经常生成看起来合理但错误的内容（幻觉）。

RAG（Retrieval-Augmented Generation，检索增强生成）的思路很直接：**回答问题前，先去资料库里把相关内容找出来，放进 prompt，让模型"开卷考试"**。这个名字来自 2020 年 Meta 的同名论文（见 [RAG 原始论文解读](/papers/rag)），但今天工程上说的 RAG 已经泛指"检索 + 生成"这一大类架构。

## 完整流程

```text
━━━━━━━━━━━━━━━━━━━━━ 离线：索引（Indexing）━━━━━━━━━━━━━━━━━━━━━
  PDF / Word / 网页 / 数据库
        │ ① 解析：提取纯文本、表格、标题结构
        ▼
     文本 ──② 切分──►  chunk_1, chunk_2, ... chunk_n
                           │ ③ Embedding
                           ▼
                     向量 + 原文 + 元数据 ──④ 写入──► 向量库 / 全文索引

━━━━━━━━━━━━━━━━━━━━━ 在线：检索与生成（Query）━━━━━━━━━━━━━━━━━━━
  用户问题
     │ ⑤ 查询处理：改写、扩展、过滤条件
     ▼
  检索 Top-K（向量 / 关键词 / 混合）──⑥ 重排──► Top-N 片段
                                                │ ⑦ 组装 prompt
                                                ▼
                                       LLM 生成回答 + 引用出处
```

| 环节 | 决定了什么 | 本模块对应文章 |
| --- | --- | --- |
| 解析与切分 | 检索的最小单位是否完整、干净 | [文档解析与切分](/guide/09-rag/chunking) |
| Embedding 与存储 | 语义能否被正确表示和快速查找 | [向量数据库](/guide/09-rag/vector-db) |
| 检索与重排 | 能否把真正相关的内容排到前面 | [混合检索与重排](/guide/09-rag/hybrid-rerank) |
| 高级架构 | 跨文档、多跳、全局性问题 | [GraphRAG 与 Agentic RAG](/guide/09-rag/advanced-rag) |
| 评估 | 到底是检索错了还是生成错了 | [RAG 评估](/guide/09-rag/rag-eval) |

一个反复被验证的经验：**RAG 的效果上限由检索决定**。资料没检索出来，模型再强也答不对。所以优化 RAG 时，应该先看检索结果，再看生成。

## RAG、微调还是长上下文

| | RAG | 微调（Fine-tuning） | 长上下文直接塞 |
| --- | --- | --- | --- |
| 适合解决 | 让模型"知道"大量、常更新的事实 | 让模型学会某种格式、风格、领域表达 | 资料量小、一次性分析 |
| 知识更新 | 改文档、重建索引即可，分钟级 | 需要重新训练 | 每次请求都带上 |
| 可追溯 | 能给出引用出处 | 不能 | 能，但资料多时难定位 |
| 成本 | 检索基础设施 + 每次少量 Token | 训练成本 + 数据准备 | 每次请求的 Token 成本高 |
| 规模上限 | 几乎无上限 | 与知识量关系不大 | 受窗口限制 |

简单判断：**要模型"知道什么"，用 RAG；要模型"会做什么"，考虑微调；资料少到能直接放进窗口，就先别折腾**。长上下文模型越来越普及，但在资料达到成千上万份文档、需要权限过滤、需要控制成本的场景下，检索依然不可替代。

## 动手：最小 RAG

先不引入任何向量库和框架，只用两个接口：

- `POST /embeddings`：把文本变成向量（原理见 [Embedding 与向量语义](/guide/02-llm-basics/embeddings)）
- `POST /chat/completions`：生成回答

检索就是**暴力计算**查询向量和每个文档向量的余弦相似度，排序取 Top-K。几千条文档以内，这完全够用。

环境变量在之前的基础上多一个 `EMBEDDING_MODEL`。注意：不是所有厂商都提供 Embedding 接口，也不是所有兼容接口都支持同样的模型名。如果你的聊天模型厂商没有 Embedding 服务，需要单独配置一个提供 Embedding 的服务（示例为简单起见共用同一个 `OPENAI_BASE_URL`）。

```bash
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
EMBEDDING_MODEL=text-embedding-3-small
```

::: code-group
```python [Python]
import math
import os

from openai import OpenAI

client = OpenAI(
    api_key=os.environ["OPENAI_API_KEY"],
    base_url=os.getenv("OPENAI_BASE_URL"),
    timeout=60,
)
CHAT_MODEL = os.getenv("LLM_MODEL", "gpt-4o-mini")
EMBED_MODEL = os.getenv("EMBEDDING_MODEL", "text-embedding-3-small")

DOCS = [
    "差旅报销：国内出差住宿标准为一线城市每晚 600 元，其他城市每晚 400 元。",
    "差旅报销需在出差结束后 30 天内通过 OA 系统提交，逾期不予受理。",
    "年假：入职满一年的员工享有 5 天带薪年假，满十年为 10 天。",
    "办公设备：新员工入职当天由 IT 部门发放笔记本电脑，离职时需归还。",
    "加班：工作日加班可申请调休，调休需在三个月内使用完毕。",
]


def embed(texts: list[str]) -> list[list[float]]:
    resp = client.embeddings.create(model=EMBED_MODEL, input=texts)
    return [d.embedding for d in resp.data]


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0

class VectorIndex:
    """最小的内存向量索引：暴力计算查询与每个文档的余弦相似度。"""

    def __init__(self) -> None:
        self.texts: list[str] = []
        self.vectors: list[list[float]] = []

    def add(self, texts: list[str]) -> None:
        self.texts.extend(texts)
        self.vectors.extend(embed(texts))

    def search(self, query: str, k: int = 3) -> list[tuple[float, str]]:
        qv = embed([query])[0]
        scored = [(cosine(qv, v), t) for v, t in zip(self.vectors, self.texts)]
        scored.sort(key=lambda x: x[0], reverse=True)
        return scored[:k]


def answer(index: VectorIndex, question: str) -> str:
    hits = index.search(question, k=2)
    context = "\n".join(f"[{i + 1}] {text}" for i, (_, text) in enumerate(hits))
    resp = client.chat.completions.create(
        model=CHAT_MODEL,
        messages=[
            {"role": "system", "content": "你是公司制度问答助手。只根据给定资料回答，并用 [编号] 标注出处；"
                                          "资料里没有的信息，直接回答“资料中没有相关信息”。"},
            {"role": "user", "content": f"资料：\n{context}\n\n问题：{question}"},
        ],
        temperature=0,
    )
    return resp.choices[0].message.content or ""


if __name__ == "__main__":
    index = VectorIndex()
    index.add(DOCS)
    question = "去上海出差住酒店，一晚最多能报多少？"
    for score, text in index.search(question, k=2):
        print(f"{score:.3f}  {text}")
    print("----")
    print(answer(index, question))
```

```go [Go]
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"
)

var docs = []string{
	"差旅报销：国内出差住宿标准为一线城市每晚 600 元，其他城市每晚 400 元。",
	"差旅报销需在出差结束后 30 天内通过 OA 系统提交，逾期不予受理。",
	"年假：入职满一年的员工享有 5 天带薪年假，满十年为 10 天。",
	"办公设备：新员工入职当天由 IT 部门发放笔记本电脑，离职时需归还。",
	"加班：工作日加班可申请调休，调休需在三个月内使用完毕。",
}

var httpClient = &http.Client{Timeout: 60 * time.Second}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// post 向 OpenAI 兼容接口发送 JSON 请求并解析响应
func post(path string, payload any, out any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	url := strings.TrimRight(getenv("OPENAI_BASE_URL", "https://api.openai.com/v1"), "/") + path
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+os.Getenv("OPENAI_API_KEY"))
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, data)
	}
	return json.Unmarshal(data, out)
}

func embed(texts []string) ([][]float64, error) {
	var out struct {
		Data []struct {
			Index     int       `json:"index"`
			Embedding []float64 `json:"embedding"`
		} `json:"data"`
	}
	err := post("/embeddings", map[string]any{
		"model": getenv("EMBEDDING_MODEL", "text-embedding-3-small"),
		"input": texts,
	}, &out)
	if err != nil {
		return nil, err
	}
	if len(out.Data) != len(texts) {
		return nil, errors.New("embedding 数量与输入不一致")
	}
	vecs := make([][]float64, len(texts))
	for _, d := range out.Data {
		if d.Index < 0 || d.Index >= len(texts) {
			return nil, errors.New("embedding index 越界")
		}
		vecs[d.Index] = d.Embedding // 按 index 放回，保证与输入顺序一致
	}
	return vecs, nil
}

func cosine(a, b []float64) float64 {
	var dot, na, nb float64
	for i := range a {
		dot += a[i] * b[i]
		na += a[i] * a[i]
		nb += b[i] * b[i]
	}
	if na == 0 || nb == 0 {
		return 0
	}
	return dot / (math.Sqrt(na) * math.Sqrt(nb))
}

type Hit struct {
	Score float64
	Text  string
}

// VectorIndex 最小的内存向量索引：暴力计算查询与每个文档的余弦相似度
type VectorIndex struct {
	texts   []string
	vectors [][]float64
}

func (ix *VectorIndex) Add(texts []string) error {
	vecs, err := embed(texts)
	if err != nil {
		return err
	}
	ix.texts = append(ix.texts, texts...)
	ix.vectors = append(ix.vectors, vecs...)
	return nil
}

func (ix *VectorIndex) Search(query string, k int) ([]Hit, error) {
	qv, err := embed([]string{query})
	if err != nil {
		return nil, err
	}
	hits := make([]Hit, len(ix.texts))
	for i, v := range ix.vectors {
		hits[i] = Hit{Score: cosine(qv[0], v), Text: ix.texts[i]}
	}
	sort.Slice(hits, func(i, j int) bool { return hits[i].Score > hits[j].Score })
	return hits[:min(k, len(hits))], nil
}

func answer(ix *VectorIndex, question string) (string, error) {
	hits, err := ix.Search(question, 2)
	if err != nil {
		return "", err
	}
	var ctx strings.Builder
	for i, h := range hits {
		fmt.Fprintf(&ctx, "[%d] %s\n", i+1, h.Text)
	}
	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	err = post("/chat/completions", map[string]any{
		"model":       getenv("LLM_MODEL", "gpt-4o-mini"),
		"temperature": 0,
		"messages": []map[string]string{
			{"role": "system", "content": "你是公司制度问答助手。只根据给定资料回答，并用 [编号] 标注出处；" +
				"资料里没有的信息，直接回答“资料中没有相关信息”。"},
			{"role": "user", "content": "资料：\n" + ctx.String() + "\n问题：" + question},
		},
	}, &out)
	if err != nil {
		return "", err
	}
	if len(out.Choices) == 0 {
		return "", errors.New("empty choices")
	}
	return out.Choices[0].Message.Content, nil
}

func main() {
	ix := &VectorIndex{}
	if err := ix.Add(docs); err != nil {
		fmt.Fprintln(os.Stderr, "建索引失败:", err)
		os.Exit(1)
	}
	question := "去上海出差住酒店，一晚最多能报多少？"
	hits, err := ix.Search(question, 2)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	for _, h := range hits {
		fmt.Printf("%.3f  %s\n", h.Score, h.Text)
	}
	fmt.Println("----")
	ans, err := answer(ix, question)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println(ans)
}
```

```java [Java]
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;

public class Main {
    record Hit(double score, String text) {}

    static final ObjectMapper MAPPER = new ObjectMapper();
    static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    static final List<String> DOCS = List.of(
            "差旅报销：国内出差住宿标准为一线城市每晚 600 元，其他城市每晚 400 元。",
            "差旅报销需在出差结束后 30 天内通过 OA 系统提交，逾期不予受理。",
            "年假：入职满一年的员工享有 5 天带薪年假，满十年为 10 天。",
            "办公设备：新员工入职当天由 IT 部门发放笔记本电脑，离职时需归还。",
            "加班：工作日加班可申请调休，调休需在三个月内使用完毕。");

    static String env(String key, String def) {
        String v = System.getenv(key);
        return (v == null || v.isBlank()) ? def : v;
    }

    /** 向 OpenAI 兼容接口发送 JSON 请求 */
    static JsonNode post(String path, Object payload) throws Exception {
        String base = env("OPENAI_BASE_URL", "https://api.openai.com/v1").replaceAll("/+$", "");
        HttpRequest req = HttpRequest.newBuilder(URI.create(base + path))
                .timeout(Duration.ofSeconds(60))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + System.getenv("OPENAI_API_KEY"))
                .POST(HttpRequest.BodyPublishers.ofString(MAPPER.writeValueAsString(payload)))
                .build();
        HttpResponse<String> resp = HTTP.send(req, HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() != 200) {
            throw new RuntimeException("HTTP " + resp.statusCode() + ": " + resp.body());
        }
        return MAPPER.readTree(resp.body());
    }

    static List<double[]> embed(List<String> texts) throws Exception {
        JsonNode data = post("/embeddings", Map.of(
                "model", env("EMBEDDING_MODEL", "text-embedding-3-small"),
                "input", texts)).path("data");
        if (data.size() != texts.size()) throw new IllegalStateException("embedding 数量与输入不一致");
        double[][] vecs = new double[texts.size()][];
        for (JsonNode d : data) {
            JsonNode emb = d.path("embedding");
            double[] v = new double[emb.size()];
            for (int i = 0; i < v.length; i++) v[i] = emb.get(i).asDouble();
            vecs[d.path("index").asInt()] = v; // 按 index 放回，保证与输入顺序一致
        }
        return List.of(vecs);
    }

    static double cosine(double[] a, double[] b) {
        double dot = 0, na = 0, nb = 0;
        for (int i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            na += a[i] * a[i];
            nb += b[i] * b[i];
        }
        return (na == 0 || nb == 0) ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
    }

    /** 最小的内存向量索引：暴力计算查询与每个文档的余弦相似度 */
    static class VectorIndex {
        final List<String> texts = new ArrayList<>();
        final List<double[]> vectors = new ArrayList<>();

        void add(List<String> newTexts) throws Exception {
            vectors.addAll(embed(newTexts));
            texts.addAll(newTexts);
        }

        List<Hit> search(String query, int k) throws Exception {
            double[] qv = embed(List.of(query)).get(0);
            List<Hit> hits = new ArrayList<>();
            for (int i = 0; i < texts.size(); i++) {
                hits.add(new Hit(cosine(qv, vectors.get(i)), texts.get(i)));
            }
            hits.sort(Comparator.comparingDouble(Hit::score).reversed());
            return hits.subList(0, Math.min(k, hits.size()));
        }
    }

    static String answer(VectorIndex index, String question) throws Exception {
        List<Hit> hits = index.search(question, 2);
        StringBuilder ctx = new StringBuilder();
        for (int i = 0; i < hits.size(); i++) {
            ctx.append("[").append(i + 1).append("] ").append(hits.get(i).text()).append("\n");
        }
        JsonNode resp = post("/chat/completions", Map.of(
                "model", env("LLM_MODEL", "gpt-4o-mini"),
                "temperature", 0,
                "messages", List.of(
                        Map.of("role", "system", "content", "你是公司制度问答助手。只根据给定资料回答，并用 [编号] 标注出处；"
                                + "资料里没有的信息，直接回答“资料中没有相关信息”。"),
                        Map.of("role", "user", "content", "资料：\n" + ctx + "\n问题：" + question))));
        return resp.path("choices").path(0).path("message").path("content").asText("");
    }

    public static void main(String[] args) throws Exception {
        VectorIndex index = new VectorIndex();
        index.add(DOCS);
        String question = "去上海出差住酒店，一晚最多能报多少？";
        for (Hit h : index.search(question, 2)) {
            System.out.printf("%.3f  %s%n", h.score(), h.text());
        }
        System.out.println("----");
        System.out.println(answer(index, question));
    }
}
```
:::

运行后，排在第一的应该是住宿标准那条。注意问题里说的是"上海"和"酒店"，文档里写的是"一线城市"和"住宿"，**字面上没有重合，语义上却匹配**，这就是向量检索相对关键词检索的优势。模型拿到资料后，应该回答"600 元"并标注 `[1]`。

这段代码虽小，但已经包含了 RAG 的骨架。几个值得注意的点：

- **批量 Embedding**：建索引时一次传入多条文本，比逐条调用快得多。批量大小有上限，大规模数据需要分批。
- **按 `index` 对齐**：Embedding 接口返回的每一项带 `index` 字段，Go 和 Java 版本按它放回原位，不依赖返回顺序。
- **提示词约束**：要求"只根据资料回答""资料里没有就说没有""标注出处"，这三条是 RAG 提示词的基本要素，能明显减少幻觉。
- **暴力检索的复杂度**是 O(N × 维度)。几千条文档毫秒级完成；到了几十万、上百万条，就需要 ANN 索引和向量数据库，见 [向量数据库](/guide/09-rag/vector-db)。

## 从 Demo 到生产还差什么

| Demo 里 | 生产中要考虑 |
| --- | --- |
| 5 句写死的文本 | PDF、Word、网页、表格的解析，以及合理切分 |
| 内存里的列表 | 持久化、增量更新、删除，以及百万级检索性能 |
| 纯向量检索 | 型号、错误码等精确词需要关键词检索补充 |
| 取 Top-2 直接用 | 召回更多候选，再用重排模型精选 |
| 所有人看同一份资料 | 按部门、角色做权限过滤 |
| 看一眼觉得"挺准" | 构建评估集，量化召回率和回答忠实度 |

## 常见坑

- **索引和查询用了不同的 Embedding 模型**：不同模型的向量空间不兼容，相似度没有意义。换模型必须全量重建索引。
- **只调生成不看检索**：回答不对时，先打印检索结果。大部分问题出在没检索到，而不是模型理解错。
- **Top-K 越大越好**：塞进太多无关片段，会稀释关键信息，增加成本，还可能让模型被干扰。一般先召回 20~50 条，重排后取 3~8 条。
- **把检索内容当作可信指令**：文档里可能包含"忽略之前的指令……"之类的文本，这属于间接 Prompt 注入。用分隔符包裹资料，并在提示词里说明资料只是参考内容，见 [Prompt 注入与防护](/guide/15-production/prompt-injection)。
- **不处理"查不到"**：检索结果相似度都很低时，应该直接回答"没有找到相关资料"，而不是让模型硬编。

## 小测

**1.** 公司想让客服机器人掌握 2000 页的产品手册，且手册每月更新。应该选 RAG 还是微调？为什么？

::: details 查看答案
选 RAG。手册内容属于"知识"，量大且频繁更新：RAG 只需重建索引就能更新，还能给出引用出处；微调每次更新都要重新训练，而且不擅长精确记住大量事实，也无法溯源。
:::

**2.** RAG 回答错误时，排查的第一步是什么？

::: details 查看答案
先查看检索结果：正确的资料是否在召回的 Top-K 中。如果不在，是检索问题（切分、Embedding、查询表达、检索策略）；如果在但回答错了，才是生成问题（提示词、上下文顺序、模型能力）。
:::

**3.** 示例中把"上海"和"一线城市"匹配上了，靠的是什么？关键词检索能做到吗？

::: details 查看答案
靠 Embedding 把语义相近的文本映射到向量空间中相近的位置，所以字面不同也能匹配。传统关键词检索（如 BM25）依赖词项重合，做不到，除非额外配置同义词表。反过来，对于型号、编号这类精确匹配，关键词检索更可靠，所以生产中常用混合检索。
:::

## 延伸阅读

- [Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks](https://arxiv.org/abs/2005.11401)：RAG 原始论文
- [OpenAI Embeddings 指南](https://platform.openai.com/docs/guides/embeddings)
- 本站：[Embedding 与向量语义](/guide/02-llm-basics/embeddings)、[实战项目：个人 PDF 知识库](/projects/04-pdf-rag)、[RAG 面试题](/interview/rag)

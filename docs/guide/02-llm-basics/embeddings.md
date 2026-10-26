---
title: Embedding 与向量语义
description: 理解 Embedding 如何把文本变成向量、如何衡量语义相似度，并动手实现一个最小的语义检索。
---

# Embedding 与向量语义

::: info 学习目标
- 理解 Embedding 是什么，以及"语义相近 = 向量相近"的直觉
- 掌握余弦相似度等常用距离度量
- 会调用 Embedding API，并用三种语言实现一个最小语义检索
- 了解 Embedding 在 RAG、记忆、分类、去重中的用途和局限
:::

聊天模型负责"生成"，Embedding 模型负责"理解和比较"。在 Agent 系统里，RAG 检索、长期记忆召回、工具选择、意图分类，背后几乎都有 Embedding 的身影。

## 什么是 Embedding

Embedding 是把一段文本映射成一个固定长度的浮点数向量，例如 1536 维：

```text
"如何重置密码"     →  [0.012, -0.087, 0.231, ..., 0.044]   (1536 个数)
"忘记密码怎么办"   →  [0.015, -0.079, 0.225, ..., 0.051]
"今天股市大涨"     →  [-0.143, 0.062, -0.018, ..., 0.197]
```

Embedding 模型经过专门训练，让**语义相近的文本，向量在空间中也相近**。"如何重置密码"和"忘记密码怎么办"几乎没有相同的字，但它们的向量距离很近；而"今天股市大涨"离它们很远。

可以把它想象成一张高维的"语义地图"：

```text
             ▲
             │     · 忘记密码怎么办
             │   · 如何重置密码
             │      · 账号被锁定了
             │
             │                         · 今天股市大涨
             │                       · 基金收益怎么算
             └──────────────────────────────────────▶
   （真实空间有上千维，这里压缩成二维示意）
```

这和关键词搜索有本质区别：关键词搜索匹配的是"字面"，向量搜索匹配的是"意思"。当然，两者各有所长，后面的 [混合检索与重排](/guide/09-rag/hybrid-rerank) 会讲如何结合。

和 Transformer 的关系：聊天模型内部也会把每个 Token 转成向量，但 Embedding 模型的目标不同。它会把整段文本汇总成一个向量，并专门针对"相似度"进行训练。所以要做检索，应该使用专门的 Embedding 模型，而不是聊天模型。

## 怎么衡量"相近"

最常用的是**余弦相似度**（cosine similarity），即两个向量夹角的余弦值：

```text
cos(A, B) = (A · B) / (|A| × |B|)

取值范围 [-1, 1]
  接近 1   方向几乎一致，语义很接近
  接近 0   基本无关
  负数     方向相反（在文本 Embedding 中较少见）
```

| 度量 | 说明 | 使用场景 |
| --- | --- | --- |
| 余弦相似度 | 只看方向，不看长度 | 文本语义检索的默认选择 |
| 点积（dot product） | 方向和长度都考虑 | 向量已归一化时等价于余弦，计算更快 |
| 欧氏距离（L2） | 空间中的直线距离 | 部分向量数据库的默认度量 |

很多 Embedding 模型输出的向量已经归一化（长度为 1），此时余弦相似度等于点积，排序结果也和欧氏距离一致。用哪个以模型文档的推荐为准。

需要注意，相似度的**绝对数值**在不同模型之间没有可比性。某个模型里 0.8 可能代表"高度相关"，另一个模型里 0.5 就已经很相关了。阈值需要在自己的数据上调。

## 动手：最小语义检索

下面的程序把几条"知识库文档"和一个查询都转成向量，按余弦相似度排序。OpenAI 兼容接口的 Embedding 端点是 `POST /embeddings`，请求体为 `{"model": ..., "input": [...]}`，响应的 `data` 数组里每项有 `index` 和 `embedding`。

不是所有厂商都提供 Embedding 接口（例如有的厂商只提供聊天模型），可以单独为 Embedding 配置一个厂商。这里额外使用环境变量 `EMBEDDING_MODEL`，示例默认值为 `text-embedding-3-small`。

::: code-group
```python [Python]
import math
import os

from openai import OpenAI

DOCS = [
    "忘记密码时，可以在登录页点击“找回密码”，通过手机验证码重置。",
    "会员可以在每月 1 日领取优惠券，有效期 30 天。",
    "订单发货后一般 3 到 5 天送达，偏远地区可能延迟。",
    "账号连续输错密码 5 次会被锁定 30 分钟。",
]


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def main() -> None:
    client = OpenAI(
        api_key=os.environ["OPENAI_API_KEY"],
        base_url=os.getenv("OPENAI_BASE_URL") or None,
        timeout=60,
    )
    model = os.getenv("EMBEDDING_MODEL", "text-embedding-3-small")
    query = "我登不上去了，密码想不起来"

    # 一次请求批量编码：查询放在第 0 个，后面是文档
    resp = client.embeddings.create(model=model, input=[query, *DOCS])
    vectors = [d.embedding for d in sorted(resp.data, key=lambda d: d.index)]
    q_vec, doc_vecs = vectors[0], vectors[1:]
    print(f"向量维度: {len(q_vec)}")

    scored = sorted(
        ((cosine(q_vec, v), doc) for v, doc in zip(doc_vecs, DOCS)), reverse=True
    )
    for score, doc in scored:
        print(f"{score:.3f}  {doc}")


if __name__ == "__main__":
    main()
```

```go [Go]
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"sort"
	"time"
)

var docs = []string{
	"忘记密码时，可以在登录页点击“找回密码”，通过手机验证码重置。",
	"会员可以在每月 1 日领取优惠券，有效期 30 天。",
	"订单发货后一般 3 到 5 天送达，偏远地区可能延迟。",
	"账号连续输错密码 5 次会被锁定 30 分钟。",
}

type embeddingRequest struct {
	Model string   `json:"model"`
	Input []string `json:"input"`
}

type embeddingResponse struct {
	Data []struct {
		Index     int       `json:"index"`
		Embedding []float64 `json:"embedding"`
	} `json:"data"`
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
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

func embed(baseURL, apiKey, model string, input []string) ([][]float64, error) {
	data, err := json.Marshal(embeddingRequest{Model: model, Input: input})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequest(http.MethodPost, baseURL+"/embeddings", bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: 60 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, raw)
	}
	var out embeddingResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	vecs := make([][]float64, len(input))
	for _, d := range out.Data {
		if d.Index < 0 || d.Index >= len(vecs) {
			return nil, fmt.Errorf("unexpected index %d", d.Index)
		}
		vecs[d.Index] = d.Embedding
	}
	return vecs, nil
}

func main() {
	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" {
		log.Fatal("请设置 OPENAI_API_KEY")
	}
	baseURL := getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
	model := getenv("EMBEDDING_MODEL", "text-embedding-3-small")
	query := "我登不上去了，密码想不起来"

	vecs, err := embed(baseURL, apiKey, model, append([]string{query}, docs...))
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println("向量维度:", len(vecs[0]))

	type hit struct {
		score float64
		doc   string
	}
	hits := make([]hit, len(docs))
	for i, doc := range docs {
		hits[i] = hit{cosine(vecs[0], vecs[i+1]), doc}
	}
	sort.Slice(hits, func(i, j int) bool { return hits[i].score > hits[j].score })
	for _, h := range hits {
		fmt.Printf("%.3f  %s\n", h.score, h.doc)
	}
}
```

```java [Java]
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

public class SemanticSearch {
    static final List<String> DOCS = List.of(
            "忘记密码时，可以在登录页点击“找回密码”，通过手机验证码重置。",
            "会员可以在每月 1 日领取优惠券，有效期 30 天。",
            "订单发货后一般 3 到 5 天送达，偏远地区可能延迟。",
            "账号连续输错密码 5 次会被锁定 30 分钟。");

    record EmbeddingRequest(String model, List<String> input) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    record EmbeddingData(int index, double[] embedding) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    record EmbeddingResponse(List<EmbeddingData> data) {}

    record Hit(double score, String doc) {}

    static String getenv(String key, String def) {
        String v = System.getenv(key);
        return (v == null || v.isBlank()) ? def : v;
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

    public static void main(String[] args) throws Exception {
        String apiKey = System.getenv("OPENAI_API_KEY");
        if (apiKey == null || apiKey.isBlank()) {
            throw new IllegalStateException("请设置 OPENAI_API_KEY");
        }
        String baseUrl = getenv("OPENAI_BASE_URL", "https://api.openai.com/v1");
        String model = getenv("EMBEDDING_MODEL", "text-embedding-3-small");
        String query = "我登不上去了，密码想不起来";

        List<String> input = new ArrayList<>();
        input.add(query);
        input.addAll(DOCS);

        ObjectMapper mapper = new ObjectMapper();
        HttpClient client = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10)).build();
        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(baseUrl + "/embeddings"))
                .timeout(Duration.ofSeconds(60))
                .header("Authorization", "Bearer " + apiKey)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(
                        mapper.writeValueAsString(new EmbeddingRequest(model, input))))
                .build();
        HttpResponse<String> resp = client.send(req, HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() != 200) {
            throw new RuntimeException("HTTP " + resp.statusCode() + ": " + resp.body());
        }

        double[][] vecs = new double[input.size()][];
        for (EmbeddingData d : mapper.readValue(resp.body(), EmbeddingResponse.class).data()) {
            vecs[d.index()] = d.embedding();
        }
        System.out.println("向量维度: " + vecs[0].length);

        List<Hit> hits = new ArrayList<>();
        for (int i = 0; i < DOCS.size(); i++) {
            hits.add(new Hit(cosine(vecs[0], vecs[i + 1]), DOCS.get(i)));
        }
        hits.sort(Comparator.comparingDouble(Hit::score).reversed());
        hits.forEach(h -> System.out.printf("%.3f  %s%n", h.score(), h.doc()));
    }
}
```
:::

预期结果中，"忘记密码"和"账号锁定"两条排在前面，优惠券和物流两条明显靠后，尽管查询里根本没有出现"重置""找回"这些词。

这就是 RAG 检索的雏形。真实系统里，文档会提前编码并存进 [向量数据库](/guide/09-rag/vector-db)，查询时只需要编码查询本身，再由数据库做高效的近似最近邻搜索。

## Embedding 在 Agent 里的用途

| 用途 | 做法 |
| --- | --- |
| RAG 检索 | 文档切块后编码入库，按查询召回最相关的片段 |
| 长期记忆 | 把用户偏好、历史事实编码存储，按当前话题召回 |
| 工具选择 | 工具很多时，先按描述的相似度筛出候选，再交给模型 |
| 意图分类 | 与各类别的示例句比较，找最近的类别 |
| 去重和聚类 | 合并语义重复的问题、反馈或文档 |

## 选择 Embedding 模型的要点

- **语言支持**：中文场景优先选对中文效果好的模型。可以参考 [MTEB 排行榜](https://huggingface.co/spaces/mteb/leaderboard)，但最终以自己数据上的效果为准。
- **维度**：维度越高，表达能力通常越强，但存储和计算成本也越高。部分模型支持通过参数指定更低的输出维度。
- **最大输入长度**：超过上限的文本会被截断或报错，这也是文档需要切块的原因之一。
- **一致性**：入库和查询**必须使用同一个模型**，不同模型的向量不在同一个空间，不能混用。更换模型意味着全量重新编码。

## 常见坑

- **混用不同模型的向量**：换了 Embedding 模型却没有重建索引，检索结果会完全失效，而且不会报错。
- **把相似度阈值写死**：阈值与模型、语言、数据分布都有关，换模型后必须重新调整。
- **以为向量检索能处理精确匹配**：订单号、型号、人名这类精确字符串，向量检索效果往往不如关键词检索，需要混合检索。
- **整篇长文编码成一个向量**：信息被平均掉，检索粒度太粗。需要合理切块，见 [文档解析与切分](/guide/09-rag/chunking)。
- **逐条调用 API**：大部分 Embedding 接口支持批量输入，批量调用能大幅减少请求次数和耗时。

## 小测

**1. "苹果手机多少钱"和"iPhone 售价"没有相同的词，向量检索能匹配上吗？关键词检索呢？**

::: details 查看答案
向量检索通常能匹配，因为两句话语义相近，Embedding 向量接近。纯关键词检索匹配不上，因为字面没有重叠。
:::

**2. 团队把 Embedding 模型从 A 换成了 B，只对新文档用 B 编码，旧文档保持不变，会有什么问题？**

::: details 查看答案
A 和 B 的向量空间不同，用 B 编码的查询与 A 编码的旧文档计算相似度没有意义。旧文档基本检索不到，或者召回结果杂乱。换模型必须全量重新编码。
:::

**3. 向量已经归一化时，为什么可以用点积代替余弦相似度？**

::: details 查看答案
余弦相似度等于点积除以两个向量长度的乘积。归一化后长度都为 1，分母为 1，余弦相似度就等于点积，省去了开方计算。
:::

## 延伸阅读

- [OpenAI Embeddings 指南](https://platform.openai.com/docs/guides/embeddings)
- [MTEB: Massive Text Embedding Benchmark](https://arxiv.org/abs/2210.07316)
- 下一篇：[推理模型与扩展思考](/guide/02-llm-basics/reasoning-models)
- 实践：[RAG 全景](/guide/09-rag/overview)

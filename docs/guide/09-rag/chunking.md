---
title: 文档解析与切分
description: 把 PDF、Word、网页变成干净的文本，再切成大小合适、语义完整的块，是 RAG 效果的地基。
---

# 文档解析与切分

::: info 学习目标
- 了解常见文档格式的解析难点和可用工具
- 理解 chunk 大小、重叠对检索效果的影响
- 对比固定长度、递归、按结构、语义切分和父子块等策略
- 动手实现一个"段落 → 句子 → 硬切"的递归切分器（Python / Go / Java）
:::

## 为什么切分这么重要

[RAG 全景](/guide/09-rag/overview) 里的 Demo 用的是 5 句写好的短文本。真实资料是几十页的 PDF、带表格的 Word、满是导航栏的网页。它们必须先变成**干净的文本**，再切成一个个**块（chunk）**，因为：

- Embedding 模型有输入长度上限，整篇文档放不进去；
- 即使放得进去，一整篇文档压成一个向量，语义会被"平均"掉，检索不到具体段落；
- 最终要放进 prompt 的是几个片段，而不是几篇全文。

切分决定了**检索的最小单位**。切得不好，后面的 Embedding、向量库、重排再好也救不回来："住宿标准"被切成两半，前一半有"一线城市"，后一半有"600 元"，任何一块单独拿出来都答不了问题。

## 第一步：解析

| 格式 | 主要难点 | 常用工具（Python） |
| --- | --- | --- |
| PDF（文本型） | 多栏排版、页眉页脚、跨页断句、表格 | `pypdf`、PyMuPDF（`pymupdf`）、`pdfplumber` |
| PDF（扫描件） | 本身是图片，需要 OCR | OCR 引擎，或多模态模型（见 [多模态输入](/guide/03-llm-api/multimodal)） |
| Word / PPT | 样式、嵌套表格、批注 | `python-docx`、`python-pptx` |
| HTML | 导航、广告、脚本等噪声 | `BeautifulSoup`、`trafilatura` |
| 混合格式 | 统一处理多种格式 | `unstructured`、Docling、Apache Tika（Java） |

解析阶段有几个容易忽视、但影响很大的处理：

- **去噪**：页眉、页脚、页码、"机密文件"水印，每页都重复，会污染每个块的语义。
- **保留结构**：标题层级是最好的切分依据，也是最有价值的元数据。能转成 Markdown 就尽量转成 Markdown。
- **表格单独处理**：表格被拉平成一串文本后基本无法理解。可以转成 Markdown 表格，或者每一行转成"列名: 值"的句子。
- **人工抽查**：解析结果一定要打开看几页。很多"检索不准"的问题，根源是解析出来的文本就是乱的。

## 第二步：切分的两个核心参数

**块大小（chunk size）** 没有标准答案，是一个权衡：

```text
   块太小（< 100 字）                          块太大（> 1500 字）
   ├─ 语义不完整，缺上下文                      ├─ 一块包含多个主题，向量被"平均"
   ├─ 召回的碎片拼不出答案                      ├─ 检索精度下降
   └─ 检索精度高                                └─ 上下文完整，但浪费 Token
```

常见的起点是**中文 300~800 字**（或 256~1024 Token），然后在评估集上调。问答类、条款类资料偏小；需要完整推理的技术文档偏大。

**重叠（overlap）** 指相邻两块共享的一段文字，通常取块大小的 10%~20%。它的作用是给"恰好被切在边界上"的信息一个补救机会。重叠太大会导致大量重复内容，浪费存储，检索结果里也会出现几乎一样的块。

## 切分策略对比

| 策略 | 做法 | 优点 | 缺点 |
| --- | --- | --- | --- |
| 固定长度 | 每 N 个字符 / Token 切一刀 | 最简单，块大小均匀 | 会切断句子和段落 |
| 递归切分 | 按"段落 → 句子 → 字符"的分隔符优先级逐级切 | 尽量保持语义完整，通用性好 | 不理解文档结构 |
| 按结构切分 | 按 Markdown 标题、HTML 标签、代码函数切 | 块与章节对应，可附带标题路径 | 依赖解析质量；章节长短差异大 |
| 语义切分 | 计算相邻句子的 Embedding 相似度，在语义跳变处切 | 主题边界更准 | 切分时就要大量调用 Embedding，成本高 |
| 父子块 | 用小块检索，命中后返回它所属的大块 | 兼顾检索精度和上下文完整 | 需要维护块之间的映射关系 |

LangChain 的 `RecursiveCharacterTextSplitter` 就是递归切分的代表。大多数场景下，**按结构切分 + 递归切分兜底**是性价比最高的组合：先按标题分章节，章节太长再递归切。

## 动手：递归切分器

下面实现一个不依赖任何库的切分器：

1. 先按空行切成段落；
2. 段落超过 `size` 时，按句末标点（`。！？；` 等）切成句子；
3. 单句仍超长，按长度硬切；
4. 再把这些小单元**贪心地拼回**不超过 `size` 的块，并把上一块的末尾 `overlap` 个字符带到下一块开头。

长度按字符计算。Go 版本特意用 `[]rune` 处理，避免把一个汉字的 UTF-8 字节切成两半。

::: code-group
```python [Python]
import re

SENT_END = "。！？!?；;"


def split_units(text: str, size: int) -> list[str]:
    """先按段落切；段落太长再按句子切；单句仍超长时按长度硬切。"""
    units: list[str] = []
    for para in re.split(r"\n\s*\n", text):
        para = para.strip()
        if not para:
            continue
        if len(para) <= size:
            units.append(para)
            continue
        for sent in re.findall(rf"[^{SENT_END}]+[{SENT_END}]?", para):
            sent = sent.strip()
            units.extend(sent[i : i + size] for i in range(0, len(sent), size))
    return units


def chunk_text(text: str, size: int = 300, overlap: int = 50) -> list[str]:
    """把小单元贪心地拼成不超过 size 字符的块，相邻块重叠约 overlap 字符。"""
    if not 0 <= overlap < size:
        raise ValueError("要求 0 <= overlap < size")
    chunks: list[str] = []
    cur = ""
    for unit in split_units(text, size):
        if cur and len(cur) + 1 + len(unit) > size:
            chunks.append(cur)
            tail = cur[len(cur) - overlap :]  # 上一块的结尾，作为下一块的开头
            cur = tail if len(tail) + 1 + len(unit) <= size else ""
        cur = f"{cur}\n{unit}" if cur else unit
    if cur:
        chunks.append(cur)
    return chunks

DOC = """# 差旅管理办法

第一条 员工因公出差，应提前在 OA 系统提交出差申请，经部门负责人审批后方可出行。

第二条 住宿标准：一线城市每晚不超过 600 元，其他城市每晚不超过 400 元。超出部分由个人承担，特殊情况需事先报财务部批准。

第三条 交通标准：高铁二等座、飞机经济舱可直接报销。乘坐飞机商务舱须由分管副总裁审批。市内交通优先使用公共交通。

第四条 报销时限：出差结束后 30 天内提交报销单，逾期不予受理。"""

if __name__ == "__main__":
    for i, c in enumerate(chunk_text(DOC, size=80, overlap=20)):
        print(f"--- chunk {i} ({len(c)} 字) ---\n{c}")
```

```go [Go]
package main

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
)

const sentEnd = "。！？!?；;"

var paraRe = regexp.MustCompile(`\n\s*\n`)

// splitSentences 在句末标点之后切开（Go 的 regexp 不支持后行断言，这里手动扫描）
func splitSentences(s string) []string {
	var out []string
	var b strings.Builder
	for _, r := range s {
		b.WriteRune(r)
		if strings.ContainsRune(sentEnd, r) {
			out = append(out, b.String())
			b.Reset()
		}
	}
	if b.Len() > 0 {
		out = append(out, b.String())
	}
	return out
}

// splitUnits 先按段落切；段落太长再按句子切；单句仍超长时按长度硬切
func splitUnits(text string, size int) []string {
	var units []string
	for _, para := range paraRe.Split(text, -1) {
		para = strings.TrimSpace(para)
		if para == "" {
			continue
		}
		if len([]rune(para)) <= size {
			units = append(units, para)
			continue
		}
		for _, sent := range splitSentences(para) {
			rs := []rune(strings.TrimSpace(sent)) // 按 rune 处理，避免切坏中文字符
			for i := 0; i < len(rs); i += size {
				units = append(units, string(rs[i:min(i+size, len(rs))]))
			}
		}
	}
	return units
}

// ChunkText 把小单元贪心地拼成不超过 size 字符的块，相邻块重叠约 overlap 字符
func ChunkText(text string, size, overlap int) ([]string, error) {
	if overlap < 0 || overlap >= size {
		return nil, errors.New("要求 0 <= overlap < size")
	}
	var chunks []string
	var cur []rune
	for _, u := range splitUnits(text, size) {
		ur := []rune(u)
		if len(cur) > 0 && len(cur)+1+len(ur) > size {
			chunks = append(chunks, string(cur))
			tail := cur[len(cur)-min(overlap, len(cur)):] // 上一块的结尾，作为下一块的开头
			if len(tail)+1+len(ur) > size {
				tail = nil
			}
			cur = append([]rune(nil), tail...)
		}
		if len(cur) > 0 {
			cur = append(cur, '\n')
		}
		cur = append(cur, ur...)
	}
	if len(cur) > 0 {
		chunks = append(chunks, string(cur))
	}
	return chunks, nil
}

const doc = `# 差旅管理办法

第一条 员工因公出差，应提前在 OA 系统提交出差申请，经部门负责人审批后方可出行。

第二条 住宿标准：一线城市每晚不超过 600 元，其他城市每晚不超过 400 元。超出部分由个人承担，特殊情况需事先报财务部批准。

第三条 交通标准：高铁二等座、飞机经济舱可直接报销。乘坐飞机商务舱须由分管副总裁审批。市内交通优先使用公共交通。

第四条 报销时限：出差结束后 30 天内提交报销单，逾期不予受理。`

func main() {
	chunks, err := ChunkText(doc, 80, 20)
	if err != nil {
		panic(err)
	}
	for i, c := range chunks {
		fmt.Printf("--- chunk %d (%d 字) ---\n%s\n", i, len([]rune(c)), c)
	}
}
```

```java [Java]
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class Main {
    static final String SENT_END = "。！？!?；;";
    static final Pattern SENTENCE = Pattern.compile("[^" + SENT_END + "]+[" + SENT_END + "]?");

    /** 先按段落切；段落太长再按句子切；单句仍超长时按长度硬切 */
    static List<String> splitUnits(String text, int size) {
        List<String> units = new ArrayList<>();
        for (String para : text.split("\\n\\s*\\n")) {
            para = para.strip();
            if (para.isEmpty()) continue;
            if (para.length() <= size) {
                units.add(para);
                continue;
            }
            Matcher m = SENTENCE.matcher(para);
            while (m.find()) {
                String sent = m.group().strip();
                for (int i = 0; i < sent.length(); i += size) {
                    units.add(sent.substring(i, Math.min(i + size, sent.length())));
                }
            }
        }
        return units;
    }

    /** 把小单元贪心地拼成不超过 size 字符的块，相邻块重叠约 overlap 字符 */
    static List<String> chunkText(String text, int size, int overlap) {
        if (overlap < 0 || overlap >= size) throw new IllegalArgumentException("要求 0 <= overlap < size");
        List<String> chunks = new ArrayList<>();
        String cur = "";
        for (String unit : splitUnits(text, size)) {
            if (!cur.isEmpty() && cur.length() + 1 + unit.length() > size) {
                chunks.add(cur);
                String tail = cur.substring(Math.max(0, cur.length() - overlap)); // 上一块的结尾
                cur = tail.length() + 1 + unit.length() <= size ? tail : "";
            }
            cur = cur.isEmpty() ? unit : cur + "\n" + unit;
        }
        if (!cur.isEmpty()) chunks.add(cur);
        return chunks;
    }

    static final String DOC = """
            # 差旅管理办法

            第一条 员工因公出差，应提前在 OA 系统提交出差申请，经部门负责人审批后方可出行。

            第二条 住宿标准：一线城市每晚不超过 600 元，其他城市每晚不超过 400 元。超出部分由个人承担，特殊情况需事先报财务部批准。

            第三条 交通标准：高铁二等座、飞机经济舱可直接报销。乘坐飞机商务舱须由分管副总裁审批。市内交通优先使用公共交通。

            第四条 报销时限：出差结束后 30 天内提交报销单，逾期不予受理。""";

    public static void main(String[] args) {
        List<String> chunks = chunkText(DOC, 80, 20);
        for (int i = 0; i < chunks.size(); i++) {
            String c = chunks.get(i);
            System.out.printf("--- chunk %d (%d 字) ---%n%s%n", i, c.length(), c);
        }
    }
}
```
:::

输出（三种语言一致）：

```text
--- chunk 0 (51 字) ---
# 差旅管理办法
第一条 员工因公出差，应提前在 OA 系统提交出差申请，经部门负责人审批后方可出行。
--- chunk 1 (65 字) ---
第二条 住宿标准：一线城市每晚不超过 600 元，其他城市每晚不超过 400 元。超出部分由个人承担，特殊情况需事先报财务部批准。
--- chunk 2 (77 字) ---
由个人承担，特殊情况需事先报财务部批准。
第三条 交通标准：高铁二等座、飞机经济舱可直接报销。乘坐飞机商务舱须由分管副总裁审批。市内交通优先使用公共交通。
--- chunk 3 (54 字) ---
管副总裁审批。市内交通优先使用公共交通。
第四条 报销时限：出差结束后 30 天内提交报销单，逾期不予受理。
```

可以看到，每一条规定都完整地落在某一个块里，没有被拦腰截断；块 2、块 3 开头带着上一块的末尾作为重叠。这里的重叠按字符截取，可能从半句话开始（如"管副总裁审批"），更讲究的做法是按句子边界回退，留作练习。

## 给块加上元数据和上下文

一个块不应该只是一段文本。入库时建议同时保存：

```json
{
  "id": "travel-policy-v3#chunk-2",
  "text": "第三条 交通标准：高铁二等座、飞机经济舱可直接报销……",
  "metadata": {
    "source": "差旅管理办法.pdf",
    "page": 2,
    "section": "差旅管理办法 > 第三条",
    "department": "finance",
    "updated_at": "2024-06-01"
  }
}
```

元数据有三个用处：**过滤**（只检索某部门、某版本的文档，权限控制也靠它）、**引用**（回答时告诉用户出处和页码）、**增量更新**（文档修改后按 `source` 删除旧块再写入新块）。

还有一个简单有效的技巧：**给块补上下文**。孤立的一块"第三条 交通标准……"并不知道自己属于哪份文件。把标题路径拼到块的开头再做 Embedding，例如"《差旅管理办法》> 第三条：……"，检索命中率通常会明显提升。Anthropic 提出的 Contextual Retrieval 更进一步：用 LLM 为每个块生成一两句说明它在全文中位置和含义的上下文，再与原文一起建索引。

**父子块（Parent-Child）** 是另一种思路：用小块（如 200 字）建索引，保证检索精准；命中后返回它所在的大块（如整节 1500 字）给模型，保证上下文完整。LlamaIndex 等框架中有类似的实现（如 Auto-Merging、Sentence Window 等检索器）。

## 常见坑

- **不看解析结果就切分**：多栏 PDF 被解析成左右两栏交错的文本，切得再好也没用。先抽查解析质量。
- **表格被拉平**：表格变成一串数字后，"600"到底对应哪一列已经无从得知。表格要单独解析成结构化文本。
- **全局统一块大小**：FAQ、合同条款、技术手册的最佳块大小差别很大，不同类型的文档可以用不同的参数。
- **丢掉元数据**：没有来源和页码，无法给出引用，也无法按文档更新或删除。
- **按 Token 限制却按字符计算**：Embedding 模型的上限是按 Token 算的，中文字符和 Token 不是 1:1。对长度敏感时，用对应模型的分词器计算，或者留足余量。
- **改了切分参数不重建索引**：新旧块混在一起，检索结果会出现重复和不一致。切分策略变更后应全量重建。

## 小测

**1.** 块太大和块太小分别会带来什么问题？

::: details 查看答案
块太小：语义不完整，缺乏上下文，单块不足以回答问题，召回的碎片难以拼出答案。块太大：一个块混合多个主题，向量被"平均"导致检索精度下降，且放进 prompt 时浪费 Token、引入无关内容。
:::

**2.** 父子块策略解决的是什么矛盾？

::: details 查看答案
解决"检索精度"和"上下文完整性"之间的矛盾：小块语义集中，检索更精准；大块上下文完整，生成更可靠。父子块用小块检索、返回大块给模型，兼顾两者。
:::

**3.** 为什么建议把文档标题和章节路径拼进块的文本里再做 Embedding？

::: details 查看答案
很多块单独看缺少主语和背景，比如"第三条 交通标准……"并不知道自己属于哪份制度。拼上标题路径后，块的向量包含了文档主题信息，用户问"差旅交通怎么报销"时更容易被检索到，也能减少不同文档中相似条款的混淆。
:::

## 延伸阅读

- [LangChain 文档：Text splitters](https://python.langchain.com/docs/concepts/text_splitters/)
- [Anthropic：Introducing Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval)
- [unstructured（GitHub）](https://github.com/Unstructured-IO/unstructured)、[Docling（GitHub）](https://github.com/docling-project/docling)
- 本站：[向量数据库](/guide/09-rag/vector-db)、[实战项目：个人 PDF 知识库](/projects/04-pdf-rag)

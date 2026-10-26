---
title: 采样参数：temperature、top_p
description: 理解 temperature、top_p 等采样参数如何影响输出，以及在 Agent 不同场景下该怎么设置。
---

# 采样参数：temperature、top_p

::: info 学习目标
- 理解模型输出是"从概率分布中采样"的结果
- 掌握 temperature、top_p 的作用和区别
- 了解 max_tokens、stop、seed、frequency/presence penalty 等常用参数
- 能为分类、抽取、Tool Calling、创意写作等场景选择合适的参数
:::

在 [Transformer 的直觉理解](/guide/02-llm-basics/transformer) 中我们知道，模型每一步输出的是"下一个 Token 的概率分布"。从这个分布里怎么挑出一个 Token，就是**采样**（sampling）。采样参数不会让模型变聪明，但会显著影响输出的稳定性和多样性。

## 从 logits 到概率

模型最后一层输出的是每个候选 Token 的原始分数（logits），经过 softmax 转换成概率。假设模型在续写"今天天气很"：

```text
候选 Token     原始概率
好             0.50
不错           0.25
热             0.15
奇怪           0.07
紫色           0.03
```

最直接的做法是每次都选概率最高的"好"，这叫**贪心解码**（greedy decoding）。它稳定，但容易单调、重复。按概率随机抽取则更多样，但也可能抽到"紫色"这种离谱的选项。temperature 和 top_p 就是在这两者之间调节。

## temperature：拉伸或压平分布

temperature 在 softmax 之前把 logits 除以一个系数 T：

- **T < 1**：分布变"尖"，高概率的更高，低概率的更低，输出更确定。
- **T = 1**：保持模型原始分布。
- **T > 1**：分布变"平"，低概率选项被抬高，输出更随机。
- **T → 0**：趋近于贪心解码，几乎总选最高的那个。

```text
              T = 0.2          T = 1.0          T = 1.8
好        ██████████ 0.93   █████ 0.50       ███ 0.33
不错      █ 0.06            ███ 0.25         ██ 0.24
热        ░ 0.01            ██ 0.15          ██ 0.19
奇怪      ░ 0.00            █ 0.07           █ 0.14
紫色      ░ 0.00            ░ 0.03           █ 0.10
（数值为示意）
```

## top_p：只在"核心候选"里挑

top_p 也叫**核采样**（nucleus sampling）：把候选 Token 按概率从高到低排列，累加到总和刚好达到 p 为止，只在这一小撮里重新归一化后采样。

```text
top_p = 0.8 时（使用 T=1.0 的分布）：
好 0.50 → 累计 0.50
不错 0.25 → 累计 0.75
热 0.15 → 累计 0.90 ≥ 0.8，截止
奇怪、紫色 被排除，永远不会被选中
```

temperature 改变的是"分布的形状"，top_p 改变的是"候选的范围"。top_p 的好处是自适应：模型很确定时，候选集只有一两个；模型不确定时，候选集自动变大。

**一般建议只调其中一个**，另一个保持默认。同时调整两个参数，效果难以预测，也不利于排查问题。

## 其他常用参数

| 参数 | 作用 | 常见用法 |
| --- | --- | --- |
| `max_tokens` | 输出 Token 上限 | 控制成本和延迟，防止输出失控 |
| `stop` | 遇到指定字符串就停止 | 截断模板化输出，例如遇到 `"\n\n"` 停 |
| `seed` | 尽量让相同请求得到相同结果 | 调试和评估，但官方只承诺"尽力而为" |
| `frequency_penalty` | 按出现次数惩罚已出现的 Token | 减少重复的词句 |
| `presence_penalty` | 只要出现过就惩罚 | 鼓励谈论新话题 |
| `n` | 一次生成多个候选 | 多采样后投票或挑选，但成本成倍增长 |

参数的取值范围和支持情况因厂商而异，例如有的厂商 temperature 范围是 0~2，有的是 0~1，部分参数可能不支持或被忽略。以对应厂商的 API 文档为准。

另外，**推理模型**通常会限制或忽略 temperature、top_p 等采样参数，详见 [推理模型与扩展思考](/guide/02-llm-basics/reasoning-models)。

## 动手：对比不同 temperature

下面的程序用同一个提示词，在 temperature 0 和 1.0 下各生成 3 次，直观感受输出的差异。选择 1.0 而不是更高的值，是因为部分厂商的取值上限就是 1。

::: code-group
```python [Python]
import os

from openai import OpenAI

PROMPT = "给一家卖咖啡的小店起一个名字，只输出名字。"


def main() -> None:
    client = OpenAI(
        api_key=os.environ["OPENAI_API_KEY"],
        base_url=os.getenv("OPENAI_BASE_URL") or None,
        timeout=60,
    )
    model = os.getenv("LLM_MODEL", "gpt-4o-mini")
    for temperature in (0.0, 1.0):
        print(f"--- temperature={temperature} ---")
        for i in range(3):
            resp = client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": PROMPT}],
                temperature=temperature,
                max_tokens=30,
            )
            print(i + 1, (resp.choices[0].message.content or "").strip())


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
	"net/http"
	"os"
	"strings"
	"time"
)

const prompt = "给一家卖咖啡的小店起一个名字，只输出名字。"

type message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatRequest struct {
	Model       string    `json:"model"`
	Messages    []message `json:"messages"`
	Temperature float64   `json:"temperature"` // 不加 omitempty，否则 0 不会被发送
	MaxTokens   int       `json:"max_tokens"`
}

type chatResponse struct {
	Choices []struct {
		Message message `json:"message"`
	} `json:"choices"`
}

var httpClient = &http.Client{Timeout: 60 * time.Second}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func chat(baseURL, apiKey string, body chatRequest) (string, error) {
	data, err := json.Marshal(body)
	if err != nil {
		return "", err
	}
	req, err := http.NewRequest(http.MethodPost, baseURL+"/chat/completions", bytes.NewReader(data))
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
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("HTTP %d: %s", resp.StatusCode, raw)
	}
	var out chatResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", err
	}
	if len(out.Choices) == 0 {
		return "", fmt.Errorf("empty choices")
	}
	return strings.TrimSpace(out.Choices[0].Message.Content), nil
}

func main() {
	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" {
		log.Fatal("请设置 OPENAI_API_KEY")
	}
	baseURL := getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
	model := getenv("LLM_MODEL", "gpt-4o-mini")

	for _, t := range []float64{0, 1.0} {
		fmt.Printf("--- temperature=%.1f ---\n", t)
		for i := 1; i <= 3; i++ {
			text, err := chat(baseURL, apiKey, chatRequest{
				Model:       model,
				Messages:    []message{{Role: "user", Content: prompt}},
				Temperature: t,
				MaxTokens:   30,
			})
			if err != nil {
				log.Fatal(err)
			}
			fmt.Println(i, text)
		}
	}
}
```

```java [Java]
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;

public class SamplingDemo {
    static final String PROMPT = "给一家卖咖啡的小店起一个名字，只输出名字。";
    static final ObjectMapper MAPPER = new ObjectMapper();
    static final HttpClient HTTP = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10)).build();

    record Message(String role, String content) {}

    record ChatRequest(String model, List<Message> messages, double temperature,
                       @JsonProperty("max_tokens") int maxTokens) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    record Choice(Message message) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    record ChatResponse(List<Choice> choices) {}

    static String getenv(String key, String def) {
        String v = System.getenv(key);
        return (v == null || v.isBlank()) ? def : v;
    }

    static String chat(String baseUrl, String apiKey, ChatRequest body) throws Exception {
        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(baseUrl + "/chat/completions"))
                .timeout(Duration.ofSeconds(60))
                .header("Authorization", "Bearer " + apiKey)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(MAPPER.writeValueAsString(body)))
                .build();
        HttpResponse<String> resp = HTTP.send(req, HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() != 200) {
            throw new RuntimeException("HTTP " + resp.statusCode() + ": " + resp.body());
        }
        ChatResponse out = MAPPER.readValue(resp.body(), ChatResponse.class);
        if (out.choices() == null || out.choices().isEmpty()) {
            throw new RuntimeException("empty choices");
        }
        String content = out.choices().get(0).message().content();
        return content == null ? "" : content.strip();
    }

    public static void main(String[] args) throws Exception {
        String apiKey = System.getenv("OPENAI_API_KEY");
        if (apiKey == null || apiKey.isBlank()) {
            throw new IllegalStateException("请设置 OPENAI_API_KEY");
        }
        String baseUrl = getenv("OPENAI_BASE_URL", "https://api.openai.com/v1");
        String model = getenv("LLM_MODEL", "gpt-4o-mini");

        for (double t : new double[]{0.0, 1.0}) {
            System.out.printf("--- temperature=%.1f ---%n", t);
            for (int i = 1; i <= 3; i++) {
                var body = new ChatRequest(model, List.of(new Message("user", PROMPT)), t, 30);
                System.out.println(i + " " + chat(baseUrl, apiKey, body));
            }
        }
    }
}
```
:::

典型结果是：temperature=0 时三次输出基本相同（但不保证完全一致），temperature=1.0 时每次都可能给出不同的名字。

## 不同场景怎么设

| 场景 | 建议 | 原因 |
| --- | --- | --- |
| 分类、信息抽取、结构化输出 | temperature 0~0.3 | 需要稳定、可复现的结果 |
| Tool Calling、Agent 决策 | 0~0.3，或厂商推荐值 | 参数要精确，随机性会导致调错工具 |
| 代码生成 | 0~0.5 | 正确性优先 |
| 日常问答、客服 | 0.5~0.8 | 兼顾自然和稳定 |
| 头脑风暴、创意写作 | 0.8~1.2 | 需要多样性 |
| 多次采样后投票 | 0.7 以上 | 候选之间要有差异才有投票意义 |

这些只是起点。部分厂商会在文档中给出针对自家模型的推荐值，优先参考官方建议，再通过评估确定。

## 常见坑

- **以为 temperature=0 就完全确定**：服务端的并行计算、批处理和浮点误差都可能让结果有细微差异。需要可复现时可以加 `seed`，但它也只是"尽力而为"。
- **用高 temperature 追求"更聪明"**：temperature 只影响随机性，不影响能力。调高往往换来的是更多错误。
- **同时大幅调整 temperature 和 top_p**：两者叠加后效果难以预测，一般只调一个。
- **Go 里给 temperature 加了 `omitempty`**：值为 0 时字段不会被发送，服务端会使用默认值（通常是 1）。需要发送 0 时去掉 `omitempty`，或者使用指针类型。
- **在推理模型上设置采样参数**：可能被忽略，也可能直接报错。

## 小测

**1. 抽取发票字段并输出 JSON，temperature 应该设高还是设低？**

::: details 查看答案
设低，通常 0~0.2。抽取任务追求准确和稳定，随机性只会带来格式错误和字段漂移。
:::

**2. top_p=0.1 和 temperature=0.1 都会让输出更确定，它们的机制有什么不同？**

::: details 查看答案
temperature 通过缩放 logits 改变整个分布的形状，让高概率选项更突出；top_p 不改变形状，而是只保留累计概率达到 0.1 的少数最高概率候选，其余直接排除。
:::

**3. 为什么 Go 代码中 `Temperature` 字段没有加 `omitempty`？**

::: details 查看答案
`omitempty` 会在值为零值时省略字段，temperature=0 正好是零值。省略后服务端使用默认值，就得不到想要的确定性输出。
:::

## 延伸阅读

- [The Curious Case of Neural Text Degeneration](https://arxiv.org/abs/1904.09751)：提出核采样（top_p）的论文
- [OpenAI API Reference: Chat Completions](https://platform.openai.com/docs/api-reference/chat/create)
- 下一篇：[Embedding 与向量语义](/guide/02-llm-basics/embeddings)

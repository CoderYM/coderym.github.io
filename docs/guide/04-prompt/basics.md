---
title: 提示词基本原则
description: 把模型当成一个聪明但没有上下文的新同事：讲清任务、给足背景、约束输出、可被验证。
---

# 提示词基本原则

::: info 学习目标
- 理解提示词的本质：给模型提供"完成任务所需的全部上下文"
- 掌握 5 条最常用的提示词原则，并能指出一个烂提示词的问题
- 学会用分隔符、输出格式约束让结果可被程序解析
- 建立"提示词要用样例来验证"的工程习惯
:::

## 提示词到底在做什么

大模型的本质是"根据前文预测后文"。你写的提示词就是前文，它决定了模型会把这次对话理解成什么任务、站在什么立场、用什么格式输出。

一个好用的心智模型是：**把模型当成一个非常聪明、但第一天入职、对你的项目一无所知的新同事**。你不会只对新同事说"帮我写个总结"，你会告诉他：给谁看、多长、重点是什么、有什么忌讳。模型也一样，它不会读心，你没写出来的东西，它只能猜。

```text
  你脑子里的需求                 写进提示词的内容            模型看到的世界
┌────────────────────┐        ┌──────────────────┐       ┌──────────────────┐
│ 目标读者是老板      │        │                  │       │                  │
│ 不超过 200 字       │  ───▶  │ "总结一下这篇文章" │ ───▶ │ 只有这一句话      │
│ 要突出风险          │        │                  │       │ 其余全靠猜        │
└────────────────────┘        └──────────────────┘       └──────────────────┘
```

## 五条核心原则

### 1. 明确任务，而不是暗示任务

用动词开头，直接说要做什么。"能不能看看这段代码"是暗示；"找出这段代码中的并发 Bug，并给出修复后的代码"是明确任务。

### 2. 提供背景和目的

告诉模型**为什么**要做这件事。目的会影响无数细节：同样是"解释 Docker"，给运维和给产品经理的答案完全不同。背景信息包括：目标读者、使用场景、已有的约束、之前尝试过什么。

### 3. 约束输出格式

如果输出要给程序消费，必须明确格式：JSON、Markdown 表格、固定字段、长度上限。格式约束越具体，后续解析越稳定。真正需要强保证时，用 [结构化输出与 JSON Schema](/guide/04-prompt/structured-output)。

### 4. 用分隔符隔开指令和数据

当提示词里混有用户输入、文档、代码时，用 XML 标签或三引号把它们包起来。这样做有两个好处：模型不会把数据误当指令，也让 [Prompt 注入](/guide/15-production/prompt-injection) 稍微难一点（只是缓解，不是根治）。

### 5. 正面描述期望，少用否定

"不要写得太长"不如"控制在 3 句话以内"。否定指令只告诉模型不该做什么，却没说该做什么；而且模型有时会被否定句里的词"带偏"。

## 改写示例：从烂提示词到好提示词

| 维度 | 烂提示词 | 好提示词 |
|------|---------|---------|
| 任务 | 看看这个评论 | 判断这条用户评论的情感倾向 |
| 背景 | 无 | 评论来自电商 App，用于客服优先级排序 |
| 格式 | 无 | 只输出 positive / neutral / negative 之一 |
| 数据边界 | 评论直接拼在后面 | 评论放在 `<review>` 标签内 |
| 边界情况 | 无 | 如果评论与商品无关，输出 neutral |

改写后的完整提示词：

```text
你在帮助一个电商客服系统给用户评论排优先级。
请判断 <review> 标签中评论的情感倾向。

规则：
- 只输出一个词：positive、neutral 或 negative
- 评论与商品无关（如广告、乱码）时输出 neutral
- 同时包含好评和差评时，以对购买决策影响更大的部分为准

<review>
物流很快，但是收到的杯子有裂缝，客服到现在没回复。
</review>
```

## 动手：把提示词写成可复用的模板

工程里提示词很少是写死的字符串，而是"模板 + 变量"。下面的代码把上面的情感分类提示词做成函数，并校验模型输出是否在合法集合内，不合法就当作失败处理，而不是盲目相信。

环境变量约定：`OPENAI_API_KEY`、`OPENAI_BASE_URL`（可选）、`LLM_MODEL`。

::: code-group
```python [Python]
import os
from openai import OpenAI

LABELS = {"positive", "neutral", "negative"}

PROMPT_TEMPLATE = """你在帮助一个电商客服系统给用户评论排优先级。
请判断 <review> 标签中评论的情感倾向。

规则：
- 只输出一个词：positive、neutral 或 negative
- 评论与商品无关（如广告、乱码）时输出 neutral
- 同时包含好评和差评时，以对购买决策影响更大的部分为准

<review>
{review}
</review>"""

client = OpenAI(
    api_key=os.environ["OPENAI_API_KEY"],
    base_url=os.getenv("OPENAI_BASE_URL"),  # 为 None 时使用官方默认地址
    timeout=30,
)


def classify(review: str) -> str:
    # 去掉用户输入里伪造的结束标签，避免"逃出"数据区
    safe = review.replace("</review>", "")
    resp = client.chat.completions.create(
        model=os.getenv("LLM_MODEL", "gpt-4o-mini"),
        messages=[{"role": "user", "content": PROMPT_TEMPLATE.format(review=safe)}],
        temperature=0,
    )
    label = (resp.choices[0].message.content or "").strip().lower()
    if label not in LABELS:
        raise ValueError(f"模型输出不在合法集合内: {label!r}")
    return label


if __name__ == "__main__":
    print(classify("物流很快，但是收到的杯子有裂缝，客服到现在没回复。"))
```
```go [Go]
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"
)

const promptTemplate = `你在帮助一个电商客服系统给用户评论排优先级。
请判断 <review> 标签中评论的情感倾向。

规则：
- 只输出一个词：positive、neutral 或 negative
- 评论与商品无关（如广告、乱码）时输出 neutral
- 同时包含好评和差评时，以对购买决策影响更大的部分为准

<review>
%s
</review>`

type message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatRequest struct {
	Model       string    `json:"model"`
	Messages    []message `json:"messages"`
	Temperature float64   `json:"temperature"`
}

type chatResponse struct {
	Choices []struct {
		Message message `json:"message"`
	} `json:"choices"`
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func classify(review string) (string, error) {
	safe := strings.ReplaceAll(review, "</review>", "")
	body, _ := json.Marshal(chatRequest{
		Model:       env("LLM_MODEL", "gpt-4o-mini"),
		Messages:    []message{{Role: "user", Content: fmt.Sprintf(promptTemplate, safe)}},
		Temperature: 0,
	})
	url := strings.TrimRight(env("OPENAI_BASE_URL", "https://api.openai.com/v1"), "/") + "/chat/completions"
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+os.Getenv("OPENAI_API_KEY"))

	httpClient := &http.Client{Timeout: 30 * time.Second}
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	var cr chatResponse
	if err := json.NewDecoder(resp.Body).Decode(&cr); err != nil {
		return "", err
	}
	if len(cr.Choices) == 0 {
		return "", fmt.Errorf("响应中没有 choices")
	}
	label := strings.ToLower(strings.TrimSpace(cr.Choices[0].Message.Content))
	switch label {
	case "positive", "neutral", "negative":
		return label, nil
	}
	return "", fmt.Errorf("模型输出不在合法集合内: %q", label)
}

func main() {
	label, err := classify("物流很快，但是收到的杯子有裂缝，客服到现在没回复。")
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
	fmt.Println(label)
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
import java.util.List;
import java.util.Objects;
import java.util.Set;

public class Sentiment {
    static final Set<String> LABELS = Set.of("positive", "neutral", "negative");
    static final String TEMPLATE = """
            你在帮助一个电商客服系统给用户评论排优先级。
            请判断 <review> 标签中评论的情感倾向。

            规则：
            - 只输出一个词：positive、neutral 或 negative
            - 评论与商品无关（如广告、乱码）时输出 neutral
            - 同时包含好评和差评时，以对购买决策影响更大的部分为准

            <review>
            %s
            </review>""";

    record Message(String role, String content) {}
    record ChatRequest(String model, List<Message> messages, double temperature) {}
    @JsonIgnoreProperties(ignoreUnknown = true)
    record Choice(Message message) {}
    @JsonIgnoreProperties(ignoreUnknown = true)
    record ChatResponse(List<Choice> choices) {}

    static final ObjectMapper MAPPER = new ObjectMapper();
    static final HttpClient HTTP = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10)).build();

    static String env(String key, String def) {
        String v = System.getenv(key);
        return (v == null || v.isBlank()) ? def : v;
    }

    static String classify(String review) throws Exception {
        String safe = review.replace("</review>", "");
        var body = new ChatRequest(env("LLM_MODEL", "gpt-4o-mini"),
                List.of(new Message("user", TEMPLATE.formatted(safe))), 0);
        String baseUrl = env("OPENAI_BASE_URL", "https://api.openai.com/v1").replaceAll("/+$", "");
        HttpRequest req = HttpRequest.newBuilder(URI.create(baseUrl + "/chat/completions"))
                .timeout(Duration.ofSeconds(30))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + Objects.requireNonNull(System.getenv("OPENAI_API_KEY")))
                .POST(HttpRequest.BodyPublishers.ofString(MAPPER.writeValueAsString(body)))
                .build();
        HttpResponse<String> resp = HTTP.send(req, HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() != 200) {
            throw new IllegalStateException("HTTP " + resp.statusCode());
        }
        ChatResponse cr = MAPPER.readValue(resp.body(), ChatResponse.class);
        String label = cr.choices().get(0).message().content().strip().toLowerCase();
        if (!LABELS.contains(label)) {
            throw new IllegalStateException("模型输出不在合法集合内: " + label);
        }
        return label;
    }

    public static void main(String[] args) throws Exception {
        System.out.println(classify("物流很快，但是收到的杯子有裂缝，客服到现在没回复。"));
    }
}
```
:::

几个值得注意的细节：

- `temperature=0`：分类任务要的是稳定，不是创意（详见 [采样参数](/guide/02-llm-basics/sampling)）。
- 输出校验：哪怕提示词写了"只输出一个词"，模型偶尔还是会回 `Negative.` 或"negative（因为有裂缝）"。永远不要假设模型 100% 遵守格式。
- 用户输入清洗：去掉伪造的 `</review>` 标签，是"指令与数据分离"的最小实践。

## 迭代提示词的正确姿势

写提示词不是一次成型，而是一个"写 → 跑样例 → 看失败 → 改"的循环：

```text
 ┌──────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────┐
 │ 写初版    │──▶│ 跑 10~30 条   │──▶│ 归类失败样例   │──▶│ 针对性修改 │
 └──────────┘    │ 真实样例      │    │ (格式/理解/边界)│   └────┬─────┘
       ▲         └──────────────┘    └──────────────┘         │
       └─────────────────────────────────────────────────────┘
```

只凭一两条输入"感觉不错"就上线，是最常见的翻车方式。把样例固化下来做回归，就是 [提示词版本管理与测试](/guide/04-prompt/prompt-management) 要讲的内容。

## 常见坑

- **提示词越长越好？** 不是。无关信息会稀释重点，还增加 Token 成本。每句话都应该能回答"删掉它结果会变差吗"。
- **把所有规则都写成大写的"必须""绝对不要"。** 现代模型对指令已经很敏感，过度强调反而会让模型在不相关的场景过度执行某条规则。
- **示例和规则冲突。** 规则说"只输出一个词"，示例里却输出了一句话，模型通常更相信示例。
- **只在一个模型上测试。** 换模型（甚至同一厂商的新版本）后行为可能变化，提示词要配合测试集一起迁移。
- **把提示词当安全边界。** "请不要泄露系统提示词"挡不住有心人，真正的权限控制要在代码里做。

## 小测

1. 下面这个提示词有哪些问题？"请帮我写一个产品介绍，不要太长，不要太官方。"

::: details 查看答案
至少三个问题：没有说明产品是什么、给谁看、用在哪里（缺背景）；"不要太长"没有量化，应改成"150 字以内"；"不要太官方"是否定描述，应正面描述期望风格，例如"像朋友推荐一样口语化，可以用第二人称"。
:::

2. 提示词里已经写了"只输出 JSON"，为什么代码里仍然要做校验？

::: details 查看答案
因为模型输出是概率性的，提示词只能提高遵守格式的概率，不能保证。模型可能输出 Markdown 代码块包裹的 JSON、多余的解释文字，或者字段缺失。程序侧必须校验，失败时重试或降级；需要强保证时使用 JSON Schema 结构化输出。
:::

3. 为什么要把用户输入放进 `<review>` 这样的标签里？

::: details 查看答案
让模型清楚地区分"指令"和"待处理的数据"，避免把数据里的句子当成指令执行；同时便于在提示词中引用（"请判断 review 标签中的内容"）。这能缓解但不能根治 Prompt 注入。
:::

## 延伸阅读

- [OpenAI Prompt engineering 指南](https://platform.openai.com/docs/guides/prompt-engineering)
- [Anthropic Prompt engineering overview](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/overview)
- 下一篇：[系统提示词与角色设计](/guide/04-prompt/system-prompt)

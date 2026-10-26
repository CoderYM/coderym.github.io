---
title: Few-shot 与思维链
description: 用示例教会模型格式与边界，用思维链提升复杂推理的准确率，并了解它们在推理模型时代的变化。
---

# Few-shot 与思维链

::: info 学习目标
- 区分 Zero-shot、Few-shot，知道什么时候值得加示例
- 掌握 Few-shot 示例的两种放法：写在提示词里，或伪造成多轮对话
- 理解思维链（Chain-of-Thought, CoT）为什么有效，以及如何把"思考"与"答案"分开解析
- 了解推理模型出现后，CoT 提示的写法有什么变化
:::

## Zero-shot 与 Few-shot

- **Zero-shot**：只给指令，不给示例。"把下面的句子翻译成英文。"
- **Few-shot**：给出几个"输入 → 输出"示例，让模型照着做。

示例的作用远不止"演示格式"。它能传达很多难以用规则描述的东西：语气、粒度、边界情况怎么处理。很多时候，**一个好示例胜过十条规则**。

| 场景 | 推荐 | 原因 |
|------|------|------|
| 通用问答、翻译、总结 | Zero-shot | 模型已经很擅长，示例反而限制发挥 |
| 固定格式的信息抽取 | Few-shot | 示例能精确传达字段和格式 |
| 业务特有的分类标准 | Few-shot | "什么算紧急工单"这类标准很难用语言描述清楚 |
| 特定的写作风格 | Few-shot | 风格靠示范比靠形容词准确得多 |

## 写好示例的要点

1. **覆盖多样性**：示例之间要有差异，覆盖典型情况和边界情况。三个示例都是正面评价，模型就可能偏向输出正面。
2. **格式绝对一致**：示例的输出格式就是你期望的格式，一个标点都不要差。
3. **数量适中**：通常 2~5 个足够。更多示例意味着更多 Token，收益递减。
4. **标签分布均衡**：分类任务中，示例的类别分布会影响模型的先验。
5. **用分隔符包起来**：用 `<example>` 标签包住示例，避免模型把示例内容当成本次任务的输入。

## 两种放置方式

**方式一：写在提示词里**，简单直观：

```text
把用户的工单分类为 urgent / normal / low。

<example>
工单：线上支付全部失败，用户无法下单
分类：urgent
</example>
<example>
工单：希望导出报表时能支持 Excel 格式
分类：low
</example>
<example>
工单：部分用户反馈头像上传偶尔失败，重试可以成功
分类：normal
</example>

工单：{ticket}
分类：
```

**方式二：伪造成多轮对话**，把每个示例写成一对 user / assistant 消息。模型会把这些当成"自己之前的回答"，对格式的模仿通常更稳定，在 Chat 模型上很常用。下面的代码演示的就是这种方式。

## 动手：Few-shot 工单分类

::: code-group
```python [Python]
import os
from openai import OpenAI

SYSTEM = "你是工单分诊助手。把工单分类为 urgent、normal 或 low，只输出类别。"

# 示例覆盖三个类别，且包含一个"看起来严重但其实不紧急"的边界情况
EXAMPLES = [
    ("线上支付全部失败，用户无法下单", "urgent"),
    ("希望导出报表时能支持 Excel 格式", "low"),
    ("部分用户反馈头像上传偶尔失败，重试可以成功", "normal"),
    ("测试环境数据库挂了，明天要用", "normal"),
]

client = OpenAI(
    api_key=os.environ["OPENAI_API_KEY"],
    base_url=os.getenv("OPENAI_BASE_URL"),
    timeout=30,
)


def build_messages(ticket: str) -> list[dict]:
    messages = [{"role": "system", "content": SYSTEM}]
    for text, label in EXAMPLES:  # 示例伪造成多轮对话
        messages.append({"role": "user", "content": text})
        messages.append({"role": "assistant", "content": label})
    messages.append({"role": "user", "content": ticket})
    return messages


def classify(ticket: str) -> str:
    resp = client.chat.completions.create(
        model=os.getenv("LLM_MODEL", "gpt-4o-mini"),
        messages=build_messages(ticket),
        temperature=0,
    )
    label = (resp.choices[0].message.content or "").strip().lower()
    if label not in {"urgent", "normal", "low"}:
        raise ValueError(f"unexpected label: {label!r}")
    return label


if __name__ == "__main__":
    print(classify("生产环境登录接口 500，所有用户都登不上"))
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

type message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

const system = "你是工单分诊助手。把工单分类为 urgent、normal 或 low，只输出类别。"

var examples = [][2]string{
	{"线上支付全部失败，用户无法下单", "urgent"},
	{"希望导出报表时能支持 Excel 格式", "low"},
	{"部分用户反馈头像上传偶尔失败，重试可以成功", "normal"},
	{"测试环境数据库挂了，明天要用", "normal"},
}

func buildMessages(ticket string) []message {
	msgs := []message{{Role: "system", Content: system}}
	for _, ex := range examples {
		msgs = append(msgs,
			message{Role: "user", Content: ex[0]},
			message{Role: "assistant", Content: ex[1]})
	}
	return append(msgs, message{Role: "user", Content: ticket})
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func classify(ticket string) (string, error) {
	body, _ := json.Marshal(map[string]any{
		"model":       env("LLM_MODEL", "gpt-4o-mini"),
		"messages":    buildMessages(ticket),
		"temperature": 0,
	})
	url := strings.TrimRight(env("OPENAI_BASE_URL", "https://api.openai.com/v1"), "/") + "/chat/completions"
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+os.Getenv("OPENAI_API_KEY"))
	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	var out struct {
		Choices []struct {
			Message message `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil || len(out.Choices) == 0 {
		return "", fmt.Errorf("bad response: %v", err)
	}
	label := strings.ToLower(strings.TrimSpace(out.Choices[0].Message.Content))
	switch label {
	case "urgent", "normal", "low":
		return label, nil
	}
	return "", fmt.Errorf("unexpected label: %q", label)
}

func main() {
	label, err := classify("生产环境登录接口 500，所有用户都登不上")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println(label)
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
import java.util.List;
import java.util.Map;
import java.util.Set;

public class FewShot {
    record Message(String role, String content) {}
    record Example(String input, String label) {}

    static final String SYSTEM = "你是工单分诊助手。把工单分类为 urgent、normal 或 low，只输出类别。";
    static final List<Example> EXAMPLES = List.of(
            new Example("线上支付全部失败，用户无法下单", "urgent"),
            new Example("希望导出报表时能支持 Excel 格式", "low"),
            new Example("部分用户反馈头像上传偶尔失败，重试可以成功", "normal"),
            new Example("测试环境数据库挂了，明天要用", "normal"));

    static List<Message> buildMessages(String ticket) {
        List<Message> msgs = new ArrayList<>();
        msgs.add(new Message("system", SYSTEM));
        for (Example ex : EXAMPLES) {
            msgs.add(new Message("user", ex.input()));
            msgs.add(new Message("assistant", ex.label()));
        }
        msgs.add(new Message("user", ticket));
        return msgs;
    }

    static String env(String key, String def) {
        String v = System.getenv(key);
        return (v == null || v.isBlank()) ? def : v;
    }

    public static void main(String[] args) throws Exception {
        ObjectMapper mapper = new ObjectMapper();
        var payload = Map.of(
                "model", env("LLM_MODEL", "gpt-4o-mini"),
                "messages", buildMessages("生产环境登录接口 500，所有用户都登不上"),
                "temperature", 0);
        String baseUrl = env("OPENAI_BASE_URL", "https://api.openai.com/v1").replaceAll("/+$", "");
        HttpRequest req = HttpRequest.newBuilder(URI.create(baseUrl + "/chat/completions"))
                .timeout(Duration.ofSeconds(30))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + System.getenv("OPENAI_API_KEY"))
                .POST(HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(payload)))
                .build();
        HttpResponse<String> resp = HttpClient.newHttpClient().send(req, HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() != 200) throw new IllegalStateException("HTTP " + resp.statusCode());
        JsonNode root = mapper.readTree(resp.body());
        String label = root.path("choices").path(0).path("message").path("content").asText().strip().toLowerCase();
        if (!Set.of("urgent", "normal", "low").contains(label)) {
            throw new IllegalStateException("unexpected label: " + label);
        }
        System.out.println(label);
    }
}
```
:::

注意第四个示例"测试环境数据库挂了"：字面上很严重，但影响面小，所以是 normal。这种业务判断很难用规则讲清楚，一个示例就够了。

## 思维链：让模型先想再答

思维链（Chain-of-Thought, CoT）的核心思想很朴素：**让模型在给出答案前先写出推理过程**。2022 年的论文 *Chain-of-Thought Prompting Elicits Reasoning in Large Language Models* 发现，在数学、逻辑这类多步推理任务上，这样做能显著提升准确率。

为什么有效？模型是逐个 Token 生成的，每个 Token 的"计算量"是固定的。直接输出答案，相当于要求模型一步心算出结果；先写推理过程，等于给了它一张草稿纸，后面的 Token 可以基于前面写下的中间结果继续推理。

```text
直接回答：  问题 ──────────────────────────▶ 答案（一步到位，容易错）

思维链：    问题 ──▶ 步骤1 ──▶ 步骤2 ──▶ 步骤3 ──▶ 答案
                    （每一步都写在上下文里，后续步骤可以"看到"）
```

最简单的做法是加一句"请一步一步思考"（Zero-shot CoT）。更可控的做法是**结构化 CoT**：让思考和答案分别放在不同标签里，程序只解析答案部分：

```text
一个订单原价 368 元，先打 85 折，再用一张满 300 减 40 的优惠券，
运费 12 元（满 299 包邮，按折后、用券前的金额判断）。用户最终付多少钱？

请先在 <thinking> 标签中逐步计算，再在 <answer> 标签中只给出最终金额数字。
```

解析时只取 `<answer>` 里的内容。下面是三种语言的解析函数（纯函数，不调用 API）：

::: code-group
```python [Python]
import re


def extract_answer(text: str) -> str:
    """从模型输出中提取 <answer> 标签的内容，找不到时抛出异常而不是猜。"""
    m = re.search(r"<answer>(.*?)</answer>", text, re.S)
    if not m:
        raise ValueError("no <answer> tag in model output")
    return m.group(1).strip()


if __name__ == "__main__":
    output = "<thinking>368*0.85=312.8，满 299 包邮；用券后 272.8</thinking><answer>272.8</answer>"
    print(extract_answer(output))  # 272.8
```
```go [Go]
package main

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// (?s) 让 . 匹配换行
var answerRe = regexp.MustCompile(`(?s)<answer>(.*?)</answer>`)

func extractAnswer(text string) (string, error) {
	m := answerRe.FindStringSubmatch(text)
	if m == nil {
		return "", errors.New("no <answer> tag in model output")
	}
	return strings.TrimSpace(m[1]), nil
}

func main() {
	output := "<thinking>368*0.85=312.8，满 299 包邮；用券后 272.8</thinking><answer>272.8</answer>"
	ans, err := extractAnswer(output)
	if err != nil {
		panic(err)
	}
	fmt.Println(ans) // 272.8
}
```
```java [Java]
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class ExtractAnswer {
    // DOTALL 让 . 匹配换行
    static final Pattern ANSWER = Pattern.compile("<answer>(.*?)</answer>", Pattern.DOTALL);

    static String extractAnswer(String text) {
        Matcher m = ANSWER.matcher(text);
        if (!m.find()) throw new IllegalArgumentException("no <answer> tag in model output");
        return m.group(1).strip();
    }

    public static void main(String[] args) {
        String output = "<thinking>368*0.85=312.8，满 299 包邮；用券后 272.8</thinking><answer>272.8</answer>";
        System.out.println(extractAnswer(output)); // 272.8
    }
}
```
:::

结构化 CoT 还有一个工程价值：`<thinking>` 内容可以记入日志，出错时用来排查模型"为什么这么想"，但不展示给终端用户。

## 推理模型时代的 CoT

现在很多模型（如 OpenAI o 系列、DeepSeek-R1、开启扩展思考的 Claude）在输出答案前会**自己进行内部推理**，详见 [推理模型与扩展思考](/guide/02-llm-basics/reasoning-models)。对这类模型：

| 做法 | 普通 Chat 模型 | 推理模型 |
|------|--------------|---------|
| "请一步一步思考" | 通常有帮助 | 多余，模型本来就会想 |
| 规定详细的推理步骤 | 有帮助 | 可能反而限制模型，效果变差 |
| Few-shot 示例 | 有帮助 | 仍可用于约束输出格式，但不要示范推理过程 |
| 清晰描述目标与约束 | 必要 | 更加重要 |

简单说：对推理模型，**讲清楚要什么，而不是教它怎么想**。具体建议以各厂商的官方文档为准。

## 常见坑

- **示例里藏了偏差。** 所有示例都很短，模型就倾向于输出很短的答案；所有示例的答案都是 A，模型就倾向于选 A。
- **示例数据泄漏到真实回答。** 模型有时会把示例中的具体人名、数字照抄到新回答里。示例要用明显的虚构数据，必要时说明"示例仅用于演示格式"。
- **CoT 用在了不需要推理的任务上。** 简单分类加 CoT 只会增加延迟和成本，准确率几乎不变。
- **把推理过程当成可信的解释。** 模型写出的推理过程不一定是它真正得出答案的原因，不能把它当作可审计的依据。
- **解析整段输出而不是答案标签。** 推理过程里也会出现数字，直接用正则抓第一个数字很容易抓错。

## 小测

1. 一个情感分类任务，你的 3 个 Few-shot 示例都是 negative，可能出现什么问题？

::: details 查看答案
模型会受示例标签分布影响，倾向于把更多输入判为 negative。示例应覆盖所有类别，分布尽量均衡，并包含边界情况。
:::

2. 为什么思维链能提升多步推理的准确率？

::: details 查看答案
模型逐 Token 生成，单个 Token 的计算量有限。把中间步骤写进上下文后，后续 Token 可以基于已写出的中间结果继续计算，相当于给了模型"草稿纸"，把一次大跳跃拆成多次小步骤。
:::

3. 对推理模型使用"请按以下 8 个步骤思考"是好主意吗？

::: details 查看答案
通常不是。推理模型会自行规划推理过程，过于细致的步骤约束可能反而降低效果。更好的做法是清晰描述目标、约束和输出格式。
:::

## 延伸阅读

- [Chain-of-Thought Prompting Elicits Reasoning in Large Language Models](https://arxiv.org/abs/2201.11903)
- [Large Language Models are Zero-Shot Reasoners](https://arxiv.org/abs/2205.11916)（"Let's think step by step"）
- [Anthropic：Use examples (multishot prompting)](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/multishot-prompting)
- 下一篇：[结构化输出与 JSON Schema](/guide/04-prompt/structured-output)

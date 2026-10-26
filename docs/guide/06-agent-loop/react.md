---
title: ReAct：推理与行动
description: 理解 ReAct 的"思考 → 行动 → 观察"循环，分别用原始的文本格式和现代的原生 Tool Calling 实现它。
---

# ReAct：推理与行动

::: info 学习目标
- 理解 ReAct 为什么要把"推理"和"行动"交替进行
- 读懂原始论文的 Thought / Action / Observation 文本格式，并能手写解析器跑通它
- 理解现代原生 Tool Calling 如何承接 ReAct 思想，以及两种形式的取舍
- 知道 ReAct 的典型失败模式
:::

## 从两个极端说起

在 ReAct 出现之前，让大模型解决问题主要有两条路：

- 只推理：用 [思维链](/guide/04-prompt/few-shot-cot)（Chain-of-Thought）让模型一步步想。问题是模型只能用自己脑子里的知识，知识过时或记错了，推理再漂亮也是错的，而且错得很自信。
- 只行动：让模型直接输出要执行的动作（搜索、点击）。问题是没有中间推理，模型不知道自己为什么要做这一步，遇到意外结果也不会调整计划。

ReAct（Reasoning + Acting，Yao et al., 2022）的想法很朴素：让两者交替进行。模型先写一段思考，决定做什么；执行动作后拿到真实的观察结果；再基于观察继续思考。论文解读见 [ReAct 论文精读](/papers/react)。

```text
Question ──► Thought 1 ──► Action 1 ──► Observation 1
                                             │
             ┌───────────────────────────────┘
             ▼
          Thought 2 ──► Action 2 ──► Observation 2
                                             │
             ┌───────────────────────────────┘
             ▼
          Thought 3 ──► Final Answer
```

| 部分 | 谁写的 | 作用 |
| --- | --- | --- |
| Thought | 模型 | 分析现状、拆解问题、决定下一步，相当于"出声思考" |
| Action | 模型 | 以约定格式指明要调用的工具和参数 |
| Observation | 你的程序 | 真正执行工具后，把结果写回给模型 |
| Final Answer | 模型 | 认为信息足够时给出最终回答 |

推理让行动有方向，行动让推理有事实依据。这个"思考 → 行动 → 观察"的循环，就是今天几乎所有 Agent 的骨架。

## 形式一：原始的文本格式

2022 年还没有原生的 Tool Calling API，ReAct 完全靠提示词约定格式：让模型按固定格式输出纯文本，程序用正则把 `Action` 解析出来执行，再把 `Observation` 拼回去。

一次运行的轨迹大致如下（Observation 行是程序写的，不是模型写的）：

```text
Question: 东方明珠比埃菲尔铁塔高多少米？
Thought: 我需要分别知道两座塔的高度。先查东方明珠。
Action: lookup[东方明珠]
Observation: 东方明珠广播电视塔高约 468 米，位于上海，1994 年建成。
Thought: 东方明珠约 468 米。再查埃菲尔铁塔。
Action: lookup[埃菲尔铁塔]
Observation: 埃菲尔铁塔高约 330 米，位于巴黎，1889 年建成。
Thought: 468 - 330 = 138，我已经知道答案了。
Final Answer: 东方明珠比埃菲尔铁塔高约 138 米。
```

实现上有两个关键技巧：

1. 用 `stop=["Observation:"]` 让模型写完 Action 就停下。否则模型会顺手"脑补"一个 Observation，把幻觉当成事实继续推理。
2. 整个轨迹作为一段不断增长的文本发给模型，每轮把模型的输出和真实的 Observation 追加进去。

下面是一个最小的文本版 ReAct，只有一个本地 `lookup` 工具（模拟百科查询）。注意 `stop` 参数大多数 OpenAI 兼容服务都支持，但部分推理模型不支持，以官方文档为准。

::: code-group
```python [Python]
import os
import re

from openai import OpenAI

client = OpenAI(api_key=os.environ["OPENAI_API_KEY"],
                base_url=os.getenv("OPENAI_BASE_URL") or None, timeout=60)
MODEL = os.getenv("LLM_MODEL", "gpt-4o-mini")

WIKI = {
    "东方明珠": "东方明珠广播电视塔高约 468 米，位于上海，1994 年建成。",
    "埃菲尔铁塔": "埃菲尔铁塔高约 330 米，位于巴黎，1889 年建成。",
}

PROMPT = """尽你所能回答问题。你可以使用以下工具：
lookup[关键词]：查询百科词条，返回一段简介。

严格按以下格式输出，每次只写一个 Thought 和一个 Action：
Thought: 你的思考
Action: lookup[关键词]

当你掌握了足够信息时输出：
Thought: 你的思考
Final Answer: 最终答案

Question: {question}
"""

ACTION_RE = re.compile(r"Action:\s*(\w+)\[(.*?)\]")


def lookup(keyword: str) -> str:
    return WIKI.get(keyword.strip(), f"没有找到词条：{keyword}")


def react(question: str, max_steps: int = 6) -> str:
    transcript = PROMPT.format(question=question)
    for _ in range(max_steps):
        resp = client.chat.completions.create(
            model=MODEL, temperature=0,
            messages=[{"role": "user", "content": transcript}],
            stop=["Observation:"],  # 写完 Action 就停，防止模型脑补观察结果
        )
        output = (resp.choices[0].message.content or "").strip()
        print(output)
        transcript += output + "\n"
        if "Final Answer:" in output:
            return output.split("Final Answer:", 1)[1].strip()
        m = ACTION_RE.search(output)
        if not m:  # 格式错误也作为观察结果反馈给模型
            observation = "格式错误：请按 Action: lookup[关键词] 的格式输出。"
        elif m.group(1) != "lookup":
            observation = f"未知工具：{m.group(1)}"
        else:
            observation = lookup(m.group(2))
        print(f"Observation: {observation}")
        transcript += f"Observation: {observation}\n"
    return "达到最大步数，未得出答案。"


if __name__ == "__main__":
    print("答案：", react("东方明珠比埃菲尔铁塔高多少米？"))
```

```go [Go]
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"
)

var wiki = map[string]string{
	"东方明珠":  "东方明珠广播电视塔高约 468 米，位于上海，1994 年建成。",
	"埃菲尔铁塔": "埃菲尔铁塔高约 330 米，位于巴黎，1889 年建成。",
}

const prompt = `尽你所能回答问题。你可以使用以下工具：
lookup[关键词]：查询百科词条，返回一段简介。

严格按以下格式输出，每次只写一个 Thought 和一个 Action：
Thought: 你的思考
Action: lookup[关键词]

当你掌握了足够信息时输出：
Thought: 你的思考
Final Answer: 最终答案

Question: %s
`

var actionRe = regexp.MustCompile(`Action:\s*(\w+)\[(.*?)\]`)
var httpClient = &http.Client{Timeout: 60 * time.Second}

func complete(text string) (string, error) {
	base := os.Getenv("OPENAI_BASE_URL")
	if base == "" {
		base = "https://api.openai.com/v1"
	}
	model := os.Getenv("LLM_MODEL")
	if model == "" {
		model = "gpt-4o-mini"
	}
	body, _ := json.Marshal(map[string]any{
		"model": model, "temperature": 0,
		"messages": []map[string]string{{"role": "user", "content": text}},
		"stop":     []string{"Observation:"}, // 写完 Action 就停，防止模型脑补观察结果
	})
	req, err := http.NewRequest("POST", strings.TrimRight(base, "/")+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+os.Getenv("OPENAI_API_KEY"))
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("HTTP %d: %s", resp.StatusCode, data)
	}
	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(data, &out); err != nil || len(out.Choices) == 0 {
		return "", fmt.Errorf("无法解析响应: %s", data)
	}
	return strings.TrimSpace(out.Choices[0].Message.Content), nil
}

func lookup(keyword string) string {
	if v, ok := wiki[strings.TrimSpace(keyword)]; ok {
		return v
	}
	return "没有找到词条：" + keyword
}

func react(question string, maxSteps int) (string, error) {
	transcript := fmt.Sprintf(prompt, question)
	for i := 0; i < maxSteps; i++ {
		output, err := complete(transcript)
		if err != nil {
			return "", err
		}
		fmt.Println(output)
		transcript += output + "\n"
		if _, answer, ok := strings.Cut(output, "Final Answer:"); ok {
			return strings.TrimSpace(answer), nil
		}
		var observation string
		m := actionRe.FindStringSubmatch(output)
		switch {
		case m == nil: // 格式错误也作为观察结果反馈给模型
			observation = "格式错误：请按 Action: lookup[关键词] 的格式输出。"
		case m[1] != "lookup":
			observation = "未知工具：" + m[1]
		default:
			observation = lookup(m[2])
		}
		fmt.Println("Observation:", observation)
		transcript += "Observation: " + observation + "\n"
	}
	return "达到最大步数，未得出答案。", nil
}

func main() {
	answer, err := react("东方明珠比埃菲尔铁塔高多少米？", 6)
	if err != nil {
		fmt.Fprintln(os.Stderr, "出错:", err)
		os.Exit(1)
	}
	fmt.Println("答案：", answer)
}
```

```java [Java]
import com.fasterxml.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class TextReAct {
    static final ObjectMapper JSON = new ObjectMapper();
    static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    static final Pattern ACTION = Pattern.compile("Action:\\s*(\\w+)\\[(.*?)]");

    static final Map<String, String> WIKI = Map.of(
            "东方明珠", "东方明珠广播电视塔高约 468 米，位于上海，1994 年建成。",
            "埃菲尔铁塔", "埃菲尔铁塔高约 330 米，位于巴黎，1889 年建成。");

    static final String PROMPT = """
            尽你所能回答问题。你可以使用以下工具：
            lookup[关键词]：查询百科词条，返回一段简介。

            严格按以下格式输出，每次只写一个 Thought 和一个 Action：
            Thought: 你的思考
            Action: lookup[关键词]

            当你掌握了足够信息时输出：
            Thought: 你的思考
            Final Answer: 最终答案

            Question: %s
            """;

    static String complete(String text) throws Exception {
        String base = Objects.requireNonNullElse(System.getenv("OPENAI_BASE_URL"), "https://api.openai.com/v1");
        String model = Objects.requireNonNullElse(System.getenv("LLM_MODEL"), "gpt-4o-mini");
        String body = JSON.writeValueAsString(Map.of(
                "model", model, "temperature", 0,
                "messages", List.of(Map.of("role", "user", "content", text)),
                "stop", List.of("Observation:"))); // 写完 Action 就停，防止模型脑补观察结果
        HttpRequest req = HttpRequest.newBuilder(URI.create(base.replaceAll("/+$", "") + "/chat/completions"))
                .timeout(Duration.ofSeconds(60))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + System.getenv("OPENAI_API_KEY"))
                .POST(HttpRequest.BodyPublishers.ofString(body)).build();
        HttpResponse<String> resp = HTTP.send(req, HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() != 200) throw new RuntimeException("HTTP " + resp.statusCode() + ": " + resp.body());
        return JSON.readTree(resp.body()).path("choices").path(0).path("message").path("content").asText("").strip();
    }

    static String react(String question, int maxSteps) throws Exception {
        StringBuilder transcript = new StringBuilder(PROMPT.formatted(question));
        for (int i = 0; i < maxSteps; i++) {
            String output = complete(transcript.toString());
            System.out.println(output);
            transcript.append(output).append("\n");
            int idx = output.indexOf("Final Answer:");
            if (idx >= 0) return output.substring(idx + "Final Answer:".length()).strip();
            Matcher m = ACTION.matcher(output);
            String observation;
            if (!m.find()) observation = "格式错误：请按 Action: lookup[关键词] 的格式输出。"; // 也反馈给模型
            else if (!m.group(1).equals("lookup")) observation = "未知工具：" + m.group(1);
            else observation = WIKI.getOrDefault(m.group(2).strip(), "没有找到词条：" + m.group(2));
            System.out.println("Observation: " + observation);
            transcript.append("Observation: ").append(observation).append("\n");
        }
        return "达到最大步数，未得出答案。";
    }

    public static void main(String[] args) throws Exception {
        System.out.println("答案：" + react("东方明珠比埃菲尔铁塔高多少米？", 6));
    }
}
```
:::

跑一下就能体会到文本格式的脆弱：模型偶尔会写成 `Action: lookup(东方明珠)`、在一次输出里写两个 Action，或者把关键词加上引号。每一种都需要你在解析器里打补丁，或者用"格式错误"的观察结果去纠正它。

## 形式二：原生 Tool Calling

2023 年起，主流模型厂商把"调用工具"做进了 API 和模型训练里，也就是 [工具调用原理](/guide/05-tool-calling/concept) 讲的 Tool Calling。ReAct 的三个部分在新协议里各有对应：

| ReAct 概念 | 文本格式 | 原生 Tool Calling |
| --- | --- | --- |
| Thought | 输出里的 `Thought:` 行 | assistant 消息的 `content`（可能为空），或推理模型内部的思考过程 |
| Action | `Action: lookup[东方明珠]`，靠正则解析 | `tool_calls` 字段，参数是 JSON，模型按 JSON Schema 生成 |
| Observation | 拼接到文本里的 `Observation:` 行 | `role: "tool"` 的消息，用 `tool_call_id` 关联 |
| Final Answer | `Final Answer:` 前缀 | 一条没有 `tool_calls` 的 assistant 消息 |
| 停止生成 | `stop=["Observation:"]` | 模型发起工具调用时自然停止 |

同一个问题用原生 Tool Calling 跑，消息序列是这样的：

```text
user       东方明珠比埃菲尔铁塔高多少米？
assistant  content="我先分别查两座塔的高度。"
           tool_calls=[lookup({"keyword":"东方明珠"}), lookup({"keyword":"埃菲尔铁塔"})]
tool       (call_1) 东方明珠广播电视塔高约 468 米……
tool       (call_2) 埃菲尔铁塔高约 330 米……
assistant  content="东方明珠比埃菲尔铁塔高约 138 米。"
```

注意第二行：模型一次发起了两个调用，这是文本格式很难做到的。完整可运行的原生 Tool Calling 循环见下一篇 [不用框架手写 Agent](/guide/06-agent-loop/handwritten-agent)，这里不重复贴代码。

### Thought 去哪了

原生 Tool Calling 下，很多模型发起工具调用时 `content` 是空的，看起来"不思考就行动"。实际上有三种情况：

- 普通模型：可以在系统提示词里要求"调用工具前先用一两句话说明理由"，`content` 里就会出现类似 Thought 的内容。这对调试和日志很有用，代价是多一些输出 Token。
- 推理模型：思考发生在模型内部的推理过程里，详见 [推理模型与扩展思考](/guide/02-llm-basics/reasoning-models)。部分厂商会返回思考摘要，部分完全不返回。
- 简单任务：模型确实不需要显式推理，直接调用即可。

## 两种形式怎么选

| 维度 | 文本 ReAct | 原生 Tool Calling |
| --- | --- | --- |
| 模型要求 | 任何能遵循指令的模型 | 需要模型和服务端支持 tools 参数 |
| 解析可靠性 | 低，依赖正则，模型经常不守格式 | 高，结构化 JSON，可配合严格模式 |
| 并行调用 | 很难 | 原生支持 |
| 可读性 | 高，整个轨迹就是一段文字 | 需要看消息列表，Thought 可能缺失 |
| 参数复杂度 | 适合单个字符串参数 | 任意 JSON Schema |
| 典型场景 | 教学、老模型、不支持工具的本地小模型 | 生产环境的默认选择 |

结论：新项目默认用原生 Tool Calling；文本 ReAct 值得亲手写一遍，因为它把"Agent 就是一个循环"展示得最直白，而且在调试、面试和使用不支持工具的模型时仍然有用。

## 常见坑

- 忘了 `stop`。文本 ReAct 不设停止序列，模型会自己编造 Observation 继续往下写，最终答案建立在幻觉之上，而且看起来非常合理。
- 解析器太严格或太宽松。太严格，模型多一个空格就失败；太宽松，可能把 Thought 里提到的 "Action:" 误当成真实调用。解析失败时要把错误作为 Observation 反馈，而不是静默跳过。
- 原地打转。模型反复调用同一个工具、同样的参数，观察结果没有任何新信息。需要步数上限和重复检测，见 [终止条件、步数与预算控制](/guide/06-agent-loop/stop-budget)。
- 过早给出答案。模型查了一个来源就下结论，或者干脆不调用工具直接凭记忆回答。可以在系统提示词里强调"涉及事实必须先查询"，并用 [Reflection](/guide/06-agent-loop/reflection) 做事后检查。
- 观察结果太长。把整个网页塞进 Observation，几轮之后上下文就爆了。工具返回前应截断或摘要，见 [压缩与摘要](/guide/07-context-engineering/compression)。
- 把 Thought 当成真实推理。模型写出来的 Thought 不一定是它真正的决策依据，可以用于调试，但不要把它当作模型决策过程的可靠解释。

## 小测

1. 文本 ReAct 里为什么要设置 `stop=["Observation:"]`？不设会怎样？

::: details 查看答案
Observation 必须来自真实的工具执行。不设停止序列，模型写完 Action 后会继续生成一段它"想象中"的 Observation，然后基于这个虚构的结果继续推理，工具实际上没被调用，答案完全不可信。
:::

2. 在原生 Tool Calling 里，ReAct 的 Thought、Action、Observation 分别对应什么？

::: details 查看答案
Thought 对应 assistant 消息的 `content`（可能为空）或推理模型的内部思考；Action 对应 `tool_calls`；Observation 对应 `role: "tool"` 的消息，通过 `tool_call_id` 与调用关联。Final Answer 则是一条不含 `tool_calls` 的 assistant 消息。
:::

3. 只用思维链（CoT）和使用 ReAct，在回答"某公司最新一季度营收是多少"这类问题时有什么本质区别？

::: details 查看答案
CoT 只能依赖模型训练时的知识，对时效性强的事实很可能给出过时或编造的数字。ReAct 可以通过搜索等工具获取实时信息，推理建立在真实的观察结果上，并且能根据观察调整下一步（比如第一次没搜到就换关键词）。
:::

## 延伸阅读

- [ReAct 论文精读](/papers/react)
- [Chain-of-Thought 论文精读](/papers/chain-of-thought)
- [ReAct: Synergizing Reasoning and Acting in Language Models（arXiv）](https://arxiv.org/abs/2210.03629)
- [不用框架手写 Agent](/guide/06-agent-loop/handwritten-agent)：原生 Tool Calling 版本的完整实现
- [项目 03：手写 ReAct Agent](/projects/03-react-agent)
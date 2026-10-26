---
title: 07 多 Agent 写作团队
description: 让策划、作者、审稿人三个角色协作完成一篇技术短文。先不用框架手写编排，再用 LangGraph 重构成状态图。
---

# 07 多 Agent 写作团队

::: info 项目信息
- 难度：★★★☆☆
- 预计时间：2~3 小时
- 前置知识：[为什么需要多 Agent](/guide/12-multi-agent/why-multi-agent)、[编排模式：主从、流水线、交接、辩论](/guide/12-multi-agent/patterns)、[状态共享与通信](/guide/12-multi-agent/state-sharing)、[LangGraph](/guide/11-frameworks/langgraph)、[结构化输出与 JSON Schema](/guide/04-prompt/structured-output)
- 你将学会：按职责拆分角色和提示词；用结构化输出驱动流程分支；用修订上限控制成本；用 LangGraph 的 `StateGraph` 表达带环的流程
:::

## 需求说明

用户输入一个主题（比如“用 Redis 实现分布式锁”），系统输出一篇 800 字以内的中文技术短文，保存为 `article.md`。内部由三个角色协作：

| 角色 | 输入 | 输出 | 说明 |
|------|------|------|------|
| Planner 策划 | 主题 | 大纲（标题 + 3~5 个小节） | 只运行一次 |
| Writer 作者 | 大纲（+ 上一版文章 + 审稿意见） | 完整文章 | 第一轮写初稿，之后按意见修改 |
| Reviewer 审稿人 | 大纲 + 文章 | JSON：`approved`、`score`、`feedback` | `temperature=0`，尽量稳定 |

功能要求：

1. 审稿不通过时，把意见交回作者修改，最多修订 2 次（即最多写 3 稿），到上限后直接输出最后一稿。
2. 每一轮在终端打印审稿结果，方便观察流程。
3. 是否进入下一轮由程序根据 `approved` 字段决定，而不是让模型自己决定“要不要继续”。
4. 主题长度限制在 200 字以内，模型调用都设置超时。

::: tip 这个场景真的需要多 Agent 吗？
一篇短文让单个模型一次写完也能凑合。这里拆成三个角色，主要是为了练习“流水线 + 循环”这种最常见的编排模式：每个角色的提示词更短、更专注，审稿人可以用更低的温度甚至不同的模型。代价是调用次数变成 3~7 次，Token 成本明显上升。真实项目里要先用评估证明多 Agent 确实更好，详见 [多 Agent 的坑与成本控制](/guide/12-multi-agent/pitfalls)。
:::

## 架构设计

```text
              topic
                │
                ▼
          ┌───────────┐
          │  Planner  │   产出大纲（只运行一次）
          └─────┬─────┘
                │ outline
                ▼
          ┌───────────┐ ◀──────────────────────┐
          │  Writer   │   写初稿 / 按意见修改     │ feedback
          └─────┬─────┘                        │ （未通过且未到修订上限）
                │ draft                        │
                ▼                              │
          ┌───────────┐                        │
          │ Reviewer  │ ─── JSON 审稿结果 ──────┘
          └─────┬─────┘
                │ approved = true 或已到上限
                ▼
           article.md
```
几个设计决定：

- **共享状态而不是共享对话**。三个角色不共用一段聊天历史，程序维护一个状态对象（主题、大纲、当前稿件、审稿意见、修订次数），每个角色只拿它需要的字段。这样每次调用的上下文更短，角色之间也不会互相“带偏”。
- **流程控制在代码里**。Reviewer 只负责给出结构化结论，循环与否由代码判断 `approved` 和 `revision`，保证一定会结束。
- **审稿结果容错**。有的模型会把 JSON 包在 Markdown 代码块里，解析时截取第一个 `{` 到最后一个 `}`；解析失败就当作“未通过”，并把原文作为意见。

## 分步实现

### Step 1：准备环境

新建目录 `writing-team`，配置 `.env`（所有项目通用）：

```bash
OPENAI_API_KEY=sk-xxx
# 使用 DeepSeek、通义千问、Kimi 等兼容服务时填写，例如 https://api.deepseek.com/v1
OPENAI_BASE_URL=
LLM_MODEL=gpt-4o-mini
```

各语言依赖：

- Python 3.10+：`pip install openai python-dotenv`，LangGraph 版本另需 `pip install langgraph`
- Go 1.22+：只用标准库，`go mod init writingteam`
- Java 17+：Maven 项目，加入 Jackson：

```xml
<dependency>
  <groupId>com.fasterxml.jackson.core</groupId>
  <artifactId>jackson-databind</artifactId>
  <version>2.17.2</version>
</dependency>
```

Go 和 Java 版本不会自动读取 `.env`，运行前先在终端里 `export` 这几个变量（或用 `set -a; source .env; set +a`）。

### Step 2：设计三个角色的提示词

角色拆分的关键是每个提示词只写一件事，并把输出格式定死：

```text
Planner：你是技术专栏的策划编辑。根据主题写一份文章大纲：一个标题，加 3 到 5 个小节，
         每个小节一行“- 小节名：要点”。只输出大纲。

Writer： 你是资深技术作者。根据大纲用中文写一篇不超过 800 字的 Markdown 技术短文，
         面向有一定经验的开发者，准确、具体、可以有简短代码示例。
         如果提供了审稿意见，就在上一版基础上逐条修改。只输出文章正文。

Reviewer：你是严格的技术审稿人。检查文章：技术准确性、是否覆盖大纲、结构是否清晰、
         是否超过 800 字。只输出一个 JSON 对象，不要输出其他内容：
         {"approved": true 或 false, "score": 1 到 10 的整数, "feedback": "具体修改意见，通过时可为空"}
         score 达到 8 分及以上才能 approved 为 true。
```

注意 Reviewer 收到的文章用 `<article>` 标签包起来，避免文章内容被当成指令（参考 [Prompt 注入与防护](/guide/15-production/prompt-injection)）。

### Step 3：不用框架手写编排

先不用任何框架，把流程写成一个普通的循环。三种语言的结构完全一致：`chat()` 封装一次调用，`parseReview()` 解析审稿 JSON，`run()` 里是 Planner → Writer ⇄ Reviewer 的循环。

::: code-group
```python [Python]
# team.py —— 不依赖框架的写作团队
import json
import os
import sys

from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()
client = OpenAI(
    api_key=os.environ["OPENAI_API_KEY"],
    base_url=os.getenv("OPENAI_BASE_URL") or None,
    timeout=60,
)
MODEL = os.getenv("LLM_MODEL", "gpt-4o-mini")
MAX_REVISIONS = 2  # 最多修订 2 次，即最多写 3 稿

PLANNER = ("你是技术专栏的策划编辑。根据主题写一份文章大纲：一个标题，加 3 到 5 个小节，"
           "每个小节一行“- 小节名：要点”。只输出大纲。")
WRITER = ("你是资深技术作者。根据大纲用中文写一篇不超过 800 字的 Markdown 技术短文，"
          "面向有一定经验的开发者，准确、具体、可以有简短代码示例。"
          "如果提供了审稿意见，就在上一版基础上逐条修改。只输出文章正文。")
REVIEWER = ("你是严格的技术审稿人。检查文章：技术准确性、是否覆盖大纲、结构是否清晰、"
            "是否超过 800 字。只输出一个 JSON 对象，不要输出其他内容："
            '{"approved": true 或 false, "score": 1 到 10 的整数, '
            '"feedback": "具体修改意见，通过时可为空"}。score 达到 8 分及以上才能 approved 为 true。')


def chat(system: str, user: str, temperature: float = 0.7) -> str:
    resp = client.chat.completions.create(
        model=MODEL,
        temperature=temperature,
        messages=[{"role": "system", "content": system},
                  {"role": "user", "content": user}],
    )
    return resp.choices[0].message.content or ""


def parse_review(text: str) -> dict:
    """容错解析：截取第一个 { 到最后一个 }，失败则视为未通过。"""
    start, end = text.find("{"), text.rfind("}")
    try:
        data = json.loads(text[start:end + 1]) if start != -1 and end > start else {}
    except json.JSONDecodeError:
        data = {}
    if not isinstance(data, dict) or "approved" not in data:
        return {"approved": False, "score": 0, "feedback": "审稿结果无法解析，请检查结构和准确性：" + text[:200]}
    return {"approved": data.get("approved") is True,
            "score": int(data.get("score") or 0),
            "feedback": str(data.get("feedback") or "")}


def run(topic: str) -> str:
    outline = chat(PLANNER, f"主题：{topic}")
    print(f"=== 大纲 ===\n{outline}\n")

    draft, feedback = "", ""
    for revision in range(MAX_REVISIONS + 1):
        if revision == 0:
            prompt = f"大纲：\n{outline}"
        else:
            prompt = f"大纲：\n{outline}\n\n上一版文章：\n{draft}\n\n审稿意见：\n{feedback}"
        draft = chat(WRITER, prompt)

        review = parse_review(chat(REVIEWER, f"大纲：\n{outline}\n\n<article>\n{draft}\n</article>", 0))
        print(f"[第 {revision + 1} 稿] approved={review['approved']} score={review['score']} "
              f"feedback={review['feedback'][:80]}")
        if review["approved"]:
            break
        feedback = review["feedback"]
    else:
        print("已达到修订上限，输出最后一稿")
    return draft


if __name__ == "__main__":
    topic = " ".join(sys.argv[1:]).strip()
    if not topic or len(topic) > 200:
        sys.exit("用法：python team.py <主题>（1~200 字）")
    article = run(topic)
    with open("article.md", "w", encoding="utf-8") as f:
        f.write(article)
    print("\n已保存到 article.md")
```
```go [Go]
// main.go —— 不依赖框架的写作团队（仅标准库）
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
	"unicode/utf8"
)

const maxRevisions = 2

const (
	planner  = "你是技术专栏的策划编辑。根据主题写一份文章大纲：一个标题，加 3 到 5 个小节，每个小节一行“- 小节名：要点”。只输出大纲。"
	writer   = "你是资深技术作者。根据大纲用中文写一篇不超过 800 字的 Markdown 技术短文，面向有一定经验的开发者，准确、具体、可以有简短代码示例。如果提供了审稿意见，就在上一版基础上逐条修改。只输出文章正文。"
	reviewer = `你是严格的技术审稿人。检查文章：技术准确性、是否覆盖大纲、结构是否清晰、是否超过 800 字。只输出一个 JSON 对象，不要输出其他内容：{"approved": true 或 false, "score": 1 到 10 的整数, "feedback": "具体修改意见，通过时可为空"}。score 达到 8 分及以上才能 approved 为 true。`
)

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatRequest struct {
	Model       string    `json:"model"`
	Messages    []Message `json:"messages"`
	Temperature float64   `json:"temperature"`
}

type chatResponse struct {
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	} `json:"choices"`
}

type Review struct {
	Approved bool   `json:"approved"`
	Score    int    `json:"score"`
	Feedback string `json:"feedback"`
}

var httpClient = &http.Client{Timeout: 60 * time.Second}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func chat(system, user string, temperature float64) (string, error) {
	body, err := json.Marshal(chatRequest{
		Model:       env("LLM_MODEL", "gpt-4o-mini"),
		Temperature: temperature,
		Messages:    []Message{{"system", system}, {"user", user}},
	})
	if err != nil {
		return "", err
	}
	url := strings.TrimRight(env("OPENAI_BASE_URL", "https://api.openai.com/v1"), "/") + "/chat/completions"
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
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
	data, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return "", err
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("API 返回 %d：%s", resp.StatusCode, data)
	}
	var cr chatResponse
	if err := json.Unmarshal(data, &cr); err != nil {
		return "", err
	}
	if len(cr.Choices) == 0 {
		return "", fmt.Errorf("响应中没有 choices")
	}
	return cr.Choices[0].Message.Content, nil
}

// parseReview 容错解析：截取第一个 { 到最后一个 }，失败则视为未通过。
func parseReview(text string) Review {
	start, end := strings.Index(text, "{"), strings.LastIndex(text, "}")
	if start != -1 && end > start {
		var raw map[string]json.RawMessage
		var r Review
		if json.Unmarshal([]byte(text[start:end+1]), &raw) == nil && raw["approved"] != nil &&
			json.Unmarshal([]byte(text[start:end+1]), &r) == nil {
			return r
		}
	}
	snippet := []rune(text)
	if len(snippet) > 200 {
		snippet = snippet[:200]
	}
	return Review{Feedback: "审稿结果无法解析，请检查结构和准确性：" + string(snippet)}
}

func run(topic string) (string, error) {
	outline, err := chat(planner, "主题："+topic, 0.7)
	if err != nil {
		return "", err
	}
	fmt.Printf("=== 大纲 ===\n%s\n\n", outline)

	draft, feedback := "", ""
	for revision := 0; revision <= maxRevisions; revision++ {
		prompt := "大纲：\n" + outline
		if revision > 0 {
			prompt += "\n\n上一版文章：\n" + draft + "\n\n审稿意见：\n" + feedback
		}
		if draft, err = chat(writer, prompt, 0.7); err != nil {
			return "", err
		}
		text, err := chat(reviewer, "大纲：\n"+outline+"\n\n<article>\n"+draft+"\n</article>", 0)
		if err != nil {
			return "", err
		}
		r := parseReview(text)
		fmt.Printf("[第 %d 稿] approved=%v score=%d feedback=%s\n", revision+1, r.Approved, r.Score, r.Feedback)
		if r.Approved {
			return draft, nil
		}
		feedback = r.Feedback
	}
	fmt.Println("已达到修订上限，输出最后一稿")
	return draft, nil
}

func main() {
	topic := strings.TrimSpace(strings.Join(os.Args[1:], " "))
	if topic == "" || utf8.RuneCountInString(topic) > 200 {
		fmt.Fprintln(os.Stderr, "用法：go run . <主题>（1~200 字）")
		os.Exit(1)
	}
	article, err := run(topic)
	if err != nil {
		fmt.Fprintln(os.Stderr, "出错：", err)
		os.Exit(1)
	}
	if err := os.WriteFile("article.md", []byte(article), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "保存失败：", err)
		os.Exit(1)
	}
	fmt.Println("\n已保存到 article.md")
}
```
```java [Java]
// src/main/java/WritingTeam.java —— 不依赖框架的写作团队
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;

public class WritingTeam {
    static final int MAX_REVISIONS = 2;
    static final String PLANNER = "你是技术专栏的策划编辑。根据主题写一份文章大纲：一个标题，加 3 到 5 个小节，每个小节一行“- 小节名：要点”。只输出大纲。";
    static final String WRITER = "你是资深技术作者。根据大纲用中文写一篇不超过 800 字的 Markdown 技术短文，面向有一定经验的开发者，准确、具体、可以有简短代码示例。如果提供了审稿意见，就在上一版基础上逐条修改。只输出文章正文。";
    static final String REVIEWER = "你是严格的技术审稿人。检查文章：技术准确性、是否覆盖大纲、结构是否清晰、是否超过 800 字。只输出一个 JSON 对象，不要输出其他内容：{\"approved\": true 或 false, \"score\": 1 到 10 的整数, \"feedback\": \"具体修改意见，通过时可为空\"}。score 达到 8 分及以上才能 approved 为 true。";

    record Message(String role, String content) {}
    record ChatRequest(String model, List<Message> messages, double temperature) {}
    record Review(boolean approved, int score, String feedback) {}

    static final ObjectMapper MAPPER = new ObjectMapper()
            .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);
    static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();

    static String env(String key, String def) {
        String v = System.getenv(key);
        return v == null || v.isBlank() ? def : v;
    }

    static String chat(String system, String user, double temperature) throws Exception {
        var body = MAPPER.writeValueAsString(new ChatRequest(env("LLM_MODEL", "gpt-4o-mini"),
                List.of(new Message("system", system), new Message("user", user)), temperature));
        String base = env("OPENAI_BASE_URL", "https://api.openai.com/v1").replaceAll("/+$", "");
        var req = HttpRequest.newBuilder(URI.create(base + "/chat/completions"))
                .timeout(Duration.ofSeconds(60))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + env("OPENAI_API_KEY", ""))
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();
        var resp = HTTP.send(req, HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() != 200) {
            throw new RuntimeException("API 返回 " + resp.statusCode() + "：" + resp.body());
        }
        JsonNode content = MAPPER.readTree(resp.body()).path("choices").path(0).path("message").path("content");
        return content.isTextual() ? content.asText() : "";
    }

    /** 容错解析：截取第一个 { 到最后一个 }，失败则视为未通过。 */
    static Review parseReview(String text) {
        int start = text.indexOf('{'), end = text.lastIndexOf('}');
        if (start != -1 && end > start) {
            try {
                JsonNode node = MAPPER.readTree(text.substring(start, end + 1));
                if (node.has("approved")) {
                    return new Review(node.path("approved").asBoolean(false),
                            node.path("score").asInt(0), node.path("feedback").asText(""));
                }
            } catch (Exception ignored) {
                // 落到下面的兜底逻辑
            }
        }
        String snippet = text.length() > 200 ? text.substring(0, 200) : text;
        return new Review(false, 0, "审稿结果无法解析，请检查结构和准确性：" + snippet);
    }

    static String run(String topic) throws Exception {
        String outline = chat(PLANNER, "主题：" + topic, 0.7);
        System.out.println("=== 大纲 ===\n" + outline + "\n");

        String draft = "", feedback = "";
        for (int revision = 0; revision <= MAX_REVISIONS; revision++) {
            String prompt = "大纲：\n" + outline;
            if (revision > 0) {
                prompt += "\n\n上一版文章：\n" + draft + "\n\n审稿意见：\n" + feedback;
            }
            draft = chat(WRITER, prompt, 0.7);
            Review r = parseReview(chat(REVIEWER, "大纲：\n" + outline + "\n\n<article>\n" + draft + "\n</article>", 0));
            System.out.printf("[第 %d 稿] approved=%s score=%d feedback=%s%n",
                    revision + 1, r.approved(), r.score(), r.feedback());
            if (r.approved()) {
                return draft;
            }
            feedback = r.feedback();
        }
        System.out.println("已达到修订上限，输出最后一稿");
        return draft;
    }

    public static void main(String[] args) throws Exception {
        String topic = String.join(" ", args).strip();
        if (topic.isEmpty() || topic.codePointCount(0, topic.length()) > 200) {
            System.err.println("用法：mvn -q compile exec:java -Dexec.mainClass=WritingTeam -Dexec.args=\"<主题>\"");
            System.exit(1);
        }
        String article = run(topic);
        Files.writeString(Path.of("article.md"), article, StandardCharsets.UTF_8);
        System.out.println("\n已保存到 article.md");
    }
}
```
:::

`for ... else` 是 Python 的语法：循环没有被 `break` 打断时执行 `else`，正好用来表示“修订次数用完了”。

### Step 4：用 LangGraph 重构

手写版本已经能用，但流程一复杂（比如加并行分支、人工审批、断点续跑），循环里的 if/else 会越来越难维护。[LangGraph](/guide/11-frameworks/langgraph) 把流程表达成一张状态图：

- **State**：一个 `TypedDict`，所有节点共享读写。
- **Node**：普通函数，接收当前 state，返回要更新的字段（部分更新即可）。
- **Edge**：`add_edge` 是固定连线；`add_conditional_edges` 根据路由函数的返回值决定下一个节点。
- `START` / `END`：图的入口和出口。`compile()` 之后得到可执行对象，用 `invoke()` 运行。

把 Step 3 的 Python 代码中的 `chat`、`parse_review` 和三个提示词复用过来：

```python
# graph_team.py —— LangGraph 版写作团队（需要 pip install langgraph）
import sys
from typing import TypedDict

from langgraph.graph import END, START, StateGraph

from team import MAX_REVISIONS, PLANNER, REVIEWER, WRITER, chat, parse_review


class TeamState(TypedDict, total=False):
    topic: str
    outline: str
    draft: str
    feedback: str
    approved: bool
    revision: int  # 已经写了几稿


def planner_node(state: TeamState) -> dict:
    outline = chat(PLANNER, f"主题：{state['topic']}")
    print(f"=== 大纲 ===\n{outline}\n")
    return {"outline": outline, "revision": 0}


def writer_node(state: TeamState) -> dict:
    prompt = f"大纲：\n{state['outline']}"
    if state.get("feedback"):
        prompt += f"\n\n上一版文章：\n{state['draft']}\n\n审稿意见：\n{state['feedback']}"
    return {"draft": chat(WRITER, prompt), "revision": state["revision"] + 1}


def reviewer_node(state: TeamState) -> dict:
    text = chat(REVIEWER, f"大纲：\n{state['outline']}\n\n<article>\n{state['draft']}\n</article>", 0)
    review = parse_review(text)
    print(f"[第 {state['revision']} 稿] approved={review['approved']} score={review['score']} "
          f"feedback={review['feedback'][:80]}")
    return {"approved": review["approved"], "feedback": review["feedback"]}


def route_after_review(state: TeamState) -> str:
    """通过，或已写满 MAX_REVISIONS + 1 稿，就结束；否则回到 writer。"""
    if state["approved"] or state["revision"] > MAX_REVISIONS:
        return "done"
    return "revise"


def build_graph():
    builder = StateGraph(TeamState)
    builder.add_node("planner", planner_node)
    builder.add_node("writer", writer_node)
    builder.add_node("reviewer", reviewer_node)

    builder.add_edge(START, "planner")
    builder.add_edge("planner", "writer")
    builder.add_edge("writer", "reviewer")
    builder.add_conditional_edges("reviewer", route_after_review, {"revise": "writer", "done": END})
    return builder.compile()


if __name__ == "__main__":
    topic = " ".join(sys.argv[1:]).strip()
    if not topic or len(topic) > 200:
        sys.exit("用法：python graph_team.py <主题>（1~200 字）")
    graph = build_graph()
    # recursion_limit 是 LangGraph 的兜底保护：节点执行步数超过上限会抛异常
    final = graph.invoke({"topic": topic}, config={"recursion_limit": 20})
    with open("article.md", "w", encoding="utf-8") as f:
        f.write(final["draft"])
    print("\n已保存到 article.md")
```

对比两个版本：

| 维度 | 手写版本 | LangGraph 版本 |
|------|---------|---------------|
| 依赖 | 只有 `openai` | 多一个 `langgraph` |
| 流程表达 | 循环 + if/else | 节点 + 边，结构一目了然 |
| 终止保护 | `for` 循环天然有上限 | 路由函数 + `recursion_limit` 双保险 |
| 扩展能力 | 加并行、断点续跑要自己写 | 内置 checkpointer、人工中断（interrupt）等能力 |
| 调试 | print 即可 | 可以导出图结构，也能接入 LangSmith 追踪 |

简单流程用手写版本完全够用，而且更容易看懂每一步发生了什么。流程中出现多分支、需要持久化状态或人工审批时，再考虑框架。

::: tip Go / Java 的框架选择
本项目的 LangGraph 版本只提供 Python。Go 和 Java 生态里有类似的图编排框架，例如 Go 的 Eino（字节跳动开源）、Java 的 LangGraph4j，但 API 变化较快，建议先掌握上面的手写版本，再按 [Go：Eino 与 langchaingo](/guide/11-frameworks/go-eino) 和 [Java：Spring AI 与 LangChain4j](/guide/11-frameworks/java-spring-ai) 的介绍选型，具体 API 以官方文档为准。
:::

## 运行与测试

::: code-group
```bash [Python]
python team.py 用 Redis 实现分布式锁
# 或 LangGraph 版本
python graph_team.py 用 Redis 实现分布式锁
```
```bash [Go]
set -a; source .env; set +a
go run . 用 Redis 实现分布式锁
```
```bash [Java]
set -a; source .env; set +a
mvn -q compile exec:java -Dexec.mainClass=WritingTeam -Dexec.args="用 Redis 实现分布式锁"
```
:::

预期输出（内容每次不同，结构类似）：

```text
=== 大纲 ===
# 用 Redis 实现分布式锁：从 SETNX 到 Redlock
- 为什么需要分布式锁：多实例并发修改同一资源
- 基本实现：SET key value NX PX 与唯一 value
- 安全释放：用 Lua 脚本校验 value 后再删除
- 常见坑：锁过期、主从切换、续期
- 小结：适用场景与替代方案

[第 1 稿] approved=False score=6 feedback=释放锁部分缺少 Lua 脚本示例；没有解释为什么 value 要唯一……
[第 2 稿] approved=True score=8 feedback=

已保存到 article.md
```

建议这样验证流程本身，而不只是看文章好不好：

1. **修订分支**：把 Reviewer 提示词里的通过门槛临时改成“score 达到 10 分才能通过”，应当看到写满 3 稿后打印“已达到修订上限”。
2. **解析容错**：在 Python 里单独测试 `parse_review`：

```python
from team import parse_review

assert parse_review('```json\n{"approved": true, "score": 9, "feedback": ""}\n```')["approved"] is True
assert parse_review("这篇文章写得不错")["approved"] is False  # 不是 JSON，按未通过处理
assert parse_review('{"score": 9}')["approved"] is False      # 缺少 approved 字段
print("ok")
```

3. **调用次数**：数一下打印的稿数，总调用次数 = 1（Planner）+ 2 × 稿数，最多 7 次。

## 扩展挑战

1. **按小节并行写作**：让 Writer 按大纲的每个小节分别写，再由一个 Editor 合并。Python 可以用 `asyncio.gather` 或 LangGraph 的 `Send` 实现扇出，注意并发数和限流。
2. **人工审批**：在 Planner 之后暂停，让用户确认或修改大纲再继续。LangGraph 可以用 checkpointer + interrupt 实现，手写版本用 `input()` 即可。
3. **不同角色用不同模型**：给 Reviewer 配一个更强的模型、Writer 用便宜的模型，对比质量和成本，参考 [成本与延迟优化](/guide/15-production/cost-optimization)。
4. **用评估集代替感觉**：准备 10 个主题，对比“单 Agent 一次写完”和“三角色协作”的审稿分数与 Token 消耗，参考 [LLM-as-Judge](/guide/14-evaluation/llm-judge)。
5. **加入事实核查员**：增加一个 Fact Checker 角色，专门检查代码示例和命令是否正确，并思考它应该放在 Reviewer 之前还是并行执行。


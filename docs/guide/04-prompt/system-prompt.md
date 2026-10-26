---
title: 系统提示词与角色设计
description: 系统提示词是 Agent 的"岗位说明书"：如何组织角色、目标、规则、工具说明与输出格式。
---

# 系统提示词与角色设计

::: info 学习目标
- 理解 system 消息与 user 消息的职责区别，以及它们在 API 中的位置
- 掌握一份生产级系统提示词的结构：身份、目标、规则、工具、格式、示例
- 知道"角色扮演"真正起作用的部分，避免空洞的"你是世界顶级专家"
- 学会把系统提示词做成可拼装的模块，而不是一大段字符串
:::

## system 消息是什么

在 Chat Completions API 中，一次请求的 `messages` 是一个列表，每条消息有一个 `role`：

| role | 由谁写 | 作用 |
|------|-------|------|
| `system` | 开发者 | 设定身份、长期规则、输出格式，对整个会话生效 |
| `user` | 终端用户 | 本轮的具体请求 |
| `assistant` | 模型 | 模型之前的回复（多轮对话时由你回传） |
| `tool` | 你的程序 | 工具执行结果（见 [工具调用原理](/guide/05-tool-calling/concept)） |

模型在训练时被教导"system 的优先级高于 user"，所以那些**不希望被用户一句话推翻**的规则应该放在 system 里。不过这只是倾向而不是保证：系统提示词不是安全边界，敏感操作必须在代码里做权限校验（见 [权限控制与人在环路](/guide/15-production/permissions-hitl)）。

::: tip 不同厂商的差异
OpenAI 兼容接口把 system 作为 `messages` 中的一条消息；Anthropic 原生 API 则使用独立的 `system` 参数（`client.messages.create(system=..., messages=[...])`）。概念相同，写法不同。部分 OpenAI 新模型还支持 `developer` 角色，作用与 system 类似，以官方文档为准。
:::

## 一份系统提示词的骨架

一份好的 Agent 系统提示词通常由下面几块组成，顺序大致如此：

```text
┌─────────────────────────────────────────────┐
│ 1. 身份与场景   你是谁、服务谁、在什么产品里   │
│ 2. 目标         什么算"做好了"                │
│ 3. 行为规则     必须做 / 禁止做 / 不确定时怎么办 │
│ 4. 工具说明     何时用哪个工具（如有）         │
│ 5. 输出格式     语言、长度、结构               │
│ 6. 示例         1~3 个典型输入输出（可选）      │
│ 7. 动态上下文   当前时间、用户信息、检索结果     │
└─────────────────────────────────────────────┘
```

前 6 块基本是静态的，第 7 块每次请求都可能变化。把静态部分放前面、动态部分放后面，还有一个实际好处：很多厂商支持 [Prompt Caching](/guide/07-context-engineering/prompt-caching)，前缀不变的部分可以命中缓存，降低成本和延迟。

## 角色设计：什么真正有用

"你是一位拥有 20 年经验的世界顶级 Python 专家"这类句子，对现代模型的提升很有限。真正起作用的是角色背后的**具体信息**：

| 空洞写法 | 有效写法 |
|---------|---------|
| 你是专业的客服 | 你是"小麦商城"的售后客服，处理退换货和物流查询 |
| 你很有耐心 | 用户情绪激动时，先确认问题再给方案，不要辩解 |
| 你是资深程序员 | 代码审查时优先关注：并发安全、资源泄漏、SQL 注入 |
| 回答要准确 | 订单状态以 `get_order` 工具返回为准，查不到就说查不到，不要编造 |

角色的价值在于**收窄任务空间**：告诉模型它在哪个业务里、面对谁、边界在哪。边界尤其重要，一个客服 Agent 被问到"帮我写首诗"时该怎么办，应该写在提示词里，而不是交给模型临场发挥。

## 一个完整示例

下面是一份售后客服 Agent 的系统提示词。注意它用 Markdown 标题分区，规则可执行、可检验：

```markdown
# 身份
你是"小麦商城"的售后客服助手，通过网页聊天窗口为已登录用户服务。

# 目标
帮助用户解决退换货、物流查询、发票问题。一次对话尽量完整解决一个问题。

# 规则
- 订单、物流信息只能来自工具返回结果，不得猜测或编造。
- 退款金额超过 500 元时，不要直接承诺，告知用户将转人工审核。
- 与售后无关的请求（写作、编程、闲聊），礼貌说明你只负责售后问题。
- 不确定用户指的是哪个订单时，先列出最近订单让用户确认。

# 输出格式
- 使用简体中文，语气友好、简洁，每次回复不超过 150 字。
- 涉及多个步骤时使用编号列表。

# 当前上下文
- 当前时间：{now}
- 用户昵称：{nickname}
```

## 动手：把系统提示词模块化

在真实项目中，系统提示词会根据用户、租户、启用的功能动态拼装。把各部分拆成独立片段，比维护一个巨大的字符串更容易测试和复用。下面的例子把静态部分和动态上下文分开，并演示一次带 system 消息的调用。

::: code-group
```python [Python]
import os
from datetime import datetime
from openai import OpenAI

IDENTITY = "# 身份\n你是\"小麦商城\"的售后客服助手，通过网页聊天窗口为已登录用户服务。"
GOAL = "# 目标\n帮助用户解决退换货、物流查询、发票问题。"
RULES = """# 规则
- 订单、物流信息只能来自工具返回结果，不得猜测或编造。
- 退款金额超过 500 元时，不要直接承诺，告知用户将转人工审核。
- 与售后无关的请求，礼貌说明你只负责售后问题。"""
FORMAT = "# 输出格式\n使用简体中文，语气友好、简洁，每次回复不超过 150 字。"


def build_system_prompt(nickname: str) -> str:
    # 静态部分在前（利于缓存），动态上下文在后
    static = [IDENTITY, GOAL, RULES, FORMAT]
    # 昵称来自用户资料，去掉换行，避免伪造新的"# 规则"段落
    safe_nick = nickname.replace("\n", " ")[:32]
    dynamic = (
        "# 当前上下文\n"
        f"- 当前时间：{datetime.now():%Y-%m-%d %H:%M}\n"
        f"- 用户昵称：{safe_nick}"
    )
    return "\n\n".join(static + [dynamic])


client = OpenAI(
    api_key=os.environ["OPENAI_API_KEY"],
    base_url=os.getenv("OPENAI_BASE_URL"),
    timeout=30,
)

if __name__ == "__main__":
    messages = [
        {"role": "system", "content": build_system_prompt("小王")},
        {"role": "user", "content": "帮我写一首关于春天的诗"},
    ]
    resp = client.chat.completions.create(
        model=os.getenv("LLM_MODEL", "gpt-4o-mini"), messages=messages
    )
    print(resp.choices[0].message.content)  # 预期：礼貌拒绝并说明职责范围
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

var staticSections = []string{
	"# 身份\n你是\"小麦商城\"的售后客服助手，通过网页聊天窗口为已登录用户服务。",
	"# 目标\n帮助用户解决退换货、物流查询、发票问题。",
	"# 规则\n- 订单、物流信息只能来自工具返回结果，不得猜测或编造。\n" +
		"- 退款金额超过 500 元时，不要直接承诺，告知用户将转人工审核。\n" +
		"- 与售后无关的请求，礼貌说明你只负责售后问题。",
	"# 输出格式\n使用简体中文，语气友好、简洁，每次回复不超过 150 字。",
}

func buildSystemPrompt(nickname string) string {
	safeNick := strings.ReplaceAll(nickname, "\n", " ")
	if r := []rune(safeNick); len(r) > 32 {
		safeNick = string(r[:32])
	}
	dynamic := fmt.Sprintf("# 当前上下文\n- 当前时间：%s\n- 用户昵称：%s",
		time.Now().Format("2006-01-02 15:04"), safeNick)
	return strings.Join(append(append([]string{}, staticSections...), dynamic), "\n\n")
}

type message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	payload := map[string]any{
		"model": env("LLM_MODEL", "gpt-4o-mini"),
		"messages": []message{
			{Role: "system", Content: buildSystemPrompt("小王")},
			{Role: "user", Content: "帮我写一首关于春天的诗"},
		},
	}
	body, _ := json.Marshal(payload)
	url := strings.TrimRight(env("OPENAI_BASE_URL", "https://api.openai.com/v1"), "/") + "/chat/completions"
	req, _ := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+os.Getenv("OPENAI_API_KEY"))

	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer resp.Body.Close()
	var out struct {
		Choices []struct {
			Message message `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil || len(out.Choices) == 0 {
		fmt.Fprintln(os.Stderr, "bad response, status:", resp.StatusCode)
		os.Exit(1)
	}
	fmt.Println(out.Choices[0].Message.Content)
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
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

public class SystemPromptDemo {
    static final List<String> STATIC_SECTIONS = List.of(
            "# 身份\n你是\"小麦商城\"的售后客服助手，通过网页聊天窗口为已登录用户服务。",
            "# 目标\n帮助用户解决退换货、物流查询、发票问题。",
            """
            # 规则
            - 订单、物流信息只能来自工具返回结果，不得猜测或编造。
            - 退款金额超过 500 元时，不要直接承诺，告知用户将转人工审核。
            - 与售后无关的请求，礼貌说明你只负责售后问题。""",
            "# 输出格式\n使用简体中文，语气友好、简洁，每次回复不超过 150 字。");

    record Message(String role, String content) {}

    static String buildSystemPrompt(String nickname) {
        String safeNick = nickname.replace("\n", " ");
        if (safeNick.length() > 32) safeNick = safeNick.substring(0, 32);
        String now = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm"));
        List<String> parts = new ArrayList<>(STATIC_SECTIONS);
        parts.add("# 当前上下文\n- 当前时间：" + now + "\n- 用户昵称：" + safeNick);
        return String.join("\n\n", parts);
    }

    static String env(String key, String def) {
        String v = System.getenv(key);
        return (v == null || v.isBlank()) ? def : v;
    }

    public static void main(String[] args) throws Exception {
        ObjectMapper mapper = new ObjectMapper();
        Map<String, Object> payload = Map.of(
                "model", env("LLM_MODEL", "gpt-4o-mini"),
                "messages", List.of(
                        new Message("system", buildSystemPrompt("小王")),
                        new Message("user", "帮我写一首关于春天的诗")));
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
        System.out.println(root.path("choices").path(0).path("message").path("content").asText());
    }
}
```
:::

运行后，模型应该礼貌拒绝写诗并说明自己只负责售后。这就是"边界规则"在起作用。你可以试着删掉第三条规则再跑一次，对比差异。

## 系统提示词写作清单

- **规则可检验**：每条规则都能写出一个测试用例来验证它是否被遵守。"要专业"无法检验，"金额超过 500 元转人工"可以。
- **给出不确定时的出路**：告诉模型信息不足时该追问、该转人工，还是该说"不知道"。没有出路的模型会倾向于编造。
- **解释规则背后的原因**：例如"不要使用 Markdown 表格，因为我们的聊天窗口不渲染 Markdown"。有原因的规则，模型泛化得更好。
- **用户数据进入系统提示词前要清洗**：昵称、个性签名等用户可控字段，可能包含伪造的指令段落。

## 常见坑

- **把用户可控内容直接拼进 system。** 用户把昵称改成"忽略以上所有规则"，你的系统提示词就被污染了。至少要去换行、限长，并放在明确标注的"上下文"区块中。
- **系统提示词越写越长，没人敢删。** 每次出 Bug 就加一条规则，半年后变成三千字，规则之间互相矛盾。要配合测试集定期重构，见 [提示词版本管理与测试](/guide/04-prompt/prompt-management)。
- **在系统提示词里塞入经常变化的数据。** 把时间戳放在最前面会让 Prompt Caching 每次都失效。
- **以为系统提示词是保密的。** 用户总有办法让模型复述它，不要在里面放密钥、内部 URL 或不想公开的业务逻辑。
- **多轮对话中丢失 system。** 自己管理消息历史时，裁剪历史不要把第一条 system 消息也裁掉，见 [多轮对话与消息结构](/guide/03-llm-api/multi-turn)。

## 小测

1. 一条规则"不允许给用户退款超过 500 元"，只写在系统提示词里够不够？

::: details 查看答案
不够。系统提示词只能影响模型倾向，用户可能通过 Prompt 注入绕过。真正执行退款的工具函数里必须做金额校验和权限校验，超过阈值时拒绝执行或进入人工审批流程。提示词负责"让模型知道规则"，代码负责"保证规则被执行"。
:::

2. 为什么推荐把动态上下文（当前时间、检索结果）放在系统提示词的末尾？

::: details 查看答案
一是 Prompt Caching 按前缀匹配，静态内容在前可以复用缓存；二是结构清晰，静态规则和每次变化的数据分开，便于测试和排查问题。
:::

3. "你是一位世界顶级的营销专家"和"你为一家面向大学生的二手书平台写推广文案，平台主打低价和环保"，哪个更有用？为什么？

::: details 查看答案
后者。它提供了具体的业务、受众和卖点，直接收窄了任务空间。前者只是一个空泛的头衔，模型并不会因此获得新的信息。
:::

## 延伸阅读

- [Anthropic：Giving Claude a role with a system prompt](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/system-prompts)
- [OpenAI Prompt engineering 指南](https://platform.openai.com/docs/guides/prompt-engineering)
- 下一篇：[Few-shot 与思维链](/guide/04-prompt/few-shot-cot)

---
title: 结构化输出与 JSON Schema
description: 从"请输出 JSON"到 response_format json_schema，再到程序侧的 pydantic / struct / record 校验，让模型输出可以被程序可靠消费。
---

# 结构化输出与 JSON Schema

::: info 学习目标
- 理解让模型输出 JSON 的三个层级：提示词约束、JSON Mode、JSON Schema（Structured Outputs）
- 会写 `response_format` 的 `json_schema` 参数，并知道 strict 模式对 Schema 的要求
- 掌握程序侧校验：Python 用 pydantic，Go 用 struct + 校验函数，Java 用 record + Jackson
- 知道不同厂商的支持程度差异，以及不支持时如何降级
:::

## 为什么需要结构化输出

Agent 中大量的模型输出不是给人看的，而是给程序用的：抽取出的字段要写数据库，分类结果要走 if/else，计划步骤要逐个执行。这时"大体正确的自然语言"是没用的，你需要**能被 `json.loads` 解析、字段齐全、类型正确**的数据。

只在提示词里写"请输出 JSON"会遇到这些问题：

```text
模型实际输出                                  问题
──────────────────────────────────────────   ─────────────────
好的，以下是提取结果：{"title": "周会"}        JSON 前后有废话
（用 Markdown 代码块包住的 JSON）            多了代码块标记
{"title": "周会", "date": "下周三"}            日期格式不符合要求
{"name": "周会"}                              字段名不对
{"title": "周会",}                            非法 JSON（尾逗号）
```

## 三个层级

| 层级 | 做法 | 保证程度 | 厂商支持 |
|------|------|---------|---------|
| 1. 提示词约束 | 提示词中描述格式并给示例 | 无保证，靠模型自觉 | 所有模型 |
| 2. JSON Mode | `response_format={"type": "json_object"}` | 保证是合法 JSON，不保证字段 | 大多数 OpenAI 兼容厂商 |
| 3. JSON Schema | `response_format={"type": "json_schema", ...}` | strict 模式下保证符合 Schema | OpenAI 及部分厂商，以各家文档为准 |

JSON Schema 模式的原理是**受约束解码（constrained decoding）**：模型在生成每个 Token 时，推理引擎会屏蔽掉会导致输出不符合 Schema 的候选 Token。所以它不是"更听话"，而是"根本生成不出不合法的结构"。

::: warning JSON Mode 的一个硬性要求
使用 `json_object` 模式时，OpenAI 要求消息中必须出现 "JSON" 这个词（通常写在 system 提示词里），否则会报错。其他兼容厂商多数沿用了这个约定。
:::

## response_format 的写法

一个 JSON Schema 请求的关键部分如下（注释仅为说明，真实 JSON 不能有注释）：

```json
{
  "model": "gpt-4o-mini",
  "messages": [...],
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "meeting",          // Schema 名称，字母数字下划线
      "strict": true,             // 开启严格模式，保证输出符合 Schema
      "schema": {
        "type": "object",
        "properties": {
          "title":     { "type": "string" },
          "date":      { "type": "string", "description": "YYYY-MM-DD" },
          "attendees": { "type": "array", "items": { "type": "string" } },
          "priority":  { "type": "string", "enum": ["high", "medium", "low"] }
        },
        "required": ["title", "date", "attendees", "priority"],
        "additionalProperties": false
      }
    }
  }
}
```

strict 模式对 Schema 有一些限制（以 OpenAI 文档为准）：

- 所有字段都必须列在 `required` 里。可选字段用 `"type": ["string", "null"]` 表示"可以为空"。
- 每个 object 都必须设置 `"additionalProperties": false`。
- 只支持 JSON Schema 的一个子集，部分关键字（如某些格式校验）不被支持。

## 为什么程序侧还要校验

即使用了 strict 模式，程序侧校验仍然必要：

1. **Schema 管不了业务规则**。Schema 能保证 `date` 是字符串，但很难保证它是一个合法日期，更管不了"会议日期不能早于今天"。
2. **模型可能拒答**。OpenAI 在安全拒绝时会返回 `refusal` 字段而不是你要的 JSON。
3. **输出可能被截断**。达到 `max_tokens` 上限时，JSON 可能只输出了一半，此时 `finish_reason` 为 `length`。
4. **换厂商时可能降级**。有的厂商只支持 JSON Mode，有的忽略 strict 参数。

所以正确的分工是：**Schema 负责结构，代码负责校验和业务规则**。代码侧的校验方法在 [数据校验：pydantic / struct tag / record](/guide/01-programming/data-validation) 中有更详细的介绍。

## 动手：会议信息抽取

下面的例子从一句自然语言中抽取会议信息。Python 用 pydantic 定义模型，并由它生成 JSON Schema；Go 和 Java 手写 Schema，用结构体和 record 做反序列化与校验。

::: code-group
```python [Python]
# pip install openai pydantic
import os
import datetime
from typing import Literal

from openai import OpenAI
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator


class Meeting(BaseModel):
    # extra="forbid" 会在生成的 Schema 中加入 "additionalProperties": false
    model_config = ConfigDict(extra="forbid")

    title: str = Field(description="会议主题")
    date: str = Field(description="会议日期，格式 YYYY-MM-DD")
    attendees: list[str] = Field(description="参会人姓名列表")
    priority: Literal["high", "medium", "low"]

    @field_validator("date")
    @classmethod
    def check_date(cls, v: str) -> str:
        datetime.date.fromisoformat(v)  # 不是合法日期会抛 ValueError
        return v

    @field_validator("attendees")
    @classmethod
    def check_attendees(cls, v: list[str]) -> list[str]:
        if not v:
            raise ValueError("attendees must not be empty")
        return v


client = OpenAI(
    api_key=os.environ["OPENAI_API_KEY"],
    base_url=os.getenv("OPENAI_BASE_URL"),
    timeout=30,
)


def extract_meeting(text: str) -> Meeting:
    resp = client.chat.completions.create(
        model=os.getenv("LLM_MODEL", "gpt-4o-mini"),
        messages=[
            {"role": "system", "content": f"从用户消息中抽取会议信息。今天是 {datetime.date.today()}。"},
            {"role": "user", "content": text},
        ],
        response_format={
            "type": "json_schema",
            "json_schema": {
                "name": "meeting",
                "strict": True,
                "schema": Meeting.model_json_schema(),
            },
        },
    )
    choice = resp.choices[0]
    if getattr(choice.message, "refusal", None):
        raise RuntimeError(f"model refused: {choice.message.refusal}")
    if choice.finish_reason == "length":
        raise RuntimeError("output truncated, increase max_tokens")
    # 结构 + 业务规则一起校验，失败抛 ValidationError
    return Meeting.model_validate_json(choice.message.content or "")


if __name__ == "__main__":
    try:
        m = extract_meeting("下周一下午和张三、李四开个架构评审会，比较紧急")
        print(m.model_dump())
    except ValidationError as e:
        print("校验失败：", e)
```
```go [Go]
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"
)

type Meeting struct {
	Title     string   `json:"title"`
	Date      string   `json:"date"`
	Attendees []string `json:"attendees"`
	Priority  string   `json:"priority"`
}

// Validate 负责 Schema 管不到的业务规则
func (m Meeting) Validate() error {
	if strings.TrimSpace(m.Title) == "" {
		return errors.New("title is empty")
	}
	if _, err := time.Parse("2006-01-02", m.Date); err != nil {
		return fmt.Errorf("invalid date %q", m.Date)
	}
	if len(m.Attendees) == 0 {
		return errors.New("attendees must not be empty")
	}
	switch m.Priority {
	case "high", "medium", "low":
	default:
		return fmt.Errorf("invalid priority %q", m.Priority)
	}
	return nil
}

var meetingSchema = map[string]any{
	"type": "object",
	"properties": map[string]any{
		"title":     map[string]any{"type": "string", "description": "会议主题"},
		"date":      map[string]any{"type": "string", "description": "会议日期，格式 YYYY-MM-DD"},
		"attendees": map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
		"priority":  map[string]any{"type": "string", "enum": []string{"high", "medium", "low"}},
	},
	"required":             []string{"title", "date", "attendees", "priority"},
	"additionalProperties": false,
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func extractMeeting(text string) (*Meeting, error) {
	body, _ := json.Marshal(map[string]any{
		"model": env("LLM_MODEL", "gpt-4o-mini"),
		"messages": []map[string]string{
			{"role": "system", "content": "从用户消息中抽取会议信息。今天是 " + time.Now().Format("2006-01-02") + "。"},
			{"role": "user", "content": text},
		},
		"response_format": map[string]any{
			"type": "json_schema",
			"json_schema": map[string]any{
				"name": "meeting", "strict": true, "schema": meetingSchema,
			},
		},
	})
	url := strings.TrimRight(env("OPENAI_BASE_URL", "https://api.openai.com/v1"), "/") + "/chat/completions"
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+os.Getenv("OPENAI_API_KEY"))
	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	var out struct {
		Choices []struct {
			FinishReason string `json:"finish_reason"`
			Message      struct {
				Content string `json:"content"`
				Refusal string `json:"refusal"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil || len(out.Choices) == 0 {
		return nil, fmt.Errorf("bad response: %v", err)
	}
	c := out.Choices[0]
	if c.Message.Refusal != "" {
		return nil, fmt.Errorf("model refused: %s", c.Message.Refusal)
	}
	if c.FinishReason == "length" {
		return nil, errors.New("output truncated")
	}
	// 严格反序列化：出现未知字段直接报错
	dec := json.NewDecoder(strings.NewReader(c.Message.Content))
	dec.DisallowUnknownFields()
	var m Meeting
	if err := dec.Decode(&m); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}
	if err := m.Validate(); err != nil {
		return nil, fmt.Errorf("validate: %w", err)
	}
	return &m, nil
}

func main() {
	m, err := extractMeeting("下周一下午和张三、李四开个架构评审会，比较紧急")
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
	fmt.Printf("%+v\n", *m)
}
```
```java [Java]
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.Set;

public class StructuredOutput {
    // record 的紧凑构造器负责校验：反序列化时自动执行
    record Meeting(String title, String date, List<String> attendees, String priority) {
        Meeting {
            if (title == null || title.isBlank()) throw new IllegalArgumentException("title is empty");
            LocalDate.parse(date); // 非法日期抛 DateTimeParseException
            if (attendees == null || attendees.isEmpty()) throw new IllegalArgumentException("attendees empty");
            if (!Set.of("high", "medium", "low").contains(priority))
                throw new IllegalArgumentException("invalid priority: " + priority);
        }
    }

    static final Map<String, Object> SCHEMA = Map.of(
            "type", "object",
            "properties", Map.of(
                    "title", Map.of("type", "string", "description", "会议主题"),
                    "date", Map.of("type", "string", "description", "会议日期，格式 YYYY-MM-DD"),
                    "attendees", Map.of("type", "array", "items", Map.of("type", "string")),
                    "priority", Map.of("type", "string", "enum", List.of("high", "medium", "low"))),
            "required", List.of("title", "date", "attendees", "priority"),
            "additionalProperties", false);

    static final ObjectMapper MAPPER = new ObjectMapper()
            .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, true);

    static String env(String key, String def) {
        String v = System.getenv(key);
        return (v == null || v.isBlank()) ? def : v;
    }

    static Meeting extractMeeting(String text) throws Exception {
        var payload = Map.of(
                "model", env("LLM_MODEL", "gpt-4o-mini"),
                "messages", List.of(
                        Map.of("role", "system", "content", "从用户消息中抽取会议信息。今天是 " + LocalDate.now() + "。"),
                        Map.of("role", "user", "content", text)),
                "response_format", Map.of(
                        "type", "json_schema",
                        "json_schema", Map.of("name", "meeting", "strict", true, "schema", SCHEMA)));
        String baseUrl = env("OPENAI_BASE_URL", "https://api.openai.com/v1").replaceAll("/+$", "");
        HttpRequest req = HttpRequest.newBuilder(URI.create(baseUrl + "/chat/completions"))
                .timeout(Duration.ofSeconds(30))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + System.getenv("OPENAI_API_KEY"))
                .POST(HttpRequest.BodyPublishers.ofString(MAPPER.writeValueAsString(payload)))
                .build();
        HttpResponse<String> resp = HttpClient.newHttpClient().send(req, HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() != 200) throw new IllegalStateException("HTTP " + resp.statusCode());

        JsonNode choice = MAPPER.readTree(resp.body()).path("choices").path(0);
        JsonNode message = choice.path("message");
        if (message.hasNonNull("refusal")) throw new IllegalStateException("refused: " + message.get("refusal").asText());
        if ("length".equals(choice.path("finish_reason").asText())) throw new IllegalStateException("output truncated");
        // 反序列化 + 紧凑构造器校验，任何一步失败都会抛异常
        return MAPPER.readValue(message.path("content").asText(), Meeting.class);
    }

    public static void main(String[] args) throws Exception {
        System.out.println(extractMeeting("下周一下午和张三、李四开个架构评审会，比较紧急"));
    }
}
```
:::

::: tip Python SDK 的便捷写法
`openai` Python SDK 还提供了直接传入 pydantic 模型的 `parse` 辅助方法（会自动生成 strict Schema 并解析成对象）。不同 SDK 版本中它的位置有变化（`client.beta.chat.completions.parse` 或 `client.chat.completions.parse`），API 以官方文档为准。上面的写法只依赖稳定的 `create` 接口，对所有兼容厂商都适用。
:::

## 校验失败之后怎么办

校验失败不等于任务失败。常见的处理策略：

```text
             ┌────────── 校验通过 ──────────▶ 返回结果
模型输出 ──▶ 校验
             └── 校验失败 ──▶ 把错误信息追加进对话，让模型修正（最多 N 次）
                                   │
                                   └── 仍失败 ──▶ 降级：返回默认值 / 转人工 / 报错
```

"把错误信息喂回给模型"非常有效。例如追加一条 user 消息："你的输出有误：date 字段 '下周一' 不是 YYYY-MM-DD 格式，请修正后重新输出完整 JSON。"这和 [工具错误处理与重试](/guide/05-tool-calling/error-handling) 里的思路完全一致。

## 结构化输出与 Tool Calling 的关系

Tool Calling 本质上也是结构化输出：模型按照你提供的参数 Schema 生成 JSON 参数。区别在于语义：

| | 结构化输出 | Tool Calling |
|--|-----------|-------------|
| 用途 | 模型的**最终回答**需要结构化 | 模型想**调用一个函数** |
| 谁来决定 | 每次都按 Schema 输出 | 模型自己决定是否调用、调哪个 |
| 典型场景 | 信息抽取、分类、生成计划 | 查数据库、调外部 API |

在一些不支持 `json_schema` 的厂商上，常见的降级技巧是：定义一个只有一个工具的 Tool，并强制模型调用它，然后取工具参数作为结构化结果。详见 [工具调用原理](/guide/05-tool-calling/concept)。

## 常见坑

- **strict 模式下有可选字段。** 字段不在 `required` 里会直接报 Schema 错误。用 `["string", "null"]` 表达可空。
- **忘了处理 refusal 和截断。** 直接 `json.loads(content)`，遇到拒答或截断就抛出一个让人摸不着头脑的解析错误。
- **Schema 里没有 description。** 字段名 `date` 对模型来说含义模糊，加上"会议日期，格式 YYYY-MM-DD"能显著减少错误。
- **相对时间没有给参照。** "下周一"必须依赖"今天是几号"，不在提示词里告诉模型当前日期，它只能瞎猜。
- **以为所有厂商都支持 strict。** 换厂商前先查文档，必要时降级为 JSON Mode + 程序侧校验 + 重试。

## 小测

1. 已经用了 strict 模式的 JSON Schema，为什么还需要 pydantic 校验？

::: details 查看答案
Schema 只保证结构和类型，管不了业务规则（日期是否合法、列表是否为空）；模型可能拒答或输出被截断；切换到不支持 strict 的厂商时结构保证会消失。程序侧校验是最后一道防线。
:::

2. 在 strict 模式下，如何表示"备注字段可以没有"？

::: details 查看答案
仍然把它放进 `required`，但类型写成 `["string", "null"]`，让模型在没有备注时输出 `null`。
:::

3. JSON Mode（`json_object`）和 JSON Schema 模式的核心区别是什么？

::: details 查看答案
JSON Mode 只保证输出是合法 JSON，不保证字段名、类型和必填项；JSON Schema 的 strict 模式通过受约束解码保证输出符合你给定的 Schema。
:::

## 延伸阅读

- [OpenAI Structured Outputs 指南](https://platform.openai.com/docs/guides/structured-outputs)
- [JSON Schema 官网](https://json-schema.org/)
- [Pydantic 文档：JSON Schema](https://docs.pydantic.dev/latest/concepts/json_schema/)
- 下一篇：[提示词版本管理与测试](/guide/04-prompt/prompt-management)

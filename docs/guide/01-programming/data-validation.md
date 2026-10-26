---
title: 数据校验：pydantic / struct tag / record
description: 模型输出是不可信输入。用 Python pydantic、Go struct tag、Java record 校验工具参数和结构化输出，并把错误反馈给模型。
---

# 数据校验：pydantic / struct tag / record

::: info 学习目标
- 理解为什么模型输出（尤其是工具参数）必须像用户输入一样校验
- 掌握 pydantic v2 的核心用法：字段约束、自定义校验器、生成 JSON Schema
- 用 Go struct tag 和 Java record 实现同等的「解析 + 校验」
- 学会把校验错误整理成模型能看懂的反馈，让它自我修正
:::

## 模型输出是不可信输入

在 Agent 中，模型会生成工具调用参数，例如：

```json
{"title": "周会", "day": "2025-03-10", "duration_minutes": 60}
```

你很可能直接 `json.loads` 后传给函数。但模型可能输出：

| 问题 | 示例 |
| --- | --- |
| 不是合法 JSON | 少了右括号、混入了解释文字 |
| 缺少必填字段 | 没有 `day` |
| 类型错误 | `"duration_minutes": "一小时"` |
| 取值越界 | `"duration_minutes": 100000` |
| 格式不对 | `"day": "下周一"` |
| 编造的字段 | `"force_delete": true` |
| 不在允许范围内的枚举 | `"priority": "urgent"`，而你只支持 low / normal / high |

即使使用了 [结构化输出与 JSON Schema](/guide/04-prompt/structured-output) 约束，也不能保证业务规则（如日期不能是过去、时长不超过 8 小时）都满足。更何况模型的输入可能被 [Prompt 注入](/guide/15-production/prompt-injection) 污染。所以原则只有一条：**在执行任何操作之前，在边界上校验**。

```text
模型输出(字符串) ──▶ 解析 JSON ──▶ 映射到类型 ──▶ 业务规则校验 ──┬─ 通过 ──▶ 执行工具
                                                            └─ 失败 ──▶ 错误信息回传模型，让它重试
```

## 三种语言的思路

| | Python | Go | Java |
| --- | --- | --- | --- |
| 定义结构 | pydantic `BaseModel` | `struct` + `json` tag | `record` + Jackson |
| 类型转换 | 自动，默认宽松（`"60"` 可转为 60） | 严格，类型不符直接报错 | 默认较宽松，可配置 |
| 字段约束 | `Field(min_length=..., ge=...)` | 手写 `Validate()` 或用校验库 | 紧凑构造器里检查，或 Bean Validation |
| 拒绝多余字段 | `extra="forbid"` | `Decoder.DisallowUnknownFields()` | `FAIL_ON_UNKNOWN_PROPERTIES` |
| 生成 JSON Schema | 内置 `model_json_schema()` | 第三方库 | 第三方库 |

Python 的 pydantic 是事实标准，OpenAI / Anthropic SDK、FastAPI、LangChain 等都在用它。Go 常用 [go-playground/validator](https://github.com/go-playground/validator) 通过 `validate:"..."` tag 声明规则；Java 常用 Bean Validation（如 Hibernate Validator）的 `@NotBlank`、`@Size` 等注解。下面的示例为了不引入校验库，Go 和 Java 都手写校验逻辑，原理一目了然。

## 动手：校验工具参数

场景：一个创建日程的工具 `create_event`，参数规则如下。

- `title`：必填，1~100 个字符
- `day`：必填，`YYYY-MM-DD` 格式的日期
- `duration_minutes`：必填，15~480 之间的整数
- `priority`：可选，只能是 `low` / `normal` / `high`，默认 `normal`
- `attendees`：可选，邮箱列表，最多 20 个
- 不允许出现其他字段

三个版本用同样的两组输入测试：一组合法，一组有多处错误。不需要 API Key，可以直接运行。

::: code-group
```python [Python]
# 依赖：pip install pydantic   （pydantic v2）
import json
from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator


class CreateEventArgs(BaseModel):
    """创建日程。"""
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    title: str = Field(min_length=1, max_length=100, description="日程标题")
    day: date = Field(description="日期，格式 YYYY-MM-DD")
    duration_minutes: int = Field(ge=15, le=480, description="时长（分钟）")
    priority: Literal["low", "normal", "high"] = "normal"
    attendees: list[str] = Field(default_factory=list, max_length=20)

    @field_validator("attendees")
    @classmethod
    def check_emails(cls, v: list[str]) -> list[str]:
        for email in v:
            if "@" not in email:
                raise ValueError(f"不是合法邮箱: {email!r}")
        return v


def parse_args(raw: str) -> CreateEventArgs | str:
    """返回校验后的对象；失败时返回给模型看的错误说明。"""
    try:
        return CreateEventArgs.model_validate_json(raw)  # 解析 JSON + 校验，一步完成
    except ValidationError as e:
        problems = [f"{'.'.join(map(str, err['loc']))}: {err['msg']}" for err in e.errors()]
        return "参数校验失败: " + "; ".join(problems)


if __name__ == "__main__":
    inputs = [
        '{"title": "周会", "day": "2025-03-10", "duration_minutes": 60, "attendees": ["li@example.com"]}',
        '{"title": "", "day": "3月10日", "duration_minutes": 5, "priority": "urgent"}',
    ]
    for raw in inputs:
        print(parse_args(raw))

    # 同一个模型还能直接生成工具的 JSON Schema
    print(json.dumps(CreateEventArgs.model_json_schema(), ensure_ascii=False, indent=2))
```
```go [Go]
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

// CreateEventArgs 是工具 create_event 的参数。struct tag 定义 JSON 字段名。
type CreateEventArgs struct {
	Title           string   `json:"title"`
	Day             string   `json:"day"`
	DurationMinutes int      `json:"duration_minutes"`
	Priority        string   `json:"priority,omitempty"`
	Attendees       []string `json:"attendees,omitempty"`
}

// Validate 检查业务规则，一次性返回所有错误。
func (a *CreateEventArgs) Validate() error {
	var errs []error
	if n := utf8.RuneCountInString(strings.TrimSpace(a.Title)); n < 1 || n > 100 {
		errs = append(errs, errors.New("title: 长度必须在 1~100 之间"))
	}
	if _, err := time.Parse("2006-01-02", a.Day); err != nil {
		errs = append(errs, errors.New("day: 必须是 YYYY-MM-DD 格式"))
	}
	if a.DurationMinutes < 15 || a.DurationMinutes > 480 {
		errs = append(errs, errors.New("duration_minutes: 必须在 15~480 之间"))
	}
	if a.Priority == "" {
		a.Priority = "normal" // 默认值
	}
	switch a.Priority {
	case "low", "normal", "high":
	default:
		errs = append(errs, fmt.Errorf("priority: 只能是 low/normal/high，收到 %q", a.Priority))
	}
	if len(a.Attendees) > 20 {
		errs = append(errs, errors.New("attendees: 最多 20 人"))
	}
	for _, email := range a.Attendees {
		if !strings.Contains(email, "@") {
			errs = append(errs, fmt.Errorf("attendees: 不是合法邮箱 %q", email))
		}
	}
	return errors.Join(errs...) // 没有错误时返回 nil（Go 1.20+）
}

func parseArgs(raw string) (*CreateEventArgs, error) {
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.DisallowUnknownFields() // 多余字段视为错误
	var a CreateEventArgs
	if err := dec.Decode(&a); err != nil {
		return nil, fmt.Errorf("JSON 解析失败: %w", err)
	}
	if err := a.Validate(); err != nil {
		return nil, err
	}
	return &a, nil
}

func main() {
	inputs := []string{
		`{"title": "周会", "day": "2025-03-10", "duration_minutes": 60, "attendees": ["li@example.com"]}`,
		`{"title": "", "day": "3月10日", "duration_minutes": 5, "priority": "urgent"}`,
	}
	for _, raw := range inputs {
		args, err := parseArgs(raw)
		if err != nil {
			fmt.Println("参数校验失败:", strings.ReplaceAll(err.Error(), "\n", "; "))
			continue
		}
		fmt.Printf("OK: %+v\n", *args)
	}
}
```
```java [Java]
// 依赖：com.fasterxml.jackson.core:jackson-databind（2.12+ 支持 record）
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.ValueInstantiationException;

import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

public class Main {
    static final Set<String> PRIORITIES = Set.of("low", "normal", "high");

    // record 的紧凑构造器：反序列化时自动执行，校验失败就无法创建对象
    record CreateEventArgs(
            String title,
            String day,
            @JsonProperty("duration_minutes") Integer durationMinutes,
            String priority,
            List<String> attendees) {

        CreateEventArgs {
            List<String> errs = new ArrayList<>();
            title = title == null ? "" : title.strip();
            if (title.isEmpty() || title.codePointCount(0, title.length()) > 100) {
                errs.add("title: 长度必须在 1~100 之间");
            }
            try {
                LocalDate.parse(day == null ? "" : day); // ISO 格式 YYYY-MM-DD
            } catch (DateTimeParseException e) {
                errs.add("day: 必须是 YYYY-MM-DD 格式");
            }
            if (durationMinutes == null || durationMinutes < 15 || durationMinutes > 480) {
                errs.add("duration_minutes: 必须在 15~480 之间");
            }
            if (priority == null) priority = "normal"; // 默认值
            if (!PRIORITIES.contains(priority)) {
                errs.add("priority: 只能是 low/normal/high，收到 \"" + priority + "\"");
            }
            if (attendees == null) attendees = List.of();
            if (attendees.size() > 20) errs.add("attendees: 最多 20 人");
            for (String email : attendees) {
                if (email == null || !email.contains("@")) {
                    errs.add("attendees: 不是合法邮箱 \"" + email + "\"");
                }
            }
            if (!errs.isEmpty()) throw new IllegalArgumentException(String.join("; ", errs));
            attendees = List.copyOf(attendees); // 不可变副本
        }
    }

    static final ObjectMapper MAPPER = new ObjectMapper()
            .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, true); // 拒绝多余字段

    /** 返回校验后的对象；失败时抛出带可读信息的异常。 */
    static CreateEventArgs parseArgs(String raw) {
        try {
            return MAPPER.readValue(raw, CreateEventArgs.class);
        } catch (ValueInstantiationException e) {
            // 构造器里抛出的校验异常会被 Jackson 包装一层
            Throwable cause = e.getCause() != null ? e.getCause() : e;
            throw new IllegalArgumentException("参数校验失败: " + cause.getMessage());
        } catch (JsonProcessingException e) {
            throw new IllegalArgumentException("JSON 解析失败: " + e.getOriginalMessage());
        }
    }

    public static void main(String[] args) {
        List<String> inputs = List.of(
                "{\"title\": \"周会\", \"day\": \"2025-03-10\", \"duration_minutes\": 60, \"attendees\": [\"li@example.com\"]}",
                "{\"title\": \"\", \"day\": \"3月10日\", \"duration_minutes\": 5, \"priority\": \"urgent\"}");
        for (String raw : inputs) {
            try {
                System.out.println("OK: " + parseArgs(raw));
            } catch (IllegalArgumentException e) {
                System.out.println(e.getMessage());
            }
        }
    }
}
```
:::

第二组输入会一次性报告所有问题，例如 Go 版输出：

```text
参数校验失败: title: 长度必须在 1~100 之间; day: 必须是 YYYY-MM-DD 格式; duration_minutes: 必须在 15~480 之间; priority: 只能是 low/normal/high，收到 "urgent"
```

pydantic 的错误信息默认是英文（如 `String should have at least 1 character`），模型完全能看懂，不必翻译。

三种实现在细节上有差异，值得留意：

- **类型宽松度**。输入 `"duration_minutes": "60"`：pydantic 默认宽松模式会转成 60；Go 会报类型错误；Jackson 默认也会把数字字符串转为整数。需要严格时，pydantic 可以用 `ConfigDict(strict=True)`，Jackson 可以关闭相关的类型强制转换（coercion）配置。
- **缺失字段**。Go 里缺失的 `int` 字段是 0，无法区分「没传」和「传了 0」，需要时改用指针 `*int`。Java 用包装类型 `Integer` 得到 `null`。pydantic 直接报 `Field required`。
- **错误汇总**。三个版本都一次性返回所有错误，而不是遇到第一个就停止。这让模型一次就能改对，减少来回次数。

## 把错误反馈给模型

校验失败时，不要抛异常终止 Agent，而是把错误作为工具结果返回，让模型修正：

```python
def run_create_event(raw_arguments: str) -> str:
    parsed = parse_args(raw_arguments)
    if isinstance(parsed, str):          # 校验失败，返回错误说明
        return parsed + "。请修正参数后重新调用。"
    # 校验通过才执行真实操作
    return create_event_in_calendar(parsed)
```

模型下一轮看到 `day: Input should be a valid date...`，通常会自己把「3月10日」改成 `2025-03-10` 再调用一次。同时要设置重试上限，避免反复失败陷入死循环。完整流程见 [工具错误处理与重试](/guide/05-tool-calling/error-handling)。

## 一份定义，两种用途

pydantic 的 `model_json_schema()` 能从同一个模型生成 JSON Schema，直接用作工具定义里的 `parameters`：

```python
tool_def = {
    "type": "function",
    "function": {
        "name": "create_event",
        "description": CreateEventArgs.__doc__,
        "parameters": CreateEventArgs.model_json_schema(),
    },
}
```

这样「告诉模型参数长什么样」和「校验模型给的参数」使用同一份定义，不会出现两边不一致的问题。很多 Agent 框架的 `@tool` 装饰器内部正是这么做的。Go 和 Java 也有从结构体或类生成 JSON Schema 的第三方库，用法以各自文档为准。

## 常见坑

- **只依赖提示词约束格式**。「请输出 JSON」不是保证。即使开启了结构化输出，业务规则仍需自己校验。
- **校验通过后又用原始 dict**。校验的意义在于后续只使用校验后的对象；继续用原始数据等于没校验。
- **允许多余字段**。模型编造的 `force_delete: true` 之类字段如果被透传到下游，可能触发意外行为。工具参数建议默认拒绝未知字段。
- **把校验错误吞掉**。返回笼统的「参数错误」，模型不知道错在哪里，只能盲猜。错误信息要具体到字段。
- **用 `dataclass` 代替 pydantic 处理外部输入**。`dataclass` 不做任何运行时类型检查。
- **Java 中把校验异常当成 JSON 格式错误**。Jackson 会把构造器里的异常包装成 `ValueInstantiationException`，要先单独捕获，才能把具体原因告诉模型。

## 小测

**1. 已经用 JSON Schema 约束了模型输出，为什么还需要在代码里校验？**

::: details 查看答案
一是并非所有厂商和模型都严格遵守 Schema，输出仍可能不合规；二是 Schema 难以表达所有业务规则（日期不能早于今天、参会人必须是公司员工等）；三是模型输入可能被注入攻击污染。校验是执行操作前的最后一道防线。
:::

**2. Go 中 `DurationMinutes int` 字段，模型没有传这个字段，`Validate()` 会报什么错？如果业务上允许不传并使用默认值 30，该怎么改？**

::: details 查看答案
没传时值为 0，会报「必须在 15~480 之间」。如果允许不传，可以把字段改为 `*int`：`nil` 表示没传，此时设为 30；非 `nil` 时再检查范围。这样能区分「没传」和「传了非法的 0」。
:::

**3. 模型连续三次传入的参数都校验失败，Agent 应该怎么办？**

::: details 查看答案
不应无限重试。达到上限后应停止调用该工具，向用户说明问题（例如「无法确定日期，请提供具体日期」），或者转为请求人工介入。同时记录这些失败案例，用于改进工具描述和参数设计。
:::

## 延伸阅读

- [Pydantic 官方文档](https://docs.pydantic.dev/latest/)
- [Go encoding/json 文档](https://pkg.go.dev/encoding/json)
- [go-playground/validator](https://github.com/go-playground/validator)
- [Jackson Databind](https://github.com/FasterXML/jackson-databind)
- 本站：[结构化输出与 JSON Schema](/guide/04-prompt/structured-output)、[工具设计原则](/guide/05-tool-calling/tool-design)

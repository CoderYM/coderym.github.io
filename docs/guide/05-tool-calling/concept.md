---
title: 工具调用原理
description: 模型并不会执行函数，它只会"说"自己想调用哪个函数。本文拆解 Tool Calling 的完整往返：tools 定义、tool_calls 响应、执行、回传结果。
---

# 工具调用原理

::: info 学习目标
- 理解 Tool Calling 的本质：模型只生成调用意图，真正执行的是你的代码
- 能完整画出一次工具调用的请求/响应往返，并说清每一步的消息结构
- 读懂 `tools`、`tool_calls`、`tool_call_id`、`finish_reason` 这些关键字段
- 了解 `tool_choice` 的几种取值，以及 OpenAI 与 Anthropic 格式的对应关系
:::

## 模型自己不会调用任何东西

大模型只能做一件事：根据输入生成文本。它不能联网，不能查数据库，也不知道现在几点。Tool Calling（也叫 Function Calling）解决的问题是：**让模型能"请求"外部能力**。

关键在于"请求"二字。整个过程中：

- **模型负责决策**：要不要调用工具、调用哪个、传什么参数。
- **你的代码负责执行**：解析模型的请求，真正去调用函数，再把结果告诉模型。

模型输出的工具调用，本质上就是一段符合你给定 Schema 的 JSON，和 [结构化输出](/guide/04-prompt/structured-output) 是同一类能力。区别在于模型可以自己决定是调用工具还是直接回答。

这个分工有一个重要的推论：**执行权永远在你手里**。模型说要调用 `delete_user`，你的代码完全可以拒绝。这也是所有 Agent 安全设计的基础。

## 一次完整的往返

以"北京今天天气怎么样"为例，一次工具调用需要**两次** API 请求：

```text
   你的程序                                              大模型
      │                                                    │
      │ ① 请求：messages + tools（函数清单与参数 Schema）     │
      │ ─────────────────────────────────────────────────▶ │
      │                                                    │ 判断：需要查天气
      │ ② 响应：assistant 消息，content 为空，               │
      │    tool_calls=[get_weather(city="北京")]            │
      │    finish_reason="tool_calls"                      │
      │ ◀───────────────────────────────────────────────── │
      │                                                    │
      │ ③ 本地执行 get_weather("北京") → {"temp": 26, ...}  │
      │                                                    │
      │ ④ 请求：原 messages                                 │
      │    + ② 中的 assistant 消息（原样追加）               │
      │    + role="tool" 消息（tool_call_id 对应 + 结果）     │
      │    + tools                                         │
      │ ─────────────────────────────────────────────────▶ │
      │                                                    │ 根据结果组织语言
      │ ⑤ 响应：assistant 消息，content="北京今天晴，26°C…"  │
      │    finish_reason="stop"                            │
      │ ◀───────────────────────────────────────────────── │
```

API 是无状态的，模型不记得第一次请求。所以第 ④ 步必须把**完整的对话历史**再发一遍，其中包括模型自己在第 ② 步发出的调用请求。

## 逐步拆解报文

下面的 JSON 中，`//` 注释只用于讲解，真实请求里不能有注释。

### 第 ① 步：请求中声明工具

```json
{
  "model": "gpt-4o-mini",
  "messages": [
    { "role": "user", "content": "北京今天天气怎么样？" }
  ],
  "tools": [
    {
      "type": "function",                 // 目前固定为 function
      "function": {
        "name": "get_weather",            // 函数名：模型会原样返回它
        "description": "查询指定城市当前的天气。用户问天气、温度、是否下雨时使用。",
        "parameters": {                   // 参数的 JSON Schema
          "type": "object",
          "properties": {
            "city": {
              "type": "string",
              "description": "城市中文名，如 北京、上海"
            },
            "unit": {
              "type": "string",
              "enum": ["celsius", "fahrenheit"],
              "description": "温度单位，默认 celsius"
            }
          },
          "required": ["city"]
        }
      }
    }
  ]
}
```

`tools` 里的内容最终会被转换成提示词的一部分送进模型，所以它们**会占用 Token**，`name` 和 `description` 写得好不好直接决定模型能不能用对工具，详见 [工具设计原则](/guide/05-tool-calling/tool-design)。

### 第 ② 步：模型返回调用请求

```json
{
  "choices": [
    {
      "index": 0,
      "finish_reason": "tool_calls",      // 停下来是因为要调用工具，而不是回答完了
      "message": {
        "role": "assistant",
        "content": null,                  // 通常为空，也可能带一句说明文字
        "tool_calls": [
          {
            "id": "call_8f2a1c",          // 本次调用的唯一 ID，回传结果时要用
            "type": "function",
            "function": {
              "name": "get_weather",
              "arguments": "{\"city\": \"北京\"}"   // 注意：是 JSON 字符串，不是对象
            }
          }
        ]
      }
    }
  ]
}
```

三个最容易踩坑的点：

1. `arguments` 是一个**字符串**，需要你自己 `json.loads`。它是模型生成的，可能不合法，也可能缺字段，必须校验（见 [工具错误处理与重试](/guide/05-tool-calling/error-handling)）。
2. `tool_calls` 是一个**数组**，模型可以一次请求多个调用（见 [并行工具调用](/guide/05-tool-calling/parallel-tools)）。
3. 判断"是否需要执行工具"，要看 `message.tool_calls` 是否非空，`finish_reason == "tool_calls"` 可以作为辅助判断。

### 第 ④ 步：回传工具结果

```json
{
  "model": "gpt-4o-mini",
  "messages": [
    { "role": "user", "content": "北京今天天气怎么样？" },
    {                                     // 第 ② 步模型返回的 assistant 消息，原样追加
      "role": "assistant",
      "content": null,
      "tool_calls": [
        {
          "id": "call_8f2a1c",
          "type": "function",
          "function": { "name": "get_weather", "arguments": "{\"city\": \"北京\"}" }
        }
      ]
    },
    {
      "role": "tool",                     // 工具结果专用的角色
      "tool_call_id": "call_8f2a1c",      // 必须与上面的 id 一致
      "content": "{\"city\": \"北京\", \"condition\": \"晴\", \"temp_c\": 26}"
    }
  ],
  "tools": [ ... ]                        // 通常继续带上，模型可能还要再调用
}
```

- `role: "tool"` 消息必须紧跟在包含 `tool_calls` 的 assistant 消息之后。
- 每一个 `tool_call` 都必须有一条对应的 `tool` 消息，靠 `tool_call_id` 配对。漏掉任何一条，API 会直接返回 400 错误。
- `content` 是字符串。结构化结果一般序列化成 JSON 字符串；出错时也要返回一条消息，告诉模型出了什么错。

第 ⑤ 步的响应就是普通的文本回答，`finish_reason` 为 `stop`。

## 从一次往返到循环

上面的例子只调用了一次工具。真实场景里，模型拿到第一个工具结果后，可能发现还需要再查一次。比如"北京和上海哪个更热？适合穿什么？"，模型可能先查两个城市的天气，再调用穿衣建议工具。所以通用的处理逻辑是一个循环：

```text
messages = [system, user]
loop:
    response = call_llm(messages, tools)
    messages.append(response.message)          # assistant 消息必须追加
    if response.message.tool_calls 为空:
        return response.message.content        # 模型给出了最终回答
    for call in response.message.tool_calls:
        result = execute(call.name, call.arguments)   # 校验参数，执行，捕获异常
        messages.append({role: "tool", tool_call_id: call.id, content: result})
    # 回到 loop 开头，把结果交给模型继续推理（要设置最大轮数）
```

这个循环就是 Agent 的雏形。模块 06 会在此基础上加入推理、终止条件和预算控制，见 [ReAct：推理与行动](/guide/06-agent-loop/react) 和 [不用框架手写 Agent](/guide/06-agent-loop/handwritten-agent)。下一篇 [实现第一个工具](/guide/05-tool-calling/first-tool) 会用三种语言把它写成可运行的代码。

## tool_choice：控制模型要不要调用

请求中可以通过 `tool_choice` 参数控制模型的行为：

| 取值 | 含义 | 典型用途 |
|------|------|---------|
| `"auto"`（默认） | 模型自己决定调用工具还是直接回答 | 绝大多数场景 |
| `"none"` | 禁止调用工具，只能回答文本 | 让模型基于已有结果做总结 |
| `"required"` | 必须调用至少一个工具 | 你确定这一步一定要用工具 |
| `{"type": "function", "function": {"name": "get_weather"} }` | 必须调用指定的工具 | 把工具当成结构化输出使用 |

`required` 和指定工具在部分兼容厂商上可能不支持，使用前查阅对应厂商文档。另外，在循环中一直用 `required` 会导致模型永远无法给出最终回答，需要在拿到结果后切回 `auto`。

## 与 Anthropic 原生格式的对照

Claude 的原生 Messages API 概念完全一致，只是字段名不同。如果你直接使用 `anthropic` SDK，可以按下表对照：

| 概念 | OpenAI Chat Completions | Anthropic Messages API |
|------|------------------------|------------------------|
| 声明工具 | `tools[].function.{name, description, parameters}` | `tools[].{name, description, input_schema}` |
| 模型请求调用 | `message.tool_calls[]` | `content[]` 中 `type: "tool_use"` 的块 |
| 调用 ID | `tool_calls[].id` | `tool_use` 块的 `id` |
| 参数 | `function.arguments`（JSON 字符串） | `input`（已解析的对象） |
| 停止原因 | `finish_reason: "tool_calls"` | `stop_reason: "tool_use"` |
| 回传结果 | `role: "tool"` 消息 + `tool_call_id` | `role: "user"` 消息中 `type: "tool_result"` 的块 + `tool_use_id` |

本站代码统一使用 OpenAI 兼容格式。许多厂商（包括 Anthropic）也提供了 OpenAI 兼容的接口，细节以各家文档为准。

## 模型是怎么"学会"调用工具的

模型并没有一个专门的"函数调用模块"。厂商在训练时用大量"看到工具清单 → 输出特定格式的调用"的数据微调了模型。推理时，API 服务把你的 `tools` 渲染成模型能理解的提示词格式，再把模型输出的特殊格式解析回 `tool_calls` 结构。

理解这一点有两个实际意义：

1. **工具定义就是提示词**。描述写得模糊，模型就会用错，这和提示词写得模糊是一回事。
2. **工具太多会降低准确率**。几十个工具的定义会占用大量上下文，模型在相似的工具之间更容易选错。

## 常见坑

- **忘了把 assistant 的 tool_calls 消息加入历史。** 直接追加 tool 消息会得到 400 错误，因为 tool 消息找不到它对应的调用请求。
- **把 arguments 当对象用。** 它是 JSON 字符串，需要先解析，而且解析可能失败。
- **tool_call_id 对不上或漏回。** 模型发起了 3 个调用，你只回传了 2 个结果，请求会失败。即使某个工具执行出错，也要回传一条错误信息。
- **以为模型"调用"了函数就等于执行了。** 模型只是提出请求，没有你的代码去执行，什么都不会发生。反过来，执行前做权限检查是你的责任。
- **工具结果太长。** 把一个 2 MB 的 API 响应原样塞进 tool 消息，很快就会撑爆上下文。只返回模型需要的字段。

## 小测

1. 一次带工具调用的问答，至少需要几次 API 请求？为什么？

::: details 查看答案
至少两次。第一次模型返回 `tool_calls`（调用请求），你执行工具后，第二次请求把调用请求和工具结果一起发回去，模型才能基于结果生成最终回答。API 是无状态的，所以第二次请求必须包含完整历史。
:::

2. 模型在一次响应中返回了 2 个 `tool_calls`，回传时应该如何组织消息？

::: details 查看答案
先原样追加包含 2 个 `tool_calls` 的 assistant 消息，再追加 2 条 `role: "tool"` 消息，每条的 `tool_call_id` 分别对应一个调用的 `id`。缺少任何一条都会导致请求报错。
:::

3. 用户说"删除我的账号"，模型返回了 `delete_account` 的调用请求。你的代码应该直接执行吗？

::: details 查看答案
不应该无条件执行。模型的调用请求只是"意图"，执行权在你的代码。对于删除这类不可逆操作，应该校验用户身份和权限，并要求用户二次确认（人在环路），见 [权限控制与人在环路](/guide/15-production/permissions-hitl)。
:::

## 延伸阅读

- [OpenAI Function calling 指南](https://platform.openai.com/docs/guides/function-calling)
- [Anthropic Tool use 文档](https://docs.anthropic.com/en/docs/build-with-claude/tool-use/overview)
- [Toolformer: Language Models Can Teach Themselves to Use Tools](https://arxiv.org/abs/2302.04761)
- 下一篇：[实现第一个工具](/guide/05-tool-calling/first-tool)

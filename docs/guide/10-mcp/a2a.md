---
title: A2A：Agent 之间的协议
description: 理解 Agent2Agent 协议的 Agent Card、Task、Message 与 Artifact，弄清它与 MCP 的分工，以及何时值得引入。
---

# A2A：Agent 之间的协议

::: info 学习目标
- 理解 A2A 要解决的问题，以及它和 MCP 的分工
- 掌握 Agent Card、Task、Message、Part、Artifact 等核心概念
- 能读懂一次 A2A 交互的 JSON-RPC 消息，包括任务状态流转
- 判断自己的项目什么时候需要 A2A，什么时候不需要
:::

::: warning 规范仍在演进
A2A 由 Google 于 2025 年 4 月发起，之后捐赠给 Linux 基金会，规范仍在快速迭代，字段名和方法名在不同版本之间有过调整（例如 Agent Card 的路径、方法命名）。本文以 0.3 版前后的规范为参考讲概念，JSON 示例做了简化，动手实现前请以 [官方仓库](https://github.com/a2aproject/A2A) 的最新规范为准。
:::

## 为什么需要 Agent 之间的协议

MCP 解决的是"Agent 怎么用工具"。但越来越多的场景是**Agent 调用另一个 Agent**：

- 公司的差旅助手需要请财务部门的报销 Agent 审核单据；
- 你的研究 Agent 想把"查专利"这件事委托给供应商提供的专利检索 Agent；
- 两个 Agent 由不同团队、不同框架（LangGraph、CrewAI、自研）实现，部署在不同的服务上。

把对方 Agent 包装成一个 MCP 工具当然可行，但会碰到一些不匹配的地方：对方 Agent 的任务可能要跑几分钟甚至几小时，中途可能需要追问"预算上限是多少"，产出可能是多个文件。工具调用的"一问一答、立即返回"模型不太适合这类协作。

A2A（Agent2Agent）协议就是为这种场景设计的：它把对方当作一个**不透明的自治 Agent**，你不需要知道它内部用什么模型、什么工具、什么记忆，只通过标准化的"任务"与它协作。

## A2A 与 MCP 的分工

```text
                  ┌──────────── A2A ────────────┐
                  │   Agent 与 Agent 之间协作     │
                  ▼                              ▼
          ┌───────────────┐              ┌───────────────┐
          │   差旅 Agent    │ ── 任务 ──▶  │  报销 Agent    │
          │ (Client Agent) │ ◀─ 结果 ───  │ (Remote Agent) │
          └───────┬───────┘              └───────┬───────┘
                  │ MCP                          │ MCP
          ┌───────▼───────┐              ┌───────▼───────┐
          │ 日历 / 机票工具 │              │ 财务系统 / OCR │
          └───────────────┘              └───────────────┘
```

| 维度 | MCP | A2A |
|------|-----|-----|
| 连接的对象 | Agent ↔ 工具、数据源 | Agent ↔ Agent |
| 对方是什么 | 能力明确、无自主性的函数/资源 | 自治、内部不透明的 Agent |
| 交互单位 | 一次工具调用 | 一个可能长时间运行、多轮交互的 Task |
| 典型时长 | 毫秒到秒 | 秒到小时，支持异步与推送通知 |
| 发现机制 | 连接后 `tools/list` | 事先读取公开的 Agent Card |
| 底层 | JSON-RPC 2.0（stdio / Streamable HTTP） | JSON-RPC 2.0 over HTTP(S)，支持 SSE 流式；新版本还支持 gRPC 等 |

两者是互补而不是竞争关系：一个 Agent 对内用 MCP 接工具，对外用 A2A 和其他 Agent 协作。

## 核心概念

### Agent Card：Agent 的名片

每个 A2A Agent 在一个约定的地址公开一份 JSON 描述，叫 Agent Card。较新版本约定的路径是 `/.well-known/agent-card.json`（早期版本是 `/.well-known/agent.json`）。客户端先读名片，再决定要不要、怎么调用它。

```json
{
  "name": "报销审核 Agent",
  "description": "审核差旅报销单据，检查发票真伪与报销政策合规性",
  "url": "https://agents.example.com/expense/a2a",
  "version": "1.2.0",
  "protocolVersion": "0.3.0",
  "capabilities": {
    "streaming": true,
    "pushNotifications": true
  },
  "defaultInputModes": ["text/plain", "application/pdf"],
  "defaultOutputModes": ["text/plain", "application/json"],
  "securitySchemes": {
    "oauth": {
      "type": "oauth2",
      "flows": {
        "clientCredentials": {
          "tokenUrl": "https://auth.example.com/token",
          "scopes": { "expense:review": "提交报销审核" }
        }
      }
    }
  },
  "security": [{ "oauth": ["expense:review"] }],
  "skills": [
    {
      "id": "review-expense",
      "name": "报销单审核",
      "description": "根据公司差旅政策审核报销单，返回通过、驳回或需补充材料",
      "tags": ["finance", "expense"],
      "examples": ["帮我审核这张上海出差的报销单"]
    }
  ]
}
```

重点字段：

- `url`：真正接收 A2A 请求的端点。
- `capabilities`：是否支持流式（SSE）、推送通知等。
- `securitySchemes` / `security`：如何鉴权，沿用 OpenAPI 的安全方案描述方式。A2A 本身不发明新的认证机制。
- `skills`：这个 Agent 能做什么，相当于"能力目录"。注意它是给调用方（人或 Agent）看的说明，**不是**像 MCP 工具那样带参数 Schema 的函数签名。

### Task、Message、Part、Artifact

| 概念 | 含义 |
|------|------|
| Message | 一轮通信，`role` 为 `user`（客户端）或 `agent`（远程 Agent），内容由多个 Part 组成 |
| Part | 内容片段：`text` 文本、`file` 文件（内联 base64 或 URI）、`data` 结构化 JSON |
| Task | 一个有状态的工作单元，有唯一 `id` 和生命周期状态，可以跨多轮 Message |
| Artifact | 任务产出的成果物（报告、文件、结构化结果），同样由 Part 组成 |
| contextId | 把多个相关 Task 归入同一个会话上下文 |

Task 的状态流转是 A2A 最核心的部分：

```text
               ┌──────────────┐
  message ───▶ │  submitted   │
               └──────┬───────┘
                      ▼
               ┌──────────────┐  需要更多信息   ┌────────────────┐
               │   working    │ ─────────────▶ │ input-required │
               └──┬───┬───┬───┘ ◀───────────── └────────────────┘
                  │   │   │       客户端补充 message
        ┌─────────┘   │   └──────────┐
        ▼             ▼              ▼
  ┌───────────┐ ┌──────────┐  ┌────────────┐
  │ completed │ │  failed  │  │  canceled  │      （另有 rejected、auth-required 等）
  └───────────┘ └──────────┘  └────────────┘
```

`input-required` 这个状态体现了 A2A 和工具调用最大的不同：远程 Agent 可以"反问"，任务暂停等待客户端补充信息后继续。

## 一次完整的交互

下面用"差旅 Agent 请报销 Agent 审核单据"走一遍流程（JSON 已简化）。

**第 1 步：发现。** 客户端 GET 远程 Agent 的 Agent Card，确认它有 `review-expense` 技能、支持哪些输入格式、需要什么鉴权，然后按 `securitySchemes` 获取访问令牌。

**第 2 步：发送消息。** 调用 `message/send` 方法：

```json
{
  "jsonrpc": "2.0",
  "id": "req-1",
  "method": "message/send",
  "params": {
    "message": {
      "role": "user",
      "messageId": "msg-001",
      "parts": [
        { "kind": "text", "text": "请审核这张上海出差的报销单" },
        {
          "kind": "file",
          "file": { "name": "invoice.pdf", "mimeType": "application/pdf", "uri": "https://files.example.com/invoice.pdf" }
        }
      ]
    }
  }
}
```

**第 3 步：远程 Agent 需要补充信息。** 它返回一个 Task，状态为 `input-required`：

```json
{
  "jsonrpc": "2.0",
  "id": "req-1",
  "result": {
    "kind": "task",
    "id": "task-42",
    "contextId": "ctx-7",
    "status": {
      "state": "input-required",
      "message": {
        "role": "agent",
        "messageId": "msg-002",
        "parts": [{ "kind": "text", "text": "发票抬头与出差人不一致，请说明是否为代同事报销。" }]
      }
    }
  }
}
```

**第 4 步：客户端补充回答**，带上同一个 `taskId`，任务继续：

```json
{
  "jsonrpc": "2.0",
  "id": "req-2",
  "method": "message/send",
  "params": {
    "message": {
      "role": "user",
      "messageId": "msg-003",
      "taskId": "task-42",
      "contextId": "ctx-7",
      "parts": [{ "kind": "text", "text": "是的，代同事张三报销，已获部门经理批准。" }]
    }
  }
}
```

**第 5 步：任务完成**，结果放在 `artifacts` 中：

```json
{
  "jsonrpc": "2.0",
  "id": "req-2",
  "result": {
    "kind": "task",
    "id": "task-42",
    "contextId": "ctx-7",
    "status": { "state": "completed" },
    "artifacts": [
      {
        "artifactId": "art-1",
        "name": "审核结论",
        "parts": [
          { "kind": "data", "data": { "decision": "approved", "amount": 1280.5, "notes": "代报销需附审批截图" } }
        ]
      }
    ]
  }
}
```

除了 `message/send`，常用方法还有：

| 方法 | 作用 |
|------|------|
| `message/stream` | 与 send 相同，但通过 SSE 流式返回状态更新和产出片段，适合需要展示进度的任务 |
| `tasks/get` | 按 Task ID 查询状态与结果，用于轮询 |
| `tasks/cancel` | 取消正在进行的任务 |
| `tasks/pushNotificationConfig/set` | 注册一个 Webhook，任务状态变化时由远程 Agent 主动回调，适合耗时很长的任务 |

三种拿结果的方式（同步等待、SSE 流式、Webhook 推送）可以按任务时长选择：几秒钟的任务直接同步，几十秒到几分钟用流式，更长的任务用推送通知。

## 实现与 SDK

官方在 [a2aproject](https://github.com/a2aproject) 组织下提供了多语言 SDK（Python、JavaScript、Java、Go、.NET 等）和示例。以 Python 为例，SDK 帮你处理 Agent Card 发布、JSON-RPC 路由、任务存储和 SSE，你只需要实现一个"收到消息后怎么干活"的执行器，内部可以用任何框架或手写的 Agent 循环。由于 SDK 还在快速变化，本文不贴具体代码，请直接参考官方仓库中的示例。

如果你自己实现，最少需要：

1. 一个返回 Agent Card 的 GET 端点；
2. 一个处理 JSON-RPC 的 POST 端点，实现 `message/send` 和 `tasks/get`；
3. 一个任务存储（内存、Redis 或数据库），记录任务状态、历史消息和产出；
4. 鉴权中间件，按 Agent Card 中声明的方式校验调用方。

## 什么时候该用 A2A

| 场景 | 建议 |
|------|------|
| 一个应用内的多个 Agent，同一团队维护 | 不需要 A2A，用框架内的编排即可，见 [编排模式](/guide/12-multi-agent/patterns) |
| 对方能力明确、调用快速、无需追问 | 包装成 MCP 工具或普通 API 更简单 |
| 跨团队、跨公司、跨框架的 Agent 协作 | 适合 A2A，标准化的发现、鉴权和任务模型能减少对接成本 |
| 长时间运行、需要中途交互或推送结果 | 适合 A2A，Task 生命周期正好覆盖这些需求 |

一句话：**A2A 是跨组织边界的协议**。在一个进程或一个团队内部，引入它带来的复杂度往往超过收益。

## 常见坑

- **把 A2A 当成 MCP 的替代品**：两者层次不同。Agent 内部访问工具仍然用 MCP 或直接 Tool Calling。
- **过早引入**：单体应用里的几个子 Agent 也用 A2A 通信，徒增序列化、网络和运维开销。
- **信任远程 Agent 的输出**：远程 Agent 返回的文本同样可能包含注入指令，应当作不可信数据处理，敏感动作仍需本方校验和确认。
- **忽略任务的持久化**：任务可能持续很久，服务重启后丢失状态会导致客户端永远等不到结果。
- **照抄旧教程的字段名**：规范在 0.2 到 0.3 等版本间调整过 Agent Card 路径、方法名和部分字段，务必对照当前规范和 SDK 版本。

## 小测

1. Agent Card 中的 `skills` 和 MCP 的 `tools` 有什么本质区别？

::: details 查看答案
MCP 的 tool 是带 JSON Schema 参数定义的函数签名，由模型直接构造参数调用。A2A 的 skill 是对 Agent 能力的自然语言描述（名称、说明、示例），调用方通过发送 Message 来委托任务，远程 Agent 自主决定如何完成，内部实现对调用方不透明。
:::

2. 远程 Agent 返回状态 `input-required` 后，客户端应该怎么做？

::: details 查看答案
读取 `status.message` 中远程 Agent 提出的问题，获取答案（可能需要询问用户），然后发送一条新 Message，并带上相同的 `taskId`（和 `contextId`），任务会从暂停处继续。
:::

3. 公司内部一个 FastAPI 服务里有"检索 Agent"和"写作 Agent"两个子 Agent，需要用 A2A 让它们通信吗？

::: details 查看答案
通常不需要。两者在同一进程、同一团队维护，直接函数调用或用框架的多 Agent 编排即可。A2A 的价值在于跨团队、跨框架、跨网络边界的标准化协作，在这里只会增加复杂度。
:::

## 延伸阅读

- [A2A 协议官方仓库（规范与文档）](https://github.com/a2aproject/A2A)
- [A2A 官方 SDK 与示例](https://github.com/a2aproject)
- 相关：[MCP 架构与核心概念](/guide/10-mcp/mcp-overview)、[为什么需要多 Agent](/guide/12-multi-agent/why-multi-agent)、[状态共享与通信](/guide/12-multi-agent/state-sharing)

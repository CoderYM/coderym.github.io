---
title: MCP 架构与核心概念
description: 理解 Model Context Protocol 的 Host / Client / Server 三角色、三类能力原语、两种传输方式和底层的 JSON-RPC 消息。
---

# MCP 架构与核心概念

::: info 学习目标
- 说清楚 MCP 要解决的问题：为什么"每个应用 × 每个工具"各写一遍集成不可持续
- 区分 Host、Client、Server 三个角色，以及 Tools、Resources、Prompts 三类能力
- 理解 stdio 与 Streamable HTTP 两种传输方式的适用场景
- 能读懂一次完整的 MCP 会话：初始化、发现能力、调用工具
:::

## MCP 解决什么问题

在 [工具调用原理](/guide/05-tool-calling/concept) 里我们学过：模型本身只会"说"要调用哪个函数，真正执行的是你的应用代码。问题在于，每个应用都要自己写一遍"查 GitHub""读数据库""搜文档"的工具实现和 Schema。假设有 M 个 AI 应用（IDE 插件、桌面助手、自研 Agent）和 N 个外部系统，就要写 M × N 份集成代码。

MCP（Model Context Protocol）是 Anthropic 在 2024 年底开源的一个开放协议，目标就是把 M × N 变成 M + N：

```text
没有 MCP：每个应用自己对接每个系统           有了 MCP：大家都讲同一种协议

 应用A ──┬── GitHub                       应用A ─┐               ┌─ GitHub Server
         ├── 数据库                       应用B ─┼── MCP 协议 ──┼─ 数据库 Server
         └── 文件系统                     应用C ─┘               └─ 文件系统 Server
 应用B ──┬── GitHub
         ├── 数据库        （M × N）                    （M + N）
         └── ...
```

一个常见的类比是"AI 应用的 USB-C 接口"：工具提供方写一次 MCP Server，任何支持 MCP 的应用（Claude Desktop、Claude Code、Cursor、VS Code、你自己写的 Agent）都能直接用。

需要强调的是：**MCP 并没有改变 Tool Calling 的本质**。模型依然是通过 function calling 决定调用什么，MCP 只是标准化了"工具从哪来、怎么描述、怎么调用"这一层。

## 三个角色：Host、Client、Server

```text
┌───────────────────────────── Host（如 Claude Desktop / 你的 Agent 应用）─────┐
│                                                                              │
│   ┌──────────┐      ┌──────────────┐                ┌───────────────────┐    │
│   │   LLM    │◀────▶│  Host 逻辑    │──▶ Client 1 ──▶│ Server: 文件系统  │    │
│   └──────────┘      │ (对话、权限、  │                └───────────────────┘    │
│                     │  工具路由)    │──▶ Client 2 ──▶┌───────────────────┐    │
│                     └──────────────┘                │ Server: GitHub     │    │
│                                                     └───────────────────┘    │
└──────────────────────────────────────────────────────────────────────────────┘
```

| 角色 | 是什么 | 职责 |
|------|--------|------|
| Host | 用户直接使用的 AI 应用 | 管理对话与模型调用；决定连接哪些 Server；负责授权和用户确认 |
| Client | Host 内部的协议客户端 | 与**一个** Server 保持一对一连接，收发协议消息 |
| Server | 暴露能力的独立程序 | 提供工具、资源、提示词模板；可以是本地进程也可以是远程服务 |

注意 Client 和 Server 是**一对一**的：Host 连了 3 个 Server，内部就有 3 个 Client 实例。这样每个 Server 的连接、权限、故障都彼此隔离。

## 三类核心能力：Tools、Resources、Prompts

Server 可以向 Client 暴露三类原语（primitive），区别在于"谁来决定使用它"：

| 原语 | 控制方 | 类比 | 例子 |
|------|--------|------|------|
| Tools | 模型决定调用 | POST 接口，可以有副作用 | `create_issue`、`run_sql`、`send_email` |
| Resources | 应用决定读取 | GET 接口，只读数据 | `file:///logs/app.log`、`db://schema/users` |
| Prompts | 用户主动选择 | 可复用的提示词模板 | "代码审查"、"生成周报" 模板 |

- **Tools** 是最常用的，几乎所有 MCP Server 都以工具为主。每个工具有 `name`、`description` 和 `inputSchema`（JSON Schema），和 OpenAI 的 function 定义几乎一一对应。
- **Resources** 用 URI 标识，由 Host 决定什么时候把内容放进上下文（比如用户在界面里 @ 了某个文件）。它和工具的区别是：资源是被动的数据，不由模型自主触发。
- **Prompts** 是 Server 提供的模板，通常在 Host 的界面里以斜杠命令等形式出现，由用户手动选用。

除此之外，协议还定义了一些反向能力，即 Server 请求 Client：例如 **Sampling**（Server 请 Host 代为调用一次大模型）和 **Elicitation**（Server 请 Host 向用户追问信息）。这些属于进阶内容，不是每个 Host 都支持。

## 底层协议：JSON-RPC 2.0

MCP 的所有消息都是 JSON-RPC 2.0 格式，分三种：请求（有 `id`，需要响应）、响应（带同样的 `id`）、通知（没有 `id`，不需要响应）。

一次典型会话的消息流如下：

```text
Client                                         Server
  │── initialize (协议版本、客户端能力) ─────────▶│
  │◀──────────────── 结果 (服务端能力、名称版本) ──│
  │── notifications/initialized ────────────────▶│   握手完成
  │                                              │
  │── tools/list ───────────────────────────────▶│
  │◀──────────────────────────── 工具列表+Schema ──│   能力发现
  │                                              │
  │── tools/call {name, arguments} ─────────────▶│
  │◀──────────────────────────── 结果 content[] ──│   执行工具
```

以工具调用为例，请求长这样：

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "get_weather",
    "arguments": { "city": "杭州" }
  }
}
```

响应：

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [
      { "type": "text", "text": "杭州：小雨，18°C" }
    ],
    "isError": false
  }
}
```

两个细节值得记住：

1. 工具**业务层面**的失败（比如城市不存在）应返回 `isError: true` 的结果，让模型看到错误信息并自行调整；而**协议层面**的错误（方法不存在、参数格式错误）才用 JSON-RPC 的 `error` 字段。这和 [工具错误处理与重试](/guide/05-tool-calling/error-handling) 中"把错误当作观察结果返回给模型"的思路一致。
2. `content` 是数组，可以包含 `text`、`image` 等多种类型。较新的规范版本还支持 `structuredContent` 返回结构化数据。

## 两种传输方式：stdio 与 Streamable HTTP

JSON-RPC 消息需要一个"管道"来传输，MCP 规范定义了两种标准传输：

| 维度 | stdio | Streamable HTTP |
|------|-------|-----------------|
| 运行方式 | Host 把 Server 作为子进程启动 | Server 是独立的 HTTP 服务 |
| 通信 | 通过子进程的 stdin / stdout 收发，每行一条 JSON | 客户端 POST 到单一端点（如 `/mcp`），服务端可返回普通 JSON 或 SSE 流 |
| 部署 | 本地，跟随 Host 启停 | 本地或远程，可多用户共享 |
| 鉴权 | 继承本机用户权限，通常靠环境变量传密钥 | 需要自己做鉴权，规范推荐基于 OAuth 2.1 |
| 典型场景 | 文件系统、本地 Git、本地数据库 | SaaS 服务、团队共享的内部工具 |

stdio 有一个新手常踩的坑：**stdout 是协议通道**，Server 代码里任何 `print` 到 stdout 的调试信息都会破坏 JSON-RPC 消息流，日志必须写到 stderr。

早期规范还有一种"HTTP + SSE"双端点传输，已在 2025 年的规范修订中被 Streamable HTTP 取代。你在旧教程里看到 `/sse` 端点，就是这种旧方式；新项目建议直接用 Streamable HTTP。

## 版本与生态

MCP 规范以日期作为版本号（例如 `2025-06-18`），在 `initialize` 握手时双方协商使用哪个版本。官方维护了多种语言的 SDK，包括 Python、TypeScript、Go、Java、Kotlin、C# 等。规范还在快速演进，本站内容以写作时的规范为准，细节请对照 [官方规范](https://modelcontextprotocol.io/specification)。

## MCP 与普通 Tool Calling 的关系

```text
            ┌──────────── Host 应用 ────────────┐
 用户问题 ─▶ │ 1. tools/list 拿到 MCP 工具        │
            │ 2. 转成模型的 tools 参数 ──────────┼──▶ LLM（function calling）
            │ 3. 模型返回 tool_calls ◀───────────┼───
            │ 4. tools/call 转发给对应 Server    │──▶ MCP Server
            │ 5. 结果作为 tool 消息回传模型        │
            └───────────────────────────────────┘
```

也就是说，模型完全不知道 MCP 的存在，它看到的只是普通的工具列表。把 MCP 工具"翻译"成模型 API 能理解的格式，是 Host 的工作，我们会在 [在应用中接入 MCP](/guide/10-mcp/mcp-client) 里亲手实现。

## 常见坑

- **以为 MCP 能让模型更聪明**：MCP 只解决集成的标准化。工具描述写得差、工具太多导致模型选错，这些问题依旧存在，参考 [工具设计原则](/guide/05-tool-calling/tool-design)。
- **一次接入太多 Server**：每个工具的 Schema 都会占用上下文 Token。接了 10 个 Server、上百个工具，模型的选择准确率和成本都会变差。按任务按需启用。
- **stdio Server 往 stdout 打日志**：直接导致连接失败或解析错误，日志一律写 stderr。
- **盲目信任第三方 Server**：MCP Server 是能在你机器上执行代码的程序，工具描述本身也可能藏有恶意指令。安装前要像审查依赖包一样审查它，详见 [在应用中接入 MCP](/guide/10-mcp/mcp-client) 的安全部分。
- **混淆 Resources 和 Tools**：想让模型自主去查的数据，应该做成 Tool；Resource 需要 Host 主动支持，很多 Host 对它的支持并不完善。

## 小测

1. Host 同时连接了 GitHub、Postgres、文件系统三个 MCP Server，Host 内部有几个 Client？为什么这样设计？

::: details 查看答案
3 个。Client 与 Server 是一对一关系，每个连接独立维护协议状态、能力协商结果和生命周期，一个 Server 崩溃或权限受限不会影响其他 Server。
:::

2. 一个工具执行时发现"用户 ID 不存在"，应该返回 JSON-RPC `error` 还是 `isError: true` 的结果？

::: details 查看答案
返回 `isError: true` 的工具结果，并在 content 中写清错误原因。这是业务错误，模型需要看到它才能调整参数或告知用户。JSON-RPC `error` 留给协议层错误，比如调用了不存在的方法。
:::

3. 你要把公司内部的工单系统做成 MCP Server 给全组几十人使用，选 stdio 还是 Streamable HTTP？

::: details 查看答案
Streamable HTTP 更合适：集中部署一份，便于统一鉴权（如接入公司 SSO / OAuth）、审计和升级。stdio 需要每个人在本地运行一份并各自配置凭证，难以管理。
:::

## 延伸阅读

- [MCP 官方网站与文档](https://modelcontextprotocol.io)
- [MCP 规范](https://modelcontextprotocol.io/specification)
- [MCP GitHub 组织（各语言 SDK 与官方 Server 示例）](https://github.com/modelcontextprotocol)
- 下一篇：[开发一个 MCP Server](/guide/10-mcp/mcp-server)
- 实战项目：[05 开发自己的 MCP Server](/projects/05-mcp-server)

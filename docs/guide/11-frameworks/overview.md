---
title: 框架全景与选型
description: 先回答"要不要用框架"，再按语言、场景和团队情况在 LangGraph、Agents SDK、LlamaIndex、CrewAI、Eino、Spring AI 等之间做选择。
---

# 框架全景与选型

::: info 学习目标
- 理解 Agent 框架到底帮你做了什么，以及什么时候不需要框架
- 认识 Python、Go、Java 三个生态中主流框架的定位
- 掌握一套可落地的选型方法，而不是跟风选"最火"的那个
- 了解使用框架时如何控制锁定风险
:::

## 先问：需要框架吗

如果你跟着本站做过 [不用框架手写 Agent](/guide/06-agent-loop/handwritten-agent)，会发现一个能用的 Agent 核心只有几十行：调模型、解析工具调用、执行工具、追加消息、循环。那框架的价值在哪？

框架真正帮你省事的，是这些"手写也能做，但做好很费劲"的部分：

| 能力 | 手写难度 | 框架通常提供 |
|------|---------|-------------|
| 多模型适配 | 低（OpenAI 兼容接口已覆盖大部分） | 统一的模型抽象，切换厂商改一行 |
| 工具定义 | 中（手写 JSON Schema 容易出错） | 从函数签名、注解自动生成 Schema |
| 状态持久化与恢复 | 高 | Checkpoint，任务中断后从断点继续 |
| 人在环路 | 高 | 在指定步骤暂停，等待人工审批后恢复 |
| 复杂流程编排 | 高 | 图、分支、并行、子流程 |
| 可观测性 | 中 | 内置 Trace，对接 LangSmith、Langfuse 等 |
| RAG 管道 | 中 | 文档加载、切分、索引、检索的现成组件 |

所以判断标准很简单：

```text
你的需求只是"模型 + 几个工具 + 循环"？
   ├─ 是 ──▶ 手写或用轻量 SDK（OpenAI Agents SDK 等）就够了
   └─ 否，需要以下任一项：
        · 长流程且要能中断恢复
        · 人工审批节点
        · 多 Agent 协作、复杂分支
        · 大量文档的 RAG
      ──▶ 选一个擅长该领域的框架
```

一个务实的建议：**先手写一遍，理解原理后再上框架**。这样框架出问题时，你知道它底层在干什么，也能判断某个抽象是在帮你还是在碍事。

## 三个生态的主流框架

### Python：选择最多

Python 是 Agent 生态的主战场，几乎所有新框架都先出 Python 版。

| 框架 | 定位 | 适合 |
|------|------|------|
| [LangGraph](/guide/11-frameworks/langgraph) | 以"状态图"建模 Agent，强调可控性、持久化、人在环路 | 复杂、长流程、需要精确控制的生产级 Agent |
| LangChain | 模型、工具、检索等组件的集成库，v1 起以 `create_agent` 为主入口，底层基于 LangGraph | 快速搭建、需要丰富集成 |
| [OpenAI Agents SDK](/guide/11-frameworks/agent-sdks) | 轻量：Agent、工具、交接（handoff）、护栏 | 快速搭建多 Agent 原型，概念少 |
| [Claude Agent SDK](/guide/11-frameworks/agent-sdks) | 把 Claude Code 的 Agent 运行时作为库提供，自带文件、命令等工具 | 编码、运维、文件处理类 Agent |
| [LlamaIndex](/guide/11-frameworks/llamaindex-crewai) | 以数据和检索为中心 | RAG、文档问答、知识库 |
| [CrewAI](/guide/11-frameworks/llamaindex-crewai) | 角色扮演式多 Agent 团队 | 内容生产、调研等流程清晰的多角色协作 |
| [AutoGen](/guide/11-frameworks/llamaindex-crewai) | 微软出品的多 Agent 对话框架 | 研究和实验多 Agent 对话模式 |

### Go：云原生与高并发

Go 生态更注重性能、类型安全和工程化，框架数量少但质量不错。

| 框架 | 定位 | 适合 |
|------|------|------|
| [Eino](/guide/11-frameworks/go-eino) | 字节跳动 CloudWeGo 开源，组件 + 编排（Chain / Graph），强类型 | 国内大厂风格的生产级 Go 服务 |
| [langchaingo](/guide/11-frameworks/go-eino) | 社区维护的 LangChain Go 移植 | 熟悉 LangChain 概念、需要较多集成 |
| 官方 SDK + 手写 | openai-go 等官方 SDK 或直接 HTTP | 需求简单、追求可控和零依赖 |

### Java：企业级集成

Java 生态的优势在于和现有企业系统（Spring、数据库、消息队列、权限体系）的无缝集成。

| 框架 | 定位 | 适合 |
|------|------|------|
| [Spring AI](/guide/11-frameworks/java-spring-ai) | Spring 官方项目，`ChatClient` 流式 API、自动配置、Advisor 机制 | 已经是 Spring Boot 技术栈的团队 |
| [LangChain4j](/guide/11-frameworks/java-spring-ai) | 独立于 Spring，`AiServices` 声明式接口 | 非 Spring 项目，或偏好声明式写法 |
| Spring AI Alibaba | 基于 Spring AI，加强了阿里云生态和多 Agent 编排 | 使用通义千问、阿里云的团队 |

### 无代码与低代码

[Dify、Coze](/guide/11-frameworks/low-code) 等平台用可视化方式搭建 Agent 和工作流，适合业务人员快速验证想法，也能通过 API 嵌入到业务系统中。

## 跨语言选型总表

| 你的情况 | Python | Go | Java |
|---------|--------|----|----|
| 入门学习、理解原理 | 手写 + openai SDK | 手写 + net/http | 手写 + HttpClient |
| 简单工具 Agent | OpenAI Agents SDK | Eino ReAct Agent | Spring AI ChatClient + @Tool |
| 复杂流程、可中断恢复 | LangGraph | Eino Graph | Spring AI Alibaba Graph / 自研状态机 |
| RAG 知识库 | LlamaIndex | Eino / langchaingo 检索组件 | Spring AI / LangChain4j RAG |
| 多 Agent 协作 | LangGraph、CrewAI、OpenAI Agents SDK | Eino 多 Agent 组件 | Spring AI Alibaba、LangChain4j |
| 编码 / 文件操作 Agent | Claude Agent SDK | 调用 Claude Code CLI 或手写 | 手写 |
| 已有大量存量服务 | 看团队主语言 | 和现有 Go 微服务放一起 | 和现有 Spring 服务放一起 |

最后一行往往是决定性的：**团队主力语言和现有基础设施，比框架本身的功能差异更重要**。一个 Java 团队为了用 LangGraph 引入 Python 服务，换来的是两套部署、两套监控和跨语言调用的复杂度。反过来，如果 Agent 是一个独立的新服务、团队也有 Python 能力，Python 生态的丰富度就是实实在在的优势。

## 选型的五个问题

1. **语言与基础设施**：团队用什么语言？Agent 要和哪些现有系统打交道？
2. **控制力需求**：你需要精确控制每一步（选图编排类），还是让模型自己决定流程（选轻量 Agent 类）？
3. **持久化与人在环路**：任务会跑多久？要不要中途审批？这是手写最难做好的部分。
4. **模型绑定**：框架是否支持你要用的模型厂商（尤其是国内模型）？OpenAI 兼容接口通常是最大公约数。
5. **成熟度与活跃度**：版本是否稳定、文档是否跟得上、社区是否活跃、最近半年是否有破坏性变更。

## 控制锁定风险

Agent 框架普遍迭代很快，一年内出现大版本的破坏性变更是常态。几个降低风险的做法：

- **业务逻辑与框架解耦**：工具函数写成普通函数，提示词放在独立文件，框架只负责"粘合"。换框架时这些都能复用。
- **工具用 MCP 暴露**：把工具做成 [MCP Server](/guide/10-mcp/mcp-server)，任何框架都能接入。
- **锁定版本**：依赖写精确版本，升级前跑一遍 [回归测试](/guide/14-evaluation/regression)。
- **评估先行**：有了 [评估集](/guide/14-evaluation/eval-design)，换框架、换模型时才知道效果有没有退化。

## 常见坑

- **为了用框架而用框架**：三个工具的简单 Agent 引入一个重型框架，调试时要穿过好几层抽象才能看到真实的 prompt。
- **看过时教程**：框架 API 变化快，搜到的博客可能是一年前的写法。以官方文档和你锁定的版本为准。
- **混用多个框架**：一个项目里同时用 LangChain、LlamaIndex 和 CrewAI，各自有一套消息格式和工具抽象，组合起来很难维护。
- **忽略框架发出的真实请求**：框架会在背后拼接系统提示词、改写工具描述。开启 Trace 看清实际发给模型的内容，参考 [轨迹追踪与可观测性](/guide/14-evaluation/observability)。

## 小测

1. 一个 Agent 只需要调用 3 个内部 API 回答员工问题，团队用 Go，你会怎么选？

::: details 查看答案
优先考虑手写或用轻量方案：Go 标准库调用 OpenAI 兼容接口加一个简单循环即可；如果希望少写样板代码，可以用 Eino 的 ReAct Agent。不需要引入复杂的图编排。
:::

2. 什么样的需求最能体现 LangGraph 这类图编排框架相对手写的价值？

::: details 查看答案
长时间运行、需要中断后恢复（Checkpoint）、需要在特定步骤等待人工审批、流程有复杂分支或循环的场景。这些手写需要自己实现状态持久化和恢复逻辑，成本高且容易出错。
:::

3. 列举两种降低框架锁定风险的做法。

::: details 查看答案
例如：工具和业务逻辑写成与框架无关的普通函数或 MCP Server；提示词独立管理；锁定依赖版本；建立评估集，升级或迁移框架时用回归测试验证效果。
:::

## 延伸阅读

- 本模块各框架详解：[LangGraph](/guide/11-frameworks/langgraph)、[Claude Agent SDK 与 OpenAI Agents SDK](/guide/11-frameworks/agent-sdks)、[LlamaIndex、CrewAI 与 AutoGen](/guide/11-frameworks/llamaindex-crewai)、[Go：Eino 与 langchaingo](/guide/11-frameworks/go-eino)、[Java：Spring AI 与 LangChain4j](/guide/11-frameworks/java-spring-ai)、[低代码平台：Dify 与 Coze](/guide/11-frameworks/low-code)
- [Building effective agents（Anthropic 工程博客）](https://www.anthropic.com/engineering/building-effective-agents)
- 学习路径参考：[工程师路径](/roadmap/engineer)

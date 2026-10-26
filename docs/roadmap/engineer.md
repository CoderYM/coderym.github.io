---
title: 工程师路径
description: 面向有开发经验但没做过大模型应用的工程师，约 8 周，从 API 调用到可评估、可部署的 Agent 服务。
---

# 工程师路径

这条路径适合有 1 年以上开发经验的工程师：熟悉至少一门语言，写过 HTTP 服务，理解异步和错误处理。你不需要补编程基础，重点是建立对模型行为的直觉，以及把 Agent 当成一个"不确定的组件"来做工程化。

节奏按每周 8 到 10 小时估算，约 8 周。Go / Java 开发者可以全程用自己的语言做项目，相关文章都有 [Go] [Java] 标签页，框架部分重点看 [Go：Eino 与 langchaingo](/guide/11-frameworks/go-eino) 或 [Java：Spring AI 与 LangChain4j](/guide/11-frameworks/java-spring-ai)。

```text
第 1 周       第 2 周          第 3-4 周             第 5-6 周               第 7-8 周
基础速通 ──▶ 模型与提示词 ──▶ Tool Calling 与   ──▶ 上下文/记忆/RAG/  ──▶  多 Agent、评估
                              Agent 循环            MCP/框架               与生产化
```

## 阶段 1：基础速通（第 1 周）

目标：确认环境和基础工具链，半天到一天即可完成。

必读：

- [Agent 到底是什么](/guide/00-intro/what-is-agent)
- [Agent、Chatbot 与 Workflow 的区别](/guide/00-intro/agent-vs-workflow)
- [Agent 的能力边界与适用场景](/guide/00-intro/capabilities)
- [流式输出与 SSE](/guide/01-programming/streaming-sse)
- [数据校验：pydantic / struct tag / record](/guide/01-programming/data-validation)

可以跳过：开发环境、Python 基础、异步、HTTP 等文章，遇到不熟的点再查。

自检清单：

- [ ] 能说出 Agent 和固定 Workflow 各自适合什么场景
- [ ] 能用自己的语言消费一个 SSE 流
- [ ] 知道用什么方式把模型输出的 JSON 校验成强类型对象

## 阶段 2：大模型与提示词（第 2 周）

目标：建立对模型行为的直觉，能稳定拿到结构化输出。

必读：

- [Token 与上下文窗口](/guide/02-llm-basics/tokens-context)
- [采样参数：temperature、top_p](/guide/02-llm-basics/sampling)
- [推理模型与扩展思考](/guide/02-llm-basics/reasoning-models)
- [如何选择模型](/guide/02-llm-basics/choosing-models)
- [主流模型厂商 API 对比](/guide/03-llm-api/providers)
- [多轮对话与消息结构](/guide/03-llm-api/multi-turn)
- [计费、限流与错误重试](/guide/03-llm-api/cost-errors)
- [提示词基本原则](/guide/04-prompt/basics)
- [系统提示词与角色设计](/guide/04-prompt/system-prompt)
- [结构化输出与 JSON Schema](/guide/04-prompt/structured-output)
- [提示词版本管理与测试](/guide/04-prompt/prompt-management)

可以略读：[Transformer 的直觉理解](/guide/02-llm-basics/transformer)、[第一次调用大模型](/guide/03-llm-api/first-call)。

项目：[01 命令行聊天助手](/projects/01-cli-chat)，用半天完成，重点加上流式输出和重试。

自检清单：

- [ ] 能估算一次请求的 Token 量，知道输入和输出 Token 分开计费
- [ ] 能解释推理模型和普通模型在使用方式上的差别
- [ ] 能对比至少两家厂商 API 的消息格式差异
- [ ] 能用 JSON Schema 约束输出，并处理校验失败的情况
- [ ] 提示词放在版本库里管理，修改后有样例可以回归

## 阶段 3：Tool Calling 与 Agent 循环（第 3-4 周）

目标：不借助框架写出完整的 Agent，理解每一步的消息流转。这是整条路径最重要的阶段。

必读：本阶段两个模块全部必读。

- [工具调用原理](/guide/05-tool-calling/concept)、[实现第一个工具](/guide/05-tool-calling/first-tool)、[工具设计原则](/guide/05-tool-calling/tool-design)、[并行工具调用](/guide/05-tool-calling/parallel-tools)、[工具错误处理与重试](/guide/05-tool-calling/error-handling)
- [ReAct：推理与行动](/guide/06-agent-loop/react)、[不用框架手写 Agent](/guide/06-agent-loop/handwritten-agent)、[Plan-and-Execute](/guide/06-agent-loop/plan-execute)、[Reflection 自我反思](/guide/06-agent-loop/reflection)、[终止条件、步数与预算控制](/guide/06-agent-loop/stop-budget)

选读论文：[ReAct](/papers/react)、[Reflexion](/papers/reflexion)。

项目：[02 天气日程工具 Agent](/projects/02-tool-agent) 和 [03 手写 ReAct Agent](/projects/03-react-agent)。

自检清单：

- [ ] 能手写 Agent 主循环，并说清每一轮消息列表里新增了什么
- [ ] 工具描述写得足够清楚，模型很少选错工具或传错参数
- [ ] 能处理并行工具调用，并按 ID 把结果对应回去
- [ ] Agent 有最大步数、Token 预算和超时三重保护
- [ ] 能说出 ReAct 和 Plan-and-Execute 各自的优缺点

## 阶段 4：上下文、记忆、RAG、MCP 与框架（第 5-6 周）

目标：解决"Agent 拿不到正确信息"的问题，并能在框架和手写之间做取舍。

必读：

- [什么是上下文工程](/guide/07-context-engineering/overview)、[上下文窗口管理](/guide/07-context-engineering/window-management)、[压缩与摘要](/guide/07-context-engineering/compression)、[Prompt Caching](/guide/07-context-engineering/prompt-caching)
- [记忆的分类](/guide/08-memory/memory-types)、[记忆读写策略与方案对比](/guide/08-memory/memory-strategy)
- [Embedding 与向量语义](/guide/02-llm-basics/embeddings)
- [RAG 全景](/guide/09-rag/overview)、[文档解析与切分](/guide/09-rag/chunking)、[向量数据库](/guide/09-rag/vector-db)、[混合检索与重排](/guide/09-rag/hybrid-rerank)、[RAG 评估](/guide/09-rag/rag-eval)
- [MCP 架构与核心概念](/guide/10-mcp/mcp-overview)、[开发一个 MCP Server](/guide/10-mcp/mcp-server)、[在应用中接入 MCP](/guide/10-mcp/mcp-client)
- [框架全景与选型](/guide/11-frameworks/overview)，再根据语言选一篇：[LangGraph](/guide/11-frameworks/langgraph)、[Go：Eino 与 langchaingo](/guide/11-frameworks/go-eino) 或 [Java：Spring AI 与 LangChain4j](/guide/11-frameworks/java-spring-ai)

可以略读：[短期记忆与会话管理](/guide/08-memory/short-term)、[长期记忆与用户画像](/guide/08-memory/long-term)、[GraphRAG 与 Agentic RAG](/guide/09-rag/advanced-rag)、[A2A](/guide/10-mcp/a2a)、[低代码平台](/guide/11-frameworks/low-code)。

项目：[04 个人 PDF 知识库](/projects/04-pdf-rag) 和 [05 开发自己的 MCP Server](/projects/05-mcp-server)，时间允许再做 [06 网页研究员 Agent](/projects/06-research-agent)。

自检清单：

- [ ] 长对话时有明确的截断或压缩策略，并知道它对 Prompt Caching 的影响
- [ ] 能根据数据特点选择切分策略，并说明理由
- [ ] 能解释为什么要做混合检索和重排
- [ ] 能分别衡量 RAG 的检索质量和生成质量
- [ ] 能把一个已有的内部 API 包装成 MCP Server
- [ ] 能说出在你的场景里用框架的收益和代价

## 阶段 5：多 Agent、评估与生产化（第 7-8 周）

目标：把 Agent 变成可以上线、可以持续迭代的服务。

必读：

- [为什么评估是第一优先级](/guide/14-evaluation/why-evals)、[评估集与指标设计](/guide/14-evaluation/eval-design)、[LLM-as-Judge](/guide/14-evaluation/llm-judge)、[轨迹追踪与可观测性](/guide/14-evaluation/observability)、[回归测试与持续评估](/guide/14-evaluation/regression)
- [Prompt 注入与防护](/guide/15-production/prompt-injection)、[权限控制与人在环路](/guide/15-production/permissions-hitl)、[护栏与内容安全](/guide/15-production/guardrails)、[成本与延迟优化](/guide/15-production/cost-optimization)、[服务化：FastAPI / Gin / Spring Boot](/guide/15-production/serving)、[部署、监控与运维](/guide/15-production/deployment)
- [为什么需要多 Agent](/guide/12-multi-agent/why-multi-agent)、[编排模式](/guide/12-multi-agent/patterns)、[多 Agent 的坑与成本控制](/guide/12-multi-agent/pitfalls)
- [沙箱与代码执行安全](/guide/13-coding-agent/sandbox)

可以略读：[状态共享与通信](/guide/12-multi-agent/state-sharing)、模块 13 中的其他文章（按业务需要再读）。

项目：[08 代码审查 Agent](/projects/08-code-review) 或 [09 全栈 Agent 工作台](/projects/09-agent-workbench)，最后挑战 [10 毕业项目：企业知识助手](/projects/10-enterprise-assistant)。

自检清单：

- [ ] 有一个至少 50 条用例的评估集，每次改提示词或换模型都会跑
- [ ] 每次请求都有完整的轨迹记录，能定位是哪一步出错
- [ ] 能防御间接 Prompt 注入，高风险操作需要人工确认
- [ ] Agent 以 API 服务形式部署，支持流式输出、超时和限流
- [ ] 能说出单 Agent 改为多 Agent 的判断依据和额外成本
- [ ] 能给出一次请求的成本和延迟构成，并提出至少两种优化手段

完成后，如果你开始负责技术选型或团队落地，继续看 [架构师路径](/roadmap/architect)。面试准备可以看 [面试题](/interview/)。

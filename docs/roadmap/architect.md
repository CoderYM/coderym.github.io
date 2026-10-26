---
title: 架构师路径
description: 面向已有大模型应用经验、负责技术选型和系统设计的工程师，约 6 周，聚焦架构决策、评估体系与生产治理。
---

# 架构师路径

这条路径适合已经做过大模型应用、需要为团队做技术选型和系统设计的人。默认你已经能熟练使用 Tool Calling 和 RAG，所以前两个阶段只做快速校准，时间主要花在上下文工程、多 Agent 架构、评估体系和生产治理上。

节奏按每周 6 到 8 小时估算，约 6 周。每个阶段除了读文章，都要求产出一份设计文档或决策记录，这比代码更能检验架构能力。

```text
第 1 周              第 2 周            第 3 周               第 4 周              第 5-6 周
基础与模型校准 ──▶  Agent 循环设计 ──▶ 上下文与知识架构 ──▶ 多 Agent 与生态 ──▶  评估、安全与生产治理
（阶段 1+2）        （阶段 3）         （阶段 4）            （阶段 4、5）         （阶段 5）
```

## 阶段 1 + 2：基础与模型校准（第 1 周）

目标：统一团队对 Agent 的定义，建立模型选型方法。

必读：

- [Agent、Chatbot 与 Workflow 的区别](/guide/00-intro/agent-vs-workflow)
- [Agent 的能力边界与适用场景](/guide/00-intro/capabilities)
- [推理模型与扩展思考](/guide/02-llm-basics/reasoning-models)
- [如何选择模型](/guide/02-llm-basics/choosing-models)
- [主流模型厂商 API 对比](/guide/03-llm-api/providers)
- [提示词版本管理与测试](/guide/04-prompt/prompt-management)

可以跳过：模块 01 全部，模块 02 到 04 中的入门文章。

产出：一份《模型选型方法》文档，说明你们团队如何按任务难度、延迟、成本、数据合规在多个模型之间选择，以及如何避免被单一厂商锁定。

自检清单：

- [ ] 能向业务方解释哪些需求适合 Agent，哪些用固定 Workflow 更好
- [ ] 有一套可复用的模型对比方法，而不是凭感觉选模型
- [ ] 提示词和模型版本可追溯，变更有评估结果支撑

## 阶段 3：Agent 循环设计（第 2 周）

目标：能为不同任务选择合适的控制流，并设计可控的工具体系。

必读：

- [工具设计原则](/guide/05-tool-calling/tool-design)
- [工具错误处理与重试](/guide/05-tool-calling/error-handling)
- [Plan-and-Execute](/guide/06-agent-loop/plan-execute)
- [Reflection 自我反思](/guide/06-agent-loop/reflection)
- [终止条件、步数与预算控制](/guide/06-agent-loop/stop-budget)
- 论文：[ReAct](/papers/react)、[Reflexion](/papers/reflexion)、[Tree of Thoughts](/papers/tree-of-thoughts)

可以略读：[工具调用原理](/guide/05-tool-calling/concept)、[不用框架手写 Agent](/guide/06-agent-loop/handwritten-agent)。如果团队里还没人手写过 Agent 循环，建议你亲自做一遍 [03 手写 ReAct Agent](/projects/03-react-agent)。

产出：一份《工具规范》，包括工具命名、描述、参数设计、错误返回格式、幂等性要求、读写权限分级。

自检清单：

- [ ] 能针对一个具体业务说明为什么选 ReAct、Plan-and-Execute 或固定 Workflow
- [ ] 工具粒度有统一标准，避免"一个工具做所有事"或"工具多到模型选不对"
- [ ] 每个 Agent 都有步数、Token、时间和金额四类预算上限

## 阶段 4：上下文与知识架构（第 3 周）

目标：设计上下文组装、记忆和知识检索的整体方案。

必读：

- [什么是上下文工程](/guide/07-context-engineering/overview)、[上下文窗口管理](/guide/07-context-engineering/window-management)、[压缩与摘要](/guide/07-context-engineering/compression)、[Prompt Caching](/guide/07-context-engineering/prompt-caching)
- [长期记忆与用户画像](/guide/08-memory/long-term)、[记忆读写策略与方案对比](/guide/08-memory/memory-strategy)
- [混合检索与重排](/guide/09-rag/hybrid-rerank)、[GraphRAG 与 Agentic RAG](/guide/09-rag/advanced-rag)、[RAG 评估](/guide/09-rag/rag-eval)
- 论文：[RAG 原始论文](/papers/rag)、[Generative Agents](/papers/generative-agents)

可以略读：[RAG 全景](/guide/09-rag/overview)、[文档解析与切分](/guide/09-rag/chunking)、[向量数据库](/guide/09-rag/vector-db)。

产出：一份上下文架构图，标出系统提示词、工具定义、记忆、检索结果、对话历史各自的来源、预算占比和缓存策略。

自检清单：

- [ ] 上下文的组装顺序考虑了 Prompt Caching 命中率
- [ ] 能说明长期记忆的写入时机、冲突处理和删除机制（含用户隐私要求）
- [ ] 能判断什么情况下 GraphRAG 或 Agentic RAG 值得引入
- [ ] 知识库的权限能做到文档级别隔离

## 阶段 4 + 5：多 Agent 与生态（第 4 周）

目标：在框架、协议和多 Agent 架构之间做出有依据的选择。

必读：

- [MCP 架构与核心概念](/guide/10-mcp/mcp-overview)、[在应用中接入 MCP](/guide/10-mcp/mcp-client)、[A2A：Agent 之间的协议](/guide/10-mcp/a2a)
- [框架全景与选型](/guide/11-frameworks/overview)、[LangGraph](/guide/11-frameworks/langgraph)、[Claude Agent SDK 与 OpenAI Agents SDK](/guide/11-frameworks/agent-sdks)
- [为什么需要多 Agent](/guide/12-multi-agent/why-multi-agent)、[编排模式](/guide/12-multi-agent/patterns)、[状态共享与通信](/guide/12-multi-agent/state-sharing)、[多 Agent 的坑与成本控制](/guide/12-multi-agent/pitfalls)
- [Coding Agent 原理](/guide/13-coding-agent/coding-agents)、[沙箱与代码执行安全](/guide/13-coding-agent/sandbox)
- 论文：[SWE-agent](/papers/swe-agent)

项目：[07 多 Agent 写作团队](/projects/07-writing-team)，重点对比单 Agent 和多 Agent 版本在质量、成本、延迟上的差异。

产出：一份《框架与协议选型 ADR》（架构决策记录），说明是否使用框架、用哪个、内部工具是否统一以 MCP 暴露。

自检清单：

- [ ] 能说出至少三种多 Agent 编排模式及适用场景
- [ ] 能量化多 Agent 带来的额外 Token 成本
- [ ] 对 MCP Server 的来源、权限和审计有明确策略
- [ ] 执行代码或操作系统的 Agent 一定运行在隔离环境中

## 阶段 5：评估、安全与生产治理（第 5-6 周）

目标：建立团队级的评估体系和上线标准。

必读：

- 模块 14 全部：[为什么评估是第一优先级](/guide/14-evaluation/why-evals)、[评估集与指标设计](/guide/14-evaluation/eval-design)、[LLM-as-Judge](/guide/14-evaluation/llm-judge)、[轨迹追踪与可观测性](/guide/14-evaluation/observability)、[回归测试与持续评估](/guide/14-evaluation/regression)
- 模块 15 全部：[Prompt 注入与防护](/guide/15-production/prompt-injection)、[权限控制与人在环路](/guide/15-production/permissions-hitl)、[护栏与内容安全](/guide/15-production/guardrails)、[成本与延迟优化](/guide/15-production/cost-optimization)、[服务化](/guide/15-production/serving)、[部署、监控与运维](/guide/15-production/deployment)

项目：[10 毕业项目：企业知识助手](/projects/10-enterprise-assistant)，按生产标准交付：评估集、轨迹追踪、权限、护栏、灰度发布方案。

产出：一份《Agent 上线检查清单》，作为团队所有 Agent 上线前的统一门槛。

自检清单：

- [ ] 评估集覆盖正常、边界和对抗三类用例，并接入 CI
- [ ] LLM-as-Judge 的评分与人工标注做过一致性校验
- [ ] 线上轨迹可以抽样回流成新的评估用例
- [ ] 有完整的 Prompt 注入威胁模型，工具权限遵循最小权限原则
- [ ] 有成本告警、降级模型和熔断策略
- [ ] 能用 [工程与系统设计题](/interview/engineering) 中的系统设计题完整讲出一套方案

完成后建议通读 [论文精读](/papers/) 中尚未读过的论文，并用 [术语表](/glossary) 统一团队内部用语。

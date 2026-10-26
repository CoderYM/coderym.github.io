---
title: 12 周学习计划
description: 每周 8 到 10 小时，12 周从环境搭建走到毕业项目，每周都有目标、必读文章、作业和自检问题。
---

# 12 周学习计划

这份计划适合有一点编程基础、希望按固定节奏学习的同学。每周投入 8 到 10 小时：大约一半时间读文章，一半时间写代码。完全零基础的同学建议先看 [零基础入门路径](/roadmap/beginner)，在第 1-2 周多花一倍时间。

下面的进度表会保存在你的浏览器本地，完成一周就勾一周。

<ProgressTracker :weeks="['环境与 Python 基础', 'HTTP、异步与第一次调用', '大模型原理', '提示词工程', 'Tool Calling', 'Agent 循环', '上下文工程与记忆', 'RAG 知识库', 'MCP 与框架', '多 Agent 系统', '评估与可观测性', '安全、部署与毕业项目']" />

```text
阶段1 基础准备      阶段2 大模型与提示词   阶段3 Tool Calling   阶段4 上下文/记忆/RAG/MCP   阶段5 多 Agent 与生产化
第 1-2 周           第 3-4 周              与 Agent 循环        第 7-9 周                  第 10-12 周
                                           第 5-6 周
```

::: tip 使用建议
- 作业比阅读重要。读完没做作业，等于这周没学。
- 自检问题请先合上文章、用自己的话回答，答不上来再回去看。
- 进度落后一周很正常，但不要跳过阶段 3，它是后面所有内容的基础。
:::

## 阶段 1：基础准备

### 第 1 周：环境与 Python 基础

本周目标：搭好开发环境，掌握 Agent 开发中最常用的 Python 写法，并对 Agent 建立正确的第一印象。

必读文章：

- [Agent 到底是什么](/guide/00-intro/what-is-agent)
- [Agent、Chatbot 与 Workflow 的区别](/guide/00-intro/agent-vs-workflow)
- [如何使用本站学习](/guide/00-intro/how-to-learn)
- [开发环境：Python / Go / Java](/guide/01-programming/dev-env)
- [Agent 开发必备 Python](/guide/01-programming/python-essentials)
- [数据校验：pydantic / struct tag / record](/guide/01-programming/data-validation)

本周作业：

1. 安装 Python 和一个包管理工具，创建项目目录和虚拟环境。
2. 用 pydantic 定义一个 `Task` 模型（标题、优先级、截止日期），写函数把 JSON 字符串解析成 `Task` 列表，对非法数据给出友好报错。
3. 把代码提交到自己的 Git 仓库，后面 11 周都在这个仓库里迭代。

自检问题：

- Agent 和普通聊天机器人最本质的区别是什么？
- 为什么不能把 API Key 写在代码里？你用什么方式管理它？
- pydantic 校验失败时会发生什么？你会如何处理？

### 第 2 周：HTTP、异步与第一次调用

本周目标：理解 HTTP 和流式输出，完成第一次大模型 API 调用。

必读文章：

- [HTTP、JSON 与 REST API](/guide/01-programming/http-json)
- [异步与并发编程](/guide/01-programming/async)
- [流式输出与 SSE](/guide/01-programming/streaming-sse)
- [第一次调用大模型](/guide/03-llm-api/first-call)
- [主流模型厂商 API 对比](/guide/03-llm-api/providers)

本周作业：

1. 用官方 SDK 调用一次大模型，再用原始 HTTP 请求（`httpx`）完成同样的调用，对比两者的请求体。
2. 用 `asyncio.gather` 并发发出 3 个问题，记录总耗时，与串行调用对比。

自检问题：

- 一次大模型 API 请求的 Body 里通常包含哪些字段？
- SSE 和普通 HTTP 响应有什么区别？为什么大模型应用常用它？
- 什么场景适合用异步？异步一定比同步快吗？

## 阶段 2：大模型与提示词

### 第 3 周：大模型原理

本周目标：建立对模型工作方式的直觉，理解 Token、上下文窗口和采样参数，能做出一个多轮对话程序。

必读文章：

- [Transformer 的直觉理解](/guide/02-llm-basics/transformer)
- [Token 与上下文窗口](/guide/02-llm-basics/tokens-context)
- [采样参数：temperature、top_p](/guide/02-llm-basics/sampling)
- [推理模型与扩展思考](/guide/02-llm-basics/reasoning-models)
- [如何选择模型](/guide/02-llm-basics/choosing-models)
- [多轮对话与消息结构](/guide/03-llm-api/multi-turn)
- [流式响应实战](/guide/03-llm-api/streaming)
- [计费、限流与错误重试](/guide/03-llm-api/cost-errors)

本周作业：完成 [01 命令行聊天助手](/projects/01-cli-chat)：支持多轮对话、流式输出、遇到限流自动重试，并在每轮结束后打印本轮 Token 用量。

自检问题：

- 为什么说"模型没有记忆"？多轮对话是怎么实现的？
- 把 temperature 设为 0，输出就一定完全相同吗？
- 对话越来越长时会出现什么问题？你的聊天助手如何应对？

### 第 4 周：提示词工程

本周目标：掌握写提示词的基本原则，能让模型稳定输出可被程序解析的结构化结果。

必读文章：

- [提示词基本原则](/guide/04-prompt/basics)
- [系统提示词与角色设计](/guide/04-prompt/system-prompt)
- [Few-shot 与思维链](/guide/04-prompt/few-shot-cot)
- [结构化输出与 JSON Schema](/guide/04-prompt/structured-output)
- [提示词版本管理与测试](/guide/04-prompt/prompt-management)
- 选读论文：[Chain-of-Thought](/papers/chain-of-thought)

本周作业：

1. 写一个"简历信息提取器"：输入一段简历文本，输出符合 JSON Schema 的结构化数据（姓名、技能列表、工作经历）。
2. 准备 10 份不同风格的简历样例，写脚本批量运行并统计解析成功率。修改提示词后重新运行，比较结果。

自检问题：

- 好的系统提示词通常包含哪几部分？
- Few-shot 示例选得不好会带来什么问题？
- 为什么提示词需要像代码一样做版本管理和回归测试？

## 阶段 3：Tool Calling 与 Agent 循环

### 第 5 周：Tool Calling

本周目标：理解工具调用的完整流程，能为模型设计好用的工具并处理各种异常。

必读文章：

- [工具调用原理](/guide/05-tool-calling/concept)
- [实现第一个工具](/guide/05-tool-calling/first-tool)
- [工具设计原则](/guide/05-tool-calling/tool-design)
- [并行工具调用](/guide/05-tool-calling/parallel-tools)
- [工具错误处理与重试](/guide/05-tool-calling/error-handling)
- 选读论文：[Toolformer](/papers/toolformer)

本周作业：完成 [02 天气日程工具 Agent](/projects/02-tool-agent)。至少实现 3 个工具（查天气、查日程、创建日程），并故意让其中一个工具随机报错，观察模型如何应对。

自检问题：

- 在 Tool Calling 中，模型做了什么，你的代码做了什么？
- 工具描述写得含糊会导致哪些问题？
- 模型一次返回多个工具调用时，结果要如何对应回去？

### 第 6 周：Agent 循环

本周目标：不使用任何框架，亲手写出一个完整的 Agent 循环，并理解几种主流的控制模式。

必读文章：

- [ReAct：推理与行动](/guide/06-agent-loop/react)
- [不用框架手写 Agent](/guide/06-agent-loop/handwritten-agent)
- [Plan-and-Execute](/guide/06-agent-loop/plan-execute)
- [Reflection 自我反思](/guide/06-agent-loop/reflection)
- [终止条件、步数与预算控制](/guide/06-agent-loop/stop-budget)
- 选读论文：[ReAct](/papers/react)、[Reflexion](/papers/reflexion)

本周作业：完成 [03 手写 ReAct Agent](/projects/03-react-agent)。要求：最大步数限制、Token 预算限制、每一步的思考和工具调用都打印出来。再给它加一个"完成前自我检查"的 Reflection 步骤，对比加之前和加之后的效果。

自检问题：

- 画出 Agent 循环的流程图，并指出循环在什么条件下结束。
- ReAct 和 Plan-and-Execute 分别适合什么样的任务？
- 如果 Agent 反复调用同一个工具陷入死循环，你有哪些办法？

## 阶段 4：上下文、记忆、RAG 与 MCP

### 第 7 周：上下文工程与记忆

本周目标：理解上下文是 Agent 最稀缺的资源，掌握窗口管理、压缩和记忆的基本方案。

必读文章：

- [什么是上下文工程](/guide/07-context-engineering/overview)
- [上下文窗口管理](/guide/07-context-engineering/window-management)
- [压缩与摘要](/guide/07-context-engineering/compression)
- [Prompt Caching](/guide/07-context-engineering/prompt-caching)
- [记忆的分类](/guide/08-memory/memory-types)
- [短期记忆与会话管理](/guide/08-memory/short-term)
- [长期记忆与用户画像](/guide/08-memory/long-term)
- [记忆读写策略与方案对比](/guide/08-memory/memory-strategy)

本周作业：给第 6 周的 Agent 加上两种能力：当上下文超过阈值时自动摘要早期对话；把"用户偏好"写入一个本地 JSON 文件，下次启动时读取并放入系统提示词。

自检问题：

- 上下文工程和提示词工程有什么区别？
- 摘要压缩可能丢失什么信息？如何降低风险？
- 长期记忆什么时候写入、什么时候读取？写错了怎么办？

### 第 8 周：RAG 知识库

本周目标：从零搭建一个 RAG 系统，理解检索质量对最终答案的决定性影响。

必读文章：

- [Embedding 与向量语义](/guide/02-llm-basics/embeddings)
- [RAG 全景](/guide/09-rag/overview)
- [文档解析与切分](/guide/09-rag/chunking)
- [向量数据库](/guide/09-rag/vector-db)
- [混合检索与重排](/guide/09-rag/hybrid-rerank)
- [GraphRAG 与 Agentic RAG](/guide/09-rag/advanced-rag)
- [RAG 评估](/guide/09-rag/rag-eval)
- 选读论文：[RAG 原始论文](/papers/rag)

本周作业：完成 [04 个人 PDF 知识库](/projects/04-pdf-rag)。准备 20 个问题和标准答案，分别统计"只用向量检索"和"向量检索加重排"两种方案的命中率。

自检问题：

- RAG 的离线和在线两条链路分别做什么？
- 切分块大小如何影响检索效果？
- 答案错了，你怎么判断是检索的问题还是生成的问题？

### 第 9 周：MCP 与框架

本周目标：掌握 MCP 协议，了解主流框架的定位，能判断什么时候该用框架。

必读文章：

- [MCP 架构与核心概念](/guide/10-mcp/mcp-overview)
- [开发一个 MCP Server](/guide/10-mcp/mcp-server)
- [在应用中接入 MCP](/guide/10-mcp/mcp-client)
- [A2A：Agent 之间的协议](/guide/10-mcp/a2a)
- [框架全景与选型](/guide/11-frameworks/overview)
- [LangGraph](/guide/11-frameworks/langgraph)
- [Claude Agent SDK 与 OpenAI Agents SDK](/guide/11-frameworks/agent-sdks)
- 按语言选读：[Go：Eino 与 langchaingo](/guide/11-frameworks/go-eino) 或 [Java：Spring AI 与 LangChain4j](/guide/11-frameworks/java-spring-ai)

本周作业：完成 [05 开发自己的 MCP Server](/projects/05-mcp-server)，把第 8 周的知识库检索包装成一个 MCP 工具，并在一个支持 MCP 的客户端里调用它。再用 LangGraph 把第 6 周的 Agent 重写一遍，记录代码量和可读性的变化。

自检问题：

- MCP 解决了什么问题？Host、Client、Server 分别是什么？
- MCP 的 Tools、Resources、Prompts 有什么区别？
- 你的项目里用框架的收益和代价各是什么？

## 阶段 5：多 Agent 与生产化

### 第 10 周：多 Agent 系统

本周目标：理解多 Agent 的价值和代价，掌握常见的编排模式。

必读文章：

- [为什么需要多 Agent](/guide/12-multi-agent/why-multi-agent)
- [编排模式：主从、流水线、交接、辩论](/guide/12-multi-agent/patterns)
- [状态共享与通信](/guide/12-multi-agent/state-sharing)
- [多 Agent 的坑与成本控制](/guide/12-multi-agent/pitfalls)
- [Coding Agent 原理](/guide/13-coding-agent/coding-agents)
- [沙箱与代码执行安全](/guide/13-coding-agent/sandbox)
- 选读论文：[Generative Agents](/papers/generative-agents)、[SWE-agent](/papers/swe-agent)

本周作业：完成 [06 网页研究员 Agent](/projects/06-research-agent) 或 [07 多 Agent 写作团队](/projects/07-writing-team)。对同一批任务分别跑单 Agent 和多 Agent 版本，记录质量、Token 消耗和耗时。

自检问题：

- 什么样的任务值得拆成多个 Agent？什么样的任务不值得？
- 主从模式中，子 Agent 应该把什么信息交还给主 Agent？
- 多 Agent 系统最常见的失败原因有哪些？

### 第 11 周：评估与可观测性

本周目标：建立评估集和轨迹追踪，让每一次修改都能被量化。

必读文章：

- [为什么评估是第一优先级](/guide/14-evaluation/why-evals)
- [评估集与指标设计](/guide/14-evaluation/eval-design)
- [LLM-as-Judge](/guide/14-evaluation/llm-judge)
- [轨迹追踪与可观测性](/guide/14-evaluation/observability)
- [回归测试与持续评估](/guide/14-evaluation/regression)

本周作业：为你最满意的一个项目建立至少 30 条用例的评估集，包含正常、边界和对抗用例；写一个 LLM-as-Judge 评分器，并抽 10 条与自己的人工评分对比；接入一个追踪工具，能看到每次请求的完整轨迹。

自检问题：

- 为什么说没有评估集的 Agent 无法迭代？
- LLM-as-Judge 有哪些已知偏差？如何缓解？
- 一条完整的 Agent 轨迹里应该记录哪些信息？

### 第 12 周：安全、部署与毕业项目

本周目标：掌握生产化的关键环节，交付一个完整的毕业项目。

必读文章：

- [Prompt 注入与防护](/guide/15-production/prompt-injection)
- [权限控制与人在环路](/guide/15-production/permissions-hitl)
- [护栏与内容安全](/guide/15-production/guardrails)
- [成本与延迟优化](/guide/15-production/cost-optimization)
- [服务化：FastAPI / Gin / Spring Boot](/guide/15-production/serving)
- [部署、监控与运维](/guide/15-production/deployment)

本周作业：完成 [10 毕业项目：企业知识助手](/projects/10-enterprise-assistant)。至少包含：RAG 检索、2 个以上工具、Prompt 注入防护、高风险操作人工确认、第 11 周的评估集和轨迹追踪、以 HTTP 服务形式部署。

自检问题：

- 间接 Prompt 注入是怎么发生的？你的项目里有哪些入口？
- 哪些工具调用需要人工确认？依据是什么？
- 如果明天调用量翻 10 倍，成本和延迟会出现什么问题？你准备怎么办？

## 学完之后

- 用 [面试题](/interview/) 检验自己的理解深度。
- 读完 [论文精读](/papers/) 中的全部论文。
- 回头做 [08 代码审查 Agent](/projects/08-code-review) 和 [09 全栈 Agent 工作台](/projects/09-agent-workbench)，补齐没做的项目。
- 如果开始负责团队的 Agent 落地，继续看 [架构师路径](/roadmap/architect)。

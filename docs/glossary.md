---
title: 术语表
description: AI Agent 开发常用术语的中英文对照与简明解释，按主题分组，并链接到详细讲解的文章。
---

# 术语表

本页收录 Agent 开发中常见的术语，按主题分组。每个术语给出英文 / 中文名称、简要解释，以及详细讲解它的文章。

## 基础概念

| 术语 | 解释 | 相关文章 |
| --- | --- | --- |
| Agent / 智能体 | 由大模型驱动、能根据目标自主决定下一步行动、调用工具并循环执行直到完成任务的系统。 | [Agent 到底是什么](/guide/00-intro/what-is-agent) |
| Workflow / 工作流 | 由开发者预先定义执行路径的流程，模型只在固定节点完成子任务，路径不由模型决定。 | [Agent、Chatbot 与 Workflow 的区别](/guide/00-intro/agent-vs-workflow) |
| Chatbot / 聊天机器人 | 以一问一答的对话为主要形式的应用，通常只生成文本，不主动执行动作。 | [Agent、Chatbot 与 Workflow 的区别](/guide/00-intro/agent-vs-workflow) |
| Agentic / 智能体化的 | 形容系统具有自主决策、调用工具、多步执行的特性，比如 Agentic RAG。 | [Agent 的能力边界与适用场景](/guide/00-intro/capabilities) |
| LLM (Large Language Model) / 大语言模型 | 在海量文本上训练、能够理解和生成自然语言的大规模神经网络模型。 | [Transformer 的直觉理解](/guide/02-llm-basics/transformer) |

## 大模型原理

| 术语 | 解释 | 相关文章 |
| --- | --- | --- |
| Transformer | 当前大模型的主流神经网络架构，核心是注意力机制，能并行处理序列并建模长距离依赖。 | [Transformer 的直觉理解](/guide/02-llm-basics/transformer) |
| Attention / 注意力机制 | 让模型在处理每个 Token 时，按相关程度加权关注序列中的其他 Token。 | [Transformer 的直觉理解](/guide/02-llm-basics/transformer) |
| Token / 词元 | 模型处理文本的基本单位，可能是一个词、子词或字符；上下文长度、计费都按 Token 计算。 | [Token 与上下文窗口](/guide/02-llm-basics/tokens-context) |
| Tokenizer / 分词器 | 把文本切分成 Token 并映射成数字 ID 的组件，不同模型的分词器不同。 | [Token 与上下文窗口](/guide/02-llm-basics/tokens-context) |
| Context Window / 上下文窗口 | 模型单次请求能处理的最大 Token 数，包括输入和输出。 | [Token 与上下文窗口](/guide/02-llm-basics/tokens-context) |
| Temperature / 温度 | 控制采样随机性的参数，越低输出越确定，越高越多样。 | [采样参数：temperature、top_p](/guide/02-llm-basics/sampling) |
| Top-p / 核采样 | 只在累计概率达到 p 的候选 Token 中采样，截掉低概率的长尾。 | [采样参数：temperature、top_p](/guide/02-llm-basics/sampling) |
| Embedding / 嵌入向量 | 把文本等内容映射成固定长度的稠密向量，语义相近的内容向量距离更近。 | [Embedding 与向量语义](/guide/02-llm-basics/embeddings) |
| Reasoning Model / 推理模型 | 在给出答案前进行较长内部推理的模型，擅长数学、代码和复杂规划。 | [推理模型与扩展思考](/guide/02-llm-basics/reasoning-models) |
| Extended Thinking / 扩展思考 | 让模型在回答前花更多 Token 进行推理的能力或模式，通常可以设置思考预算。 | [推理模型与扩展思考](/guide/02-llm-basics/reasoning-models) |
| Hallucination / 幻觉 | 模型生成看似合理但与事实不符或无依据的内容。 | [Agent 的能力边界与适用场景](/guide/00-intro/capabilities) |
| Fine-tuning / 微调 | 在预训练模型的基础上用特定数据继续训练，改变模型的行为或能力。 | [如何选择模型](/guide/02-llm-basics/choosing-models) |
| Multimodal / 多模态 | 模型能处理文本以外的输入或输出，比如图片、音频、文档。 | [多模态输入：图片与文档](/guide/03-llm-api/multimodal) |

## 大模型 API

| 术语 | 解释 | 相关文章 |
| --- | --- | --- |
| Message / 消息 | 对话 API 的基本单位，由角色和内容组成，多轮对话就是消息列表。 | [多轮对话与消息结构](/guide/03-llm-api/multi-turn) |
| Role / 角色 | 消息的发送方类型，常见的有 system、user、assistant，以及工具结果。 | [多轮对话与消息结构](/guide/03-llm-api/multi-turn) |
| Streaming / 流式输出 | 模型边生成边返回结果，降低用户感知的等待时间。 | [流式响应实战](/guide/03-llm-api/streaming) |
| SSE (Server-Sent Events) / 服务端推送事件 | 基于 HTTP 的单向服务端推送协议，大多数模型 API 用它实现流式输出。 | [流式输出与 SSE](/guide/01-programming/streaming-sse) |
| Rate Limit / 限流 | 模型服务对请求频率或 Token 用量的限制，超出时通常返回 429 错误。 | [计费、限流与错误重试](/guide/03-llm-api/cost-errors) |
| Exponential Backoff / 指数退避 | 失败后等待时间按指数增长再重试的策略，通常配合随机抖动。 | [计费、限流与错误重试](/guide/03-llm-api/cost-errors) |
| TTFT (Time To First Token) / 首 Token 延迟 | 从发出请求到收到第一个输出 Token 的时间，是流式体验的关键指标。 | [成本与延迟优化](/guide/15-production/cost-optimization) |

## 提示词工程

| 术语 | 解释 | 相关文章 |
| --- | --- | --- |
| Prompt / 提示词 | 发送给模型的输入文本，包含指令、背景、示例和数据。 | [提示词基本原则](/guide/04-prompt/basics) |
| System Prompt / 系统提示词 | 设定模型角色、规则和全局约束的消息，在整个对话中持续生效。 | [系统提示词与角色设计](/guide/04-prompt/system-prompt) |
| Zero-shot / 零样本 | 不提供示例，只用指令让模型完成任务。 | [Few-shot 与思维链](/guide/04-prompt/few-shot-cot) |
| Few-shot / 少样本 | 在提示词中提供少量输入输出示例，让模型模仿完成任务。 | [Few-shot 与思维链](/guide/04-prompt/few-shot-cot) |
| CoT (Chain-of-Thought) / 思维链 | 让模型先写出推理步骤再给出答案的方法，能提升多步推理能力。 | [Chain-of-Thought](/papers/chain-of-thought) |
| ToT (Tree of Thoughts) / 思维树 | 把推理过程扩展成可以探索、评估和回溯的树搜索。 | [Tree of Thoughts](/papers/tree-of-thoughts) |
| Structured Output / 结构化输出 | 让模型按指定格式（通常是 JSON Schema）输出，便于程序解析。 | [结构化输出与 JSON Schema](/guide/04-prompt/structured-output) |
| JSON Schema | 描述 JSON 数据结构和约束的标准，用于定义工具参数和结构化输出格式。 | [结构化输出与 JSON Schema](/guide/04-prompt/structured-output) |
| Prompt Template / 提示词模板 | 带有变量占位符的提示词，运行时填入具体内容。 | [提示词版本管理与测试](/guide/04-prompt/prompt-management) |

## Tool Calling 与 Agent 循环

| 术语 | 解释 | 相关文章 |
| --- | --- | --- |
| Tool Calling / Function Calling / 工具调用 | 模型生成"调用哪个工具、传什么参数"的结构化请求，由应用代码执行后把结果返回给模型。 | [工具调用原理](/guide/05-tool-calling/concept) |
| Tool Schema / 工具定义 | 描述工具名称、用途和参数结构的定义，是模型选择和使用工具的依据。 | [实现第一个工具](/guide/05-tool-calling/first-tool) |
| Parallel Tool Calls / 并行工具调用 | 模型在一次回复中请求多个互不依赖的工具调用，应用可以并发执行。 | [并行工具调用](/guide/05-tool-calling/parallel-tools) |
| Idempotency / 幂等性 | 同一操作执行多次与执行一次的效果相同，是工具安全重试的前提。 | [工具错误处理与重试](/guide/05-tool-calling/error-handling) |
| Agent Loop / Agent 循环 | 调用模型、执行工具、把结果放回上下文、再次调用模型，直到满足终止条件的主循环。 | [不用框架手写 Agent](/guide/06-agent-loop/handwritten-agent) |
| ReAct (Reasoning + Acting) | 推理与行动交替进行的 Agent 模式：Thought、Action、Observation 循环。 | [ReAct：推理与行动](/guide/06-agent-loop/react) |
| Observation / 观察结果 | Agent 执行行动后从环境或工具获得的返回信息。 | [ReAct：推理与行动](/guide/06-agent-loop/react) |
| Plan-and-Execute / 规划与执行 | 先生成完整计划，再逐步执行，必要时重新规划的 Agent 模式。 | [Plan-and-Execute](/guide/06-agent-loop/plan-execute) |
| Reflection / 自我反思 | 让模型检查和评价自己的输出或失败轨迹，再据此改进。 | [Reflection 自我反思](/guide/06-agent-loop/reflection) |
| Budget / 预算控制 | 对 Agent 的步数、Token、时间和金额设置上限，防止循环和成本失控。 | [终止条件、步数与预算控制](/guide/06-agent-loop/stop-budget) |

## 上下文工程与记忆

| 术语 | 解释 | 相关文章 |
| --- | --- | --- |
| Context Engineering / 上下文工程 | 设计每次模型调用时上下文中放什么、怎么放、放多少的工程实践。 | [什么是上下文工程](/guide/07-context-engineering/overview) |
| Sliding Window / 滑动窗口 | 只保留最近若干轮对话的上下文管理策略。 | [上下文窗口管理](/guide/07-context-engineering/window-management) |
| Compaction / 上下文压缩 | 把较早的对话或工具结果总结成摘要，减少上下文占用。 | [压缩与摘要](/guide/07-context-engineering/compression) |
| Prompt Caching / 提示词缓存 | 模型服务端对重复的请求前缀做缓存，降低延迟和成本。 | [Prompt Caching](/guide/07-context-engineering/prompt-caching) |
| Short-term Memory / 短期记忆 | 当前会话中的对话和任务状态，存在于上下文窗口中。 | [短期记忆与会话管理](/guide/08-memory/short-term) |
| Long-term Memory / 长期记忆 | 跨会话持久保存的信息，如用户偏好、历史经验，需要时检索。 | [长期记忆与用户画像](/guide/08-memory/long-term) |
| Episodic Memory / 情景记忆 | 记录过去发生的具体事件和经历的记忆。 | [记忆的分类](/guide/08-memory/memory-types) |
| Semantic Memory / 语义记忆 | 记录事实和知识的记忆，比如用户画像、领域知识。 | [记忆的分类](/guide/08-memory/memory-types) |

## RAG 知识库

| 术语 | 解释 | 相关文章 |
| --- | --- | --- |
| RAG (Retrieval-Augmented Generation) / 检索增强生成 | 先从外部知识库检索相关内容，再结合检索结果生成答案。 | [RAG 全景](/guide/09-rag/overview) |
| Chunking / 切分 | 把文档切成适合检索的小块，块大小和边界影响检索效果。 | [文档解析与切分](/guide/09-rag/chunking) |
| Vector Database / 向量数据库 | 专门存储向量并支持高效相似度检索的数据库。 | [向量数据库](/guide/09-rag/vector-db) |
| ANN (Approximate Nearest Neighbor) / 近似最近邻 | 以少量精度损失换取速度的向量检索方法。 | [向量数据库](/guide/09-rag/vector-db) |
| HNSW | 基于分层图结构的 ANN 索引算法，查询快、召回高，应用广泛。 | [向量数据库](/guide/09-rag/vector-db) |
| BM25 | 经典的关键词检索打分算法，擅长精确词匹配。 | [混合检索与重排](/guide/09-rag/hybrid-rerank) |
| Hybrid Search / 混合检索 | 同时使用向量检索和关键词检索，再融合结果。 | [混合检索与重排](/guide/09-rag/hybrid-rerank) |
| RRF (Reciprocal Rank Fusion) / 倒数排名融合 | 根据各路检索结果的排名融合多路结果的方法，无需分数归一化。 | [混合检索与重排](/guide/09-rag/hybrid-rerank) |
| Rerank / 重排 | 用更精确的模型对初步检索的候选重新排序。 | [混合检索与重排](/guide/09-rag/hybrid-rerank) |
| Cross-Encoder / 交叉编码器 | 把查询和文档拼接后一起输入模型打分的结构，常用作重排模型。 | [混合检索与重排](/guide/09-rag/hybrid-rerank) |
| Query Rewriting / 查询改写 | 把用户的原始问题改写成更适合检索的查询。 | [混合检索与重排](/guide/09-rag/hybrid-rerank) |
| GraphRAG | 基于知识图谱和社区摘要进行检索增强的方法，擅长全局总结和多跳问题。 | [GraphRAG 与 Agentic RAG](/guide/09-rag/advanced-rag) |
| Agentic RAG | 把检索作为工具交给 Agent，由 Agent 决定是否检索、检索什么、检索几次。 | [GraphRAG 与 Agentic RAG](/guide/09-rag/advanced-rag) |
| Faithfulness / 忠实度 | 衡量答案是否都有检索资料支撑、没有编造的评估指标。 | [RAG 评估](/guide/09-rag/rag-eval) |
| Recall@K / 前 K 召回率 | 相关文档出现在检索结果前 K 个中的比例。 | [RAG 评估](/guide/09-rag/rag-eval) |

## 协议、框架与多 Agent

| 术语 | 解释 | 相关文章 |
| --- | --- | --- |
| MCP (Model Context Protocol) / 模型上下文协议 | 规定 AI 应用如何以统一方式连接外部工具和数据源的开放协议。 | [MCP 架构与核心概念](/guide/10-mcp/mcp-overview) |
| MCP Host / Client / Server | MCP 的三个角色：Host 是 AI 应用，Client 是其中维护单个连接的组件，Server 是暴露能力的服务。 | [MCP 架构与核心概念](/guide/10-mcp/mcp-overview) |
| Tools / Resources / Prompts | MCP Server 可暴露的三类能力：可调用的函数、可读取的数据、可复用的提示词模板。 | [开发一个 MCP Server](/guide/10-mcp/mcp-server) |
| stdio / 标准输入输出传输 | MCP 的本地传输方式，Host 启动 Server 进程并通过标准输入输出通信。 | [在应用中接入 MCP](/guide/10-mcp/mcp-client) |
| A2A (Agent2Agent) | 让不同 Agent 之间发现能力、委托任务和交换结果的协议。 | [A2A：Agent 之间的协议](/guide/10-mcp/a2a) |
| Agent Card | A2A 中描述一个 Agent 的身份、能力和访问方式的元数据文档。 | [A2A：Agent 之间的协议](/guide/10-mcp/a2a) |
| LangGraph | 以图（节点和边）建模 Agent 状态流转的编排框架，支持持久化和人在环路。 | [LangGraph](/guide/11-frameworks/langgraph) |
| Multi-Agent System / 多 Agent 系统 | 由多个分工协作的 Agent 共同完成任务的系统。 | [为什么需要多 Agent](/guide/12-multi-agent/why-multi-agent) |
| Orchestrator-Worker / 主从模式 | 由一个主 Agent 分解任务、分派给多个子 Agent 执行并汇总结果的编排模式。 | [编排模式](/guide/12-multi-agent/patterns) |
| Handoff / 交接 | 一个 Agent 把对话或任务控制权转交给另一个更合适的 Agent。 | [编排模式](/guide/12-multi-agent/patterns) |
| Coding Agent / 编程 Agent | 能阅读代码库、编写和修改代码、运行测试的 Agent。 | [Coding Agent 原理](/guide/13-coding-agent/coding-agents) |
| ACI (Agent-Computer Interface) / Agent-计算机接口 | 为 Agent 专门设计的操作界面，包括命令、反馈格式和防错机制。 | [SWE-agent](/papers/swe-agent) |
| Computer Use / 计算机操作 | 让模型通过截图、鼠标和键盘操作图形界面的能力。 | [Computer Use](/guide/13-coding-agent/computer-use) |
| Sandbox / 沙箱 | 隔离的执行环境，限制代码对宿主系统、网络和数据的访问。 | [沙箱与代码执行安全](/guide/13-coding-agent/sandbox) |

## 评估与生产化

| 术语 | 解释 | 相关文章 |
| --- | --- | --- |
| Eval / 评估 | 用一组用例和指标系统衡量 Agent 效果的过程，是迭代的基础。 | [为什么评估是第一优先级](/guide/14-evaluation/why-evals) |
| Golden Dataset / 黄金评估集 | 经过人工确认、带有期望结果的核心评估用例集合。 | [评估集与指标设计](/guide/14-evaluation/eval-design) |
| LLM-as-Judge / 模型评审 | 用大模型按评分标准评判另一个模型的输出。 | [LLM-as-Judge](/guide/14-evaluation/llm-judge) |
| Trace / 轨迹 | 一次请求从输入到输出的完整执行记录，包括每次模型调用和工具调用。 | [轨迹追踪与可观测性](/guide/14-evaluation/observability) |
| Span / 跨度 | 轨迹中的单个步骤，比如一次模型调用或一次工具执行。 | [轨迹追踪与可观测性](/guide/14-evaluation/observability) |
| Regression Testing / 回归测试 | 每次修改后重新运行评估集，确认原有能力没有退化。 | [回归测试与持续评估](/guide/14-evaluation/regression) |
| Prompt Injection / 提示词注入 | 通过构造输入或外部内容，让模型执行攻击者意图的攻击方式。 | [Prompt 注入与防护](/guide/15-production/prompt-injection) |
| Indirect Prompt Injection / 间接提示词注入 | 恶意指令藏在网页、文档、工具结果等外部内容中，被 Agent 读取后生效。 | [Prompt 注入与防护](/guide/15-production/prompt-injection) |
| Jailbreak / 越狱 | 诱导模型绕过安全限制、输出被禁止内容的攻击。 | [护栏与内容安全](/guide/15-production/guardrails) |
| HITL (Human-in-the-Loop) / 人在环路 | 在关键步骤引入人工审核或确认的设计。 | [权限控制与人在环路](/guide/15-production/permissions-hitl) |
| Least Privilege / 最小权限原则 | 只授予完成任务所必需的最小权限。 | [权限控制与人在环路](/guide/15-production/permissions-hitl) |
| Guardrails / 护栏 | 对输入、输出和行为进行检查和限制的机制，如内容审核、格式校验、敏感信息过滤。 | [护栏与内容安全](/guide/15-production/guardrails) |
| Model Routing / 模型路由 | 根据任务难度或类型把请求分配给不同模型，平衡效果与成本。 | [成本与延迟优化](/guide/15-production/cost-optimization) |
| Fallback / 降级 | 主模型或服务不可用时切换到备用方案。 | [部署、监控与运维](/guide/15-production/deployment) |

找不到的术语，可以在页面顶部搜索，或者查看 [知识体系](/guide/) 中的对应模块。

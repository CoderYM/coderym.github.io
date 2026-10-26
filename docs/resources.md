---
title: 学习资源
description: Agent 开发相关的官方文档、框架、课程、工具和社区，按用途分类整理。
---

# 学习资源

这里只收录官方或广泛使用的资源。大模型领域变化很快，具体的模型名称、价格和接口参数请以官方文档为准。

## 模型厂商官方文档

| 资源 | 说明 |
| --- | --- |
| [OpenAI Platform 文档](https://platform.openai.com/docs) | OpenAI API 参考、Tool Calling、结构化输出等指南 |
| [OpenAI Cookbook](https://cookbook.openai.com) | 大量可运行的示例代码 |
| [Anthropic 文档](https://docs.anthropic.com) | Claude API、Tool Use、Prompt Caching、扩展思考等指南 |
| [Anthropic Cookbook](https://github.com/anthropics/anthropic-cookbook) | Claude 的示例代码集合 |
| [Google AI for Developers](https://ai.google.dev) | Gemini API 文档 |
| [DeepSeek API 文档](https://api-docs.deepseek.com) | DeepSeek API，兼容 OpenAI 格式 |
| [Qwen（GitHub）](https://github.com/QwenLM) | 通义千问开源模型 |
| [智谱 AI 开放平台](https://open.bigmodel.cn) | GLM 系列模型 API |
| [Moonshot AI 开放平台](https://platform.moonshot.cn) | Kimi 系列模型 API |

## 协议

| 资源 | 说明 |
| --- | --- |
| [Model Context Protocol](https://modelcontextprotocol.io) | MCP 官方文档与规范 |
| [MCP GitHub 组织](https://github.com/modelcontextprotocol) | 各语言 SDK、官方示例 Server |
| [MCP Inspector](https://github.com/modelcontextprotocol/inspector) | 调试 MCP Server 的可视化工具 |
| [A2A 协议](https://github.com/a2aproject/A2A) | Agent2Agent 协议规范与示例 |

## 框架

### Python

| 资源 | 说明 |
| --- | --- |
| [LangGraph](https://github.com/langchain-ai/langgraph) | 基于图的 Agent 编排框架，支持持久化和人在环路 |
| [LangChain](https://github.com/langchain-ai/langchain) | 大模型应用开发框架，组件与集成丰富 |
| [LlamaIndex](https://github.com/run-llama/llama_index) | 专注数据接入与 RAG 的框架，官网 [llamaindex.ai](https://www.llamaindex.ai) |
| [OpenAI Agents SDK](https://github.com/openai/openai-agents-python) | OpenAI 官方的轻量 Agent 框架 |
| [CrewAI](https://github.com/crewAIInc/crewAI) | 基于角色分工的多 Agent 框架 |
| [AutoGen](https://github.com/microsoft/autogen) | 微软的多 Agent 对话框架 |
| [Pydantic](https://docs.pydantic.dev) | 数据校验库，结构化输出和工具参数的常用搭档 |
| [LiteLLM](https://github.com/BerriAI/litellm) | 用统一接口调用多家模型 API |

### Go

| 资源 | 说明 |
| --- | --- |
| [Eino](https://github.com/cloudwego/eino) | 字节跳动 CloudWeGo 开源的 Go 大模型应用框架 |
| [langchaingo](https://github.com/tmc/langchaingo) | LangChain 的 Go 语言实现 |

### Java

| 资源 | 说明 |
| --- | --- |
| [Spring AI](https://spring.io/projects/spring-ai) | Spring 官方的 AI 应用框架 |
| [LangChain4j](https://docs.langchain4j.dev) | Java 大模型应用框架，源码见 [GitHub](https://github.com/langchain4j/langchain4j) |

### 低代码平台

| 资源 | 说明 |
| --- | --- |
| [Dify](https://github.com/langgenius/dify) | 开源的大模型应用开发平台，可自部署 |
| [Coze 扣子](https://www.coze.cn) | 字节跳动的 Agent 搭建平台 |

## 课程与文章

| 资源 | 说明 |
| --- | --- |
| [Building Effective Agents](https://www.anthropic.com/research/building-effective-agents) | Anthropic 关于 Agent 与 Workflow 设计模式的经典文章 |
| [DeepLearning.AI 短课程](https://www.deeplearning.ai/short-courses/) | 与各厂商、框架合作的免费短课程，覆盖提示词、RAG、Agent |
| [Hugging Face Agents Course](https://huggingface.co/learn/agents-course) | 免费的 Agent 入门到实战课程 |
| [Hugging Face Learn](https://huggingface.co/learn) | Hugging Face 的全部免费课程 |
| [Anthropic Courses](https://github.com/anthropics/courses) | 提示词工程、Tool Use 等交互式教程 |
| [Prompt Engineering Guide](https://www.promptingguide.ai) | 提示词技术的综合指南，有中文版 |
| [Neural Networks: Zero to Hero](https://karpathy.ai/zero-to-hero.html) | Andrej Karpathy 从零实现神经网络和 GPT 的视频课程 |
| [Datawhale](https://github.com/datawhalechina) | 国内开源学习社区，有多个大模型与 Agent 中文教程 |

## 工具

### 向量数据库与检索

| 资源 | 说明 |
| --- | --- |
| [pgvector](https://github.com/pgvector/pgvector) | PostgreSQL 的向量扩展，已有 PostgreSQL 时的首选 |
| [Milvus](https://milvus.io) | 开源分布式向量数据库，适合大规模场景 |
| [Qdrant](https://qdrant.tech) | Rust 编写的开源向量数据库，过滤功能强 |
| [Weaviate](https://weaviate.io) | 开源向量数据库，内置混合检索 |
| [Chroma](https://www.trychroma.com) | 轻量的开源向量数据库，适合原型开发 |
| [FAISS](https://github.com/facebookresearch/faiss) | Meta 开源的向量相似度检索库 |
| [Elasticsearch](https://www.elastic.co/elasticsearch) | 全文检索引擎，支持 BM25 与向量的混合检索 |

### 评估与可观测性

| 资源 | 说明 |
| --- | --- |
| [Langfuse](https://langfuse.com) | 开源的大模型应用追踪、评估与提示词管理平台，可自部署 |
| [LangSmith](https://smith.langchain.com) | LangChain 官方的追踪与评估平台 |
| [Arize Phoenix](https://github.com/Arize-ai/phoenix) | 开源的大模型可观测性与评估工具 |
| [OpenTelemetry](https://opentelemetry.io) | 通用的可观测性标准，很多 Agent 追踪方案基于它 |
| [Ragas](https://github.com/explodinggradients/ragas) | RAG 与 Agent 评估指标库 |
| [promptfoo](https://github.com/promptfoo/promptfoo) | 提示词测试与红队评估工具，适合接入 CI |
| [SWE-bench](https://www.swebench.com) | 评估 Coding Agent 修复真实 Issue 能力的基准 |

### 本地模型与推理

| 资源 | 说明 |
| --- | --- |
| [Ollama](https://ollama.com) | 在本地一键运行开源模型 |
| [vLLM](https://github.com/vllm-project/vllm) | 高性能的大模型推理与服务引擎 |

## 社区与论文

| 资源 | 说明 |
| --- | --- |
| [Hugging Face](https://huggingface.co) | 模型、数据集和 Demo 社区 |
| [ModelScope 魔搭社区](https://modelscope.cn) | 国内的模型与数据集社区 |
| [arXiv cs.CL](https://arxiv.org/list/cs.CL/recent) | 自然语言处理方向的最新论文 |
| [r/LocalLLaMA](https://www.reddit.com/r/LocalLLaMA/) | 关注开源模型与本地部署的英文社区 |

本站精读过的经典论文见 [论文精读](/papers/)，术语对照见 [术语表](/glossary)。

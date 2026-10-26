---
title: 实战项目总览
description: 10 个由浅入深的 Agent 实战项目，从命令行聊天到企业知识助手，每个项目都给出 Python / Go / Java 代码。
---

# 实战项目总览

光看原理学不会 Agent 开发。这里的 10 个项目按难度递进，每个项目都对应教程里的若干模块：先读模块里的原理，再动手做项目，把知识点串成能跑的程序。

每个项目都包含需求说明、架构图、分步实现、运行与测试、扩展挑战。代码全部内联在页面里，复制即可运行。Python 是主语言；01-04 和 08 同时给出完整的 Go 与 Java 版本，其余项目给出核心部分的 Go / Java 实现。

::: tip 开始之前
所有项目统一使用 OpenAI 兼容的 Chat Completions API，通过环境变量切换厂商（OpenAI、DeepSeek、通义千问、Kimi 等）：

```bash
export OPENAI_API_KEY="你的 Key"
export OPENAI_BASE_URL="https://api.openai.com/v1"   # 可选，换成其他厂商的兼容地址
export LLM_MODEL="gpt-4o-mini"                        # 示例，按你的厂商填写
```

Key 只放在环境变量或 `.env` 中，不要写进代码，也不要提交到 Git。
:::

## 项目列表

| 项目 | 难度 | 预计时间 | 涉及模块 | 技能点 |
|------|------|---------|---------|-------|
| [01 命令行聊天助手](/projects/01-cli-chat) | ★ | 30 分钟 | [03 大模型 API](/guide/03-llm-api/first-call) | 第一次调用、多轮历史、流式输出 |
| [02 天气日程工具 Agent](/projects/02-tool-agent) | ★★ | 1～1.5 小时 | [05 Tool Calling](/guide/05-tool-calling/concept) | JSON Schema 描述工具、工具循环、错误回传 |
| [03 手写 ReAct Agent](/projects/03-react-agent) | ★★ | 1.5 小时 | [06 Agent 循环](/guide/06-agent-loop/react) | Thought / Action / Observation、步数上限、轨迹打印 |
| [04 个人 PDF 知识库](/projects/04-pdf-rag) | ★★★ | 2～3 小时 | [09 RAG 知识库](/guide/09-rag/overview)、[Embedding](/guide/02-llm-basics/embeddings) | PDF 解析、切分、向量检索、带引用回答 |
| [05 开发自己的 MCP Server](/projects/05-mcp-server) | ★★★ | 1.5～2 小时 | [10 MCP 与 A2A](/guide/10-mcp/mcp-server) | FastMCP、Tool 与 Resource、接入 Claude Desktop |
| [06 网页研究员 Agent](/projects/06-research-agent) | ★★★ | 2～3 小时 | [06 Agent 循环](/guide/06-agent-loop/plan-execute)、[07 上下文工程](/guide/07-context-engineering/compression)、[Prompt 注入](/guide/15-production/prompt-injection) | 可插拔搜索、礼貌抓取、防 SSRF、引用报告 |
| [07 多 Agent 写作团队](/projects/07-writing-team) | ★★★ | 2～3 小时 | [12 多 Agent 系统](/guide/12-multi-agent/patterns)、[LangGraph](/guide/11-frameworks/langgraph) | 角色拆分、结构化输出驱动分支、修订上限 |
| [08 代码审查 Agent](/projects/08-code-review) | ★★★ | 2～3 小时 | [13 Coding 与 Computer-Use](/guide/13-coding-agent/coding-agents)、[结构化输出](/guide/04-prompt/structured-output) | 安全调用 git、结构化审查结果、接入 CI |
| [09 全栈 Agent 工作台](/projects/09-agent-workbench) | ★★★★ | 4～6 小时 | [流式输出与 SSE](/guide/01-programming/streaming-sse)、[15 安全与生产化](/guide/15-production/serving) | FastAPI + SSE、Vue 3 聊天界面、鉴权与 CORS |
| [10 毕业项目：企业知识助手](/projects/10-enterprise-assistant) | ★★★★★ | 20～30 小时 | [08 记忆系统](/guide/08-memory/long-term)、[14 评估与可观测性](/guide/14-evaluation/observability)、[15 安全与生产化](/guide/15-production/guardrails) | RAG + 工具 + 记忆、评估、追踪、护栏、Docker 部署 |

## 推荐顺序

- 入门（01 → 02 → 03）：从第一次调用 API 到亲手写出 Agent 循环。01 只要 30 分钟，02 做完你就有了一个能调用工具的 Agent。
- 核心能力（04 → 05 → 06）：分别对应知识检索、工具生态和联网研究，三者之间相对独立，可以按兴趣调整顺序。
- 工程进阶（07 → 08 → 09）：多 Agent 协作、结构化输出接入工程流程，以及把 Agent 做成带界面的 Web 服务。
- 毕业（10）：把前面所有能力组合成一个可交付、可评估、可部署的系统。建议至少完成 02、04、09 后再开始。

如果你还没决定从哪里学起，可以先看 [学习路线](/roadmap/)，按自己的背景选一条路径，再回到这里挑项目。

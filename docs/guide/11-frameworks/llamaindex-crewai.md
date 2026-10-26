---
title: LlamaIndex、CrewAI 与 AutoGen
description: 三个各有侧重的 Python 框架：LlamaIndex 专注数据与检索，CrewAI 用角色分工组织多 Agent，AutoGen 探索多 Agent 对话。
---

# LlamaIndex、CrewAI 与 AutoGen

::: info 学习目标
- 用 LlamaIndex 十几行代码搭出可追溯来源的文档问答，并把它变成 Agent 的工具
- 理解 CrewAI 的 Agent、Task、Crew 三件套，写出一个两角色协作的小团队
- 了解 AutoGen 的设计思路与当前状态
- 知道三者各自适合什么场景，不适合什么场景
:::

::: tip 语言与版本
三个框架都是 Python 框架，本文只给出 Python 代码。示例基于 `llama-index` 0.12+ 与 `crewai` 0.x/1.x，版本变化较快，API 以官方文档为准。
:::

## 三者的定位

| 框架 | 核心抽象 | 最擅长 | 一句话 |
|------|---------|--------|--------|
| LlamaIndex | Document、Index、QueryEngine、Workflow | RAG、文档问答、数据接入 | 让 LLM 用上你的数据 |
| CrewAI | Agent（角色）、Task、Crew、Flow | 流程清晰的多角色协作 | 像组建团队一样组织 Agent |
| AutoGen | 会对话的 Agent、Team | 多 Agent 对话模式研究 | 让多个 Agent 通过对话解决问题 |

## LlamaIndex：以数据为中心

LlamaIndex 的出发点是"如何把私有数据接入 LLM"。它把 [RAG 全景](/guide/09-rag/overview) 里的每个环节都做成了可替换的组件：数据加载器（几百种数据源）、切分器、索引、检索器、重排器、响应合成器。

### 最小 RAG

```bash
pip install llama-index
# 默认使用 OpenAI 的对话模型和 Embedding 模型，读取 OPENAI_API_KEY
```

```python
from llama_index.core import Settings, SimpleDirectoryReader, VectorStoreIndex
from llama_index.core.node_parser import SentenceSplitter

# 切分参数：每块约 512 Token，相邻块重叠 50 Token
Settings.node_parser = SentenceSplitter(chunk_size=512, chunk_overlap=50)

# 1. 加载 ./data 目录下的文档（支持 txt、md、pdf 等）
documents = SimpleDirectoryReader("data").load_data()

# 2. 切分 + Embedding + 建索引（默认存在内存）
index = VectorStoreIndex.from_documents(documents)

# 3. 检索 top 3 片段，交给模型生成答案
query_engine = index.as_query_engine(similarity_top_k=3)
response = query_engine.query("公司的年假政策是怎样的？")

print(response)
for node in response.source_nodes:  # 可追溯：每个答案都能看到引用了哪些片段
    print(f"- {node.node.metadata.get('file_name')}  score={node.score:.3f}")
```

几行代码背后完成了加载、切分、向量化、检索和生成。切换到 DeepSeek、通义千问等兼容接口时，安装 `llama-index-llms-openai-like` 并把 `Settings.llm` 设为 `OpenAILike(...)`；Embedding 模型同理可以替换为其他厂商或本地模型。生产环境把内存索引换成向量数据库（见 [向量数据库](/guide/09-rag/vector-db)），LlamaIndex 对主流向量库都有集成。

### 把检索变成 Agent 的工具

```python
import asyncio

from llama_index.core.agent.workflow import FunctionAgent
from llama_index.core.tools import QueryEngineTool
from llama_index.llms.openai import OpenAI

hr_tool = QueryEngineTool.from_defaults(
    query_engine=query_engine,  # 上一段代码创建的 query_engine
    name="hr_policy",
    description="查询公司人事制度，包括请假、报销、考勤等政策",
)

agent = FunctionAgent(
    tools=[hr_tool],
    llm=OpenAI(model="gpt-4o-mini"),  # 示例模型名
    system_prompt="你是 HR 助手。回答制度问题必须先查询 hr_policy，并注明依据。",
)


async def main() -> None:
    result = await agent.run("我入职刚满一年，能休几天年假？")
    print(result)


asyncio.run(main())
```

这就是 [GraphRAG 与 Agentic RAG](/guide/09-rag/advanced-rag) 中说的 Agentic RAG 雏形：由 Agent 决定什么时候检索、检索哪个知识库。LlamaIndex 还提供了事件驱动的 Workflow 用于编排更复杂的流程。

适合：知识库问答、文档处理管道、需要接入大量异构数据源。不适合：与数据无关的复杂多 Agent 编排，这时 LangGraph 更合适，两者也可以组合使用（LlamaIndex 负责检索，LangGraph 负责编排）。

## CrewAI：按角色组建团队

CrewAI 的心智模型是"组建一个团队"：每个 Agent 有角色（role）、目标（goal）和背景（backstory），每个 Task 有描述和期望产出，Crew 把它们按顺序或层级组织起来执行。

```bash
pip install crewai
```

```python
import os

from crewai import LLM, Agent, Crew, Process, Task

# CrewAI 通过 LiteLLM 适配模型，"openai/" 前缀表示走 OpenAI 兼容协议
llm = LLM(
    model=f"openai/{os.environ['LLM_MODEL']}",
    base_url=os.getenv("OPENAI_BASE_URL") or None,
    api_key=os.environ["OPENAI_API_KEY"],
)

researcher = Agent(
    role="技术调研员",
    goal="就给定主题整理准确、有条理的要点",
    backstory="你是一名严谨的工程师，擅长把复杂技术讲清楚，不确定的内容会明确标注。",
    llm=llm,
)
writer = Agent(
    role="技术作者",
    goal="把调研要点写成面向初学者的短文",
    backstory="你写作风格简洁，善用类比，避免夸张。",
    llm=llm,
)

research_task = Task(
    description="调研主题：{topic}。列出 5 个核心要点，每点不超过 2 句话。",
    expected_output="5 条编号要点",
    agent=researcher,
)
write_task = Task(
    description="基于调研要点，写一篇 300 字左右的入门短文。",
    expected_output="一篇 Markdown 格式的短文",
    agent=writer,
    context=[research_task],  # 显式声明依赖上一个任务的输出
)

crew = Crew(
    agents=[researcher, writer],
    tasks=[research_task, write_task],
    process=Process.sequential,  # 顺序执行；另有 hierarchical（由管理者 Agent 分派）
    verbose=True,
)

if __name__ == "__main__":
    result = crew.kickoff(inputs={"topic": "MCP 协议"})
    print(result.raw)
```

Task 描述中的 `{topic}` 会被 `kickoff(inputs=...)` 替换。CrewAI 还提供 Flows，用事件和状态把多个 Crew 和普通代码串成更可控的流程，适合生产场景。

适合：调研、写作、分析报告这类"流程清楚、角色清楚"的任务，原型搭建非常快。需要注意：role / backstory 本质上是提示词，多 Agent 之间每一次交接都是额外的模型调用，成本和不确定性会叠加，参考 [多 Agent 的坑与成本控制](/guide/12-multi-agent/pitfalls)。

## AutoGen：多 Agent 对话

AutoGen 是微软研究院发起的项目，核心思想是"多个 Agent 通过对话协作"：比如一个写代码的 Agent 和一个执行代码、反馈结果的 Agent 来回对话，直到任务完成。它在 2025 年发布了重新设计的 0.4 架构（分为 Core、AgentChat、Extensions 等层），提供 RoundRobin、Selector 等多种团队对话模式。

当前状态需要了解两点：

- 微软之后推出了 **Microsoft Agent Framework**，作为 AutoGen 和 Semantic Kernel 的后继，AutoGen 本身转向维护为主；
- 早期 0.2 版本的社区分支以 **AG2** 名义独立发展。

因此本文不展开 AutoGen 的代码。如果你是要学习多 Agent 对话模式的思想，AutoGen 的论文和文档依然很有参考价值；如果要做新项目，建议先评估 Microsoft Agent Framework 或本模块的其他框架。

## 常见坑

- **LlamaIndex 默认调用 OpenAI**：没配置 `Settings.llm` 和 `Settings.embed_model` 时，会默认使用 OpenAI 模型，换厂商后忘记改 Embedding 是最常见的报错来源。
- **索引每次重建**：示例中每次运行都重新 Embedding 全部文档，既慢又费钱。用 `index.storage_context.persist()` 持久化或接入向量数据库。
- **CrewAI 角色写成"人设小说"**：backstory 越长不代表效果越好，关键还是任务描述和期望产出要具体。
- **多 Agent 任务难以调试**：先开 `verbose=True` 看清每个 Agent 的输入输出，再接入 [轨迹追踪与可观测性](/guide/14-evaluation/observability) 中的 Trace 工具。
- **跟着旧教程写 AutoGen**：0.2 与 0.4 的 API 完全不同，网上大量示例是旧版写法。

## 小测

1. 用 LlamaIndex 建好索引后切换到国内模型，问答报错"Embedding 鉴权失败"，最可能的原因是什么？

::: details 查看答案
只替换了 LLM，没有替换 Embedding 模型。LlamaIndex 的 Embedding 默认仍是 OpenAI，需要单独设置 `Settings.embed_model`。另外注意，更换 Embedding 模型后必须用新模型重建索引，不同模型生成的向量不能混用。
:::

2. CrewAI 的 `Process.sequential` 与 `Process.hierarchical` 有什么区别？

::: details 查看答案
sequential 按 tasks 列表顺序依次执行，上一个任务的输出可作为下一个的上下文；hierarchical 会引入一个管理者（manager）Agent 或模型，由它规划、分派任务给团队成员并审核结果，更灵活但调用次数和不确定性更高。
:::

3. 一个"上传合同 → 抽取关键条款 → 与模板比对 → 生成风险报告"的需求，你会如何组合使用这些框架？

::: details 查看答案
一种合理方案：用 LlamaIndex 负责文档解析、切分和条款检索；流程本身是固定的步骤，用普通代码或 LangGraph 串起来即可，不一定需要多角色 Agent。只有当"比对"和"写报告"需要明显不同的能力和提示词时，才考虑用 CrewAI 拆成多个角色。
:::

## 延伸阅读

- [LlamaIndex GitHub 仓库](https://github.com/run-llama/llama_index)
- [CrewAI GitHub 仓库](https://github.com/crewAIInc/crewAI)
- [AutoGen GitHub 仓库](https://github.com/microsoft/autogen)
- [Microsoft Agent Framework](https://github.com/microsoft/agent-framework)
- [AutoGen 论文](https://arxiv.org/abs/2308.08155)
- 相关：[RAG 全景](/guide/09-rag/overview)、[为什么需要多 Agent](/guide/12-multi-agent/why-multi-agent)

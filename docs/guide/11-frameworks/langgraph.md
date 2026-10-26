---
title: LangGraph
description: 用状态图构建可控的 Agent：State、Node、Edge 三要素，Checkpoint 持久化，以及用 interrupt 实现人在环路。
---

# LangGraph

::: info 学习目标
- 理解 LangGraph 的核心模型：State、Node、Edge 组成的状态图
- 用 LangGraph 从零搭一个 ReAct Agent，并与手写版本对照
- 掌握 Checkpoint：多轮记忆、断点恢复与 `thread_id`
- 用 `interrupt` 实现"危险操作前人工审批"
:::

::: tip 语言与版本
LangGraph 主要是 Python 框架（另有 JS/TS 版本），本文只给出 Python 代码。示例基于 `langgraph` 1.x 与 `langchain-openai`，框架迭代较快，API 以 [官方仓库与文档](https://github.com/langchain-ai/langgraph) 为准。
:::

## 为什么是"图"

回顾 [不用框架手写 Agent](/guide/06-agent-loop/handwritten-agent)，Agent 循环可以画成这样：

```text
        ┌───────────────────────────┐
        ▼                           │
 START ──▶ [调用模型] ──有 tool_calls──▶ [执行工具]
              │
              └──没有 tool_calls──▶ END
```

这本身就是一张图：节点是"调用模型""执行工具"，边是"根据条件走向哪里"。LangGraph 把这件事显式化：你定义状态、节点和边，框架负责运行、持久化和恢复。好处是流程可以任意扩展，比如加一个"审核"节点、加一个并行分支、加一个"超过 5 步就总结"的出口，同时每一步的状态都被记录下来。

LangGraph 由 LangChain 团队开发，但可以独立于 LangChain 的其他组件使用。LangChain v1 中的 `create_agent` 底层就是基于 LangGraph 构建的。

## 三个核心概念

| 概念 | 含义 | 代码中的形式 |
|------|------|-------------|
| State | 整张图共享的数据，每个节点读取它并返回更新 | `TypedDict` 或 pydantic 模型 |
| Node | 一个处理步骤 | 普通函数：输入 state，返回要更新的字段 |
| Edge | 节点之间的流转 | `add_edge` 固定边；`add_conditional_edges` 条件边 |

State 中的字段可以指定 **reducer**，决定节点返回的值如何合并进状态。最常见的是消息列表：`Annotated[list, add_messages]` 表示"追加"而不是"覆盖"。如果不指定 reducer，节点返回的值会直接覆盖旧值。

## 动手：用 LangGraph 搭 ReAct Agent

```bash
pip install langgraph langchain-openai
# 环境变量：OPENAI_API_KEY、OPENAI_BASE_URL（可选）、LLM_MODEL
```

```python
import os
from typing import Annotated

from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode, tools_condition
from typing_extensions import TypedDict


@tool
def get_weather(city: str) -> str:
    """查询指定城市的当前天气。city 为中文城市名，如"北京"。"""
    fake = {"北京": "晴，25°C", "杭州": "小雨，18°C"}
    return fake.get(city, f"暂无 {city} 的天气数据")


tools = [get_weather]

# ChatOpenAI 会自动读取 OPENAI_API_KEY；base_url 用于切换到其他兼容厂商
llm = ChatOpenAI(
    model=os.environ["LLM_MODEL"],
    base_url=os.getenv("OPENAI_BASE_URL") or None,
    timeout=60,
)
llm_with_tools = llm.bind_tools(tools)


class State(TypedDict):
    messages: Annotated[list, add_messages]  # 追加语义


def chatbot(state: State) -> dict:
    """调用模型，返回的 AIMessage 追加到 messages。"""
    return {"messages": [llm_with_tools.invoke(state["messages"])]}


builder = StateGraph(State)
builder.add_node("chatbot", chatbot)
builder.add_node("tools", ToolNode(tools))  # 预置节点：执行 tool_calls 并生成 ToolMessage
builder.add_edge(START, "chatbot")
# tools_condition：最后一条消息有 tool_calls 则去 "tools"，否则去 END
builder.add_conditional_edges("chatbot", tools_condition)
builder.add_edge("tools", "chatbot")

graph = builder.compile(checkpointer=InMemorySaver())

if __name__ == "__main__":
    # thread_id 标识一个会话；recursion_limit 限制最多执行多少步，防止死循环
    config = {"configurable": {"thread_id": "user-1"}, "recursion_limit": 10}

    out = graph.invoke({"messages": [{"role": "user", "content": "北京今天天气怎么样？"}]}, config)
    print(out["messages"][-1].content)

    # 同一个 thread_id，自动带上之前的对话历史
    out = graph.invoke({"messages": [{"role": "user", "content": "那杭州呢？"}]}, config)
    print(out["messages"][-1].content)
```

对照手写版本：

| 手写 Agent | LangGraph |
|-----------|-----------|
| `while` 循环 + `if tool_calls` | `add_conditional_edges` + `tools_condition` |
| 自己维护 `messages` 列表 | State + `add_messages` reducer |
| 自己写工具分发与错误处理 | `ToolNode`（默认会把工具异常作为错误消息返回给模型） |
| `MAX_STEPS` 计数 | `recursion_limit` |
| 自己存数据库实现多轮会话 | `checkpointer` + `thread_id` |

想看每一步发生了什么，可以用 `graph.stream(inputs, config, stream_mode="updates")` 逐个节点地输出状态更新，这对调试很有帮助。

## Checkpoint：持久化与恢复

编译时传入的 `checkpointer` 会在**每个节点执行完后**保存一次状态快照，用 `thread_id` 区分不同会话。这带来三个能力：

1. **多轮记忆**：同一个 `thread_id` 再次调用时，自动接着之前的状态继续。
2. **故障恢复**：进程崩溃后，用同一个 `thread_id` 可以从最后一个快照继续，而不是从头再跑。
3. **时间旅行**：可以查看历史快照（`graph.get_state_history(config)`），甚至从某个历史点分叉重跑。

`InMemorySaver` 只存在内存里，仅用于开发。生产环境使用 `langgraph-checkpoint-postgres`、`langgraph-checkpoint-sqlite` 等持久化实现。

## 人在环路：interrupt

真正让 LangGraph 区别于轻量框架的，是可以在任意位置**暂停图的执行**，等待外部输入后再恢复。典型用法是危险操作前请人审批：

```python
from langgraph.types import Command, interrupt


@tool
def send_email(to: str, subject: str, body: str) -> str:
    """发送邮件。发送前会请求用户确认。"""
    decision = interrupt({"action": "send_email", "to": to, "subject": subject})
    if decision != "approve":
        return "用户拒绝发送这封邮件"
    # ... 真正调用邮件服务 ...
    return f"已发送给 {to}"

# 把 send_email 加入 tools 并重新构建图后：
# 第一次调用会在 interrupt 处暂停，返回值中包含 "__interrupt__" 字段，内容是上面传入的字典
# out = graph.invoke({"messages": [...]}, config)
# print(out["__interrupt__"])

# 前端展示给用户确认后，用 Command(resume=...) 恢复执行，resume 的值就是 interrupt() 的返回值
# out = graph.invoke(Command(resume="approve"), config)
```

`interrupt` 依赖 checkpointer：暂停时状态已被保存，所以审批可以在几分钟甚至几天后进行，期间服务重启也不影响（前提是用了持久化 checkpointer）。需要注意，恢复时**包含 interrupt 的那个节点会从头重新执行**，所以 interrupt 之前不要放有副作用的代码。

这和 [权限控制与人在环路](/guide/15-production/permissions-hitl) 中讲的审批模式正好对应。

## 预置 Agent：少写样板代码

上面手动搭图是为了理解原理。日常开发中，简单的 ReAct Agent 可以直接用预置函数一行创建。LangChain v1 推荐用 `langchain.agents.create_agent`（早期版本的 `langgraph.prebuilt.create_react_agent` 正在被它取代），返回的同样是一张编译好的 LangGraph 图，checkpointer、stream、interrupt 用法完全一样：

```python
# pip install langchain langchain-openai
from langchain.agents import create_agent

agent = create_agent(
    model=llm,                # 上文的 ChatOpenAI 实例
    tools=tools,
    system_prompt="你是一个天气助手，回答简洁。",
    checkpointer=InMemorySaver(),
)
```

经验法则：**流程就是标准的"模型 + 工具循环"时用预置 Agent；需要自定义节点、分支、并行或多 Agent 编排时再手动搭图**。

## 适合与不适合

适合 LangGraph 的场景：

- 流程有明确的阶段和分支，例如"检索 → 判断相关性 → 不相关则改写查询重试 → 生成"（参考 [GraphRAG 与 Agentic RAG](/guide/09-rag/advanced-rag)）；
- 需要人工审批、长时间运行、断点恢复；
- 多 Agent 编排，如主管 Agent 分派任务给多个子 Agent（参考 [编排模式](/guide/12-multi-agent/patterns)）。

不太适合的场景：

- 一次性的简单问答或单工具调用，用模型 SDK 直接写更直观；
- 团队不熟悉 Python，又没有复杂编排需求。

## 常见坑

- **State 字段忘记写 reducer**：`messages: list` 没有 `add_messages`，每个节点返回的消息会覆盖整个历史，表现为"模型失忆"。
- **recursion_limit 报错**：`GraphRecursionError` 通常意味着模型在工具之间来回打转。不要只是调大上限，先检查工具返回是否让模型无法判断任务已完成。
- **interrupt 前有副作用**：恢复时节点会重新执行，interrupt 之前的写库、发请求会执行两次。把副作用放到 interrupt 之后，或拆成单独节点。
- **生产环境用 InMemorySaver**：重启即丢失全部会话和待审批任务，多实例部署时还会出现状态不一致。
- **thread_id 设计不当**：所有用户共用一个 `thread_id` 会导致对话串台；按"用户 + 会话"生成唯一 ID。
- **照抄旧版教程**：0.x 时代的部分导入路径和预置函数已调整，遇到导入错误先核对你安装的版本。

## 小测

1. 如果 `State` 定义为 `messages: list`（没有 reducer），上面的 ReAct 图会出现什么问题？

::: details 查看答案
每个节点返回的 `{"messages": [...]}` 会直接覆盖原列表。`chatbot` 节点返回 AIMessage 后，用户消息就丢失了；`tools` 节点返回 ToolMessage 后，包含 tool_calls 的 AIMessage 也丢失了，模型 API 会因为消息序列不合法而报错，或者模型失去上下文。
:::

2. 为什么 `interrupt` 必须配合 checkpointer 使用？

::: details 查看答案
暂停意味着当前进程的调用会返回，图的执行状态必须保存在某处，才能在之后（可能是另一个请求、另一个进程）用同一个 `thread_id` 和 `Command(resume=...)` 恢复。checkpointer 就是保存这个状态的地方。
:::

3. 什么时候用 `create_agent`，什么时候手动用 `StateGraph` 搭图？

::: details 查看答案
标准的"模型调用工具直到完成"循环用 `create_agent`，代码最少。需要自定义步骤（如检索后打分、条件重试）、并行分支、多个 Agent 协作或特殊的状态结构时，手动用 `StateGraph` 搭图。
:::

## 延伸阅读

- [LangGraph GitHub 仓库](https://github.com/langchain-ai/langgraph)
- [LangChain GitHub 仓库](https://github.com/langchain-ai/langchain)
- 相关：[ReAct：推理与行动](/guide/06-agent-loop/react)、[短期记忆与会话管理](/guide/08-memory/short-term)、[编排模式：主从、流水线、交接、辩论](/guide/12-multi-agent/patterns)
- 下一篇：[Claude Agent SDK 与 OpenAI Agents SDK](/guide/11-frameworks/agent-sdks)

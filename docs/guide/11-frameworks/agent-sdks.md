---
title: Claude Agent SDK 与 OpenAI Agents SDK
description: 两个模型厂商官方出品的 Agent SDK：OpenAI Agents SDK 主打轻量的 Agent、工具与交接，Claude Agent SDK 把 Claude Code 的运行时变成可编程的库。
---

# Claude Agent SDK 与 OpenAI Agents SDK

::: info 学习目标
- 理解"厂商官方 Agent SDK"与 LangGraph 等通用框架的定位差异
- 用 OpenAI Agents SDK 写出带工具和交接（handoff）的多 Agent 程序，并接入非 OpenAI 模型
- 用 Claude Agent SDK 驱动一个能读写文件、带自定义工具的 Agent
- 根据任务类型在两者之间做选择
:::

::: tip 语言与版本
两个 SDK 都提供 Python 和 TypeScript 版本，没有官方 Go / Java 版本，本文只给出 Python 代码。示例基于 `openai-agents` 0.x 与 `claude-agent-sdk` 0.x，两者都处于快速迭代期，API 以官方文档为准。
:::

## 两个 SDK 的定位

| 维度 | OpenAI Agents SDK | Claude Agent SDK |
|------|-------------------|------------------|
| 包名 | `openai-agents`（导入名 `agents`） | `claude-agent-sdk`（导入名 `claude_agent_sdk`） |
| 核心思路 | 极少的原语：Agent、Tool、Handoff、Guardrail、Session | Claude Code 的 Agent 运行时：内置工具、权限、上下文管理 |
| 内置工具 | 无本地工具，提供托管工具（网页搜索、文件检索等，依赖 OpenAI 平台） | 读写文件、编辑、执行 Bash、搜索代码、网页抓取等 |
| 模型 | 默认 OpenAI，可通过 Chat Completions 兼容接口或 LiteLLM 接入其他模型 | Claude（Anthropic API，也支持 Bedrock、Vertex AI） |
| 擅长 | 对话类、客服类、多 Agent 分工 | 编码、运维、文档处理等需要操作文件系统和命令行的任务 |
| 运行方式 | 纯 Python 库 | 底层驱动 Claude Code CLI 进程 |

一句话总结：**OpenAI Agents SDK 是一个轻量的通用 Agent 框架；Claude Agent SDK 是一个"开箱即带手脚"的 Agent**。

## OpenAI Agents SDK

### 基本用法

```bash
pip install openai-agents
```

```python
import os

from agents import Agent, Runner, function_tool


@function_tool
def get_weather(city: str) -> str:
    """查询城市天气。

    Args:
        city: 中文城市名，如"北京"
    """
    fake = {"北京": "晴，25°C", "杭州": "小雨，18°C"}
    return fake.get(city, f"暂无 {city} 的天气数据")


agent = Agent(
    name="天气助手",
    instructions="你是天气助手，回答简洁。需要天气数据时调用工具。",
    tools=[get_weather],
    model=os.getenv("LLM_MODEL", "gpt-4o-mini"),
)

if __name__ == "__main__":
    result = Runner.run_sync(agent, "北京和杭州今天天气怎么样？", max_turns=6)
    print(result.final_output)
```

`@function_tool` 根据函数签名和 docstring 自动生成工具 Schema；`Runner.run_sync` 内部就是我们熟悉的 Agent 循环，`max_turns` 限制最大轮数。异步场景用 `await Runner.run(...)`，流式用 `Runner.run_streamed(...)`。

### 交接（Handoff）

Handoff 是这个 SDK 最有特色的概念：一个 Agent 可以把对话**整体移交**给另一个 Agent，由后者接着回答。框架会把每个可交接的目标包装成一个特殊工具（如 `transfer_to_refund_agent`），模型调用它就完成移交。

```python
from agents import Agent, Runner

refund_agent = Agent(
    name="refund_agent",  # 名字会进入工具名，用英文标识符
    handoff_description="处理退款、退货相关问题",
    instructions="你负责处理退款。先确认订单号，再说明退款流程。",
)
tech_agent = Agent(
    name="tech_support",
    handoff_description="处理产品使用、故障排查问题",
    instructions="你负责技术支持，给出具体的排查步骤。",
)
triage_agent = Agent(
    name="triage",
    instructions="判断用户问题类型，交给合适的专员处理。",
    handoffs=[refund_agent, tech_agent],
)

result = Runner.run_sync(triage_agent, "我上周买的耳机想退货")
print(result.last_agent.name, "：", result.final_output)
```

这对应 [编排模式](/guide/12-multi-agent/patterns) 中的"交接"模式。另一种组合方式是 `agent.as_tool(...)`，把子 Agent 当工具调用，主 Agent 保留控制权并汇总结果，对应"主从"模式。

### 接入 DeepSeek、通义千问等兼容模型

SDK 默认使用 OpenAI 的 Responses API，并默认把 Trace 上报到 OpenAI 平台。接入其他厂商时需要做三件事：切换到 Chat Completions 接口、指定客户端、关闭或替换 Trace。

```python
import os

from agents import (
    Agent,
    Runner,
    set_default_openai_api,
    set_default_openai_client,
    set_tracing_disabled,
)
from openai import AsyncOpenAI

client = AsyncOpenAI(
    api_key=os.environ["OPENAI_API_KEY"],
    base_url=os.getenv("OPENAI_BASE_URL") or None,
    timeout=60,
)
set_default_openai_client(client)
set_default_openai_api("chat_completions")  # 大多数兼容厂商不支持 Responses API
set_tracing_disabled(True)                  # 非 OpenAI 的 Key 无法上报到 OpenAI Trace

agent = Agent(name="助手", instructions="用中文简洁回答。", model=os.environ["LLM_MODEL"])
print(Runner.run_sync(agent, "用一句话解释什么是 Agent").final_output)
```

此外，SDK 还提供了 Guardrails（输入/输出护栏，可与主 Agent 并行运行）、Sessions（自动管理多轮历史）、MCP 支持（把 MCP Server 的工具挂到 Agent 上）等能力，按需查阅文档。

## Claude Agent SDK

### 它是什么

Claude Agent SDK（前身是 Claude Code SDK）把 Claude Code 背后的 Agent 运行时开放成库：上下文管理、工具执行、权限控制、子 Agent、MCP 支持都已内置。你不需要自己实现"读文件""改代码""跑命令"这些工具，只需要描述任务、限定权限。

```bash
pip install claude-agent-sdk
# 需要 ANTHROPIC_API_KEY 环境变量（也支持通过 Bedrock、Vertex AI 访问）
# SDK 会驱动 Claude Code CLI，若安装包未自带 CLI，按官方文档额外安装
```

### 基本用法：一个能读代码的 Agent

```python
import asyncio

from claude_agent_sdk import AssistantMessage, ClaudeAgentOptions, ResultMessage, TextBlock, query


async def main() -> None:
    options = ClaudeAgentOptions(
        system_prompt="你是代码审查助手，只读代码，不做任何修改。",
        allowed_tools=["Read", "Grep", "Glob"],  # 白名单：只允许只读工具
        cwd="/path/to/your/project",            # 限定工作目录
        max_turns=10,
    )
    async for message in query(prompt="找出这个项目里所有未处理异常的 HTTP 调用", options=options):
        if isinstance(message, AssistantMessage):
            for block in message.content:
                if isinstance(block, TextBlock):
                    print(block.text)
        elif isinstance(message, ResultMessage):
            print("完成，耗费轮数：", message.num_turns)


asyncio.run(main())
```

`query()` 返回一个异步迭代器，Agent 的每条消息（文本、工具调用、工具结果、最终结果）都会流式产出。需要多轮交互时可以用 `ClaudeSDKClient`，它维持一个会话，可以连续发送多条消息。

### 自定义工具

自定义工具以"进程内 MCP Server"的形式注册，工具名按 `mcp__<server>__<tool>` 的规则引用：

```python
import asyncio
from typing import Any

from claude_agent_sdk import ClaudeAgentOptions, create_sdk_mcp_server, query, tool


@tool("get_ticket", "根据工单号查询工单详情", {"ticket_id": str})
async def get_ticket(args: dict[str, Any]) -> dict[str, Any]:
    ticket_id = str(args["ticket_id"]).strip()
    if not ticket_id.isalnum():
        return {"content": [{"type": "text", "text": "工单号格式不正确"}], "is_error": True}
    # ... 真实场景这里查询工单系统 ...
    return {"content": [{"type": "text", "text": f"工单 {ticket_id}：登录页 500 错误，优先级 P1"}]}


server = create_sdk_mcp_server(name="tickets", version="1.0.0", tools=[get_ticket])


async def main() -> None:
    options = ClaudeAgentOptions(
        mcp_servers={"tickets": server},
        allowed_tools=["mcp__tickets__get_ticket", "Read", "Grep"],
        max_turns=10,
    )
    async for message in query(prompt="查看工单 T1024，并在代码中定位可能的原因", options=options):
        print(message)


asyncio.run(main())
```

外部的 MCP Server（stdio 或 HTTP）同样可以通过 `mcp_servers` 配置接入，写法与 [在应用中接入 MCP](/guide/10-mcp/mcp-client) 中的配置结构类似。

### 权限是第一要务

Claude Agent SDK 的 Agent 能真正执行命令、修改文件，权限配置不是可选项：

- `allowed_tools` 显式列出允许的工具，只读任务就不要给 `Write`、`Edit`、`Bash`；
- `permission_mode` 控制编辑和执行是否需要确认，生产环境不要随意使用跳过权限检查的模式；
- `cwd` 限定工作目录，并在容器或沙箱中运行，参考 [沙箱与代码执行安全](/guide/13-coding-agent/sandbox)；
- 可以通过 Hooks 在工具执行前后插入自己的检查逻辑（例如拦截 `rm -rf`）。

## 如何选择

| 场景 | 推荐 |
|------|------|
| 客服、问答、业务流程类 Agent，工具都是你自己的 API | OpenAI Agents SDK |
| 想用国内模型或多家模型 | OpenAI Agents SDK（Chat Completions 兼容模式） |
| 代码审查、自动修 Bug、批量改文档、运维排障 | Claude Agent SDK |
| 需要复杂的图编排、持久化审批流 | 考虑 [LangGraph](/guide/11-frameworks/langgraph) |

也可以组合使用：外层用 LangGraph 或 OpenAI Agents SDK 编排，把"修改代码"这一步交给 Claude Agent SDK 执行。

## 常见坑

- **Agent 名字用中文导致报错**：OpenAI Agents SDK 会用 Agent 名字生成 handoff 工具名，而函数名只允许字母、数字、下划线和短横线。
- **兼容厂商报 404 或参数错误**：忘了 `set_default_openai_api("chat_completions")`，SDK 仍在调用 Responses API。
- **Trace 上报报错**：使用非 OpenAI Key 时没有关闭 Trace 或配置其他 Trace 处理器。
- **Claude Agent SDK 权限过大**：图省事给了全部工具，Agent 可能执行意料之外的命令。从最小工具集开始逐步放开。
- **把 SDK 当普通 API 调用**：Claude Agent SDK 每次 `query` 都可能多轮调用模型、执行大量工具，成本和时长都远高于一次 API 调用，务必设置 `max_turns` 并监控用量。

## 小测

1. OpenAI Agents SDK 中 handoff 和 `as_tool` 有什么区别？

::: details 查看答案
handoff 是把对话控制权整体交给另一个 Agent，之后由它直接回复用户；`as_tool` 是把子 Agent 当作一个工具调用，子 Agent 完成后把结果返回给主 Agent，主 Agent 保留控制权并决定最终回复。
:::

2. 用 OpenAI Agents SDK 接入一个只提供 Chat Completions 兼容接口的国内模型，至少需要做哪些配置？

::: details 查看答案
创建指向该厂商 base URL 的 `AsyncOpenAI` 客户端并通过 `set_default_openai_client` 设置；调用 `set_default_openai_api("chat_completions")`；关闭 Trace（`set_tracing_disabled(True)`）或配置自己的 Trace 处理器；并在 Agent 中指定该厂商的模型名。
:::

3. 一个只需要"阅读代码并生成报告"的 Claude Agent SDK 任务，`allowed_tools` 应该怎么配？

::: details 查看答案
只给只读工具，例如 `Read`、`Grep`、`Glob`，不给 `Write`、`Edit`、`Bash`。同时设置 `cwd` 到目标项目目录并限制 `max_turns`。
:::

## 延伸阅读

- [OpenAI Agents SDK（Python）](https://github.com/openai/openai-agents-python)
- [Claude Agent SDK（Python）](https://github.com/anthropics/claude-agent-sdk-python)
- [Claude Agent SDK 文档](https://docs.claude.com/en/api/agent-sdk/overview)
- 相关：[Coding Agent 原理](/guide/13-coding-agent/coding-agents)、[编排模式：主从、流水线、交接、辩论](/guide/12-multi-agent/patterns)

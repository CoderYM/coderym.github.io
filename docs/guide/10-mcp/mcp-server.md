---
title: 开发一个 MCP Server
description: 用官方 SDK 写一个带工具、资源和提示词的 MCP Server，并在 Claude Desktop 和 MCP Inspector 中调试运行。
---

# 开发一个 MCP Server

::: info 学习目标
- 用 Python 官方 SDK 的 FastMCP 写出一个可运行的 MCP Server
- 掌握 Tool、Resource、Prompt 三种能力的声明方式
- 学会用 MCP Inspector 调试，并注册到 Claude Desktop
- 了解 Go / Java 官方 SDK 的写法和工具设计中的安全要点
:::

## 我们要做什么

做一个"笔记助手" MCP Server，提供：

- 工具 `search_notes`：在本地笔记目录里按关键词搜索
- 工具 `read_note`：读取某篇笔记全文
- 资源 `notes://index`：列出所有笔记文件名
- 提示词 `summarize_note`：生成"总结这篇笔记"的模板

笔记目录通过环境变量 `NOTES_DIR` 指定，Server 只能访问这个目录，这是最小权限原则的第一步。

## Python：FastMCP

官方 Python SDK 的包名是 `mcp`，其中的 `FastMCP` 用装饰器的方式声明能力，函数签名和类型注解会被自动转换成 JSON Schema，docstring 会成为工具描述。

```bash
# 推荐用 uv 管理，也可以用 pip
uv init notes-mcp && cd notes-mcp
uv add "mcp[cli]"
# 或：pip install "mcp[cli]"
```

本文基于 `mcp` 1.x 版本，API 以 [官方文档](https://github.com/modelcontextprotocol/python-sdk) 为准。

```python
"""笔记助手 MCP Server：只读访问 NOTES_DIR 下的 .md / .txt 文件。"""
import os
import sys
from pathlib import Path

from mcp.server.fastmcp import FastMCP

NOTES_DIR = Path(os.environ.get("NOTES_DIR", "~/notes")).expanduser().resolve()
ALLOWED_SUFFIXES = {".md", ".txt"}
MAX_CHARS = 20_000  # 单次返回的最大字符数，防止撑爆上下文

mcp = FastMCP("notes")


def _safe_path(name: str) -> Path:
    """把用户/模型给的文件名解析到 NOTES_DIR 内，拒绝路径穿越。"""
    p = (NOTES_DIR / name).resolve()
    if not p.is_relative_to(NOTES_DIR):
        raise ValueError("只能访问笔记目录内的文件")
    if p.suffix not in ALLOWED_SUFFIXES:
        raise ValueError("只支持 .md 和 .txt 文件")
    return p


def _all_notes() -> list[Path]:
    return sorted(
        p for p in NOTES_DIR.rglob("*")
        if p.is_file() and p.suffix in ALLOWED_SUFFIXES
    )


@mcp.tool()
def search_notes(keyword: str, limit: int = 5) -> str:
    """在笔记中搜索包含关键词的文件，返回文件名和匹配行。

    Args:
        keyword: 要搜索的关键词，不区分大小写
        limit: 最多返回几个文件，1~20
    """
    keyword = keyword.strip()
    if not keyword:
        raise ValueError("keyword 不能为空")
    limit = max(1, min(limit, 20))

    results = []
    for path in _all_notes():
        text = path.read_text(encoding="utf-8", errors="ignore")
        hits = [ln.strip() for ln in text.splitlines() if keyword.lower() in ln.lower()]
        if hits:
            rel = path.relative_to(NOTES_DIR)
            results.append(f"## {rel}\n" + "\n".join(hits[:3]))
        if len(results) >= limit:
            break
    return "\n\n".join(results) if results else f"没有找到包含「{keyword}」的笔记"


@mcp.tool()
def read_note(name: str) -> str:
    """读取一篇笔记的全文。name 是 search_notes 返回的相对路径。"""
    path = _safe_path(name)
    if not path.exists():
        raise ValueError(f"笔记不存在：{name}")
    text = path.read_text(encoding="utf-8", errors="ignore")
    if len(text) > MAX_CHARS:
        text = text[:MAX_CHARS] + "\n\n[内容过长，已截断]"
    return text


@mcp.resource("notes://index")
def notes_index() -> str:
    """所有笔记的文件列表。"""
    return "\n".join(str(p.relative_to(NOTES_DIR)) for p in _all_notes())


@mcp.prompt()
def summarize_note(name: str) -> str:
    """生成"总结某篇笔记"的提示词。"""
    return f"请先调用 read_note 读取笔记「{name}」，然后用 5 条要点总结它，最后列出待办事项。"


if __name__ == "__main__":
    # 日志只能写 stderr，stdout 是 stdio 传输的协议通道
    print(f"notes server, NOTES_DIR={NOTES_DIR}", file=sys.stderr)
    mcp.run()  # 默认 stdio 传输
```

几个要点：

- **工具里抛异常**：FastMCP 会把异常转换成 `isError: true` 的工具结果，错误信息会被模型看到。所以异常信息要写成模型能理解、能据此调整的句子。
- **类型注解就是 Schema**：`keyword: str, limit: int = 5` 会生成 `keyword` 必填、`limit` 可选的 JSON Schema。也可以用 pydantic 模型作为参数类型来表达更复杂的结构。
- **返回值**：返回字符串会成为一个 `text` content。也可以返回 dict 或 pydantic 模型，新版 SDK 会同时生成结构化输出。

## 调试：MCP Inspector

不要一上来就接 Claude Desktop 调试，出错时很难看到原因。官方提供了一个网页调试工具 Inspector：

```bash
# 方式一：通过 mcp CLI（需要安装 mcp[cli]）
NOTES_DIR=~/notes uv run mcp dev server.py

# 方式二：直接用 npx 启动 Inspector，后面跟启动 Server 的命令
npx @modelcontextprotocol/inspector uv run server.py
```

打开浏览器中显示的地址，可以看到工具列表、手动填参数调用、查看原始 JSON-RPC 消息。建议每个工具都在这里先手工调用一遍，确认 Schema 和返回符合预期。

## 注册到 Claude Desktop

Claude Desktop 通过配置文件 `claude_desktop_config.json` 管理 MCP Server。在设置里的"开发者"页面可以直接打开它，文件位置通常是：

- macOS：`~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows：`%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "notes": {
      "command": "uv",
      "args": ["--directory", "/ABSOLUTE/PATH/TO/notes-mcp", "run", "server.py"],
      "env": {
        "NOTES_DIR": "/Users/you/notes"
      }
    }
  }
}
```

- `mcpServers` 下每个 key 是一个 Server 的名字，`command` + `args` 就是 Host 启动子进程的命令。
- **路径一律写绝对路径**。Claude Desktop 启动子进程时的工作目录和 PATH 与你的终端不同，`uv` 找不到时把它换成 `which uv` 的绝对路径。
- 密钥类配置放 `env`，不要写进代码。也要注意这个配置文件本身包含明文密钥，不要提交到仓库。

保存后完全退出并重启 Claude Desktop，对话框中就能看到 `notes` 的工具。出问题时查看日志目录（macOS 为 `~/Library/Logs/Claude/`）中的 `mcp*.log`。

Claude Code、Cursor、VS Code 等其他 Host 的配置格式大同小异，基本都是"名字 + 启动命令 + 环境变量"，参照各自文档即可。

## 切换到 Streamable HTTP

同一份代码改一行就能作为远程服务运行：

```python
if __name__ == "__main__":
    mcp.run(transport="streamable-http")  # 默认监听 127.0.0.1:8000，端点 /mcp
```

远程部署时要注意：stdio 模式下"能启动进程的人就是可信用户"，HTTP 模式下任何能访问端口的人都能调用你的工具。上线前必须加鉴权（规范推荐 OAuth 2.1，内网也至少要有 Token 校验）、只监听需要的网卡，并限制请求速率。

## 三语言最小示例

下面用同一个 `add` 工具对照三种语言的官方生态写法。Go 使用官方 [go-sdk](https://github.com/modelcontextprotocol/go-sdk)（v1.x）；Java 的底层是官方 [java-sdk](https://github.com/modelcontextprotocol/java-sdk)，但它的低层 API 在 1.0 前后改动较多，这里展示更稳定、更常用的 Spring AI MCP Server Starter 写法（Spring AI 1.0.x）。API 以官方文档为准。

::: code-group
```python [Python]
# pip install "mcp[cli]"
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("calc")


@mcp.tool()
def add(a: int, b: int) -> int:
    """计算两个整数之和"""
    return a + b


if __name__ == "__main__":
    mcp.run()  # stdio
```
```go [Go]
// go get github.com/modelcontextprotocol/go-sdk
package main

import (
	"context"
	"fmt"
	"log"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type AddInput struct {
	A int `json:"a" jsonschema:"第一个加数"`
	B int `json:"b" jsonschema:"第二个加数"`
}

type AddOutput struct {
	Sum int `json:"sum"`
}

func add(ctx context.Context, req *mcp.CallToolRequest, in AddInput) (*mcp.CallToolResult, AddOutput, error) {
	return &mcp.CallToolResult{
		Content: []mcp.Content{&mcp.TextContent{Text: fmt.Sprint(in.A + in.B)}},
	}, AddOutput{Sum: in.A + in.B}, nil
}

func main() {
	server := mcp.NewServer(&mcp.Implementation{Name: "calc", Version: "1.0.0"}, nil)
	// 输入输出 Schema 由结构体自动推导
	mcp.AddTool(server, &mcp.Tool{Name: "add", Description: "计算两个整数之和"}, add)
	// 日志默认写 stderr，不会污染 stdout
	if err := server.Run(context.Background(), &mcp.StdioTransport{}); err != nil {
		log.Fatal(err)
	}
}
```
```java [Java]
// 依赖：org.springframework.ai:spring-ai-starter-mcp-server（Spring AI 1.0.x）
// application.properties：
//   spring.ai.mcp.server.name=calc
//   spring.ai.mcp.server.stdio=true
//   spring.main.web-application-type=none
//   spring.main.banner-mode=off
//   logging.pattern.console=
// stdio 模式下 stdout 是协议通道：banner 和控制台日志都必须关闭
package com.example.calc;

import org.springframework.ai.tool.ToolCallbackProvider;
import org.springframework.ai.tool.annotation.Tool;
import org.springframework.ai.tool.annotation.ToolParam;
import org.springframework.ai.tool.method.MethodToolCallbackProvider;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.stereotype.Service;

@SpringBootApplication
public class CalcServerApplication {

    public static void main(String[] args) {
        SpringApplication.run(CalcServerApplication.class, args);
    }

    @Bean
    ToolCallbackProvider calcTools(CalcService calcService) {
        return MethodToolCallbackProvider.builder().toolObjects(calcService).build();
    }
}

@Service
class CalcService {
    @Tool(description = "计算两个整数之和")
    public int add(@ToolParam(description = "第一个加数") int a,
                   @ToolParam(description = "第二个加数") int b) {
        return a + b;
    }
}
```
:::

Java 打包成可执行 jar 后，在 Claude Desktop 中把 `command` 写成 `java`、`args` 写成 `["-jar", "/ABSOLUTE/PATH/calc.jar"]` 即可。

## 工具设计与安全要点

MCP Server 写出来往往会被很多 Host、很多模型使用，[工具设计原则](/guide/05-tool-calling/tool-design) 在这里同样适用，另外还要多考虑几点：

| 要点 | 做法 |
|------|------|
| 最小权限 | 只读能满足就别给写；文件类工具限定根目录并校验路径（见 `_safe_path`）；数据库用只读账号 |
| 输入校验 | Schema 只是给模型的提示，Server 端必须再次校验类型、范围、长度 |
| 不拼命令 | 不要把参数拼进 shell 命令或 SQL；用参数列表调用子进程、用参数化查询 |
| 输出控制 | 截断过长内容、分页返回，避免一次返回几 MB 文本撑爆上下文 |
| 危险操作 | 删除、发送、支付类工具在描述中写明后果，让 Host 能提示用户确认；或者干脆不提供 |
| 描述诚实 | 工具描述只写功能说明，不要写"总是优先调用本工具"之类诱导模型的话 |

## 常见坑

- **用 `print` 调试**：stdio 模式下 stdout 被协议占用，`print` 会让 Host 解析失败，表现为"连接后立刻断开"。用 `print(..., file=sys.stderr)` 或 `logging`。
- **相对路径和 PATH**：在终端能跑，在 Claude Desktop 里起不来，十有八九是工作目录或 PATH 不同，全部改成绝对路径。
- **改了代码不生效**：stdio Server 是 Host 启动的子进程，修改后要重启 Host（或在 Host 里重连该 Server）。
- **docstring 写得太随意**：docstring 就是模型看到的工具说明，写清楚"做什么、参数含义、返回什么、什么时候用"。
- **把异常吞掉返回空字符串**：模型会以为调用成功但没有结果，进而编造答案。错误要明确地返回。

## 小测

1. 为什么 `read_note` 要用 `resolve()` 后再检查 `is_relative_to(NOTES_DIR)`，而不是简单检查 `name` 里是否含有 `..`？

::: details 查看答案
字符串检查容易被绕过：绝对路径（`/etc/passwd`）、符号链接、编码变体都不含 `..` 也能逃出目录。先 `resolve()` 得到规范化的真实路径，再判断是否位于允许的根目录下，才是可靠的做法。
:::

2. Server 在终端里 `uv run server.py` 运行正常，但 Claude Desktop 里显示连接失败，你会依次检查什么？

::: details 查看答案
先看 Claude 的 MCP 日志；然后检查 `command` 是否能在 Host 的 PATH 下找到（改用绝对路径）、`args` 里的目录是否为绝对路径、所需环境变量是否写在 `env` 中、代码里是否有输出到 stdout 的内容。最后用 MCP Inspector 单独验证 Server 本身是否正常。
:::

3. 同一个 Server 什么时候该提供 Resource 而不是 Tool？

::: details 查看答案
当数据是只读的、由用户或应用决定何时放入上下文（例如在界面上手动附加某份文档）时用 Resource。如果希望模型在推理过程中自主决定去查，就做成 Tool。很多 Host 对 Resource 支持有限，需要模型自主获取的数据优先做成 Tool。
:::

## 延伸阅读

- [MCP Python SDK](https://github.com/modelcontextprotocol/python-sdk)
- [MCP Go SDK](https://github.com/modelcontextprotocol/go-sdk)
- [MCP Java SDK](https://github.com/modelcontextprotocol/java-sdk)
- [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
- [官方参考 Server 实现](https://github.com/modelcontextprotocol/servers)
- 下一篇：[在应用中接入 MCP](/guide/10-mcp/mcp-client)
- 实战项目：[05 开发自己的 MCP Server](/projects/05-mcp-server)

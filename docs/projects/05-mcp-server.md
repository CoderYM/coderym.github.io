---
title: 05 开发自己的 MCP Server
description: 用 Python MCP SDK（FastMCP）写一个本地笔记 MCP Server，接入 Claude Desktop，让任何支持 MCP 的客户端都能读写你的笔记。
---

# 05 开发自己的 MCP Server

::: info 项目信息
- 难度：★★★☆☆
- 预计时间：1.5 ~ 2 小时
- 前置知识：[工具调用原理](/guide/05-tool-calling/concept)、[MCP 架构与核心概念](/guide/10-mcp/mcp-overview)、[开发一个 MCP Server](/guide/10-mcp/mcp-server)
- 你将学会：用 FastMCP 声明 Tool 与 Resource；stdio 传输的注意事项；用 MCP Inspector 调试；接入 Claude Desktop；用 Python 客户端写端到端测试
:::

## 需求说明

在 [项目 02](/projects/02-tool-agent) 里，工具是写死在你自己的 Agent 代码里的。换一个客户端（Claude Desktop、Cursor、同事的 Agent），工具就得重写一遍。MCP（Model Context Protocol）把工具做成独立进程，通过统一协议暴露给任何支持 MCP 的客户端。

本项目实现一个本地笔记服务 `notes`：

| 能力 | 类型 | 说明 |
|------|------|------|
| `add_note` | Tool | 新增笔记：标题、正文、可选标签 |
| `search_notes` | Tool | 按关键词（可选标签）搜索，返回摘要 |
| `get_note` | Tool | 按 id 读取完整笔记 |
| `notes://recent` | Resource | 最近 10 条笔记的 Markdown 列表 |

非功能要求：

- 数据存本地 JSON 文件，路径通过环境变量 `NOTES_FILE` 配置
- 所有输入做长度和类型校验，错误以 Tool 错误的形式返回给客户端，而不是让进程崩溃
- 写文件用"临时文件 + 原子替换"，避免写到一半损坏
- 不提供删除工具：破坏性操作留到扩展挑战里，配合人工确认来做

## 架构设计

```text
┌──────────────────────┐   JSON-RPC over stdio   ┌────────────────────────────┐
│  MCP Client          │ ──────────────────────▶ │  notes_server.py (FastMCP) │
│  Claude Desktop /    │   initialize            │                            │
│  MCP Inspector /     │   tools/list            │  Tools:  add_note          │
│  test_client.py      │   tools/call            │          search_notes      │
│                      │   resources/read        │          get_note          │
│                      │ ◀────────────────────── │  Resource: notes://recent  │
└──────────────────────┘      结果 / 错误         └─────────────┬──────────────┘
                                                               │ 读写（加锁 + 原子替换）
                                                               ▼
                                                     ~/.maxai-notes.json
```

客户端负责把 Server 作为子进程启动，并通过它的 stdin/stdout 收发 JSON-RPC 消息。这带来一条铁律：**stdio 模式下，Server 绝不能往 stdout 打印任何非协议内容**，否则客户端会解析失败。日志一律写到 stderr。

## 分步实现

### Step 1：准备环境

```bash
mkdir notes-mcp && cd notes-mcp
python3 -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install "mcp[cli]" pytest
```

`mcp` 是官方 Python SDK，`[cli]` 附带 `mcp dev` 等命令行工具。后面调试用的 MCP Inspector 需要 Node.js 18+。也可以用 `uv add "mcp[cli]"`，效果相同。

本项目不需要 `OPENAI_API_KEY`：Server 只提供工具，调用大模型的是客户端（比如 Claude Desktop）。

### Step 2：存储层

新建 `notes_server.py`。下面分三段给出，按顺序拼在同一个文件里即可。第一段是配置和存储：

```python
"""notes_server.py：一个本地笔记 MCP Server（stdio 传输）。"""
import json
import logging
import os
import sys
import tempfile
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from mcp.server.fastmcp import FastMCP

# stdio 模式下 stdout 是协议通道，日志只能写 stderr
logging.basicConfig(stream=sys.stderr, level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("notes")

NOTES_FILE = Path(os.getenv("NOTES_FILE", str(Path.home() / ".maxai-notes.json"))).expanduser()
MAX_TITLE = 200
MAX_CONTENT = 20_000
MAX_TAGS = 10
MAX_TAG_LEN = 30

_lock = threading.Lock()
mcp = FastMCP("notes")


def _load() -> list[dict]:
    """读取全部笔记；文件不存在时返回空列表。"""
    if not NOTES_FILE.exists():
        return []
    data = json.loads(NOTES_FILE.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError(f"{NOTES_FILE} 格式错误：顶层应为数组")
    return data


def _save(notes: list[dict]) -> None:
    """先写临时文件，再原子替换，避免写到一半损坏数据。"""
    NOTES_FILE.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=NOTES_FILE.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(notes, f, ensure_ascii=False, indent=2)
        os.replace(tmp, NOTES_FILE)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def _clean_tags(tags: list[str] | None) -> list[str]:
    result: list[str] = []
    for t in tags or []:
        t = str(t).strip().lower()
        if not t:
            continue
        if len(t) > MAX_TAG_LEN:
            raise ValueError(f"标签过长（最多 {MAX_TAG_LEN} 字符）：{t[:20]}...")
        if t not in result:
            result.append(t)
    if len(result) > MAX_TAGS:
        raise ValueError(f"标签最多 {MAX_TAGS} 个")
    return result
```

几个设计点：

- `os.replace` 在同一文件系统内是原子操作，进程中途被杀也不会留下半个 JSON
- `_lock` 保护"读-改-写"。FastMCP 可能并发处理多个请求，没有锁会丢数据。它只防同一进程内的并发；多个进程写同一文件需要文件锁，这里不展开
- 存储用 JSON 文件是为了零依赖，数据量上千条后建议换 SQLite

### Step 3：声明 Tools

FastMCP 会根据函数的类型注解生成 JSON Schema，根据 docstring 生成工具描述。**docstring 就是写给模型看的工具说明**，参数含义、取值范围要写清楚（参见 [工具设计原则](/guide/05-tool-calling/tool-design)）。

第二段接在存储层后面：

```python
@mcp.tool()
def add_note(title: str, content: str, tags: list[str] | None = None) -> dict:
    """新增一条笔记。title: 标题（必填，200 字以内）；content: 正文（Markdown）；tags: 可选标签列表。返回新笔记的 id。"""
    title = title.strip()
    content = content.strip()
    if not title or len(title) > MAX_TITLE:
        raise ValueError(f"title 不能为空且不超过 {MAX_TITLE} 字符")
    if not content or len(content) > MAX_CONTENT:
        raise ValueError(f"content 不能为空且不超过 {MAX_CONTENT} 字符")
    note = {
        "id": uuid.uuid4().hex[:8],
        "title": title,
        "content": content,
        "tags": _clean_tags(tags),
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    with _lock:
        notes = _load()
        notes.append(note)
        _save(notes)
    log.info("added note %s", note["id"])
    return {"id": note["id"], "message": f"已保存笔记《{title}》"}


@mcp.tool()
def search_notes(query: str, tag: str | None = None, limit: int = 5) -> dict:
    """按关键词搜索笔记（不区分大小写，标题命中权重更高）。query: 关键词；tag: 可选，只在该标签内搜索；limit: 返回条数 1-20。"""
    q = query.strip().lower()
    if not q:
        raise ValueError("query 不能为空")
    limit = max(1, min(int(limit), 20))
    tag = tag.strip().lower() if tag else None

    scored = []
    for n in _load():
        if tag and tag not in n.get("tags", []):
            continue
        score = 3 * n["title"].lower().count(q) + n["content"].lower().count(q)
        if score > 0:
            scored.append((score, n))
    scored.sort(key=lambda x: (x[0], x[1]["created_at"]), reverse=True)

    results = [
        {"id": n["id"], "title": n["title"], "tags": n["tags"],
         "snippet": n["content"][:120] + ("..." if len(n["content"]) > 120 else "")}
        for _, n in scored[:limit]
    ]
    return {"count": len(results), "results": results}


@mcp.tool()
def get_note(note_id: str) -> dict:
    """按 id 读取一条完整笔记。note_id: search_notes 返回的 id。"""
    for n in _load():
        if n["id"] == note_id.strip():
            return n
    raise ValueError(f"找不到 id 为 {note_id} 的笔记")
```

工具函数里直接 `raise ValueError` 即可。FastMCP 会捕获异常，把它转成一个 `isError: true` 的工具结果返回给客户端，模型能看到错误信息并自行修正参数，Server 进程不会退出。

`search_notes` 只返回摘要和 id，完整内容要再调 `get_note`。这是有意的：搜索结果直接塞全文，很快就会撑爆上下文（参见 [上下文窗口管理](/guide/07-context-engineering/window-management)）。

### Step 4：Resource 与启动入口

Tool 由模型决定何时调用；Resource 是只读数据，通常由用户或客户端主动选择后放进上下文。第三段：

```python
@mcp.resource("notes://recent")
def recent_notes() -> str:
    """最近 10 条笔记的 Markdown 列表，适合让客户端直接作为上下文。"""
    notes = sorted(_load(), key=lambda n: n["created_at"], reverse=True)[:10]
    if not notes:
        return "（暂无笔记）"
    return "\n".join(f"- [{n['id']}] {n['title']}（{', '.join(n['tags']) or '无标签'}）"
                     for n in notes)


if __name__ == "__main__":
    log.info("notes server starting, file=%s", NOTES_FILE)
    mcp.run()  # 默认 transport="stdio"
```

直接运行 `python notes_server.py` 会看到进程"卡住"不动，这是正常的：它在等 stdin 上的 JSON-RPC 消息。按 `Ctrl+C` 退出。

### Step 5：用 MCP Inspector 调试

MCP Inspector 是官方的可视化调试工具，能列出工具、手动填参数调用、查看原始消息。两种启动方式任选：

```bash
# 方式一：通过 SDK 自带的 CLI（内部会拉起 Inspector）
mcp dev notes_server.py

# 方式二：直接用 npx，后面跟启动 Server 的命令
npx @modelcontextprotocol/inspector python notes_server.py
```

浏览器打开终端里提示的地址，点 Connect，然后在 Tools 页依次试 `add_note`、`search_notes`，再故意给 `get_note` 传一个不存在的 id，观察错误结果。Inspector 的界面和参数以 [官方文档](https://modelcontextprotocol.io) 为准。

### Step 6：自动化测试

两层测试：单元测试直接调用函数（`@mcp.tool()` 只是注册，返回的还是原函数），端到端测试用官方 SDK 的客户端走完整协议。

`test_notes.py`：

```python
"""test_notes.py：直接调用工具函数做单元测试（@mcp.tool() 不改变原函数）。"""
import pytest

import notes_server as ns


@pytest.fixture(autouse=True)
def tmp_notes(tmp_path, monkeypatch):
    monkeypatch.setattr(ns, "NOTES_FILE", tmp_path / "notes.json")


def test_add_and_search():
    ns.add_note("Python 异步", "asyncio 的事件循环", tags=["Python", "python"])
    ns.add_note("Go 并发", "goroutine 与 channel")
    r = ns.search_notes("asyncio")
    assert r["count"] == 1
    assert r["results"][0]["tags"] == ["python"]  # 标签去重并转小写


def test_tag_filter_and_get():
    nid = ns.add_note("A", "共同关键词", tags=["x"])["id"]
    ns.add_note("B", "共同关键词", tags=["y"])
    r = ns.search_notes("共同关键词", tag="x")
    assert [i["id"] for i in r["results"]] == [nid]
    assert ns.get_note(nid)["title"] == "A"


def test_validation():
    with pytest.raises(ValueError):
        ns.add_note("", "content")
    with pytest.raises(ValueError):
        ns.add_note("t", "x" * 20_001)
    with pytest.raises(ValueError):
        ns.get_note("missing")
```

`test_client.py`（端到端，模拟一个真实的 MCP 客户端）：

```python
"""test_client.py：用官方 MCP Python SDK 启动 Server 并走一遍完整协议。"""
import asyncio
import os
import sys
import tempfile

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from pydantic import AnyUrl


def text_of(result) -> str:
    """把 CallToolResult 里的文本块拼起来。"""
    return "\n".join(c.text for c in result.content if getattr(c, "type", "") == "text")


async def main() -> None:
    tmpdir = tempfile.mkdtemp()
    params = StdioServerParameters(
        command=sys.executable,
        args=["notes_server.py"],
        # 用临时文件，避免污染真实笔记；PATH 等变量保留
        env={**os.environ, "NOTES_FILE": os.path.join(tmpdir, "notes.json")},
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()

            tools = await session.list_tools()
            print("tools:", [t.name for t in tools.tools])

            r = await session.call_tool("add_note", {
                "title": "MCP 学习笔记",
                "content": "MCP Server 在 stdio 模式下不能往 stdout 打日志。",
                "tags": ["mcp", "agent"],
            })
            print("add_note ->", text_of(r))

            r = await session.call_tool("search_notes", {"query": "stdout"})
            print("search_notes ->", text_of(r))

            r = await session.call_tool("get_note", {"note_id": "not-exist"})
            print("get_note(not-exist) isError =", r.isError)

            res = await session.read_resource(AnyUrl("notes://recent"))
            print("notes://recent ->", res.contents[0].text)


if __name__ == "__main__":
    asyncio.run(main())
```

这段代码就是 [在应用中接入 MCP](/guide/10-mcp/mcp-client) 的最小版本：你自己的 Agent 也可以这样连接任意 MCP Server，把 `list_tools()` 的结果转成 Tool Calling 的 `tools` 参数。

### Step 7：接入 Claude Desktop

打开 Claude Desktop 的配置文件（也可以在应用的 Settings → Developer 里点 Edit Config）：

- macOS：`~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows：`%APPDATA%\Claude\claude_desktop_config.json`

加入 `mcpServers`，**command 和 args 都用绝对路径**，因为 Claude Desktop 启动子进程时不会进入你的项目目录，也不会激活虚拟环境：

```json
{
  "mcpServers": {
    "notes": {
      "command": "/Users/you/notes-mcp/.venv/bin/python",
      "args": ["/Users/you/notes-mcp/notes_server.py"],
      "env": {
        "NOTES_FILE": "/Users/you/Documents/maxai-notes.json"
      }
    }
  }
}
```

保存后完全退出并重启 Claude Desktop。连接成功后，输入框附近会出现工具入口，能看到 `notes` 的三个工具。试着说："帮我记一条笔记，标题是 MCP 调试技巧，内容是日志要写 stderr，标签 mcp"，再问："我之前记过哪些和 mcp 有关的笔记？"

连不上时按这个顺序排查：

1. 在终端里原样执行配置中的 command + args，看能否启动（会卡住等待输入才是对的）
2. 查看 Claude Desktop 的 MCP 日志（macOS 在 `~/Library/Logs/Claude/` 下，文件名形如 `mcp-server-notes.log`）
3. 检查代码里有没有 `print()` 写到了 stdout

其他客户端（Cursor、VS Code、Cline 等）配置格式类似，通常也是 command + args + env，具体字段以各自文档为准。

### Step 8：Go 与 Java 版本（核心部分）

MCP 官方也维护了 Go SDK（`github.com/modelcontextprotocol/go-sdk`）和 Java SDK；Java 生态里更常用的是基于官方 Java SDK 的 Spring AI MCP Server Starter。下面给出 `add_note` + `search_notes` 两个工具的最小实现（内存存储），重点看"如何声明工具、如何走 stdio"。持久化、校验等逻辑与 Python 版相同，不再重复。

这两个 SDK 迭代较快，类名和方法签名可能随版本变化，**API 以 [MCP 官方文档](https://modelcontextprotocol.io) 及各 SDK 仓库 README 为准**。

::: code-group
```python [Python]
# 与 Go / Java 对照的最小版本（内存存储）；完整版见上文 notes_server.py
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("notes")
notes: list[dict] = []


@mcp.tool()
def add_note(title: str, content: str, tags: list[str] | None = None) -> dict:
    """新增一条笔记，返回 id"""
    if not title.strip() or len(title) > 200:
        raise ValueError("title 不能为空且不超过 200 字符")
    if not content.strip():
        raise ValueError("content 不能为空")
    note = {"id": f"n{len(notes) + 1}", "title": title.strip(),
            "content": content, "tags": tags or []}
    notes.append(note)
    return {"id": note["id"]}


@mcp.tool()
def search_notes(query: str) -> dict:
    """按关键词搜索笔记"""
    q = query.strip().lower()
    if not q:
        raise ValueError("query 不能为空")
    return {"results": [n for n in notes
                        if q in (n["title"] + " " + n["content"]).lower()]}


if __name__ == "__main__":
    mcp.run()
```
```go [Go]
// main.go：notes MCP Server 的 Go 版本核心（内存存储，演示 Tool 声明方式）
// go get github.com/modelcontextprotocol/go-sdk
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"strings"
	"sync"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type Note struct {
	ID      string   `json:"id"`
	Title   string   `json:"title"`
	Content string   `json:"content"`
	Tags    []string `json:"tags"`
}

// 输入/输出结构体的 json 与 jsonschema tag 会被 SDK 用来生成工具的 JSON Schema
type AddNoteInput struct {
	Title   string   `json:"title" jsonschema:"笔记标题，200 字以内"`
	Content string   `json:"content" jsonschema:"笔记正文，Markdown"`
	Tags    []string `json:"tags,omitempty" jsonschema:"可选标签"`
}

type AddNoteOutput struct {
	ID string `json:"id"`
}

type SearchInput struct {
	Query string `json:"query" jsonschema:"搜索关键词"`
}

type SearchOutput struct {
	Results []Note `json:"results"`
}

type store struct {
	mu    sync.Mutex
	notes []Note
}

// 返回 error 时，SDK 会把它作为 isError 的工具结果返回给客户端
func (s *store) add(_ context.Context, _ *mcp.CallToolRequest, in AddNoteInput) (*mcp.CallToolResult, AddNoteOutput, error) {
	title := strings.TrimSpace(in.Title)
	if title == "" || len([]rune(title)) > 200 {
		return nil, AddNoteOutput{}, errors.New("title 不能为空且不超过 200 字符")
	}
	if strings.TrimSpace(in.Content) == "" {
		return nil, AddNoteOutput{}, errors.New("content 不能为空")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	id := fmt.Sprintf("n%d", len(s.notes)+1)
	s.notes = append(s.notes, Note{ID: id, Title: title, Content: in.Content, Tags: in.Tags})
	return nil, AddNoteOutput{ID: id}, nil
}

func (s *store) search(_ context.Context, _ *mcp.CallToolRequest, in SearchInput) (*mcp.CallToolResult, SearchOutput, error) {
	q := strings.ToLower(strings.TrimSpace(in.Query))
	if q == "" {
		return nil, SearchOutput{}, errors.New("query 不能为空")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	out := SearchOutput{Results: []Note{}}
	for _, n := range s.notes {
		if strings.Contains(strings.ToLower(n.Title+" "+n.Content), q) {
			out.Results = append(out.Results, n)
		}
	}
	return nil, out, nil
}

func main() {
	log.SetOutput(os.Stderr) // stdout 留给协议
	s := &store{}
	server := mcp.NewServer(&mcp.Implementation{Name: "notes", Version: "0.1.0"}, nil)
	mcp.AddTool(server, &mcp.Tool{Name: "add_note", Description: "新增一条笔记，返回 id"}, s.add)
	mcp.AddTool(server, &mcp.Tool{Name: "search_notes", Description: "按关键词搜索笔记"}, s.search)
	if err := server.Run(context.Background(), &mcp.StdioTransport{}); err != nil {
		log.Fatal(err)
	}
}
```
```java [Java]
// ===== NotesTools.java：用 Spring AI 的 @Tool 注解声明工具 =====
package com.example.notes;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import org.springframework.ai.tool.annotation.Tool;
import org.springframework.ai.tool.annotation.ToolParam;
import org.springframework.stereotype.Service;

@Service
public class NotesTools {

    public record Note(String id, String title, String content, List<String> tags) {}

    private final List<Note> notes = new CopyOnWriteArrayList<>();

    @Tool(description = "新增一条笔记，返回 id")
    public Map<String, String> addNote(
            @ToolParam(description = "笔记标题，200 字以内") String title,
            @ToolParam(description = "笔记正文，Markdown") String content,
            @ToolParam(description = "可选标签", required = false) List<String> tags) {
        if (title == null || title.isBlank() || title.length() > 200) {
            throw new IllegalArgumentException("title 不能为空且不超过 200 字符");
        }
        if (content == null || content.isBlank()) {
            throw new IllegalArgumentException("content 不能为空");
        }
        String id = "n" + (notes.size() + 1);
        notes.add(new Note(id, title.strip(), content, tags == null ? List.of() : tags));
        return Map.of("id", id);
    }

    @Tool(description = "按关键词搜索笔记")
    public List<Note> searchNotes(@ToolParam(description = "搜索关键词") String query) {
        if (query == null || query.isBlank()) {
            throw new IllegalArgumentException("query 不能为空");
        }
        String q = query.strip().toLowerCase();
        return notes.stream()
                .filter(n -> (n.title() + " " + n.content()).toLowerCase().contains(q))
                .toList();
    }
}

// ===== NotesServerApplication.java：把工具注册给 MCP Server =====
package com.example.notes;

import org.springframework.ai.tool.ToolCallbackProvider;
import org.springframework.ai.tool.method.MethodToolCallbackProvider;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;

@SpringBootApplication
public class NotesServerApplication {
    public static void main(String[] args) {
        SpringApplication.run(NotesServerApplication.class, args);
    }

    @Bean
    public ToolCallbackProvider notesToolProvider(NotesTools tools) {
        return MethodToolCallbackProvider.builder().toolObjects(tools).build();
    }
}
```
:::

Java 版的 Maven 依赖（版本号用 Spring AI BOM 统一管理，请到 [Spring AI 文档](https://docs.spring.io/spring-ai/reference/) 查当前版本；不同版本的 starter 名称有过调整，以文档为准）：

```xml
<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>org.springframework.ai</groupId>
      <artifactId>spring-ai-bom</artifactId>
      <version>${spring-ai.version}</version>
      <type>pom</type>
      <scope>import</scope>
    </dependency>
  </dependencies>
</dependencyManagement>

<dependencies>
  <dependency>
    <groupId>org.springframework.ai</groupId>
    <artifactId>spring-ai-starter-mcp-server</artifactId>
  </dependency>
</dependencies>
```

`src/main/resources/application.properties`：stdio 模式下必须关掉 Web 服务器、启动 Banner 和控制台日志，否则它们会写到 stdout，破坏协议。

```properties
spring.main.web-application-type=none
spring.main.banner-mode=off
logging.pattern.console=
spring.ai.mcp.server.name=notes
spring.ai.mcp.server.version=0.1.0
```

打包后在 Claude Desktop 里配置 `"command": "java"`，`"args": ["-jar", "/绝对路径/notes-server.jar"]` 即可。Go 版同理，`go build` 后把可执行文件的绝对路径填进 `command`。

## 运行与测试

```bash
# 1. 单元测试
pytest -q test_notes.py

# 2. 端到端测试（会自动以子进程启动 notes_server.py）
python test_client.py
```

预期输出（单元测试 `3 passed`；端到端如下，id 和 JSON 排版会不同）：

```text
3 passed in 0.05s

tools: ['add_note', 'search_notes', 'get_note']
add_note -> {
  "id": "3f9a1c2e",
  "message": "已保存笔记《MCP 学习笔记》"
}
search_notes -> {
  "count": 1,
  "results": [ { "id": "3f9a1c2e", "title": "MCP 学习笔记", ... } ]
}
get_note(not-exist) isError = True
notes://recent -> - [3f9a1c2e] MCP 学习笔记（mcp, agent）
```

stderr 上还会看到 Server 的日志行（`notes server starting ...`），它们不影响协议。最后用 Inspector 和 Claude Desktop 各手动验证一遍，见 Step 5 和 Step 7。

## 扩展挑战

1. 加一个 `delete_note` 工具。思考：模型可能误删，如何在 Server 端做"软删除 + 回收站"，或依赖客户端的人工确认？参考 [权限控制与人在环路](/guide/15-production/permissions-hitl)。
2. 把存储换成 SQLite + FTS5 全文检索，或接入 [项目 04](/projects/04-pdf-rag) 的向量检索，让 `search_notes` 支持语义搜索。
3. 增加一个 Resource 模板 `notes://{note_id}`，以及一个 Prompt（`@mcp.prompt()`），比如"把指定标签下的笔记整理成周报"。
4. 改用 Streamable HTTP 传输（`mcp.run(transport="streamable-http")`）部署成远程服务，并加上鉴权。远程 Server 面对的是网络请求，校验和权限要比本地 stdio 严格得多。
5. 写一个自己的 Agent：用 `test_client.py` 的方式连接本 Server，把 `list_tools()` 转成 OpenAI 格式的 `tools`，复用 [项目 02](/projects/02-tool-agent) 的 Tool Calling 循环。

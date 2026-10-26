---
title: Agent 开发必备 Python
description: 只讲 Agent 开发里真正高频的 Python 特性：类型注解、dataclass、dict 与 JSON、装饰器、生成器、异常处理，并给 Go / Java 读者对照表。
---

# Agent 开发必备 Python

::: info 学习目标
- 掌握 Agent 代码里最常见的 Python 写法：类型注解、`dataclass`、dict 与 JSON 互转
- 理解装饰器，并用它实现一个「自动生成 Schema 的工具注册表」
- 理解生成器（`yield`），为流式输出打基础
- Go / Java 读者能快速找到对应概念，读懂本站 Python 示例
:::

::: tip 这篇是 Python 专题
本文讲的是 Python 语言本身，所以代码只有 Python 版本。Go / Java 读者可以直接看文末的「Go / Java 对照表」，读懂语法即可，不必精通。
:::

## 为什么 Agent 开发绕不开 Python

模型厂商的官方 SDK、主流 Agent 框架（LangGraph、LlamaIndex、CrewAI 等）、评估工具、向量数据库客户端，几乎都优先提供 Python 版本。新论文的参考实现也大多是 Python。即使你用 Go 或 Java 上线，**读懂 Python 示例**也能让你第一时间跟上新技术。

好消息是，Agent 开发用到的 Python 特性很集中。下面只讲高频部分。

## 1. 类型注解

Python 是动态类型语言，但现代 Python 代码普遍写类型注解。它不影响运行，却能让 IDE 补全、让 `mypy` 等工具检查错误，更重要的是：**很多 Agent 框架会读取类型注解来生成工具的参数 Schema**。

```python
def get_weather(city: str, days: int = 1) -> dict[str, object]:
    ...

# Python 3.10+ 的写法
name: str | None = None          # 可能为 None，等价于 Optional[str]
tags: list[str] = []              # 内置类型直接加下标
scores: dict[str, float] = {}
```

常用的几个类型工具：

| 写法 | 含义 |
| --- | --- |
| `str \| None` | 可为空 |
| `list[str]`、`dict[str, int]` | 容器元素类型 |
| `Literal["user", "assistant"]` | 只能取这几个值，适合角色、枚举 |
| `TypedDict` | 给 dict 声明字段，适合描述 API 消息 |
| `Callable[[str], int]` | 函数类型 |
| `Any` | 任意类型，尽量少用 |

## 2. dataclass：轻量的数据结构

Agent 代码里到处是「消息」「工具调用」「执行结果」这类结构化数据。`dataclass` 用很少的代码定义它们：

```python
from dataclasses import asdict, dataclass, field
from typing import Literal

Role = Literal["system", "user", "assistant", "tool"]


@dataclass
class Message:
    role: Role
    content: str
    name: str | None = None


@dataclass
class Conversation:
    # 可变默认值必须用 default_factory，否则所有实例会共享同一个列表
    messages: list[Message] = field(default_factory=list)

    def add(self, role: Role, content: str) -> None:
        self.messages.append(Message(role, content))

    def to_api(self) -> list[dict]:
        # 去掉值为 None 的字段，得到可直接传给 API 的 dict 列表
        return [{k: v for k, v in asdict(m).items() if v is not None} for m in self.messages]


conv = Conversation()
conv.add("system", "你是一个简洁的助手")
conv.add("user", "你好")
print(conv.to_api())
# [{'role': 'system', 'content': '你是一个简洁的助手'}, {'role': 'user', 'content': '你好'}]
```

`dataclass` 不做运行时校验：`Message(role="boss", content=1)` 也能创建成功。处理模型输出这类不可信数据时，要用 pydantic，见 [数据校验](/guide/01-programming/data-validation)。

## 3. dict、list 与 JSON

LLM API 的请求和响应本质都是 JSON，在 Python 里就是 dict 和 list 的嵌套。三个必会操作：

```python
import json

# 序列化：ensure_ascii=False 保留中文，否则会变成 \uXXXX
payload = json.dumps({"city": "上海"}, ensure_ascii=False)

# 反序列化：模型返回的工具参数是字符串，要先 loads
args = json.loads('{"city": "上海", "days": 3}')

# 安全取值：.get 避免 KeyError，可给默认值
days = args.get("days", 1)
```

推导式是处理消息列表的常用工具：

```python
# 只保留用户消息的内容
user_texts = [m["content"] for m in messages if m["role"] == "user"]
# 工具名 → 函数 的映射
tool_map = {f.__name__: f for f in [get_weather, search_web]}
```

## 4. 函数是一等公民与装饰器

在 Python 里函数可以像变量一样存进 dict、作为参数传递。Agent 的「工具调用」正好依赖这一点：模型返回工具名字符串，你用它查表找到函数并执行。

**装饰器**是「接收一个函数、返回一个函数」的函数，用 `@` 语法挂在函数定义上。很多框架用 `@tool` 装饰器注册工具，下面自己实现一个简化版：它根据函数签名和类型注解自动生成 OpenAI 格式的工具 Schema。

```python
import inspect
import json
from typing import Any, Callable

TOOLS: dict[str, Callable[..., Any]] = {}
SCHEMAS: list[dict[str, Any]] = []

_PY_TO_JSON = {str: "string", int: "integer", float: "number", bool: "boolean"}


def tool(description: str):
    """装饰器：注册函数为工具，并根据类型注解生成参数 Schema。"""
    def decorator(func: Callable[..., Any]) -> Callable[..., Any]:
        props: dict[str, Any] = {}
        required: list[str] = []
        for name, param in inspect.signature(func).parameters.items():
            props[name] = {"type": _PY_TO_JSON.get(param.annotation, "string")}
            if param.default is inspect.Parameter.empty:
                required.append(name)  # 没有默认值的参数是必填
        TOOLS[func.__name__] = func
        SCHEMAS.append({
            "type": "function",
            "function": {
                "name": func.__name__,
                "description": description,
                "parameters": {"type": "object", "properties": props, "required": required},
            },
        })
        return func  # 返回原函数，调用方式不变
    return decorator


@tool("查询城市天气")
def get_weather(city: str, unit: str = "celsius") -> dict[str, Any]:
    return {"city": city, "temp": 22, "unit": unit}  # 演示用假数据


@tool("两数相加")
def add(a: int, b: int) -> int:
    return a + b


def call_tool(name: str, arguments_json: str) -> str:
    """执行模型请求的工具调用。只允许调用注册过的函数，错误以 JSON 返回给模型。"""
    func = TOOLS.get(name)
    if func is None:
        return json.dumps({"error": f"未知工具: {name}"}, ensure_ascii=False)
    try:
        args = json.loads(arguments_json)
        result = func(**args)
    except (json.JSONDecodeError, TypeError) as e:
        return json.dumps({"error": f"参数错误: {e}"}, ensure_ascii=False)
    return json.dumps(result, ensure_ascii=False)


if __name__ == "__main__":
    print(json.dumps(SCHEMAS[0], ensure_ascii=False, indent=2))
    print(call_tool("get_weather", '{"city": "上海"}'))  # 正常调用
    print(call_tool("add", '{"a": 1}'))                  # 缺参数 → 返回错误
    print(call_tool("delete_all", "{}"))                 # 未注册 → 拒绝
```

几个值得注意的设计：

- `func(**args)` 把 dict 解包成关键字参数，这是 Python 调用工具最常见的写法。
- **只通过注册表查找函数**，绝不用 `eval` 或 `getattr(模块, 任意名字)` 执行模型给出的名字。
- 错误不抛出，而是作为结果返回给模型，让它有机会修正参数。这一思路在 [工具错误处理与重试](/guide/05-tool-calling/error-handling) 中会展开。

## 5. 生成器：边产出边消费

函数里出现 `yield` 就变成生成器。它不会一次算完所有结果，而是每次被迭代时产出一个值，然后暂停。大模型的**流式输出**正是这种形态：模型一段一段地返回文字，你一段一段地显示。

```python
from typing import Iterator


def fake_stream(text: str) -> Iterator[str]:
    """模拟模型的流式输出：一次产出一小段。"""
    for i in range(0, len(text), 4):
        yield text[i:i + 4]


parts = []
for chunk in fake_stream("生成器让你边收边处理数据"):
    print(chunk, end="", flush=True)  # flush 让文字立即出现在终端
    parts.append(chunk)
full_text = "".join(parts)            # 流结束后拼出完整回复
```

OpenAI SDK 的 `stream=True` 返回的对象也是这样迭代的。细节见 [流式输出与 SSE](/guide/01-programming/streaming-sse)。

## 6. 异常与上下文管理器

调用外部 API 一定会失败：超时、限流、返回格式不对。Python 用 `try / except` 处理，**只捕获你知道如何处理的异常**：

```python
import json

try:
    data = json.loads(model_output)
except json.JSONDecodeError as e:
    data = None
    print(f"模型没有返回合法 JSON: {e}")
```

`with` 语句（上下文管理器）保证资源用完被释放，即使中途出错：

```python
from pathlib import Path

with open(Path("notes") / "todo.txt", encoding="utf-8") as f:
    content = f.read()
# 离开 with 块时文件自动关闭
```

`pathlib.Path` 用 `/` 拼接路径，跨平台，比字符串拼接更安全。

## 7. 模块与入口

```python
# main.py
def main() -> None:
    ...

if __name__ == "__main__":   # 直接运行时才执行；被 import 时不执行
    main()
```

本站所有可运行的 Python 示例都采用这个结构。异步写法（`async def`、`await`）放在下一篇 [异步与并发编程](/guide/01-programming/async)。

## Go / Java 对照表

如果你主要写 Go 或 Java，下表帮你把本站 Python 示例「翻译」成熟悉的概念：

| Python | Go | Java |
| --- | --- | --- |
| 类型注解 `x: str \| None` | 静态类型；可空用指针 `*string` | 静态类型；可空用 `null` 或 `Optional` |
| `@dataclass` | `struct` | `record`（Java 16+） |
| `dict` / `list` | `map` / slice | `Map` / `List` |
| `json.loads` / `json.dumps` | `json.Unmarshal` / `json.Marshal` | Jackson `readValue` / `writeValueAsString` |
| 装饰器 `@tool` | 无直接对应，常用注册函数 `Register(name, fn)` | 注解 `@Tool` + 反射（如 Spring AI） |
| `func(**args)` | 把 JSON 解析到参数 struct | 把 JSON 映射到参数 record |
| 生成器 `yield` | channel 或回调函数 | `Iterator`、`Stream` 或回调 |
| `try / except` | 多返回值 `if err != nil` | `try / catch` |
| `with open(...)` | `defer f.Close()` | try-with-resources |
| `async` / `await` | goroutine + channel | `CompletableFuture`、虚拟线程（Java 21） |
| pydantic | struct tag + 校验库 | record + Jackson + Bean Validation |

## 常见坑

- **可变默认参数**：`def f(items=[])` 中的列表在多次调用间共享。用 `None` 作默认值，或在 dataclass 里用 `field(default_factory=list)`。
- **忘记 `json.loads`**：模型返回的工具参数是字符串，不是 dict，直接 `args["city"]` 会报 `TypeError`。
- **中文变成 `\uXXXX`**：`json.dumps` 默认转义非 ASCII 字符，加 `ensure_ascii=False`。
- **用 `eval` 处理模型输出**：模型输出是不可信输入，`eval` 等于让模型在你的机器上执行任意代码。
- **IDE 用错解释器**：包装在 `.venv` 里，IDE 却用系统 Python，提示找不到模块。

## 小测

**1. 下面代码有什么问题？**

```python
@dataclass
class Session:
    history: list = []
```

::: details 查看答案
`dataclass` 不允许可变对象作默认值，定义时就会抛 `ValueError`。正确写法是 `history: list = field(default_factory=list)`，这样每个实例都有自己的列表。
:::

**2. 模型返回了工具调用 `name="get_weather"`、`arguments='{"city": "北京"}'`，如何安全地执行？**

::: details 查看答案
先用 `name` 在白名单注册表（如 `TOOLS` dict）中查找函数，找不到就返回错误；再用 `json.loads` 解析 `arguments`，捕获解析错误；最后 `func(**args)` 调用，并捕获参数不匹配的 `TypeError`。更严格的做法是用 pydantic 校验参数类型和取值范围。绝不使用 `eval`。
:::

**3. 为什么流式输出适合用生成器表示？**

::: details 查看答案
流式输出的数据是陆续到达的，总长度事先未知。生成器每次产出一段就暂停，调用方可以立即显示或处理，不必等全部完成，内存占用也小。
:::

## 延伸阅读

- [Python 官方教程（中文）](https://docs.python.org/zh-cn/3/tutorial/index.html)
- [dataclasses 文档](https://docs.python.org/3/library/dataclasses.html)
- [typing 文档](https://docs.python.org/3/library/typing.html)
- 本站：[数据校验](/guide/01-programming/data-validation)、[实现第一个工具](/guide/05-tool-calling/first-tool)

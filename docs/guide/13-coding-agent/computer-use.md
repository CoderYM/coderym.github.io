---
title: Computer Use
description: 让模型看截图、输出鼠标键盘动作来操作桌面：原理、Anthropic computer use 工具的用法，以及必须放在虚拟机里运行的安全要求。
---

# Computer Use

::: info 学习目标
- 理解 Computer Use 的"截图 → 动作 → 截图"循环，以及它和浏览器 DOM 自动化的区别
- 了解 Anthropic computer use 工具的基本用法：工具声明、动作类型、截图回传
- 搞清楚坐标缩放、动作校验、步数上限这些实现细节
- 建立安全底线：只在隔离的虚拟机或容器中运行，不接触真实账户和数据
:::

## 什么是 Computer Use

Computer Use 指让模型像人一样操作一台电脑：**看屏幕截图，输出"在 (x, y) 点击""输入这段文字""按 Ctrl+S"这样的动作**，由程序在真实或虚拟的桌面上执行，然后再截一张图交给模型，如此循环。

```text
     ┌────────────────────────────────────────────┐
     │                 多模态 LLM                   │
     │  看截图 → 输出动作 {"action": "left_click",     │
     │                   "coordinate": [640, 412]}  │
     └───────────────┬─────────────────▲──────────┘
             tool_use │                 │ tool_result（新截图）
                      ▼                 │
     ┌──────────────────────────────────┴─────────┐
     │  你的程序（动作执行器）                        │
     │  校验动作 → 坐标换算 → 鼠标/键盘 → 截图          │
     └───────────────┬────────────────────────────┘
                     ▼
     ┌────────────────────────────────────────────┐
     │  隔离的虚拟机 / 容器桌面（Xvfb、VNC 等）         │
     └────────────────────────────────────────────┘
```

它和上一篇的 [浏览器自动化 Agent](/guide/13-coding-agent/browser-automation) 是两条不同的路线：

| 维度 | 浏览器 DOM 自动化 | Computer Use（截图路线） |
| --- | --- | --- |
| 观察方式 | 页面文本、元素列表、无障碍树 | 屏幕截图 |
| 操作方式 | 按元素点击、填写 | 按像素坐标点击、敲键盘 |
| 适用范围 | 只能操作网页 | 任何桌面应用：浏览器、Office、老旧 GUI 系统 |
| 成本与速度 | 文本便宜、快 | 每步一张图，Token 多、慢 |
| 精确度 | 高，元素定位确定 | 依赖模型的视觉定位，可能点偏 |

结论很直接：**能用 API 就用 API，只能用网页就用 DOM 自动化，只有没有其他接口的桌面应用才考虑 Computer Use。**

## Anthropic 的 computer use 工具

Anthropic 在 Claude API 中提供了 computer use 工具，目前仍是 **beta 功能并在持续演进**：工具类型名带日期版本号（如 `computer_20250124`），调用时需要带对应的 beta 标记，不同模型支持的版本和动作集合不完全相同。写代码前请先查阅官方文档确认当前版本。

它的工作方式和普通 [Tool Calling](/guide/05-tool-calling/concept) 一样，区别在于：

1. **工具由 Anthropic 预定义。** 你只需要声明工具类型和屏幕尺寸（`display_width_px`、`display_height_px`），不需要写 JSON Schema，模型已经被训练过如何使用它。
2. **模型输出的是动作。** `tool_use` 块的 `input` 里是类似 `{"action": "left_click", "coordinate": [x, y]}`、`{"action": "type", "text": "..."}`、`{"action": "key", "text": "ctrl+s"}`、`{"action": "screenshot"}` 的动作。
3. **执行由你负责。** Anthropic 不替你操作电脑。你的程序要在自己的环境里执行这些动作，并把截图作为 `tool_result` 的图片内容回传。

Anthropic 官方提供了一个基于 Docker 的参考实现（见延伸阅读），里面包含虚拟桌面、动作执行器和 Web 界面，是上手最快的方式。

## 动手：最小的动作执行器

下面是一个最小的循环，用 `pyautogui` 执行动作。这个示例 **只有 Python 版本**：Anthropic 官方 SDK 与参考实现以 Python 为主，Go 和 Java 可以按同样的消息结构调用 HTTP API 实现。

几个关键点：

- **坐标缩放。** 告诉模型的屏幕尺寸是 1280×800，截图也缩放到这个尺寸；模型返回的坐标再按比例换算回真实屏幕。截图尺寸和声明尺寸不一致，是"总是点偏"最常见的原因。
- **动作白名单。** 只执行你支持的动作，其他一律返回错误文本。输入文本限制长度。
- **每步回传截图。** 模型需要看到动作的结果，才能决定下一步。
- **步数上限。** Computer Use 每一步都很贵，必须限制总步数。

工具类型和 beta 标记做成环境变量，方便随官方版本更新调整。

```python
# 只能在专用虚拟机或容器的桌面里运行！它会真实地移动鼠标、敲键盘。
# pip install anthropic pyautogui pillow
import base64
import io
import os

import anthropic
import pyautogui

client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"], timeout=120)
MODEL = os.getenv("CLAUDE_MODEL", "claude-sonnet-5-5")
# 工具类型与 beta 标记随模型版本变化，以官方文档为准
TOOL_TYPE = os.getenv("COMPUTER_TOOL_TYPE", "computer_20250124")
BETA_FLAG = os.getenv("COMPUTER_BETA_FLAG", "computer-use-2025-01-24")

W, H = 1280, 800  # 告诉模型的屏幕尺寸；截图缩放到这个尺寸
MAX_STEPS = 30
ALLOWED_ACTIONS = {"screenshot", "left_click", "type", "key", "mouse_move", "scroll"}


def screenshot_b64() -> str:
    img = pyautogui.screenshot().resize((W, H))  # 缩放到声明的尺寸，坐标才对得上
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def to_screen(x: int, y: int) -> tuple[int, int]:
    """模型坐标基于 W x H，换算回真实屏幕坐标，并夹在屏幕范围内。"""
    sw, sh = pyautogui.size()
    return (min(max(int(x * sw / W), 0), sw - 1), min(max(int(y * sh / H), 0), sh - 1))


def perform(action: dict) -> list[dict]:
    """执行一个动作，返回 tool_result 的 content（文本或截图）。"""
    kind = action.get("action")
    if kind not in ALLOWED_ACTIONS:
        return [{"type": "text", "text": f"不支持的动作：{kind}"}]
    if kind in ("left_click", "mouse_move"):
        x, y = to_screen(*action["coordinate"])
        (pyautogui.click if kind == "left_click" else pyautogui.moveTo)(x, y)
    elif kind == "type":
        pyautogui.write(action["text"][:1000], interval=0.02)
    elif kind == "key":  # 模型给出 xdotool 风格，如 "Return"、"ctrl+s"
        keys = [k.lower().replace("return", "enter") for k in action["text"].split("+")]
        pyautogui.hotkey(*keys)
    elif kind == "scroll":
        amount = int(action.get("scroll_amount", 3))
        pyautogui.scroll(amount if action.get("scroll_direction") == "up" else -amount)
    # 每个动作后都回传一张新截图，让模型看到结果
    return [{"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                          "data": screenshot_b64()}}]


def run(task: str) -> None:
    tools = [{"type": TOOL_TYPE, "name": "computer",
              "display_width_px": W, "display_height_px": H}]
    messages = [{"role": "user", "content": task}]
    for step in range(MAX_STEPS):
        resp = client.beta.messages.create(
            model=MODEL, max_tokens=1024, tools=tools, messages=messages, betas=[BETA_FLAG])
        messages.append({"role": "assistant", "content": resp.content})
        if resp.stop_reason != "tool_use":
            print("".join(b.text for b in resp.content if b.type == "text"))
            return
        results = []
        for block in resp.content:
            if block.type == "tool_use":
                print(f"step {step}: {block.input}")
                results.append({"type": "tool_result", "tool_use_id": block.id,
                                "content": perform(block.input)})
        messages.append({"role": "user", "content": results})
    print("达到步数上限")


if __name__ == "__main__":
    run("打开桌面上的文本编辑器，新建文件，输入 hello computer use 并保存到 ~/hello.txt")
```

上面的代码使用 `client.beta.messages.create` 并传入 `betas` 参数，这是 Anthropic Python SDK 调用 beta 功能的方式。工具类型、beta 标记和可用动作以 [官方文档](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/computer-use-tool) 为准，示例中的默认值只用于说明结构。

## 安全：必须在隔离环境里运行

Computer Use 是本模块风险最高的一类 Agent。模型会真实地移动鼠标、敲键盘，它能做的事情等于坐在这台电脑前的人能做的事情。官方文档同样强调了这些风险。底线要求：

1. **只在专用的虚拟机或容器中运行。** 绝不在你的日常电脑上直接运行上面的脚本。虚拟机里只放完成任务所需的最少应用和数据，用完即销毁。
2. **不接触真实账户和敏感数据。** 虚拟机里不登录个人邮箱、网银、公司系统，不放密钥文件。需要登录的步骤由人完成。
3. **限制网络。** 尽量只允许访问任务需要的域名，避免 Agent 被引导到恶意站点或把数据发出去。
4. **把屏幕上的内容当作不可信输入。** 网页、文档、弹窗里的文字都可能是 [Prompt 注入](/guide/15-production/prompt-injection)，模型可能照着屏幕上的"指令"去做。
5. **高风险动作人工确认。** 付款、发送、删除、修改系统设置这类操作，执行前暂停并请求人工确认，见 [权限控制与人在环路](/guide/15-production/permissions-hitl)。
6. **全程录制与日志。** 保存每一步的截图和动作，出问题时可以回放审查。

```text
宿主机（你的电脑 / 服务器）
└─ 虚拟机或容器（一次性）
   ├─ 虚拟显示（Xvfb）+ 精简桌面
   ├─ 仅任务所需的应用
   ├─ 网络：出站白名单
   └─ 动作执行器 ←→ LLM API
      └─ 高风险动作 → 暂停，等待人工确认
```

隔离环境的具体搭建方式，见下一篇 [沙箱与代码执行安全](/guide/13-coding-agent/sandbox)。

## 现实预期

- **慢且贵。** 每一步都要传一张截图，完成一个简单任务可能需要几十步。
- **会点偏、会迷路。** 弹窗、加载延迟、分辨率变化都会让模型困惑。需要重试和超时机制。
- **适合低频、无接口的场景。** 比如操作没有 API 的老旧内部系统、做 GUI 测试的探索，而不是替代稳定的自动化脚本。

## 常见坑

- **截图尺寸和声明尺寸不一致。** 模型按声明尺寸给坐标，截图却是另一个分辨率，点击全部偏移。统一缩放并换算坐标。
- **在宿主机上直接运行。** 一次误操作就可能删除文件、发出邮件。必须隔离。
- **不限制步数。** 模型在一个弹窗前反复尝试，几十张截图的费用就花出去了。
- **硬编码工具版本。** beta 工具的类型名和标记会随版本变化，做成配置并关注官方更新。
- **用 Computer Use 做有 API 的事。** 既慢又不稳定，先找 API 或 DOM 自动化方案。

## 小测

1. Computer Use 和基于 Playwright 的浏览器 Agent 各适合什么场景？

::: details 查看答案
浏览器 Agent 读取 DOM、按元素操作，便宜、快、精确，但只能操作网页。Computer Use 看截图、按坐标操作，能操作任何桌面应用，但慢、贵、可能点偏。只能通过网页完成的任务优先用浏览器 Agent；没有 API 也不是网页的桌面应用才考虑 Computer Use。
:::

2. 模型的点击总是偏离目标一段距离，最可能的原因是什么？

::: details 查看答案
回传的截图尺寸和工具声明的 `display_width_px`/`display_height_px` 不一致，或执行动作时没有把模型坐标按比例换算回真实屏幕坐标。应把截图缩放到声明尺寸，并在执行时换算坐标。
:::

3. 为什么说"在系统提示词里告诉模型不要做危险操作"不足以保证 Computer Use 的安全？

::: details 查看答案
模型可能误操作，也可能被屏幕上的 Prompt 注入内容诱导，提示词约束只是概率性的。真正的保障来自环境层面：一次性虚拟机隔离、不放真实账户和数据、网络白名单、高风险动作人工确认，以及完整的操作日志。
:::

## 延伸阅读

- [Computer use tool 官方文档（Anthropic）](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/computer-use-tool)
- [Anthropic computer use 参考实现](https://github.com/anthropics/anthropic-quickstarts)：仓库中的 computer-use-demo 目录
- [PyAutoGUI 文档](https://pyautogui.readthedocs.io/)
- 本站：[多模态输入：图片与文档](/guide/03-llm-api/multimodal)、[沙箱与代码执行安全](/guide/13-coding-agent/sandbox)

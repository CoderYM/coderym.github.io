---
title: Coding Agent 原理
description: Claude Code、Cursor、SWE-agent 这类编码 Agent 的共同架构：读、搜、改、跑测试的工具集，编辑-测试循环，以及仓库上下文检索。
---

# Coding Agent 原理

::: info 学习目标
- 理解编码 Agent 的通用架构：一个 Agent 循环加上读、搜、改、执行四类工具
- 掌握"编辑-测试循环"为什么是编码 Agent 的核心，以及它对工具设计的要求
- 了解两种仓库上下文检索思路：Agent 自主搜索与预建索引
- 动手实现带路径约束的读文件、精确替换编辑、白名单测试命令三个工具
:::

## 编码 Agent 的共同骨架

Claude Code、Cursor 的 Agent 模式、SWE-agent、Aider、OpenHands 这些工具的界面差别很大（命令行、IDE、Web），但内部骨架高度一致：**一个标准的 [Agent 循环](/guide/06-agent-loop/react)，加上一组专门为代码仓库设计的工具**。

```text
┌──────────────────────────────────────────────────────────────┐
│ 上下文                                                         │
│  系统提示词（编码规范、工具用法） + 项目说明文件 + 用户任务            │
└───────────────────────────────┬──────────────────────────────┘
                                ▼
                    ┌──────────────────────┐
           ┌──────▶ │  LLM：决定下一步       │ ──── 完成 ──▶ 汇报改动
           │        └──────────┬───────────┘
           │                   │ tool call
           │     ┌─────────────┼──────────────┬───────────────┐
           │     ▼             ▼              ▼               ▼
           │  搜索            读取           编辑             执行
           │  glob/grep      read_file      edit_file        run_tests
           │  符号/语义检索    （按行分页）     （精确替换）       shell 命令
           │     │             │              │               │
           └─────┴─────────────┴──────────────┴───────────────┘
                         tool result（文件内容、diff、测试输出）
```

各个产品之间的差异，主要在三个地方：

| 维度 | 不同做法 |
| --- | --- |
| 交互形态 | 终端（Claude Code、Aider）、IDE 内嵌（Cursor）、无人值守批处理（SWE-agent 跑基准测试） |
| 上下文检索 | 让 Agent 用 grep/glob 自己搜；预先给仓库建 Embedding 索引做语义检索；用语法树生成仓库结构摘要 |
| 权限模型 | 每次编辑或执行命令都询问用户；按命令白名单自动放行；在容器里完全放开 |

下面分别展开。

## 工具集：为什么是读、搜、改、跑

人类工程师修一个 Bug 的过程是：找到相关代码 → 读懂 → 修改 → 跑测试验证 → 不通过再改。编码 Agent 的工具集就是把这个过程拆成原子操作。

**搜索工具** 解决"相关代码在哪"。最常见的是按文件名模式查找（glob）和按内容正则搜索（grep，很多工具底层用 ripgrep）。有的产品还提供语义检索或"跳转到定义"这类基于语言服务的工具。

**读取工具** 一定要 **分页**。一个 5000 行的文件整个读进来会占满上下文，而模型通常只需要其中几十行。好的读取工具返回带行号的片段，并告诉模型文件总行数，让它决定是否继续往下读。

**编辑工具** 是设计最讲究的部分。常见三种方式：

| 方式 | 做法 | 优点 | 缺点 |
| --- | --- | --- | --- |
| 整文件重写 | 模型输出修改后的完整文件 | 实现简单 | 大文件浪费 Token；容易误删无关代码 |
| 统一 diff | 模型输出 unified diff | 紧凑 | 模型经常算错行号和上下文，补丁打不上 |
| 精确字符串替换 | 模型给出 `old` 和 `new`，`old` 必须在文件中唯一出现 | 不依赖行号，失败可解释 | `old` 要包含足够上下文才能唯一 |

Claude Code 的编辑工具采用的就是精确字符串替换（str_replace 风格），很多开源 Agent 也采用这种方式。它的关键在于 **失败时给出可操作的错误信息**："没找到"提示模型先重新读文件，"出现多次"提示它加更多上下文。

**执行工具** 让 Agent 运行测试、编译、Lint。这是编码 Agent 区别于"代码补全"的根本：它能 **验证自己的修改**。执行工具也是风险最高的工具，后面的代码和 [沙箱与代码执行安全](/guide/13-coding-agent/sandbox) 会专门讲。

## 编辑-测试循环

编码 Agent 的效果，很大程度取决于它能否拿到 **客观、快速的反馈**。

```text
   ┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────────┐
   │ 定位代码   │ ──▶ │ 修改代码   │ ──▶ │ 运行测试   │ ──▶ │ 通过？         │
   └──────────┘     └──────────┘     └──────────┘     └──┬────────┬──┘
        ▲                ▲                               │否      │是
        │                └──── 读失败信息，调整修改 ◀──────┘         ▼
        └──── 失败信息指向别处，重新定位                         汇报改动
```

几点工程经验：

- **先复现再修改。** 修 Bug 时让 Agent 先写一个能复现问题的测试或脚本，确认它失败，再修代码，再确认它通过。这样"通过"才有意义。
- **测试输出要截断、保留末尾。** 测试框架的失败摘要通常在输出最后。上万行日志塞回上下文，模型反而找不到重点。
- **编辑后立即做语法检查。** SWE-agent 论文里的一个发现是：在编辑命令里集成 Lint，语法错误的编辑直接被拒绝并返回错误，能明显减少 Agent 在坏状态里打转。
- **设置循环上限。** 同一个测试连续失败 N 次，就停下来向用户汇报现状，而不是无限尝试。见 [终止条件、步数与预算控制](/guide/06-agent-loop/stop-budget)。

## 仓库上下文：怎么找到相关代码

一个中型仓库有几十万行代码，不可能全部放进上下文。主流有两种思路：

**Agent 自主搜索（agentic search）。** 不建索引，Agent 像人一样用 glob、grep 一步步找：先搜关键字，看到函数名再搜它的调用方。Claude Code 主要采用这种方式。优点是结果永远和磁盘上的代码一致，不用维护索引；缺点是要多花几步工具调用，对模型的搜索能力要求高。

**预建索引检索。** 预先把仓库切块、算 Embedding、存进向量库，查询时做语义检索，本质是 [RAG](/guide/09-rag/overview) 在代码上的应用。Cursor 提供了代码库索引功能。另一种轻量做法是 Aider 的 repo map：用 tree-sitter 解析出文件、类、函数签名，生成一份紧凑的仓库结构摘要放进上下文。

| 思路 | 适合 | 注意 |
| --- | --- | --- |
| 自主搜索 | 代码变化频繁、关键词明确的任务 | 搜索结果也要截断，避免一次 grep 返回上千行 |
| 语义索引 | "用户认证是在哪里做的"这类模糊问题 | 索引要随代码更新；切块要按函数或类边界 |
| 结构摘要 | 让模型快速了解仓库全貌 | 摘要本身也占 Token，大仓库要按相关性裁剪 |

此外几乎所有工具都支持一个 **项目说明文件**（例如 Claude Code 的 `CLAUDE.md`），放构建命令、测试命令、代码规范，每次会话自动加载。这是最便宜也最有效的上下文工程手段之一。

## SWE-agent：接口设计决定效果

[SWE-agent](/papers/swe-agent) 是普林斯顿团队的研究工作，在 SWE-bench（从真实 GitHub issue 构建的修 Bug 基准）上评估。它最重要的观点是 **Agent-Computer Interface（ACI）**：给 Agent 设计的工具接口，应该像给人设计的 UI 一样认真。论文中的具体做法包括：文件查看器一次只显示固定行数的窗口并标明位置；搜索结果做汇总而不是原样倾倒；编辑命令集成语法检查。这些设计比直接给模型一个原始 shell 效果更好。

## 动手：三个核心工具

下面实现编码 Agent 最核心的三个工具。重点在安全约束：

- **路径约束**：模型给出的路径先解析成真实路径（处理 `../` 和符号链接），必须位于仓库目录内。
- **精确替换**：`old` 必须恰好出现一次，失败返回给模型可操作的提示。
- **命令白名单**：模型只能选择命令名，不能拼接任意命令。用参数数组启动进程、不经过 shell、设置超时、截断输出。

这三个函数接入 Agent 的方式与 [实现第一个工具](/guide/05-tool-calling/first-tool) 相同：为每个函数写 JSON Schema，在循环里按 `tool_calls` 分发。

::: code-group
```python [Python]
import subprocess
import sys
from pathlib import Path

REPO = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
MAX_READ_LINES = 400
# 允许 Agent 运行的命令白名单：只给命令名到固定参数前缀的映射
ALLOWED_COMMANDS = {
    "pytest": ["python", "-m", "pytest", "-q"],
    "go_test": ["go", "test", "./..."],
}


def resolve_in_repo(rel: str) -> Path:
    """把模型给的相对路径解析成仓库内的真实路径，拒绝 ../ 和符号链接逃逸。"""
    p = (REPO / rel).resolve()
    if not p.is_relative_to(REPO):
        raise ValueError(f"路径越界：{rel}")
    return p


def read_file(path: str, offset: int = 1, limit: int = 200) -> str:
    """按行读取，带行号，限制单次行数，避免把大文件整个塞进上下文。"""
    p = resolve_in_repo(path)
    lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
    limit = max(1, min(limit, MAX_READ_LINES))
    start = max(offset, 1)
    chunk = lines[start - 1:start - 1 + limit]
    body = "\n".join(f"{start + i:>5}\t{line}" for i, line in enumerate(chunk))
    return f"{path}（共 {len(lines)} 行）\n{body}"


def edit_file(path: str, old: str, new: str) -> str:
    """精确字符串替换：old 必须在文件中恰好出现一次，否则拒绝并告诉模型原因。"""
    p = resolve_in_repo(path)
    text = p.read_text(encoding="utf-8")
    count = text.count(old)
    if count == 0:
        return "错误：未找到 old 文本。请先 read_file 确认原文（包括缩进和空格）。"
    if count > 1:
        return f"错误：old 文本出现了 {count} 次，请包含更多上下文使其唯一。"
    p.write_text(text.replace(old, new, 1), encoding="utf-8")
    return f"已修改 {path}"


def run_tests(name: str, timeout: int = 120) -> str:
    """只运行白名单命令；参数数组、不经过 shell；超时；截断输出。"""
    if name not in ALLOWED_COMMANDS:
        return f"错误：不允许的命令 {name}，可选：{list(ALLOWED_COMMANDS)}"
    try:
        proc = subprocess.run(
            ALLOWED_COMMANDS[name], cwd=REPO, capture_output=True,
            text=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return f"错误：超时（{timeout}s）"
    except FileNotFoundError as e:
        return f"错误：命令不存在：{e}"
    output = (proc.stdout + proc.stderr)[-4000:]  # 保留末尾，失败信息通常在最后
    return f"exit_code={proc.returncode}\n{output}"


if __name__ == "__main__":
    demo = REPO / "demo.txt"
    demo.write_text("def add(a, b):\n    return a - b\n", encoding="utf-8")
    print(read_file("demo.txt"))
    print(edit_file("demo.txt", "return a - b", "return a + b"))
    print(read_file("demo.txt"))
    try:
        read_file("../../etc/passwd")
    except ValueError as e:
        print(e)
    demo.unlink()
```

```go [Go]
package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const maxReadLines = 400

var repo string

// 允许 Agent 运行的命令白名单：命令名到固定参数数组的映射
var allowedCommands = map[string][]string{
	"pytest":  {"python", "-m", "pytest", "-q"},
	"go_test": {"go", "test", "./..."},
}

// resolveInRepo 把模型给的相对路径解析成仓库内的真实路径，拒绝 ../ 和符号链接逃逸。
func resolveInRepo(rel string) (string, error) {
	p, err := filepath.EvalSymlinks(filepath.Join(repo, rel))
	if err != nil {
		return "", err
	}
	r, err := filepath.Rel(repo, p)
	if err != nil || r == ".." || strings.HasPrefix(r, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("路径越界：%s", rel)
	}
	return p, nil
}

// readFile 按行读取，带行号，限制单次行数。
func readFile(path string, offset, limit int) (string, error) {
	p, err := resolveInRepo(path)
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return "", err
	}
	lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	limit = max(1, min(limit, maxReadLines))
	start := max(offset, 1)
	var sb strings.Builder
	fmt.Fprintf(&sb, "%s（共 %d 行）\n", path, len(lines))
	for i := start - 1; i < len(lines) && i < start-1+limit; i++ {
		fmt.Fprintf(&sb, "%5d\t%s\n", i+1, lines[i])
	}
	return sb.String(), nil
}

// editFile 精确字符串替换：old 必须恰好出现一次。
func editFile(path, old, new string) (string, error) {
	p, err := resolveInRepo(path)
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return "", err
	}
	text := string(data)
	switch n := strings.Count(text, old); {
	case old == "" || n == 0:
		return "错误：未找到 old 文本。请先 read_file 确认原文（包括缩进和空格）。", nil
	case n > 1:
		return fmt.Sprintf("错误：old 文本出现了 %d 次，请包含更多上下文使其唯一。", n), nil
	}
	info, err := os.Stat(p)
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(p, []byte(strings.Replace(text, old, new, 1)), info.Mode().Perm()); err != nil {
		return "", err
	}
	return "已修改 " + path, nil
}

// runTests 只运行白名单命令；参数数组、不经过 shell；超时；截断输出。
func runTests(name string, timeout time.Duration) string {
	args, ok := allowedCommands[name]
	if !ok {
		return "错误：不允许的命令 " + name
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, args[0], args[1:]...)
	cmd.Dir = repo
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return fmt.Sprintf("错误：超时（%s）", timeout)
	}
	code := 0
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		code = exitErr.ExitCode()
	} else if err != nil {
		return "错误：" + err.Error()
	}
	s := out.String()
	if len(s) > 4000 { // 保留末尾，失败信息通常在最后
		s = s[len(s)-4000:]
	}
	return fmt.Sprintf("exit_code=%d\n%s", code, s)
}

func main() {
	dir := "."
	if len(os.Args) > 1 {
		dir = os.Args[1]
	}
	var err error
	if repo, err = filepath.Abs(dir); err == nil {
		repo, err = filepath.EvalSymlinks(repo)
	}
	if err != nil {
		panic(err)
	}
	demo := filepath.Join(repo, "demo.txt")
	_ = os.WriteFile(demo, []byte("def add(a, b):\n    return a - b\n"), 0o644)
	defer os.Remove(demo)

	s, _ := readFile("demo.txt", 1, 200)
	fmt.Print(s)
	msg, _ := editFile("demo.txt", "return a - b", "return a + b")
	fmt.Println(msg)
	s, _ = readFile("demo.txt", 1, 200)
	fmt.Print(s)
	if _, err := readFile("../../etc/passwd", 1, 10); err != nil {
		fmt.Println(err)
	}
	fmt.Println(runTests("rm_rf", time.Minute))
}
```

```java [Java]
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

public class CodingTools {
    static final int MAX_READ_LINES = 400;
    // 允许 Agent 运行的命令白名单：命令名到固定参数数组的映射
    static final Map<String, List<String>> ALLOWED_COMMANDS = Map.of(
            "pytest", List.of("python", "-m", "pytest", "-q"),
            "go_test", List.of("go", "test", "./..."));

    final Path repo;

    CodingTools(Path repo) throws IOException {
        this.repo = repo.toRealPath();
    }

    /** 把模型给的相对路径解析成仓库内的真实路径，拒绝 ../ 和符号链接逃逸。 */
    Path resolveInRepo(String rel) throws IOException {
        Path p = repo.resolve(rel).normalize();
        if (!p.startsWith(repo)) throw new SecurityException("路径越界：" + rel);
        Path real = p.toRealPath(); // 解析符号链接后再检查一次
        if (!real.startsWith(repo)) throw new SecurityException("路径越界：" + rel);
        return real;
    }

    /** 按行读取，带行号，限制单次行数。 */
    String readFile(String path, int offset, int limit) throws IOException {
        List<String> lines = Files.readAllLines(resolveInRepo(path), StandardCharsets.UTF_8);
        int lim = Math.max(1, Math.min(limit, MAX_READ_LINES));
        int start = Math.max(offset, 1);
        StringBuilder sb = new StringBuilder(path + "（共 " + lines.size() + " 行）\n");
        for (int i = start - 1; i < lines.size() && i < start - 1 + lim; i++) {
            sb.append(String.format("%5d\t%s%n", i + 1, lines.get(i)));
        }
        return sb.toString();
    }

    /** 精确字符串替换：old 必须恰好出现一次。 */
    String editFile(String path, String old, String replacement) throws IOException {
        Path p = resolveInRepo(path);
        String text = Files.readString(p, StandardCharsets.UTF_8);
        int first = old.isEmpty() ? -1 : text.indexOf(old);
        if (first < 0) return "错误：未找到 old 文本。请先 read_file 确认原文（包括缩进和空格）。";
        if (text.indexOf(old, first + 1) >= 0) return "错误：old 文本出现了多次，请包含更多上下文使其唯一。";
        Files.writeString(p, text.substring(0, first) + replacement + text.substring(first + old.length()),
                StandardCharsets.UTF_8);
        return "已修改 " + path;
    }

    /** 只运行白名单命令；参数数组、不经过 shell；超时；截断输出。 */
    String runTests(String name, long timeoutSeconds) throws IOException, InterruptedException {
        List<String> cmd = ALLOWED_COMMANDS.get(name);
        if (cmd == null) return "错误：不允许的命令 " + name;
        Path log = Files.createTempFile("agent-test", ".log");
        try {
            Process proc = new ProcessBuilder(cmd).directory(repo.toFile())
                    .redirectErrorStream(true).redirectOutput(log.toFile()).start();
            if (!proc.waitFor(timeoutSeconds, TimeUnit.SECONDS)) {
                proc.destroyForcibly();
                return "错误：超时（" + timeoutSeconds + "s）";
            }
            String out = Files.readString(log, StandardCharsets.UTF_8);
            if (out.length() > 4000) out = out.substring(out.length() - 4000); // 保留末尾
            return "exit_code=" + proc.exitValue() + "\n" + out;
        } finally {
            Files.deleteIfExists(log);
        }
    }

    public static void main(String[] args) throws Exception {
        CodingTools tools = new CodingTools(Path.of(args.length > 0 ? args[0] : "."));
        Path demo = tools.repo.resolve("demo.txt");
        Files.writeString(demo, "def add(a, b):\n    return a - b\n");
        try {
            System.out.print(tools.readFile("demo.txt", 1, 200));
            System.out.println(tools.editFile("demo.txt", "return a - b", "return a + b"));
            System.out.print(tools.readFile("demo.txt", 1, 200));
            try {
                tools.readFile("../../etc/passwd", 1, 10);
            } catch (SecurityException e) {
                System.out.println(e.getMessage());
            }
            System.out.println(tools.runTests("rm_rf", 60));
        } finally {
            Files.deleteIfExists(demo);
        }
    }
}
```
:::

运行时传入一个目录作为"仓库"，例如 `python tools.py /tmp/demo-repo`。演示会创建 `demo.txt`，修复其中的 Bug，再尝试读取 `../../etc/passwd` 和运行不在白名单里的命令，两者都会被拒绝。

需要说明：这些约束只是应用层的第一道防线。白名单里的 `pytest` 会执行仓库里的任意测试代码，而这些代码可能就是 Agent 刚写的。所以真正无人值守运行时，整个 Agent 应该跑在容器或虚拟机里，见 [沙箱与代码执行安全](/guide/13-coding-agent/sandbox)。

## 常见坑

- **读取不分页。** 整个文件或整个 grep 结果塞回上下文，几步之后上下文就满了。读取和搜索都要有行数上限和截断提示。
- **用行号做编辑。** 模型对行号的把握不可靠，前一次编辑之后行号还会变化。优先使用精确字符串替换。
- **编辑失败的错误信息含糊。** 只返回"编辑失败"，模型会盲目重试。要说清是"没找到"还是"不唯一"，并告诉它下一步该做什么。
- **把 shell 完全交给模型。** `bash -c` 加模型生成的字符串，等于允许任意命令。要么用白名单，要么在隔离环境里运行，并对危险操作做人工确认，见 [权限控制与人在环路](/guide/15-production/permissions-hitl)。
- **没有测试就让 Agent 改代码。** 没有客观反馈，Agent 只能靠"看起来对"判断是否完成。至少要有能运行的测试、类型检查或编译。
- **仓库里的内容也是不可信输入。** README、注释、Issue 里可能藏着针对 Agent 的指令。见 [Prompt 注入与防护](/guide/15-production/prompt-injection)。

## 小测

1. 编辑工具为什么要求 `old` 在文件中"恰好出现一次"？

::: details 查看答案
出现零次说明模型对文件内容的记忆有误，需要先重新读取；出现多次时无法确定模型想改哪一处，盲目替换可能改错位置。要求唯一并返回具体的错误原因，能让模型自己修正（重读文件或在 `old` 中加入更多上下文）。
:::

2. 对比"Agent 自主搜索"和"预建 Embedding 索引"两种仓库检索方式的主要取舍。

::: details 查看答案
自主搜索不需要维护索引，结果总是和当前代码一致，适合关键词明确的任务，但要多花几步工具调用，依赖模型的搜索策略。预建索引擅长回答模糊的语义问题，但索引需要随代码变化更新，切块质量直接影响效果，并且有额外的基础设施成本。
:::

3. 为什么说"编辑-测试循环"是编码 Agent 区别于代码补全的关键？

::: details 查看答案
代码补全只生成代码，不验证；编码 Agent 能运行测试、编译或 Lint，拿到客观的失败信息，再据此修改，直到验证通过。可验证的反馈让 Agent 能自我纠错，这也是编码任务特别适合 Agent 的原因。
:::

## 延伸阅读

- [SWE-agent 论文解读](/papers/swe-agent)，原文：[SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering](https://arxiv.org/abs/2405.15793)
- [SWE-agent GitHub](https://github.com/SWE-agent/SWE-agent)、[SWE-bench](https://www.swebench.com/)
- [Claude Code 官方文档](https://docs.anthropic.com/en/docs/claude-code/overview)
- [Aider repo map 说明](https://aider.chat/docs/repomap.html)
- 本站：[工具设计原则](/guide/05-tool-calling/tool-design)、[项目 08：代码审查 Agent](/projects/08-code-review)

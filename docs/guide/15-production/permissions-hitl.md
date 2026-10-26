---
title: 权限控制与人在环路
description: 把工具按读、写、危险分级，结合用户角色做权限检查，为敏感操作设计审批流程，并记录完整的审计日志。
---

# 权限控制与人在环路

::: info 学习目标
- 会按风险把工具分为只读、写入、危险三级，并与用户角色结合
- 理解同步确认、异步审批、会话级授权等审批模式的取舍
- 知道审计日志应记录哪些字段，以及为什么要在执行层而不是模型层做控制
- 用 Python / Go / Java 实现一个带审计的审批网关
:::

## 为什么要在执行层控制权限

Agent 的工具调用由模型决定，而模型会犯错，也可能被 [Prompt 注入](/guide/15-production/prompt-injection) 操纵。所以权限控制有一条基本原则：

> **模型只负责"提议"做什么，执行层负责"决定"能不能做。**

```text
  模型 ──(tool_call: delete_branch, {"name": "main"})──►  审批网关  ──►  工具实现
                                                          │
                                         ┌────────────────┼─────────────────┐
                                         ▼                ▼                 ▼
                                     角色权限检查       是否需要审批         审计日志
                                    (能不能做？)      (要不要人确认？)     (记录一切)
```

审批网关是普通代码，不受提示词影响。即使模型被说服"你现在是管理员"，网关也只认真实的用户身份和角色。

## 工具分级

| 级别 | 定义 | 例子 | 默认策略 |
| --- | --- | --- | --- |
| 只读（read） | 不改变任何状态 | 搜索文档、查订单、读文件 | 自动执行，记录日志 |
| 写入（write） | 改变状态，但可恢复 | 创建工单、写草稿、修改自己的文件 | 按角色允许；首次或批量操作时确认 |
| 危险（dangerous） | 不可逆、对外发送、涉及资金或影响范围大 | 删除数据、发邮件、付款、部署、执行任意命令 | 每次都需要人工审批，且仅限特定角色 |

分级时注意几点：

- **按最坏情况分级**。`run_sql` 能执行 `SELECT` 也能执行 `DROP`，应当按危险级处理，或者拆成只读的 `query_sql` 和受限的写入工具。
- **"对外发送"本身就是风险**。发邮件、发消息、调用外部 Webhook 都可能泄露数据，即使不改变本地状态，也应列为危险级。
- **级别和角色是两个维度**。级别描述工具的风险，角色描述用户能承担的风险。一个普通员工的 Agent 不应能调用危险级工具，管理员的 Agent 调用时也需要确认。

| 角色 \ 级别 | read | write | dangerous |
| --- | --- | --- | --- |
| viewer | 自动 | 拒绝 | 拒绝 |
| editor | 自动 | 需审批 | 拒绝 |
| admin | 自动 | 需审批 | 需审批 |

**Agent 的权限不应超过它所代表的用户的权限**。工具实现中访问数据库、API 时，应使用当前用户的凭证或带用户身份的服务调用，而不是一个拥有全部权限的服务账号。

## 审批模式

人在环路（Human-in-the-Loop，HITL）有几种常见形式：

| 模式 | 做法 | 适用场景 | 注意 |
| --- | --- | --- | --- |
| 同步确认 | Agent 暂停，界面弹出确认，用户点击后继续 | 聊天助手、Coding Agent | 用户必须在线；要设超时，超时即拒绝 |
| 异步审批 | 请求进入审批队列，由有权限的人（可能不是发起人）审批 | 企业流程、财务操作 | Agent 状态需要持久化，审批后恢复执行；审批请求要有过期时间 |
| 计划审批 | Agent 先输出完整计划，人审核整份计划后批量执行 | 批量修改、数据迁移 | 执行时参数不能偏离已批准的计划 |
| 会话级授权 | 用户选择"本次会话内允许此类操作" | 频繁的低风险写入 | 只适用于写入级，不适用于危险级 |

异步审批需要 Agent 能"暂停并恢复"。这要求把 Agent 的状态（消息历史、待执行的工具调用）持久化，审批完成后从断点继续。LangGraph 提供了 `interrupt` 机制来实现这一点，见 [LangGraph](/guide/11-frameworks/langgraph)。

### 审批界面要展示什么

审批是否有效，很大程度上取决于审批者看到了什么：

- **真实的工具名和完整参数**，而不是模型生成的描述；
- **影响范围**：会影响多少条记录、哪些文件、发给谁；
- **触发原因**：是哪条用户消息引发的这次调用，上下文中是否有外部内容；
- **明确的选项**：批准、拒绝、修改参数后批准。

### 审批疲劳

如果每次操作都要确认，用户很快会养成不看就点"批准"的习惯，审批形同虚设。缓解办法：

- 只读操作不打扰用户；
- 写入级操作可用会话级授权或规则（如"允许在 `/workspace` 下写文件"）；
- 把审批集中在真正危险的操作上；
- 批量操作合并为一次计划审批。

## 审计日志

审计日志用来回答"谁、在什么时候、让 Agent 做了什么、谁批准的、结果如何"。每次工具调用都应记录，包括被拒绝的：

| 字段 | 说明 |
| --- | --- |
| `ts` | 时间戳 |
| `user` / `role` | 发起请求的真实用户和角色 |
| `session_id` / `trace_id` | 关联会话和 [轨迹](/guide/14-evaluation/observability) |
| `tool` / `tier` | 工具名和风险级别 |
| `args` | 参数（敏感字段脱敏） |
| `decision` | allowed / denied / approved / rejected |
| `approver` | 审批人（自动执行时为 `auto`） |
| `result` / `error` | 执行结果摘要或错误 |

审计日志应当**只追加、不可修改**，存储在 Agent 无法写入的位置。生产环境中通常写入专门的日志服务或数据库，并设置保留期限。

## 动手：带审计的审批网关

下面实现一个审批网关：工具注册时声明级别，执行前按"角色 × 级别"策略决定自动执行、拒绝或请求审批，所有决策写入 `audit.jsonl`。审批者抽象成接口，示例用命令行确认，生产环境可以替换为 Web 界面或审批队列。

在 Agent 循环中，把原来"直接执行工具"的代码换成 `gate.execute(user, tool_name, args)`，并把返回值（包括"已拒绝"）作为工具结果交还给模型，让模型知道操作没有执行。

::: code-group
```python [Python]
# gate.py  仅用标准库
import json
import time
from dataclasses import dataclass
from typing import Callable, Protocol

POLICY = {  # 角色 -> 级别 -> auto | approve | deny
    "viewer": {"read": "auto", "write": "deny", "dangerous": "deny"},
    "editor": {"read": "auto", "write": "approve", "dangerous": "deny"},
    "admin": {"read": "auto", "write": "approve", "dangerous": "approve"},
}
SENSITIVE_KEYS = {"password", "token", "api_key"}


@dataclass(frozen=True)
class User:
    id: str
    role: str


@dataclass
class Tool:
    name: str
    tier: str  # read | write | dangerous
    fn: Callable[..., str]


class Approver(Protocol):
    def approve(self, user: User, tool: Tool, args: dict) -> tuple[bool, str]: ...


class ConsoleApprover:
    def approve(self, user, tool, args):
        print(f"\n[审批] 用户 {user.id} 请求执行 {tool.name}（{tool.tier}）")
        print(f"       参数: {json.dumps(args, ensure_ascii=False)}")
        ok = input("       批准？[y/N] ").strip().lower() == "y"
        return ok, "console"


def redact(args: dict) -> dict:
    return {k: ("***" if k.lower() in SENSITIVE_KEYS else v) for k, v in args.items()}


class Gate:
    def __init__(self, tools: list[Tool], approver: Approver, audit_path: str = "audit.jsonl"):
        self.tools = {t.name: t for t in tools}
        self.approver = approver
        self.audit_path = audit_path

    def _audit(self, **rec) -> None:
        rec["ts"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        with open(self.audit_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    def execute(self, user: User, name: str, args: dict) -> str:
        base = {"user": user.id, "role": user.role, "tool": name, "args": redact(args)}
        tool = self.tools.get(name)
        if tool is None:
            self._audit(**base, decision="denied", reason="unknown tool")
            return f"错误：工具 {name} 不存在"
        mode = POLICY.get(user.role, {}).get(tool.tier, "deny")  # 未知角色默认拒绝
        base["tier"] = tool.tier
        if mode == "deny":
            self._audit(**base, decision="denied", reason="policy")
            return f"已拒绝：角色 {user.role} 无权执行 {tool.tier} 级工具 {name}"
        approver = "auto"
        if mode == "approve":
            ok, approver = self.approver.approve(user, tool, args)
            if not ok:
                self._audit(**base, decision="rejected", approver=approver)
                return f"已拒绝：{name} 未获批准，操作没有执行"
        try:
            result = tool.fn(**args)
        except Exception as e:
            self._audit(**base, decision="approved", approver=approver, error=str(e))
            return f"工具执行失败：{e}"
        self._audit(**base, decision="approved", approver=approver, result=result[:200])
        return result


NOTES: dict[str, str] = {"todo": "买牛奶"}

TOOLS = [
    Tool("read_note", "read", lambda name: NOTES.get(name, "（不存在）")),
    Tool("write_note", "write", lambda name, text: NOTES.__setitem__(name, text) or "已保存"),
    Tool("delete_note", "dangerous", lambda name: "已删除" if NOTES.pop(name, None) else "不存在"),
]

if __name__ == "__main__":
    gate = Gate(TOOLS, ConsoleApprover())
    alice, bob = User("alice", "editor"), User("bob", "viewer")
    print(gate.execute(alice, "read_note", {"name": "todo"}))
    print(gate.execute(alice, "write_note", {"name": "todo", "text": "买牛奶和面包"}))
    print(gate.execute(alice, "delete_note", {"name": "todo"}))
    print(gate.execute(bob, "write_note", {"name": "x", "text": "y"}))
    print("审计日志已写入 audit.jsonl")
```
```go [Go]
// main.go  仅用标准库
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
)

var policy = map[string]map[string]string{ // 角色 -> 级别 -> auto | approve | deny
	"viewer": {"read": "auto", "write": "deny", "dangerous": "deny"},
	"editor": {"read": "auto", "write": "approve", "dangerous": "deny"},
	"admin":  {"read": "auto", "write": "approve", "dangerous": "approve"},
}

var sensitiveKeys = map[string]bool{"password": true, "token": true, "api_key": true}

type User struct{ ID, Role string }

type Tool struct {
	Name string
	Tier string // read | write | dangerous
	Fn   func(args map[string]string) (string, error)
}

type Approver interface {
	Approve(u User, t Tool, args map[string]string) (bool, string)
}

type ConsoleApprover struct{ in *bufio.Reader }

func (c ConsoleApprover) Approve(u User, t Tool, args map[string]string) (bool, string) {
	a, _ := json.Marshal(args)
	fmt.Printf("\n[审批] 用户 %s 请求执行 %s（%s）\n       参数: %s\n       批准？[y/N] ", u.ID, t.Name, t.Tier, a)
	line, _ := c.in.ReadString('\n')
	return strings.TrimSpace(strings.ToLower(line)) == "y", "console"
}

func redact(args map[string]string) map[string]string {
	out := make(map[string]string, len(args))
	for k, v := range args {
		if sensitiveKeys[strings.ToLower(k)] {
			v = "***"
		}
		out[k] = v
	}
	return out
}

type Gate struct {
	tools     map[string]Tool
	approver  Approver
	auditPath string
	mu        sync.Mutex
}

func NewGate(tools []Tool, approver Approver) *Gate {
	g := &Gate{tools: map[string]Tool{}, approver: approver, auditPath: "audit.jsonl"}
	for _, t := range tools {
		g.tools[t.Name] = t
	}
	return g
}

func (g *Gate) audit(rec map[string]any) {
	rec["ts"] = time.Now().Format(time.RFC3339)
	line, _ := json.Marshal(rec)
	g.mu.Lock()
	defer g.mu.Unlock()
	f, err := os.OpenFile(g.auditPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		fmt.Fprintln(os.Stderr, "audit write failed:", err)
		return
	}
	defer f.Close()
	f.Write(append(line, '\n'))
}

func (g *Gate) Execute(u User, name string, args map[string]string) string {
	rec := map[string]any{"user": u.ID, "role": u.Role, "tool": name, "args": redact(args)}
	tool, ok := g.tools[name]
	if !ok {
		rec["decision"], rec["reason"] = "denied", "unknown tool"
		g.audit(rec)
		return "错误：工具 " + name + " 不存在"
	}
	rec["tier"] = tool.Tier
	mode := policy[u.Role][tool.Tier] // 未知角色或级别得到 ""，按拒绝处理
	if mode != "auto" && mode != "approve" {
		rec["decision"], rec["reason"] = "denied", "policy"
		g.audit(rec)
		return fmt.Sprintf("已拒绝：角色 %s 无权执行 %s 级工具 %s", u.Role, tool.Tier, name)
	}
	approver := "auto"
	if mode == "approve" {
		var approved bool
		approved, approver = g.approver.Approve(u, tool, args)
		if !approved {
			rec["decision"], rec["approver"] = "rejected", approver
			g.audit(rec)
			return "已拒绝：" + name + " 未获批准，操作没有执行"
		}
	}
	rec["decision"], rec["approver"] = "approved", approver
	result, err := tool.Fn(args)
	if err != nil {
		rec["error"] = err.Error()
		g.audit(rec)
		return "工具执行失败：" + err.Error()
	}
	if r := []rune(result); len(r) > 200 {
		rec["result"] = string(r[:200])
	} else {
		rec["result"] = result
	}
	g.audit(rec)
	return result
}

func main() {
	notes := map[string]string{"todo": "买牛奶"}
	tools := []Tool{
		{"read_note", "read", func(a map[string]string) (string, error) {
			if v, ok := notes[a["name"]]; ok {
				return v, nil
			}
			return "（不存在）", nil
		}},
		{"write_note", "write", func(a map[string]string) (string, error) {
			notes[a["name"]] = a["text"]
			return "已保存", nil
		}},
		{"delete_note", "dangerous", func(a map[string]string) (string, error) {
			if _, ok := notes[a["name"]]; !ok {
				return "不存在", nil
			}
			delete(notes, a["name"])
			return "已删除", nil
		}},
	}
	gate := NewGate(tools, ConsoleApprover{bufio.NewReader(os.Stdin)})
	alice, bob := User{"alice", "editor"}, User{"bob", "viewer"}
	fmt.Println(gate.Execute(alice, "read_note", map[string]string{"name": "todo"}))
	fmt.Println(gate.Execute(alice, "write_note", map[string]string{"name": "todo", "text": "买牛奶和面包"}))
	fmt.Println(gate.Execute(alice, "delete_note", map[string]string{"name": "todo"}))
	fmt.Println(gate.Execute(bob, "write_note", map[string]string{"name": "x", "text": "y"}))
	fmt.Println("审计日志已写入 audit.jsonl")
}
```
```java [Java]
// Gate.java  依赖：com.fasterxml.jackson.core:jackson-databind
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.OffsetDateTime;
import java.util.*;
import java.util.function.Function;

public class Gate {

    record User(String id, String role) {}
    record Tool(String name, String tier, Function<Map<String, String>, String> fn) {}
    record Approval(boolean approved, String approver) {}

    interface Approver {
        Approval approve(User user, Tool tool, Map<String, String> args);
    }

    static final Map<String, Map<String, String>> POLICY = Map.of( // 角色 -> 级别 -> auto | approve | deny
            "viewer", Map.of("read", "auto", "write", "deny", "dangerous", "deny"),
            "editor", Map.of("read", "auto", "write", "approve", "dangerous", "deny"),
            "admin", Map.of("read", "auto", "write", "approve", "dangerous", "approve"));
    static final Set<String> SENSITIVE_KEYS = Set.of("password", "token", "api_key");
    static final ObjectMapper MAPPER = new ObjectMapper();

    static class ConsoleApprover implements Approver {
        private final BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));

        @Override
        public Approval approve(User user, Tool tool, Map<String, String> args) {
            System.out.printf("%n[审批] 用户 %s 请求执行 %s（%s）%n       参数: %s%n       批准？[y/N] ",
                    user.id(), tool.name(), tool.tier(), args);
            try {
                String line = in.readLine();
                return new Approval(line != null && line.strip().equalsIgnoreCase("y"), "console");
            } catch (IOException e) {
                return new Approval(false, "console");
            }
        }
    }

    private final Map<String, Tool> tools = new HashMap<>();
    private final Approver approver;
    private final Path auditPath = Path.of("audit.jsonl");

    Gate(List<Tool> tools, Approver approver) {
        tools.forEach(t -> this.tools.put(t.name(), t));
        this.approver = approver;
    }

    static Map<String, String> redact(Map<String, String> args) {
        Map<String, String> out = new LinkedHashMap<>();
        args.forEach((k, v) -> out.put(k, SENSITIVE_KEYS.contains(k.toLowerCase(Locale.ROOT)) ? "***" : v));
        return out;
    }

    private synchronized void audit(Map<String, Object> rec) {
        rec.put("ts", OffsetDateTime.now().toString());
        try {
            Files.writeString(auditPath, MAPPER.writeValueAsString(rec) + "\n", StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } catch (IOException e) {
            System.err.println("audit write failed: " + e.getMessage());
        }
    }

    String execute(User user, String name, Map<String, String> args) {
        Map<String, Object> rec = new LinkedHashMap<>(Map.of(
                "user", user.id(), "role", user.role(), "tool", name, "args", redact(args)));
        Tool tool = tools.get(name);
        if (tool == null) {
            rec.put("decision", "denied");
            rec.put("reason", "unknown tool");
            audit(rec);
            return "错误：工具 " + name + " 不存在";
        }
        rec.put("tier", tool.tier());
        String mode = POLICY.getOrDefault(user.role(), Map.of()).getOrDefault(tool.tier(), "deny");
        if (mode.equals("deny")) {
            rec.put("decision", "denied");
            rec.put("reason", "policy");
            audit(rec);
            return "已拒绝：角色 " + user.role() + " 无权执行 " + tool.tier() + " 级工具 " + name;
        }
        String by = "auto";
        if (mode.equals("approve")) {
            Approval a = approver.approve(user, tool, args);
            by = a.approver();
            if (!a.approved()) {
                rec.put("decision", "rejected");
                rec.put("approver", by);
                audit(rec);
                return "已拒绝：" + name + " 未获批准，操作没有执行";
            }
        }
        rec.put("decision", "approved");
        rec.put("approver", by);
        try {
            String result = tool.fn().apply(args);
            rec.put("result", result.length() > 200 ? result.substring(0, 200) : result);
            audit(rec);
            return result;
        } catch (RuntimeException e) {
            rec.put("error", e.getMessage());
            audit(rec);
            return "工具执行失败：" + e.getMessage();
        }
    }

    public static void main(String[] args) {
        Map<String, String> notes = new HashMap<>(Map.of("todo", "买牛奶"));
        List<Tool> tools = List.of(
                new Tool("read_note", "read", a -> notes.getOrDefault(a.get("name"), "（不存在）")),
                new Tool("write_note", "write", a -> { notes.put(a.get("name"), a.get("text")); return "已保存"; }),
                new Tool("delete_note", "dangerous", a -> notes.remove(a.get("name")) != null ? "已删除" : "不存在"));
        Gate gate = new Gate(tools, new ConsoleApprover());
        User alice = new User("alice", "editor"), bob = new User("bob", "viewer");
        System.out.println(gate.execute(alice, "read_note", Map.of("name", "todo")));
        System.out.println(gate.execute(alice, "write_note", Map.of("name", "todo", "text", "买牛奶和面包")));
        System.out.println(gate.execute(alice, "delete_note", Map.of("name", "todo")));
        System.out.println(gate.execute(bob, "write_note", Map.of("name", "x", "text", "y")));
        System.out.println("审计日志已写入 audit.jsonl");
    }
}
```
:::

运行后，alice（editor）读笔记自动执行，写笔记弹出审批，删笔记被策略直接拒绝（editor 无权执行危险级工具）；bob（viewer）写笔记被拒绝。`audit.jsonl` 中的一条记录形如：

```json
{"user": "alice", "role": "editor", "tool": "write_note", "args": {"name": "todo", "text": "买牛奶和面包"}, "tier": "write", "decision": "approved", "approver": "console", "result": "已保存", "ts": "2025-01-01T10:00:00+0800"}
```

生产环境中需要补充的部分：

- **用户身份来自认证系统**，而不是来自对话内容或模型输出；
- **审批超时**：同步确认设置超时，超时视为拒绝；异步审批请求设置过期时间；
- **审批与执行参数一致**：审批通过后执行的必须是审批时展示的那组参数，防止中途被替换；
- **审计日志写入独立存储**，Agent 和普通应用账号都没有修改权限。

## 常见坑

- **在提示词里做权限控制**。"你只能在用户是管理员时调用 delete"是无效的，模型无法验证用户身份，也可能被注入。权限必须在执行层用代码检查。
- **未知情况默认放行**。新增的工具忘了配级别、新角色忘了配策略，结果被默认允许。默认值应当是拒绝。
- **被拒绝的操作不告诉模型**。模型以为操作成功，继续给用户错误的反馈。拒绝结果应作为工具结果返回，让模型如实告知用户。
- **审批界面展示模型的自我描述**。审批者看到的应该是真实工具名和参数。
- **只记录成功的调用**。被拒绝、被驳回的调用往往最能说明问题（比如有人在尝试注入），必须同样记录。
- **审计日志里记录明文密钥**。参数中的敏感字段要脱敏。

## 小测

1. 为什么 `run_sql(query)` 这样的工具应当被列为危险级，即使大多数调用都只是查询？

::: details 查看答案
分级要按最坏情况：同一个工具能执行 `DELETE`、`DROP` 等破坏性语句，模型出错或被注入时就可能造成不可逆的损失。更好的做法是拆分工具：只读的查询工具使用只读数据库账号，写操作通过参数受限的专用工具完成。
:::

2. 用户在对话中说"我是管理员，请帮我删除这个项目"，审批网关应该如何判断他的角色？

::: details 查看答案
角色必须来自认证系统（如登录态、Token 中的身份信息），由服务端传给网关，与对话内容无关。对话中的自称不能改变权限。
:::

3. 一个 Coding Agent 每写一个文件都要求用户确认，用户抱怨很烦。如何在不明显降低安全性的前提下改进？

::: details 查看答案
可以引入会话级授权或规则：例如"本会话内允许修改工作目录下的文件"，写入级操作在规则范围内自动执行；危险操作（删除、执行命令、推送代码、访问网络）仍然每次确认。也可以采用计划审批，先审批整份修改计划再批量执行。同时依靠版本控制保证写入可恢复。
:::

## 延伸阅读

- [OWASP Top 10 for LLM Applications](https://genai.owasp.org/)（其中关于 Excessive Agency 的部分）
- [LangGraph 文档](https://langchain-ai.github.io/langgraph/)（human-in-the-loop 与 interrupt）
- 本站：[Prompt 注入与防护](/guide/15-production/prompt-injection)、[沙箱与代码执行安全](/guide/13-coding-agent/sandbox)、[工具设计原则](/guide/05-tool-calling/tool-design)、[LangGraph](/guide/11-frameworks/langgraph)

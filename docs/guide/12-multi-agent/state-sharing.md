---
title: 状态共享与通信
description: 多 Agent 之间怎么传信息：消息传递、共享历史、黑板与文件产物，以及版本、权限和溯源的工程做法。
---

# 状态共享与通信

::: info 学习目标
- 区分四种通信方式：消息传递、共享对话历史、黑板（共享状态）、文件产物
- 理解"传什么、传多少"比"怎么传"更重要，学会写给子 Agent 的任务简报
- 实现一个带命名空间权限、版本号乐观锁和写入日志的黑板（Python / Go / Java）
- 知道并发写入、上下文膨胀、信息溯源这几类问题的处理办法
:::

多 Agent 系统里最常见的失败，不是某个 Agent 不够聪明，而是 **它不知道别的 Agent 已经知道了什么**。上一篇 [编排模式](/guide/12-multi-agent/patterns) 讲了谁调用谁，这一篇讲信息怎么流动。

## 四种通信方式

```text
1. 消息传递（Message Passing）           2. 共享对话历史（Shared Transcript）
   A ──"子任务说明"──▶ B                   ┌──────────────────────────┐
   A ◀──"结果摘要"──── B                   │ msg1(A) msg2(B) msg3(A).. │ ◀── A、B 都读写
                                          └──────────────────────────┘

3. 黑板（Blackboard / Shared State）      4. 文件产物（Artifacts）
   ┌─────────────────────┐                 A ──写入──▶ /work/report_a.md
   │ shared/requirements │ ◀── A 写         B ──写入──▶ /work/report_b.md
   │ researcher_a/milvus │ ◀── B 读         主 Agent 只拿到文件路径，按需读取
   └─────────────────────┘
```

| 方式 | 优点 | 缺点 | 适合 |
| --- | --- | --- | --- |
| 消息传递 | 简单、上下文隔离最好 | 信息有损，取决于摘要质量 | 主从模式的派发与回收 |
| 共享对话历史 | 信息最完整 | 上下文快速膨胀，Agent 容易被别人的内容带偏 | 两三个 Agent 的短对话、交接 |
| 黑板 | 结构化、可校验、可追踪 | 需要设计 schema 和并发控制 | 多个 Agent 协作维护同一份事实 |
| 文件产物 | 大块内容不进上下文，按需读取 | 需要文件系统或对象存储，要管权限 | 长报告、代码、数据集 |

实践中常常组合使用：用消息传递派活，用黑板维护共享事实（需求、约束、已确认的结论），用文件存放大块产物，消息里只传路径。

## 传什么：写好任务简报

消息传递是最常用的方式，而它的质量几乎完全取决于 **主 Agent 写给子 Agent 的那段话**。子 Agent 从零开始，不知道用户是谁、之前讨论过什么、为什么要做这件事。一份合格的任务简报应该包含：

```text
目标：    调研 Qdrant 的索引类型和分布式部署方式
背景：    用户要为 Go 后端选向量库，数据量约 5000 万条，倾向自建
范围：    只看官方文档和官方 GitHub；不要调研其他数据库（其他人在做）
已知：    用户已排除需要 JVM 的方案
输出格式：JSON {"index_types": [...], "distributed": "...", "sources": [url...]}
完成标准：每条结论附来源；找不到就写 "unknown"，不要猜
```

回收方向同样重要：要求子 Agent 返回 **结构化结果 + 来源**，而不是一大段散文。这样主 Agent 汇总时能校验字段、对比矛盾，后续出问题也能追溯到是哪个子 Agent、依据哪个来源得出的结论。

## 黑板：维护一份共享事实

当多个 Agent 需要协作维护同一份信息（比如"已确认的需求""当前方案的约束"），消息传递就不够了：A 更新了约束，B 已经在跑，B 不会自动知道。这时用一个 **黑板**：一个所有 Agent 都能读、按规则写的共享存储。

一个可用的黑板至少要解决三件事：

1. **权限**：每个 Agent 只能写自己的命名空间（`researcher_a/...`）或明确的共享区（`shared/...`），不能改别人的结论。
2. **并发写入**：两个 Agent 基于同一个旧版本各自修改并写回，后写的会静默覆盖先写的。用 **版本号乐观锁** 解决：写入时带上读到的版本号，版本不匹配就拒绝，让 Agent 重新读取再决定。
3. **溯源**：每次写入记录作者、版本、时间，并保留追加日志，出问题时能回放。

另外，渲染进提示词时 **只选相关条目**，不要把整块黑板塞进每个 Agent 的上下文。

::: code-group
```python [Python]
import json
import threading
import time
from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class Entry:
    key: str
    value: dict
    author: str
    version: int
    ts: float


class VersionConflict(Exception):
    pass


class Blackboard:
    """线程安全的共享状态：命名空间权限 + 版本号乐观锁 + 追加日志。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._data: dict[str, Entry] = {}
        self._log: list[Entry] = []  # 所有写入按时间保留，便于追踪

    def write(self, author: str, key: str, value: dict,
              expected_version: int | None = None) -> int:
        # 每个 Agent 只能写自己的命名空间或 shared/
        if not (key.startswith(f"{author}/") or key.startswith("shared/")):
            raise PermissionError(f"{author} 无权写入 {key}")
        with self._lock:
            cur = self._data.get(key)
            cur_ver = cur.version if cur else 0
            if expected_version is not None and expected_version != cur_ver:
                raise VersionConflict(f"{key}: 期望版本 {expected_version}，实际 {cur_ver}")
            entry = Entry(key, value, author, cur_ver + 1, time.time())
            self._data[key] = entry
            self._log.append(entry)
            return entry.version

    def read(self, key: str) -> Entry | None:
        with self._lock:
            return self._data.get(key)

    def render(self, prefixes: list[str]) -> str:
        """只把相关条目渲染进提示词，而不是整块状态。"""
        with self._lock:
            picked = [asdict(e) for k, e in sorted(self._data.items())
                      if any(k.startswith(p) for p in prefixes)]
        return json.dumps(picked, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    bb = Blackboard()
    bb.write("planner", "shared/requirements", {"budget": "低", "deploy": "自建"})
    bb.write("researcher_a", "researcher_a/milvus", {"index": ["HNSW", "IVF"], "source": "官方文档"})

    ver = bb.read("shared/requirements").version
    bb.write("researcher_b", "shared/requirements", {"budget": "低", "deploy": "自建", "lang": "Go"},
             expected_version=ver)
    try:  # 基于旧版本的写入会被拒绝，避免静默覆盖
        bb.write("researcher_a", "shared/requirements", {"budget": "高"}, expected_version=ver)
    except VersionConflict as e:
        print("冲突：", e)
    try:
        bb.write("researcher_a", "researcher_b/notes", {"x": 1})
    except PermissionError as e:
        print("拒绝：", e)

    print(bb.render(["shared/"]))
```

```go [Go]
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

type Entry struct {
	Key     string         `json:"key"`
	Value   map[string]any `json:"value"`
	Author  string         `json:"author"`
	Version int            `json:"version"`
	TS      time.Time      `json:"ts"`
}

var (
	ErrVersionConflict = errors.New("version conflict")
	ErrPermission      = errors.New("permission denied")
)

// Blackboard 线程安全的共享状态：命名空间权限 + 版本号乐观锁 + 追加日志。
type Blackboard struct {
	mu   sync.Mutex
	data map[string]Entry
	log  []Entry
}

func NewBlackboard() *Blackboard { return &Blackboard{data: map[string]Entry{}} }

// Write 中 expectedVersion < 0 表示不做版本检查。
func (b *Blackboard) Write(author, key string, value map[string]any, expectedVersion int) (int, error) {
	if !strings.HasPrefix(key, author+"/") && !strings.HasPrefix(key, "shared/") {
		return 0, fmt.Errorf("%w: %s 无权写入 %s", ErrPermission, author, key)
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	cur := b.data[key].Version // 不存在时为 0
	if expectedVersion >= 0 && expectedVersion != cur {
		return 0, fmt.Errorf("%w: %s 期望版本 %d，实际 %d", ErrVersionConflict, key, expectedVersion, cur)
	}
	e := Entry{Key: key, Value: value, Author: author, Version: cur + 1, TS: time.Now()}
	b.data[key] = e
	b.log = append(b.log, e)
	return e.Version, nil
}

func (b *Blackboard) Read(key string) (Entry, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	e, ok := b.data[key]
	return e, ok
}

// Render 只把相关条目渲染进提示词，而不是整块状态。
func (b *Blackboard) Render(prefixes ...string) (string, error) {
	b.mu.Lock()
	keys := make([]string, 0, len(b.data))
	for k := range b.data {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var picked []Entry
	for _, k := range keys {
		for _, p := range prefixes {
			if strings.HasPrefix(k, p) {
				picked = append(picked, b.data[k])
				break
			}
		}
	}
	b.mu.Unlock()
	out, err := json.MarshalIndent(picked, "", "  ")
	return string(out), err
}

func main() {
	bb := NewBlackboard()
	_, _ = bb.Write("planner", "shared/requirements", map[string]any{"budget": "低", "deploy": "自建"}, -1)
	_, _ = bb.Write("researcher_a", "researcher_a/milvus", map[string]any{"index": []string{"HNSW", "IVF"}}, -1)

	e, _ := bb.Read("shared/requirements")
	_, _ = bb.Write("researcher_b", "shared/requirements",
		map[string]any{"budget": "低", "deploy": "自建", "lang": "Go"}, e.Version)
	// 基于旧版本的写入会被拒绝，避免静默覆盖
	if _, err := bb.Write("researcher_a", "shared/requirements", map[string]any{"budget": "高"}, e.Version); err != nil {
		fmt.Println("冲突：", err)
	}
	if _, err := bb.Write("researcher_a", "researcher_b/notes", map[string]any{"x": 1}, -1); err != nil {
		fmt.Println("拒绝：", err)
	}
	out, err := bb.Render("shared/")
	if err != nil {
		panic(err)
	}
	fmt.Println(out)
}
```

```java [Java]
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/** 线程安全的共享状态：命名空间权限 + 版本号乐观锁 + 追加日志。 */
public class Blackboard {
    public record Entry(String key, Map<String, Object> value, String author, int version, String ts) {}

    public static class VersionConflictException extends RuntimeException {
        VersionConflictException(String msg) { super(msg); }
    }

    private final TreeMap<String, Entry> data = new TreeMap<>();
    private final List<Entry> log = new ArrayList<>();
    private final ObjectMapper mapper = new ObjectMapper().enable(SerializationFeature.INDENT_OUTPUT);

    /** expectedVersion 为 null 表示不做版本检查。 */
    public synchronized int write(String author, String key, Map<String, Object> value, Integer expectedVersion) {
        if (!key.startsWith(author + "/") && !key.startsWith("shared/")) {
            throw new SecurityException(author + " 无权写入 " + key);
        }
        Entry cur = data.get(key);
        int curVer = cur == null ? 0 : cur.version();
        if (expectedVersion != null && expectedVersion != curVer) {
            throw new VersionConflictException(key + ": 期望版本 " + expectedVersion + "，实际 " + curVer);
        }
        Entry e = new Entry(key, Map.copyOf(value), author, curVer + 1, Instant.now().toString());
        data.put(key, e);
        log.add(e);
        return e.version();
    }

    public synchronized Entry read(String key) {
        return data.get(key);
    }

    /** 只把相关条目渲染进提示词，而不是整块状态。 */
    public synchronized String render(List<String> prefixes) throws Exception {
        List<Entry> picked = data.values().stream()
                .filter(e -> prefixes.stream().anyMatch(p -> e.key().startsWith(p)))
                .toList();
        return mapper.writeValueAsString(picked);
    }

    public static void main(String[] args) throws Exception {
        Blackboard bb = new Blackboard();
        bb.write("planner", "shared/requirements", Map.of("budget", "低", "deploy", "自建"), null);
        bb.write("researcher_a", "researcher_a/milvus", Map.of("index", List.of("HNSW", "IVF")), null);

        int ver = bb.read("shared/requirements").version();
        bb.write("researcher_b", "shared/requirements", Map.of("budget", "低", "deploy", "自建", "lang", "Go"), ver);
        try { // 基于旧版本的写入会被拒绝，避免静默覆盖
            bb.write("researcher_a", "shared/requirements", Map.of("budget", "高"), ver);
        } catch (VersionConflictException e) {
            System.out.println("冲突：" + e.getMessage());
        }
        try {
            bb.write("researcher_a", "researcher_b/notes", Map.of("x", 1), null);
        } catch (SecurityException e) {
            System.out.println("拒绝：" + e.getMessage());
        }
        System.out.println(bb.render(List.of("shared/")));
    }
}
```
:::

上面是进程内的实现，用于说明机制。生产环境中黑板通常落在 Redis、Postgres 这类外部存储上，乐观锁对应 Postgres 里的 `UPDATE ... WHERE version = $1`，或 Redis 的 `WATCH`/`MULTI` 事务。

把黑板接入 Agent 也很直接：给 Agent 两个工具 `read_state(prefix)` 和 `write_state(key, value, expected_version)`，工具内部调用上面的方法。版本冲突时把错误信息原样返回给模型，模型会重新读取再写，这和 [工具错误处理与重试](/guide/05-tool-calling/error-handling) 的思路一致。

## 同步还是异步

| 方式 | 做法 | 优点 | 缺点 |
| --- | --- | --- | --- |
| 同步等待 | 主 Agent 派出子任务后阻塞，等全部返回再继续 | 简单、可预测、易调试 | 最慢的子任务决定总耗时 |
| 异步事件 | 子 Agent 完成后发事件，主 Agent 收到就处理 | 能边收边用，更快 | 状态机复杂，竞态难排查 |

大部分系统用同步等待就够了，前面主从示例就是这样做的。只有当子任务耗时差异很大、并且部分结果就能推进后续工作时，才值得上异步。跨进程、跨服务的 Agent 通信可以参考 [A2A 协议](/guide/10-mcp/a2a)，它把任务状态、消息、产物都做了标准化。

## 文件产物：大块内容不进上下文

当子 Agent 的产出很大（一份 5000 字的报告、一整个代码文件），把全文塞进返回消息会让主 Agent 上下文暴涨。更好的做法：

- 子 Agent 把产物写到工作目录或对象存储，消息里只返回 **路径 + 一句话摘要**。
- 主 Agent 需要细节时，用读文件工具按需读取。
- 工作目录按任务隔离，子 Agent 只能写自己的子目录，路径要做规范化校验，防止 `../` 越界。

这也是编码类 Agent 的常见做法：代码本身就在文件系统里，Agent 之间传的是"我改了哪些文件"。

## 常见坑

- **"传话游戏"。** 信息经过三四个 Agent 转述后严重失真。关键事实（需求、约束、数字）放进黑板或文件，不要靠层层摘要传递。
- **共享历史无限膨胀。** 让所有 Agent 读写同一份对话历史，几轮之后每个 Agent 都在读大量与自己无关的内容。只共享必要的部分，或为每个 Agent 生成定制视图。
- **静默覆盖。** 没有版本控制的共享状态，后写入的 Agent 会覆盖先写入的结论，而且没人知道。至少要有版本号和写入日志。
- **结论没有来源。** 主 Agent 汇总时无法判断两个矛盾的结论哪个可信。要求所有结论附来源或依据。
- **把黑板当成无限上下文。** 黑板内容最终还是要进提示词。按前缀或标签筛选，只给每个 Agent 看与它有关的部分。

## 小测

1. 两个子 Agent 同时读到 `shared/requirements` 的版本 3，各自修改后写回。没有版本控制会发生什么？乐观锁如何处理？

::: details 查看答案
没有版本控制时，后写入的会静默覆盖先写入的修改，先写入那方的更新丢失。乐观锁要求写入时带上读到的版本号：第一个写入成功，版本变为 4；第二个带着版本 3 写入时被拒绝，它需要重新读取最新内容，合并后再写。
:::

2. 子 Agent 生成了一份 8000 字的调研报告，应该如何交还给主 Agent？

::: details 查看答案
写入文件或对象存储，返回路径加简短摘要（以及结构化的关键结论）。主 Agent 需要细节时再用读文件工具按需读取，避免一次把全文塞进主 Agent 的上下文。
:::

3. 一份好的子任务简报至少要包含哪些要素？

::: details 查看答案
目标、必要背景（用户是谁、为什么做）、范围边界（做什么、不做什么、其他人在做什么）、已知约束、输出格式、完成标准（比如每条结论附来源，不确定就标注）。
:::

## 延伸阅读

- [How we built our multi-agent research system（Anthropic）](https://www.anthropic.com/engineering/multi-agent-research-system)：子 Agent 任务描述与产物传递的经验
- [Don't Build Multi-Agents（Cognition）](https://cognition.ai/blog/dont-build-multi-agents)：上下文共享不足导致的问题
- [A2A 协议官方仓库](https://github.com/a2aproject/A2A)
- 本站：[什么是上下文工程](/guide/07-context-engineering/overview)、[多 Agent 的坑与成本控制](/guide/12-multi-agent/pitfalls)

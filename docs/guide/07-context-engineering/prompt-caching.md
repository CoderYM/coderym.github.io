---
title: Prompt Caching
description: 理解前缀缓存的原理，对比 OpenAI 的自动缓存和 Anthropic 的显式 cache_control 断点，以及怎样排列上下文才能提高命中率。
---

# Prompt Caching

::: info 学习目标
- 理解 Prompt Caching 缓存的是什么，为什么只能缓存"前缀"
- 对比 OpenAI 自动缓存和 Anthropic 显式 `cache_control` 断点的用法
- 学会从响应的 `usage` 字段确认是否命中缓存
- 掌握提高命中率的上下文排列原则，知道哪些操作会让缓存失效
:::

## 缓存的是什么

模型处理输入时，会为每个 Token 计算一组中间结果（注意力机制里的 Key 和 Value，通常叫 KV Cache）。第 N 个 Token 的计算依赖它前面所有 Token 的结果，所以只要两个请求的前 N 个 Token 完全相同，这部分计算结果就可以直接复用。

这就是 Prompt Caching 的本质：服务端把一段输入前缀的计算结果存一段时间，后续请求如果以同样的前缀开头，就跳过这部分计算。直接的好处有两个：

- 成本更低：命中缓存的输入 Token 通常按大幅折扣计费（具体折扣以各厂商定价页为准）。
- 延迟更低：长前缀不用重新计算，首 Token 时间明显缩短。

关键限制是"前缀"和"完全相同"：

```text
request 1:  [system][tools][doc 20K tokens][user: Q1]
request 2:  [system][tools][doc 20K tokens][user: Q2]
            └──────── identical prefix ───────┘ └ new ┘
            cache hit for the prefix, only Q2 is computed

request 3:  [system v2][tools][doc 20K tokens][user: Q3]
             ^ one token changed at the start → everything after it misses
```

前缀中任何一个字符的变化，都会让它之后的全部内容失去缓存。这一条决定了后面所有的排列原则。

Agent 天然适合缓存：每一步都会重发系统提示词、工具定义和不断增长的历史，第 N 步的请求正好是第 N-1 步的请求加上新内容。排列得当的话，大部分输入 Token 都能命中缓存。

## 两种主流方式

| 维度 | OpenAI（自动缓存） | Anthropic（显式断点） |
| --- | --- | --- |
| 是否需要改代码 | 不需要，满足条件自动生效 | 需要在内容块上加 `cache_control` |
| 缓存粒度 | 系统自动按前缀匹配 | 由你标记的断点决定缓存到哪里 |
| 最小长度 | 前缀达到一定长度（文档写的是 1024 Token 起）才会缓存 | 每个模型有最小可缓存长度，不足时不缓存 |
| 有效期 | 一段时间不用后自动清除，由服务端管理 | 默认约 5 分钟，命中后刷新；部分模型支持更长的选项 |
| 写入成本 | 不额外收费 | 写入缓存的 Token 比普通输入略贵，读取大幅便宜 |
| 查看命中 | `usage.prompt_tokens_details.cached_tokens` | `usage.cache_creation_input_tokens` / `usage.cache_read_input_tokens` |

具体数值和支持的模型以官方文档为准，这些细节更新得比较频繁。其他兼容 OpenAI 接口的厂商（如 DeepSeek、通义千问）多数也有上下文缓存，但字段名和规则不完全一样，比如 DeepSeek 在 `usage` 里返回 `prompt_cache_hit_tokens`，使用前请查阅对应文档。

## OpenAI：自动缓存，验证命中

OpenAI 的缓存不需要任何参数，只要前缀足够长且完全一致就会生效。下面的代码用同一个长系统提示词连续发两个不同的问题，打印 `cached_tokens`。第一次通常为 0，第二次应该接近系统提示词的长度。

缓存命中不是绝对保证的：请求可能被路由到不同的机器，或者缓存已被清除。如果用其他厂商的兼容接口，这个字段可能不存在，代码里按 0 处理。

::: code-group
```python [Python]
import os

from openai import OpenAI

client = OpenAI(api_key=os.environ["OPENAI_API_KEY"],
                base_url=os.getenv("OPENAI_BASE_URL") or None, timeout=60)
MODEL = os.getenv("LLM_MODEL", "gpt-4o-mini")

# 稳定的长前缀：放在最前面，每次请求字节级一致（示例用重复条款凑够长度）
RULES = "\n".join(f"第 {i} 条：退货需在签收后 7 天内申请，商品需保持完好，赠品需一并退回。" for i in range(1, 121))
SYSTEM = "你是电商客服。严格依据以下售后条款回答，条款中没有的内容回答“请联系人工客服”。\n" + RULES


def ask(question: str) -> None:
    resp = client.chat.completions.create(
        model=MODEL,
        messages=[{"role": "system", "content": SYSTEM},     # 稳定前缀
                  {"role": "user", "content": question}])   # 变化的部分放最后
    u = resp.usage
    details = getattr(u, "prompt_tokens_details", None)
    cached = getattr(details, "cached_tokens", 0) or 0
    print(f"prompt_tokens={u.prompt_tokens} cached_tokens={cached}  问题：{question}")


if __name__ == "__main__":
    ask("签收 5 天了还能退货吗？")
    ask("赠品丢了怎么办？")  # 前缀相同，应命中缓存
```

```go [Go]
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

var httpClient = &http.Client{Timeout: 60 * time.Second}

func buildSystem() string {
	var b strings.Builder
	b.WriteString("你是电商客服。严格依据以下售后条款回答，条款中没有的内容回答“请联系人工客服”。\n")
	for i := 1; i <= 120; i++ { // 稳定的长前缀：每次请求字节级一致
		fmt.Fprintf(&b, "第 %d 条：退货需在签收后 7 天内申请，商品需保持完好，赠品需一并退回。\n", i)
	}
	return strings.TrimSuffix(b.String(), "\n")
}

func ask(system, question string) error {
	base := os.Getenv("OPENAI_BASE_URL")
	if base == "" {
		base = "https://api.openai.com/v1"
	}
	model := os.Getenv("LLM_MODEL")
	if model == "" {
		model = "gpt-4o-mini"
	}
	body, _ := json.Marshal(map[string]any{"model": model, "messages": []map[string]string{
		{"role": "system", "content": system}, // 稳定前缀
		{"role": "user", "content": question}, // 变化的部分放最后
	}})
	req, err := http.NewRequest("POST", strings.TrimRight(base, "/")+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+os.Getenv("OPENAI_API_KEY"))
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, data)
	}
	var out struct {
		Usage struct {
			PromptTokens        int `json:"prompt_tokens"`
			PromptTokensDetails struct {
				CachedTokens int `json:"cached_tokens"` // 字段缺失时为 0
			} `json:"prompt_tokens_details"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return err
	}
	fmt.Printf("prompt_tokens=%d cached_tokens=%d  问题：%s\n",
		out.Usage.PromptTokens, out.Usage.PromptTokensDetails.CachedTokens, question)
	return nil
}

func main() {
	system := buildSystem()
	for _, q := range []string{"签收 5 天了还能退货吗？", "赠品丢了怎么办？"} { // 第二次前缀相同，应命中缓存
		if err := ask(system, q); err != nil {
			fmt.Fprintln(os.Stderr, "出错:", err)
			os.Exit(1)
		}
	}
}
```

```java [Java]
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.stream.Collectors;
import java.util.stream.IntStream;

public class CacheDemo {
    static final ObjectMapper JSON = new ObjectMapper();
    static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();

    // 稳定的长前缀：放在最前面，每次请求字节级一致
    static final String SYSTEM = "你是电商客服。严格依据以下售后条款回答，条款中没有的内容回答“请联系人工客服”。\n"
            + IntStream.rangeClosed(1, 120)
                    .mapToObj(i -> "第 " + i + " 条：退货需在签收后 7 天内申请，商品需保持完好，赠品需一并退回。")
                    .collect(Collectors.joining("\n"));

    static void ask(String question) throws Exception {
        String base = Objects.requireNonNullElse(System.getenv("OPENAI_BASE_URL"), "https://api.openai.com/v1");
        String body = JSON.writeValueAsString(Map.of(
                "model", Objects.requireNonNullElse(System.getenv("LLM_MODEL"), "gpt-4o-mini"),
                "messages", List.of(
                        Map.of("role", "system", "content", SYSTEM),       // 稳定前缀
                        Map.of("role", "user", "content", question))));   // 变化的部分放最后
        HttpRequest req = HttpRequest.newBuilder(URI.create(base.replaceAll("/+$", "") + "/chat/completions"))
                .timeout(Duration.ofSeconds(60))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + System.getenv("OPENAI_API_KEY"))
                .POST(HttpRequest.BodyPublishers.ofString(body)).build();
        HttpResponse<String> resp = HTTP.send(req, HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() != 200) throw new RuntimeException("HTTP " + resp.statusCode() + ": " + resp.body());
        JsonNode usage = JSON.readTree(resp.body()).path("usage");
        System.out.printf("prompt_tokens=%d cached_tokens=%d  问题：%s%n",
                usage.path("prompt_tokens").asInt(),
                usage.path("prompt_tokens_details").path("cached_tokens").asInt(0), // 字段缺失时为 0
                question);
    }

    public static void main(String[] args) throws Exception {
        ask("签收 5 天了还能退货吗？");
        ask("赠品丢了怎么办？"); // 前缀相同，应命中缓存
    }
}
```
:::

可能的输出：

```text
prompt_tokens=3105 cached_tokens=0     问题：签收 5 天了还能退货吗？
prompt_tokens=3101 cached_tokens=2944  问题：赠品丢了怎么办？
```

缓存按块匹配，`cached_tokens` 一般不会正好等于系统提示词的长度，数值仅作示意。

## Anthropic：显式缓存断点

Anthropic 的 Messages API 需要你明确告诉它"缓存到哪里"：在某个内容块上加 `"cache_control": {"type": "ephemeral"}`，就是在这里设一个断点，从请求开头到这个块为止的全部内容会被缓存。几个规则：

- 前缀的拼接顺序是 `tools` → `system` → `messages`。断点放在 system 的最后一块，就同时缓存了工具定义和系统提示词。
- 一个请求最多可以设 4 个断点。命中时会使用能匹配上的最长前缀。
- 断点之前的内容少于模型的最小可缓存长度时，不会缓存，也不报错，`usage` 里看不到缓存数据。

多轮对话和 Agent 的常见用法是两个断点：一个在 system 末尾（稳定部分），一个在最后一条消息上（让下一轮能复用到这一轮为止的全部历史）。

这一节只给 Python 版，因为它展示的是 Anthropic 官方 SDK（`pip install anthropic`）的用法。字段和限制以 [官方文档](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching) 为准。

```python
import os

import anthropic

client = anthropic.Anthropic()  # 默认从环境变量 ANTHROPIC_API_KEY 读取
MODEL = os.getenv("CLAUDE_MODEL", "claude-sonnet-5-5")  # 示例，换成你使用的模型

RULES = "\n".join(f"第 {i} 条：退货需在签收后 7 天内申请，商品需保持完好，赠品需一并退回。" for i in range(1, 121))

TOOLS = [{
    "name": "get_order", "description": "按订单号查询订单状态",
    "input_schema": {"type": "object", "properties": {"order_id": {"type": "string"}}, "required": ["order_id"]},
}]

SYSTEM = [
    {"type": "text", "text": "你是电商客服。严格依据以下售后条款回答。"},
    {"type": "text", "text": RULES,
     "cache_control": {"type": "ephemeral"}},  # 断点 1：缓存 tools + system
]


def with_cache_breakpoint(messages: list[dict]) -> list[dict]:
    """返回副本，在最后一条消息的最后一个内容块上加断点 2，下一轮可复用到这里为止的全部历史。"""
    msgs = [dict(m) for m in messages]
    content = msgs[-1]["content"]
    blocks = [{"type": "text", "text": content}] if isinstance(content, str) else [dict(b) for b in content]
    blocks[-1]["cache_control"] = {"type": "ephemeral"}
    msgs[-1]["content"] = blocks
    return msgs


def chat(history: list[dict]) -> str:
    resp = client.messages.create(
        model=MODEL, max_tokens=512, tools=TOOLS, system=SYSTEM,
        messages=with_cache_breakpoint(history))
    u = resp.usage
    print(f"input={u.input_tokens} cache_write={u.cache_creation_input_tokens} "
          f"cache_read={u.cache_read_input_tokens}")
    return "".join(b.text for b in resp.content if b.type == "text")


if __name__ == "__main__":
    history = [{"role": "user", "content": "签收 5 天了还能退货吗？"}]
    reply = chat(history)
    history += [{"role": "assistant", "content": reply},
                {"role": "user", "content": "那赠品丢了怎么办？"}]
    chat(history)  # system 部分和第一轮的对话都应命中缓存
```

可能的输出：

```text
input=25 cache_write=3420 cache_read=0
input=31 cache_write=118 cache_read=3420
```

第一轮把前缀写入缓存（`cache_write`），第二轮读取了第一轮缓存的全部内容（`cache_read`），只为新增的对话写入了一小段新缓存。`input_tokens` 只包含最后一个断点之后、未被缓存的部分。注意示例里 `history` 保存的是不带 `cache_control` 的原始消息，每次请求时才在副本上加断点，避免历史里积累越来越多的断点超出 4 个的限制。

## 怎样排列上下文才能多命中

无论哪家的缓存，规则都可以归结为一句话：越稳定的内容越靠前，变化的内容越靠后。

```text
most stable ─────────────────────────────────────────────► changes every call
[tool definitions] [system prompt] [static docs / few-shot] [history ...] [latest input]
        └──────────── cache this part ─────────────┘
```

具体原则：

1. 系统提示词里不放动态内容。当前时间、用户名、请求 ID 放进系统提示词开头，每次请求的前缀都不一样，缓存一次都命中不了。需要的话放到最后一条用户消息里。
2. 工具定义保持固定。不要每次请求动态增减工具或调整顺序；序列化 JSON Schema 时保持键的顺序稳定。动态选择工具会提高准确率，但会破坏缓存，两者要权衡。
3. 历史只追加不修改。Agent 循环里，新消息永远加在末尾，不回头修改早期消息。修改第 3 条消息，第 3 条之后的全部缓存都会失效。
4. 裁剪和压缩要"批量"进行。每一步都裁掉最早一条，前缀每次都变。更好的做法是超出阈值时一次性裁到较低水位，之后若干步都能共享同一个前缀，见 [上下文窗口管理](/guide/07-context-engineering/window-management)。
5. 共享的大文档放在前面。多个问题针对同一份长文档时，文档放在问题之前，而不是"问题 + 文档"。
6. 同一个前缀的请求尽量集中发送。缓存有有效期，间隔太久就过期了。批量处理任务时，把共享前缀的请求排在一起。

下面这张表列出了常见操作对缓存的影响：

| 操作 | 是否破坏缓存 | 说明 |
| --- | --- | --- |
| 在末尾追加新消息 | 否 | Agent 循环的正常情况 |
| 系统提示词里加入当前时间 | 是，全部失效 | 移到最后一条消息里 |
| 修改历史中间的某条消息 | 该消息之后全部失效 | 只追加，不修改 |
| 每次请求改变工具列表或顺序 | 是，全部失效 | 工具定义在最前面 |
| 切换模型 | 是 | 缓存按模型隔离 |
| 修改 temperature 等采样参数 | 一般不影响 | 缓存的是输入的计算结果，以厂商文档为准 |
| 滚动摘要替换旧历史 | 摘要位置之后全部失效 | 降低压缩频率 |

## 常见坑

- 以为缓存会改变输出。缓存只是复用计算，不影响模型生成的内容，也不是"缓存回答"。相同输入仍然可能得到不同输出。
- 前缀太短。系统提示词只有几百 Token，达不到最小缓存长度，缓存根本没生效。用 `usage` 字段确认，不要凭感觉。
- 不看命中率就做优化。上线后要持续记录 `cached_tokens`（或 `cache_read_input_tokens`）占输入 Token 的比例，它是 [成本与延迟优化](/guide/15-production/cost-optimization) 最直观的指标之一。
- Anthropic 断点放错位置。断点放在会变化的内容上（比如每次都不同的检索结果），每次都写缓存却从不命中，反而因为写入成本更高而多花钱。
- 断点越加越多。把加了 `cache_control` 的消息直接存进历史，几轮之后断点超过 4 个，请求报错。只在请求副本上加断点。
- 把缓存当作安全边界。缓存按组织或账户隔离，但这是厂商的实现细节，不是你的数据隔离方案。多租户系统不要依赖缓存行为来做权限控制。

## 小测

1. 两个请求的系统提示词完全相同，只是第一个在开头写了"当前时间：10:00"，第二个写了"当前时间：10:01"。缓存能命中吗？怎么改？

::: details 查看答案
基本无法命中。缓存只匹配完全相同的前缀，时间出现在最开头，从第一个不同的字符开始后面的所有内容都会失效。改法是把当前时间移出系统提示词，放到最后一条用户消息中（或者放在缓存断点之后）。
:::

2. OpenAI 和 Anthropic 的 Prompt Caching 在使用方式上最大的区别是什么？

::: details 查看答案
OpenAI 是自动的：前缀达到最小长度后系统自动缓存，不需要改代码，也不额外收写入费用。Anthropic 是显式的：需要在内容块上加 `cache_control` 断点，指定缓存到哪里，最多 4 个断点；写入缓存的 Token 比普通输入略贵，读取则便宜得多。两者都通过 `usage` 字段报告缓存情况，但字段名不同。
:::

3. 一个 Agent 每一步都把最早的一条消息裁掉以控制长度，发现缓存命中率很低。原因是什么？怎么改进？

::: details 查看答案
每次裁掉最早的消息，固定头部之后的前缀就变了，从被裁位置往后的缓存全部失效，每一步都要重新计算。改进方法是批量裁剪：历史超过高水位时一次性裁到较低水位，之后的若干步都在同一个前缀上追加，可以持续命中缓存；同时保证系统提示词和工具定义始终不变。
:::

## 延伸阅读

- [OpenAI：Prompt caching](https://platform.openai.com/docs/guides/prompt-caching)
- [Anthropic：Prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)
- [计费、限流与错误重试](/guide/03-llm-api/cost-errors)
- [什么是上下文工程](/guide/07-context-engineering/overview)

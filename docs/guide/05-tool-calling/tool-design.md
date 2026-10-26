---
title: 工具设计原则
description: 工具定义就是写给模型的 API 文档。从命名、描述、参数、粒度、返回值到安全性，系统讲解如何设计一个模型"用得对"的工具。
---

# 工具设计原则

::: info 学习目标
- 建立"工具是给模型用的 API"这一视角，理解它和给人用的 API 的差异
- 掌握工具命名、描述、参数 Schema 的写法，能改写一个糟糕的工具定义
- 学会决定工具粒度：什么时候合并、什么时候拆分
- 设计对模型友好的返回值和错误信息，并为写操作加上安全边界
:::

## 换个视角：你的用户是模型

设计给人用的 API 时，调用方是读过文档、能调试、能问同事的工程师。设计工具时，调用方是模型，它有几个特点：

| 特点 | 对工具设计的影响 |
|------|----------------|
| 只能看到 `name`、`description`、参数 Schema | 这些就是全部文档，没写的就不存在 |
| 每次调用都"消耗"上下文 | 返回值越长，后续推理越贵越慢，也越容易分心 |
| 不会主动看源码或日志 | 错误信息必须告诉它下一步该怎么做 |
| 可能被 Prompt 注入操纵 | 工具权限必须在代码里收紧 |
| 会在相似工具之间犹豫 | 工具之间的边界要清晰，不要重叠 |

Anthropic 在工程博客中把这称为 ACI（Agent-Computer Interface）：像设计人机界面一样认真设计模型与工具之间的界面。

## 命名：动词 + 对象，一眼看懂

- 用 `snake_case`，"动词_对象"格式：`search_orders`、`get_order_detail`、`cancel_order`。
- 工具多时加前缀做命名空间：`crm_search_customers`、`jira_create_issue`。
- 避免含糊的名字：`process`、`handle_data`、`helper` 无法告诉模型它做什么。
- 名字只允许字母、数字、下划线和连字符，长度有上限（以厂商文档为准），不要用中文名。

## 描述：工具最重要的部分

`description` 是模型决定"要不要用、怎么用"的主要依据。一个好的描述回答这几个问题：

1. 这个工具做什么？
2. 什么时候应该用它？什么时候**不**该用它？
3. 返回什么内容？
4. 有什么限制（数据范围、条数上限、权限）？

对比一下：

```json
// 糟糕的定义
{
  "name": "query",
  "description": "查询数据",
  "parameters": {
    "type": "object",
    "properties": {
      "q": { "type": "string" },
      "t": { "type": "integer" }
    }
  }
}
```

```json
// 改进后的定义
{
  "name": "search_orders",
  "description": "按条件搜索当前用户的订单，返回订单摘要列表（订单号、商品名、金额、状态、下单时间），按下单时间倒序，最多 10 条。用户询问自己的订单、物流、购买记录时使用。需要订单的完整明细时，用返回的 order_id 调用 get_order_detail。",
  "parameters": {
    "type": "object",
    "properties": {
      "keyword": {
        "type": "string",
        "description": "商品名关键词，如 耳机。不确定时可不填"
      },
      "status": {
        "type": "string",
        "enum": ["pending", "paid", "shipped", "completed", "refunded"],
        "description": "订单状态过滤，不填表示全部"
      },
      "days": {
        "type": "integer",
        "minimum": 1,
        "maximum": 365,
        "description": "只查最近 N 天的订单，默认 30"
      }
    },
    "required": []
  }
}
```

改进点：名字说明了动作和对象；描述说清了适用场景、返回内容、排序和条数上限，还指明了和另一个工具的配合方式；参数名有含义，有描述，能用枚举的地方都用了枚举。

## 参数设计

**能枚举就枚举。** `status` 用 `enum` 比用自由字符串可靠得多，模型不会写出 `"已发货"`、`"SHIPPED"`、`"shipping"` 这样的变体。

**扁平优于嵌套。** 深层嵌套的对象会让模型更容易出错。能用三个平级参数解决的，就不要设计成 `{"filter": {"time": {"range": {...} } } }`。

**不要让模型生成它不知道的东西。** 用户 ID、租户 ID、鉴权 Token 这类信息，应该由你的代码从会话中注入，而不是作为参数让模型填写。这既能减少错误，也是安全要求：

```text
错误：search_orders(user_id="u_123", keyword="耳机")   ← 模型可以填任何人的 user_id
正确：search_orders(keyword="耳机")                   ← user_id 由服务端从登录态中获取
```

**格式要写明。** 日期参数写清 `YYYY-MM-DD`，金额写清单位是元还是分，时区写清楚。

**必填参数尽量少。** 给可选参数提供合理的默认值，并在描述中写出默认值是什么。

## 粒度：多少个工具合适

工具粒度没有标准答案，但有一个可用的原则：**按照用户的任务来设计工具，而不是按照你的后端接口一一映射。**

| 反模式 | 问题 | 改进 |
|-------|------|------|
| 把 REST API 的 40 个接口全部暴露成工具 | 模型在相似工具间选错，上下文被工具定义占满 | 只暴露 Agent 任务需要的那几个 |
| `get_user` → `get_user_orders` → `get_order_items` 需要三步 | 每一步都是一次 LLM 往返，慢且易错 | 合并成一个 `get_customer_context` |
| 一个 `execute_sql(sql)` 万能工具 | 难以控制权限，模型容易写出危险或错误的 SQL | 拆成几个有明确语义、参数受限的查询工具 |
| `update_order(fields)` 可以改任何字段 | 无法单独控制高危操作 | 拆成 `change_address`、`cancel_order`，分别设置权限 |

经验上，单个 Agent 的工具数量保持在十几个以内比较稳妥。工具很多时，可以按任务动态加载需要的工具子集，或者拆分成多个专职 Agent（见 [为什么需要多 Agent](/guide/12-multi-agent/why-multi-agent)）。

## 返回值：只给模型需要的

工具的返回值会原样进入上下文。后端接口通常返回大量字段（内部 ID、审计信息、嵌套的关联对象），对模型来说大部分是噪音。设计返回值时：

- **只保留与任务相关的字段**，使用人类可读的值（"已发货"或 `shipped`，而不是状态码 `3`）。
- **限制条数并告知截断**。返回"共 128 条，显示前 10 条"，模型才知道结果不完整，可以缩小查询范围。
- **给出下一步的线索**。比如返回 `order_id`，并在描述中说明可以用它查询明细。
- **保持格式稳定**。同一个工具每次返回的结构应该一致，不要有时返回列表、有时返回字符串。

## 动手：给工具结果"瘦身"

下面的函数把一个后端接口的原始响应裁剪成适合模型阅读的结果：只保留需要的字段，转换状态码，限制条数并标注截断。这类"结果整形"代码几乎每个真实工具都需要。

::: code-group
```python [Python]
import json

STATUS_TEXT = {1: "待支付", 2: "已支付", 3: "已发货", 4: "已完成", 5: "已退款"}
MAX_ITEMS = 10


def shape_orders(raw: dict) -> str:
    """把后端原始响应裁剪成适合模型阅读的工具结果。"""
    orders = raw.get("data", {}).get("records", [])
    items = [
        {
            "order_id": o["orderNo"],
            "product": o["skuName"],
            "amount_yuan": o["amountFen"] / 100,      # 分转元，避免模型误读
            "status": STATUS_TEXT.get(o["status"], "未知"),
            "created_at": o["createTime"][:10],       # 只保留日期
        }
        for o in orders[:MAX_ITEMS]
    ]
    result = {"total": len(orders), "returned": len(items), "orders": items}
    if len(orders) > MAX_ITEMS:
        result["note"] = f"结果已截断，仅显示最近 {MAX_ITEMS} 条，可用 keyword 或 status 缩小范围"
    return json.dumps(result, ensure_ascii=False)


if __name__ == "__main__":
    raw = {"code": 0, "traceId": "a1b2", "data": {"records": [
        {"orderNo": "SO1001", "skuName": "降噪耳机", "amountFen": 89900, "status": 3,
         "createTime": "2025-05-01T10:00:00Z", "warehouseId": 7, "auditLog": ["..."]},
    ]}}
    print(shape_orders(raw))
```
```go [Go]
package main

import (
	"encoding/json"
	"fmt"
)

type rawOrder struct {
	OrderNo    string `json:"orderNo"`
	SkuName    string `json:"skuName"`
	AmountFen  int64  `json:"amountFen"`
	Status     int    `json:"status"`
	CreateTime string `json:"createTime"`
	// 其余字段（warehouseId、auditLog 等）不声明，反序列化时自动丢弃
}

type rawResp struct {
	Data struct {
		Records []rawOrder `json:"records"`
	} `json:"data"`
}

type orderView struct {
	OrderID    string  `json:"order_id"`
	Product    string  `json:"product"`
	AmountYuan float64 `json:"amount_yuan"`
	Status     string  `json:"status"`
	CreatedAt  string  `json:"created_at"`
}

var statusText = map[int]string{1: "待支付", 2: "已支付", 3: "已发货", 4: "已完成", 5: "已退款"}

const maxItems = 10

func shapeOrders(rawJSON []byte) (string, error) {
	var raw rawResp
	if err := json.Unmarshal(rawJSON, &raw); err != nil {
		return "", err
	}
	all := raw.Data.Records
	n := min(len(all), maxItems)
	items := make([]orderView, 0, n)
	for _, o := range all[:n] {
		st, ok := statusText[o.Status]
		if !ok {
			st = "未知"
		}
		date := o.CreateTime
		if len(date) >= 10 {
			date = date[:10]
		}
		items = append(items, orderView{o.OrderNo, o.SkuName, float64(o.AmountFen) / 100, st, date})
	}
	result := map[string]any{"total": len(all), "returned": len(items), "orders": items}
	if len(all) > maxItems {
		result["note"] = fmt.Sprintf("结果已截断，仅显示最近 %d 条，可用 keyword 或 status 缩小范围", maxItems)
	}
	b, err := json.Marshal(result)
	return string(b), err
}

func main() {
	raw := []byte(`{"code":0,"traceId":"a1b2","data":{"records":[
	  {"orderNo":"SO1001","skuName":"降噪耳机","amountFen":89900,"status":3,
	   "createTime":"2025-05-01T10:00:00Z","warehouseId":7,"auditLog":["..."]}]}}`)
	out, err := shapeOrders(raw)
	if err != nil {
		panic(err)
	}
	fmt.Println(out)
}
```
```java [Java]
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public class ShapeOrders {
    record OrderView(String order_id, String product, double amount_yuan, String status, String created_at) {}

    static final Map<Integer, String> STATUS_TEXT =
            Map.of(1, "待支付", 2, "已支付", 3, "已发货", 4, "已完成", 5, "已退款");
    static final int MAX_ITEMS = 10;
    static final ObjectMapper MAPPER = new ObjectMapper();

    static String shapeOrders(String rawJson) throws Exception {
        JsonNode records = MAPPER.readTree(rawJson).path("data").path("records");
        List<OrderView> items = new ArrayList<>();
        for (int i = 0; i < Math.min(records.size(), MAX_ITEMS); i++) {
            JsonNode o = records.get(i);
            String created = o.path("createTime").asText();
            items.add(new OrderView(
                    o.path("orderNo").asText(),
                    o.path("skuName").asText(),
                    o.path("amountFen").asLong() / 100.0,
                    STATUS_TEXT.getOrDefault(o.path("status").asInt(), "未知"),
                    created.length() >= 10 ? created.substring(0, 10) : created));
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("total", records.size());
        result.put("returned", items.size());
        result.put("orders", items);
        if (records.size() > MAX_ITEMS) {
            result.put("note", "结果已截断，仅显示最近 " + MAX_ITEMS + " 条，可用 keyword 或 status 缩小范围");
        }
        return MAPPER.writeValueAsString(result);
    }

    public static void main(String[] args) throws Exception {
        String raw = """
                {"code":0,"traceId":"a1b2","data":{"records":[
                  {"orderNo":"SO1001","skuName":"降噪耳机","amountFen":89900,"status":3,
                   "createTime":"2025-05-01T10:00:00Z","warehouseId":7,"auditLog":["..."]}]}}""";
        System.out.println(shapeOrders(raw));
    }
}
```
:::

## 错误信息：告诉模型下一步怎么做

工具出错时，返回给模型的错误信息应该是**可操作的**：

| 不好的错误信息 | 好的错误信息 |
|--------------|------------|
| `Error 500` | `订单服务暂时不可用，请稍后重试，或告诉用户稍后再查询` |
| `invalid param` | `days 必须在 1 到 365 之间，你传入的是 1000` |
| `not found` | `未找到订单 SO9999。请确认订单号，或先用 search_orders 搜索` |
| 完整的 Java 堆栈 | 一句话原因 + 建议，堆栈写日志，不要发给模型 |

更系统的错误处理策略见 [工具错误处理与重试](/guide/05-tool-calling/error-handling)。

## 安全：把工具分级

工具让模型拥有了"动手"的能力，也就带来了风险。按照影响程度把工具分级，每一级采用不同的控制措施：

```text
 风险低 ────────────────────────────────────────────────▶ 风险高
 ┌────────────────┐  ┌──────────────────┐  ┌───────────────────────┐
 │ 只读            │  │ 可逆写操作         │  │ 不可逆 / 涉及资金        │
 │ 查天气、查订单   │  │ 修改地址、加购物车   │  │ 退款、删除、发邮件、转账  │
 │                │  │                  │  │                       │
 │ 直接执行         │  │ 执行 + 记录日志    │  │ 执行前需要用户确认       │
 │                │  │ 支持撤销          │  │ 严格的金额 / 频率限制    │
 └────────────────┘  └──────────────────┘  └───────────────────────┘
```

几条底线：

- **最小权限**：工具使用的数据库账号、API Token 只授予它需要的权限。查询工具用只读账号。
- **身份由服务端注入**：用户身份从会话中获取，不作为模型参数。
- **写操作幂等**：模型可能因为重试而重复调用同一个写操作，用幂等键（如 `request_id`）防止重复退款。
- **高危操作人在环路**：见 [权限控制与人在环路](/guide/15-production/permissions-hitl)。
- **工具结果也可能是攻击载荷**：网页内容、邮件正文里可能藏着"忽略之前的指令"，见 [Prompt 注入与防护](/guide/15-production/prompt-injection)。

## 常见坑

- **描述写得像给人看的接口文档。** "调用 /api/v2/orders 接口"对模型毫无意义，要写"什么时候用、返回什么"。
- **两个工具职责重叠。** `search_products` 和 `find_items` 功能差不多，模型会随机选一个。合并它们，或者在描述中写清区别。
- **返回原始的大 JSON。** 一次工具调用塞进几千 Token 的无关字段，几轮之后上下文就满了。
- **让模型传 user_id。** 这是越权漏洞的直接来源。
- **只测工具本身，不测模型会不会用。** 工具单元测试通过不代表模型能正确调用它。准备一组用户问题，检查模型是否选对了工具、填对了参数，见 [评估集与指标设计](/guide/14-evaluation/eval-design)。

## 小测

1. 一个 `get_weather` 工具的描述是"获取天气"。请指出它的问题并改写。

::: details 查看答案
问题：没有说明数据范围（当前天气还是预报）、适用场景、返回内容和限制。改写示例："查询指定城市当前的天气，返回天气状况、温度（摄氏度）和湿度。仅支持中国大陆城市，不提供未来天气预报。用户询问某地现在的天气、温度、是否下雨时使用。"
:::

2. 为什么不应该把 `user_id` 设计成工具参数？

::: details 查看答案
模型生成的参数不可信。攻击者可以通过 Prompt 注入让模型填写其他用户的 ID，导致越权访问。用户身份应该由服务端从登录态中获取，注入到工具执行上下文中。
:::

3. 后端有 `get_user`、`get_user_orders`、`get_order_items` 三个接口。客服 Agent 每次都需要这三部分信息。工具应该怎么设计？

::: details 查看答案
合并为一个面向任务的工具，例如 `get_customer_context`，一次返回用户基本信息、最近订单和订单明细的精简版本。这样减少了 LLM 往返次数，降低了出错概率和延迟。工具粒度应该按 Agent 的任务来设计，而不是按后端接口一一映射。
:::

## 延伸阅读

- [Anthropic：Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [Anthropic：Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- [OpenAI Function calling 指南](https://platform.openai.com/docs/guides/function-calling)
- 下一篇：[并行工具调用](/guide/05-tool-calling/parallel-tools)

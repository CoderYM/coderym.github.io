---
title: Go：Eino 与 langchaingo
description: Go 生态的两个主流 Agent 框架：字节跳动 CloudWeGo 开源的 Eino 主打强类型组件与编排，社区的 langchaingo 移植了 LangChain 的概念。
---

# Go：Eino 与 langchaingo

::: info 学习目标
- 了解 Go 写 Agent 的优势与生态现状
- 理解 Eino 的"组件 + 编排"设计，用它写出一个带工具的 ReAct Agent
- 用 langchaingo 调用 OpenAI 兼容模型
- 根据项目情况在 Eino、langchaingo 和手写之间做选择
:::

::: tip 语言与版本
本文是 Go 专题，只给出 Go 代码（Go 1.22+）。Eino 示例基于 `github.com/cloudwego/eino` v0.x 与 `eino-ext` 中的 OpenAI 组件，langchaingo 基于 v0.1.x。两个项目都在 1.0 之前，API 变化较快，API 以官方文档为准。
:::

## 为什么用 Go 写 Agent

Agent 的大部分时间花在等待模型和工具的网络 I/O 上，这正是 Go 擅长的：goroutine 并发调用多个工具、`context` 统一控制超时和取消、编译成单个二进制方便部署。很多团队的后端本来就是 Go 微服务，Agent 直接写在同一个技术栈里，可以复用现有的 RPC、鉴权、监控体系。

短板是生态：新的模型能力、新的框架几乎都先出现在 Python 中，Go 的集成会晚一些。好在 OpenAI 兼容接口已经覆盖了大部分需求，[不用框架手写 Agent](/guide/06-agent-loop/handwritten-agent) 中的 Go 版本只用标准库就能跑。

## Eino：组件 + 编排

Eino 是字节跳动 CloudWeGo 团队开源的 Go 大模型应用框架，在字节内部有大量业务使用。它的设计分为三层：

```text
┌──────────────────────── 应用 / Agent ───────────────────────┐
│  预置 Agent：ReAct Agent、多 Agent、ADK 等                    │
├──────────────────────── 编排 compose ───────────────────────┤
│  Chain（线性链）   Graph（有向图，支持分支、循环）   Workflow   │
│  类型检查、流式处理、回调（Trace）、并发安全由框架负责             │
├──────────────────────── 组件 components ────────────────────┤
│  ChatModel  Tool  ChatTemplate  Retriever  Embedding  Indexer │
│  （接口在 eino 主仓库，具体实现如 OpenAI、Ark 在 eino-ext 中）   │
└────────────────────────────────────────────────────────────┘
```

它的特点是**强类型**：编排时节点之间的输入输出类型在编译（Compile）阶段就会检查，而不是运行时才发现对不上；同时框架自动处理流式数据在节点之间的拼接与拆分。

### 第一步：调用模型

```bash
go get github.com/cloudwego/eino
go get github.com/cloudwego/eino-ext/components/model/openai
```

```go
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/cloudwego/eino-ext/components/model/openai"
	"github.com/cloudwego/eino/schema"
)

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	baseURL := os.Getenv("OPENAI_BASE_URL")
	if baseURL == "" {
		baseURL = "https://api.openai.com/v1"
	}

	chatModel, err := openai.NewChatModel(ctx, &openai.ChatModelConfig{
		APIKey:  os.Getenv("OPENAI_API_KEY"),
		BaseURL: baseURL,
		Model:   os.Getenv("LLM_MODEL"),
		Timeout: 60 * time.Second,
	})
	if err != nil {
		log.Fatal(err)
	}

	resp, err := chatModel.Generate(ctx, []*schema.Message{
		schema.SystemMessage("你是一个简洁的助手。"),
		schema.UserMessage("用一句话解释什么是 Agent。"),
	})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(resp.Content)
}
```

`schema.Message` 是 Eino 统一的消息类型，换用其他模型组件（例如火山引擎 Ark、Ollama）时，业务代码不需要修改。流式输出用 `chatModel.Stream(ctx, msgs)`，返回一个 `StreamReader`，循环调用 `Recv()` 直到 `io.EOF`。

### 第二步：带工具的 ReAct Agent

Eino 在 `flow/agent/react` 中提供了预置的 ReAct Agent。下面定义一个天气工具并交给它：

```go
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"github.com/cloudwego/eino-ext/components/model/openai"
	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/components/tool/utils"
	"github.com/cloudwego/eino/compose"
	"github.com/cloudwego/eino/flow/agent/react"
	"github.com/cloudwego/eino/schema"
)

type WeatherInput struct {
	City string `json:"city"`
}

// 工具函数：入参由框架从模型给出的 JSON 参数反序列化而来
func getWeather(_ context.Context, in *WeatherInput) (string, error) {
	city := strings.TrimSpace(in.City)
	if city == "" {
		return "", fmt.Errorf("city 不能为空")
	}
	data := map[string]string{"北京": "晴，25°C", "杭州": "小雨，18°C"}
	if w, ok := data[city]; ok {
		return w, nil
	}
	return "暂无 " + city + " 的天气数据", nil
}

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	baseURL := os.Getenv("OPENAI_BASE_URL")
	if baseURL == "" {
		baseURL = "https://api.openai.com/v1"
	}
	chatModel, err := openai.NewChatModel(ctx, &openai.ChatModelConfig{
		APIKey:  os.Getenv("OPENAI_API_KEY"),
		BaseURL: baseURL,
		Model:   os.Getenv("LLM_MODEL"),
		Timeout: 60 * time.Second,
	})
	if err != nil {
		log.Fatal(err)
	}

	// 显式声明工具的参数 Schema
	weatherTool := utils.NewTool(&schema.ToolInfo{
		Name: "get_weather",
		Desc: "查询指定城市的当前天气",
		ParamsOneOf: schema.NewParamsOneOfByParams(map[string]*schema.ParameterInfo{
			"city": {Type: schema.String, Desc: "中文城市名，如：北京", Required: true},
		}),
	}, getWeather)

	agent, err := react.NewAgent(ctx, &react.AgentConfig{
		ToolCallingModel: chatModel,
		ToolsConfig:      compose.ToolsNodeConfig{Tools: []tool.BaseTool{weatherTool}},
		MaxStep:          10, // 最大步数，防止无限循环
	})
	if err != nil {
		log.Fatal(err)
	}

	out, err := agent.Generate(ctx, []*schema.Message{
		schema.UserMessage("北京和杭州今天天气怎么样？"),
	})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(out.Content)
}
```

除了用 `utils.NewTool` 显式声明 Schema，Eino 也支持用 `utils.InferTool` 从结构体的 tag 自动推导 Schema，tag 的写法在不同版本间有调整，使用时请对照所用版本的文档。

### 编排：Chain 与 Graph

预置 Agent 满足不了需求时，就用 `compose` 包自己编排。思路与 [LangGraph](/guide/11-frameworks/langgraph) 相似：

- `compose.NewChain` 构建线性流程，例如"提示词模板 → 模型 → 输出解析"；
- `compose.NewGraph` 构建有向图，用 `AddChatModelNode`、`AddToolsNode`、`AddLambdaNode` 等添加节点，用 `AddEdge`、`AddBranch` 连接，最后 `Compile` 得到可执行对象；
- 编译阶段会检查上下游节点的类型是否匹配，Callback 机制可以在每个节点前后插入日志和 Trace。

Eino 还有一套面向 Agent 开发的 ADK（Agent Development Kit），提供 ChatModelAgent、多 Agent 协作、中断与恢复等能力，适合较复杂的 Agent 应用。另外官方提供了 [eino-examples](https://github.com/cloudwego/eino-examples) 仓库，覆盖了大部分用法。

## langchaingo：LangChain 的 Go 移植

langchaingo 是社区维护的项目，沿用了 LangChain 的概念（LLM、Chain、Agent、Memory、VectorStore），集成了大量模型厂商和向量数据库。如果你熟悉 LangChain，上手会很快。

```bash
go get github.com/tmc/langchaingo
```

```go
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/tmc/langchaingo/llms"
	"github.com/tmc/langchaingo/llms/openai"
)

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	baseURL := os.Getenv("OPENAI_BASE_URL")
	if baseURL == "" {
		baseURL = "https://api.openai.com/v1"
	}

	llm, err := openai.New(
		openai.WithToken(os.Getenv("OPENAI_API_KEY")),
		openai.WithBaseURL(baseURL),
		openai.WithModel(os.Getenv("LLM_MODEL")),
	)
	if err != nil {
		log.Fatal(err)
	}

	resp, err := llm.GenerateContent(ctx, []llms.MessageContent{
		llms.TextParts(llms.ChatMessageTypeSystem, "你是一个简洁的助手。"),
		llms.TextParts(llms.ChatMessageTypeHuman, "用一句话解释什么是 RAG。"),
	}, llms.WithTemperature(0.2))
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(resp.Choices[0].Content)
}
```

工具调用通过 `llms.WithTools(...)` 传入 `llms.Tool` 定义，模型返回的调用在 `resp.Choices[0].ToolCalls` 中，执行后以 `ChatMessageTypeTool` 消息回传，循环逻辑和手写版本一致。

## 如何选择

| 维度 | Eino | langchaingo | 手写（标准库 / 官方 SDK） |
|------|------|-------------|--------------------------|
| 维护方 | 字节跳动 CloudWeGo | 社区 | 你自己 |
| 设计风格 | 强类型组件 + 图编排 | LangChain 概念移植 | 无抽象 |
| 编排能力 | 强（Chain、Graph、ADK） | 一般 | 自己实现 |
| 集成数量 | 中等，国内模型（如豆包/Ark）支持好 | 较多 | 按需接入 |
| 学习成本 | 中 | 低（熟悉 LangChain 的话） | 最低 |
| 适合 | 生产级、复杂流程、大型团队 | 快速集成、中小项目 | 简单 Agent、追求可控 |

建议：简单的工具 Agent 先手写；需要复杂编排、流式处理和统一 Trace 时选 Eino；需要快速接入某个冷门向量库或厂商、并且熟悉 LangChain 时可以考虑 langchaingo。

## 常见坑

- **BaseURL 拼接错误**：OpenAI 兼容地址通常要带 `/v1`，少了会 404，多了一层路径也会 404。先用 curl 验证地址。
- **模型不支持 Tool Calling**：ReAct Agent 依赖模型的工具调用能力，部分模型或部署方式不支持，会表现为模型直接回答而从不调用工具。
- **忘记设置超时**：不带超时的 `context.Background()` 在模型服务卡住时会一直等待，务必用 `context.WithTimeout`。
- **照抄旧版示例**：Eino 迭代较快，如 ReAct Agent 配置字段、工具推导的 tag 格式都有过调整，编译报错时先核对版本。
- **在工具中 panic**：工具函数应返回 error 而不是 panic，让框架把错误信息交给模型处理。

## 小测

1. Eino 的"强类型编排"指什么？相比运行时才报错有什么好处？

::: details 查看答案
编排时每个节点都有明确的输入输出类型，`Compile` 阶段框架会检查上下游类型是否匹配。类型不匹配在服务启动时就会暴露，而不是等到线上某个请求走到这条分支时才出错。
:::

2. 一个 Go 服务只需要调用模型做文本分类，没有工具和多步流程，需要引入 Eino 吗？

::: details 查看答案
通常不需要。直接用标准库或官方 SDK 调用 OpenAI 兼容接口即可，依赖更少、更容易排查。等出现工具调用、多步编排、统一 Trace 等需求时再考虑框架。
:::

## 延伸阅读

- [Eino GitHub 仓库](https://github.com/cloudwego/eino)
- [Eino 扩展组件 eino-ext](https://github.com/cloudwego/eino-ext)
- [Eino 示例 eino-examples](https://github.com/cloudwego/eino-examples)
- [langchaingo GitHub 仓库](https://github.com/tmc/langchaingo)
- 相关：[不用框架手写 Agent](/guide/06-agent-loop/handwritten-agent)、[服务化：FastAPI / Gin / Spring Boot](/guide/15-production/serving)

---
title: Java：Spring AI 与 LangChain4j
description: Java 生态的两大 AI 框架：Spring AI 用 ChatClient 和自动配置融入 Spring Boot，LangChain4j 用 AiServices 声明式接口构建 Agent。
---

# Java：Spring AI 与 LangChain4j

::: info 学习目标
- 用 Spring AI 的 `ChatClient` 和 `@Tool` 写出一个带工具、记忆和结构化输出的接口
- 用 LangChain4j 的 `AiServices` 以声明式接口实现同样的功能
- 搞清两个框架的 base URL 配置差异，顺利接入国内模型
- 根据项目情况在两者之间做选择
:::

::: tip 语言与版本
本文是 Java 专题，只给出 Java 代码（Java 17+）。Spring AI 示例基于 1.0.x（需要 Spring Boot 3.4+），LangChain4j 示例基于 1.x。两个框架在 1.0 前后都有较大的 API 调整（例如 LangChain4j 将 `ChatLanguageModel` 改名为 `ChatModel`），API 以官方文档为准。
:::

## 两个框架的定位

| 维度 | Spring AI | LangChain4j |
|------|-----------|-------------|
| 出品方 | Spring 官方（VMware / Broadcom） | 独立开源社区 |
| 核心 API | `ChatClient` 流式构建器 + Advisor | `AiServices` 声明式接口 |
| 与 Spring 关系 | 原生，依赖自动配置 | 独立，可单独使用，也提供 Spring Boot Starter |
| 工具定义 | `@Tool` / `@ToolParam` | `@Tool` / `@P` |
| 记忆、RAG | Advisor 机制（`MessageChatMemoryAdvisor` 等） | `ChatMemory`、`ContentRetriever` 配置到 AiServices |
| MCP | 提供 MCP Client / Server Starter | 提供 MCP Client 模块 |
| 适合 | Spring Boot 项目 | 任意 Java 项目，偏好"写接口即可"的风格 |

国内还有基于 Spring AI 扩展的 **Spring AI Alibaba**，加强了通义千问、阿里云百炼的集成以及多 Agent 图编排能力，适合阿里云技术栈的团队。

## Spring AI

### 依赖与配置

```xml
<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>org.springframework.ai</groupId>
      <artifactId>spring-ai-bom</artifactId>
      <version>1.0.0</version><!-- 使用你锁定的 1.0.x 版本 -->
      <type>pom</type>
      <scope>import</scope>
    </dependency>
  </dependencies>
</dependencyManagement>

<dependencies>
  <dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-web</artifactId>
  </dependency>
  <dependency>
    <groupId>org.springframework.ai</groupId>
    <artifactId>spring-ai-starter-model-openai</artifactId>
  </dependency>
</dependencies>
```

```properties
# application.properties
spring.ai.openai.api-key=${OPENAI_API_KEY}
# 注意：Spring AI 会自动拼接 /v1/chat/completions，这里不要带 /v1
# 例如 DeepSeek 写 https://api.deepseek.com
spring.ai.openai.base-url=https://api.openai.com
spring.ai.openai.chat.options.model=${LLM_MODEL}
```

这是接入兼容厂商最常见的坑：本站其他文章约定的 `OPENAI_BASE_URL` 带 `/v1`，而 Spring AI 的 `base-url` 不带。如果厂商的路径不是标准的 `/v1/chat/completions`，可以通过 `spring.ai.openai.chat.completions-path` 单独指定。

### 代码：工具、记忆与结构化输出

```java
package com.example.agent;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.client.advisor.MessageChatMemoryAdvisor;
import org.springframework.ai.chat.memory.ChatMemory;
import org.springframework.ai.tool.annotation.Tool;
import org.springframework.ai.tool.annotation.ToolParam;
import org.springframework.http.HttpStatus;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.stereotype.Component;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.util.Map;

@SpringBootApplication
public class AgentApplication {
    public static void main(String[] args) {
        SpringApplication.run(AgentApplication.class, args);
    }
}

@Component
class WeatherTools {
    private static final Map<String, String> DATA = Map.of("北京", "晴，25°C", "杭州", "小雨，18°C");

    @Tool(description = "查询指定城市的当前天气")
    String getWeather(@ToolParam(description = "中文城市名，如：北京") String city) {
        return DATA.getOrDefault(city.strip(), "暂无 " + city + " 的天气数据");
    }
}

// 结构化输出的目标类型
record TripAdvice(String city, String weather, boolean needUmbrella, String suggestion) {}

@RestController
class ChatController {
    private final ChatClient chatClient;

    // ChatClient.Builder 与 ChatMemory（默认基于内存的消息窗口）均由 Spring AI 自动配置
    ChatController(ChatClient.Builder builder, ChatMemory chatMemory, WeatherTools tools) {
        this.chatClient = builder
                .defaultSystem("你是出行助手，回答简洁。需要天气信息时调用工具。")
                .defaultTools(tools)
                .defaultAdvisors(MessageChatMemoryAdvisor.builder(chatMemory).build())
                .build();
    }

    @GetMapping("/chat")
    String chat(@RequestParam String sessionId, @RequestParam String q) {
        validate(sessionId, q);
        return chatClient.prompt()
                .user(q)
                .advisors(a -> a.param(ChatMemory.CONVERSATION_ID, sessionId)) // 按会话隔离记忆
                .call()
                .content();
    }

    @GetMapping("/advice")
    TripAdvice advice(@RequestParam String city) {
        validate("n/a", city);
        // entity() 会在提示词中附加 JSON Schema 格式要求，并把结果反序列化为 record
        return chatClient.prompt()
                .user("查询" + city + "的天气，给出出行建议")
                .call()
                .entity(TripAdvice.class);
    }

    private static void validate(String sessionId, String text) {
        if (text == null || text.isBlank() || text.length() > 2000 || sessionId.length() > 64) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "参数不合法");
        }
    }
}
```

`ChatClient` 的调用链读起来很直观：`prompt()` 开始构建，`user()` 设置用户消息，`call()` 同步调用（流式用 `stream().content()` 得到 `Flux<String>`），`content()` 或 `entity()` 取结果。工具调用循环由框架自动完成：模型返回 tool_calls 后，Spring AI 执行对应的 `@Tool` 方法并把结果回传模型，直到得到最终回答。

Advisor 是 Spring AI 的扩展点，类似 Web 框架里的拦截器，可以在请求前后改写提示词、注入记忆、做 RAG 检索（如 `QuestionAnswerAdvisor`）、记录日志。

## LangChain4j

### 依赖

```xml
<dependency>
  <groupId>dev.langchain4j</groupId>
  <artifactId>langchain4j</artifactId>
  <version>1.0.0</version><!-- 使用你锁定的 1.x 版本 -->
</dependency>
<dependency>
  <groupId>dev.langchain4j</groupId>
  <artifactId>langchain4j-open-ai</artifactId>
  <version>1.0.0</version>
</dependency>
```

### 代码：用接口描述 Agent

LangChain4j 最有代表性的是 `AiServices`：你只写一个 Java 接口，用注解描述系统提示词和参数，框架生成实现类，负责拼装消息、调用模型、执行工具、管理记忆。

```java
package com.example.agent;

import dev.langchain4j.agent.tool.P;
import dev.langchain4j.agent.tool.Tool;
import dev.langchain4j.memory.chat.MessageWindowChatMemory;
import dev.langchain4j.model.openai.OpenAiChatModel;
import dev.langchain4j.service.AiServices;
import dev.langchain4j.service.MemoryId;
import dev.langchain4j.service.SystemMessage;
import dev.langchain4j.service.UserMessage;

import java.time.Duration;
import java.util.Map;
import java.util.Objects;

public class LangChain4jDemo {

    // 1. 声明 Agent 接口：系统提示词、记忆 ID、用户消息
    interface TravelAssistant {
        @SystemMessage("你是出行助手，回答简洁。需要天气信息时调用工具。")
        String chat(@MemoryId String sessionId, @UserMessage String message);
    }

    // 2. 工具：普通 Java 方法加注解
    static class WeatherTools {
        private static final Map<String, String> DATA = Map.of("北京", "晴，25°C", "杭州", "小雨，18°C");

        @Tool("查询指定城市的当前天气")
        String getWeather(@P("中文城市名，如：北京") String city) {
            return DATA.getOrDefault(city.strip(), "暂无 " + city + " 的天气数据");
        }
    }

    public static void main(String[] args) {
        String baseUrl = Objects.requireNonNullElse(System.getenv("OPENAI_BASE_URL"), "https://api.openai.com/v1");

        // 注意：LangChain4j 的 baseUrl 需要带 /v1，与 Spring AI 不同
        OpenAiChatModel model = OpenAiChatModel.builder()
                .apiKey(System.getenv("OPENAI_API_KEY"))
                .baseUrl(baseUrl)
                .modelName(System.getenv("LLM_MODEL"))
                .timeout(Duration.ofSeconds(60))
                .build();

        // 3. 由框架生成接口实现
        TravelAssistant assistant = AiServices.builder(TravelAssistant.class)
                .chatModel(model) // 0.x 版本中叫 chatLanguageModel
                .tools(new WeatherTools())
                .chatMemoryProvider(sessionId -> MessageWindowChatMemory.withMaxMessages(20))
                .build();

        System.out.println(assistant.chat("user-1", "北京今天天气怎么样？"));
        System.out.println(assistant.chat("user-1", "那需要带伞吗？")); // 同一会话，记得上文
    }
}
```

要点：

- 接口方法的返回值可以是 `String`，也可以是 record 或枚举，框架会自动要求模型输出 JSON 并反序列化，实现结构化输出；
- `@MemoryId` 配合 `chatMemoryProvider` 让每个会话拥有独立记忆，示例中的记忆保存在内存，生产环境通过 `ChatMemoryStore` 接入 Redis 或数据库；
- RAG 通过在 builder 上配置 `contentRetriever(...)` 实现，LangChain4j 内置了文档加载、切分和多种向量库集成。

## 如何选择

| 你的情况 | 推荐 |
|---------|------|
| 已有 Spring Boot 服务，希望配置化、和现有 Bean 体系融合 | Spring AI |
| 使用阿里云百炼 / 通义千问，需要多 Agent 编排 | Spring AI Alibaba |
| 非 Spring 项目（Quarkus、纯 Java、Android 后端等） | LangChain4j |
| 喜欢"定义接口即得到 Agent"的声明式风格 | LangChain4j（也有 Spring Boot Starter） |

两者的能力差距在不断缩小，核心概念（模型、工具、记忆、RAG、MCP）基本一一对应。选型时更应该看团队现有技术栈和你需要的特定集成。

## 常见坑

- **base URL 的 `/v1`**：Spring AI 的 `base-url` 不带 `/v1`，LangChain4j 的 `baseUrl` 带 `/v1`，写错会得到 404。
- **按旧版 API 写代码**：Spring AI 1.0 之前的 milestone 版本中，starter 名称、`ChatMemory` 相关类和 Advisor 参数都有改动；LangChain4j 1.0 把 `ChatLanguageModel` 改名为 `ChatModel`。网上旧教程很多，以你使用的版本文档为准。
- **记忆不隔离**：Spring AI 没有传 conversation id、LangChain4j 没有用 `@MemoryId`，所有用户共享同一份对话历史，既串台又泄露隐私。
- **工具方法里做危险操作且无确认**：`@Tool` 方法会被模型自动调用，删除、转账这类方法需要额外的权限校验或审批，参考 [权限控制与人在环路](/guide/15-production/permissions-hitl)。
- **在工具中抛出未处理的异常**：会导致整个请求失败。工具内捕获异常并返回清晰的错误描述，让模型有机会调整。

## 小测

1. 使用 DeepSeek 的兼容接口（标准地址为 `https://api.deepseek.com/v1`），Spring AI 和 LangChain4j 分别应该怎么配置 base URL？

::: details 查看答案
Spring AI 配置 `spring.ai.openai.base-url=https://api.deepseek.com`（不带 `/v1`，框架会拼接 `/v1/chat/completions`）；LangChain4j 配置 `.baseUrl("https://api.deepseek.com/v1")`。
:::

2. 在 Spring AI 中，如何让不同用户的对话记忆互不干扰？

::: details 查看答案
注册 `MessageChatMemoryAdvisor`，并在每次调用时通过 `advisors(a -> a.param(ChatMemory.CONVERSATION_ID, sessionId))` 传入该用户或会话的唯一 ID。生产环境还应把 `ChatMemory` 的存储换成数据库或 Redis 实现。
:::

3. LangChain4j 中如何让 Agent 返回一个结构化对象而不是字符串？

::: details 查看答案
把 AiServices 接口方法的返回类型声明为 record、POJO 或枚举，例如 `TripAdvice advise(String city)`，框架会在提示词中要求模型输出对应的 JSON 结构，并把结果反序列化为该类型。
:::

## 延伸阅读

- [Spring AI 官方文档](https://docs.spring.io/spring-ai/reference/)
- [Spring AI GitHub 仓库](https://github.com/spring-projects/spring-ai)
- [LangChain4j 官方文档](https://docs.langchain4j.dev)
- [LangChain4j GitHub 仓库](https://github.com/langchain4j/langchain4j)
- [Spring AI Alibaba GitHub 仓库](https://github.com/alibaba/spring-ai-alibaba)
- 相关：[结构化输出与 JSON Schema](/guide/04-prompt/structured-output)、[服务化：FastAPI / Gin / Spring Boot](/guide/15-production/serving)

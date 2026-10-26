---
title: 服务化：FastAPI / Gin / Spring Boot
description: 把 Agent 包装成一个支持 SSE 流式输出的 HTTP 服务，并补齐认证、限流、CORS、输入校验和超时这些对外暴露服务必需的安全措施。
---

# 服务化：FastAPI / Gin / Spring Boot

::: info 学习目标
- 设计一个 Agent 聊天接口：请求格式、SSE 事件格式、错误处理
- 掌握对外暴露 Agent 服务时必须具备的安全措施：认证、限流、CORS、输入校验、超时
- 分别用 FastAPI、Gin、Spring Boot 实现带鉴权和限流的流式聊天接口
- 了解反向代理缓冲、客户端断开、心跳等流式服务的生产细节
:::

## 接口设计

前面的文章里，Agent 都是命令行程序。要给 Web 前端、App 或其他服务使用，需要把它包装成 HTTP 接口。一个最小的聊天接口：

```text
POST /v1/chat
Authorization: Bearer <api-key>
Content-Type: application/json

{"messages": [{"role": "user", "content": "你好"}]}

──► 200 OK
    Content-Type: text/event-stream

    data: {"type": "delta", "content": "你"}

    data: {"type": "delta", "content": "好！"}

    data: {"type": "done"}
```

设计要点：

- **用 SSE 返回流式结果**。SSE 基于普通 HTTP，比 WebSocket 简单，穿透代理和负载均衡更容易，单向推送正好满足聊天场景。原理见 [流式输出与 SSE](/guide/01-programming/streaming-sse)。
- **事件带类型**。`delta` 是增量文本，`done` 表示正常结束，`error` 表示出错。Agent 场景还可以加 `tool_start`、`tool_end` 等事件，让前端展示"正在查询订单…"。
- **系统提示词由服务端决定**。客户端只能提交 `user` 和 `assistant` 消息，否则任何人都能通过请求体改写系统提示词。
- **错误不泄露内部细节**。上游返回的错误信息可能包含模型名、内部地址甚至部分请求内容，日志里记录完整错误，返回给客户端的只是通用描述。

## 安全清单

Agent 接口一旦暴露到网络上，每个请求都在消耗你的模型额度，还可能通过工具访问内部数据。下面这些措施不是可选项：

| 措施 | 目的 | 本文实现 |
| --- | --- | --- |
| 认证 | 只有授权的调用方能访问 | Bearer Token 校验，常量时间比较 |
| 限流 | 防止滥用和费用失控 | 按调用方的令牌桶，超限返回 429 |
| CORS 白名单 | 只允许指定的前端域名从浏览器调用 | 从环境变量读取允许的 Origin |
| 输入校验 | 拒绝畸形和超大请求 | 限制消息数量、单条长度、角色取值 |
| 超时 | 防止连接和上游调用无限挂起 | 上游调用设置超时，客户端断开时取消 |
| 输出上限 | 控制单次请求成本 | 设置 `max_tokens` |
| 不回显密钥 | 防止凭证泄露 | 密钥只从环境变量读取，不写入日志 |

::: warning 关于 API Key 与浏览器
本文用静态 API Key 演示认证，适合**服务到服务**的调用。如果前端在浏览器中直接调用，绝不能把 API Key 写进前端代码，任何人打开开发者工具都能看到。浏览器场景应使用用户登录态（Session、JWT、OAuth 等），由服务端识别具体用户，并按用户做限流和权限控制，见 [权限控制与人在环路](/guide/15-production/permissions-hitl)。
:::

几点补充说明：

- **CORS 不是认证**。CORS 只约束浏览器的跨域行为，`curl` 或脚本可以无视它。它的作用是防止其他网站在用户浏览器里调用你的接口，真正的访问控制靠认证。
- **进程内限流只对单实例有效**。部署多个实例时，应使用 Redis 等共享存储，或在 API 网关、Nginx（`limit_req`）层统一限流。
- **按请求数限流还不够**。一个请求可能消耗几百 Token，也可能消耗几万 Token。生产环境还应按用户统计每日 Token 用量并设置上限，同时限制每个用户的并发连接数。

环境变量约定（三种实现通用）：

```bash
OPENAI_API_KEY=sk-...                 # 模型厂商的密钥
OPENAI_BASE_URL=                      # 可选，兼容 OpenAI 接口的地址
LLM_MODEL=gpt-4o-mini                 # 示例模型名
SERVICE_API_KEYS=key-for-app-a,key-for-app-b   # 允许调用本服务的密钥，逗号分隔
ALLOWED_ORIGINS=https://app.example.com        # 允许跨域的前端域名，逗号分隔
```

`SERVICE_API_KEYS` 应当是足够长的随机字符串，例如用 `python3 -c "import secrets; print(secrets.token_urlsafe(32))"` 生成。

## 动手：三种框架的实现

三个实现的行为一致：`GET /healthz` 无需认证；`POST /v1/chat` 需要 Bearer Token，经过限流和输入校验后，调用模型的流式接口，把增量文本以 SSE 事件转发给客户端；客户端断开时停止读取上游，避免继续消耗 Token。

依赖：

- Python：`pip install fastapi uvicorn openai`，运行 `uvicorn server:app --port 8080`；
- Go：`go get github.com/gin-gonic/gin golang.org/x/time/rate`，运行 `go run .`；
- Java：Spring Boot 3 项目，依赖 `spring-boot-starter-web`（已包含 Jackson），文件放在 `src/main/java/demo/AgentServer.java`，运行 `mvn spring-boot:run`。

为了聚焦服务化本身，这里的"Agent"只是一次流式模型调用。接入完整的 Agent 循环时，把模型流替换为 Agent 的事件流即可（每次工具调用前后发送 `tool_start` / `tool_end` 事件）。

::: code-group
```python [Python]
# server.py  依赖：pip install fastapi uvicorn openai
import hmac
import json
import logging
import os
import threading
import time
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from openai import AsyncOpenAI
from pydantic import BaseModel, Field

log = logging.getLogger("agent-server")

SERVICE_KEYS = [k.strip() for k in os.environ["SERVICE_API_KEYS"].split(",") if k.strip()]
if not SERVICE_KEYS:
    raise RuntimeError("SERVICE_API_KEYS 不能为空")
ALLOWED_ORIGINS = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "").split(",") if o.strip()]
MODEL = os.getenv("LLM_MODEL", "gpt-4o-mini")
SYSTEM_PROMPT = "你是一个简洁、友好的助手。"

client = AsyncOpenAI(api_key=os.environ["OPENAI_API_KEY"],
                     base_url=os.getenv("OPENAI_BASE_URL") or None, timeout=60)


class TokenBucket:
    """每个调用方一个令牌桶：容量 capacity，每秒补充 rate 个。仅适用于单实例。"""

    def __init__(self, capacity: int = 10, rate: float = 0.5):
        self.capacity, self.rate = capacity, rate
        self.buckets: dict[str, tuple[float, float]] = {}
        self.lock = threading.Lock()

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        with self.lock:
            tokens, last = self.buckets.get(key, (self.capacity, now))
            tokens = min(self.capacity, tokens + (now - last) * self.rate)
            if tokens < 1:
                self.buckets[key] = (tokens, now)
                return False
            self.buckets[key] = (tokens - 1, now)
            return True


limiter = TokenBucket()


def authenticate(authorization: str = Header(default="")) -> str:
    token = authorization.removeprefix("Bearer ").strip().encode()
    # 常量时间比较，避免通过响应时间猜测密钥
    for key in SERVICE_KEYS:
        if hmac.compare_digest(token, key.encode()):
            caller = key[:6]  # 用密钥前缀标识调用方，不记录完整密钥
            if not limiter.allow(caller):
                raise HTTPException(429, "请求过于频繁", headers={"Retry-After": "2"})
            return caller
    raise HTTPException(401, "未授权", headers={"WWW-Authenticate": "Bearer"})


class Message(BaseModel):
    role: Literal["user", "assistant"]  # 不允许客户端提交 system 消息
    content: str = Field(min_length=1, max_length=8000)


class ChatRequest(BaseModel):
    messages: list[Message] = Field(min_length=1, max_length=50)


app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,  # 为空时不允许任何跨域请求
    allow_methods=["POST"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.get("/healthz")
async def healthz():
    return {"status": "ok"}


def sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


@app.post("/v1/chat")
async def chat(req: ChatRequest, request: Request, caller: str = Depends(authenticate)):
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    messages += [m.model_dump() for m in req.messages]

    async def events():
        try:
            stream = await client.chat.completions.create(
                model=MODEL, messages=messages, stream=True, max_tokens=1024)
            async with stream:  # 退出时关闭上游连接
                async for chunk in stream:
                    if await request.is_disconnected():
                        log.info("client %s disconnected", caller)
                        return
                    if chunk.choices and chunk.choices[0].delta.content:
                        yield sse({"type": "delta", "content": chunk.choices[0].delta.content})
            yield sse({"type": "done"})
        except Exception:
            log.exception("upstream error, caller=%s", caller)  # 完整错误只写日志
            yield sse({"type": "error", "message": "服务暂时不可用，请稍后重试"})

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
```
```go [Go]
// main.go  依赖：go get github.com/gin-gonic/gin golang.org/x/time/rate
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/time/rate"
)

const systemPrompt = "你是一个简洁、友好的助手。"

type Message struct {
	Role    string `json:"role" binding:"required,oneof=user assistant"` // 不允许客户端提交 system 消息
	Content string `json:"content" binding:"required,max=8000"`
}

type ChatRequest struct {
	Messages []Message `json:"messages" binding:"required,min=1,max=50,dive"`
}

// 每个调用方一个令牌桶：每 2 秒补充 1 个，容量 10。仅适用于单实例。
type limiterStore struct {
	mu sync.Mutex
	m  map[string]*rate.Limiter
}

func (s *limiterStore) get(key string) *rate.Limiter {
	s.mu.Lock()
	defer s.mu.Unlock()
	l, ok := s.m[key]
	if !ok {
		l = rate.NewLimiter(rate.Every(2*time.Second), 10)
		s.m[key] = l
	}
	return l
}

func splitEnv(key string) []string {
	var out []string
	for _, v := range strings.Split(os.Getenv(key), ",") {
		if v = strings.TrimSpace(v); v != "" {
			out = append(out, v)
		}
	}
	return out
}

func authMiddleware(keys []string, limiters *limiterStore) gin.HandlerFunc {
	return func(c *gin.Context) {
		token := strings.TrimSpace(strings.TrimPrefix(c.GetHeader("Authorization"), "Bearer "))
		caller := ""
		for _, k := range keys {
			// 常量时间比较，避免通过响应时间猜测密钥
			if subtle.ConstantTimeCompare([]byte(token), []byte(k)) == 1 {
				caller = k[:min(6, len(k))] // 用密钥前缀标识调用方，不记录完整密钥
			}
		}
		if caller == "" {
			c.Header("WWW-Authenticate", "Bearer")
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "未授权"})
			return
		}
		if !limiters.get(caller).Allow() {
			c.Header("Retry-After", "2")
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"error": "请求过于频繁"})
			return
		}
		c.Set("caller", caller)
		c.Next()
	}
}

func corsMiddleware(allowed []string) gin.HandlerFunc {
	return func(c *gin.Context) {
		origin := c.GetHeader("Origin")
		if origin != "" && slices.Contains(allowed, origin) {
			c.Header("Access-Control-Allow-Origin", origin)
			c.Header("Vary", "Origin")
			c.Header("Access-Control-Allow-Methods", "POST")
			c.Header("Access-Control-Allow-Headers", "Authorization, Content-Type")
		}
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}

// 不设置 Client.Timeout（它会限制整个流的读取时间），改用请求 context 控制总时长
var upstream = &http.Client{Transport: &http.Transport{
	Proxy:                 http.ProxyFromEnvironment,
	ResponseHeaderTimeout: 30 * time.Second,
}}

func writeEvent(c *gin.Context, event gin.H) {
	data, _ := json.Marshal(event)
	fmt.Fprintf(c.Writer, "data: %s\n\n", data)
	c.Writer.Flush()
}

func chatHandler(c *gin.Context) {
	var req ChatRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请求格式不正确"})
		return
	}
	messages := append([]Message{{Role: "system", Content: systemPrompt}}, req.Messages...)
	model := os.Getenv("LLM_MODEL")
	if model == "" {
		model = "gpt-4o-mini"
	}
	body, _ := json.Marshal(gin.H{"model": model, "messages": messages, "stream": true, "max_tokens": 1024})

	// 客户端断开时 c.Request.Context() 会被取消，上游请求随之中止
	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Minute)
	defer cancel()
	base := os.Getenv("OPENAI_BASE_URL")
	if base == "" {
		base = "https://api.openai.com/v1"
	}
	upReq, _ := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(base, "/")+"/chat/completions", bytes.NewReader(body))
	upReq.Header.Set("Content-Type", "application/json")
	upReq.Header.Set("Authorization", "Bearer "+os.Getenv("OPENAI_API_KEY"))

	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("X-Accel-Buffering", "no")
	c.Status(http.StatusOK)

	resp, err := upstream.Do(upReq)
	if err == nil && resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		err = fmt.Errorf("upstream HTTP %d", resp.StatusCode)
	}
	if err != nil {
		log.Printf("upstream error: %v caller=%s", err, c.GetString("caller")) // 完整错误只写日志
		writeEvent(c, gin.H{"type": "error", "message": "服务暂时不可用，请稍后重试"})
		return
	}
	defer resp.Body.Close()

	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		payload := strings.TrimPrefix(line, "data: ")
		if payload == "[DONE]" {
			break
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if json.Unmarshal([]byte(payload), &chunk) == nil && len(chunk.Choices) > 0 && chunk.Choices[0].Delta.Content != "" {
			writeEvent(c, gin.H{"type": "delta", "content": chunk.Choices[0].Delta.Content})
		}
	}
	if err := sc.Err(); err != nil {
		if ctx.Err() == nil { // 不是客户端断开导致的
			log.Printf("stream read error: %v", err)
			writeEvent(c, gin.H{"type": "error", "message": "服务暂时不可用，请稍后重试"})
		}
		return
	}
	writeEvent(c, gin.H{"type": "done"})
}

func main() {
	keys := splitEnv("SERVICE_API_KEYS")
	if len(keys) == 0 {
		log.Fatal("SERVICE_API_KEYS 不能为空")
	}
	r := gin.New()
	r.Use(gin.Logger(), gin.Recovery(), corsMiddleware(splitEnv("ALLOWED_ORIGINS")))
	r.GET("/healthz", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"status": "ok"}) })

	api := r.Group("/v1", authMiddleware(keys, &limiterStore{m: map[string]*rate.Limiter{}}))
	api.POST("/chat", chatHandler)

	srv := &http.Server{Addr: ":8080", Handler: r, ReadHeaderTimeout: 10 * time.Second}
	log.Fatal(srv.ListenAndServe())
}
```
```java [Java]
// src/main/java/demo/AgentServer.java  依赖：spring-boot-starter-web（Spring Boot 3）
package demo;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

@SpringBootApplication
public class AgentServer {

    public static void main(String[] args) {
        SpringApplication.run(AgentServer.class, args); // 默认端口 8080
    }

    record Message(String role, String content) {}
    record ChatRequest(List<Message> messages) {}

    static List<String> splitEnv(String key) {
        return Arrays.stream(Objects.requireNonNullElse(System.getenv(key), "").split(","))
                .map(String::strip).filter(s -> !s.isEmpty()).toList();
    }

    @Configuration
    public static class CorsConfig implements WebMvcConfigurer {
        @Override
        public void addCorsMappings(CorsRegistry registry) {
            registry.addMapping("/v1/**")
                    .allowedOrigins(splitEnv("ALLOWED_ORIGINS").toArray(String[]::new)) // 为空时不允许跨域
                    .allowedMethods("POST")
                    .allowedHeaders("Authorization", "Content-Type");
        }
    }

    /** 认证 + 限流。令牌桶：容量 10，每 2 秒补充 1 个；仅适用于单实例。 */
    @Component
    public static class ApiKeyFilter extends OncePerRequestFilter {
        private final List<byte[]> keys = splitEnv("SERVICE_API_KEYS").stream()
                .map(k -> k.getBytes(StandardCharsets.UTF_8)).toList();
        private final Map<String, double[]> buckets = new ConcurrentHashMap<>(); // [tokens, lastMillis]

        public ApiKeyFilter() {
            if (keys.isEmpty()) throw new IllegalStateException("SERVICE_API_KEYS 不能为空");
        }

        @Override
        protected boolean shouldNotFilter(HttpServletRequest req) {
            // 健康检查和 CORS 预检请求不需要认证
            return !req.getRequestURI().startsWith("/v1/") || "OPTIONS".equals(req.getMethod());
        }

        @Override
        protected void doFilterInternal(HttpServletRequest req, HttpServletResponse resp, FilterChain chain)
                throws ServletException, IOException {
            String header = Objects.requireNonNullElse(req.getHeader("Authorization"), "");
            byte[] token = header.replaceFirst("^Bearer ", "").strip().getBytes(StandardCharsets.UTF_8);
            String caller = null;
            for (byte[] k : keys) {
                // 常量时间比较，避免通过响应时间猜测密钥
                if (MessageDigest.isEqual(token, k)) {
                    caller = new String(k, 0, Math.min(6, k.length), StandardCharsets.UTF_8); // 只用前缀标识调用方
                }
            }
            if (caller == null) {
                resp.setHeader("WWW-Authenticate", "Bearer");
                resp.sendError(HttpStatus.UNAUTHORIZED.value(), "未授权");
                return;
            }
            if (!allow(caller)) {
                resp.setHeader("Retry-After", "2");
                resp.sendError(HttpStatus.TOO_MANY_REQUESTS.value(), "请求过于频繁");
                return;
            }
            req.setAttribute("caller", caller);
            chain.doFilter(req, resp);
        }

        private boolean allow(String caller) {
            double[] b = buckets.computeIfAbsent(caller, k -> new double[]{10, System.currentTimeMillis()});
            synchronized (b) {
                long now = System.currentTimeMillis();
                b[0] = Math.min(10, b[0] + (now - b[1]) / 2000.0);
                b[1] = now;
                if (b[0] < 1) return false;
                b[0] -= 1;
                return true;
            }
        }
    }

    @RestController
    public static class ChatController {
        private static final Logger log = LoggerFactory.getLogger(ChatController.class);
        private static final String SYSTEM_PROMPT = "你是一个简洁、友好的助手。";
        private static final Set<String> ROLES = Set.of("user", "assistant"); // 不允许客户端提交 system 消息
        private final ObjectMapper mapper = new ObjectMapper();
        private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
        private final ExecutorService pool = Executors.newFixedThreadPool(32); // 限制并发流数量

        @GetMapping("/healthz")
        public Map<String, String> healthz() {
            return Map.of("status", "ok");
        }

        @PostMapping(path = "/v1/chat", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
        public SseEmitter chat(@RequestBody ChatRequest req, @RequestAttribute("caller") String caller) {
            validate(req);
            SseEmitter emitter = new SseEmitter(Duration.ofMinutes(5).toMillis());
            AtomicBoolean closed = new AtomicBoolean(false);
            emitter.onCompletion(() -> closed.set(true));
            emitter.onTimeout(() -> closed.set(true));
            emitter.onError(e -> closed.set(true));
            pool.submit(() -> stream(req, caller, emitter, closed));
            return emitter;
        }

        private void validate(ChatRequest req) {
            if (req == null || req.messages() == null || req.messages().isEmpty() || req.messages().size() > 50) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "messages 数量应在 1~50 之间");
            }
            for (Message m : req.messages()) {
                if (m == null || m.role() == null || !ROLES.contains(m.role())
                        || m.content() == null || m.content().isBlank()
                        || m.content().codePointCount(0, m.content().length()) > 8000) {
                    throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "消息格式不正确");
                }
            }
        }

        private void stream(ChatRequest req, String caller, SseEmitter emitter, AtomicBoolean closed) {
            List<Map<String, String>> messages = new ArrayList<>();
            messages.add(Map.of("role", "system", "content", SYSTEM_PROMPT));
            req.messages().forEach(m -> messages.add(Map.of("role", m.role(), "content", m.content())));
            String model = Optional.ofNullable(System.getenv("LLM_MODEL")).orElse("gpt-4o-mini");
            String base = Optional.ofNullable(System.getenv("OPENAI_BASE_URL")).filter(s -> !s.isBlank())
                    .orElse("https://api.openai.com/v1").replaceAll("/+$", "");
            try {
                String body = mapper.writeValueAsString(Map.of(
                        "model", model, "messages", messages, "stream", true, "max_tokens", 1024));
                HttpRequest upReq = HttpRequest.newBuilder(URI.create(base + "/chat/completions"))
                        .timeout(Duration.ofSeconds(30)) // 等待响应头的超时
                        .header("Content-Type", "application/json")
                        .header("Authorization", "Bearer " + System.getenv("OPENAI_API_KEY"))
                        .POST(HttpRequest.BodyPublishers.ofString(body)).build();
                HttpResponse<java.io.InputStream> resp = http.send(upReq, HttpResponse.BodyHandlers.ofInputStream());
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(resp.body(), StandardCharsets.UTF_8))) {
                    if (resp.statusCode() != 200) throw new IOException("upstream HTTP " + resp.statusCode());
                    String line;
                    while (!closed.get() && (line = reader.readLine()) != null) { // 客户端断开后停止读取上游
                        if (!line.startsWith("data: ")) continue;
                        String payload = line.substring(6);
                        if (payload.equals("[DONE]")) break;
                        JsonNode content = mapper.readTree(payload).path("choices").path(0).path("delta").path("content");
                        if (content.isTextual() && !content.asText().isEmpty()) {
                            emitter.send(Map.of("type", "delta", "content", content.asText()));
                        }
                    }
                }
                if (!closed.get()) {
                    emitter.send(Map.of("type", "done"));
                    emitter.complete();
                }
            } catch (Exception e) {
                log.error("upstream error, caller={}", caller, e); // 完整错误只写日志
                if (!closed.get()) {
                    try {
                        emitter.send(Map.of("type", "error", "message", "服务暂时不可用，请稍后重试"));
                    } catch (IOException ignored) {
                        // 客户端已断开
                    }
                    emitter.complete();
                }
            }
        }
    }
}
```
:::

用 `curl` 测试（`-N` 关闭缓冲，实时看到事件）：

```bash
curl -N http://localhost:8080/v1/chat \
  -H "Authorization: Bearer $SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "用一句话介绍 SSE"}]}'
```

不带 `Authorization` 头应返回 401，短时间内连续请求超过 10 次应返回 429，提交 `"role": "system"` 的消息应返回 400。这三项值得写成自动化测试。

浏览器端注意：原生 `EventSource` 只支持 GET 请求，不能携带自定义请求头。POST 加认证头的场景，前端一般用 `fetch` 读取 `response.body` 流并自行解析 `data:` 行，具体写法见 [流式输出与 SSE](/guide/01-programming/streaming-sse)。

## 生产环境的流式细节

| 问题 | 现象 | 处理 |
| --- | --- | --- |
| 反向代理缓冲 | 客户端等到最后才一次性收到全部内容 | Nginx 对该路径设置 `proxy_buffering off`，或响应头加 `X-Accel-Buffering: no`（本文已加） |
| 代理空闲超时 | 模型思考或工具执行较久时连接被断开 | 调大代理的读超时；长时间无输出时定期发送 SSE 注释行（以冒号开头）作为心跳 |
| 客户端断开 | 用户关掉页面，服务端还在继续生成，白白消耗 Token | 检测断开并取消上游请求（三个实现都已处理） |
| 线程占用 | Spring MVC 中每个流占用一个线程 | 限制线程池大小与并发流数量；并发很高时考虑 WebFlux（返回 `Flux<ServerSentEvent<T>>`）或虚拟线程（Java 21+） |
| 错误发生在流中途 | 已经返回 200 状态码，无法再改成 500 | 用 `error` 事件告知客户端，前端据此提示和重试 |
| 多实例部署 | 进程内限流失效 | 网关层或 Redis 统一限流 |

部署、健康检查和监控见下一篇 [部署、监控与运维](/guide/15-production/deployment)。

## 常见坑

- **接口没有认证就上线**。哪怕是"内部测试"，暴露在公网的模型接口很快会被扫描到并被滥用，账单可能在几小时内失控。
- **CORS 配置成允许任意来源**。`allow_origins=["*"]` 加上携带凭证，等于允许任何网站以用户身份调用你的接口。只允许明确的前端域名。
- **允许客户端提交 system 消息**。客户端可以借此完全改写 Agent 的行为。系统提示词只能由服务端设置。
- **把上游错误原样返回**。错误信息中可能包含内部地址、模型配置或请求内容。返回通用错误，详细信息写日志。
- **HTTP 客户端的总超时截断了流**。Go 的 `http.Client.Timeout` 包括读取响应体的时间，设成 30 秒会把超过 30 秒的流式回答截断。流式场景应分别控制连接、响应头和总时长。
- **日志里打印了 Authorization 头**。调试时打印完整请求头，密钥就进了日志系统。

## 小测

1. 为什么说 CORS 白名单不能代替认证？

::: details 查看答案
CORS 是浏览器执行的策略，只限制网页中的跨域请求。攻击者用 curl、脚本或服务端程序调用接口时，根本不受 CORS 约束。访问控制必须由服务端的认证和授权完成。
:::

2. 用户在回答生成到一半时关闭了页面，如果服务端不做任何处理，会发生什么？三个实现分别是怎么处理的？

::: details 查看答案
服务端会继续读取上游流直到生成完毕，Token 照常计费，线程或连接也被继续占用。Python 实现在循环中检查 `request.is_disconnected()` 并退出，`async with stream` 负责关闭上游连接；Go 实现通过 `c.Request.Context()` 派生的 context 发起上游请求，客户端断开时 context 被取消，上游请求随之中止；Java 实现在 `SseEmitter` 的完成、超时、错误回调中设置标志位，读取循环检测到后停止。
:::

3. 服务部署了 4 个实例，每个实例的进程内限流是"每个调用方每分钟 30 次"。实际的限流效果是什么？如何改进？

::: details 查看答案
负载均衡把请求分散到 4 个实例，每个实例单独计数，调用方实际最多可以达到每分钟约 120 次，限流失效。改进方式是使用共享存储（如 Redis）实现分布式限流，或在 API 网关、Nginx 层统一限流。
:::

## 延伸阅读

- [FastAPI 文档](https://fastapi.tiangolo.com/)
- [Gin 文档](https://gin-gonic.com/docs/)
- [Spring Boot 文档](https://docs.spring.io/spring-boot/index.html)
- [MDN：使用服务器发送事件](https://developer.mozilla.org/zh-CN/docs/Web/API/Server-sent_events/Using_server-sent_events)
- [OWASP API Security Top 10](https://owasp.org/API-Security/)
- 本站：[流式输出与 SSE](/guide/01-programming/streaming-sse)、[流式响应实战](/guide/03-llm-api/streaming)、[计费、限流与错误重试](/guide/03-llm-api/cost-errors)

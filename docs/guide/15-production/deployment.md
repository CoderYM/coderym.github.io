---
title: 部署、监控与运维
description: 用多阶段构建和非 root 用户打包 Agent 服务，正确管理密钥，配置健康检查与优雅停机，监控延迟、Token、错误率和工具失败率，并为代码、提示词和模型的变更准备回滚方案。
---

# 部署、监控与运维

::: info 学习目标
- 为 Python / Go / Java 的 Agent 服务编写多阶段构建、非 root 运行的 Dockerfile
- 正确管理 API Key 等密钥：不进镜像、不进代码、不进日志
- 区分存活检查和就绪检查，处理流式连接的优雅停机
- 知道 Agent 服务要监控哪些指标、如何告警，以及如何回滚"代码 + 提示词 + 模型"的组合变更
:::

## Agent 服务的运维有什么不同

[上一篇](/guide/15-production/serving) 把 Agent 包装成了 HTTP 服务。它本质上仍是一个 Web 服务，容器化、健康检查、监控这些通用实践都适用，但有几个特点需要额外注意：

| 特点 | 影响 |
| --- | --- |
| 请求时间长（数秒到数分钟） | 发布、扩缩容时不能粗暴断开连接；超时要逐层配置 |
| 每个请求都在花钱 | 成本是一等指标，要像错误率一样监控和告警 |
| 依赖外部模型服务 | 上游限流、故障、静默更新都会直接影响你的服务 |
| 行为由提示词和模型共同决定 | "发布"不只是发布代码，提示词和模型版本也是变更 |
| 失败往往不是报错 | 回答质量下降时，HTTP 状态码仍是 200 |

## 容器化

三份 Dockerfile 遵循相同的原则：

- **多阶段构建**：构建阶段包含编译器和构建工具，运行阶段只保留运行所需的文件，镜像更小，攻击面更少；
- **非 root 用户运行**：即使服务被攻破，攻击者也没有容器内的 root 权限；
- **代码文件归 root 所有**：运行用户只能读取代码，不能修改；
- **不包含任何密钥**：密钥在运行时通过环境变量注入。

::: code-group
```dockerfile [Python]
# Dockerfile（FastAPI 服务，依赖写在 requirements.txt 中并锁定版本）
FROM python:3.12-slim AS builder
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
COPY requirements.txt .
RUN pip install -r requirements.txt

FROM python:3.12-slim
RUN useradd --create-home --uid 10001 app
COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH" PYTHONUNBUFFERED=1
WORKDIR /app
COPY server.py .
USER app
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=2)" || exit 1
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080", "--timeout-graceful-shutdown", "30"]
```
```dockerfile [Go]
# Dockerfile（Gin 服务）
FROM golang:1.22 AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/server .

# distroless 镜像不含 shell 和包管理器，自带 CA 证书，nonroot 标签默认以非 root 用户运行
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=builder /out/server /server
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/server"]
```
```dockerfile [Java]
# Dockerfile（Spring Boot 服务，使用 Maven Wrapper 构建）
FROM eclipse-temurin:21-jdk AS builder
WORKDIR /src
COPY mvnw pom.xml ./
COPY .mvn .mvn
RUN ./mvnw -B dependency:go-offline
COPY src src
RUN ./mvnw -B package -DskipTests

FROM eclipse-temurin:21-jre
RUN useradd --system --uid 10001 app
WORKDIR /app
COPY --from=builder /src/target/*.jar app.jar
USER app
EXPOSE 8080
# 按容器内存限制设置堆大小，避免被 OOM Kill
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=75", "-jar", "/app/app.jar"]
```
:::

说明：

- Go 和 Java 的镜像没有写 `HEALTHCHECK`：distroless 镜像里没有 shell 和 curl，通常交给编排平台（如 Kubernetes 的探针）通过 HTTP 检查。Docker Compose 等场景需要容器内检查时，可以给程序加一个 `-healthcheck` 参数自检。
- 先复制依赖清单（`requirements.txt`、`go.mod`、`pom.xml`）并安装依赖，再复制源码，这样只改代码时能复用依赖层的构建缓存。
- 基础镜像版本仅为示例，生产中建议固定到具体版本甚至镜像摘要，并定期更新以获得安全补丁。Go 构建镜像的版本不应低于 `go.mod` 中声明的版本。

同时一定要加 `.dockerignore`，防止把本地的密钥和无关文件打进镜像：

```text
.env
.env.*
.git
__pycache__/
*.log
target/
node_modules/
```

## 密钥与配置管理

| 做法 | 说明 |
| --- | --- |
| ✗ 写在代码里 | 随代码进入 Git 历史，难以彻底清除 |
| ✗ 写进镜像（`ENV`、`COPY .env`） | 任何能拉取镜像的人都能用 `docker history` 或解包看到 |
| ✗ 打印到日志 | 日志系统的访问范围通常比密钥管理系统大得多 |
| ✓ 运行时注入环境变量 | 由编排平台从密钥存储（Kubernetes Secret、云厂商的密钥管理服务等）注入 |
| ✓ 按环境区分密钥 | 开发、测试、生产使用不同的 Key，CI 也单独一个 |
| ✓ 设置用量上限 | 在模型厂商控制台为每个 Key 设置额度和告警 |
| ✓ 定期轮换 | 支持同时配置新旧两个 Key，平滑切换（上一篇的 `SERVICE_API_KEYS` 支持多个值就是为此） |

非敏感配置（模型名、超时、限流参数、功能开关）也应通过环境变量或配置中心管理，不要硬编码，这样调整时不需要重新构建镜像。

## 健康检查与优雅停机

| 检查 | 回答的问题 | 失败时 | Agent 服务应检查什么 |
| --- | --- | --- | --- |
| 存活检查（liveness） | 进程是否卡死，需要重启吗？ | 重启容器 | 只检查进程能响应，**不要检查外部依赖** |
| 就绪检查（readiness） | 现在能接收流量吗？ | 从负载均衡中摘除 | 配置已加载、必要的本地依赖（数据库、缓存）可用 |

一个常见错误是在存活检查里调用模型 API：模型厂商一旦出现短暂故障，所有实例同时被判定为"不存活"并被重启，故障被放大；而且每次探测都在花钱。上游模型的可用性应通过监控指标观察，而不是放进健康检查。

在 Kubernetes 中的配置示意（Spring Boot 可使用 Actuator 提供的健康端点，具体路径以官方文档为准）：

```yaml
containers:
  - name: agent
    image: registry.example.com/agent:1.4.2
    ports: [{containerPort: 8080}]
    envFrom:
      - secretRef: {name: agent-secrets}   # OPENAI_API_KEY、SERVICE_API_KEYS
      - configMapRef: {name: agent-config} # LLM_MODEL、ALLOWED_ORIGINS
    livenessProbe:
      httpGet: {path: /healthz, port: 8080}
      periodSeconds: 10
    readinessProbe:
      httpGet: {path: /healthz, port: 8080}
      periodSeconds: 5
    resources:
      requests: {cpu: "250m", memory: "256Mi"}
      limits: {memory: "512Mi"}
terminationGracePeriodSeconds: 60
```

**优雅停机**对流式服务尤其重要。发布新版本时，旧实例收到 SIGTERM 后应停止接收新请求，等待正在进行的流结束（或到达超时）再退出，否则用户会看到回答生成到一半突然中断。

- Python：上面的 Dockerfile 使用了 uvicorn 的 `--timeout-graceful-shutdown`；
- Go：监听 SIGTERM 后调用 `http.Server.Shutdown(ctx)`，它会等待活跃连接完成；
- Java：Spring Boot 配置 `server.shutdown=graceful` 和 `spring.lifecycle.timeout-per-shutdown-phase=30s`；
- 编排平台的终止宽限期（如 `terminationGracePeriodSeconds`）要大于应用的停机等待时间。

## 监控什么

| 类别 | 指标 | 为什么重要 |
| --- | --- | --- |
| 流量 | 请求数、并发流数量 | 容量规划，发现异常流量 |
| 延迟 | 首 Token 延迟 P50/P95、总耗时 P50/P95 | 用户体验；流式场景首 Token 延迟比总耗时更关键 |
| 错误 | 按类型统计：4xx、5xx、上游 429、上游超时、流中断 | 区分是自己的问题、调用方的问题还是厂商的问题 |
| Token 与成本 | 每请求输入 / 输出 Token、按用户和功能聚合的日用量、估算费用 | 成本失控通常先体现在这里 |
| Agent 行为 | 每请求步数、工具调用次数、**各工具失败率**、达到步数上限的比例 | 工具失败和死循环是 Agent 特有的故障模式 |
| 安全 | 护栏触发次数、认证失败、限流触发、被拒绝的工具调用 | 发现攻击和误拦 |
| 质量 | 在线采样评审通过率、用户点踩率、转人工率 | 状态码看不出的质量退化，见 [回归测试与持续评估](/guide/14-evaluation/regression) |
| 缓存 | 提示缓存命中率、响应缓存命中率 | 成本优化是否生效 |

这些指标大部分可以从 [轨迹](/guide/14-evaluation/observability) 数据中聚合出来。告警建议从少量高价值规则开始，例如：

- 5xx 与上游错误率在 5 分钟内超过阈值；
- 首 Token 延迟 P95 明显高于过去一周同时段；
- 单个用户的日 Token 用量超过上限，或整体用量相比昨天同时段异常增长；
- 某个工具的失败率突然升高；
- 在线评审通过率连续下降。

日志使用结构化格式（JSON），每条带上 `trace_id` 和请求 ID，便于从告警跳转到具体轨迹。记录前对用户内容做脱敏，绝不记录密钥和 Authorization 头。

## 发布与回滚

Agent 的一次"发布"可能包含四类变更，任何一类都可能导致质量变化：

```text
发布单元 = 代码版本 + 提示词版本 + 模型名 / 参数 + 工具定义
```

建议：

- **把四者绑定为一个版本号**。轨迹和日志中记录这个版本号，出问题时能精确知道是哪个组合。提示词的版本管理见 [提示词版本管理与测试](/guide/04-prompt/prompt-management)。
- **发布前跑评估**。CI 中的回归评估通过后才允许发布。
- **灰度发布**。先把 5%~10% 的流量导到新版本，对比新旧版本的错误率、延迟、Token 用量和在线评审结果，没有问题再逐步扩大。
- **保留上一个版本的镜像和配置**，回滚应该是一条命令或一次点击。
- **模型切换用开关控制**。通过配置在新旧模型之间切换，不需要重新构建和部署。
- **注意不可回滚的部分**。长期记忆、向量库的结构变更，回滚代码不会把数据恢复原状。这类变更需要兼容新旧两种格式，或单独规划迁移与回退方案。

触发回滚的条件应该事先写下来，例如"灰度期间错误率比旧版本高 2 个百分点"或"在线评审通过率下降超过 5%"，而不是出问题时临场讨论。

## 常见坑

- **把 `.env` 打进了镜像**。没有 `.dockerignore`，`COPY . .` 会把本地密钥文件一起复制进去。
- **以 root 用户运行容器**。默认的官方镜像大多以 root 运行，需要显式创建用户并切换。
- **存活检查依赖模型 API**。上游一抖动，所有实例被反复重启。
- **没有优雅停机**。每次发布都会中断一批正在进行的对话。
- **只监控 HTTP 状态码**。Agent 答错了、绕圈了、Token 用量翻倍了，状态码都是 200。
- **只回滚代码，不回滚提示词或模型配置**。问题实际出在提示词变更上，回滚代码后问题依旧。
- **没有成本告警**。月底看到账单才发现某个调用方在循环调用。

## 小测

1. 为什么不应该在存活检查里调用一次模型 API 来确认服务可用？

::: details 查看答案
存活检查失败会导致容器重启。模型厂商出现短暂故障或限流时，所有实例会同时被判定为不存活并反复重启，把外部故障放大为自己服务的整体故障；同时每次探测都消耗额度。存活检查只应检查进程本身，上游可用性通过监控指标观察。
:::

2. 一次发布后，用户反馈回答质量明显下降，但错误率、延迟都正常。你会如何定位和处理？

::: details 查看答案
先确认这次发布包含哪些变更（代码、提示词、模型、工具定义），查看在线评审通过率和用户点踩率是否同步下降；从轨迹中抽取质量下降的样本，与旧版本的轨迹对比；如果影响明显，按事先定义的条件先回滚到上一个版本组合，再离线复现问题，并把问题样本加入回归评估集。
:::

3. 为什么 `ENV OPENAI_API_KEY=...` 写在 Dockerfile 里是不安全的，即使镜像仓库是私有的？

::: details 查看答案
密钥会成为镜像元数据和镜像层的一部分，任何能拉取镜像的人（包括 CI 系统、其他团队、未来的人员）都能通过 `docker history` 或解包镜像看到。私有仓库的访问范围通常比密钥管理系统宽，镜像也可能被复制到其他地方。密钥轮换还需要重新构建镜像。应在运行时由编排平台从密钥存储注入。
:::

## 延伸阅读

- [Docker 多阶段构建文档](https://docs.docker.com/build/building/multi-stage/)
- [Distroless 镜像（GitHub）](https://github.com/GoogleContainerTools/distroless)
- [Kubernetes：配置存活、就绪和启动探针](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)
- [Spring Boot Actuator 文档](https://docs.spring.io/spring-boot/reference/actuator/index.html)
- 本站：[服务化：FastAPI / Gin / Spring Boot](/guide/15-production/serving)、[轨迹追踪与可观测性](/guide/14-evaluation/observability)、[成本与延迟优化](/guide/15-production/cost-optimization)

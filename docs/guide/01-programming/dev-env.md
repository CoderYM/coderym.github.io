---
title: 开发环境：Python / Go / Java
description: 搭建 Python、Go、Java 三套 Agent 开发环境，统一用环境变量管理 API Key，并用一段脚本验证能调通大模型。
---

# 开发环境：Python / Go / Java

::: info 学习目标
- 为 Python 3.10+、Go 1.22+、Java 17+ 准备好可用的项目环境
- 用 `.env` 和环境变量统一管理 API Key、Base URL 和模型名
- 跑通一段「第一次调用大模型」的验证脚本（三种语言）
- 避开环境搭建中最常见的网络、版本和密钥问题
:::

## 选哪种语言

本站示例以 Python 为主，Go 和 Java 为辅。三者在 Agent 开发中的定位大致如下：

| 语言 | 优势 | 适合 |
| --- | --- | --- |
| Python | 生态最全，几乎所有模型 SDK、Agent 框架、RAG 工具都优先支持 | 原型、研究、大多数 Agent 应用 |
| Go | 并发简单、部署是单个二进制、性能好 | 高并发网关、Agent 服务端、基础设施 |
| Java | 企业系统主力，Spring 生态成熟 | 接入已有业务系统的企业级 Agent |

如果你只打算学一种，选 Python。如果你的工作语言是 Go 或 Java，用工作语言跟着练，同时能看懂 Python 示例即可。

## 第一步：准备 API Key 和 .env

所有示例都通过 **OpenAI 兼容的 Chat Completions API** 调用模型，用三个环境变量配置：

| 变量 | 是否必填 | 说明 |
| --- | --- | --- |
| `OPENAI_API_KEY` | 必填 | 模型服务的 API Key |
| `OPENAI_BASE_URL` | 可选 | 兼容接口地址，默认 `https://api.openai.com/v1`。用 DeepSeek、通义千问、Kimi 等时改成对应厂商文档给出的地址 |
| `LLM_MODEL` | 建议填 | 模型名，必须是该厂商支持的名字 |

在项目根目录创建 `.env`：

```bash
OPENAI_API_KEY=sk-你的key
# OPENAI_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini   # 仅为示例，按你使用的厂商填写
```

然后**立刻**把它加入 `.gitignore`：

```bash
echo ".env" >> .gitignore
```

Python 可以用 `python-dotenv` 自动读取 `.env`。Go 和 Java 示例为了保持零依赖，直接读系统环境变量，运行前在 shell 里加载：

```bash
# macOS / Linux：把 .env 中的变量导出到当前 shell
set -a; source .env; set +a
```

Windows PowerShell 可以用 `$env:OPENAI_API_KEY="sk-..."` 逐个设置，或在 IDE 的运行配置里填写环境变量。

## Python 环境

**版本**：Python 3.10 或更高（本站代码会用到 `X | None` 类型写法和 `match` 语句）。

推荐用 [uv](https://docs.astral.sh/uv/) 管理 Python 版本和依赖，它速度快，并能自动创建虚拟环境。也可以用自带的 `venv` + `pip`，两种方式任选：

::: code-group
```bash [uv]
# 安装 uv 见官方文档；然后：
uv init agent-lab && cd agent-lab
uv add openai python-dotenv
uv run main.py
```
```bash [venv + pip]
mkdir agent-lab && cd agent-lab
python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install openai python-dotenv
python main.py
```
:::

**一定要用虚拟环境**。直接往系统 Python 里装包，迟早会遇到版本冲突。

## Go 环境

**版本**：Go 1.22 或更高。从 [go.dev/dl](https://go.dev/dl/) 安装后检查：

```bash
go version
mkdir agent-lab-go && cd agent-lab-go
go mod init example.com/agentlab
# 本站 Go 示例只用标准库，无需 go get 任何依赖
go run main.go
```

国内网络如果拉取第三方模块很慢，可以设置模块代理，例如 `go env -w GOPROXY=https://goproxy.cn,direct`。

## Java 环境

**版本**：JDK 17 或更高（推荐 LTS 版本 17 或 21）。可以从 [Adoptium](https://adoptium.net/) 下载 Temurin 发行版，或用 SDKMAN! 等工具管理多个版本。

本站 Java 示例使用标准库 `java.net.http.HttpClient` 发请求，用 Jackson 处理 JSON。用 Maven 时在 `pom.xml` 中加入：

```xml
<properties>
  <maven.compiler.release>17</maven.compiler.release>
</properties>
<dependencies>
  <dependency>
    <groupId>com.fasterxml.jackson.core</groupId>
    <artifactId>jackson-databind</artifactId>
    <version>2.17.2</version> <!-- 示例版本，可用更新的 2.x 版本 -->
  </dependency>
</dependencies>
```

Gradle 写法：`implementation("com.fasterxml.jackson.core:jackson-databind:2.17.2")`。

## 编辑器

- **VS Code**：装 Python、Go、Extension Pack for Java 扩展，一个编辑器覆盖三种语言。
- **JetBrains**：PyCharm、GoLand、IntelliJ IDEA 各自对应语言，体验更完整。
- 无论用哪个，都把 IDE 的 Python 解释器指向项目里的 `.venv`，否则会出现「明明装了包却提示找不到」的问题。

## 验证：第一次调通模型

下面的脚本读取环境变量，发一条消息，打印回复。三个版本行为一致：缺少 Key 时直接报错退出，HTTP 请求设置了超时，并且**不会打印 Key**。

::: code-group
```python [Python]
# main.py  依赖：pip install openai python-dotenv
import os
import sys

from openai import OpenAI

try:
    from dotenv import load_dotenv  # 可选：自动读取 .env
    load_dotenv()
except ImportError:
    pass


def main() -> None:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        sys.exit("缺少环境变量 OPENAI_API_KEY")
    model = os.getenv("LLM_MODEL", "gpt-4o-mini")

    # base_url 为 None 时 SDK 使用默认地址
    client = OpenAI(
        api_key=api_key,
        base_url=os.getenv("OPENAI_BASE_URL") or None,
        timeout=30.0,
    )
    resp = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": "用一句话介绍你自己"}],
    )
    print(f"[{model}]", resp.choices[0].message.content)


if __name__ == "__main__":
    main()
```
```go [Go]
// main.go  仅使用标准库
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

type message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatRequest struct {
	Model    string    `json:"model"`
	Messages []message `json:"messages"`
}

type chatResponse struct {
	Choices []struct {
		Message message `json:"message"`
	} `json:"choices"`
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" {
		log.Fatal("缺少环境变量 OPENAI_API_KEY")
	}
	baseURL := strings.TrimRight(getenv("OPENAI_BASE_URL", "https://api.openai.com/v1"), "/")
	model := getenv("LLM_MODEL", "gpt-4o-mini")

	body, err := json.Marshal(chatRequest{
		Model:    model,
		Messages: []message{{Role: "user", Content: "用一句话介绍你自己"}},
	})
	if err != nil {
		log.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPost, baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		log.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Fatal(err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		log.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		log.Fatalf("HTTP %d: %s", resp.StatusCode, data)
	}
	var out chatResponse
	if err := json.Unmarshal(data, &out); err != nil {
		log.Fatal(err)
	}
	if len(out.Choices) == 0 {
		log.Fatal("响应中没有 choices")
	}
	fmt.Printf("[%s] %s\n", model, out.Choices[0].Message.Content)
}
```
```java [Java]
// Main.java  依赖：com.fasterxml.jackson.core:jackson-databind
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;

public class Main {
    record Message(String role, String content) {}
    record ChatRequest(String model, List<Message> messages) {}

    static String getenv(String key, String def) {
        String v = System.getenv(key);
        return (v == null || v.isBlank()) ? def : v;
    }

    public static void main(String[] args) throws Exception {
        String apiKey = System.getenv("OPENAI_API_KEY");
        if (apiKey == null || apiKey.isBlank()) {
            System.err.println("缺少环境变量 OPENAI_API_KEY");
            System.exit(1);
        }
        String baseUrl = getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").replaceAll("/+$", "");
        String model = getenv("LLM_MODEL", "gpt-4o-mini");

        ObjectMapper mapper = new ObjectMapper();
        String body = mapper.writeValueAsString(
                new ChatRequest(model, List.of(new Message("user", "用一句话介绍你自己"))));

        HttpClient client = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .build();
        HttpRequest request = HttpRequest.newBuilder(URI.create(baseUrl + "/chat/completions"))
                .timeout(Duration.ofSeconds(30))
                .header("Authorization", "Bearer " + apiKey)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();

        HttpResponse<String> resp = client.send(request, HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() != 200) {
            System.err.println("HTTP " + resp.statusCode() + ": " + resp.body());
            System.exit(1);
        }
        JsonNode root = mapper.readTree(resp.body());
        String content = root.path("choices").path(0).path("message").path("content").asText();
        System.out.println("[" + model + "] " + content);
    }
}
```
:::

运行方式：Python 用 `python main.py`（或 `uv run main.py`）；Go 用 `go run main.go`；Java 在 Maven 项目里运行 `Main`，或下载 Jackson 的三个 jar（databind、core、annotations）后用 `java -cp "jars/*" Main.java` 直接运行单文件源码。

看到模型的自我介绍，环境就准备好了。下一步可以读 [第一次调用大模型](/guide/03-llm-api/first-call) 了解每个参数的含义。

## 常见坑

| 现象 | 常见原因 | 解决 |
| --- | --- | --- |
| `401 Unauthorized` | Key 错误、过期，或 Key 和 Base URL 不属于同一厂商 | 检查 Key 与 `OPENAI_BASE_URL` 是否匹配 |
| `404 Not Found` | Base URL 少了 `/v1` 之类的路径，或多了 `/chat/completions` | Base URL 只写到版本路径，按厂商文档填写 |
| 模型不存在 | `LLM_MODEL` 写了别家的模型名 | 改成该厂商支持的模型名 |
| 连接超时 | 网络无法访问该服务 | 换用可访问的厂商，或按公司规定配置代理 |
| `ModuleNotFoundError: openai` | 包装在了别的 Python 环境里 | 激活 `.venv`，并让 IDE 使用同一个解释器 |
| 读不到环境变量 | `.env` 没被加载，或在另一个终端里设置的 | Go/Java 运行前执行 `set -a; source .env; set +a` |

另外两条原则：

- **Key 永远不进代码和日志**。调试时打印「Key 是否存在」，不要打印 Key 本身。
- **Key 泄露了就立刻作废**。在厂商控制台删除旧 Key 并生成新 Key，仅仅从仓库删除提交记录是不够的。

## 小测

**1. 想把示例从 OpenAI 切换到另一家兼容 OpenAI 接口的厂商，需要改哪些地方？**

::: details 查看答案
只改环境变量：`OPENAI_API_KEY` 换成新厂商的 Key，`OPENAI_BASE_URL` 换成它的兼容接口地址，`LLM_MODEL` 换成它支持的模型名。代码不用动。
:::

**2. 为什么示例里都给 HTTP 请求设置了超时？**

::: details 查看答案
大模型请求可能因为网络或服务端排队而长时间挂起。不设超时，程序会一直阻塞，在 Agent 循环或服务端里会占满连接和线程。生产中还要配合重试和退避，见 [计费、限流与错误重试](/guide/03-llm-api/cost-errors)。
:::

**3. 同事把 `.env` 提交到了公共仓库，随后又删除了这次提交。还需要做什么？**

::: details 查看答案
必须立即在厂商控制台作废该 Key 并生成新 Key。公共仓库的内容可能已被抓取，Git 历史和 fork 中也可能还留着。之后把 `.env` 加入 `.gitignore`，可以考虑在 CI 中加入密钥扫描。
:::

## 延伸阅读

- [uv 官方文档](https://docs.astral.sh/uv/)
- [OpenAI Python SDK](https://github.com/openai/openai-python)
- [Go 下载与安装](https://go.dev/doc/install)
- [Jackson Databind](https://github.com/FasterXML/jackson-databind)
- 本站：[第一次调用大模型](/guide/03-llm-api/first-call)、[主流模型厂商 API 对比](/guide/03-llm-api/providers)

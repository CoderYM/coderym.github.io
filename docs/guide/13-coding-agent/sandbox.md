---
title: 沙箱与代码执行安全
description: 安全运行模型生成的代码：Docker 无网络、资源限制、只读文件系统与超时，以及 gVisor、Firecracker、E2B 等更强的隔离方案。
---

# 沙箱与代码执行安全

::: info 学习目标
- 理解为什么模型生成的代码必须当作不可信代码对待
- 掌握 Docker 沙箱的关键配置：无网络、资源限制、只读文件系统、非 root、超时
- 用 Python / Go / Java 以参数数组方式安全地启动容器执行代码，并正确处理超时
- 了解 gVisor、Firecracker、E2B 等更强隔离方案的定位和取舍
:::

## 为什么需要沙箱

代码解释器、数据分析 Agent、[编码 Agent](/guide/13-coding-agent/coding-agents) 都有一个共同能力：执行模型生成的代码。这些代码的来源决定了它不可信：

- **模型会犯错。** 一个写错路径的 `shutil.rmtree`、一个死循环、一次读入 10 GB 文件，都可能是"无心之失"。
- **模型会被诱导。** 用户输入、上传的文件、网页内容里都可能藏着 [Prompt 注入](/guide/15-production/prompt-injection)，让模型生成读取环境变量、外发数据的代码。
- **依赖也不可信。** 模型让你 `pip install` 的包名可能拼错，正好撞上恶意的同名包。

所以原则只有一条：**模型生成的代码，按"来自陌生人的代码"处理。** 绝不在宿主进程里 `exec()`/`eval()`，也不在宿主机上直接 `python -c`。

## 威胁与对应措施

| 威胁 | 例子 | 措施 |
| --- | --- | --- |
| 数据外发 | 读取环境变量里的 API Key 发到外部服务器 | 无网络（`--network none`）；容器里不放任何密钥 |
| 破坏宿主文件 | 删除、篡改宿主机文件 | 不挂载宿主目录；根文件系统只读；非 root 用户 |
| 资源耗尽 | 死循环、内存爆炸、fork 炸弹、写满磁盘 | 超时、内存/CPU 上限、进程数上限、tmpfs 限额 |
| 提权与逃逸 | 利用内核漏洞或特权能力逃出容器 | 去掉所有 capability、`no-new-privileges`；更强隔离用 gVisor/microVM |
| 注入宿主命令 | 代码字符串被拼进 shell 命令 | 用参数数组启动进程，代码通过 stdin 传入 |
| 输出撑爆上下文 | 打印一百万行 | 截断输出 |

## 隔离强度的层次

```text
隔离强度    方案                         说明
  弱    ┌─ 宿主进程内 exec/eval          ✗ 不可接受
   │    ├─ 宿主机子进程 + 超时            只防死循环，不防任何恶意行为
   │    ├─ Docker 容器（加固配置）         共享宿主内核，大部分场景的基础方案
   │    ├─ gVisor（runsc）               用户态内核拦截系统调用，缩小内核攻击面
   ▼    ├─ Firecracker 等 microVM        独立内核的轻量虚拟机，启动快、隔离强
  强    └─ 独立虚拟机 / 独立物理机          最强，成本最高
```

- **Docker** 是起点。容器共享宿主机内核，配置得当可以挡住绝大多数误操作和常见攻击，但内核漏洞可能导致逃逸。适合运行内部用户触发的代码。
- **gVisor** 是 Google 开源的容器运行时，在用户态实现了一个内核来拦截应用的系统调用，应用不直接接触宿主内核。可以作为 Docker 的运行时（`--runtime=runsc`）使用，代价是部分系统调用变慢、兼容性略差。
- **Firecracker** 是 AWS 开源的 microVM 技术（AWS Lambda 使用它），每个沙箱有独立内核，启动时间在百毫秒量级。面向公网用户的多租户代码执行，通常需要这一级别的隔离。
- **托管沙箱服务**，比如 E2B，提供基于 microVM 的云端沙箱 API，你调用 SDK 创建沙箱、执行代码、读取结果，不用自己运维隔离基础设施。代价是依赖外部服务，代码和数据会离开你的环境。

选择取决于"谁能触发代码执行"：只有自己或内部员工用，加固的 Docker 通常够了；面向公网用户，至少上 gVisor 或 microVM。

## Docker 沙箱的关键配置

逐项说明下面代码里用到的 `docker run` 参数：

| 参数 | 作用 |
| --- | --- |
| `--rm` | 退出后自动删除容器，不留状态 |
| `-i` | 保持 stdin 打开，代码从 stdin 传入，不需要挂载宿主文件 |
| `--network none` | 容器只有回环网卡，不能访问任何网络 |
| `--memory 256m --memory-swap 256m` | 内存上限 256 MB，且不允许使用 swap 绕过 |
| `--cpus 0.5` | 最多使用半个 CPU 核 |
| `--pids-limit 64` | 限制进程数，防止 fork 炸弹 |
| `--read-only` | 根文件系统只读 |
| `--tmpfs /tmp:rw,size=64m` | 唯一可写的目录，在内存中，有大小上限，容器销毁即消失 |
| `--cap-drop ALL` | 去掉所有 Linux capability |
| `--security-opt no-new-privileges` | 禁止通过 setuid 等方式提权 |
| `--user 65534:65534` | 以 nobody 用户运行，不是 root |
| `python -I -` | 隔离模式运行 Python（忽略环境变量和用户 site-packages），从 stdin 读代码 |

镜像要提前拉取，并固定版本（最好固定 digest），不要让 Agent 决定用什么镜像。需要第三方库时，提前构建好包含这些库的镜像，而不是在沙箱里联网 `pip install`。

## 动手：安全地启动沙箱

三个版本做的是同一件事，注意几个共同点：

- **参数数组启动进程**：Python 的 `subprocess.run(list)`（不使用 `shell=True`）、Go 的 `exec.CommandContext(ctx, "docker", args...)`、Java 的 `ProcessBuilder(List)`。代码内容永远不会被 shell 解释。
- **代码通过 stdin 传入**，不拼进命令行参数，也不写进宿主机文件再挂载。
- **超时后单独清理容器。** 超时杀掉的只是本地的 `docker` 客户端进程，容器本身可能还在跑，所以要给容器起一个随机名字，超时后 `docker kill`。
- **输出截断。** 只保留末尾若干字符，错误信息通常在最后。

::: code-group
```python [Python]
import subprocess
import uuid

IMAGE = "python:3.12-slim"   # 提前 docker pull，并固定版本或 digest
MAX_CODE_BYTES = 20_000
MAX_OUTPUT = 8_000


def docker_args(name: str) -> list[str]:
    return [
        "docker", "run", "--rm", "-i",
        "--name", name,
        "--network", "none",              # 无网络
        "--memory", "256m", "--memory-swap", "256m",
        "--cpus", "0.5",
        "--pids-limit", "64",             # 防 fork 炸弹
        "--read-only",                    # 根文件系统只读
        "--tmpfs", "/tmp:rw,size=64m",    # 唯一可写处，容器销毁即消失
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--user", "65534:65534",          # nobody，非 root
        IMAGE, "python", "-I", "-",       # 代码从 stdin 读入，不挂载任何宿主目录
    ]


def run_untrusted(code: str, timeout: int = 10) -> dict:
    if len(code.encode()) > MAX_CODE_BYTES:
        return {"ok": False, "error": "代码过长"}
    name = f"sandbox-{uuid.uuid4().hex[:12]}"
    try:
        proc = subprocess.run(
            docker_args(name),            # 参数数组，不使用 shell=True
            input=code, capture_output=True, text=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        # 超时只会杀掉 docker 客户端进程，容器要单独清理
        subprocess.run(["docker", "kill", name], capture_output=True, timeout=10)
        return {"ok": False, "error": f"执行超时（{timeout}s）"}
    return {
        "ok": proc.returncode == 0,
        "exit_code": proc.returncode,
        "stdout": proc.stdout[-MAX_OUTPUT:],
        "stderr": proc.stderr[-MAX_OUTPUT:],
    }


if __name__ == "__main__":
    print(run_untrusted("print(sum(range(10)))"))
    print(run_untrusted("import urllib.request\nurllib.request.urlopen('https://example.com')"))
    print(run_untrusted("while True: pass", timeout=3))
```

```go [Go]
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

const (
	image        = "python:3.12-slim" // 提前 docker pull，并固定版本或 digest
	maxCodeBytes = 20_000
	maxOutput    = 8_000
)

type Result struct {
	OK       bool
	ExitCode int
	Stdout   string
	Stderr   string
	Error    string
}

func dockerArgs(name string) []string {
	return []string{
		"run", "--rm", "-i",
		"--name", name,
		"--network", "none", // 无网络
		"--memory", "256m", "--memory-swap", "256m",
		"--cpus", "0.5",
		"--pids-limit", "64", // 防 fork 炸弹
		"--read-only",                 // 根文件系统只读
		"--tmpfs", "/tmp:rw,size=64m", // 唯一可写处
		"--cap-drop", "ALL",
		"--security-opt", "no-new-privileges",
		"--user", "65534:65534", // nobody，非 root
		image, "python", "-I", "-", // 代码从 stdin 读入
	}
}

func tail(s string, n int) string {
	if len(s) > n {
		return s[len(s)-n:]
	}
	return s
}

func runUntrusted(code string, timeout time.Duration) Result {
	if len(code) > maxCodeBytes {
		return Result{Error: "代码过长"}
	}
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	name := "sandbox-" + hex.EncodeToString(b)

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "docker", dockerArgs(name)...) // 参数数组，不经过 shell
	cmd.Stdin = strings.NewReader(code)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()

	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		// 超时只会杀掉 docker 客户端进程，容器要单独清理
		killCtx, killCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer killCancel()
		_ = exec.CommandContext(killCtx, "docker", "kill", name).Run()
		return Result{Error: fmt.Sprintf("执行超时（%s）", timeout)}
	}
	exitCode := 0
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		exitCode = exitErr.ExitCode()
	} else if err != nil {
		return Result{Error: err.Error()}
	}
	return Result{
		OK: exitCode == 0, ExitCode: exitCode,
		Stdout: tail(stdout.String(), maxOutput), Stderr: tail(stderr.String(), maxOutput),
	}
}

func main() {
	fmt.Printf("%+v\n", runUntrusted("print(sum(range(10)))", 10*time.Second))
	fmt.Printf("%+v\n", runUntrusted("import urllib.request\nurllib.request.urlopen('https://example.com')", 10*time.Second))
	fmt.Printf("%+v\n", runUntrusted("while True: pass", 3*time.Second))
}
```

```java [Java]
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

public class Sandbox {
    static final String IMAGE = "python:3.12-slim"; // 提前 docker pull，并固定版本或 digest
    static final int MAX_CODE_BYTES = 20_000;
    static final int MAX_OUTPUT = 8_000;

    record Result(boolean ok, int exitCode, String stdout, String stderr, String error) {
        static Result fail(String error) { return new Result(false, -1, "", "", error); }
    }

    static List<String> dockerArgs(String name) {
        return List.of(
                "docker", "run", "--rm", "-i",
                "--name", name,
                "--network", "none",                 // 无网络
                "--memory", "256m", "--memory-swap", "256m",
                "--cpus", "0.5",
                "--pids-limit", "64",                // 防 fork 炸弹
                "--read-only",                       // 根文件系统只读
                "--tmpfs", "/tmp:rw,size=64m",       // 唯一可写处
                "--cap-drop", "ALL",
                "--security-opt", "no-new-privileges",
                "--user", "65534:65534",             // nobody，非 root
                IMAGE, "python", "-I", "-");         // 代码从 stdin 读入
    }

    static String tail(Path p) throws IOException {
        String s = Files.readString(p, StandardCharsets.UTF_8);
        return s.length() > MAX_OUTPUT ? s.substring(s.length() - MAX_OUTPUT) : s;
    }

    static Result runUntrusted(String code, long timeoutSeconds) throws IOException, InterruptedException {
        byte[] bytes = code.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_CODE_BYTES) return Result.fail("代码过长");
        String name = "sandbox-" + UUID.randomUUID().toString().substring(0, 12);
        // 输出重定向到临时文件，避免管道写满导致子进程阻塞
        Path out = Files.createTempFile("sandbox", ".out");
        Path err = Files.createTempFile("sandbox", ".err");
        try {
            Process proc = new ProcessBuilder(dockerArgs(name))   // 参数列表，不经过 shell
                    .redirectOutput(out.toFile()).redirectError(err.toFile()).start();
            try (OutputStream stdin = proc.getOutputStream()) {
                stdin.write(bytes);
            }
            if (!proc.waitFor(timeoutSeconds, TimeUnit.SECONDS)) {
                proc.destroyForcibly();
                // 超时只会杀掉 docker 客户端进程，容器要单独清理
                new ProcessBuilder(List.of("docker", "kill", name)).start().waitFor(10, TimeUnit.SECONDS);
                return Result.fail("执行超时（" + timeoutSeconds + "s）");
            }
            int exit = proc.exitValue();
            return new Result(exit == 0, exit, tail(out), tail(err), null);
        } finally {
            Files.deleteIfExists(out);
            Files.deleteIfExists(err);
        }
    }

    public static void main(String[] args) throws Exception {
        System.out.println(runUntrusted("print(sum(range(10)))", 10));
        System.out.println(runUntrusted("import urllib.request\nurllib.request.urlopen('https://example.com')", 10));
        System.out.println(runUntrusted("while True: pass", 3));
    }
}
```
:::

演示中的三段代码分别验证：正常执行能拿到输出；访问网络会因为 `--network none` 失败（stderr 里是 DNS 解析或连接错误）；死循环会在超时后被终止并清理。

## 接入 Agent

把 `run_untrusted` 包装成一个工具即可接入 Agent：

```json
{
  "name": "run_python",
  "description": "在隔离沙箱中运行 Python 代码。无网络，无法访问任何文件，只有 /tmp 可写，10 秒超时。用 print 输出结果。",
  "parameters": {
    "type": "object",
    "properties": { "code": { "type": "string", "description": "完整的 Python 代码" } },
    "required": ["code"]
  }
}
```

工具描述里要 **把限制告诉模型**：没有网络、超时多久、只能用哪些库。否则模型会写出 `requests.get(...)`，然后在一次次失败中浪费步数。

需要让代码处理用户上传的文件时，用只读方式挂载一个 **专门为本次任务准备的** 临时目录（`-v /path/to/task-input:/data:ro`），不要挂载项目目录或家目录。需要多轮执行共享状态（像 Jupyter 那样）时，可以为一个会话保留一个长期运行的容器，但同样要设置会话总时长和资源上限，会话结束就销毁。

## 安全清单

```text
[ ] 代码绝不在宿主进程内 exec/eval
[ ] 用参数数组启动进程，代码经 stdin 或只读挂载传入
[ ] 无网络，或仅允许经过审计的出站白名单
[ ] 内存、CPU、进程数、磁盘（tmpfs size）都有上限
[ ] 墙钟超时，超时后清理容器
[ ] 根文件系统只读，非 root，去掉 capability
[ ] 容器内没有任何密钥、Token、宿主目录
[ ] 镜像固定版本，依赖预装，不在运行时联网安装
[ ] 输出截断后再回传给模型
[ ] 面向公网多租户时使用 gVisor / microVM 或托管沙箱
[ ] 记录每次执行的代码和结果，便于审计
```

## 常见坑

- **用 `shell=True` 或字符串拼命令。** `f"docker run ... python -c '{code}'"` 中，代码里的一个单引号就能逃出引号执行宿主命令。始终用参数数组，代码走 stdin。
- **以为容器默认安全。** 默认的 `docker run` 有网络、可写文件系统、root 用户、没有资源限制。每一项都需要显式加固。
- **超时只杀了客户端。** `subprocess` 超时后，`docker run` 进程被杀，但容器可能继续运行、继续占资源。要按名字 `docker kill`。
- **把 Docker socket 挂进 Agent 所在的容器。** 能访问 Docker socket 基本等于拥有宿主机 root 权限。运行沙箱的服务本身也要尽量隔离。
- **环境变量泄露。** 用 `-e` 把宿主环境变量传进沙箱，或在镜像里留了密钥。沙箱里不该有任何秘密。
- **给模型的工具描述不说明限制。** 模型不知道没网，会反复尝试联网。

## 小测

1. 为什么不能用 `subprocess.run(f"python -c '{code}'", shell=True)` 执行模型生成的代码，哪怕是在容器里？

::: details 查看答案
代码被拼进 shell 命令字符串，其中的引号、分号、`$()` 等字符会被宿主机的 shell 解释，模型（或注入攻击者）可以借此在宿主机上执行任意命令，容器隔离还没生效就已经被绕过。应使用参数数组启动进程，并把代码通过 stdin 传入。
:::

2. `--network none` 和"容器里不放任何密钥"分别防范什么？为什么两者都需要？

::: details 查看答案
`--network none` 阻止代码向外发送数据或下载恶意内容；不放密钥保证即使隔离出现缺口（例如网络配置失误、或者需要放开部分网络），代码也没有敏感信息可偷。纵深防御要求每一层都假设其他层可能失效。
:::

3. 面向公网用户开放"在线运行 Agent 生成的代码"功能，只用加固的 Docker 够吗？

::: details 查看答案
通常不够。Docker 容器共享宿主内核，内核漏洞可能导致容器逃逸，面对公网的大量不可信用户风险较高。应使用更强的隔离：gVisor 这样的用户态内核运行时、Firecracker 这样的 microVM，或者 E2B 这类托管沙箱服务，同时保留资源限制、超时和无网络等配置。
:::

## 延伸阅读

- [Docker run 参考：资源限制](https://docs.docker.com/engine/containers/resource_constraints/)
- [Docker 安全文档](https://docs.docker.com/engine/security/)
- [gVisor](https://gvisor.dev/)、[Firecracker](https://firecracker-microvm.github.io/)、[E2B](https://e2b.dev/)
- [Python subprocess 文档：安全注意事项](https://docs.python.org/3/library/subprocess.html)
- 本站：[权限控制与人在环路](/guide/15-production/permissions-hitl)、[护栏与内容安全](/guide/15-production/guardrails)、[部署、监控与运维](/guide/15-production/deployment)

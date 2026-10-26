---
title: 回归测试与持续评估
description: 把评估放进 CI：用测试框架跑评估集、设置阈值和基线对比、控制成本与波动，并在上线后持续采样评估。
---

# 回归测试与持续评估

::: info 学习目标
- 理解 Agent 的回归测试和传统单元测试有什么不同
- 会设计三类门槛：关键用例必过、总体通过率下限、相对基线的最大降幅
- 用 pytest / go test / JUnit 把评估接入 GitHub Actions
- 了解上线后的持续评估：采样、异步评审、告警
:::

## 回归是怎么发生的

Agent 的回归往往不是"代码写错了"，而是下面这些看起来无害的改动：

- 系统提示词加了一条规则，另一类任务的行为跟着变了；
- 工具描述改得更详细，模型开始在不该调用的时候调用它；
- 换了一个"更强"的模型，输出格式和以前不一样，下游解析失败；
- 厂商在同一个模型名下更新了版本；
- RAG 知识库重建索引，切分方式变了。

这些改动都不会让编译失败，也不会让单元测试失败。只有拿固定的评估集跑一遍，才能发现行为变了。**回归测试的目标是：每次改动合并前，自动回答"有没有变差"**。

## 和单元测试的区别

| | 单元测试 | Agent 回归评估 |
| --- | --- | --- |
| 结果 | 确定，全过或有失败 | 有波动，通过率是统计量 |
| 判定 | 每条必须通过 | 关键用例必过 + 整体达到阈值 |
| 速度 | 毫秒级 | 每条数秒，整套可能数分钟 |
| 成本 | 几乎为零 | 每次运行都要花 Token |
| 依赖 | 可完全 mock | 依赖真实模型 API（工具可 mock） |

这些差异决定了设计：不能要求 100% 通过，要用**阈值**；不能每次提交都跑全量，要**分层**；结果要和**基线**比较。

## 三类门槛

```text
                    ┌───────────────────────────────┐
  评估结果 ────────► │ 1. 关键用例（critical）全部通过   │──✗──► 阻止合并
                    ├───────────────────────────────┤
                    │ 2. 总通过率 ≥ 绝对下限（如 85%）  │──✗──► 阻止合并
                    ├───────────────────────────────┤
                    │ 3. 相比基线下降 ≤ 容忍值（如 3%） │──✗──► 阻止合并
                    └───────────────────────────────┘
                                   │ ✓
                                   ▼
                         合并；报告逐条差异供评审
```

1. **关键用例必过**。安全相关（不泄露系统提示词、不执行越权操作）、核心业务流程。这类用例失败一次就应阻止合并。打上 `critical` 标签。
2. **绝对下限**。整体通过率不能低于某个值，这个值根据产品可接受的质量设定。
3. **相对基线**。和主分支上一次的结果比较，下降超过容忍值就阻止合并。这能发现"虽然还在下限之上，但明显变差了"的改动。

容忍值怎么定？先在不做任何改动的情况下把评估集连续跑 5 次，看通过率的波动范围。如果 50 条用例的通过率在 88%~92% 之间波动，那么容忍值设 1% 就会频繁误报，设 4%~5% 更合理。用例越多，波动越小，阈值可以越严格。

## 分层运行

全量评估集可能有几百条，每个 PR 都跑既慢又贵。常见的分层方式：

| 触发时机 | 运行范围 | 目的 |
| --- | --- | --- |
| 每个 PR | 关键用例 + 冒烟子集（几十条） | 快速拦截明显问题 |
| 合并到主分支 / 每晚 | 全量评估集 | 更新基线，发现细微退化 |
| 换模型、大改提示词前 | 全量 × 多次运行 + LLM 评审 | 做发布决策 |

## 动手：用测试框架跑评估

下面把 [评估集与指标设计](/guide/14-evaluation/eval-design) 中的评估框架包装成测试。约定：

- `cases.jsonl`：用例文件，关键用例的 `tags` 含 `critical`；
- `baseline.json`：主分支上一次的结果，格式为 `{"用例 id": true/false}`；
- 被测函数 `run_agent` 和打分函数 `score` 复用上一篇的代码（Python 放在 `eval_harness.py`，Go 与上一篇的 `main.go` 放在同一 package，Java 把 `EvalHarness` 放在同一包下）；
- 没有设置 `OPENAI_API_KEY` 时跳过评估，避免在没有密钥的环境（如来自 fork 的 PR）里报错。

测试运行后会写出 `eval_results.json`，格式和 `baseline.json` 相同，更新基线时直接用它替换即可。阈值通过环境变量 `EVAL_MIN_PASS_RATE`、`EVAL_MAX_DROP` 调整；`EVAL_SUBSET=smoke` 时只跑带 `smoke` 或 `critical` 标签的用例。

::: code-group
```python [Python]
# test_evals.py  运行：pytest -v test_evals.py   依赖：pip install openai pytest
import json
import os
from pathlib import Path

import pytest

if not os.getenv("OPENAI_API_KEY"):
    pytest.skip("未设置 OPENAI_API_KEY，跳过评估", allow_module_level=True)

from eval_harness import run_agent, score  # noqa: E402  上一篇的评估框架

HERE = Path(__file__).parent
MIN_PASS_RATE = float(os.getenv("EVAL_MIN_PASS_RATE", "0.85"))
MAX_DROP = float(os.getenv("EVAL_MAX_DROP", "0.05"))
SUBSET = os.getenv("EVAL_SUBSET", "all")


def load_cases() -> list[dict]:
    lines = (HERE / "cases.jsonl").read_text(encoding="utf-8").splitlines()
    cases = [json.loads(line) for line in lines if line.strip()]
    if SUBSET == "smoke":
        cases = [c for c in cases if {"smoke", "critical"} & set(c.get("tags", []))]
    return cases


@pytest.fixture(scope="session")
def results() -> dict:
    out = {}
    for case in load_cases():
        try:
            reasons = score(case, run_agent(case["input"]))
        except Exception as e:
            reasons = [f"error: {type(e).__name__}: {e}"]
        out[case["id"]] = {"passed": not reasons, "reasons": reasons,
                           "critical": "critical" in case.get("tags", [])}
    if not out:
        pytest.skip("没有用例")
    summary = {cid: r["passed"] for cid, r in out.items()}
    (HERE / "eval_results.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    return out


def test_critical_cases(results):
    failed = {cid: r["reasons"] for cid, r in results.items()
              if r["critical"] and not r["passed"]}
    assert not failed, f"关键用例失败: {failed}"


def test_pass_rate(results):
    rate = sum(r["passed"] for r in results.values()) / len(results)
    failed = {cid: r["reasons"] for cid, r in results.items() if not r["passed"]}
    assert rate >= MIN_PASS_RATE, f"通过率 {rate:.1%} 低于 {MIN_PASS_RATE:.0%}，失败: {failed}"


def test_no_regression_vs_baseline(results):
    path = HERE / "baseline.json"
    if not path.exists():
        pytest.skip("没有 baseline.json")
    baseline = json.loads(path.read_text(encoding="utf-8"))
    common = [cid for cid in results if cid in baseline]
    if not common:
        pytest.skip("与基线没有共同用例")
    base_rate = sum(baseline[c] for c in common) / len(common)
    new_rate = sum(results[c]["passed"] for c in common) / len(common)
    newly_failed = [c for c in common if baseline[c] and not results[c]["passed"]]
    assert new_rate >= base_rate - MAX_DROP, (
        f"通过率 {base_rate:.1%} → {new_rate:.1%}，超过容忍值 {MAX_DROP:.0%}；"
        f"新增失败: {newly_failed}")
```
```go [Go]
// eval_test.go  与上一篇的 main.go 放在同一 package
// 运行：go test -run TestEvals -v -timeout 30m
package main

import (
	"bufio"
	"encoding/json"
	"os"
	"slices"
	"strconv"
	"strings"
	"testing"
)

func envFloat(key string, def float64) float64 {
	if v, err := strconv.ParseFloat(os.Getenv(key), 64); err == nil {
		return v
	}
	return def
}

func loadCases(t *testing.T, path string) []Case {
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	smoke := os.Getenv("EVAL_SUBSET") == "smoke"
	var cases []Case
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1024*1024), 1024*1024)
	for sc.Scan() {
		if strings.TrimSpace(sc.Text()) == "" {
			continue
		}
		var c Case
		if err := json.Unmarshal(sc.Bytes(), &c); err != nil {
			t.Fatalf("解析用例失败: %v", err)
		}
		if smoke && !slices.Contains(c.Tags, "smoke") && !slices.Contains(c.Tags, "critical") {
			continue
		}
		cases = append(cases, c)
	}
	return cases
}

func TestEvals(t *testing.T) {
	if os.Getenv("OPENAI_API_KEY") == "" {
		t.Skip("未设置 OPENAI_API_KEY，跳过评估")
	}
	minRate := envFloat("EVAL_MIN_PASS_RATE", 0.85)
	maxDrop := envFloat("EVAL_MAX_DROP", 0.05)

	cases := loadCases(t, "cases.jsonl")
	if len(cases) == 0 {
		t.Skip("没有用例")
	}
	results := map[string]bool{}
	var criticalFailed []string
	passed := 0
	for _, c := range cases {
		var reasons []string
		if out, err := runAgent(c.Input); err != nil {
			reasons = []string{"error: " + err.Error()}
		} else {
			reasons = score(c, out)
		}
		ok := len(reasons) == 0
		results[c.ID] = ok
		if ok {
			passed++
			continue
		}
		t.Logf("✗ %s: %s", c.ID, strings.Join(reasons, "; "))
		if slices.Contains(c.Tags, "critical") {
			criticalFailed = append(criticalFailed, c.ID)
		}
	}
	data, _ := json.MarshalIndent(results, "", "  ")
	if err := os.WriteFile("eval_results.json", data, 0o644); err != nil {
		t.Fatal(err)
	}

	if len(criticalFailed) > 0 {
		t.Errorf("关键用例失败: %v", criticalFailed)
	}
	rate := float64(passed) / float64(len(cases))
	if rate < minRate {
		t.Errorf("通过率 %.1f%% 低于 %.0f%%", rate*100, minRate*100)
	}

	raw, err := os.ReadFile("baseline.json")
	if err != nil {
		t.Log("没有 baseline.json，跳过基线对比")
		return
	}
	var baseline map[string]bool
	if err := json.Unmarshal(raw, &baseline); err != nil {
		t.Fatalf("解析基线失败: %v", err)
	}
	var common, basePass, newPass int
	var newlyFailed []string
	for id, now := range results {
		before, ok := baseline[id]
		if !ok {
			continue
		}
		common++
		if before {
			basePass++
		}
		if now {
			newPass++
		}
		if before && !now {
			newlyFailed = append(newlyFailed, id)
		}
	}
	if common == 0 {
		return
	}
	baseRate, newRate := float64(basePass)/float64(common), float64(newPass)/float64(common)
	if newRate < baseRate-maxDrop {
		t.Errorf("通过率 %.1f%% → %.1f%%，超过容忍值；新增失败: %v", baseRate*100, newRate*100, newlyFailed)
	}
}
```
```java [Java]
// src/test/java/EvalRegressionTest.java  依赖：JUnit 5 (org.junit.jupiter:junit-jupiter)、jackson-databind
// 运行：mvn test -Dtest=EvalRegressionTest
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;

import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

class EvalRegressionTest {

    static final ObjectMapper MAPPER = new ObjectMapper();
    static final Map<String, Boolean> RESULTS = new LinkedHashMap<>();
    static final List<String> CRITICAL_FAILED = new ArrayList<>();

    static double envDouble(String key, double def) {
        try {
            return Double.parseDouble(System.getenv(key));
        } catch (NullPointerException | NumberFormatException e) {
            return def;
        }
    }

    @BeforeAll
    static void runEvals() throws Exception {
        String key = System.getenv("OPENAI_API_KEY");
        assumeTrue(key != null && !key.isBlank(), "未设置 OPENAI_API_KEY，跳过评估");
        boolean smoke = "smoke".equals(System.getenv("EVAL_SUBSET"));

        for (String line : Files.readAllLines(Path.of("cases.jsonl"))) {
            if (line.isBlank()) continue;
            EvalHarness.Case c = MAPPER.readValue(line, EvalHarness.Case.class);
            List<String> tags = Objects.requireNonNullElse(c.tags(), List.of());
            if (smoke && !tags.contains("smoke") && !tags.contains("critical")) continue;
            List<String> reasons;
            try {
                reasons = EvalHarness.score(c, EvalHarness.runAgent(c.input()));
            } catch (Exception e) {
                reasons = List.of("error: " + e);
            }
            RESULTS.put(c.id(), reasons.isEmpty());
            if (!reasons.isEmpty()) {
                System.out.println("✗ " + c.id() + ": " + String.join("; ", reasons));
                if (tags.contains("critical")) CRITICAL_FAILED.add(c.id());
            }
        }
        assumeTrue(!RESULTS.isEmpty(), "没有用例");
        MAPPER.enable(SerializationFeature.INDENT_OUTPUT)
              .writeValue(Path.of("eval_results.json").toFile(), RESULTS);
    }

    static double rate(Collection<Boolean> values) {
        return values.stream().filter(b -> b).count() / (double) values.size();
    }

    @Test
    void criticalCasesPass() {
        assertTrue(CRITICAL_FAILED.isEmpty(), "关键用例失败: " + CRITICAL_FAILED);
    }

    @Test
    void passRateAboveThreshold() {
        double min = envDouble("EVAL_MIN_PASS_RATE", 0.85);
        double r = rate(RESULTS.values());
        assertTrue(r >= min, String.format("通过率 %.1f%% 低于 %.0f%%", r * 100, min * 100));
    }

    @Test
    void noRegressionVsBaseline() throws Exception {
        Path path = Path.of("baseline.json");
        assumeTrue(Files.exists(path), "没有 baseline.json");
        Map<String, Boolean> baseline = MAPPER.readValue(path.toFile(), new TypeReference<>() {});
        List<String> common = RESULTS.keySet().stream().filter(baseline::containsKey).toList();
        assumeTrue(!common.isEmpty(), "与基线没有共同用例");

        double baseRate = rate(common.stream().map(baseline::get).toList());
        double newRate = rate(common.stream().map(RESULTS::get).toList());
        List<String> newlyFailed = common.stream()
                .filter(id -> baseline.get(id) && !RESULTS.get(id)).toList();
        double maxDrop = envDouble("EVAL_MAX_DROP", 0.05);
        assertTrue(newRate >= baseRate - maxDrop, String.format(
                "通过率 %.1f%% → %.1f%%，超过容忍值；新增失败: %s", baseRate * 100, newRate * 100, newlyFailed));
    }
}
```
:::

Java 版本假设 `EvalHarness`（上一篇的代码）放在 `src/main/java` 的默认包下，测试类与它同包，因此可以直接调用包级可见的 `score` 和 `runAgent`；实际项目中应放进正式的包并调整可见性。

## 接入 GitHub Actions

以 Python 为例。Go 把运行步骤换成 `go test -run TestEvals -v -timeout 30m`，Java 换成 `mvn -B test -Dtest=EvalRegressionTest`。

```yaml
# .github/workflows/evals.yml
name: evals

on:
  pull_request:
    paths: ["agent/**", "prompts/**", "evals/**"]  # 只在相关文件变化时运行
  schedule:
    - cron: "0 18 * * *"   # 每天 UTC 18:00 跑全量
  workflow_dispatch:

concurrency:
  group: evals-${{ github.ref }}
  cancel-in-progress: true  # 同一分支新提交会取消旧的运行，节省 Token

jobs:
  evals:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - run: pip install openai pytest
      - name: Run evals
        working-directory: evals
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          OPENAI_BASE_URL: ${{ vars.OPENAI_BASE_URL }}
          LLM_MODEL: ${{ vars.LLM_MODEL }}
          EVAL_SUBSET: ${{ github.event_name == 'pull_request' && 'smoke' || 'all' }}
          EVAL_MIN_PASS_RATE: "0.85"
          EVAL_MAX_DROP: "0.05"
        run: pytest -v test_evals.py
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: eval-results
          path: evals/eval_results.json
```

几点说明：

- **密钥放在仓库的 Secrets 中**，不要写进代码或工作流文件。GitHub 默认不会把 Secrets 传给来自 fork 的 PR，这时测试会因为缺少密钥而跳过，这是预期行为，需要维护者在受信任的环境下再跑一次。
- **建议为 CI 单独创建 API Key**，并在厂商控制台设置用量上限，防止配置错误导致费用失控。
- **基线更新走评审**。每晚全量运行的 `eval_results.json` 作为构件保存；需要更新基线时，下载后替换 `baseline.json`，通过 PR 提交并说明原因。不要让 CI 自动覆盖基线，否则一次退化会悄悄成为新标准。
- **把结果贴到 PR**。可以用脚本把新增失败的用例列表写进 PR 评论或 Job Summary，评审者不用翻日志。

## 上线后的持续评估

离线评估集再好，也只是真实流量的一个样本。上线后还需要持续评估：

```text
线上请求 ──► 轨迹存储 ──► 按比例采样（如 1%）──► 异步 LLM 评审 ──► 指标看板
                │                                      │
                └──► 用户反馈（点赞/点踩、投诉）           └──► 低分样本 ──► 人工复核
                                                                       │
                                                         确认是问题 ──► 加入离线评估集
```

- **采样 + 异步评审**。不在请求链路上同步评审（增加延迟），而是从 [轨迹](/guide/14-evaluation/observability) 中采样，后台用 [LLM-as-Judge](/guide/14-evaluation/llm-judge) 打分。
- **用户信号**。点赞点踩、重新生成、对话中途放弃、转人工，都是质量信号。
- **告警**。评审通过率、工具失败率、平均步数出现明显变化时告警。模型厂商静默更新时，这往往是最早的信号。
- **闭环**。人工确认的问题样本要回流进离线评估集，这是评估集保持"贴近真实"的主要途径。

## 常见坑

- **阈值设得比波动还小**。CI 时红时绿，大家很快就会习惯性忽略或重跑。先测量波动，再定阈值。
- **CI 自动更新基线**。退化被悄悄接受。基线更新应当是一个需要人确认的动作。
- **评估集被"刷分"**。开发者针对失败用例改提示词，评估集通过率越来越高，线上效果却没变好。保留一部分不公开的保留集，定期用新的线上样本补充。
- **只在 PR 上跑子集，从不跑全量**。子集覆盖不到的退化会累积。至少每天或每周跑一次全量。
- **评估依赖的模型版本不固定**。被测模型或评审模型用的是会自动更新的别名，分数变化分不清是代码导致还是模型导致。评估时尽量使用带版本号的模型名，并在结果中记录。

## 小测

1. 不做任何改动，连续跑 5 次评估集，通过率在 86%~91% 之间。把"相对基线最大降幅"设为 1% 会怎样？

::: details 查看答案
会频繁误报：仅仅是随机波动就可能让通过率下降超过 1%，导致 CI 经常失败。团队会开始忽略失败或反复重跑，评估失去作用。应将容忍值设在波动范围之上（例如 5% 左右），或者增加用例数量、对关键用例多次运行以减小波动。
:::

2. 为什么不应该让 CI 在每次运行后自动用最新结果覆盖 `baseline.json`？

::: details 查看答案
如果某次改动导致了退化，自动覆盖会让退化后的结果成为新基线，之后的对比就再也发现不了这次退化。基线更新应由人确认，并说明原因（如有意调整了行为、修改了用例）。
:::

3. 来自 fork 的 PR 中评估被跳过了，这是 bug 吗？应该怎么处理？

::: details 查看答案
不是 bug。GitHub 出于安全考虑默认不向 fork PR 的工作流传递 Secrets，否则任何人都可以通过提交 PR 窃取密钥。应由维护者审查代码后，在受信任的分支或通过手动触发运行评估。
:::

## 延伸阅读

- [GitHub Actions 文档](https://docs.github.com/en/actions)
- [pytest 文档](https://docs.pytest.org/)
- [promptfoo（GitHub）](https://github.com/promptfoo/promptfoo)：也提供 CI 集成方式
- 本站：[评估集与指标设计](/guide/14-evaluation/eval-design)、[提示词版本管理与测试](/guide/04-prompt/prompt-management)、[部署、监控与运维](/guide/15-production/deployment)

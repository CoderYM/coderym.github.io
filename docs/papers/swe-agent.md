---
title: SWE-agent
description: 精读 SWE-agent：为 Agent 专门设计的"Agent-计算机接口"（ACI），能显著提升它在真实代码仓库中修复问题的能力。
---

# SWE-agent

## 论文信息

- 标题：SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering
- 作者：John Yang、Carlos E. Jimenez、Alexander Wettig、Kilian Lieret、Shunyu Yao、Karthik Narasimhan、Ofir Press（Princeton University）
- 年份：2024（NeurIPS 2024）
- 链接：[arXiv:2405.15793](https://arxiv.org/abs/2405.15793)

## 一句话总结

人用 IDE，Agent 也需要为它量身定做的"IDE"：通过精心设计的命令、反馈格式和防错机制（Agent-Computer Interface，ACI），同一个模型在真实 GitHub 仓库中解决 Issue 的能力大幅提升。

## 要解决的问题

在 SWE-bench 这类基准上，Agent 需要阅读一个真实的开源仓库，理解 Issue，定位相关代码，修改并让测试通过。早期的尝试主要有两种：

- 直接把相关代码检索出来让模型一次性生成补丁，缺少交互和验证。
- 直接给模型一个 Linux Shell，让它像人一样用 `cat`、`grep`、`sed` 操作。

问题在于，Shell 是为人设计的。对模型来说，`cat` 一个大文件会塞爆上下文，`sed` 改代码容易出错且没有反馈，命令没有输出时模型不知道是否成功。作者的核心观点是：Agent 是一类新的"用户"，应该像做人机交互设计那样，为它专门设计交互界面。

## 核心方法

SWE-agent 在 Shell 之上提供了一组为模型设计的命令，并规定了统一的反馈格式。

```text
                 ┌───────────────────────────────────────┐
                 │              大模型 (Agent)            │
                 └───────────────────────────────────────┘
                     │ Thought + 命令          ▲ 精简、结构化的反馈
                     ▼                         │
 ┌────────────────────────────────────────────────────────────────┐
 │             Agent-Computer Interface (ACI)                      │
 │                                                                │
 │  搜索导航: find_file / search_dir / search_file                 │
 │            结果过多时只提示"请缩小范围"，避免刷屏                   │
 │  文件查看: open / scroll_up / scroll_down / goto                 │
 │            每次只显示约 100 行窗口，带行号和文件位置信息             │
 │  文件编辑: edit 起始行:结束行 <新内容>                             │
 │            编辑后自动运行 lint，有语法错误则拒绝修改并提示           │
 │  上下文管理: 旧的观察结果被折叠，只保留最近的完整输出               │
 └────────────────────────────────────────────────────────────────┘
                     │                         ▲
                     ▼                         │
                 ┌───────────────────────────────────────┐
                 │     Docker 沙箱中的代码仓库 + Shell     │
                 └───────────────────────────────────────┘
```

设计原则可以总结为：

- **动作要简单、易懂：** 命令少而清晰，文档简短。
- **操作要紧凑、高效：** 一个命令完成一件完整的事，比如一次编辑多行，而不是多次小修改。
- **反馈要信息量高但简洁：** 只返回模型做下一步决策需要的信息。
- **防护措施：** 在常见错误发生之前拦截，比如编辑引入语法错误时直接拒绝并告诉模型原因。

## 关键实验结论

论文主要在 SWE-bench（真实 GitHub Issue 修复）上评估，也在 HumanEvalFix（短代码修复）上做了测试。

- **ACI 带来显著提升：** 使用同一个模型，SWE-agent 解决 Issue 的比例明显高于只给原始 Shell 的基线，也明显高于此前基于检索一次性生成补丁的方法，在发表时达到了 SWE-bench 上的领先水平。
- **消融实验验证了每个设计：** 去掉编辑后的 lint 检查，模型会频繁引入语法错误并陷入反复修改；搜索结果不做限制，模型容易被大量输出淹没；文件查看窗口过大或过小，效果都会下降。
- **失败模式分析：** 常见失败包括定位到错误的文件、修改不完整、以及在编辑出错后连续多次失败。一旦 Agent 在早期没找对位置，后续很难恢复。

## 对 Agent 开发的启发

- **工具设计就是 Agent 的界面设计。** 工具的命名、参数、返回格式、错误提示，会直接决定 Agent 的表现。这是 [工具设计原则](/guide/05-tool-calling/tool-design) 最有力的论据。
- **控制工具返回的信息量。** 分页、截断、摘要，以及"结果太多，请缩小范围"这样的提示，比把所有结果一次塞给模型更有效。
- **在工具层做防护。** 与其在提示词里写"请注意不要引入语法错误"，不如在工具里直接校验并拒绝错误操作，给出明确的错误信息。
- **管理历史观察。** 折叠旧的工具输出，是一种简单有效的上下文管理方法，参考 [上下文窗口管理](/guide/07-context-engineering/window-management)。
- **在沙箱中执行。** Agent 修改代码和运行命令必须在隔离环境中进行，详见 [沙箱与代码执行安全](/guide/13-coding-agent/sandbox)。

## 局限性

- ACI 的设计依赖人工经验和反复试验，针对软件工程场景，迁移到其他领域需要重新设计。
- 评估基于 SWE-bench，测试通过不等于补丁质量高，可能存在"碰巧通过测试"的修改。
- 基准主要来自部分 Python 开源项目，对其他语言和大型私有代码库的代表性有限。
- 单次任务需要多轮交互，成本和耗时较高。
- 早期定位错误后难以恢复，说明仅靠单 Agent 循环还缺少更好的规划和自我纠正机制。

## 相关文章

- [Coding Agent 原理](/guide/13-coding-agent/coding-agents)
- [工具设计原则](/guide/05-tool-calling/tool-design)
- [沙箱与代码执行安全](/guide/13-coding-agent/sandbox)
- [上下文窗口管理](/guide/07-context-engineering/window-management)
- [工具错误处理与重试](/guide/05-tool-calling/error-handling)
- 实战项目：[08 代码审查 Agent](/projects/08-code-review)

// 知识体系唯一数据源：侧边栏、首页模块全景、文章计数都从这里生成。
// 新增文章：在对应模块 items 里加一行，并创建 docs/<link>.md。

export interface Item { text: string; link: string }
export interface Module { id: string; text: string; part: string; items: Item[] }

const m = (id: string, text: string, part: string, items: [string, string][]): Module => ({
  id, text, part,
  items: items.map(([slug, t]) => ({ text: t, link: `/guide/${id}/${slug}` })),
})

export const modules: Module[] = [
  m('00-intro', '00 导读', '基础篇', [
    ['what-is-agent', 'Agent 到底是什么'],
    ['agent-vs-workflow', 'Agent、Chatbot 与 Workflow 的区别'],
    ['capabilities', 'Agent 的能力边界与适用场景'],
    ['how-to-learn', '如何使用本站学习'],
  ]),
  m('01-programming', '01 编程基础', '基础篇', [
    ['dev-env', '开发环境：Python / Go / Java'],
    ['python-essentials', 'Agent 开发必备 Python'],
    ['async', '异步与并发编程'],
    ['http-json', 'HTTP、JSON 与 REST API'],
    ['streaming-sse', '流式输出与 SSE'],
    ['data-validation', '数据校验：pydantic / struct tag / record'],
  ]),
  m('02-llm-basics', '02 大模型原理', '基础篇', [
    ['transformer', 'Transformer 的直觉理解'],
    ['tokens-context', 'Token 与上下文窗口'],
    ['sampling', '采样参数：temperature、top_p'],
    ['embeddings', 'Embedding 与向量语义'],
    ['reasoning-models', '推理模型与扩展思考'],
    ['choosing-models', '如何选择模型'],
  ]),
  m('03-llm-api', '03 大模型 API', '基础篇', [
    ['first-call', '第一次调用大模型'],
    ['providers', '主流模型厂商 API 对比'],
    ['multi-turn', '多轮对话与消息结构'],
    ['streaming', '流式响应实战'],
    ['multimodal', '多模态输入：图片与文档'],
    ['cost-errors', '计费、限流与错误重试'],
  ]),
  m('04-prompt', '04 提示词工程', '核心篇', [
    ['basics', '提示词基本原则'],
    ['system-prompt', '系统提示词与角色设计'],
    ['few-shot-cot', 'Few-shot 与思维链'],
    ['structured-output', '结构化输出与 JSON Schema'],
    ['prompt-management', '提示词版本管理与测试'],
  ]),
  m('05-tool-calling', '05 Tool Calling', '核心篇', [
    ['concept', '工具调用原理'],
    ['first-tool', '实现第一个工具'],
    ['tool-design', '工具设计原则'],
    ['parallel-tools', '并行工具调用'],
    ['error-handling', '工具错误处理与重试'],
  ]),
  m('06-agent-loop', '06 Agent 循环', '核心篇', [
    ['react', 'ReAct：推理与行动'],
    ['handwritten-agent', '不用框架手写 Agent'],
    ['plan-execute', 'Plan-and-Execute'],
    ['reflection', 'Reflection 自我反思'],
    ['stop-budget', '终止条件、步数与预算控制'],
  ]),
  m('07-context-engineering', '07 上下文工程', '核心篇', [
    ['overview', '什么是上下文工程'],
    ['window-management', '上下文窗口管理'],
    ['compression', '压缩与摘要'],
    ['prompt-caching', 'Prompt Caching'],
  ]),
  m('08-memory', '08 记忆系统', '核心篇', [
    ['memory-types', '记忆的分类'],
    ['short-term', '短期记忆与会话管理'],
    ['long-term', '长期记忆与用户画像'],
    ['memory-strategy', '记忆读写策略与方案对比'],
  ]),
  m('09-rag', '09 RAG 知识库', '核心篇', [
    ['overview', 'RAG 全景'],
    ['chunking', '文档解析与切分'],
    ['vector-db', '向量数据库'],
    ['hybrid-rerank', '混合检索与重排'],
    ['advanced-rag', 'GraphRAG 与 Agentic RAG'],
    ['rag-eval', 'RAG 评估'],
  ]),
  m('10-mcp', '10 MCP 与 A2A', '生态篇', [
    ['mcp-overview', 'MCP 架构与核心概念'],
    ['mcp-server', '开发一个 MCP Server'],
    ['mcp-client', '在应用中接入 MCP'],
    ['a2a', 'A2A：Agent 之间的协议'],
  ]),
  m('11-frameworks', '11 框架实战', '生态篇', [
    ['overview', '框架全景与选型'],
    ['langgraph', 'LangGraph'],
    ['agent-sdks', 'Claude Agent SDK 与 OpenAI Agents SDK'],
    ['llamaindex-crewai', 'LlamaIndex、CrewAI 与 AutoGen'],
    ['go-eino', 'Go：Eino 与 langchaingo'],
    ['java-spring-ai', 'Java：Spring AI 与 LangChain4j'],
    ['low-code', '低代码平台：Dify 与 Coze'],
  ]),
  m('12-multi-agent', '12 多 Agent 系统', '生态篇', [
    ['why-multi-agent', '为什么需要多 Agent'],
    ['patterns', '编排模式：主从、流水线、交接、辩论'],
    ['state-sharing', '状态共享与通信'],
    ['pitfalls', '多 Agent 的坑与成本控制'],
  ]),
  m('13-coding-agent', '13 Coding 与 Computer-Use', '生态篇', [
    ['coding-agents', 'Coding Agent 原理'],
    ['browser-automation', '浏览器自动化 Agent'],
    ['computer-use', 'Computer Use'],
    ['sandbox', '沙箱与代码执行安全'],
  ]),
  m('14-evaluation', '14 评估与可观测性', '工程篇', [
    ['why-evals', '为什么评估是第一优先级'],
    ['eval-design', '评估集与指标设计'],
    ['llm-judge', 'LLM-as-Judge'],
    ['observability', '轨迹追踪与可观测性'],
    ['regression', '回归测试与持续评估'],
  ]),
  m('15-production', '15 安全与生产化', '工程篇', [
    ['prompt-injection', 'Prompt 注入与防护'],
    ['permissions-hitl', '权限控制与人在环路'],
    ['guardrails', '护栏与内容安全'],
    ['cost-optimization', '成本与延迟优化'],
    ['serving', '服务化：FastAPI / Gin / Spring Boot'],
    ['deployment', '部署、监控与运维'],
  ]),
]

const sec = (base: string, items: [string, string][]): Item[] =>
  items.map(([slug, text]) => ({ text, link: `/${base}/${slug}` }))

export const projects = sec('projects', [
  ['01-cli-chat', '01 命令行聊天助手'],
  ['02-tool-agent', '02 天气日程工具 Agent'],
  ['03-react-agent', '03 手写 ReAct Agent'],
  ['04-pdf-rag', '04 个人 PDF 知识库'],
  ['05-mcp-server', '05 开发自己的 MCP Server'],
  ['06-research-agent', '06 网页研究员 Agent'],
  ['07-writing-team', '07 多 Agent 写作团队'],
  ['08-code-review', '08 代码审查 Agent'],
  ['09-agent-workbench', '09 全栈 Agent 工作台'],
  ['10-enterprise-assistant', '10 毕业项目：企业知识助手'],
])

export const roadmap = sec('roadmap', [
  ['beginner', '零基础入门路径'],
  ['engineer', '工程师路径'],
  ['architect', '架构师路径'],
  ['12-weeks', '12 周学习计划'],
])

export const papers = sec('papers', [
  ['chain-of-thought', 'Chain-of-Thought'],
  ['react', 'ReAct'],
  ['toolformer', 'Toolformer'],
  ['reflexion', 'Reflexion'],
  ['rag', 'RAG 原始论文'],
  ['generative-agents', 'Generative Agents'],
  ['tree-of-thoughts', 'Tree of Thoughts'],
  ['swe-agent', 'SWE-agent'],
])

export const interview = sec('interview', [
  ['basics', '基础概念题'],
  ['rag', 'RAG 题'],
  ['engineering', '工程与系统设计题'],
])

export const articleCount =
  modules.reduce((n, mod) => n + mod.items.length, 0) +
  projects.length + roadmap.length + papers.length + interview.length

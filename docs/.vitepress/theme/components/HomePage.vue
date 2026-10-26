<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { withBase } from 'vitepress'
import ParticleBg from './ParticleBg.vue'
import AgentLoopDemo from './AgentLoopDemo.vue'
import { modules, projects, articleCount } from '../../curriculum'

const parts = [
  ['PART 1 · 基础篇', '打牢地基'],
  ['PART 2 · 核心篇', 'Agent 的核心能力'],
  ['PART 3 · 生态篇', '框架与协议'],
  ['PART 4 · 工程篇', '走向生产'],
].map(([kick, title]) => ({
  kick, title,
  mods: modules.filter((m) => kick.endsWith(m.part)),
}))

const paths = [
  ['🌱', '零基础 · 约 16 周', '入门路径', 'Python → 调用大模型 → 第一个工具调用 Agent → 个人知识库助手', '/roadmap/beginner'],
  ['⚡', '有开发经验 · 约 8 周', '工程师路径', 'Agent 循环 → 上下文工程 → RAG → MCP → LangGraph 多 Agent', '/roadmap/engineer'],
  ['🏗', '进阶 · 约 6 周', '架构师路径', '评估体系 → 可观测性 → 安全护栏 → 成本优化 → 规模化部署', '/roadmap/architect'],
]

const stages = [
  ['阶段 1 · 基础准备', '第 1-2 周', ['Python 必备语法、async、pydantic（Go / Java 对照）', 'HTTP、JSON、SSE 流式', '第一次调用大模型 API']],
  ['阶段 2 · 大模型与提示词', '第 3-4 周', ['Token、上下文窗口、采样参数、Embedding', 'Prompt 工程与结构化输出']],
  ['阶段 3 · Tool Calling 与 Agent 循环', '第 5-6 周', ['函数调用协议与工具设计', '不用框架手写 ReAct Agent']],
  ['阶段 4 · 上下文 / 记忆 / RAG / MCP', '第 7-9 周', ['上下文工程与长期记忆', 'RAG 全流程：切分、检索、重排、评估', '开发自己的 MCP Server']],
  ['阶段 5 · 多 Agent 与生产化', '第 10-12 周', ['LangGraph / Agents SDK 多 Agent 编排', 'Evals、可观测性、安全护栏、部署上线']],
] as const
const open = ref<number[]>([0])
const toggle = (i: number) => {
  open.value = open.value.includes(i) ? open.value.filter((n) => n !== i) : [...open.value, i]
}

const LANG_KEY = 'maxai-code-lang'
const langs = ['Python', 'Go', 'Java'] as const
const lang = ref<(typeof langs)[number]>('Python')
const setLang = (l: (typeof langs)[number]) => { lang.value = l; localStorage.setItem(LANG_KEY, l) }
const code: Record<string, string> = {
  Python: `def run_agent(goal: str, max_steps: int = 10) -> str:
    messages = [{"role": "user", "content": goal}]
    for _ in range(max_steps):
        resp = llm.chat(messages, tools=TOOLS)          # 思考
        if not resp.tool_calls:
            return resp.content                         # 回答
        for call in resp.tool_calls:
            result = TOOLS[call.name](**call.args)      # 行动
            messages.append(tool_result(call, result))  # 观察
    return "超过最大步数"`,
  Go: `func RunAgent(ctx context.Context, goal string, maxSteps int) (string, error) {
    msgs := []Message{{Role: "user", Content: goal}}
    for i := 0; i < maxSteps; i++ {
        resp, err := llm.Chat(ctx, msgs, tools)            // 思考
        if err != nil { return "", err }
        if len(resp.ToolCalls) == 0 { return resp.Content, nil } // 回答
        for _, call := range resp.ToolCalls {
            result := tools[call.Name](call.Args)          // 行动
            msgs = append(msgs, ToolResult(call, result))  // 观察
        }
    }
    return "", ErrMaxSteps
}`,
  Java: `public String runAgent(String goal, int maxSteps) {
    List<Message> msgs = new ArrayList<>(List.of(Message.user(goal)));
    for (int i = 0; i < maxSteps; i++) {
        ChatResponse resp = llm.chat(msgs, tools);              // 思考
        if (resp.toolCalls().isEmpty()) return resp.content();  // 回答
        for (ToolCall call : resp.toolCalls()) {
            String result = tools.get(call.name()).apply(call.args()); // 行动
            msgs.add(Message.toolResult(call, result));         // 观察
        }
    }
    throw new MaxStepsExceededException();
}`,
}

// 数字滚动、滚动出现动画
const counts = ref({ modules: 0, articles: 0, projects: 0 })
const target = { modules: modules.length, articles: articleCount, projects: projects.length }
let io: IntersectionObserver | undefined
let timer = 0
onMounted(() => {
  const saved = localStorage.getItem(LANG_KEY)
  if (saved && (langs as readonly string[]).includes(saved)) lang.value = saved as typeof lang.value
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches
  if (still) counts.value = { ...target }
  else {
    let k = 0
    timer = window.setInterval(() => {
      k++
      const f = Math.min(1, k / 40)
      counts.value = {
        modules: Math.round(target.modules * f),
        articles: Math.round(target.articles * f),
        projects: Math.round(target.projects * f),
      }
      if (f === 1) clearInterval(timer)
    }, 30)
  }
  io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && e.target.classList.add('on')), { threshold: 0.12 })
  document.querySelectorAll('.mx .reveal').forEach((el) => io!.observe(el))
})
onBeforeUnmount(() => { io?.disconnect(); clearInterval(timer) })

// 卡片 3D 倾斜 / 聚光灯
const tilt = (e: MouseEvent) => {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const el = e.currentTarget as HTMLElement
  const r = el.getBoundingClientRect()
  const dx = (e.clientX - r.left) / r.width - 0.5, dy = (e.clientY - r.top) / r.height - 0.5
  el.style.transform = `perspective(800px) rotateY(${dx * 10}deg) rotateX(${-dy * 10}deg)`
}
const untilt = (e: MouseEvent) => { (e.currentTarget as HTMLElement).style.transform = '' }
const spot = (e: MouseEvent) => {
  const el = e.currentTarget as HTMLElement
  const r = el.getBoundingClientRect()
  el.style.setProperty('--x', `${e.clientX - r.left}px`)
  el.style.setProperty('--y', `${e.clientY - r.top}px`)
}
</script>
<template>
  <div class="mx">
    <ParticleBg />
    <div class="wrap">
      <!-- 1. Hero -->
      <div class="hero">
        <div>
          <a class="pill" :href="withBase('/guide/10-mcp/mcp-overview')"><i>● NEW</i> MCP 与 A2A 协议专题已上线</a>
          <h1>让大模型<br><span class="grad">学会思考与行动</span></h1>
          <p class="lead">一套系统化的 AI Agent 开发知识体系。从 LLM 原理到 Tool Calling、RAG、MCP、多 Agent 协作与生产部署，示例代码提供 Python / Go / Java 三个版本。</p>
          <div class="btns">
            <a class="btn p" :href="withBase('/guide/00-intro/what-is-agent')">开始学习 →</a>
            <a class="btn" :href="withBase('/roadmap/12-weeks')">查看 12 周计划</a>
          </div>
          <div class="stats">
            <div><b class="grad">{{ counts.modules }}</b><small>知识模块</small></div>
            <div><b class="grad">{{ counts.articles }}+</b><small>篇教程</small></div>
            <div><b class="grad">{{ counts.projects }}</b><small>实战项目</small></div>
          </div>
        </div>
        <div class="orbit" aria-hidden="true">
          <div class="ring"><div class="node" style="left:50%;top:0">🛠 Tools</div><div class="node" style="left:100%;top:50%">🧠 Memory</div><div class="node" style="left:50%;top:100%">📚 RAG</div><div class="node" style="left:0;top:50%">🔌 MCP</div></div>
          <div class="ring r2"><div class="node" style="left:85%;top:15%">Plan</div><div class="node" style="left:15%;top:85%">Reflect</div></div>
          <div class="core">LLM</div>
        </div>
      </div>

      <!-- 2. Agent 循环演示 -->
      <section class="reveal">
        <div class="center"><div class="kick">// WHAT IS AN AGENT</div><h2>看一个 Agent <span class="grad">如何工作</span></h2><p class="sub">理解了这个循环，就理解了 90% 的 Agent 框架</p></div>
        <AgentLoopDemo />
      </section>

      <!-- 3. 三条路径 -->
      <section class="reveal">
        <div class="center"><div class="kick">// CHOOSE YOUR PATH</div><h2>三条路径，<span class="grad">总有一条适合你</span></h2><p class="sub">按背景选择入口，所有路径最终汇合到生产级 Agent</p></div>
        <div class="grid3">
          <a v-for="p in paths" :key="p[2]" class="glass card" :href="withBase(p[4])" @mousemove="tilt" @mouseleave="untilt">
            <div class="ic">{{ p[0] }}</div><div class="lv">{{ p[1] }}</div><h3>{{ p[2] }}</h3><p>{{ p[3] }}</p>
          </a>
        </div>
      </section>

      <!-- 4. 知识体系全景 -->
      <section class="reveal">
        <div class="center"><div class="kick">// KNOWLEDGE MAP</div><h2>{{ modules.length }} 个模块，<span class="grad">一张全景图</span></h2><p class="sub">基础 → 核心 → 生态 → 工程，每篇都有可运行代码</p></div>
        <div class="bento">
          <div v-for="part in parts" :key="part.kick" class="glass box" @mousemove="spot">
            <small>{{ part.kick }}</small><h3>{{ part.title }}</h3>
            <ul><li v-for="mod in part.mods" :key="mod.id"><a :href="withBase(mod.items[0].link)">{{ mod.text }}</a></li></ul>
          </div>
        </div>
        <p class="center more"><a :href="withBase('/guide/')">查看完整目录 →</a></p>
      </section>

      <!-- 5. 多语言代码 -->
      <section class="reveal">
        <div class="center"><div class="kick">// POLYGLOT</div><h2>Python 为主，<span class="grad">Go / Java 同步</span></h2><p class="sub">同一个 Agent 循环，三种语言实现，选择会在全站文章中同步</p></div>
        <div class="glass code">
          <div class="tabs" role="tablist" aria-label="代码语言">
            <button v-for="l in langs" :key="l" role="tab" :aria-selected="lang === l" :class="{ on: lang === l }" @click="setLang(l)">{{ l }}</button>
          </div>
          <pre role="tabpanel">{{ code[lang] }}</pre>
        </div>
      </section>

      <!-- 6. 12 周路线 -->
      <section class="reveal">
        <div class="kick">// 12-WEEK ROADMAP</div><h2>12 周，<span class="grad">从入门到上线</span></h2><p class="sub">点击展开每个阶段的核心内容</p>
        <div class="tl">
          <div v-for="(s, i) in stages" :key="s[0]" class="st" :class="{ open: open.includes(i) }">
            <button :aria-expanded="open.includes(i)" @click="toggle(i)"><h4>{{ s[0] }}<em>{{ s[1] }}</em></h4></button>
            <ul><li v-for="t in s[2]" :key="t">{{ t }}</li></ul>
          </div>
        </div>
        <p class="more"><a :href="withBase('/roadmap/12-weeks')">查看每周详细计划与打卡 →</a></p>
      </section>

      <!-- 7. CTA -->
      <section class="reveal">
        <div class="glass cta">
          <div class="kick">// READY?</div><h2>今天就写出你的<span class="grad">第一个 Agent</span></h2>
          <p class="sub">30 分钟，从环境搭建到能调用工具的 Agent</p>
          <a class="btn p" :href="withBase('/projects/01-cli-chat')">开始第一个项目 →</a>
        </div>
      </section>
    </div>
  </div>
</template>
<style scoped>
.mx { position: relative; color: #eee9ff; background: var(--mx-bg); overflow-x: hidden; line-height: 1.7; }
.wrap { position: relative; z-index: 1; max-width: 1200px; margin: auto; padding: 0 24px 60px; }
a { color: inherit; text-decoration: none; }
.grad { background: linear-gradient(90deg, var(--mx-cyan), var(--mx-purple), var(--mx-pink), var(--mx-cyan)); background-size: 300%; -webkit-background-clip: text; background-clip: text; color: transparent; animation: fl 6s linear infinite; }
@keyframes fl { to { background-position: 300%; } }
.hero { min-height: calc(100vh - var(--vp-nav-height)); display: grid; grid-template-columns: 1.1fr .9fr; align-items: center; gap: 40px; }
.pill { display: inline-flex; gap: 8px; padding: 6px 14px; border: 1px solid #ffffff22; border-radius: 99px; background: #ffffff0a; font-size: 13px; color: var(--mx-muted); transition: .2s; }
.pill:hover { border-color: #8b5cf688; color: #fff; }
.pill i { font-style: normal; color: var(--mx-green); }
h1 { font-size: clamp(40px, 5.6vw, 76px); line-height: 1.1; margin: 22px 0; letter-spacing: -.02em; font-weight: 800; }
.lead { color: var(--mx-muted); font-size: 18px; max-width: 560px; }
.btns { display: flex; gap: 14px; margin: 36px 0 40px; flex-wrap: wrap; }
.btn { display: inline-block; padding: 14px 26px; border-radius: 12px; color: #fff; border: 1px solid #ffffff22; background: #ffffff0d; transition: .25s; font-weight: 600; }
.btn.p { background: linear-gradient(90deg, var(--mx-purple), var(--mx-cyan)); border: 0; box-shadow: 0 10px 40px #8b5cf666; }
.btn:hover { transform: translateY(-2px); }
.btn:focus-visible, .card:focus-visible, .tabs button:focus-visible, .st button:focus-visible { outline: 2px solid var(--mx-cyan); outline-offset: 3px; }
.stats { display: flex; gap: 44px; }
.stats b { display: block; font-size: 30px; font-weight: 800; }
.stats small { color: var(--mx-muted); }
.orbit { position: relative; width: min(440px, 80vw); aspect-ratio: 1; margin: auto; }
.ring { position: absolute; inset: 0; border: 1px dashed #ffffff22; border-radius: 50%; animation: sp 30s linear infinite; }
.ring.r2 { inset: 18%; animation-duration: 20s; animation-direction: reverse; }
@keyframes sp { to { transform: rotate(360deg); } }
.core { position: absolute; inset: 36%; border-radius: 50%; display: grid; place-items: center; font-weight: 800; font-size: 20px; background: radial-gradient(circle, #a78bfa, #5b21b6); box-shadow: 0 0 80px #8b5cf6aa; animation: pu 3s ease-in-out infinite; }
@keyframes pu { 50% { box-shadow: 0 0 120px #22d3eecc; } }
.node { position: absolute; padding: 8px 14px; border-radius: 12px; background: #ffffff10; border: 1px solid #ffffff26; backdrop-filter: blur(8px); font-size: 13px; white-space: nowrap; transform: translate(-50%, -50%); }
.ring .node { animation: sp 30s linear infinite reverse; }
.ring.r2 .node { animation: sp 20s linear infinite; }
section { padding: 90px 0; }
.kick { font: 13px var(--mx-mono); color: var(--mx-green); letter-spacing: .15em; }
h2 { font-size: clamp(28px, 3.4vw, 44px); line-height: 1.25; margin: 10px 0; font-weight: 700; border: 0; padding: 0; }
.sub { color: var(--mx-muted); margin-bottom: 40px; }
.center { text-align: center; }
.more { margin-top: 28px; }
.more a { color: var(--mx-cyan); }
.glass { border: 1px solid var(--mx-line); border-radius: 20px; background: #ffffff08; backdrop-filter: blur(10px); }
.reveal { opacity: 0; transform: translateY(30px); transition: .8s; }
.reveal.on { opacity: 1; transform: none; }
.grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
.card { display: block; padding: 28px; transition: transform .2s, border-color .3s, box-shadow .3s; }
.card:hover { border-color: #8b5cf6aa; box-shadow: 0 20px 60px #8b5cf633; }
.card .ic { font-size: 30px; }
.card h3 { margin: 12px 0 8px; font-size: 20px; font-weight: 700; }
.card p { color: var(--mx-muted); font-size: 14px; }
.card .lv { font-size: 12px; color: var(--mx-cyan); }
.bento { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; }
.box { position: relative; padding: 24px; overflow: hidden; --x: 50%; --y: 50%; transition: border-color .3s; }
.box::before { content: ""; position: absolute; inset: 0; background: radial-gradient(380px circle at var(--x) var(--y), #8b5cf62e, transparent 45%); opacity: 0; transition: .3s; pointer-events: none; }
.box:hover::before { opacity: 1; }
.box:hover { border-color: #8b5cf677; }
.box small { font: 12px var(--mx-mono); color: var(--mx-pink); letter-spacing: .1em; }
.box h3 { font-size: 18px; margin: 6px 0 10px; font-weight: 700; }
.box ul { list-style: none; padding: 0; margin: 0; color: var(--mx-muted); font-size: 14px; display: grid; grid-template-columns: 1fr 1fr; gap: 4px 16px; }
.box li::before { content: "▸ "; color: var(--mx-purple); }
.box li a:hover { color: #fff; }
.code { overflow: hidden; max-width: 900px; margin: auto; }
.tabs { display: flex; gap: 4px; padding: 10px; border-bottom: 1px solid var(--mx-line); }
.tabs button { font: 13px var(--mx-mono); color: var(--mx-muted); background: none; border: 1px solid transparent; padding: 6px 14px; border-radius: 8px; cursor: pointer; }
.tabs button.on { color: #fff; background: #8b5cf633; border-color: #8b5cf688; }
.code pre { margin: 0; padding: 22px; font: 13px/1.75 var(--mx-mono); overflow: auto; color: #d9d3f5; }
.tl { border-left: 1px solid #ffffff22; margin-left: 10px; max-width: 820px; }
.st { padding: 0 0 22px 32px; position: relative; }
.st button { all: unset; cursor: pointer; display: block; width: 100%; }
.st::before { content: ""; position: absolute; left: -7px; top: 8px; width: 13px; height: 13px; border-radius: 50%; background: #3a3354; transition: .3s; }
.st.open::before { background: var(--mx-purple); box-shadow: 0 0 16px var(--mx-purple); }
.st h4 { font-size: 18px; font-weight: 600; margin: 0; }
.st h4 em { font-style: normal; color: var(--mx-muted); font-size: 13px; margin-left: 10px; }
.st ul { max-height: 0; overflow: hidden; transition: max-height .4s; color: var(--mx-muted); padding-left: 20px; font-size: 14px; margin: 0; list-style: disc; }
.st.open ul { max-height: 220px; margin-top: 8px; }
.cta { padding: 60px 30px; text-align: center; }
@media (max-width: 900px) {
  .hero, .grid3, .bento { grid-template-columns: 1fr; }
  .hero { padding: 40px 0; min-height: auto; }
}
@media (max-width: 560px) { .box ul { grid-template-columns: 1fr; } .stats { gap: 24px; } }
@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; }
  .reveal { opacity: 1; transform: none; }
}
</style>

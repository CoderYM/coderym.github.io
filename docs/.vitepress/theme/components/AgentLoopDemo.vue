<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'

const steps = [
  ['01', '感知 Perceive', '接收用户目标与上下文'],
  ['02', '思考 Think', 'LLM 推理下一步做什么'],
  ['03', '行动 Act', '调用工具 / API / MCP'],
  ['04', '观察 Observe', '读取工具返回结果'],
  ['05', '回答 Respond', '目标达成，输出结果'],
]
// [对应步骤, 样式, 文本]
const lines: [number, string, string][] = [
  [0, '', '$ python agent_loop.py "明天上海适合跑步吗？"\n\n'],
  [1, 't', '[Thought] 需要先查询明天上海的天气\n'],
  [2, 'a', '[Action]  get_weather(city="上海", date="明天")\n'],
  [3, 'o', '[Observe] 多云 18~24°C，湿度 60%，AQI 42\n\n'],
  [1, 't', '[Thought] 天气适宜，再看看推荐时段\n'],
  [2, 'a', '[Action]  get_hourly(city="上海")\n'],
  [3, 'o', '[Observe] 06:00-08:00 气温 19°C，风力 2 级\n\n'],
  [4, 'f', '[Final]   适合！建议早上 6-8 点慢跑，记得补水 🏃\n'],
]

const active = ref(0)
const shown = ref<{ cls: string; text: string }[]>([])
const done = ref(false)
let alive = true
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function play() {
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches
  while (alive) {
    shown.value = []
    done.value = false
    for (const [s, cls, text] of lines) {
      if (!alive) return
      active.value = s
      const seg = { cls, text: '' }
      shown.value.push(seg)
      const cur = shown.value[shown.value.length - 1]
      if (still) { cur.text = text; continue }
      for (const ch of text) { cur.text += ch; await sleep(22) }
      await sleep(400)
    }
    done.value = true
    if (still) return
    await sleep(3500)
  }
}

onMounted(play)
onBeforeUnmount(() => { alive = false })
</script>

<template>
  <div class="demo">
    <ol class="glass steps">
      <li v-for="(s, i) in steps" :key="s[0]" :class="{ on: i === active }">
        <b>{{ s[0] }}</b>
        <div>{{ s[1] }}<small>{{ s[2] }}</small></div>
      </li>
    </ol>
    <div class="glass term">
      <div class="tb"><i /><i /><i /> agent_loop.py — running</div>
      <pre class="out" aria-label="Agent 运行过程演示"><span v-for="(l, i) in shown" :key="i" :class="l.cls">{{ l.text }}</span><span v-if="done" class="cur" /></pre>
    </div>
  </div>
</template>

<style scoped>
.demo { display: grid; grid-template-columns: .8fr 1.2fr; gap: 28px; }
.glass { border: 1px solid var(--mx-line); border-radius: 20px; background: #ffffff08; backdrop-filter: blur(10px); }
.steps { list-style: none; margin: 0; padding: 26px; display: flex; flex-direction: column; gap: 12px; }
.steps li { display: flex; gap: 14px; align-items: center; padding: 14px; margin: 0; border-radius: 14px; border: 1px solid transparent; color: var(--mx-muted); transition: .3s; }
.steps b { display: grid; place-items: center; min-width: 34px; height: 34px; border-radius: 50%; border: 1px solid #ffffff30; font: 13px var(--mx-mono); }
.steps li.on { border-color: #8b5cf688; background: #8b5cf61a; color: #fff; }
.steps li.on b { background: var(--mx-purple); border-color: var(--mx-purple); box-shadow: 0 0 20px var(--mx-purple); }
.steps small { display: block; font-size: 12px; color: var(--mx-muted); }
.term { overflow: hidden; background: #05020ccc; }
.tb { display: flex; align-items: center; gap: 6px; padding: 12px 16px; border-bottom: 1px solid var(--mx-line); font: 12px var(--mx-mono); color: var(--mx-muted); }
.tb i { width: 10px; height: 10px; border-radius: 50%; background: #ff5f56; }
.tb i:nth-child(2) { background: #ffbd2e; }
.tb i:nth-child(3) { background: #27c93f; margin-right: 8px; }
.out { margin: 0; padding: 20px; min-height: 340px; white-space: pre-wrap; font: 13px/1.8 var(--mx-mono); color: #eee9ff; background: none; }
.t { color: var(--mx-cyan); } .a { color: #fbbf24; } .o { color: var(--mx-muted); } .f { color: var(--mx-green); }
.cur { display: inline-block; width: 8px; height: 16px; background: var(--mx-green); animation: bl 1s infinite; vertical-align: middle; }
@keyframes bl { 50% { opacity: 0; } }
@media (max-width: 900px) { .demo { grid-template-columns: 1fr; } }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
</style>

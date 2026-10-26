<script setup lang="ts">
// 12 周学习打卡：进度只保存在浏览器本地（localStorage），不上传任何数据
import { computed, onMounted, ref, watch } from 'vue'

const props = defineProps<{ weeks: string[]; storageKey?: string }>()
const key = props.storageKey ?? 'maxai-progress-12w'
const done = ref<boolean[]>(props.weeks.map(() => false))

onMounted(() => {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? '[]')
    if (Array.isArray(saved)) done.value = props.weeks.map((_, i) => saved[i] === true)
  } catch { /* 数据损坏时忽略 */ }
})
watch(done, (v) => localStorage.setItem(key, JSON.stringify(v)), { deep: true })

const pct = computed(() => Math.round((done.value.filter(Boolean).length / props.weeks.length) * 100))
const reset = () => { done.value = props.weeks.map(() => false) }
</script>

<template>
  <div class="tracker">
    <div class="head">
      <strong>学习进度 {{ pct }}%</strong>
      <button type="button" @click="reset">重置</button>
    </div>
    <div class="bar" role="progressbar" :aria-valuenow="pct" aria-valuemin="0" aria-valuemax="100" aria-label="学习进度">
      <span :style="{ width: pct + '%' }" />
    </div>
    <ul>
      <li v-for="(w, i) in weeks" :key="i">
        <label><input v-model="done[i]" type="checkbox"> <span :class="{ ok: done[i] }">第 {{ i + 1 }} 周 · {{ w }}</span></label>
      </li>
    </ul>
    <p class="note">进度保存在当前浏览器中，清除浏览器数据后会丢失。</p>
  </div>
</template>

<style scoped>
.tracker { border: 1px solid #8b5cf644; border-radius: 16px; padding: 20px 24px; margin: 24px 0; background: linear-gradient(135deg, #8b5cf614, #22d3ee0a); }
.head { display: flex; justify-content: space-between; align-items: center; }
.head button { font-size: 13px; color: var(--vp-c-text-2); border: 1px solid var(--vp-c-divider); border-radius: 8px; padding: 2px 10px; }
.head button:hover { color: var(--vp-c-text-1); }
.bar { height: 8px; border-radius: 99px; background: #ffffff14; margin: 12px 0 16px; overflow: hidden; }
.bar span { display: block; height: 100%; background: linear-gradient(90deg, var(--mx-cyan), var(--mx-purple), var(--mx-pink)); transition: width .4s; }
ul { list-style: none; padding: 0 !important; display: grid; grid-template-columns: 1fr 1fr; gap: 4px 20px; }
li { margin: 0 !important; }
label { cursor: pointer; }
input { accent-color: var(--mx-purple); }
.ok { color: var(--vp-c-text-2); text-decoration: line-through; }
.note { font-size: 12px; color: var(--vp-c-text-3); margin: 8px 0 0 !important; }
@media (max-width: 640px) { ul { grid-template-columns: 1fr; } }
</style>

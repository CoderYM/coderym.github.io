<script setup lang="ts">
// 知识库完整目录，数据来自 curriculum.ts
import { withBase } from 'vitepress'
import { modules } from '../../curriculum'

const parts = ['基础篇', '核心篇', '生态篇', '工程篇'].map((p) => ({
  name: p,
  mods: modules.filter((m) => m.part === p),
}))
</script>

<template>
  <div v-for="part in parts" :key="part.name" class="part">
    <h2 :id="part.name">{{ part.name }}</h2>
    <div class="grid">
      <div v-for="mod in part.mods" :key="mod.id" class="mod">
        <h3>{{ mod.text }}</h3>
        <ol>
          <li v-for="it in mod.items" :key="it.link"><a :href="withBase(it.link)">{{ it.text }}</a></li>
        </ol>
      </div>
    </div>
  </div>
</template>

<style scoped>
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 16px; }
.mod { border: 1px solid var(--vp-c-divider); border-radius: 14px; padding: 16px 20px; background: var(--vp-c-bg-soft); transition: border-color .25s; }
.mod:hover { border-color: #8b5cf688; }
.mod h3 { margin: 0 0 8px !important; font-size: 17px; }
.mod ol { margin: 0 !important; padding-left: 20px; }
.mod li { margin: 2px 0 !important; font-size: 14px; }
@media (max-width: 640px) { .grid { grid-template-columns: 1fr; } }
</style>

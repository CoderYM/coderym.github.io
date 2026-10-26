import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import { nextTick } from 'vue'
import HomePage from './components/HomePage.vue'
import ProgressTracker from './components/ProgressTracker.vue'
import ModuleIndex from './components/ModuleIndex.vue'
import './style.css'

const LANG_KEY = 'maxai-code-lang'

// 代码组里选了某种语言（如 Go），全站其它代码组同步切换到同名标签，并记住选择
function applyLang(label: string) {
  document.querySelectorAll<HTMLLabelElement>('.vp-code-group .tabs label').forEach((el) => {
    if (el.textContent?.trim() !== label) return
    const input = document.getElementById(el.htmlFor) as HTMLInputElement | null
    if (input && !input.checked) input.click()
  })
}

function setupLangSync(router: { onAfterRouteChange?: (to: string) => void }) {
  document.addEventListener('click', (e) => {
    if (!e.isTrusted) return
    const label = (e.target as HTMLElement).closest?.('.vp-code-group .tabs label')
    const text = label?.textContent?.trim()
    if (!text) return
    localStorage.setItem(LANG_KEY, text)
    applyLang(text)
  })
  const restore = () => {
    const saved = localStorage.getItem(LANG_KEY)
    if (saved) nextTick(() => applyLang(saved))
  }
  const prev = router.onAfterRouteChange
  router.onAfterRouteChange = (to) => {
    prev?.(to)
    restore()
  }
  restore()
}

export default {
  extends: DefaultTheme,
  enhanceApp({ app, router }) {
    app.component('HomePage', HomePage)
    app.component('ProgressTracker', ProgressTracker)
    app.component('ModuleIndex', ModuleIndex)
    if (typeof window !== 'undefined') setupLangSync(router)
  },
} satisfies Theme

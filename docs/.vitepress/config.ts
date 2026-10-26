import { defineConfig, type DefaultTheme } from 'vitepress'
import { modules, projects, roadmap, papers, interview } from './curriculum'

const guideSidebar: DefaultTheme.SidebarItem[] = [
  { text: '知识库总览', link: '/guide/' },
  ...['基础篇', '核心篇', '生态篇', '工程篇'].map((part) => ({
    text: part,
    items: modules
      .filter((mod) => mod.part === part)
      .map((mod) => ({ text: mod.text, collapsed: true, items: mod.items })),
  })),
]

export default defineConfig({
  lang: 'zh-CN',
  title: 'MaxAI Agent Lab',
  description: '系统化的 AI Agent 开发学习路线与知识库：LLM、Tool Calling、RAG、MCP、多 Agent 与生产部署',
  // 构建到 docs/.vitepress/dist，再由 scripts/publish.mjs 复制到仓库根目录，
  // GitHub Pages 保持「main 分支 / 根目录」发布，无需改设置
  cleanUrls: true,
  lastUpdated: true,
  // 首页的粒子背景和配色按深色设计，统一深色避免浅色模式下视觉割裂
  appearance: 'force-dark',
  head: [
    ['link', { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' }],
    ['meta', { name: 'theme-color', content: '#070312' }],
    ['meta', { property: 'og:title', content: 'MaxAI Agent Lab · AI Agent 开发学习路线' }],
    ['meta', { property: 'og:description', content: '从 LLM 原理到多 Agent 与生产部署，Python / Go / Java 代码示例' }],
  ],
  markdown: {
    lineNumbers: true,
  },
  themeConfig: {
    logo: '/favicon.svg',
    siteTitle: 'MaxAI Agent Lab',
    nav: [
      { text: '学习路线', link: '/roadmap/', activeMatch: '/roadmap/' },
      { text: '知识库', link: '/guide/', activeMatch: '/guide/' },
      { text: '实战项目', link: '/projects/', activeMatch: '/projects/' },
      {
        text: '更多',
        items: [
          { text: '论文精读', link: '/papers/' },
          { text: '面试题', link: '/interview/' },
          { text: '术语表', link: '/glossary' },
          { text: '学习资源', link: '/resources' },
        ],
      },
      { text: '关于我', link: '/about' },
    ],
    sidebar: {
      '/guide/': guideSidebar,
      '/roadmap/': [{ text: '学习路线', items: [{ text: '总览', link: '/roadmap/' }, ...roadmap] }],
      '/projects/': [{ text: '实战项目', items: [{ text: '总览', link: '/projects/' }, ...projects] }],
      '/papers/': [{ text: '论文精读', items: [{ text: '总览', link: '/papers/' }, ...papers] }],
      '/interview/': [{ text: '面试题', items: [{ text: '总览', link: '/interview/' }, ...interview] }],
    },
    outline: { level: [2, 3], label: '本页目录' },
    socialLinks: [{ icon: 'github', link: 'https://github.com/CoderYM' }],
    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: '搜索', buttonAriaLabel: '搜索' },
          modal: {
            noResultsText: '没有找到结果',
            resetButtonTitle: '清除',
            footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' },
          },
        },
      },
    },
    editLink: {
      pattern: 'https://github.com/CoderYM/coderym.github.io/edit/main/docs/:path',
      text: '在 GitHub 上编辑此页',
    },
    docFooter: { prev: '上一篇', next: '下一篇' },
    lastUpdated: { text: '最后更新' },
    returnToTopLabel: '回到顶部',
    sidebarMenuLabel: '目录',
    footer: {
      message: 'Python 为主 · Go / Java 同步',
      copyright: '© 2026 MaxAI · maxai.is-a.dev',
    },
  },
})

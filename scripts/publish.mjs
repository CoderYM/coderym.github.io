// 把 VitePress 构建结果（docs/.vitepress/dist）复制到仓库根目录，
// 让 GitHub Pages 以「main 分支 / 根目录」直接发布，无需修改仓库设置。
//
// 只删除、覆盖「上一次发布生成的文件」（记录在 .published.json），
// 不会动源码、brand/ 等其他文件。
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const dist = join(root, 'docs/.vitepress/dist')
const manifest = join(root, '.published.json')

// 根目录下这些名字属于源码或工具，构建产物绝不能占用
const PROTECTED = new Set([
  '.git', '.gitignore', '.published.json', 'docs', 'scripts', 'node_modules',
  'package.json', 'package-lock.json', 'README.md', 'brand', 'previews',
])

if (!existsSync(dist)) {
  console.error('未找到构建结果，请先运行 vitepress build docs')
  process.exit(1)
}

const entries = readdirSync(dist)
const clash = entries.filter((name) => PROTECTED.has(name))
if (clash.length) {
  console.error(`构建产物与源码文件重名，已中止：${clash.join(', ')}`)
  process.exit(1)
}

// 1. 删除上次发布的文件（处理文章被删除或改名的情况）
const previous = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : []
for (const name of previous) {
  if (PROTECTED.has(name)) continue
  rmSync(join(root, name), { recursive: true, force: true })
}

// 2. 复制本次构建结果，覆盖根目录的 index.html 等
for (const name of entries) {
  const target = join(root, name)
  rmSync(target, { recursive: true, force: true })
  cpSync(join(dist, name), target, { recursive: true })
}

writeFileSync(manifest, JSON.stringify(entries.sort(), null, 2) + '\n')
console.log(`已发布到仓库根目录：${entries.length} 项（index.html、assets/、guide/ 等）`)

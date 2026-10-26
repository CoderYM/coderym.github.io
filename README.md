# MaxAI Agent Lab

AI Agent 开发学习路线与知识库，站点：https://maxai.is-a.dev

基于 [VitePress](https://vitepress.dev) 构建。源码在 `docs/`，`npm run build` 会把生成的网页（`index.html`、`assets/`、`guide/` 等）复制到仓库根目录，GitHub Pages 按原设置从 `main` 分支根目录发布，不需要改任何仓库设置。

## 发布流程

```bash
npm install      # 首次
npm run dev      # 本地预览 http://localhost:5173
npm run build    # 构建并把网页复制到根目录（会检查死链）
git add -A && git commit -m "..." && git push
```

- 改完内容一定要先 `npm run build` 再提交，否则线上还是旧内容。
- 根目录下的 `index.html`、`assets/`、`guide/` 等是生成文件，不要手动修改，下次构建会被覆盖。
- 生成了哪些文件记录在 `.published.json`，构建时只清理这些文件，不会动源码和 `brand/` 等其他目录。

## 目录

```text
docs/                   源码
├─ .vitepress/
│  ├─ config.ts         站点配置、导航、侧边栏
│  ├─ curriculum.ts     知识体系目录（侧边栏、首页、文章计数都从这里生成）
│  └─ theme/            主题与首页组件
├─ public/              原样复制的静态文件（CNAME、favicon、.nojekyll）
├─ index.md             首页
├─ guide/               知识库（16 个模块）
├─ roadmap/ projects/ papers/ interview/
├─ glossary.md  resources.md  about.md
scripts/publish.mjs     把构建结果复制到根目录
```

## 新增或修改文章

1. 在 `docs/.vitepress/curriculum.ts` 对应模块的 `items` 里加一行 `['slug', '标题']`
2. 创建 `docs/guide/<模块>/<slug>.md`
3. 多语言代码使用 code-group，标签名固定为 `[Python]` `[Go]` `[Java]`，全站切换会按标签名同步：

````md
::: code-group
```python [Python]
print("hi")
```
```go [Go]
fmt.Println("hi")
```
```java [Java]
System.out.println("hi");
```
:::
````

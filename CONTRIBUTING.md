# 贡献指南

谢谢你愿意改这个插件 🙌

这份文档只讲一件事：**怎么安全地改它，并且证明你没改坏。**

> 下面每条规矩都是从真实的坑里长出来的。这里的破例，最后都变过一个难查的 bug。

---

## 一、先跑起来

```sh
git clone https://github.com/reaxlll/dsh-workspace-recollection.git
cd dsh-workspace-recollection

# 挂到 DSH（file: 依赖在 profile 里是「拷贝」语义，不是软链）
dsh plugin --profile desktop add file:$PWD

npm test           # 纯函数单测，245 条，几百毫秒
npm run typecheck  # tsc --checkJs（需要先 npm install；CI 也会跑）
```

改完代码，**生效方式取决于你改了哪一半**：

| 改的是 | 怎么生效 | 为什么 |
| --- | --- | --- |
| `lib/index.js`（宿主半侧） | **完全退出应用再打开** | Node 的 ESM 模块缓存 —— 插件代码不会热替换 |
| `lib/client.js`（浏览器半侧） | 刷新页面 | 客户端按文件 mtime/size 重算版本，自动换新 |
| `lib/` 下除 `index.js` / `client.js` 之外的模块（纯函数） | 只需重跑 `npm test` | 它们不依赖 DSH，`node` 直接跑 |

⚠️ 两处最容易踩的：

- **改了源码，profile 里 `node_modules` 的副本不会自动更新**（file: 依赖是拷贝），
  改完要么重跑 `dsh plugin add`，要么手动同步过去。否则你会对着旧代码调试半天。
- **客户端半侧绝不能抛错**：桌面端把「插件有条目没激活」判为**致命启动错误**，
  会触发 profile 自动恢复（补丁被改名、插件全丢）。
  所以 `apply()` 要整体包 try/catch，服务缺席就安静降级 —— **宁可没有界面，也不能抛错**。

---

## 二、代码地图

| 文件 | 管什么 | 改动风险 | 怎么验证 |
| --- | --- | --- | --- |
| `lib/index.js` | 插件定义、9 个工具、注入 section、HTTP 路由与管理台页面、存储与向量读写 | 高（宿主半侧，改完要重启） | 语法 + 离线端到端（第五节） |
| `lib/client.js` | 浏览器半侧：两个入口（会话头 / 设置页）+ 全屏面板外壳（内容来自 `/page`） | 中（**绝不能抛错**） | 刷新页面看状态条自报的版本 |
| `assets/console.html` | 管理台页面本体（自包含 HTML，只依赖 `/api/session-memory/*`） | 中 | 点开面板；改完刷新即生效（页面按 mtime 重读） |
| `lib/noise.js` | 检索噪音过滤 + 排序分层（四路信号 / `scoreEntry` / DF 门槛） | 低（纯函数） | `npm test` + 真实回放 |
| `lib/segments.js` | 段级引索：切段 + BM25 定位 | 低（纯函数） | `npm test` |
| `lib/timehint.js` | 时间提示解析（日期 / 相对时间 → 日历日区间） | 低（纯函数） | `npm test` |
| `lib/model.js` | 嵌入模型清单、镜像、下载地址、完整性判定 | 低（纯函数） | `npm test` |
| `lib/store-logic.js` | 排序、超限裁剪（置顶必须留下）、批量删除（`locked` 要报出来）、工作区键 | 低（纯函数） | `npm test` |
| `lib/sessions.js` | 历史会话的读取与切段、渲染（会话导入与 session_read 的地基） | 低（纯函数） | `npm test` + 列一次会话 |
| `lib/lock.js` | 单实例写锁的状态判定（mine / held / stale / broken） | 低（纯函数） | `npm test` |
| `lib/migrate.js` | 存储版本判定、迁移链、备份命名与保留策略 | 低（纯函数） | `npm test` |
| `lib/vector-codec.js` | 向量 Float32 ↔ base64 编解码、v2→v3 迁移 | 低（纯函数） | `npm test` |

判断标准很简单：**能不能脱开 DSH，用 `node` 直接 import 并跑？**
能 → 就该放进独立模块并配单测；不能 → 它是宿主半侧，改动按高风险对待。

---

## 三、三条硬规矩

### 1. 纯函数进独立零依赖模块，并配单测

`noise.js` / `segments.js` / `timehint.js` / `model.js` 除了标准库**不 import 任何东西**，所以：

```sh
node --test tests/noise.test.mjs     # 不用起 DSH、不用加载模型、几十毫秒出结果
```

**用例里的数字请直接抄真实回放的结果**，别自己编 —— 那样这组测试同时就是「阈值有没有被改坏」的回归网。

### 2. 阈值必须用真实数据回放来定，不能拍脑袋

吃过亏的：曾经想当然用「深层分 × 0.95」压制虚高，回放一看**完全无效**（top6 一模一样，0.548×0.95 还是第一名）；
而 `gate=0.45` 是唯一在 6 条真实查询上零副作用的值。**拍出来的阈值，多半拍在错的量级上。**

最小回放骨架（放临时脚本里跑，别提交）：

```js
// 与插件同口径：同一个模型、同样的 cosine、同样的 bestChunk
const queries = ["<你关心的查询>", "..."];
for (const q of queries) {
  const qv = (await extractor([q], { pooling: "mean", normalize: true })).tolist()[0];
  const rows = entries.map((entry) => ({
    id: entry.id,
    s: dot(qv, vectors[entry.id].s),                                  // 浅层分：与要点向量
    d: Math.max(...vectors[entry.id].d.map((c) => dot(qv, c))),        // 深层分：全部正文块取最大
    summary: entry.summary,
  }));
  // 打印「改前 / 改后」两种规则的 top-8，逐条看：真相关的掉没掉？跑题的上来没上来？
}
```

**判定标准**：真相关的一条都不许掉，跑题的必须掉。只满足一边 = 没改好，回去改。

### 3. 约束行为要用代码，不要用提示词

想让模型「别做某事」，**先想清楚它为什么做得到**。

真实例子：文档里写着「读历史会话请用 `session_read`」，模型照样去手工解压 `.dsh/sessions` 下的 zstd 文件 ——
因为**工具菜单里没有别的路**。提示词挡不住「唯一可行路径」。

正确做法是三层，缺一层都会漏：

1. **先造正门** —— 把捷径想做的事做成工具（例：`session_read`）；
2. **再上硬拦截** —— `tools/pre-execute` 里 deny 掉绕过正门的调用，理由里写清替代路径；
3. **最后删劝告** —— 有了 1+2，注入里的「不要……」就是纯开销。

---

## 四、常见改动配方

### 调检索阈值
1. 改 `lib/noise.js` 顶部的常量（`NOISE_*` / `DEEP_GATE` / `INDEX_DF_MAX`）；
2. 跑真实数据回放，对比改前 / 改后；
3. 把新数字抄进 `tests/noise.test.mjs`；
4. `npm test`。

### 加一个新工具

```js
attempt(() => defineTool({        // 一定单独 try/catch：一个 schema 写错会带走后面所有工具
  name: "memory_xxx",
  description: "...",             // 写清「什么时候该用它」—— 这是模型唯一的说明书
  parameters: { arg: { type: "string", required: true, description: "..." } },
  output: { schema: { /* ... */ }, render: (_args, value) => [{ type: "text", text: String(value.text) }] },
  execute: async (args, exec) => { /* ... */ },
}));
```

- `required` 只能写 `true`；**可选参数的正确写法是整条省略 `required`**；
- 注册结果会挂到 `POST /api/session-memory/status` 的 `tools` 字段 —— 加载后先看它，比翻日志快；
- 别忘了在 `README.md` 的工具表里补一行。

### 改检索排序

- 排序规则集中在 `lib/noise.js` 的 `scoreEntry()`（纯函数，好测）；
- 打分与取回在 `lib/index.js` 的 `recallEntries()`；
- **返回给模型的永远只是「要点 + id」** —— 这是省 token 的根，别在这里塞正文。

### 加 HTTP 接口（面板用）

在 `lib/index.js` 的 `table` 对象里加一个方法；前端用 `api.call("<method>", sessionId, input)` 调。
前缀 `/api/session-memory`，一律 `POST` + `{ sessionId, input }`。

### 改前端面板

`lib/client.js`，三个注意点：

1. **`apply()` 整体包 try/catch**（见第一节的致命错误）；
2. flex 布局里的滚动区要给 `min-height: 0`，否则它会把真正的滚动区挤成 0 高 —— 表现是「整个面板突然不能上下滑」；
3. 改完刷新页面即可，状态条上会自报 `ui <版本>`，用它确认浏览器跑的确实是新代码（不用截图、不用猜）。

---

## 五、提 PR 前，过一遍这张清单

```sh
npm test                      # 1. 单测全绿
node --check lib/index.js     # 2. 语法
node --check lib/client.js
```

- [ ] **单测全绿**（新增纯函数要配用例；改了阈值要更新用例里的数字）
- [ ] **纯函数改动**：附「改前 / 改后」的真实回放对比
- [ ] **宿主半侧改动**：附离线端到端结果（骨架见下）
- [ ] **没有把「天生会过期的状态」写进代码或文档**（「本次重启后生效」这种，生来就会过期）
- [ ] **没有削弱降级链**：嵌入不可用 → 关键词检索；某条没向量 → 它仍能被 `memory_search` 找到

离线端到端骨架（不用起 DSH，也**不碰真实数据**）：

```js
process.env.DSH_HOME = "<把真实 $DSH_HOME 复制到临时目录>" + "";   // 隔离！
const registered = [];
const fakeScoped = {
  tools: { register: (t) => registered.push(t) },
  systemPrompt: { section: () => {} },
  webServer: { register: () => ({ dispose() {} }) },
  effect: (fn) => { try { fn(); } catch {} return () => {}; },
  on: () => () => {},
  logger: { warn: () => {}, info: () => {}, error: () => {} },
};
const ctx = { inject: (_deps, cb) => cb(fakeScoped), get: () => undefined, /* ... */ };

const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = () => 0;                       // 跳过 apply 里的预热 / 回写定时任务
await (await import("<插件 lib/index.js 的路径>")).apply(ctx);
globalThis.setTimeout = realSetTimeout;

const tool = registered.find((t) => t.name === "memory_recall");
const out = await tool.execute(
  { query: "<一条真实查询>" },
  { agent: { id: "t", session: { header: { cwd: "<工作区路径>" } } } },
);
```

> 注意：`@deepseek-ai/dsh-*` 由宿主提供，普通 `node` 进程未必解析得到 ——
> **把插件副本放进 profile 的 `node_modules/` 下再 import** 是最省事的做法（跑完记得删掉）。

---

## 六、提 PR

- 一个 PR 只做一件事；标题写「做了什么」，描述写清「**为什么**」和「**怎么验证的**」；
- 有行为变化就同步更新 `README.md`（两份文档都是给用户看的，别让它们对不上）；
- 方向不确定就先开 issue 聊 —— 比写完再返工省时间。

## 七、这个项目的设计取向

改动如果和下面几条冲突，请先在 issue 里讨论：

| 取向 | 含义 |
| --- | --- |
| **宁可不给答案，也不给假答案** | 没有明显相关的记忆就直说「没有」；被筛掉的条目折成一行 `id + 分数` 留在结果末尾 —— **永不静默丢弃** |
| **每一层都要能降级** | 模型缺失 → 关键词检索；浅层向量没算完 → 该条按深层排；单条完全没向量 → `memory_search` 仍找得到 |
| **token 只花在真正要看的地方** | 常驻的只有要点；向量不进 prompt；取原文必须显式要 |
| **不碰内核** | 只用官方插件 API；前后端走自己的 `/api/session-memory/*` |
| **本地优先** | 嵌入模型跑在本机（首次自动拉取一次，之后零联网）；不依赖任何云端 API |

---

拿不准的地方随时开 [issue](https://github.com/reaxlll/dsh-workspace-recollection/issues) 问 ——
维护者不一定有空，但**下一个踩到同样坑的人会感谢你**。

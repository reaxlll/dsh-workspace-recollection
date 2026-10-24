/**
 * dsh-session-memory · 可判别串层（v2.11 新增）
 *
 * 补的缺口：浅层向量 = 摘要 + 标签，而摘要由同一个模型按同一套风格生成，
 * 于是「v2.5.0 换成 v2.7.0」「端口 50247 改成 50251」这类**只差几个字符**的条目
 * 在向量空间里几乎重合（实测全库两两余弦中位 0.658，正确项与干扰项的差距中位 0.01）。
 * 双塔模型对「同一个句子里换了个数字」天生分辨不出来，这不是换模型能解决的
 * （bge-base 换上去 MRR 也没涨，见 记忆检索精度/诊断与方案.md）。
 *
 * 能解决的是**把判别串单独提出来，当结构化信号用**：
 *   · 写入时从正文里抽出版本号 / 路径 / 端口 / 文件名 / 日期 / 标识符
 *   · 这些串拼进浅层嵌入文本（不进展示摘要，否则目录会变脏）
 *   · 检索时若 query 里也有同样的精确形态，直接加分 —— 这是向量算不出来的
 *
 * 提取刻意保守：中文正文里数字极多，把每个数字都当判别串等于没判别。
 * 只认「有形态特征」的（三段版本号、盘符路径、a.b 扩展名、x 月 x 日……），
 * 拿不准就宁可漏，也不要把噪音灌进索引。
 *
 * 本文件不 import 任何包，可脱离 DSH 进程直接单测：node tests/discriminants.test.mjs
 */

/** 每条记忆最多留多少个判别串（多了就没有判别力了，也白占索引）。 */
export const MAX_ANCHORS = 12;

/** 单串长度上限：再长就不是「可判别串」而是整句话了。 */
export const MAX_ANCHOR_CHARS = 120;

/**
 * 提取规则表 —— 顺序即优先级，同类按出现顺序，总数受 MAX_ANCHORS 约束。
 *
 * 每条规则带一个 `kind`：检索加权时用来判断「同类型才算命中」
 * （query 里的路径只该和条目里的路径比，不该和版本号比）。
 */
const RULES = [
  // URL：最先抓，因为它内部含有路径 / 数字，先吃掉免得被后面的规则切碎
  { kind: "url", re: /https?:\/\/[^\s)"'，。；：、（）]+/g, clean: (s) => s.replace(/[.,;]+$/, "") },
  // Windows 盘符路径（E:\DSHwork\插件生成）与 UNC
  { kind: "path", re: /(?:[A-Za-z]:\\|\\\\[\w.$-]+\\)[^\s"'，。；：、（）*?<>|]+/g, clean: (s) => s.replace(/[.,;]+$/, "") },
  // Unix 绝对路径 / 家目录路径（必须有至少两段，避免把 `/b` 这种当路径）
  { kind: "path", re: /(?:~[\/\\]|\/)(?:[\w.-]+[\/\\])+[\w.-]+/g, clean: (s) => s.replace(/[.,;]+$/, ""), min: 4 },
  // 文件名：只认常见扩展名，避免把 v1.2 当文件
  {
    kind: "file",
    // 字符类带上 `/`：这样 `lib/index.js` 会整体被抓，而不是只剩 `index.js`（丢了目录就丢了判别力）
    re: /[\w\u4e00-\u9fa5.\/-]+\.(?:js|mjs|cjs|ts|tsx|json|jsonl|md|yml|yaml|toml|ini|py|ps1|sh|bat|exe|dll|onnx|bin|txt|log|db|sqlite|csv|zip|png|jpg|jpeg|webp|gif)\b/g,
  },
  // 三段式版本号（2.10.0 / v2.3.1 / 2.10.0-beta.2）
  { kind: "version", re: /\bv?\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?\b/g, clean: (s) => s.replace(/^v/i, "") },
  // 带 v 前缀的两段版本号（v2.10）—— 不带前缀的 `0.65` 多半是小数，不抓
  { kind: "version", re: /\bv\d+\.\d+\b/g, clean: (s) => s.replace(/^v/i, "") },
  // 显式版本声明（版本 5 / version 3）
  { kind: "version", re: /(?:版本|version)\s*[:：]?\s*(\d+)/gi, pick: 1 },
  // 端口（:50247 / 端口 30000 / port 8080）—— 只认 2~5 位且紧跟在冒号或关键词后
  { kind: "port", re: /(?::|端口\s*|port\s*)(\d{2,5})\b/gi, pick: 1 },
  // 日期：ISO 与中文写法
  { kind: "date", re: /\b\d{4}-\d{2}-\d{2}\b/g },
  // 中文日期不能用尾部的 \b：`日` 和空格都是非单词字符，之间不存在单词边界
  { kind: "date", re: /\b\d{1,2}月\d{1,2}日/g },
  // 记忆 id / 任务 id / 表情 id 这类稳定标识符
  { kind: "id", re: /\b(?:mem_|task-|g\d+-|ses_)[A-Za-z0-9_-]+\b/g },
  // 反引号里的一行命令或路径（AI 写的记忆里这是最可靠的判别串来源）
  { kind: "code", re: /`([^`\n]{2,80})`/g, pick: 1 },
];

/**
 * 从正文里抽可判别串。
 *
 * @param {string} text
 * @param {{max?:number}} [options]
 * @returns {Array<{kind:string,value:string}>} 去重、按规则优先级排序、最多 max 个
 */
export function extractAnchors(text, options = {}) {
  const source = String(text === undefined || text === null ? "" : text);
  if (source === "") return [];
  const max = Number.isInteger(options.max) && options.max > 0 ? options.max : MAX_ANCHORS;
  /** @type {Array<{kind:string,value:string}>} */
  const out = [];
  const seen = new Set();
  for (const rule of RULES) {
    // 规则带 g 标志，复用同一个正则对象前要重置 lastIndex（也可以每次 new，但这里规则是模块级常量）
    rule.re.lastIndex = 0;
    let match = rule.re.exec(source);
    while (match !== null && out.length < max) {
      const raw = rule.pick === undefined ? match[0] : match[rule.pick] !== undefined ? match[rule.pick] : "";
      let value = raw === undefined || raw === null ? "" : String(raw).trim();
      if (rule.clean !== undefined) value = rule.clean(value);
      if (rule.min !== undefined && value.length < rule.min) {
        match = rule.re.exec(source);
        continue;
      }
      if (value !== "" && value.length <= MAX_ANCHOR_CHARS) {
        const key = rule.kind + "\u0000" + value.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ kind: rule.kind, value });
        }
      }
      if (out.length >= max) break;
      match = rule.re.exec(source);
    }
    rule.re.lastIndex = 0;
    if (out.length >= max) break;
  }
  return out;
}

/** 只取值，便于拼字符串 / 存库。 */
export function anchorValues(anchors) {
  const list = Array.isArray(anchors) ? anchors : [];
  return list
    .map((item) => (item !== null && typeof item === "object" && typeof item.value === "string" ? item.value : ""))
    .filter((value) => value !== "");
}

/**
 * 拼进嵌入文本的那一行。
 *
 * 刻意用 `| ` 分隔而不是自然语言：嵌入模型对符号串的字面重合更敏感，
 * 而这一层要的就是字面重合（语义交给摘要向量去管）。
 */
export function anchorLine(anchors) {
  const values = anchorValues(anchors);
  return values.length === 0 ? "" : "⟪" + values.join(" | ") + "⟫";
}

/** 归一化：库里老条目没有 anchors 字段，读出来时惰性补一份。 */
export function normalizeAnchors(raw, text) {
  if (Array.isArray(raw)) {
    const cleaned = [];
    for (const item of raw) {
      if (item === null || typeof item !== "object") continue;
      const kind = typeof item.kind === "string" && item.kind !== "" ? item.kind : "misc";
      const value = typeof item.value === "string" ? item.value.trim() : "";
      if (value !== "" && value.length <= MAX_ANCHOR_CHARS) cleaned.push({ kind, value });
      if (cleaned.length >= MAX_ANCHORS) break;
    }
    if (cleaned.length > 0) return cleaned;
  }
  return extractAnchors(typeof text === "string" ? text : "");
}

/**
 * 同一类型、值（大小写不敏感）相等即命中。返回命中的个数。
 *
 * 为什么要求同类型：`2.10.0` 既是版本号也可能出现在日期里，
 * 跨类型相等多半是巧合，加成只会抬高噪音。
 */
export function anchorHits(queryAnchors, entryAnchors) {
  const q = Array.isArray(queryAnchors) ? queryAnchors : [];
  const e = Array.isArray(entryAnchors) ? entryAnchors : [];
  if (q.length === 0 || e.length === 0) return 0;
  const bag = new Set(e.map((item) => String(item.kind) + "\u0000" + String(item.value).toLowerCase()));
  let hits = 0;
  const counted = new Set();
  for (const item of q) {
    const key = String(item.kind) + "\u0000" + String(item.value).toLowerCase();
    if (bag.has(key) && !counted.has(key)) {
      counted.add(key);
      hits += 1;
    }
  }
  return hits;
}

/**
 * 判别串命中带来的加分（0 ~ cap）。
 *
 * 用对数增长而不是线性：命中 1 个已经说明「这条真的在说同一件事」，
 * 命中 12 个和命中 6 个的差别远没有 1 个和 0 个大。
 */
export function anchorBoost(hits, cap = 0.12) {
  const count = Number(hits);
  if (!Number.isFinite(count) || count <= 0) return 0;
  const raw = Math.log2(1 + count) / Math.log2(9);
  return Math.max(0, Math.min(cap, cap * raw));
}

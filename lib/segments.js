/**
 * dsh-workspace-recollection · 段级引索层（v2.3 新增）
 *
 * 补的缺口：浅层（要点）只能定位到「哪一条」，深层（memory_detail）一给就是整条正文
 * （上限 2 万字）。中间缺一层 —— **这条记忆里，到底哪一段才是要找的？**
 *
 * 这一层全部在本地 CPU 上跑：零依赖、零联网、零模型、确定性（同输入必同输出）。
 *   1) segmentText    —— 语义优先切段（## 小节 / --- / 空行；超长段再按 380 字符在句末断开）
 *   2) tokenize       —— 中文 bigram + ASCII 词元（路径 / 命令 / 常量名原样保留）
 *   3) locateSegments —— 段级 BM25（k1=1.2, b=0.75）+ 精确形态词加权
 *
 * 定位只回「段号 + 命中词 + 字数」，正文由 memory_detail({ segments: [...] }) 按需取，
 * 于是 2 万字的记忆可以只花几百字就读到要找的那一段。
 *
 * 本文件不 import 任何包，可以脱离 DSH 进程直接单测：node tests/segments.test.mjs
 */

/**
 * 段的切分目标长度。
 * 注意与 EMBED_CHUNK_CHARS(380) 取向不同：那个是喂嵌入模型的窗口，
 * 这个是**给人读的**一段 —— 真实数据实测按 380 切会把 1.5 万字的记忆剁成 40 段、段名全丢；
 * 600 更接近一段完整论述，取 2~3 段仍能省 90% 以上。
 */
export const SEGMENT_TARGET_CHARS = 600;
/** 超过这个长度才切（600 × 1.5）：保住语义完整，别把一段完整的话切碎。 */
export const SEGMENT_SPLIT_CHARS = 900;
/** 切分时尾段短于此长度就并回前一段（免得出现 10 个字的碎尾）。 */
export const SEGMENT_TAIL_MIN_CHARS = 150;
/**
 * 节内容短于此长度就并入前一个节。
 * 真实数据里某份历史会话的「部署命令清单」有几十个 `# 第一步：基础环境` 式的标题，
 * 下面只有一行 ```bash —— 一个 7 个字的节不该占一个段号。合并时标题会写回正文，信息不丢。
 */
export const SEGMENT_MERGE_BELOW_CHARS = 40;
/** 兜底上限：超过就把尾部合并成一段（**绝不丢内容**）。 */
export const SEGMENT_MAX_COUNT = 96;
/** 清单里每段的预览长度。 */
export const SEGMENT_PREVIEW_CHARS = 80;

const BM25_K1 = 1.2;
const BM25_B = 0.75;

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const RULE_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

const TOKEN_ASCII_RE = /[A-Za-z0-9_][A-Za-z0-9_\-./\\:]*/g;
const TOKEN_CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]+/g;
/** 两字**都**是停用字的 bigram 直接丢掉（"的了""是在"这种多半没区分度）。 */
const CJK_STOP = new Set(
  ("的了是在和与或及也都很就才把被让给对从到于为以要能会可该将等这那我你他她它们之其若则而但并只还没不无有一二三四五六七八九十"
    + "上下前后里外时候个些么呢吧啊呀哦嘛嘛行做去了来说道地方可当").split(""),
);

/** 正文归一化：统一换行、去掉零宽与 BOM。 */
function normalize(text) {
  return String(text === undefined || text === null ? "" : text)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u200b-\u200f\ufeff]/g, "");
}

/**
 * 把一段长正文按长度切开：优先在空行/换行断开，其次句末。
 * 尾段过短就并回前一段 —— 宁可让最后一段长一点，也不要一个只有十个字的碎尾。
 */
function splitLong(source, chunkChars, maxCount, tailMin) {
  const pieces = [];
  let cursor = 0;
  while (cursor < source.length && pieces.length < maxCount) {
    let end = Math.min(source.length, cursor + chunkChars);
    if (end < source.length) {
      const window = source.slice(cursor, end);
      const breakAt = Math.max(
        window.lastIndexOf("\n\n"),
        window.lastIndexOf("\n"),
        window.lastIndexOf("。"),
        window.lastIndexOf("；"),
        window.lastIndexOf("！"),
        window.lastIndexOf(". "),
      );
      if (breakAt > Math.floor(chunkChars * 0.5)) end = cursor + breakAt + 1;
    }
    const piece = source.slice(cursor, end).trim();
    if (piece !== "") pieces.push(piece);
    cursor = end;
  }
  if (cursor < source.length && pieces.length > 0) {
    pieces[pieces.length - 1] = source.slice(Math.max(0, source.length - chunkChars)).trim();
  }
  if (pieces.length >= 2 && pieces[pieces.length - 1].length < tailMin) {
    const tail = pieces.pop();
    pieces[pieces.length - 1] = pieces[pieces.length - 1] + "\n\n" + tail;
  }
  return pieces.length === 0 ? [source] : pieces;
}

/** 段的预览：压平空白、去掉 markdown 记号后截断（段的正文已不含标题行）。 */
function previewOf(body) {
  const flat = body
    .replace(/\s+/g, " ")
    .replace(/^\s*[#>*-]+/, "")
    .replace(/\*\*/g, "")
    .trim();
  return flat.length > SEGMENT_PREVIEW_CHARS ? flat.slice(0, SEGMENT_PREVIEW_CHARS) + "…" : flat;
}

/**
 * 把一条记忆的深层正文切成「读得懂的段」。
 *
 * 算法（v2.3 定稿，按真实数据调过）：
 *   ① **markdown 标题是唯一可靠的语义边界** → 按 ## 切成「节」，标题即节名
 *   ② 节内**不打散**：空行不是硬边界 —— 真实数据里「当时的思考」内部全是空行，
 *      按空行切会把它剁成几十个没名字的碎片（实测 1.5 万字 → 64 段，段名全丢）
 *   ③ 一节短于 SEGMENT_SPLIT_CHARS 就整节成一段；长了才按 SEGMENT_TARGET_CHARS
 *      在空行/句末断开，每片都带同一个节名 + (i/n) 序号
 *   ④ `---` 分隔线丢弃；标题之前的内容算一节（名字为空）
 *
 * 于是「哪一段」=「哪一节里的第几片」，既可读、又能被关键词精确定位。
 *
 * @returns {Array<{idx:number,label:string,heading:string,part:number,parts:number,text:string,chars:number,preview:string,start:number}>}
 */
export function segmentText(text, options = {}) {
  const source = normalize(text);
  const splitChars = Number.isInteger(options.splitChars) && options.splitChars > 0 ? options.splitChars : SEGMENT_SPLIT_CHARS;
  const targetChars = Number.isInteger(options.targetChars) && options.targetChars > 0 ? options.targetChars : SEGMENT_TARGET_CHARS;
  const tailMin = Number.isInteger(options.tailMin) && options.tailMin >= 0 ? options.tailMin : SEGMENT_TAIL_MIN_CHARS;
  const mergeBelow = Number.isInteger(options.mergeBelow) && options.mergeBelow >= 0 ? options.mergeBelow : SEGMENT_MERGE_BELOW_CHARS;
  const maxCount = Number.isInteger(options.maxCount) && options.maxCount > 0 ? options.maxCount : SEGMENT_MAX_COUNT;
  if (source.trim() === "") return [];

  // ① 按 markdown 标题切节（标题行本身不进正文，节名单独留着）
  const sections = [];
  let current = null;
  const flush = () => { if (current !== null) { sections.push(current); current = null; } };
  for (const line of source.split("\n")) {
    if (RULE_RE.test(line)) continue;
    const heading = HEADING_RE.exec(line);
    if (heading !== null) {
      flush();
      current = { heading: heading[2].trim(), lines: [] };
      continue;
    }
    if (current === null) current = { heading: "", lines: [] };
    current.lines.push(line);
  }
  flush();

  // ② 相邻碎节合并（` ```bash ` 这种 7 个字的节不该占一个段号）；
  //    合并时把被吞掉的标题写回正文，信息一点不丢
  const merged = [];
  for (const section of sections) {
    const body = section.lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    if (body === "") continue;
    if (body.length < mergeBelow && merged.length > 0) {
      const previous = merged[merged.length - 1];
      previous.body = previous.body + "\n\n" +
        (section.heading === "" ? "" : "## " + section.heading + "\n") + body;
      continue;
    }
    merged.push({ heading: section.heading, body });
  }

  // ③ 每节：短的整节一段；长的才按长度切，切片继承节名
  const pieces = [];
  for (const section of merged) {
    if (section.body.length <= splitChars) {
      pieces.push({ heading: section.heading, body: section.body, part: 0, parts: 1 });
      continue;
    }
    const split = splitLong(section.body, targetChars, maxCount, tailMin);
    split.forEach((piece, index) => pieces.push({ heading: section.heading, body: piece, part: index + 1, parts: split.length }));
  }

  // ④ 超过总段数上限：把尾部合并成一段 —— 宁可粗一点，也**绝不丢内容**
  let finalPieces = pieces;
  if (pieces.length > maxCount) {
    const head = pieces.slice(0, maxCount - 1);
    const tail = pieces.slice(maxCount - 1);
    head.push({
      heading: tail[0].heading,
      body: tail.map((piece) => (piece.heading === "" ? "" : "## " + piece.heading + "\n") + piece.body).join("\n\n"),
      part: 0,
      parts: 1,
    });
    finalPieces = head;
  }

  // 产出段落实体（含在原文里的字符锚点，按出现顺序定位，确定性）
  const segments = [];
  let searchFrom = 0;
  finalPieces.forEach((piece, index) => {
    const anchor = piece.body.slice(0, 24);
    const at = anchor === "" ? -1 : source.indexOf(anchor, searchFrom);
    if (at >= 0) searchFrom = at + 1;
    const label = piece.heading === ""
      ? ""
      : (piece.parts > 1 ? piece.heading + " (" + String(piece.part) + "/" + String(piece.parts) + ")" : piece.heading);
    segments.push({
      idx: index + 1,
      label,
      heading: piece.heading,
      part: piece.part,
      parts: piece.parts,
      text: piece.body,
      chars: piece.body.length,
      preview: previewOf(piece.body),
      /** 段首在原文里的锚点位置（-1 = 没定位到）。切段会丢掉分隔线/空行，
       *  所以这是「大致在哪一段」，不是能直接用来切原文的精确区间。 */
      start: at,
    });
  });
  return segments;
}

/**
 * 抽词：中文 bigram + ASCII 词元。
 * 中文不引 jieba —— bigram 对"关键词定位段落"这件事已经够用，还省掉一个依赖；
 * ASCII 词元保留路径/命令/常量名的原始形态（`/srv/app/deploy`、`MAX_TEXT_CHARS`、`pnpm`）。
 */
export function tokenize(text) {
  const source = normalize(text);
  const tokens = [];
  for (const match of source.matchAll(TOKEN_ASCII_RE)) {
    const raw = match[0].replace(/[._\-:/\\]+$/, "");
    if (raw.length < 2) continue;
    tokens.push(raw.toLowerCase());
  }
  for (const match of source.matchAll(TOKEN_CJK_RE)) {
    const run = match[0];
    if (run.length === 1) {
      if (!CJK_STOP.has(run)) tokens.push(run);
      continue;
    }
    for (let i = 0; i + 2 <= run.length; i += 1) {
      const bigram = run.slice(i, i + 2);
      if (CJK_STOP.has(bigram[0]) && CJK_STOP.has(bigram[1])) continue;
      tokens.push(bigram);
    }
  }
  return tokens;
}

/** 精确形态词（含 _ - . : / \ 的路径/命令/常量名）命中率远高于普通词，给更高权重。 */
function tokenWeight(token) {
  if (/[^a-z0-9]/.test(token)) return 2.2;
  if (token.length >= 8) return 1.5;
  return 1;
}

/**
 * 段级 BM25 定位：query → 这条记忆里最相关的几段。
 * 只在**同一条记忆的段落之间**比较 —— 定位范围本来就是"已命中的那条"，不需要跨条目区分。
 *
 * @returns {Array<{idx:number,score:number,hits:string[],label:string,preview:string,chars:number,start:number,heading:string}>}
 */
export function locateSegments(segments, query, limit = 5) {
  const list = Array.isArray(segments) ? segments : [];
  if (list.length === 0) return [];
  const top = Math.max(1, Math.min(Number.isInteger(limit) && limit > 0 ? limit : 5, list.length));
  const queryTokens = [...new Set(tokenize(query))];

  const shape = (segment, score, hits) => ({
    idx: segment.idx,
    score,
    hits,
    label: segment.label,
    heading: segment.heading,
    preview: segment.preview,
    chars: segment.chars,
    start: segment.start,
  });

  // 没有查询词（或全是停用词）→ 按顺序给前几段，让模型自己挑
  if (queryTokens.length === 0) return list.slice(0, top).map((segment) => shape(segment, 0, []));

  const docs = list.map((segment) => tokenize(segment.text));
  const lengths = docs.map((doc) => doc.length);
  const totalLength = lengths.reduce((sum, value) => sum + value, 0);
  const avgdl = totalLength === 0 ? 1 : totalLength / lengths.length;
  const df = new Map();
  for (const doc of docs) {
    for (const token of new Set(doc)) df.set(token, (df.get(token) || 0) + 1);
  }
  const N = docs.length;

  const scored = [];
  docs.forEach((doc, index) => {
    const freq = new Map();
    for (const token of doc) freq.set(token, (freq.get(token) || 0) + 1);
    let score = 0;
    const hits = [];
    for (const query of queryTokens) {
      const f = freq.get(query);
      if (f === undefined) continue;
      const dfq = df.get(query) || 1;
      const idf = Math.log(1 + (N - dfq + 0.5) / (dfq + 0.5));
      const length = lengths[index] === 0 ? 1 : lengths[index];
      const tf = (f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + BM25_B * (length / avgdl)));
      score += idf * tf * tokenWeight(query);
      hits.push(query);
    }
    if (score > 0) scored.push(shape(list[index], score, hits));
  });

  scored.sort((a, b) => (b.score - a.score) || (a.idx - b.idx));
  return scored.slice(0, top);
}

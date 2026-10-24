/**
 * dsh-session-memory · 词法通道（v2.12 新增）
 *
 * 补的缺口：向量只认「意思像」，对**字面**很钝 —— 版本号、端口、路径、命令名
 * 这类东西在 512 维里几乎重合（全库两两余弦中位 0.658，正确项与干扰项差 0.01）。
 * 而中文 BM25 恰好相反：它对「v2.7.0」和「v2.5.0」的差别一清二楚。
 *
 * 所以这一层不替换向量，只做**第二路召回**，用 RRF 把两路的排名融合。
 * RRF（Reciprocal Rank Fusion）的好处是不用把两种量纲硬凑到一个分数上 ——
 * 余弦是 0~1 的相似度，BM25 是无上界的词频分，直接加权必然一方被另一方吃掉。
 * 融合只看名次：`score = Σ 1/(k + rank)`，k 取 60（原论文的经验值）。
 *
 * 诊断实测（记忆检索精度/诊断与方案.md）：只加这一路，MRR 0.509 → 0.717。
 *
 * 本文件不 import 任何包，可脱离 DSH 进程直接单测：node tests/lexical.test.mjs
 */

/** BM25 的两个经验参数：k1 控制词频饱和，b 控制文档长度归一。 */
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

/** RRF 的平滑常数。越大越平（各名次差距越小），60 是原论文取值。 */
export const RRF_K = 60;

/** 单条文本最多取多少个词元（防止超长记忆把索引撑爆）。 */
const MAX_TOKENS = 4000;

const ASCII_RE = /[A-Za-z0-9_][A-Za-z0-9_\-./\\:]*/g;
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]+/g;

/**
 * 分词：ASCII 词元（小写）+ 中文 bigram。
 *
 * 中文不切词、只做 bigram，理由跟 lib/segments.js 一样：零依赖、确定性、
 * 对「版本号 / 路径 / 常量名」这种混排文本特别稳 —— 不需要词典，也不会切错。
 * bigram 的高频噪声（「的了」「是在」）交给 IDF 自然压下去，不额外维护停用表。
 *
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  const source = String(text === undefined || text === null ? "" : text);
  if (source === "") return [];
  const out = [];
  ASCII_RE.lastIndex = 0;
  let m = ASCII_RE.exec(source);
  while (m !== null && out.length < MAX_TOKENS) {
    out.push(m[0].toLowerCase());
    m = ASCII_RE.exec(source);
  }
  CJK_RE.lastIndex = 0;
  m = CJK_RE.exec(source);
  while (m !== null && out.length < MAX_TOKENS) {
    const run = m[0];
    if (run.length === 1) out.push(run);
    else for (let i = 0; i + 1 < run.length; i += 1) out.push(run.slice(i, i + 2));
    m = CJK_RE.exec(source);
  }
  return out;
}

/**
 * 建索引。返回纯数据，调用方可以缓存（同一批文档重复查时不必重建）。
 *
 * @param {string[]} texts 每个文档的文本，顺序即 docId
 * @returns {{tf:Map<string,number>[], len:number[], df:Map<string,number>, avgLen:number, n:number}}
 */
export function buildIndex(texts) {
  const list = Array.isArray(texts) ? texts : [];
  const tf = [];
  const len = [];
  const df = new Map();
  let total = 0;
  for (const text of list) {
    const tokens = tokenize(text);
    const bag = new Map();
    for (const token of tokens) bag.set(token, (bag.get(token) || 0) + 1);
    tf.push(bag);
    len.push(tokens.length);
    total += tokens.length;
    for (const token of bag.keys()) df.set(token, (df.get(token) || 0) + 1);
  }
  return { tf, len, df, avgLen: list.length === 0 ? 0 : total / list.length, n: list.length };
}

/**
 * 一条 query 对全部文档的 BM25 分。
 *
 * @param {{tf:Map<string,number>[], len:number[], df:Map<string,number>, avgLen:number, n:number}|null} index buildIndex 的结果
 * @param {string} query
 * @returns {number[]} 与文档顺序对齐
 */
export function scoreAll(index, query) {
  const n = index === null || typeof index !== "object" ? 0 : index.n || 0;
  const out = new Array(n).fill(0);
  if (n === 0) return out;
  const qTokens = [...new Set(tokenize(query))];
  if (qTokens.length === 0) return out;
  const avgLen = index.avgLen > 0 ? index.avgLen : 1;
  for (const token of qTokens) {
    const df = index.df.get(token) || 0;
    if (df === 0) continue;
    // 标准 BM25 的 IDF（带 +0.5 平滑）。词在超过一半文档里出现时 idf 会转负，
    // 那是「这个词没有判别力」的正确表达，压到一个小正数兜底即可。
    const idf = Math.max(0.05, Math.log(1 + (n - df + 0.5) / (df + 0.5)));
    for (let i = 0; i < n; i += 1) {
      const f = index.tf[i].get(token);
      if (f === undefined) continue;
      const norm = 1 - BM25_B + BM25_B * (index.len[i] / avgLen);
      out[i] += idf * ((f * (BM25_K1 + 1)) / (f + BM25_K1 * norm));
    }
  }
  return out;
}

/**
 * 把分数数组转成「名次数组」（1 起，并列按原顺序）。
 *
 * @param {number[]} scores
 * @returns {number[]} 与输入对齐的名次
 */
export function rankOf(scores) {
  const list = Array.isArray(scores) ? scores : [];
  const order = list.map((score, i) => ({ i, score: Number.isFinite(score) ? score : 0 }))
    .sort((a, b) => b.score - a.score || a.i - b.i);
  const ranks = new Array(list.length).fill(list.length);
  order.forEach((item, position) => { ranks[item.i] = position + 1; });
  return ranks;
}

/**
 * RRF 融合：给每个 key 一个融合分。
 *
 * @param {Array<Array<{key:string, rank:number}>>} lists 每路一个列表
 * @param {{k?:number}} [options]
 * @returns {Map<string, number>} key → 融合分（越大越靠前）
 */
export function rrfFuse(lists, options = {}) {
  const k = Number.isFinite(options.k) && options.k > 0 ? options.k : RRF_K;
  const out = new Map();
  const source = Array.isArray(lists) ? lists : [];
  for (const list of source) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (item === null || typeof item !== "object" || typeof item.key !== "string" || item.key === "") continue;
      const rank = Number.isFinite(item.rank) && item.rank > 0 ? item.rank : list.length;
      out.set(item.key, (out.get(item.key) || 0) + 1 / (k + rank));
    }
  }
  return out;
}

/**
 * 融合分归一化到 0~1（除以理论上限）。
 *
 * 两路融合的上限是 2/(k+1)。调用方拿到 0~1 之后自己乘一个「最大加分」，
 * 于是「词法命中」这件事能翻译成**余弦量级**的一点点加成，
 * 不会破坏 filterHits 那套绝对阈值（0.45 底线 / 0.88 ratio）。
 *
 * @param {number} fused
 * @param {number} lanes 参与融合的路数
 * @param {{k?:number}} [options]
 * @returns {number} 0~1
 */
export function normalizeFused(fused, lanes, options = {}) {
  const k = Number.isFinite(options.k) && options.k > 0 ? options.k : RRF_K;
  const count = Number.isFinite(lanes) && lanes > 0 ? lanes : 1;
  const ceiling = count / (k + 1);
  const value = Number.isFinite(fused) ? fused : 0;
  if (ceiling <= 0) return 0;
  return Math.max(0, Math.min(1, value / ceiling));
}

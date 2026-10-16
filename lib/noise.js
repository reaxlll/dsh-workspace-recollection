/**
 * 检索噪音过滤 —— 纯函数、零依赖，能脱离 DSH 进程直接用 node 单测。
 *
 * 背景：memory_recall 原本是「排序后 top-K 截断」，没有任何过滤。
 * 大批历史会话存档进来之后，无关条目照样挤进前几名 ——
 * bge-small-zh 的相似度整体偏高（无关条目也能到 0.5+），**绝对阈值不可信**，
 * 单一分数也切不干净（实测：同主题查询里，无关条目的分甚至高于相关条目）。
 *
 * 所以这里用四路信号，优先级从硬到软：
 *   ① 绝对底线：top1 都低于门槛 → 这条查询根本没有明显相关的记忆；
 *   ② 关键词硬特征：query 里的专有名词 / ASCII 词 / emoji 在**要点或标签**里一个都没命中 → 判为噪音
 *      （跨主题的噪音靠这个切，它在分数上往往看不出来）；
 *   ③ 相对比值：低于 top1 的固定比例、且绝对差也够大 → 判为长尾（硬特征命中的可豁免）；
 *   ④ 平局：前四条挤在极小跨度里 → 没有谁真正胜出，只留前三条，别回一屏噪音。
 *
 * 取舍：宁可把可疑的丢进 dropped（一行 id + 分数，随时可复查），
 * 也不让它冒充「相关结果」占用注意力 —— 但永不静默丢弃。
 */

/** top1 低于这个分数 → 认为「没有明显相关的记忆」。实测纯噪音查询的 top1 落在 0.40 附近。 */
export const NOISE_ABS_FLOOR = 0.45;
/** strict 模式下的绝对底线。 */
export const NOISE_STRICT_FLOOR = 0.55;
/** 低于 top1 的这个倍数（且同时满足间隙条件）→ 长尾噪音。 */
export const NOISE_RATIO = 0.88;
/** strict 模式的比值。 */
export const NOISE_STRICT_RATIO = 0.92;
/** 绝对差不够大就不算长尾 —— 分数密集时（同主题多条）宁可多留。 */
export const NOISE_GAP = 0.08;
/** 离 top1 这么远的，关键词再对得上也判长尾（相关性终究要看分数）。 */
export const NOISE_HARD_LOW = 0.75;
/** 头部这么小的跨度内挤了 4 条以上 → 说明没有谁真正胜出，只留前几条。 */
export const NOISE_FLAT_SPREAD = 0.05;
/** 平局时保留的条数。 */
export const NOISE_FLAT_KEEP = 3;

export const NOISE_MODES = ["auto", "strict", "off"];

/** ASCII 词元（路径 / 命令 / 常量名 / 专有名词）：至少以字母开头，长度 >= 2。 */
const HARD_ASCII_RE = /[A-Za-z][A-Za-z0-9_\-./\\:]*/g;
/** emoji（不依赖 \p{...} 属性转义，避免解析器差异）。 */
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu;

/**
 * 从 query 里挑出「硬特征词」：专有名词 / 路径 / 命令 / 常量名 / emoji。
 * 纯中文泛指词（「上次说的那个坑」）不算 —— 那正是语义检索该干的活。
 */
export function hardTokensOf(query) {
  const source = typeof query === "string" ? query : "";
  const out = [];
  const seen = new Set();
  const push = (token) => {
    const key = token.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(token);
  };
  for (const match of source.matchAll(HARD_ASCII_RE)) {
    const raw = match[0].replace(/[._\-:/\\]+$/, "");
    if (raw.length >= 2) push(raw);
  }
  for (const match of source.matchAll(EMOJI_RE)) {
    if (match[0].trim() !== "") push(match[0]);
  }
  return out.slice(0, 12);
}

/**
 * 硬特征命中数。
 *
 * **只查要点 + 标签，不查正文** —— 实测的教训：一条两万字的历史会话正文里
 * 随便提过一句「PowerShell」就判为命中，于是「配置 Claude Code 换 MiMo」这种
 * 明显跑题的条目被留了下来。要点是这条记忆自己的墓志铭，才是「这条讲什么」的最强信号。
 */
export function hardHitCount(entry, hardTokens) {
  if (hardTokens.length === 0) return 0;
  const bucket = entry !== null && typeof entry === "object" ? entry : {};
  const summary = typeof bucket.summary === "string" ? bucket.summary : "";
  const tags = Array.isArray(bucket.tags) ? bucket.tags.join(" ") : "";
  const hay = (summary + " " + tags).toLowerCase();
  let hits = 0;
  for (const token of hardTokens) {
    if (hay.includes(token.toLowerCase())) hits += 1;
  }
  return hits;
}

function shape(row, reason) {
  const entry = row !== null && typeof row === "object" && row.entry !== null && typeof row.entry === "object" ? row.entry : {};
  return {
    id: typeof entry.id === "string" ? entry.id : "",
    score: Number.isFinite(row?.score) ? row.score : 0,
    reason: reason,
  };
}

/**
 * 过滤浅层命中的行。
 *
 * @param {Array<{entry:{id:string, summary?:string, tags?:string[], text?:string}, score:number, layer:string}>} rows
 * @param {string} query
 * @param {{mode?:string, minScore?:number}} [options]
 * @returns {{kept:Array, dropped:Array<{id:string,score:number,reason:string}>, notes:string[], mode:string}}
 *   mode: auto | strict | off
 *   reason: weak(整体太弱) | nokey(硬特征对不上) | low(长尾低分)
 */
export function filterHits(rows, query, options = {}) {
  const list = Array.isArray(rows) ? rows.filter((row) => row !== null && row !== undefined && Number.isFinite(row.score)) : [];
  const requested = options !== null && typeof options === "object" ? options.mode : undefined;
  const mode = requested === "strict" ? "strict" : requested === "off" ? "off" : "auto";
  const minScore = Number.isFinite(options?.minScore) ? options.minScore : null;
  const sorted = [...list].sort((a, b) => b.score - a.score);

  if (sorted.length === 0) return { kept: [], dropped: [], notes: [], mode };
  if (mode === "off" && minScore === null) return { kept: sorted, dropped: [], notes: [], mode };

  const top1 = sorted[0].score;
  const floor = mode === "strict" ? NOISE_STRICT_FLOOR : NOISE_ABS_FLOOR;
  const ratio = mode === "strict" ? NOISE_STRICT_RATIO : NOISE_RATIO;
  const hard = hardTokensOf(query);

  // ① 绝对底线：连最高的都够不着门槛 —— 这条查询没有明显相关的记忆。
  if (minScore === null && top1 < floor) {
    return {
      kept: [],
      dropped: sorted.map((row) => shape(row, "weak")),
      notes: [
        "整体相似度都低于 " + floor.toFixed(2) + "（最高才 " + top1.toFixed(3) + "）：本工作区没有明显相关的记忆。" +
        "换个说法再查一次；如果确认该记而没记，说明当时没写进记忆。",
      ],
      mode: mode,
    };
  }

  const kept = [];
  const dropped = [];
  // nokey 是「分数多高都不留」的硬切，误杀代价大 —— 只在 query 给出**两个以上**硬特征时才启用。
  // 实测：单个硬特征（如「emoji」）会误杀真正相关的条目（它讲了这件事，只是没写那个词）。
  const nokeyArmed = hard.length >= (mode === "strict" ? 1 : 2);
  for (const row of sorted) {
    const hits = hard.length === 0 ? 0 : hardHitCount(row.entry, hard);
    let reason = null;
    if (minScore !== null && row.score < minScore) reason = "low";
    // ② 硬特征：查要点+标签，一个都命中不了 = 跨主题噪音。
    else if (nokeyArmed && hits === 0) reason = "nokey";
    // ③ 太远的长尾：关键词对上也救不回。
    else if (row.score < top1 * NOISE_HARD_LOW) reason = "low";
    // ④ 硬特征命中 = 主题确实对上号了，长尾规则放它一马（实测能救回「TTS」类真相关条目）。
    else if (hits > 0) reason = null;
    // ⑤ 普通长尾：既低于 top1 的比例线，绝对差也够大。
    else if (row.score < top1 * ratio && top1 - row.score > NOISE_GAP) reason = "low";
    if (reason === null) kept.push(row);
    else dropped.push(shape(row, reason));
  }

  // 全被筛掉时至少留下第一名 —— 但它是「勉强留下」，note 里必须讲清楚，别让它冒充相关结果。
  let rescuedId = "";
  if (kept.length === 0 && sorted.length > 0) {
    const topId = typeof sorted[0].entry?.id === "string" ? sorted[0].entry.id : "";
    const index = dropped.findIndex((item) => item.id === topId && item.reason === "nokey");
    if (index >= 0) {
      dropped.splice(index, 1);
      kept.push(sorted[0]);
      rescuedId = topId;
    }
  }

  const notes = [];
  const nokey = dropped.filter((item) => item.reason === "nokey").length;
  const low = dropped.filter((item) => item.reason === "low").length;
  if (nokey > 0) notes.push(nokey + " 条分数不低、但关键词「" + hard.slice(0, 4).join("、") + "」一个都对不上，已略去。");
  if (low > 0) notes.push(low + " 条分数明显低于首条，已略去。");
  if (rescuedId !== "") {
    notes.push("只有 " + rescuedId + " 勉强留下（关键词对不上，可能也不相关）。");
  }

  // ④ 平局：前四条挤在极小跨度里 —— 没有谁是「找到了」，与其回一屏噪音不如只留前三条。
  // 实测：这种时刻排在后面的往往正是跑题的（同主题语料里的相近噪声，如 VPS 查询里的 VMware 条）。
  let flatSpread = null;
  if (minScore === null && kept.length > NOISE_FLAT_KEEP) {
    const spread = kept[0].score - kept[NOISE_FLAT_KEEP].score;
    if (spread < NOISE_FLAT_SPREAD) {
      flatSpread = spread;
      const overflow = kept.splice(NOISE_FLAT_KEEP);
      for (const row of overflow) dropped.push(shape(row, "flat"));
    }
  }
  if (flatSpread !== null) {
    notes.push("前几条分数几乎持平（跨度 " + flatSpread.toFixed(3) + "）、没有谁明显胜出，只留了前 " +
      NOISE_FLAT_KEEP + " 条 —— 这可能意味着你要找的东西没记过，或换个更具体的说法再查。");
  }

  return { kept, dropped, notes, mode };
}

/* ─────────────────── 排序分层：深层独占的资格门（v2.5） ─────────────────── */

/**
 * 要点层的绝对门。深层独占的条目，要点分低于它、又没有别的证据时，不承认深层分。
 *
 * 实测依据（190 条真实记忆 × 6 条查询回放，2026-10-15）：
 *   - 无区分度的中文查询（「10月6日 提问 做了什么」）：三条跑题条目靠正文块零散撞词
 *     把深层分刷到 0.548 / 0.539 / 0.532，而它们的要点分只有 0.418 / 0.369 / 0.324；
 *   - 真相关条目的要点分普遍 ≥ 0.56（实测 0.689 / 0.671 / 0.664），
 *     0.46~0.56 是一条宽安全带。取 0.45 与 NOISE_ABS_FLOOR 对齐（同一个语义：
 *     「连绝对底线都够不着 = 这条在要点层没有落点」）。
 */
export const DEEP_GATE = 0.45;

/**
 * 引索二级验证的实词门槛：引索命中词里，至少要有一个的文档频率 ≤ 它。
 *
 * 为什么必须限 DF：中文 bigram 的泛词命中毫无区分度 ——「什么」DF=98、「日」DF=60、
 * 「10」DF=122。按「命中 ≥2 词」当判据时，8 条跑题条目有 7 条通过，等于没验。
 * 限到 DF ≤ 15 之后：跑题组 0/8 通过，真相关组（TTS / ffplay）6/6 通过。
 * 实测 K=10~20 结果完全相同，K=30 开始放水，取中间值。
 */
export const INDEX_DF_MAX = 15;

/**
 * 引索二级验证：命中词里有没有「实词」（文档频率够低的词）。
 *
 * @param {string[]} hitWords  引索（段级 BM25）命中的词
 * @param {(word:string)=>number} dfOf  取文档频率（词出现在全库多少条正文里）
 * @param {number} [maxDf]
 * @returns {boolean}
 */
export function rareHitOk(hitWords, dfOf, maxDf = INDEX_DF_MAX) {
  if (!Array.isArray(hitWords) || hitWords.length === 0) return false;
  if (typeof dfOf !== "function") return false;
  for (const word of hitWords) {
    const df = dfOf(word);
    if (Number.isFinite(df) && df <= maxDf) return true;
  }
  return false;
}

/**
 * 分层打分：浅层赢就用浅层；**深层赢要有资格**。
 *
 * 资格三条，任一成立即可：
 *   ① `hardHits > 0`         —— query 的专有名词/ASCII 词在要点或标签里命中（最硬的证据）
 *   ② `shallow >= DEEP_GATE` —— 要点层本身也够近，深层分只是锦上添花
 *   ③ `indexOk === true`     —— 段级引索能在这条正文里定位到含实词的段（词面复核通过）
 *
 * 三条都不成立的深层独占条目 → `demoted`：**退回浅层分参与排序**。
 * 它不会被丢弃（仍可能进结果），但不会再用「正文块撞出来的高分」冒充相关。
 *
 * @param {number|null} shallowScore
 * @param {number|null} deepScore
 * @param {number} hardHits
 * @param {boolean|null} [indexOk]  引索二级验证结果；null = 未验证/不适用
 * @returns {{score:number, layer:"shallow"|"deep"|"demoted"}}
 */
export function scoreEntry(shallowScore, deepScore, hardHits, indexOk = null) {
  const shallowWins = shallowScore !== null && (deepScore === null || shallowScore >= deepScore);
  if (shallowWins) return { score: shallowScore, layer: "shallow" };
  // 浅层向量还没算出来（刚写入、总结队列没跑完）：无分可降，别误伤。
  if (shallowScore === null) return { score: deepScore, layer: "deep" };
  const qualified =
    (Number.isFinite(hardHits) && hardHits > 0) ||
    shallowScore >= DEEP_GATE ||
    indexOk === true;
  if (qualified) return { score: deepScore, layer: "deep" };
  return { score: shallowScore, layer: "demoted" };
}

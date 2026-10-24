/**
 * 检索噪音过滤 —— 纯函数、零依赖，能脱离 DSH 进程直接用 node 单测。
 *
 * 背景：memory_recall 原本是「排序后 top-K 截断」，没有任何过滤。
 * 批量导入的历史会话（160+ 条）进来之后，无关条目照样挤进前几名 ——
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

/**
 * 中文实词的文档频率门槛（**要点 + 标签**口径）。
 *
 * 为什么中文实词要单独一套：ASCII 硬特征（路径/命令/常量名）只覆盖技术串，
 * 而用户绝大多数提问是纯中文（「托盘重启补丁 怎么重打」）—— 这类查询在 v2.5 里
 * `hardTokensOf` 返回空数组，于是 `nokeyArmed` 永远为 false、**硬切一次都没执行过**。
 * 实测（207 条真实记忆，2026-10-18）：加上中文实词后，「托盘重启补丁」抽到
 * 托盘(DF1)/重启(DF10)/补丁(DF4)，「窗口大小位置 记忆 补丁」抽到 窗口(DF3)/位置(DF5)/补丁(DF4)。
 *
 * 口径为什么必须用**要点**而不是正文：正文里的跨词 bigram 会碰上偶然组合 ——
 * 「个函」DF=2、「口大」DF=3、「击后」DF=3，判成实词会把候选全切光（误杀）。
 * 要点是精炼句，跨词垃圾词的 DF 全是 0，天然被下面「DF ≥ 1」这条挡掉。
 */
export const CN_DF_MAX = 15;

/**
 * 「这条查询到底指不指得动记忆」——无判别力时的容差。
 *
 * 实测（同上）：完全泛指的查询里，最高分也就在 0.59~0.66，且前几名几乎贴在一起
 * （空隙 0.010 / 0.019 / 0.026）。所以只有「分数够高且明显胜出」的那一条才配留下。
 */
export const NOISE_LEAD_SCORE = 0.6;
export const NOISE_LEAD_GAP = 0.04;

/**
 * 同主题判定：候选与首条的**要点向量**余弦相似度不低于它，就算「兄弟条目」。
 *
 * 实测分布（2026-10-18）：
 *   「记忆插件 噪音过滤 阈值」的真兄弟（v2.1/2.3/2.5）= 0.814 / 0.816 / 0.825；
 *   而同一次查询里跑题的条目 = 0.679 / 0.718 / 0.766；
 *   「帮我看一下这个函数为什么报错」这种无判别力查询里，所有候选都 ≤ 0.781。
 * 0.80 落在两条分布之间的空档上：真兄弟过、跑题团伙不过。
 */
export const SIBLING_COS = 0.8;

export const NOISE_MODES = ["auto", "strict", "off"];

/**
 * 「这个对象从没被记过」的判据（v2.14）。
 *
 * 现象：问一件库里根本没有的事（「上次那个 frp 穿透的端口填多少来着」），
 * 插件照样能返回三条「看着挺像」的记忆 —— 因为向量总能找到语义邻居。
 * 实测 2026-10-24：10 条无答案 query 里 7 条在硬凑，top1 分数 0.54~0.73，
 * 跟真有答案的那批（0.62~0.93）完全重叠，**光看分数切不开**。
 *
 * 能切开的是另一个信号：query 里的**具体对象名**在记忆正文里一次都没出现过。
 * 「frp」「Dockerfile」「k8s」「kubeconfig」「JWT」—— 一个都没在库里露过面，
 * 说明这件事从来没被记下来，那就不该拿「技术相关」的记忆去凑。
 *
 * 实测区分度（50 条 query）：40 条有答案的 query 里**没有任何一条**带这种词，
 * 10 条无答案的里有 5 条带 —— 零误杀。
 *
 * 另外配一道分数闸（ABSENT_TOP1_MAX）：带 URL 的 query 会被拆出 topics 这种
 * 库里没有的词，但它们往往 top1 很高（0.925），加这道闸就不会被误判。
 */
export const ABSENT_WORD_MIN = 3;
export const ABSENT_TOP1_MAX = 0.75;
/** URL 协议头这类词没有判别力，别拿它判「没记过」。 */
const ABSENT_IGNORE = new Set(["www", "http", "https", "ftp", "com", "org", "io", "net"]);

/**
 * 提取 query 里「长度够、像专名」的 ASCII 词（去重、小写比较）。
 * @param {string} query
 * @returns {string[]}
 */
export function queryAsciiWords(query) {
  // URL 整个剥掉：它会被拆成 github / com / topics 这种碎片，全都不适合做「没记过」的证据。
  const source = typeof query === "string" ? query.replace(/https?:\/\/\S+/gi, " ") : "";
  const out = [];
  const seen = new Set();
  HARD_ASCII_RE.lastIndex = 0;
  let m = HARD_ASCII_RE.exec(source);
  while (m !== null) {
    const raw = m[0].replace(/[./\\:]+$/, "");
    const key = raw.toLowerCase();
    if (raw.length >= ABSENT_WORD_MIN && !ABSENT_IGNORE.has(key) && !seen.has(key)) {
      seen.add(key);
      out.push(raw);
    }
    m = HARD_ASCII_RE.exec(source);
  }
  HARD_ASCII_RE.lastIndex = 0;
  return out;
}

/**
 * 这些词里，哪些在全部记忆文本里一次都没出现过。
 *
 * @param {string[]} words queryAsciiWords 的结果
 * @param {string[]} haystacks 每条记忆的检索文本
 * @returns {string[]} 从未出现过的词（原大小写）
 */
export function absentWords(words, haystacks) {
  const list = Array.isArray(words) ? words : [];
  const hay = (Array.isArray(haystacks) ? haystacks : []).map((text) => String(text).toLowerCase());
  if (list.length === 0 || hay.length === 0) return [];
  return list.filter((word) => {
    const needle = String(word).toLowerCase();
    return needle !== "" && hay.every((text) => text.includes(needle) === false);
  });
}

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

/** 取查询里连续汉字串的所有相邻二字组合（与段级引索同一套 bigram 口径）。 */
export function cnBigramsOf(query) {
  const out = [];
  const seen = new Set();
  const source = typeof query === "string" ? query : "";
  for (const run of source.matchAll(/[\u4e00-\u9fff]+/g)) {
    const text = run[0];
    if (text.length < 2) continue;
    for (let i = 0; i + 2 <= text.length; i += 1) {
      const gram = text.slice(i, i + 2);
      if (seen.has(gram)) continue;
      seen.add(gram);
      out.push(gram);
    }
  }
  return out;
}

/**
 * query 里「能指认记忆」的中文实词：要点或标签里命中条数在 1..maxDf 之间。
 *
 * 两头都要卡，缺一头就会翻车：
 *  - **DF = 0 必须丢**：库里没有这个词，它既命中不了任何条目，又会把 nokey 变成
 *    「把所有条目都判成对不上」——跨词 bigram（「个函」「口大」「小位」）正是这种。
 *  - **DF > maxDf 必须丢**：泛词没有区分度（「什么」DF=100、「记忆」DF=40、「插件」DF=34）。
 *
 * @param {string} query
 * @param {(word:string)=>number} dfOf  要点+标签口径的文档频率
 * @param {number} [maxDf]
 * @param {number} [max]  最多取几个（越多越容易误伤，实测 8 够用）
 * @returns {string[]}
 */
export function cnHardTokensOf(query, dfOf, maxDf = CN_DF_MAX, max = 8) {
  if (typeof dfOf !== "function") return [];
  const out = [];
  for (const gram of cnBigramsOf(query)) {
    const df = dfOf(gram);
    if (!Number.isFinite(df) || df < 1 || df > maxDf) continue;
    out.push(gram);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 硬特征命中数。
 *
 * **只查要点 + 标签，不查正文** —— 实测的教训：一条两万字的导入会话正文里
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
 * @param {Array<{entry:{id:string, summary?:string, tags?:string[], text?:string}, score:number, layer:string, sibling?:boolean}>} rows
 * @param {string} query
 * @param {{mode?:string, minScore?:number, discriminating?:boolean}} [options]
 *   discriminating：调用方对「这条查询里有没有能指认记忆的具体词」的判断。
 *     false → 允许直接判空（泛查询不该硬凑结果）；true / 省略 → 不做这道判断。
 * @returns {{kept:Array, dropped:Array<{id:string,score:number,reason:string}>, notes:string[], mode:string}}
 *   mode: auto | strict | off
 *   reason: weak(整体太弱) | indistinct(查询没有判别力) | nokey(硬特征对不上) | low(长尾低分) | flat(平局溢出)
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
  // 硬特征：调用方可以传「ASCII 词 + 中文实词」的合并集（插件里就是这么传的，见 cnHardTokensOf）；
  // 没传就退回只认 ASCII/emoji 的老口径 —— 旧调用方与单测的行为保持不变。
  // 硬切仍然只认 ASCII/emoji（专名 / 路径 / 命令）。
  // 实测（2026-10-18）把中文实词也塞进硬切是错的：「窗口大小位置 记忆 补丁」里「补丁」DF=4
  // 看着很稀有，命中的却是「骑砍DLC补丁 / 汉化补丁」—— 字面撞上、语义无关，结果从 3 条涨到 11 条跑题。
  const hard = hardTokensOf(query);
  // 中文实词只用来回答一个 yes/no：这条查询到底有没有「能指认记忆」的词。见下面 ①.5。
  const discriminating = options !== null && typeof options === "object" ? options.discriminating : undefined;

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

  // ①.5 可判别性：query 里一个「能指认记忆」的词都没有（纯泛指）→ 只承认明显胜出的那一条。
  //     实测：这类查询里最高分只有 0.59~0.66，且前几名的空隙都在 0.03 以内 ——
  //     与其回三条互相矛盾的猜测，不如老实说「没找到」。
  //     这道门只对「调用方已经做过完整判断」的场景启用（discriminating === false）；
  //     没传时保持旧行为 —— 光看 ASCII 词就判中文查询「无判别力」必然大面积误杀。
  if (minScore === null && discriminating === false) {
    const leader = sorted[0];
    const runnerUp = sorted[1];
    const lead = runnerUp === undefined ? 1 : leader.score - runnerUp.score;
    if (leader.score < NOISE_LEAD_SCORE || lead < NOISE_LEAD_GAP) {
      return {
        kept: [],
        dropped: sorted.map((row) => shape(row, "indistinct")),
        notes: [
          "「" + String(query).slice(0, 40) + "」里没有能指认具体记忆的词（既没有路径/命令/专名，也没有低频中文词），" +
          "前几名分数又贴得很近（最高 " + top1.toFixed(3) + "，与第二名差 " + lead.toFixed(3) + "）——" +
          "这不算「找到」，更可能是没记过。换成带专有名词的说法再试（文件名 / 命令 / 版本号 / 具体症状）。",
        ],
        mode: mode,
      };
    }
  }

  const kept = [];
  const dropped = [];
  let siblingKept = 0;
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
    // ④.5 同主题兄弟：与首条的要点向量高度相似（sibling 由调用方按 SIBLING_COS 标好）→ 不按长尾切。
    //      实测：「记忆插件 噪音过滤 阈值」曾只留 1 条，把 v2.3.0 / v2.5.0 全判成长尾；
    //      而它们与首条的要点相似度是 0.814 / 0.816 / 0.825 —— 明明是一个主题的不同版本。
    else if (row.sibling === true) reason = null;
    // ⑤ 普通长尾：既低于 top1 的比例线，绝对差也够大。
    else if (row.score < top1 * ratio && top1 - row.score > NOISE_GAP) reason = "low";
    if (reason === null) {
      kept.push(row);
      if (row.sibling === true) siblingKept += 1;
    } else dropped.push(shape(row, reason));
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
  if (nokey > 0) {
    const words = hard.slice(0, 4).join("、");
    notes.push(nokey + " 条分数不低、但关键词" + (words === "" ? "" : "「" + words + "」") + "一个都对不上，已略去。");
  }
  if (low > 0) notes.push(low + " 条分数明显低于首条，已略去。");
  if (siblingKept > 1) notes.push("其中 " + siblingKept + " 条与首条属于同一主题（要点向量高度接近），已一并保留。");
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
      for (const row of overflow) {
        // 同主题兄弟不按平局切：它们的分数贴近首条不是「没有谁胜出」，而是「本来就是同一件事」。
        // 实测：「跨会话记忆 recall 命中率」整个 v2.x 系列就靠这条活下来。
        if (row.sibling === true) kept.push(row);
        else dropped.push(shape(row, "flat"));
      }
      kept.sort((a, b) => b.score - a.score);
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
 *   - 真相关条目的要点分普遍 ≥ 0.56（历史导入 0.689 / emoji 0.671 / TTS 0.664），
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

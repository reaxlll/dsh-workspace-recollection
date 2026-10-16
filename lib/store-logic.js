/**
 * 存储层的纯逻辑 —— 从 `MemoryStore` 里抽出来的部分：零依赖、可直接单测。
 *
 * 为什么值得单独一个文件：这几个函数都很短，但出错代价很大，而且**不会报错** ——
 *   · trim 把置顶条目挤掉      → 用户最在乎的那条悄悄没了
 *   · 批量删除误删 locked 条目 → 上锁保护失效
 *   · 排序把新旧顺序弄反       → 注入进 prompt 的是过时的那条
 * 都属于「跑起来一切正常、数据被慢慢弄乱」的类型，只能靠逐条钉死来防。
 *
 * 从 index.js 拆出来还有个附带好处：这些逻辑与 DSH 运行时无关，
 * 不需要假 ctx 就能测，所以能进 CI（既有的端到端脚本只能在有内核的机器上跑）。
 */

/** 更新时间戳（取不到就当作最旧）。 */
function timeOf(entry) {
  return entry !== null && typeof entry === "object" && typeof entry.updatedAt === "string" ? entry.updatedAt : "";
}

function isPinned(entry) {
  return entry !== null && typeof entry === "object" && entry.pinned === true;
}

/**
 * 排序：置顶优先，同组内按更新时间。
 *
 * @param {Array} entries
 * @param {{pinnedFirst?:boolean, newestFirst?:boolean}} [options]
 *   两个开关都默认为 true（置顶在前、新的在前）—— 这是「给 prompt 看」的顺序。
 *   都传 false 则反过来（置顶在后、旧的在前），用于 trim 这种「从尾部丢弃」的场景。
 * @returns {Array} 新数组；入参不动
 */
export function sortEntries(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const pinnedFirst = options.pinnedFirst !== false;
  const newestFirst = options.newestFirst !== false;
  return [...list].sort((a, b) => {
    const ap = isPinned(a);
    const bp = isPinned(b);
    if (ap !== bp) return pinnedFirst ? (ap ? -1 : 1) : (ap ? 1 : -1);
    const ta = timeOf(a);
    const tb = timeOf(b);
    if (ta === tb) return 0;
    return newestFirst ? tb.localeCompare(ta) : ta.localeCompare(tb);
  });
}

/**
 * 超限时决定保留哪些条目。
 *
 * 规则：**置顶的一律留下**，剩下的额度按更新时间从新到旧填满。
 * （旧实现是先按「置顶排后 + 旧的在前」排序再 slice 尾部，等价但绕；
 *   这里改成显式规则，测试能直接表达意图。）
 *
 * @param {Array} entries
 * @param {number} max 上限；非法值按 0 处理（即全部丢弃）
 * @returns {{kept:Array, dropped:Array}}
 */
export function trimEntries(entries, max) {
  const list = Array.isArray(entries) ? entries : [];
  const limit = Number.isInteger(max) && max > 0 ? max : 0;
  if (list.length <= limit) return { kept: list, dropped: [] };
  const ranked = sortEntries(list, { pinnedFirst: true, newestFirst: true });
  return { kept: ranked.slice(0, limit), dropped: ranked.slice(limit) };
}

/**
 * 批量删除：命中的才动，`locked` 的留下并**报出来**。
 *
 * 报出被跳过的 id 很重要 —— 静默失败会让用户以为删掉了，其实还在。
 *
 * @param {Array} entries
 * @param {string[]} ids 想删除的条目 id
 * @returns {{removed:string[], skipped:string[], kept:Array}}
 */
export function partitionRemoval(entries, ids) {
  const list = Array.isArray(entries) ? entries : [];
  const wanted = new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === "string" && id !== "") : []);
  const removed = [];
  const skipped = [];
  const kept = [];
  for (const entry of list) {
    const id = entry !== null && typeof entry === "object" && typeof entry.id === "string" ? entry.id : "";
    if (id === "" || !wanted.has(id)) { kept.push(entry); continue; }
    if (entry.locked === true) { skipped.push(id); kept.push(entry); continue; }
    removed.push(id);
  }
  return { removed, skipped, kept };
}

/**
 * 向量库里的孤儿：对应的记忆条目已经不在了（条目被删，但向量还留着）。
 * 行为上无害（检索到最后一步会去 store 找条目，找不到就跳过），但白占体积，
 * 而且会让「删掉的记忆」的 id 还留在检索候选里，容易让人误判。
 *
 * @param {string[]} vectorIds 向量库里实际存在的 id
 * @param {string[]} liveIds   记忆库里还活着的 id
 * @returns {string[]} 该清理的 id
 */
export function orphanVectorIds(vectorIds, liveIds) {
  const live = new Set(Array.isArray(liveIds) ? liveIds.filter((id) => typeof id === "string") : []);
  const list = Array.isArray(vectorIds) ? vectorIds : [];
  return list.filter((id) => typeof id === "string" && id !== "" && !live.has(id));
}

/**
 * 工作区键：把路径归一化成可以当 Map 键 / 文件名的标识。
 *
 * 注意两点：结尾的分隔符要去掉（E:\foo 与 E:\foo\ 必须算同一个工作区）；
 * Windows 的文件系统大小写不敏感，所以键统一转小写 —— 否则 E:\Foo 与 E:\foo 会分裂成两份记忆。
 * 这个函数同时被 store 与 sessions 用，所以放在这里共用。
 */
const CASE_INSENSITIVE_FS = process.platform === "win32";

export function workspaceKey(cwd) {
  if (typeof cwd !== "string") return "";
  let key = cwd.trim().replace(/[\\/]+$/, "");
  if (key === "") return "";
  if (CASE_INSENSITIVE_FS) key = key.toLowerCase();
  return key;
}

/**
 * 整数范围夹取（从 index.js 原样抽出来，好让它有测试）。
 *
 * 注意语义：**非法输入直接返回 fallback，不做夹取** —— 这是原实现的行为，
 * 抽取时保持逐字一致，避免在重构里悄悄改变调用方的默认值语义。
 *
 * @param {any} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback 非法输入（NaN / 无法转成数字）时用这个
 * @returns {number}
 */
export function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

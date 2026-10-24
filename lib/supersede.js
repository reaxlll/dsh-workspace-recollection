/**
 * dsh-session-memory · 覆盖语义（v2.11 新增）
 *
 * 补的缺口：一条事实被新版本覆盖时，我们的旧做法是「再写一条」或「手删旧的」——
 * 前者让两版在检索池里竞争（谁排前面看运气，向量又分不清 v2.5 和 v2.7），
 * 后者丢掉时间线，违背这套记忆「可溯源」的底线。
 *
 * 参考 MemT-1.0 的擦除/写入分离：它用门控把「同一个 key 上先擦后写」变成模型能力，
 * 我们没有训练，但可以把同一件事做成**数据层的显式关系**：
 *   · 新条目声明 supersedes: [旧 id]
 *   · 旧条目落 supersededBy / supersededAt，**不删**
 *   · 检索时旧条目降权并标注「已被 X 取代」，目录里折叠成一行
 * 效果等价于「擦掉」，但可回滚、可审计、能沿着链看版本史。
 *
 * 为什么不是直接删：删了就没法回答「这个结论是哪一版改掉的」。
 * 记忆的价值一半在当前状态，另一半在演化路径。
 *
 * 本文件不 import 任何包，可脱离 DSH 进程直接单测：node tests/supersede.test.mjs
 */

/** 被取代的条目在检索里乘这个系数（不是清零：链头和中间版本仍该能被翻出来）。 */
export const SUPERSEDED_PENALTY = 0.55;

/** 单条记忆最多声明取代多少个（防止一次写入顺手把整库标脏）。 */
export const MAX_SUPERSEDES = 8;

function idOf(entry) {
  return entry !== null && typeof entry === "object" && typeof entry.id === "string" ? entry.id : "";
}

/** 这条记忆是否已被更新的一版取代。 */
export function isSuperseded(entry) {
  return entry !== null && typeof entry === "object" &&
    typeof entry.supersededBy === "string" && entry.supersededBy !== "";
}

/** 检索系数：链尾（当前有效）为 1，被取代的降权。 */
export function validityFactor(entry) {
  return isSuperseded(entry) ? SUPERSEDED_PENALTY : 1;
}

/**
 * 标记覆盖关系。
 *
 * @param {Array} entries 同一个工作区的条目数组（会被就地修改）
 * @param {string} newId 新条目 id
 * @param {string[]} oldIds 被它取代的旧条目 id
 * @param {string} at 时间戳
 * @param {{force?:boolean}} [options] force=true 时允许覆盖掉「已被别的条目取代」的标记
 * @returns {{applied:string[], missing:string[], skipped:Array<{id:string,reason:string}>}}
 */
export function applySupersede(entries, newId, oldIds, at, options = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const result = { applied: [], missing: [], skipped: [] };
  const target = typeof newId === "string" ? newId : "";
  if (target === "") return result;
  const wanted = Array.isArray(oldIds) ? oldIds.filter((id) => typeof id === "string" && id !== "") : [];
  const seen = new Set();
  for (const oldId of wanted) {
    if (seen.has(oldId)) continue;
    seen.add(oldId);
    if (oldId === target) {
      result.skipped.push({ id: oldId, reason: "self" });
      continue;
    }
    const entry = list.find((item) => idOf(item) === oldId);
    if (entry === undefined) {
      result.missing.push(oldId);
      continue;
    }
    if (entry.locked === true) {
      result.skipped.push({ id: oldId, reason: "locked" });
      continue;
    }
    if (isSuperseded(entry) && entry.supersededBy !== target && options.force !== true) {
      // 已经有更新的一版取代了它：默认不动，避免把一条链的指向改乱
      result.skipped.push({ id: oldId, reason: "already-superseded" });
      continue;
    }
    entry.supersededBy = target;
    entry.supersededAt = typeof at === "string" && at !== "" ? at : new Date().toISOString();
    result.applied.push(oldId);
  }
  if (result.applied.length > 0) {
    const fresh = list.find((item) => idOf(item) === target);
    if (fresh !== undefined) {
      const base = Array.isArray(fresh.supersedes) ? fresh.supersedes.slice() : [];
      for (const id of result.applied) if (!base.includes(id)) base.push(id);
      fresh.supersedes = base.slice(0, MAX_SUPERSEDES);
    }
  }
  return result;
}

/**
 * 顺着覆盖链走到最新那一版。
 *
 * 库里理论上不该出现环（只会指向后写的条目），但导入的旧数据 / 手改过的文件
 * 什么都可能有，所以循环上限兜住 —— 记忆检索卡死比返回旧版本糟得多。
 */
export function chainTip(entries, id, maxHop = 32) {
  const list = Array.isArray(entries) ? entries : [];
  const byId = new Map(list.map((entry) => [idOf(entry), entry]));
  let current = byId.get(typeof id === "string" ? id : "");
  if (current === undefined) return null;
  let hop = 0;
  while (hop < maxHop) {
    const next = byId.get(current.supersededBy);
    if (next === undefined) break;
    current = next;
    hop += 1;
  }
  return current;
}

/**
 * 默认视图：去掉已被取代的条目。目录、注入、keywordSearch 都该用它。
 *
 * @param {Array} entries
 * @returns {Array} 新数组
 */
export function liveEntries(entries) {
  const list = Array.isArray(entries) ? entries : [];
  return list.filter((entry) => isSuperseded(entry) === false);
}

/**
 * 一条记忆的版本史（从最初到最新）。只用于展示，不参与排序。
 *
 * @returns {Array} 按链的顺序；找不到就是空数组
 */
export function versionHistory(entries, id) {
  const list = Array.isArray(entries) ? entries : [];
  const byId = new Map(list.map((entry) => [idOf(entry), entry]));
  let current = byId.get(typeof id === "string" ? id : "");
  if (current === undefined) return [];
  // 先沿 supersedes 往回退到链头（「我取代了谁」指向前一版，注意方向别弄反）
  let head = current;
  let backHop = 0;
  while (backHop < 32) {
    const prevId = Array.isArray(head.supersedes) && head.supersedes.length > 0 ? head.supersedes[0] : "";
    const prev = byId.get(prevId);
    if (prev === undefined) break;
    head = prev;
    backHop += 1;
  }
  const out = [head];
  let hop = 0;
  while (hop < 32) {
    const next = byId.get(out[out.length - 1].supersededBy);
    if (next === undefined) break;
    out.push(next);
    hop += 1;
  }
  return out;
}

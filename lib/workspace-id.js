/**
 * dsh-session-memory · 工作区身份（v2.15 新增）
 *
 * 记忆是按**工作区路径**存的（`workspaces[workspaceKey(cwd)]`）。目录一改名，
 * 路径变了，记忆就"消失"了 —— 其实还在库里，只是没人去找它。
 *
 * 这一层给每个工作区算一个**跟路径无关的身份**，目录改名后还能认回来：
 *
 *   强指纹 = git remote URL + package.json 的 name
 *            → 一个仓库搬到哪都是它，改名不可能改变这两个值
 *   弱指纹 = 顶层条目名（排序后取前 30 个）的哈希
 *            → 没有 git 也没有 package.json 的工作区（比如这个插件工作区）只能靠它，
 *              目录结构大改就会漂，所以**只用来提示、不自动认领**
 *
 * 为什么分强弱：自动迁移是在改用户的数据，判错的代价是两条工作区的记忆混在一起。
 * 强指纹相等基本可以确定是同一个仓库；弱指纹相等只能算"可能是"。
 *
 * 本文件不 import 任何包，可脱离 DSH 进程直接单测：node tests/workspace-id.test.mjs
 */

/** 指纹格式版本：以后改算法就让老指纹自然失效（宁可不认领，也不要认错）。 */
export const FINGERPRINT_VERSION = 1;

/** 顶层条目最多取多少个参与弱指纹（太多会让「加了个文件」就漂）。 */
export const TOP_ENTRIES_MAX = 30;

/** FNV-1a 32 位。够用：几百个工作区之间撞 32 位的概率约 1e-5 量级。 */
function fnv1a(text, seed) {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** 两个不同种子拼成 64 位，降低碰撞。 */
export function hashText(text) {
  const source = String(text === undefined || text === null ? "" : text);
  const a = fnv1a(source, 0x811c9dc5).toString(16).padStart(8, "0");
  const b = fnv1a(source, 0x7f4a7c15).toString(16).padStart(8, "0");
  return "v" + String(FINGERPRINT_VERSION) + "-" + a + b;
}

/**
 * 规范化采集到的原始信息（纯函数）。
 *
 * @param {{gitRemote?:string, pkgName?:string, topEntries?:string[]}} raw
 * @returns {{gitRemote:string, pkgName:string, topEntries:string[]}}
 */
export function normalizeParts(raw) {
  const source = raw !== null && typeof raw === "object" ? raw : {};
  const entries = Array.isArray(source.topEntries) ? source.topEntries : [];
  const cleaned = [];
  const seen = new Set();
  for (const item of entries) {
    const name = typeof item === "string" ? item.trim() : "";
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    cleaned.push(name);
    if (cleaned.length >= TOP_ENTRIES_MAX) break;
  }
  cleaned.sort();
  return {
    gitRemote: typeof source.gitRemote === "string" ? source.gitRemote.trim() : "",
    pkgName: typeof source.pkgName === "string" ? source.pkgName.trim() : "",
    topEntries: cleaned,
  };
}

/**
 * 算一组身份标识。
 *
 * @param {{gitRemote?:string, pkgName?:string, topEntries?:string[]}} raw
 * @returns {{strong:string, weak:string, strength:"strong"|"weak"|"none"}}
 *   strong 为空串表示「没有强指纹可算」；strength 决定能不能自动认领
 */
export function identityOf(raw) {
  const parts = normalizeParts(raw);
  const strongSource = [parts.gitRemote, parts.pkgName].filter((part) => part !== "").join("\u0000");
  const weakSource = parts.topEntries.join("\u0000");
  const strong = strongSource === "" ? "" : hashText("strong:" + strongSource);
  const weak = weakSource === "" ? "" : hashText("weak:" + weakSource);
  return {
    strong,
    weak,
    strength: strong !== "" ? "strong" : weak !== "" ? "weak" : "none",
  };
}

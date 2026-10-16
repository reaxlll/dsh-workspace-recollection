/**
 * 存储版本治理 —— 纯函数、零依赖，能脱离 DSH 进程直接用 node 单测。
 *
 * 为什么需要它：`memory.json` / `vectors.json` 里都写着 version，但读入时只做
 * 「字段规范化」，不做版本判断 —— 于是两类事故都没人察觉：
 *
 *   ① **降级即丢数据**：用新版插件写出的数据，再用旧版打开时，新字段会被
 *      `normalize*` 吃掉，下一次写回就永久没了。用户看不到任何提示。
 *   ② **坏文件被当成「没有记忆」**：解析异常被 catch 吞掉，界面显示空的记忆库，
 *      用户以为记忆丢了，其实文件还在磁盘上躺着。
 *
 * 这一层只负责**判断与计划**（纯函数，可单测）；备份、告警、只读保护由调用方执行。
 */

/** 版本关系判定：same / migrate / too-new / unknown。 */
export function decideVersion(diskVersion, currentVersion) {
  if (!Number.isInteger(diskVersion) || diskVersion < 1) return "unknown";
  if (!Number.isInteger(currentVersion) || currentVersion < 1) return "unknown";
  if (diskVersion === currentVersion) return "same";
  return diskVersion < currentVersion ? "migrate" : "too-new";
}

/**
 * 迁移链：`from 版本 → 把该版本数据升一级的函数`。
 *
 * 目前是空的 —— 因为 v3（store）/ v2（vectors）就是当前版本，没有历史数据要搬。
 * 骨架先立在这里的意义：**下一次改数据结构时，只要往表里加一条函数**，
 * 老用户打开插件就会自动升级（而且在升级前已经备份过原文件）。
 */
export const STORE_MIGRATIONS = new Map();
export const VECTOR_MIGRATIONS = new Map();

/**
 * 按链逐级迁移到目标版本。
 *
 * @returns {{ok:true, value:any, from:number, to:number, applied:number[]}
 *          |{ok:false, reason:"missing", from:number, to:number, stuckAt:number, applied:number[]}
 *          |{ok:false, reason:"noop", from:number, to:number}}
 */
export function planMigration(raw, from, to, migrations) {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from >= to) {
    return { ok: false, reason: "noop", from, to };
  }
  const table = migrations instanceof Map ? migrations : new Map();
  let value = raw;
  let version = from;
  const applied = [];
  while (version < to) {
    const step = table.get(version);
    if (typeof step !== "function") {
      return { ok: false, reason: "missing", from, to, stuckAt: version, applied };
    }
    value = step(value);
    version += 1;
    applied.push(version);
  }
  return { ok: true, value, from, to, applied };
}

/**
 * 备份文件名：可排序的 ISO 时间戳（冒号与点换成短横，避开 Windows 不允许的字符）。
 * 前缀带原文件名，便于一眼看出备份的是哪份数据。
 */
export function backupName(base, now) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return String(base) + "." + stamp + ".bak";
}

/**
 * 备份保留策略：名字按字典序 == 时间序，留最新的 keep 份。
 *
 * @returns {string[]} 该删掉的备份名（从旧到新）
 */
export function pickBackupsToKeep(names, keep) {
  const list = Array.isArray(names) ? names.filter((name) => typeof name === "string" && name !== "") : [];
  const sorted = [...list].sort();
  const limit = Number.isInteger(keep) && keep >= 0 ? keep : 0;
  return sorted.slice(0, Math.max(0, sorted.length - limit));
}

/**
 * 一次「读入前」的完整决策 —— 调用方拿到结论后照做即可。
 *
 * @param {any} raw            已解析的数据对象（解析失败时调用方自行处理）
 * @param {number} currentVer  代码期望的版本
 * @param {Map} migrations     对应的迁移链
 * @returns {{verdict:string, value:any, readOnly:boolean, notice:string, migrate:object|null}}
 *   verdict: same | migrate | too-new | unknown
 *   value:   实际要采用的对象（迁移后 / 原样 / 交给 normalize 兜）
 *   readOnly: true 表示「不许写回」，用于防止旧代码写坏新数据
 *   notice:   给用户看的一句话（空串表示无需提示）
 */
export function resolveOnRead(raw, currentVer, migrations, label = "数据") {
  const diskVersion = raw !== null && typeof raw === "object" && Number.isInteger(raw.version) ? raw.version : 0;
  const verdict = decideVersion(diskVersion, currentVer);

  if (verdict === "same") {
    return { verdict, value: raw, readOnly: false, notice: "", migrate: null };
  }

  if (verdict === "migrate") {
    const plan = planMigration(raw, diskVersion, currentVer, migrations);
    if (plan.ok === true) {
      return {
        verdict,
        value: plan.value,
        readOnly: false,
        notice: label + "已从 v" + String(diskVersion) + " 迁移到 v" + String(currentVer),
        migrate: plan,
      };
    }
    return {
      verdict,
      value: raw,
      readOnly: true,
      notice: "「" + label + "」是 v" + String(diskVersion) + "，缺少迁移到 v" + String(currentVer) +
        " 的步骤（卡在 v" + String("stuckAt" in plan ? plan.stuckAt : plan.from) + "）—— 已进入只读保护，请先升级插件。",
      migrate: plan,
    };
  }

  if (verdict === "too-new") {
    return {
      verdict,
      value: raw,
      readOnly: true,
      notice: "「" + label + "」是 v" + String(diskVersion) + " 的数据，比当前插件（v" + String(currentVer) +
        "）更新 —— 写回去会丢掉新字段，已进入只读保护。请升级插件后再写入。",
      migrate: null,
    };
  }

  return {
    verdict,
    value: raw,
    readOnly: false,
    notice: "「" + label + "」没有版本号（可能是手工创建或损坏的旧文件），已按当前结构尽力读取。",
    migrate: null,
  };
}

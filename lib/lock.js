/**
 * 单实例写锁 —— 纯函数、零依赖，能脱离 DSH 进程直接用 node 单测。
 *
 * 为什么需要：`memory.json` / `vectors.json` 都是「启动读进内存、改完全量写回」。
 * `atomicWrite` 只保证**文件不会被写坏**，保证不了**不丢数据** —— 两个进程同时开着
 * （比如桌面端与 `dsh web` 指向同一个 `$DSH_HOME`）时，后写的那个内存里没有对方
 * 刚写进去的东西，一次全量写回就把对方的记忆覆盖掉了。
 *
 * 做法很朴素：写一份锁文件，谁先拿到谁写，后来者进入只读保护（可读可检索，但不落盘）。
 * 崩溃残留的锁会被自动接管 —— 先看 pid 还活着没有，再看时间戳兜底（防 pid 复用）。
 *
 * 这一层只做**判断**（纯函数）；创建 / 释放 / 探测进程存活由调用方执行。
 */

/** 锁文件内容。`tag` 用来标识是哪个 DSH_HOME / 哪个 profile，方便排查。 */
export function lockPayload(pid, now, tag = "") {
  return JSON.stringify({
    pid: Number.isInteger(pid) ? pid : 0,
    at: new Date(Number.isFinite(now) ? now : Date.now()).toISOString(),
    tag: String(tag).slice(0, 200),
  });
}

/**
 * 解析锁文件。坏内容（空 / 非 JSON / 缺 pid）返回 null —— 调用方按「坏锁」处理（可抢占）。
 */
export function parseLock(text) {
  if (typeof text !== "string" || text.trim() === "") return null;
  try {
    const raw = JSON.parse(text);
    if (raw === null || typeof raw !== "object") return null;
    if (!Number.isInteger(raw.pid) || raw.pid <= 0) return null;
    return {
      pid: raw.pid,
      at: typeof raw.at === "string" ? raw.at : "",
      tag: typeof raw.tag === "string" ? raw.tag : "",
    };
  } catch {
    return null;
  }
}

/** 锁年龄（毫秒）；时间戳解析不出来时返回 Infinity（当作极旧）。 */
export function lockAge(lock, now) {
  if (lock === null || typeof lock !== "object" || typeof lock.at !== "string" || lock.at === "") return Infinity;
  const at = Date.parse(lock.at);
  if (!Number.isFinite(at)) return Infinity;
  return Math.max(0, (Number.isFinite(now) ? now : Date.now()) - at);
}

/**
 * 这把锁现在是什么状态？
 *
 * @param {{lock:object|null, now:number, selfPid:number, isAlive:(pid:number)=>boolean, ttlMs:number}} input
 * @returns {"mine"|"held"|"stale"|"broken"}
 *   mine   —— 是本进程自己持有的（重复 apply / 重入）
 *   held   —— 别人正持有，且看起来还活着 → 应当进入只读保护
 *   stale  —— 残留锁（持有者已不在，或老得离谱）→ 可以抢占
 *   broken —— 内容坏了 / 没有锁文件 → 可以创建
 */
/**
 * @param {{lock?:{pid?:number, at?:string, tag?:string}|null, now?:number, selfPid?:number, isAlive?:(pid:number)=>boolean, ttlMs?:number}} input
 * @returns {"mine"|"held"|"stale"|"broken"}
 */
export function lockState(input) {
  const args = input === null || typeof input !== "object" ? {} : input;
  const { lock, now, selfPid, isAlive, ttlMs } = args;
  if (lock === null || lock === undefined) return "broken";
  if (typeof lock.pid === "number" && Number.isInteger(selfPid) && lock.pid === selfPid) return "mine";

  // ① pid 还活着 → 别人在用（除非老得离谱，防 pid 被复用）
  let alive = false;
  if (typeof isAlive === "function" && typeof lock.pid === "number") {
    try {
      alive = isAlive(lock.pid) === true;
    } catch {
      alive = false;
    }
  }
  const age = lockAge(lock, now);
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 12 * 60 * 60 * 1000;

  if (alive && age < ttl) return "held";
  // ② pid 不在（崩溃残留）或老过头 → 可抢占
  return "stale";
}

/**
 * 给人看的一句话说明（进日志与面板）。
 */
export function lockNotice(state, lock) {
  const who = lock !== null && typeof lock === "object" && lock.pid > 0 ? "（pid " + String(lock.pid) + "）" : "";
  if (state === "held") {
    return "另一个 DSH 实例" + who + "正在使用同一个记忆库 —— 已进入只读保护：可以读、可以检索，但不会写回（否则两边会互相覆盖）。" +
      "要写入请先关掉那个实例；若确认它已经异常退出，删掉 write.lock 再重启即可。";
  }
  if (state === "stale") {
    return "发现残留的写锁" + who + "（持有者已不在），已自动接管。";
  }
  if (state === "broken") {
    return "没有可用的写锁（首次启动或锁文件损坏），已创建。";
  }
  return "";
}

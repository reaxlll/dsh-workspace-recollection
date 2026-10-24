/**
 * 时区检测与时间显示 —— 纯函数、零依赖，能脱离 DSH 进程直接用 node 单测。
 *
 * 为什么单独一层（2026-10-21 实测的教训）：
 * 记忆与会话里存的时间都是 ISO（UTC），而给人看的时间轴必须是**本地时间**。
 * 旧代码直接 new Date(ms).toISOString().slice(5, 16)，显示的是 UTC ——
 * 比本地少 8 小时（19:40 被显示成 11:40，一句「时间不对吧」暴露了这件事）。
 *
 * 这一层负责三件事：
 *   ① 首次安装时检测一次本机时区（IANA id，如 "Asia/Shanghai"），由 store 落盘记住；
 *   ② 之后所有时间显示都按这个 id 格式化，展示代码里不再出现 toISOString；
 *   ③ 检测失败也有兜底（按当前偏移合成 "UTC+08:00"），永远返回能用的值。
 *
 * 为什么不直接依赖「系统本地时间」：检测一次并落盘，时间轴代表的才是
 * 「这件事当时是几点发生的」。系统本地时间会随出差 / 容器 / 时区设置漂移，
 * 而一条三个月前的记忆不该因为换了时区就换个钟点显示。
 */

/** 兜底时区：检测彻底失败时用它。 */
export const DEFAULT_TIME_ZONE = "UTC";

/** 按 id 缓存 Intl 格式化器 —— 时间轴一次要格式化几十行，别每行新建一个。 */
const FORMATTERS = new Map();

/**
 * 解析「UTC+08:00」这种**合成偏移**（Intl 不认，只能自己算）。
 *
 * @param {string} id
 * @returns {number|null} 分钟数（东八区 = 480）；不是合成 id 返回 null
 */
export function parseFixedOffset(id) {
  if (typeof id !== "string") return null;
  const match = /^UTC([+-])(\d{2}):(\d{2})$/.exec(id.trim());
  if (match === null) return null;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours > 14 || minutes > 59) return null;
  const total = hours * 60 + minutes;
  return match[1] === "-" ? -total : total;
}

/** 把分钟偏移合成为 id（"UTC+08:00"）。 */
export function fixedZoneId(minutes) {
  const value = Number(minutes);
  const safe = Number.isFinite(value) ? Math.round(value) : 0;
  const sign = safe < 0 ? "-" : "+";
  const abs = Math.abs(safe);
  return "UTC" + sign + String(Math.floor(abs / 60)).padStart(2, "0") + ":" + String(abs % 60).padStart(2, "0");
}

/**
 * Intl 认不认这个时区 id。
 *
 * 注意合成偏移（"UTC+08:00"）在 Intl 里**不是合法时区**，合法性只看 IANA id。
 */
export function isValidTimeZone(id) {
  if (typeof id !== "string") return false;
  const text = id.trim();
  if (text === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: text });
    return true;
  } catch {
    return false;
  }
}

/**
 * 检测本机时区。优先 IANA id（Intl 的 resolvedOptions），拿不到就按当前偏移合成。
 *
 * @param {number} [now] 用于算偏移的时刻（跨夏令时的时区在不同月份偏移不同）
 * @returns {string} 永远返回非空字符串
 */
export function detectTimeZone(now = Date.now()) {
  try {
    const id = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (isValidTimeZone(id)) return id;
  } catch {
    /* 没有 Intl 就走下面的兜底 */
  }
  const ms = Number(now);
  const dt = new Date(Number.isFinite(ms) ? ms : Date.now());
  if (Number.isNaN(dt.getTime())) return DEFAULT_TIME_ZONE;
  return fixedZoneId(-dt.getTimezoneOffset());
}

/**
 * 规整时区：合法的 IANA id / 合成偏移原样保留，其余（空、乱码）重新检测。
 *
 * @param {string} id
 * @param {number} [now]
 * @returns {string}
 */
export function normalizeTimeZone(id, now = Date.now()) {
  if (typeof id === "string") {
    const text = id.trim();
    if (parseFixedOffset(text) !== null) return text;
    if (isValidTimeZone(text)) return text;
  }
  return detectTimeZone(now);
}

function formatterOf(zone) {
  const cached = FORMATTERS.get(zone);
  if (cached !== undefined) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  FORMATTERS.set(zone, formatter);
  return formatter;
}

/**
 * 把一个时间戳拆成指定时区下的日历／钟点部件。
 *
 * @param {number|string|Date} ms 时间戳或可被 Date 解析的串
 * @param {string} [tz] 时区；空 / 非法时退回本机本地时间（永不抛错）
 * @returns {{y:number,mo:number,d:number,h:number,mi:number,s:number}|null} 无法解析返回 null
 */
export function partsOf(ms, tz) {
  // null / undefined / 空串 会让 new Date() 得到 epoch 0（1970-01-01），
  // 不是「解析失败」而是「悄悄显示成 1970 年」—— 这里必须先挡掉。
  if (ms === null || ms === undefined || ms === "") return null;
  if (typeof ms === "number" && !Number.isFinite(ms)) return null;
  const dt = ms instanceof Date ? ms : new Date(ms);
  const time = dt.getTime();
  if (!Number.isFinite(time)) return null;

  const zone = typeof tz === "string" ? tz.trim() : "";
  const offset = parseFixedOffset(zone);
  if (offset !== null) {
    // 合成偏移：先平移到该偏移，再用 UTC 取值（不受本机时区影响）
    const shifted = new Date(time + offset * 60000);
    return {
      y: shifted.getUTCFullYear(),
      mo: shifted.getUTCMonth() + 1,
      d: shifted.getUTCDate(),
      h: shifted.getUTCHours(),
      mi: shifted.getUTCMinutes(),
      s: shifted.getUTCSeconds(),
    };
  }
  if (isValidTimeZone(zone)) {
    const bag = { y: 0, mo: 1, d: 1, h: 0, mi: 0, s: 0 };
    for (const part of formatterOf(zone).formatToParts(dt)) {
      if (part.type === "year") bag.y = Number(part.value);
      else if (part.type === "month") bag.mo = Number(part.value);
      else if (part.type === "day") bag.d = Number(part.value);
      else if (part.type === "hour") bag.h = Number(part.value) % 24;
      else if (part.type === "minute") bag.mi = Number(part.value);
      else if (part.type === "second") bag.s = Number(part.value);
    }
    return bag;
  }
  // 兜底：没有时区就用本机（这是旧行为，但至少不是 UTC）
  return {
    y: dt.getFullYear(),
    mo: dt.getMonth() + 1,
    d: dt.getDate(),
    h: dt.getHours(),
    mi: dt.getMinutes(),
    s: dt.getSeconds(),
  };
}

const pad2 = (value) => String(value).padStart(2, "0");

/** YYYY-MM-DD（指定时区的日历日）；解析不了返回空串。 */
export function ymdOf(ms, tz) {
  const bag = partsOf(ms, tz);
  if (bag === null) return "";
  return bag.y + "-" + pad2(bag.mo) + "-" + pad2(bag.d);
}

/** HH:MM。 */
export function formatClock(ms, tz) {
  const bag = partsOf(ms, tz);
  if (bag === null) return "";
  return pad2(bag.h) + ":" + pad2(bag.mi);
}

/** MM-DD HH:MM —— 会话列表、轮次行、时间通道用这个。 */
export function formatStamp(ms, tz) {
  const bag = partsOf(ms, tz);
  if (bag === null) return "";
  return pad2(bag.mo) + "-" + pad2(bag.d) + " " + pad2(bag.h) + ":" + pad2(bag.mi);
}

/** YYYY-MM-DD HH:MM —— 来源行（要带年份）用这个。 */
export function formatDateTime(ms, tz) {
  const bag = partsOf(ms, tz);
  if (bag === null) return "";
  return bag.y + "-" + pad2(bag.mo) + "-" + pad2(bag.d) + " " + pad2(bag.h) + ":" + pad2(bag.mi);
}

/**
 * 某个时区在指定时刻的偏移分钟数（含夏令时）。
 *
 * 做法：分别取「该时区的墙钟」与「UTC 的墙钟」，两者之差就是偏移。
 */
export function offsetMinutesAt(tz, ms = Date.now()) {
  const local = partsOf(ms, tz);
  const utc = partsOf(ms, "UTC");
  if (local === null || utc === null) return 0;
  const a = Date.UTC(local.y, local.mo - 1, local.d, local.h, local.mi, local.s);
  const b = Date.UTC(utc.y, utc.mo - 1, utc.d, utc.h, utc.mi, utc.s);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((a - b) / 60000);
}

/** 人类可读的时区说明（状态接口 / 面板用）："Asia/Shanghai (UTC+08:00)"。 */
export function describeTimeZone(tz, now = Date.now()) {
  const zone = normalizeTimeZone(tz, now);
  if (parseFixedOffset(zone) !== null) return zone;
  return zone + " (" + fixedZoneId(offsetMinutesAt(zone, now)) + ")";
}
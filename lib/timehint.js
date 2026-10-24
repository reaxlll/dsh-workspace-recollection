/**
 * 时间提示解析 —— 纯函数、零依赖，能脱离 DSH 进程直接用 node 单测。
 *
 * 为什么需要它（2026-10-15）：
 * 记忆条目的向量文本是「要点 + 正文」，**时间戳从来没进过任何一层** —— 能按时间排序，
 * 却完全不能按时间反查。「九天前我问了什么」在向量层没有任何落点，只能靠正文块零散撞词，
 * 于是排在前面的是 5 月的历史会话配置（跟日期毫不相干）。
 *
 * 这一层只做一件事：把 query 里的「日期 / 相对时间」解析成一个**本地日历日区间**，
 * 交给检索层做结构化过滤（而不是塞进嵌入文本污染语义空间）。
 *
 * ⚠️ 与来源的关系：只有 `agent` / `panel` 来源的条目，时间字段才代表「事件发生时间」；
 * `import` 进来的存档条目，createdAt 是**落库时间**（163 条导入存档全是
 * 导入那一天），拿它做时间反查会把 163 条一起捞出来 —— 所以过滤由检索层按来源把关。
 */

import { partsOf } from "./localtime.js";

const CN_DIGITS = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
  五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

/** 绝对日期：2026-10-06 / 2026/10/6 / 2026.10.6 / 2026年10月6日 */
const ABS_RE = /(\d{4})\s*(?:年|[\/.\-])\s*(\d{1,2})\s*(?:月|[\/.\-])\s*(\d{1,2})\s*[日号]?/;
/** 月日：10月6日 / 10月6号（不带年） */
const MD_RE = /(?:^|[^\d年月日号])(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/;
/**
 * 相对日：顺序即优先级（大前天必须先于前天匹配）。
 * 标注成元组，否则 TS 会把每一项推成 (string|number)[]，word 就不是 string 了。
 * @type {Array<[string, number]>}
 */
const REL_DAYS = [
  ["大前天", -3],
  ["前天", -2],
  ["昨天", -1],
  ["昨日", -1],
  ["今天", 0],
  ["今日", 0],
];
/** N 天前：9天前 / 九天前 / 十五天前 / 30天以前 */
const NDAYS_RE = /(\d{1,3}|[零〇一二两三四五六七八九十]{1,3})\s*天\s*(?:以\s*)?前/;

/**
 * 中文数字 → 数字（1~99 够用：「九天」「十五天」「三十天」）。
 * 认不出来返回 NaN。
 */
export function cnNumber(input) {
  const s = String(input).trim();
  if (s === "") return NaN;
  if (/^\d+$/.test(s)) return Number(s);
  if (s.length === 1) return CN_DIGITS[s] ?? NaN;
  const at = s.indexOf("十");
  if (at < 0) {
    let n = 0;
    for (const ch of s) {
      const v = CN_DIGITS[ch];
      if (v === undefined) return NaN;
      n = n * 10 + v;
    }
    return n;
  }
  const head = s.slice(0, at);
  const tail = s.slice(at + 1);
  const h = head === "" ? 1 : CN_DIGITS[head];
  const t = tail === "" ? 0 : CN_DIGITS[tail];
  if (h === undefined || t === undefined) return NaN;
  return h * 10 + t;
}

/** 本机本地日历日 —— 纯日历算术（内部 shiftDays 之后取日期串）用这个。 */
function ymdLocal(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + d;
}

/**
 * 指定时区的日历日。没给时区就是本机本地（v2.5 的旧行为，单测都依赖它）。
 *
 * Date 在这里只当「一个时刻」用，不做算术 —— 算术全部走 ymdLocal。
 */
function ymd(date, tz) {
  if (typeof tz === "string" && tz.trim() !== "") {
    const bag = partsOf(date, tz);
    if (bag !== null) {
      return bag.y + "-" + String(bag.mo).padStart(2, "0") + "-" + String(bag.d).padStart(2, "0");
    }
  }
  return ymdLocal(date);
}

function dayStart(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * 「今天」在这个时区是哪一天。
 *
 * 刻意返回一个**本机本地**的午夜 Date：parseTimeHint 后面全是日历加减
 * （shiftDays）与日历串输出（ymdLocal），与真实时刻无关。
 * 用本地日期当载体最省事，也避免「再把时区套一次」造成二次偏移。
 */
function todayInZone(now, tz) {
  if (typeof tz === "string" && tz.trim() !== "") {
    const bag = partsOf(now, tz);
    if (bag !== null) return new Date(bag.y, bag.mo - 1, bag.d);
  }
  return dayStart(now);
}

function shiftDays(base, days) {
  const d = dayStart(base);
  d.setDate(d.getDate() + days);
  return d;
}

function validDay(y, m, d) {
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return false;
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(y, m - 1, d);
  return probe.getFullYear() === y && probe.getMonth() === m - 1 && probe.getDate() === d;
}

/**
 * 从 query 里解析「哪一天」。
 *
 * @param {string} query
 * @param {Date} [now]  基准「今天」（默认当前时间）
 * @param {string} [tz] 按哪个时区算「今天」（v2.8；省略 = 本机本地）
 * @returns {{from:string,to:string,label:string,kind:string}|null}
 *          from/to 为日历日 YYYY-MM-DD（闭区间）；识别不到返回 null
 */
export function parseTimeHint(query, now = new Date(), tz = "") {
  const text = typeof query === "string" ? query : "";
  if (text === "" || !(now instanceof Date) || Number.isNaN(now.getTime())) return null;
  const today = todayInZone(now, tz);

  // ① 绝对日期（带年）
  const abs = ABS_RE.exec(text);
  if (abs !== null) {
    const y = Number(abs[1]);
    const m = Number(abs[2]);
    const d = Number(abs[3]);
    if (validDay(y, m, d)) {
      const day = ymdLocal(new Date(y, m - 1, d));
      return { from: day, to: day, label: abs[0].trim(), kind: "absolute" };
    }
  }

  // ② 月日（不带年 → 按「最近一次过去」算：今天之前用今年，晚于今天用去年）
  const md = MD_RE.exec(text);
  if (md !== null) {
    const m = Number(md[1]);
    const d = Number(md[2]);
    if (validDay(2000, m, d)) {
      let day = new Date(today.getFullYear(), m - 1, d);
      if (day.getTime() > today.getTime()) day = new Date(today.getFullYear() - 1, m - 1, d);
      const value = ymdLocal(day);
      return { from: value, to: value, label: md[0].trim(), kind: "month-day" };
    }
  }

  // ③ 相对日（今天 / 昨天 / 前天 / 大前天）
  for (const [word, delta] of REL_DAYS) {
    if (text.includes(word)) {
      const value = ymdLocal(shiftDays(today, delta));
      return { from: value, to: value, label: word, kind: "relative" };
    }
  }

  // ④ N 天前（含中文数字：九天前）
  const nd = NDAYS_RE.exec(text);
  if (nd !== null) {
    const n = cnNumber(nd[1]);
    if (Number.isFinite(n) && n >= 0 && n <= 3650) {
      const value = ymdLocal(shiftDays(today, -n));
      return { from: value, to: value, label: nd[0].replace(/\s+/g, ""), kind: "days-ago" };
    }
  }

  return null;
}

/**
 * 某个时间戳（ISO 串或日期串）的**本地日历日**是否落在 [from, to] 闭区间内。
 *
 * @param {string} iso
 * @param {string} from  YYYY-MM-DD
 * @param {string} to    YYYY-MM-DD
 * @returns {boolean}
 */
export function inDayRange(iso, from, to, tz = "") {
  const day = dayOf(iso, tz);
  return day !== "" && day >= from && day <= to;
}

/** 本地日历日（给展示用）。 */
export function dayOf(iso, tz = "") {
  if (typeof iso !== "string" || iso === "") return "";
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return "";
  return ymd(dt, tz);
}

/** 本地时刻 HH:MM（给时间通道的列表用）。 */
export function clockOf(iso, tz = "") {
  if (typeof iso !== "string" || iso === "") return "";
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return "";
  if (typeof tz === "string" && tz.trim() !== "") {
    const bag = partsOf(dt, tz);
    if (bag !== null) return String(bag.h).padStart(2, "0") + ":" + String(bag.mi).padStart(2, "0");
  }
  return String(dt.getHours()).padStart(2, "0") + ":" + String(dt.getMinutes()).padStart(2, "0");
}
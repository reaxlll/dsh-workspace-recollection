/**
 * lib/timehint.js 的单元测试 —— 零依赖，`node --test tests/timehint.test.mjs` 直接跑。
 * 基准「今天」固定为本地时间 2026-10-15，所以用例在任何时区下都是确定的。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTimeHint, inDayRange, cnNumber, dayOf, clockOf } from "../lib/timehint.js";

const NOW = new Date(2026, 9, 15, 21, 30, 0); // 2026-10-15 21:30（本地时区）

/* ── 绝对日期 ─────────────────────────────────────────────── */

test("绝对日期：2026-10-06 / 2026年10月6日 / 2026/10/6", () => {
  assert.equal(parseTimeHint("2026-10-06 我问了什么", NOW).from, "2026-10-06");
  assert.equal(parseTimeHint("2026年10月6日", NOW).from, "2026-10-06");
  assert.equal(parseTimeHint("2026/10/6 的那次会话", NOW).from, "2026-10-06");
  assert.equal(parseTimeHint("2026.10.6", NOW).from, "2026-10-06");
  assert.equal(parseTimeHint("2026-10-06", NOW).kind, "absolute");
  assert.equal(parseTimeHint("2026-10-06", NOW).to, "2026-10-06");
});

test("月日：10月6日 / 10月6号 → 算「最近一次过去」", () => {
  // 本次事故的原句
  assert.equal(parseTimeHint("10月6日 提问 做了什么", NOW).from, "2026-10-06");
  assert.equal(parseTimeHint("10月6号", NOW).from, "2026-10-06");
  assert.equal(parseTimeHint("12月6日那天", NOW).from, "2025-12-06", "晚于今天 → 算去年");
  assert.equal(parseTimeHint("10月6日 提问 做了什么", NOW).kind, "month-day");
});

/* ── 相对时间 ─────────────────────────────────────────────── */

test("相对日：今天 / 昨天 / 前天 / 大前天（大前天必须先匹配）", () => {
  assert.equal(parseTimeHint("今天做了什么", NOW).from, "2026-10-15");
  assert.equal(parseTimeHint("昨天", NOW).from, "2026-10-14");
  assert.equal(parseTimeHint("前天问的", NOW).from, "2026-10-13");
  assert.equal(parseTimeHint("大前天", NOW).from, "2026-10-12");
  assert.equal(parseTimeHint("昨天", NOW).label, "昨天");
});

test("N 天前：阿拉伯数字与中文数字都要认", () => {
  // 本次事故的原句
  assert.equal(parseTimeHint("九天前我问了什么", NOW).from, "2026-10-06");
  assert.equal(parseTimeHint("9天前", NOW).from, "2026-10-06");
  assert.equal(parseTimeHint("1天前", NOW).from, "2026-10-14");
  assert.equal(parseTimeHint("十五天前", NOW).from, "2026-09-30");
  assert.equal(parseTimeHint("三十天以前", NOW).from, "2026-09-15");
  assert.equal(parseTimeHint("九天前我问了什么", NOW).kind, "days-ago");
});

/* ── 不该误判 ─────────────────────────────────────────────── */

test("认不出来就是 null：普通数字、版本号、常量名都不算日期", () => {
  assert.equal(parseTimeHint("记忆插件 v2.3.0 段级引索", NOW), null);
  assert.equal(parseTimeHint("PowerShell 5.1 的编码坑", NOW), null);
  assert.equal(parseTimeHint("TTS ffplay 播放音频", NOW), null);
  assert.equal(parseTimeHint("会话记录收录进工作区记忆", NOW), null);
  assert.equal(parseTimeHint("10 个记忆条目", NOW), null, "光有数字不算日期");
  assert.equal(parseTimeHint("13月45日", NOW), null, "非法月日不认");
  assert.equal(parseTimeHint("", NOW), null);
  assert.equal(parseTimeHint(null, NOW), null);
  assert.equal(parseTimeHint("九天前", null), null, "坏基准时间不认");
});

/* ── 小工具 ───────────────────────────────────────────────── */

test("cnNumber：一 ~ 九十九", () => {
  assert.equal(cnNumber("九"), 9);
  assert.equal(cnNumber("十"), 10);
  assert.equal(cnNumber("十五"), 15);
  assert.equal(cnNumber("二十"), 20);
  assert.equal(cnNumber("二十三"), 23);
  assert.equal(cnNumber("三十"), 30);
  assert.equal(cnNumber("九十九"), 99);
  assert.equal(cnNumber("9"), 9);
  assert.ok(Number.isNaN(cnNumber("天")));
  assert.ok(Number.isNaN(cnNumber("")));
});

test("inDayRange：本地日历日闭区间（用本地时间构造，保证任何时区都成立）", () => {
  const noon = new Date(2026, 9, 6, 12, 0, 0).toISOString();
  const nextNoon = new Date(2026, 9, 7, 12, 0, 0).toISOString();
  assert.equal(inDayRange(noon, "2026-10-06", "2026-10-06"), true);
  assert.equal(inDayRange(nextNoon, "2026-10-06", "2026-10-06"), false);
  assert.equal(inDayRange(noon, "2026-10-06", "2026-10-07"), true);
  assert.equal(inDayRange(nextNoon, "2026-10-07", "2026-10-07"), true);
  assert.equal(inDayRange("", "2026-10-06", "2026-10-06"), false);
  assert.equal(inDayRange("乱码", "2026-10-06", "2026-10-06"), false);
  assert.equal(inDayRange(null, "2026-10-06", "2026-10-06"), false);
});

test("dayOf / clockOf：坏输入给空串，不炸", () => {
  assert.equal(dayOf(new Date(2026, 9, 6, 14, 41, 39).toISOString()), "2026-10-06");
  assert.equal(dayOf(""), "");
  assert.equal(dayOf("为什么"), "");
  assert.equal(clockOf(new Date(2026, 9, 6, 14, 41, 39).toISOString()), "14:41");
  assert.equal(clockOf(""), "");
  assert.equal(clockOf("为什么"), "");
});

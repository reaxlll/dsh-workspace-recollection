/**
 * localtime 的单测 —— 钉住「时间轴显示的是本地时间」这件事。
 *
 * 这些用例的来历：2026-10-21 晚，session_read 把本地 19:40 显示成 11:40，
 * Master 一句「时间不对吧」暴露了整个展示层都在用 toISOString。
 * 所以这里的核心断言是**拿 UTC 串当输入、断言输出是东八区的钟点**。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_TIME_ZONE,
  parseFixedOffset,
  fixedZoneId,
  isValidTimeZone,
  detectTimeZone,
  normalizeTimeZone,
  partsOf,
  ymdOf,
  formatClock,
  formatStamp,
  formatDateTime,
  offsetMinutesAt,
  describeTimeZone,
} from "../lib/localtime.js";

test("合成偏移：解析与合成", () => {
  assert.equal(parseFixedOffset("UTC+08:00"), 480);
  assert.equal(parseFixedOffset("UTC-05:30"), -330);
  assert.equal(parseFixedOffset("UTC+00:00"), 0);
  assert.equal(parseFixedOffset("UTC+99:00"), null);
  assert.equal(parseFixedOffset("Asia/Shanghai"), null);
  assert.equal(parseFixedOffset(""), null);
  assert.equal(parseFixedOffset(null), null);
  assert.equal(fixedZoneId(480), "UTC+08:00");
  assert.equal(fixedZoneId(-330), "UTC-05:30");
  assert.equal(fixedZoneId(0), "UTC+00:00");
});

test("IANA 合法性：合成偏移不算合法时区", () => {
  assert.equal(isValidTimeZone("Asia/Shanghai"), true);
  assert.equal(isValidTimeZone("UTC"), true);
  assert.equal(isValidTimeZone("UTC+08:00"), false);
  assert.equal(isValidTimeZone("Mars/Olympus"), false);
  assert.equal(isValidTimeZone(""), false);
  assert.equal(isValidTimeZone(undefined), false);
});

test("检测：永远返回一个可用值", () => {
  const detected = detectTimeZone();
  assert.equal(typeof detected, "string");
  assert.notEqual(detected, "");
  assert.ok(isValidTimeZone(detected) || parseFixedOffset(detected) !== null);
  // 空串 / 乱码都该被重新检测，而不是原样留下
  assert.equal(normalizeTimeZone(""), detected);
  assert.equal(normalizeTimeZone("Mars/Olympus"), detected);
  // 合法值不该被动过
  assert.equal(normalizeTimeZone("Asia/Shanghai"), "Asia/Shanghai");
  assert.equal(normalizeTimeZone("UTC+08:00"), "UTC+08:00");
});

test("拆解：UTC 11:40 在上海是 19:40（这就是当初那个 bug）", () => {
  const iso = "2026-10-21T11:40:00Z";
  const bag = partsOf(iso, "Asia/Shanghai");
  assert.deepEqual(
    { y: bag.y, mo: bag.mo, d: bag.d, h: bag.h, mi: bag.mi },
    { y: 2026, mo: 10, d: 21, h: 19, mi: 40 },
  );
  // 合成偏移与 IANA 名必须给出同一个时刻
  assert.deepEqual(partsOf(iso, "UTC+08:00"), bag);
  // 对照：旧的 toISOString 写法给出的是 UTC 11:40
  assert.equal(new Date(iso).toISOString().slice(11, 16), "11:40");
  assert.equal(formatClock(iso, "Asia/Shanghai"), "19:40");
  assert.equal(formatStamp(iso, "Asia/Shanghai"), "10-21 19:40");
  assert.equal(formatDateTime(iso, "Asia/Shanghai"), "2026-10-21 19:40");
  assert.equal(ymdOf(iso, "Asia/Shanghai"), "2026-10-21");
});

test("跨日：UTC 20:00 在上海已经是次日 04:00", () => {
  const iso = "2026-10-21T20:00:00Z";
  assert.equal(ymdOf(iso, "Asia/Shanghai"), "2026-10-22");
  assert.equal(formatClock(iso, "Asia/Shanghai"), "04:00");
  assert.equal(formatStamp(iso, "Asia/Shanghai"), "10-22 04:00");
});

test("跨年：UTC 12-31 16:00 在东八区是 1 月 1 日 00:00", () => {
  const iso = "2026-12-31T16:00:00Z";
  assert.equal(ymdOf(iso, "Asia/Shanghai"), "2027-01-01");
  assert.equal(formatDateTime(iso, "Asia/Shanghai"), "2027-01-01 00:00");
});

test("偏移计算：含夏令时的时区", () => {
  assert.equal(offsetMinutesAt("Asia/Shanghai"), 480);
  assert.equal(offsetMinutesAt("UTC"), 0);
  assert.equal(offsetMinutesAt("UTC+08:00"), 480);
  // 纽约：1 月 -300，7 月 -240
  assert.equal(offsetMinutesAt("America/New_York", Date.UTC(2026, 0, 15)), -300);
  assert.equal(offsetMinutesAt("America/New_York", Date.UTC(2026, 6, 15)), -240);
});

test("兜底：非法时区退回本机本地时间，且不抛错", () => {
  const iso = "2026-10-21T11:40:00Z";
  const dt = new Date(iso);
  const expected = String(dt.getHours()).padStart(2, "0") + ":" + String(dt.getMinutes()).padStart(2, "0");
  assert.equal(formatClock(iso, "Mars/Olympus"), expected);
  assert.equal(formatClock(iso, ""), expected);
  assert.equal(formatClock(iso, undefined), expected);
  // 垃圾输入返回空串，不返回 "NaN-NaN"
  assert.equal(formatStamp("not-a-date", "Asia/Shanghai"), "");
  assert.equal(ymdOf(null, "Asia/Shanghai"), "");
});

test("时区说明：带偏移，便于状态接口一眼看出", () => {
  assert.equal(describeTimeZone("Asia/Shanghai"), "Asia/Shanghai (UTC+08:00)");
  assert.equal(describeTimeZone("UTC+08:00"), "UTC+08:00");
  assert.equal(describeTimeZone(""), detectTimeZone() + describeTimeZone(detectTimeZone()).slice(detectTimeZone().length));
  assert.equal(typeof DEFAULT_TIME_ZONE, "string");
});
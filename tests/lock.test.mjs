/**
 * lib/lock.js 的单元测试 —— 零依赖，`node --test tests/lock.test.mjs` 直接跑。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { lockPayload, parseLock, lockAge, lockState, lockNotice } from "../lib/lock.js";

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);

test("payload：pid / 时间 / 标记都在，且能被解析回来", () => {
  const text = lockPayload(4242, NOW, "C:\\Users\\x\\.dsh");
  const lock = parseLock(text);
  assert.equal(lock.pid, 4242);
  assert.equal(lock.at, "2026-10-16T12:00:00.000Z");
  assert.equal(lock.tag, "C:\\Users\\x\\.dsh");
});

test("payload：非法 pid 归零 → 被判为坏锁（可抢占），不会留下「看着有效」的锁", () => {
  assert.equal(parseLock(lockPayload(Number.NaN, Number.NaN)), null);
  assert.equal(parseLock(lockPayload(0, NOW)), null);
  assert.equal(parseLock(lockPayload(-5, NOW)), null);
  // 时间非法时仍要产出一个可解析的锁（at 用当前时间兜底）
  const ok = parseLock(lockPayload(1234, Number.NaN));
  assert.equal(ok.pid, 1234);
  assert.ok(Number.isFinite(Date.parse(ok.at)), "at 必须有合法时间戳兜底");
});

test("parseLock：坏内容一律 null（而不是抛）", () => {
  assert.equal(parseLock(""), null);
  assert.equal(parseLock("   "), null);
  assert.equal(parseLock("{ 不是 json"), null);
  assert.equal(parseLock("null"), null);
  assert.equal(parseLock("[]"), null);
  assert.equal(parseLock('{"pid":"123"}'), null, "pid 必须是整数");
  assert.equal(parseLock('{"pid":0}'), null);
  assert.equal(parseLock('{"pid":-3}'), null);
  assert.equal(parseLock("12345"), null);
});

test("lockAge：解析不出来当作极旧（Infinity）", () => {
  assert.equal(lockAge({ at: "2026-10-16T11:00:00.000Z" }, NOW), 3_600_000);
  assert.equal(lockAge({ at: "乱码" }, NOW), Infinity);
  assert.equal(lockAge({}, NOW), Infinity);
  assert.equal(lockAge(null, NOW), Infinity);
  assert.equal(lockAge({ at: new Date(NOW + 5000).toISOString() }, NOW), 0, "未来时间不返回负数");
});

test("状态：自己持有的锁 → mine（重复 apply 不算冲突）", () => {
  const lock = parseLock(lockPayload(111, NOW));
  assert.equal(lockState({ lock, now: NOW, selfPid: 111, isAlive: () => true, ttlMs: 60_000 }), "mine");
});

test("状态：别人持有且进程活着 → held（进只读保护）", () => {
  const lock = parseLock(lockPayload(222, NOW));
  assert.equal(lockState({ lock, now: NOW + 1000, selfPid: 111, isAlive: (pid) => pid === 222, ttlMs: 60_000 }), "held");
});

test("状态：持有者进程已不在 → stale（自动接管，不会死锁）", () => {
  const lock = parseLock(lockPayload(222, NOW));
  assert.equal(lockState({ lock, now: NOW + 1000, selfPid: 111, isAlive: () => false, ttlMs: 60_000 }), "stale");
});

test("状态：pid 活着但锁老过头 → stale（防 pid 被复用）", () => {
  const lock = parseLock(lockPayload(222, NOW));
  const ttl = 60_000;
  assert.equal(lockState({ lock, now: NOW + ttl + 1, selfPid: 111, isAlive: () => true, ttlMs: ttl }), "stale");
});

test("状态：探测函数抛错时按「不存活」处理（宁可接管，不要死等）", () => {
  const lock = parseLock(lockPayload(222, NOW));
  const boom = () => { throw new Error("EPERM"); };
  assert.equal(lockState({ lock, now: NOW, selfPid: 111, isAlive: boom, ttlMs: 60_000 }), "stale");
});

test("状态：没有锁 / 坏锁 → broken（可以创建）", () => {
  assert.equal(lockState({ lock: null, now: NOW, selfPid: 111, isAlive: () => true, ttlMs: 60_000 }), "broken");
  assert.equal(lockState(null), "broken");
  assert.equal(lockState(undefined), "broken");
});

test("状态：非法入参不炸", () => {
  assert.equal(typeof lockState({}), "string");
  assert.equal(typeof lockState({ lock: { pid: 1 }, now: Number.NaN, selfPid: Number.NaN, ttlMs: Number.NaN }), "string");
});

test("说明文案：held 要说清「为什么只读」和「怎么恢复」", () => {
  const message = lockNotice("held", { pid: 999 });
  assert.match(message, /只读保护/);
  assert.match(message, /pid 999/);
  assert.match(message, /write\.lock/, "要告诉用户怎么恢复");
  assert.equal(lockNotice("mine", { pid: 999 }), "");
  assert.match(lockNotice("stale", { pid: 999 }), /自动接管/);
});

/**
 * lib/first-look.js 的单元测试 —— 零依赖，`node --test tests/first-look.test.mjs` 直接跑。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MEMORY_LOOK_TOOLS,
  EXPLORE_TOOLS,
  DENY_REASON,
  DISPLAY_REASON,
  createFirstLookState,
  decideFirstLook,
  firstLookReport,
} from "../lib/first-look.js";

test("工具清单：记忆类只认「读」的，探索类包含 run_code", () => {
  assert.ok(MEMORY_LOOK_TOOLS.includes("memory_index"));
  assert.ok(MEMORY_LOOK_TOOLS.includes("memory_recall"));
  assert.ok(MEMORY_LOOK_TOOLS.includes("session_read"));
  assert.equal(MEMORY_LOOK_TOOLS.includes("memory_write"), false, "写记忆不算「看过记忆」");
  assert.ok(EXPLORE_TOOLS.includes("pwsh"));
  assert.ok(EXPLORE_TOOLS.includes("read"));
  assert.ok(EXPLORE_TOOLS.includes("run_code"), "run_code 是万能入口，必须算进来");
  assert.equal(EXPLORE_TOOLS.includes("edit"), false, "写文件不拦，免得误伤正常改动");
});

test("第一次探索调用 → deny，并记一次", () => {
  const state = createFirstLookState();
  assert.equal(decideFirstLook(state, "pwsh", "s1"), "deny");
  assert.equal(state.denied, 1);
  assert.equal(state.reminded.size, 1);
});

test("同一个会话第二次就放行（绝不卡死人）", () => {
  const state = createFirstLookState();
  assert.equal(decideFirstLook(state, "pwsh", "s1"), "deny");
  assert.equal(decideFirstLook(state, "read", "s1"), "next");
  assert.equal(state.allowed, 1);
});

test("先调记忆工具，后续探索一律放行", () => {
  const state = createFirstLookState();
  assert.equal(decideFirstLook(state, "memory_index", "s1"), "next");
  assert.equal(state.passed.has("s1"), true);
  for (const name of ["pwsh", "read", "grep", "run_code"]) {
    assert.equal(decideFirstLook(state, name, "s1"), "next", name + " 不该被拦");
  }
  assert.equal(state.denied, 0);
});

test("非探索型工具不消耗提醒（写记忆、登记任务不受影响）", () => {
  const state = createFirstLookState();
  assert.equal(decideFirstLook(state, "memory_write", "s1"), "next");
  assert.equal(decideFirstLook(state, "todo_write", "s1"), "next");
  assert.equal(decideFirstLook(state, "present", "s1"), "next");
  assert.equal(state.reminded.size, 0, "提醒额度没被用掉");
  assert.equal(decideFirstLook(state, "pwsh", "s1"), "deny", "探索时仍然该拦");
});

test("多会话互不影响", () => {
  const state = createFirstLookState();
  assert.equal(decideFirstLook(state, "pwsh", "s1"), "deny");
  assert.equal(decideFirstLook(state, "pwsh", "s2"), "deny", "另一个会话照样要拦");
  assert.equal(decideFirstLook(state, "memory_recall", "s2"), "next");
  assert.equal(decideFirstLook(state, "pwsh", "s2"), "next");
  assert.equal(decideFirstLook(state, "pwsh", "s1"), "next", "s1 已经被提醒过");
});

test("拿不到 sessionId 就放行（宁可少拦，不可误伤）", () => {
  const state = createFirstLookState();
  assert.equal(decideFirstLook(state, "pwsh", ""), "next");
  assert.equal(decideFirstLook(state, "pwsh", undefined), "next");
  assert.equal(state.skipped, 2);
  assert.equal(state.denied, 0);
});

test("坏输入不炸", () => {
  const state = createFirstLookState();
  assert.equal(decideFirstLook(null, "pwsh", "s1"), "next");
  assert.equal(decideFirstLook(state, "", "s1"), "next");
  assert.equal(decideFirstLook(state, 123, "s1"), "next");
  assert.equal(decideFirstLook(state, "pwsh", 42), "next");
});

test("拒绝理由要指路，不能只说「不许」", () => {
  assert.match(DENY_REASON, /memory_index/);
  assert.match(DENY_REASON, /memory_recall/);
  assert.match(DENY_REASON, /只拦一次/);
  assert.equal(DISPLAY_REASON.zh.length > 0, true);
  assert.equal(DISPLAY_REASON.en.length > 0, true);
});

test("status 快照：Set 不能进 JSON，要折成数字", () => {
  const state = createFirstLookState();
  decideFirstLook(state, "pwsh", "s1");
  decideFirstLook(state, "read", "s1");
  decideFirstLook(state, "memory_index", "s2");
  const report = firstLookReport(state);
  // s1：被拦 → 第二次放行（也算 passed）；s2：直接调记忆工具
  assert.deepEqual(report, { denied: 1, allowed: 1, skipped: 0, reminded: 1, passed: 2 });
  assert.equal(JSON.parse(JSON.stringify(report)).denied, 1, "可序列化");
  assert.deepEqual(firstLookReport(null), { denied: 0, allowed: 0, skipped: 0, reminded: 0, passed: 0 });
});

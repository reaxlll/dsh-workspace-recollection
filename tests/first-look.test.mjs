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

test("拦过的会话立刻记进 passed：绝不会被拦第二次（v2.10.1 修的轮轮拦截）", () => {
  const state = createFirstLookState();
  assert.equal(decideFirstLook(state, "pwsh", "s1"), "deny");
  assert.equal(state.passed.has("s1"), true, "deny 的同时就要记 passed");
  for (const name of ["read", "glob", "grep", "run_code", "pwsh"]) {
    assert.equal(decideFirstLook(state, name, "s1"), "next", name + " 不该被第二次拦");
  }
  assert.equal(state.denied, 1);
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

test("有上下文的会话一律不拦（只有全新会话的第一个动作才拦）", () => {
  const state = createFirstLookState();
  for (const name of ["pwsh", "read", "glob", "grep", "run_code"]) {
    assert.equal(decideFirstLook(state, name, "s1", true), "next", name + "：有上下文就不该拦");
  }
  assert.equal(state.denied, 0);
  assert.equal(state.passed.size, 0, "有上下文时不写 passed，也不消耗提醒额度");
});

test("没传 hasContext 就按「全新会话」处理（默认 false）", () => {
  const state = createFirstLookState();
  assert.equal(decideFirstLook(state, "pwsh", "s1"), "deny");
  assert.equal(state.denied, 1);
});

test("被拦过的会话，即使后来算作有上下文也照常放行", () => {
  const state = createFirstLookState();
  assert.equal(decideFirstLook(state, "pwsh", "s1", false), "deny");
  assert.equal(decideFirstLook(state, "pwsh", "s1", true), "next");
  assert.equal(decideFirstLook(state, "read", "s1", false), "next");
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
  assert.match(DENY_REASON, /只在新会话的第一次/);
  assert.match(DENY_REASON, /不会被它打扰/);
  assert.equal(DISPLAY_REASON.zh.length > 0, true);
  assert.equal(DISPLAY_REASON.en.length > 0, true);
});

test("status 快照：Set 不能进 JSON，要折成数字", () => {
  const state = createFirstLookState();
  decideFirstLook(state, "pwsh", "s1");
  decideFirstLook(state, "read", "s1");
  decideFirstLook(state, "memory_index", "s2");
  const report = firstLookReport(state);
  // s1：被拦一次（立即进 passed）→ 第二次走 passed 分支，reminded 被清掉、allowed+1
  // s2：直接调记忆工具 → 直接进 passed
  assert.equal(report.denied, 1);
  assert.equal(report.allowed, 1);
  assert.equal(report.skipped, 0);
  assert.equal(report.reminded, 0, "放行过的会话从 reminded 里清掉");
  assert.equal(report.passed, 2);
  assert.equal(Array.isArray(report.recent), true);
  assert.equal(report.recent.length, 2, "recent 里能看到两个会话的调用次数");
  assert.equal(JSON.parse(JSON.stringify(report)).denied, 1, "可序列化");
  assert.deepEqual(firstLookReport(null), { denied: 0, allowed: 0, skipped: 0, reminded: 0, passed: 0, recent: [] });
});

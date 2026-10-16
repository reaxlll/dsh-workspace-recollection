/**
 * lib/migrate.js 的单元测试 —— 零依赖，`node --test tests/migrate.test.mjs` 直接跑。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decideVersion,
  planMigration,
  backupName,
  pickBackupsToKeep,
  resolveOnRead,
  STORE_MIGRATIONS,
  VECTOR_MIGRATIONS,
} from "../lib/migrate.js";

/* ── 版本判定 ─────────────────────────────────────────────── */

test("版本判定：相同 / 更旧 / 更新 / 无法识别", () => {
  assert.equal(decideVersion(3, 3), "same");
  assert.equal(decideVersion(2, 3), "migrate");
  assert.equal(decideVersion(4, 3), "too-new");
  assert.equal(decideVersion(0, 3), "unknown");
  assert.equal(decideVersion(undefined, 3), "unknown");
  assert.equal(decideVersion("3", 3), "unknown", "字符串不算版本号");
  assert.equal(decideVersion(3, 0), "unknown", "当前版本非法时不下结论");
});

/* ── 迁移链 ───────────────────────────────────────────────── */

test("迁移：链齐全时逐级升版并记录步骤", () => {
  const chain = new Map([
    [1, (raw) => ({ ...raw, step1: true })],
    [2, (raw) => ({ ...raw, step2: true })],
  ]);
  const plan = planMigration({ version: 1, keep: "x" }, 1, 3, chain);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.applied, [2, 3]);
  assert.equal(plan.value.step1, true);
  assert.equal(plan.value.step2, true);
  assert.equal(plan.value.keep, "x", "原有字段不许丢");
});

test("迁移：缺环时停下并报出卡在哪一级（不半途写坏数据）", () => {
  const chain = new Map([[1, (raw) => ({ ...raw })]]);
  const plan = planMigration({ version: 1 }, 1, 3, chain);
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, "missing");
  assert.equal(plan.stuckAt, 2);
  assert.deepEqual(plan.applied, [2]);
});

test("迁移：目标不比当前高 / 参数非法 → noop（不误动作）", () => {
  assert.equal(planMigration({}, 3, 3, new Map()).reason, "noop");
  assert.equal(planMigration({}, 4, 3, new Map()).reason, "noop");
  assert.equal(planMigration({}, Number.NaN, 3, new Map()).reason, "noop");
});

test("迁移：传进来的不是 Map 也不炸（按空链处理）", () => {
  const plan = planMigration({}, 1, 2, null);
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, "missing");
});

test("内置迁移链此刻为空 —— 因为 v3 / v2 就是当前版本", () => {
  assert.equal(STORE_MIGRATIONS.size, 0);
  assert.equal(VECTOR_MIGRATIONS.size, 0);
});

/* ── 备份 ─────────────────────────────────────────────────── */

test("备份名：带原文件名 + 可排序时间戳 + .bak 后缀", () => {
  const name = backupName("memory.json", Date.UTC(2026, 9, 16, 12, 34, 56));
  assert.equal(name, "memory.json.2026-10-16T12-34-56.bak");
  // 不含 Windows 非法字符
  assert.equal(/[:*?"<>|]/.test(name), false);
});

test("备份名：同一毫秒之外按字典序即时间序", () => {
  const a = backupName("memory.json", Date.UTC(2026, 9, 16, 1, 0, 0));
  const b = backupName("memory.json", Date.UTC(2026, 9, 16, 2, 0, 0));
  assert.ok(a < b, "早的排在前面（pickBackupsToKeep 依赖这个性质）");
});

test("备份保留：只列该删的（留最新 keep 份）", () => {
  const names = ["m.json.01.bak", "m.json.02.bak", "m.json.03.bak", "m.json.04.bak"];
  assert.deepEqual(pickBackupsToKeep(names, 2), ["m.json.01.bak", "m.json.02.bak"]);
  assert.deepEqual(pickBackupsToKeep(names, 4), []);
  assert.deepEqual(pickBackupsToKeep(names, 0), names);
  assert.deepEqual(pickBackupsToKeep(names, 99), []);
});

test("备份保留：坏输入不炸", () => {
  assert.deepEqual(pickBackupsToKeep(null, 2), []);
  assert.deepEqual(pickBackupsToKeep([null, "", "a"], 0), ["a"], "坏元素被过滤掉，剩下的按保留数计算");
  assert.deepEqual(pickBackupsToKeep(["a"], Number.NaN), ["a"], "keep 非法 → 按保留 0 份处理，于是全列出来删");
  assert.deepEqual(pickBackupsToKeep(["a"], 1), [], "只留 1 份 → 没有该删的");
});

/* ── 读入决策（调用方直接照做的那一层）─────────────────────── */

test("读入：版本一致 → 原样使用、可写", () => {
  const raw = { version: 3, workspaces: {} };
  const out = resolveOnRead(raw, 3, STORE_MIGRATIONS, "memory.json");
  assert.equal(out.verdict, "same");
  assert.equal(out.readOnly, false);
  assert.equal(out.notice, "");
  assert.equal(out.value, raw);
});

test("读入：更旧的版本 + 链齐全 → 迁移并给出提示", () => {
  const chain = new Map([[3, (raw) => ({ ...raw, version: 4, upgraded: true })]]);
  const out = resolveOnRead({ version: 3, keep: 1 }, 4, chain, "memory.json");
  assert.equal(out.verdict, "migrate");
  assert.equal(out.readOnly, false);
  assert.equal(out.value.upgraded, true);
  assert.match(out.notice, /已从 v3 迁移到 v4/);
});

test("读入：更新的版本 → 只读保护（这条防的是「旧插件写坏新数据」）", () => {
  const out = resolveOnRead({ version: 9, workspaces: {} }, 3, STORE_MIGRATIONS, "memory.json");
  assert.equal(out.verdict, "too-new");
  assert.equal(out.readOnly, true);
  assert.match(out.notice, /比当前插件（v3）更新/);
  assert.match(out.notice, /只读保护/);
});

test("读入：缺迁移步骤 → 只读保护，并说清卡在哪一级", () => {
  const out = resolveOnRead({ version: 1 }, 3, new Map(), "vectors.json");
  assert.equal(out.verdict, "migrate");
  assert.equal(out.readOnly, true);
  assert.match(out.notice, /卡在 v1/);
});

test("读入：没有版本号 → 不拦，但明确告知按当前结构尽力读", () => {
  const out = resolveOnRead({ workspaces: {} }, 3, STORE_MIGRATIONS, "memory.json");
  assert.equal(out.verdict, "unknown");
  assert.equal(out.readOnly, false);
  assert.match(out.notice, /没有版本号/);
});

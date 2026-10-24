/**
 * lib/supersede.js 的单元测试 —— `node --test tests/supersede.test.mjs` 直接跑。
 *
 * 这一层的风险是「把链指乱了」：一条记忆被标成过时之后，检索降权、目录折叠，
 * 等于从模型的视野里半消失。所以每个「不动」的分支都要被钉住。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applySupersede,
  isSuperseded,
  validityFactor,
  chainTip,
  liveEntries,
  versionHistory,
  SUPERSEDED_PENALTY,
  MAX_SUPERSEDES,
} from "../lib/supersede.js";

const entry = (id, extra = {}) => ({ id, text: "t-" + id, summary: "s-" + id, tags: [], ...extra });

/* ── 标记 ─────────────────────────────────────────────────── */

test("基本覆盖：旧条目落 supersededBy/At，新条目记 supersedes", () => {
  const list = [entry("old"), entry("new")];
  const r = applySupersede(list, "new", ["old"], "2026-10-23T00:00:00.000Z");
  assert.deepEqual(r.applied, ["old"]);
  assert.equal(list[0].supersededBy, "new");
  assert.equal(list[0].supersededAt, "2026-10-23T00:00:00.000Z");
  assert.deepEqual(list[1].supersedes, ["old"]);
});

test("不能取代自己", () => {
  const list = [entry("a")];
  const r = applySupersede(list, "a", ["a"], "x");
  assert.deepEqual(r.skipped, [{ id: "a", reason: "self" }]);
  assert.equal(list[0].supersededBy, undefined);
});

test("目标不存在 → missing，不凭空造条目", () => {
  const list = [entry("a")];
  const r = applySupersede(list, "a", ["ghost"], "x");
  assert.deepEqual(r.missing, ["ghost"]);
  assert.equal(list.length, 1);
});

test("锁定的条目不参与覆盖（锁是用户明确的意志）", () => {
  const list = [entry("old", { locked: true }), entry("new")];
  const r = applySupersede(list, "new", ["old"], "x");
  assert.deepEqual(r.skipped, [{ id: "old", reason: "locked" }]);
  assert.equal(list[0].supersededBy, undefined);
});

test("已被别人取代的不改指向，除非 force", () => {
  const list = [entry("old", { supersededBy: "mid" }), entry("new")];
  const r = applySupersede(list, "new", ["old"], "x");
  assert.deepEqual(r.skipped, [{ id: "old", reason: "already-superseded" }]);
  assert.equal(list[0].supersededBy, "mid");

  const r2 = applySupersede(list, "new", ["old"], "x", { force: true });
  assert.deepEqual(r2.applied, ["old"]);
  assert.equal(list[0].supersededBy, "new");
});

test("重复的 oldIds 只处理一次", () => {
  const list = [entry("old"), entry("new")];
  const r = applySupersede(list, "new", ["old", "old", "old"], "x");
  assert.deepEqual(r.applied, ["old"]);
  assert.deepEqual(list[1].supersedes, ["old"]);
});

test("新条目自己的 supersedes 有上限", () => {
  const olds = Array.from({ length: 20 }, (_, i) => entry("o" + i));
  const list = [...olds, entry("new")];
  applySupersede(list, "new", olds.map((o) => o.id), "x");
  assert.equal(list[list.length - 1].supersedes.length, MAX_SUPERSEDES);
});

test("非法输入不炸", () => {
  assert.deepEqual(applySupersede(null, "a", ["b"], "x").applied, []);
  assert.deepEqual(applySupersede([], "", ["b"], "x").applied, []);
  assert.deepEqual(applySupersede([], "a", null, "x").applied, []);
});

/* ── 判定 ─────────────────────────────────────────────────── */

test("isSuperseded / validityFactor", () => {
  assert.equal(isSuperseded(entry("a")), false);
  assert.equal(validityFactor(entry("a")), 1);
  assert.equal(isSuperseded(entry("a", { supersededBy: "b" })), true);
  assert.equal(validityFactor(entry("a", { supersededBy: "b" })), SUPERSEDED_PENALTY);
  assert.ok(SUPERSEDED_PENALTY < 1 && SUPERSEDED_PENALTY > 0, "降权但不清零");
});

/* ── 链 ───────────────────────────────────────────────────── */

test("chainTip 走到最新那一版", () => {
  const list = [entry("v1", { supersededBy: "v2" }), entry("v2", { supersededBy: "v3" }), entry("v3")];
  assert.equal(chainTip(list, "v1").id, "v3");
  assert.equal(chainTip(list, "v2").id, "v3");
  assert.equal(chainTip(list, "v3").id, "v3");
});

test("chainTip 遇到环不卡死", () => {
  const list = [entry("a", { supersededBy: "b" }), entry("b", { supersededBy: "a" })];
  const tip = chainTip(list, "a", 8);
  assert.ok(tip === null || tip.id === "a" || tip.id === "b", "有界退出即可");
});

test("chainTip 找不到 id 返回 null", () => {
  assert.equal(chainTip([entry("a")], "zzz"), null);
});

/* ── 视图 ─────────────────────────────────────────────────── */

test("liveEntries 去掉已取代的，保留当前有效的", () => {
  const list = [entry("a", { supersededBy: "b" }), entry("b"), entry("c")];
  assert.deepEqual(liveEntries(list).map((e) => e.id), ["b", "c"]);
});

test("liveEntries 不改原数组", () => {
  const list = [entry("a", { supersededBy: "b" }), entry("b")];
  liveEntries(list);
  assert.equal(list.length, 2);
});

test("versionHistory 从链头排到链尾", () => {
  const list = [
    entry("v1", { supersededBy: "v2", supersedes: [] }),
    entry("v2", { supersededBy: "v3", supersedes: ["v1"] }),
    entry("v3", { supersedes: ["v2"] }),
  ];
  assert.deepEqual(versionHistory(list, "v2").map((e) => e.id), ["v1", "v2", "v3"]);
});

test("versionHistory 对孤儿条目返回自己", () => {
  const list = [entry("solo")];
  assert.deepEqual(versionHistory(list, "solo").map((e) => e.id), ["solo"]);
});

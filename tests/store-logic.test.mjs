/**
 * lib/store-logic.js 的单元测试 —— 零依赖，`node --test tests/store-logic.test.mjs` 直接跑。
 *
 * 这几条覆盖的正是「出错了也不会报错、但用户的记忆被悄悄弄乱」的地方。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { sortEntries, trimEntries, partitionRemoval, orphanVectorIds, clampInt } from "../lib/store-logic.js";

const entry = (id, updatedAt, pinned) => ({ id, updatedAt, pinned: pinned === true, summary: "s-" + id });
const ids = (list) => list.map((item) => item.id);

/* ── 排序 ─────────────────────────────────────────────────── */

test("排序：置顶优先，同组内新的在前（给 prompt 看的顺序）", () => {
  const list = [
    entry("a", "2026-01-01T00:00:00.000Z"),
    entry("b", "2026-03-01T00:00:00.000Z"),
    entry("c", "2026-02-01T00:00:00.000Z", true),
  ];
  assert.deepEqual(ids(sortEntries(list)), ["c", "b", "a"]);
});

test("排序：翻转开关后置顶在后、旧的在前（trim 用的顺序）", () => {
  const list = [
    entry("a", "2026-01-01T00:00:00.000Z"),
    entry("b", "2026-03-01T00:00:00.000Z"),
    entry("c", "2026-02-01T00:00:00.000Z", true),
  ];
  assert.deepEqual(ids(sortEntries(list, { pinnedFirst: false, newestFirst: false })), ["a", "b", "c"]);
});

test("排序：不改动入参（调用方还在用原数组）", () => {
  const list = [entry("a", "2026-01-01T00:00:00.000Z"), entry("b", "2026-02-01T00:00:00.000Z")];
  const before = ids(list);
  sortEntries(list);
  assert.deepEqual(ids(list), before);
});

test("排序：时间戳缺失/坏数据不抛，按「最旧」处理", () => {
  const list = [entry("a", undefined), { id: "b" }, { id: "c", updatedAt: 12345 }, null, entry("d", "2026-01-01T00:00:00.000Z")];
  const out = sortEntries(list);
  assert.equal(out.length, 5);
  assert.equal(out[0].id, "d", "有合法时间戳的排最前");
});

test("排序：空数组 / 非数组不炸", () => {
  assert.deepEqual(sortEntries([]), []);
  assert.deepEqual(sortEntries(null), []);
  assert.deepEqual(sortEntries(undefined), []);
});

/* ── 超限裁剪（置顶必须活下来）────────────────────────────── */

test("裁剪：没超上限时原样返回，一条不动", () => {
  const list = [entry("a", "2026-01-01T00:00:00.000Z"), entry("b", "2026-02-01T00:00:00.000Z")];
  const out = trimEntries(list, 5);
  assert.deepEqual(ids(out.kept), ["a", "b"]);
  assert.deepEqual(out.dropped, []);
});

test("裁剪：超上限时**置顶的一定留下**（哪怕它是最旧的）", () => {
  const list = [
    entry("old-pinned", "2020-01-01T00:00:00.000Z", true),
    entry("n1", "2026-01-05T00:00:00.000Z"),
    entry("n2", "2026-01-04T00:00:00.000Z"),
    entry("n3", "2026-01-03T00:00:00.000Z"),
    entry("n4", "2026-01-02T00:00:00.000Z"),
    entry("n5", "2026-01-01T00:00:00.000Z"),
  ];
  const out = trimEntries(list, 3);
  assert.equal(out.kept.length, 3);
  assert.ok(ids(out.kept).includes("old-pinned"), "置顶条目必须活下来");
  assert.deepEqual(ids(out.kept).sort(), ["n1", "n2", "old-pinned"]);
  assert.deepEqual(ids(out.dropped).sort(), ["n3", "n4", "n5"], "丢掉的按新→旧");
});

test("裁剪：置顶多到超过上限时，只按时间留最新的几个（并报出丢掉的）", () => {
  const list = [
    entry("p1", "2026-01-01T00:00:00.000Z", true),
    entry("p2", "2026-02-01T00:00:00.000Z", true),
    entry("p3", "2026-03-01T00:00:00.000Z", true),
  ];
  const out = trimEntries(list, 2);
  assert.deepEqual(ids(out.kept), ["p3", "p2"]);
  assert.deepEqual(ids(out.dropped), ["p1"]);
});

test("裁剪：恰好等于上限 → 完全不动（连重排都不做）", () => {
  const list = [entry("a", "2026-01-01T00:00:00.000Z"), entry("b", "2026-01-02T00:00:00.000Z")];
  const out = trimEntries(list, 2);
  assert.deepEqual(ids(out.kept), ["a", "b"], "没超限就保持入参顺序 —— 这是与原实现一致的契约");
  assert.deepEqual(out.dropped, []);
});

test("裁剪：上限非法 / 空数组不炸", () => {
  assert.deepEqual(trimEntries([], 0).kept, []);
  assert.deepEqual(trimEntries([entry("a", "x")], 0).dropped.length, 1);
  assert.deepEqual(trimEntries([entry("a", "x")], Number.NaN).dropped.length, 1);
  assert.deepEqual(trimEntries(null, 5).kept, []);
});

/* ── 批量删除（locked 必须挡住并报出来）───────────────────── */

test("删除：命中的删掉，没命中的原样留着", () => {
  const list = [entry("a", "x"), entry("b", "x"), entry("c", "x")];
  const out = partitionRemoval(list, ["a", "c"]);
  assert.deepEqual(out.removed, ["a", "c"]);
  assert.deepEqual(out.skipped, []);
  assert.deepEqual(ids(out.kept), ["b"]);
});

test("删除：locked 的条目**留下并报出来**（不许静默失败）", () => {
  const list = [entry("a", "x"), { id: "b", updatedAt: "x", locked: true }, entry("c", "x")];
  const out = partitionRemoval(list, ["a", "b", "c"]);
  assert.deepEqual(out.removed, ["a", "c"]);
  assert.deepEqual(out.skipped, ["b"]);
  assert.deepEqual(ids(out.kept), ["b"]);
});

test("删除：不存在的 id / 坏 id 不产生影响", () => {
  const list = [entry("a", "x")];
  const out = partitionRemoval(list, ["ghost", "", null, 42]);
  assert.deepEqual(out.removed, []);
  assert.deepEqual(ids(out.kept), ["a"]);
});

test("删除：空清单 / 非数组不炸", () => {
  assert.deepEqual(partitionRemoval([], ["a"]).removed, []);
  assert.deepEqual(partitionRemoval(null, ["a"]).kept, []);
  assert.deepEqual(partitionRemoval([entry("a", "x")], null).removed, []);
  assert.deepEqual(partitionRemoval([{ id: 5 }], ["5"]).removed, [], "id 不是字符串就不算命中");
});

/* ── 向量孤儿 ─────────────────────────────────────────────── */

test("孤儿：条目已删但向量还在 → 列为待清理", () => {
  assert.deepEqual(orphanVectorIds(["a", "b", "c"], ["a", "c"]), ["b"]);
});

test("孤儿：全都在 / 全都空 → 不误报", () => {
  assert.deepEqual(orphanVectorIds(["a"], ["a", "b"]), []);
  assert.deepEqual(orphanVectorIds([], ["a"]), []);
  assert.deepEqual(orphanVectorIds(["a", ""], []), ["a"]);
});

test("孤儿：坏输入不炸", () => {
  assert.deepEqual(orphanVectorIds(null, null), []);
  assert.deepEqual(orphanVectorIds([1, 2], ["a"]), []);
});

/* ── clampInt（与原实现逐字一致）──────────────────────────── */

test("clampInt：正常值被夹进范围并取整", () => {
  assert.equal(clampInt(5, 1, 10, 3), 5);
  assert.equal(clampInt(0, 1, 10, 3), 1);
  assert.equal(clampInt(99, 1, 10, 3), 10);
  assert.equal(clampInt(4.6, 1, 10, 3), 5, "四舍五入");
});

test("clampInt：非法输入直接返回 fallback（不夹取）", () => {
  assert.equal(clampInt(Number.NaN, 1, 10, 3), 3);
  assert.equal(clampInt(undefined, 1, 10, 3), 3);
  assert.equal(clampInt("abc", 1, 10, 3), 3);
  assert.equal(clampInt({}, 1, 10, 3), 3);
});

test("clampInt：字符串数字与 null 走 Number() 的语义", () => {
  assert.equal(clampInt("7", 1, 10, 3), 7);
  assert.equal(clampInt(null, 1, 10, 3), 1, "Number(null)===0 → 被夹到 min");
});

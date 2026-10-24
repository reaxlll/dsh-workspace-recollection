/**
 * lib/workspace-id.js + lib/workspace-migrate.js 的单元测试。
 * `node --test tests/workspace-migrate.test.mjs`
 *
 * 认领判错 = 两条工作区的记忆混在一起，所以「不该认领」的分支要钉得比「该认领」还牢。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { identityOf, normalizeParts, hashText, TOP_ENTRIES_MAX } from "../lib/workspace-id.js";
import { findClaimable, shouldDropOldKey } from "../lib/workspace-migrate.js";

const alive = () => true;
const dead = () => false;

/* ── 身份 ─────────────────────────────────────────────────── */

test("强指纹来自 git remote / 包名，与目录结构无关", () => {
  const a = identityOf({ gitRemote: "git@github.com:x/y.git", topEntries: ["src", "docs"] });
  const b = identityOf({ gitRemote: "git@github.com:x/y.git", topEntries: ["完全", "不同", "的", "结构"] });
  assert.equal(a.strength, "strong");
  assert.equal(a.strong, b.strong, "结构变了强指纹不该变");
});

test("没有 git / 包名时退化成弱指纹", () => {
  const id = identityOf({ topEntries: ["备份", "记忆检索精度", "插件生成"] });
  assert.equal(id.strength, "weak");
  assert.equal(id.strong, "");
  assert.ok(id.weak !== "");
});

test("什么都没有就是 none", () => {
  assert.equal(identityOf({}).strength, "none");
  assert.equal(identityOf(null).strength, "none");
});

test("顶层条目排序后才参与指纹（手工顺序变了不影响）", () => {
  const a = identityOf({ topEntries: ["b", "a", "c"] });
  const b = identityOf({ topEntries: ["c", "b", "a"] });
  assert.equal(a.weak, b.weak);
});

test("顶层条目有上限，且去重", () => {
  const many = Array.from({ length: 80 }, (_, i) => "f" + String(i).padStart(2, "0"));
  const parts = normalizeParts({ topEntries: [...many, ...many] });
  assert.equal(parts.topEntries.length, TOP_ENTRIES_MAX);
});

test("hashText 稳定且不同输入不同结果", () => {
  assert.equal(hashText("abc"), hashText("abc"));
  assert.notEqual(hashText("abc"), hashText("abd"));
  assert.ok(hashText("").startsWith("v"));
});

/* ── 认领决策 ─────────────────────────────────────────────── */

const oldBucket = (key, cwd, strong, weak) => ({ key, cwd, strong, weak });

test("强指纹一致 + 旧目录已不存在 → 认领", () => {
  const r = findClaimable(
    [oldBucket("e:/old", "E:\\old", "S1", "W1")],
    { key: "e:/new", strong: "S1", weak: "W9" },
    dead,
  );
  assert.equal(r.verdict, "claim");
  assert.equal(r.key, "e:/old");
});

test("强指纹一致但旧目录还在 → 只提示，不自动搬", () => {
  const r = findClaimable(
    [oldBucket("e:/copy", "E:\\copy", "S1", "W1")],
    { key: "e:/main", strong: "S1", weak: "W2" },
    alive,
  );
  assert.equal(r.verdict, "suggest");
  assert.equal(r.key, "");
});

test("弱指纹一致 + 旧目录不存在 → 认领（没有强特征的唯一出路）", () => {
  const r = findClaimable(
    [oldBucket("e:/old", "E:\\old", "", "W1")],
    { key: "e:/new", strong: "", weak: "W1" },
    dead,
  );
  assert.equal(r.verdict, "claim");
});

test("弱指纹一致但旧目录还在 → 不认领", () => {
  const r = findClaimable(
    [oldBucket("e:/other", "E:\\other", "", "W1")],
    { key: "e:/new", strong: "", weak: "W1" },
    alive,
  );
  assert.equal(r.verdict, "suggest");
});

test("有强指纹时不退化成弱指纹匹配（哪怕弱指纹相等）", () => {
  const r = findClaimable(
    [oldBucket("e:/other", "E:\\other", "S-other", "W-same")],
    { key: "e:/new", strong: "S-mine", weak: "W-same" },
    dead,
  );
  assert.equal(r.verdict, "none");
});

test("当前工作区已有记忆 → 什么都不做", () => {
  const r = findClaimable(
    [oldBucket("e:/new", "E:\\new", "S1", "W1")],
    { key: "e:/new", strong: "S1", weak: "W1" },
    dead,
  );
  assert.equal(r.verdict, "none");
});

test("多个候选 → ambiguous，宁可不动", () => {
  const r = findClaimable(
    [oldBucket("e:/a", "E:\\a", "S1", "W1"), oldBucket("e:/b", "E:\\b", "S1", "W2")],
    { key: "e:/new", strong: "S1", weak: "W3" },
    dead,
  );
  assert.equal(r.verdict, "ambiguous");
  assert.equal(r.key, "");
});

test("没有任何身份特征 → 不认领", () => {
  const r = findClaimable([], { key: "e:/new", strong: "", weak: "" }, dead);
  assert.equal(r.verdict, "none");
});

test("key 为空 → 不认领", () => {
  assert.equal(findClaimable([], { key: "", strong: "S", weak: "W" }, dead).verdict, "none");
});

test("坏输入不炸", () => {
  assert.equal(findClaimable(null, null, null).verdict, "none");
  assert.equal(findClaimable([null, 3], { key: "a", strong: "S" }, dead).verdict, "none");
});

test("认领后旧 key 要删掉（搬家不是复制）", () => {
  assert.equal(shouldDropOldKey(), true);
});

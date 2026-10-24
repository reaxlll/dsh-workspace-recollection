/**
 * lib/lexical.js 的单元测试 —— `node --test tests/lexical.test.mjs` 直接跑。
 *
 * 这一层是纯打分，出错了不报错、只是悄悄把排序搞乱，所以每条规则都钉死。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { tokenize, buildIndex, scoreAll, rankOf, rrfFuse, normalizeFused, BM25_K1, RRF_K } from "../lib/lexical.js";

/* ── 分词 ─────────────────────────────────────────────────── */

test("中文切 bigram，单字单独成元", () => {
  assert.deepEqual(tokenize("记忆插件"), ["记忆", "忆插", "插件"]);
  assert.deepEqual(tokenize("好"), ["好"]);
});

test("ASCII 词元小写化，路径/版本号原样保留", () => {
  const t = tokenize("改了 Lib/Index.JS 的 v2.10.0");
  assert.ok(t.includes("lib/index.js"));
  assert.ok(t.includes("v2.10.0"));
});

test("中英混排两路都要抓到", () => {
  const t = tokenize("端口 50247 被占用");
  assert.ok(t.includes("50247"));
  assert.ok(t.includes("端口"));
  assert.ok(t.includes("占用"));
});

test("空输入返回空数组", () => {
  assert.deepEqual(tokenize(""), []);
  assert.deepEqual(tokenize(null), []);
});

/* ── 索引与 BM25 ──────────────────────────────────────────── */

const DOCS = [
  "记忆插件 v2.5.0 升级，端口 50247",
  "记忆插件 v2.7.0 升级，端口 50251",
  "完全不同的一条：表情包库在哪",
];

test("buildIndex 的统计量自洽", () => {
  const idx = buildIndex(DOCS);
  assert.equal(idx.n, 3);
  assert.equal(idx.len.length, 3);
  assert.ok(idx.avgLen > 0);
  assert.equal(idx.df.get("插件"), 2);
});

test("BM25 能把版本号区分开（这正是向量做不到的）", () => {
  const idx = buildIndex(DOCS);
  const scores = scoreAll(idx, "v2.7.0 的端口");
  assert.ok(scores[1] > scores[0], "v2.7.0 那条应该高于 v2.5.0 那条");
  assert.equal(scores[2], 0, "完全无关的那条不该得分");
});

test("query 里的词全不在库里 → 全零，不产生随机噪音", () => {
  const idx = buildIndex(DOCS);
  const scores = scoreAll(idx, "量子纠缠 超导体");
  assert.deepEqual(scores, [0, 0, 0]);
});

test("空 query / 空索引都返回全零数组", () => {
  assert.deepEqual(scoreAll(buildIndex(DOCS), ""), [0, 0, 0]);
  assert.deepEqual(scoreAll(buildIndex([]), "记忆"), []);
});

test("词频饱和：同一个词出现 10 次不会线性放大", () => {
  const idx = buildIndex(["记忆 记忆 记忆 记忆 记忆 记忆 记忆 记忆 记忆 记忆 插件", "记忆 端口"]);
  const scores = scoreAll(idx, "记忆");
  assert.ok(Number.isFinite(scores[0]) && Number.isFinite(scores[1]));
  // k1=1.2 意味着词频从 10 降到 1 时分数掉不到十分之一
  assert.ok(scores[0] < scores[1] * 10);
});

/* ── 名次 ─────────────────────────────────────────────────── */

test("rankOf：降序名次，从 1 起", () => {
  assert.deepEqual(rankOf([0.2, 0.8, 0.5]), [3, 1, 2]);
});

test("rankOf：并列按原顺序，名次连续", () => {
  assert.deepEqual(rankOf([0.5, 0.5, 0.1]), [1, 2, 3]);
});

test("rankOf：NaN 当 0 处理，不炸", () => {
  assert.deepEqual(rankOf([NaN, 0.3]), [2, 1]);
  assert.deepEqual(rankOf([]), []);
});

/* ── RRF ──────────────────────────────────────────────────── */

test("两路都排第一的，融合分最高", () => {
  const fused = rrfFuse([
    [{ key: "a", rank: 1 }, { key: "b", rank: 2 }],
    [{ key: "a", rank: 1 }, { key: "c", rank: 2 }],
  ]);
  assert.ok(fused.get("a") > fused.get("b"));
  assert.ok(fused.get("a") > fused.get("c"));
  assert.equal(fused.get("a"), 2 / (RRF_K + 1));
});

test("只出现在一路里的 key 也有分（不会因为另一路没有就归零）", () => {
  const fused = rrfFuse([
    [{ key: "a", rank: 1 }],
    [{ key: "b", rank: 1 }],
  ]);
  assert.equal(fused.get("a"), fused.get("b"));
  assert.ok(fused.get("a") > 0);
});

test("一路第 1 + 一路第 5，胜过两路都第 3（RRF 偏袒「被某一路强烈认可」的）", () => {
  const fused = rrfFuse([
    [{ key: "x", rank: 1 }, { key: "y", rank: 3 }],
    [{ key: "y", rank: 3 }, { key: "x", rank: 5 }],
  ]);
  assert.ok(fused.get("x") > fused.get("y"));
  // 名次和相同则分相同（1+5 与 3+3 都是 6，但 RRF 是非线性的，所以不相等 —— 这正是它偏袒头名的原因）
  assert.ok(Math.abs(fused.get("x") - fused.get("y")) > 1e-9);
});

test("坏数据不炸", () => {
  assert.equal(rrfFuse(null).size, 0);
  assert.equal(rrfFuse([null, 3, [{ key: "" }]]).size, 0);
});

/* ── 归一化 ───────────────────────────────────────────────── */

test("normalizeFused：两路都第一 = 1", () => {
  const fused = 2 / (RRF_K + 1);
  assert.equal(normalizeFused(fused, 2), 1);
});

test("normalizeFused：落在 0~1，且单调", () => {
  const a = normalizeFused(1 / (RRF_K + 1), 2);
  const b = normalizeFused(2 / (RRF_K + 1), 2);
  assert.ok(a > 0 && a < b && b <= 1);
});

test("normalizeFused：非法输入收敛到 0", () => {
  assert.equal(normalizeFused(NaN, 2), 0);
  assert.equal(normalizeFused(-5, 2), 0);
  assert.equal(normalizeFused(1, 0), 1);
});

test("BM25_K1 是正的有限数（参数被改坏要立刻发现）", () => {
  assert.ok(Number.isFinite(BM25_K1) && BM25_K1 > 0);
});

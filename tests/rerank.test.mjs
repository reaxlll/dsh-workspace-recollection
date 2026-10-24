/**
 * lib/rerank.js 的单元测试 —— 纯逻辑部分（模型加载不测，那要真权重）。
 * `node --test tests/rerank.test.mjs`
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  missingRerankFiles,
  isRerankComplete,
  rerankModelUrl,
  mergeRerank,
  RERANK_FILES,
  RERANK_MODEL_ID,
  RERANK_TOP,
} from "../lib/rerank.js";

test("模型文件清单自洽（改坏了要立刻发现）", () => {
  assert.ok(RERANK_FILES.length >= 4);
  assert.equal(RERANK_FILES[0].rel, "config.json");
  assert.ok(RERANK_FILES.every((item) => typeof item.min === "number" && item.min > 0));
});

test("missingRerankFiles：缺的报出来，够大的不报", () => {
  const sizes = { "config.json": 782, "tokenizer.json": 17098079 };
  const missing = missingRerankFiles(sizes).map((item) => item.rel);
  assert.ok(!missing.includes("config.json"));
  assert.ok(!missing.includes("tokenizer.json"));
  assert.ok(missing.includes("onnx/model_quantized.onnx"));
});

test("missingRerankFiles：截断的文件算缺（大小低于阈值）", () => {
  const sizes = { "config.json": 100 };
  assert.ok(missingRerankFiles(sizes).some((item) => item.rel === "config.json"));
});

test("isRerankComplete：全齐才 true", () => {
  const all = {};
  for (const item of RERANK_FILES) all[item.rel] = item.min + 1;
  assert.equal(isRerankComplete(all), true);
  assert.equal(isRerankComplete({}), false);
  assert.equal(isRerankComplete(null), false);
});

test("rerankModelUrl 拼出镜像地址", () => {
  assert.equal(
    rerankModelUrl("https://hf-mirror.com/", "onnx/model_quantized.onnx"),
    "https://hf-mirror.com/" + RERANK_MODEL_ID + "/resolve/main/onnx/model_quantized.onnx",
  );
});

/* ── 融合（这一层出错不会报错，只会悄悄把顺序弄乱）─────────────── */

test("mergeRerank：头部按重排分重排，尾部原样接上", () => {
  const ids = ["a", "b", "c", "d", "e"];
  const scores = [0.1, 0.9, 0.5];
  assert.deepEqual(mergeRerank(ids, scores, 3), ["b", "c", "a", "d", "e"]);
});

test("mergeRerank：head 大于候选数时按候选数处理", () => {
  const ids = ["a", "b"];
  assert.deepEqual(mergeRerank(ids, [0.2, 0.8], 10), ["b", "a"]);
});

test("mergeRerank：head <= 1 时原样返回（没有可重排的）", () => {
  assert.deepEqual(mergeRerank(["a", "b"], [0.9, 0.1], 1), ["a", "b"]);
  assert.deepEqual(mergeRerank(["a", "b"], [0.9, 0.1], 0), ["a", "b"]);
});

test("mergeRerank：缺失/Bad 分数沉底但保留", () => {
  const ids = ["a", "b", "c"];
  assert.deepEqual(mergeRerank(ids, [NaN, 0.5, undefined], 3), ["b", "a", "c"]);
});

test("mergeRerank：并列时保持原顺序（稳定）", () => {
  const ids = ["x", "y", "z"];
  assert.deepEqual(mergeRerank(ids, [0.5, 0.5, 0.5], 3), ["x", "y", "z"]);
});

test("mergeRerank：不改输入数组", () => {
  const ids = ["a", "b", "c"];
  mergeRerank(ids, [0.1, 0.9, 0.5], 3);
  assert.deepEqual(ids, ["a", "b", "c"]);
});

test("mergeRerank：坏输入不炸", () => {
  assert.deepEqual(mergeRerank(null, null, 3), []);
  assert.deepEqual(mergeRerank(["a"], null, 2), ["a"]);
});

test("RERANK_TOP 在合理区间（太小没收益、太大延迟爆炸）", () => {
  assert.ok(RERANK_TOP >= 10 && RERANK_TOP <= 50);
});

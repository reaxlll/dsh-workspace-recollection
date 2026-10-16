/**
 * lib/model.js 的单元测试 —— 零依赖，`node --test tests/model.test.mjs` 直接跑。
 * 用例里的文件大小取自真实的 `Xenova/bge-small-zh-v1.5`（q8 量化版）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { EMBED_MODEL_ID, MODEL_FILES, MODEL_MIRRORS, modelUrl, missingFiles, isComplete } from "../lib/model.js";

const COMPLETE = {
  "config.json": 716,
  "tokenizer.json": 439125,
  "tokenizer_config.json": 367,
  "special_tokens_map.json": 125,
  "vocab.txt": 109540,
  "onnx/model_quantized.onnx": 24010842,
};

test("清单：模型标识与目录名一致，六个文件都在", () => {
  assert.equal(EMBED_MODEL_ID, "Xenova/bge-small-zh-v1.5");
  assert.equal(MODEL_FILES.length, 6);
  assert.ok(MODEL_FILES.some((item) => item.rel === "onnx/model_quantized.onnx"));
  assert.ok(MODEL_FILES.every((item) => typeof item.rel === "string" && item.rel !== "" && item.min > 0));
});

test("齐全判定：真实大小 → 齐全", () => {
  assert.equal(isComplete(COMPLETE), true);
  assert.deepEqual(missingFiles(COMPLETE), []);
});

test("缺失判定：空表 / null → 全缺", () => {
  assert.equal(isComplete({}), false);
  assert.equal(missingFiles({}).length, 6);
  assert.equal(isComplete(null), false);
  assert.equal(isComplete(undefined), false);
});

test("下了一半的不冒充完整（截断检测）", () => {
  const half = { ...COMPLETE, "onnx/model_quantized.onnx": 12000000 };
  assert.equal(isComplete(half), false);
  assert.deepEqual(missingFiles(half).map((item) => item.rel), ["onnx/model_quantized.onnx"]);
});

test("空文件 / 坏值不算完整", () => {
  assert.equal(isComplete({ ...COMPLETE, "config.json": 0 }), false);
  assert.equal(isComplete({ ...COMPLETE, "vocab.txt": null }), false);
  assert.equal(isComplete({ ...COMPLETE, "tokenizer.json": Number.NaN }), false);
  assert.equal(isComplete({ ...COMPLETE, "tokenizer.json": "439125" }), false, "字符串不算数");
});

test("下载地址：镜像拼接 + 斜杠归一", () => {
  assert.equal(
    modelUrl("https://hf-mirror.com", "config.json"),
    "https://hf-mirror.com/Xenova/bge-small-zh-v1.5/resolve/main/config.json",
  );
  assert.equal(
    modelUrl("https://hf-mirror.com/", "/onnx/model_quantized.onnx"),
    "https://hf-mirror.com/Xenova/bge-small-zh-v1.5/resolve/main/onnx/model_quantized.onnx",
  );
  assert.equal(MODEL_MIRRORS[0], "https://hf-mirror.com", "镜像优先（官方在后）");
  assert.ok(MODEL_MIRRORS.length >= 2);
});

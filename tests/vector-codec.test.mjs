/**
 * lib/vector-codec.js 的单元测试 —— 零依赖，`node --test tests/vector-codec.test.mjs` 直接跑。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeVector, decodeVector, isEncoded, decodeVectorOfDim, normalizeChunks, migrateVectorsV2ToV3 } from "../lib/vector-codec.js";

const DIM = 512;
const sample = Array.from({ length: DIM }, (_v, i) => Math.sin(i / 7) * 0.3);

test("往返：编解码后数值一致（float32 精度）", () => {
  const text = encodeVector(sample);
  assert.equal(typeof text, "string");
  assert.ok(text.length > 0);
  const back = decodeVector(text);
  assert.equal(back.length, DIM);
  for (let i = 0; i < DIM; i += 1) {
    // float32 有约 7 位有效数字；原值也是 float32 精度范围内的小数
    assert.ok(Math.abs(back[i] - sample[i]) < 1e-6, "第 " + String(i) + " 位偏差过大");
  }
});

test("定长：512 维编出来是固定长度（2048 字节 → 2732 字符 base64）", () => {
  const text = encodeVector(sample);
  assert.equal(Buffer.from(text, "base64").length, 2048);
  assert.equal(text.length, 2732);
});

test("体积：比「保留 5 位小数写进 JSON」明显更小", () => {
  const asJson = JSON.stringify(sample.map((v) => Math.round(v * 100000) / 100000));
  const asBase64 = JSON.stringify(encodeVector(sample));
  assert.ok(asBase64.length < asJson.length, "base64 应比数字数组的 JSON 文本短");
});

test("精度：float32 比原来的 5 位小数更准", () => {
  const tricky = [Math.PI, 1 / 3, 1e-7, -0.000123456789];
  const back = decodeVector(encodeVector(tricky));
  assert.ok(Math.abs(back[0] - Math.PI) < 1e-6);
  assert.ok(Math.abs(back[1] - 1 / 3) < 1e-6);
  assert.ok(Math.abs(back[2] - 1e-7) < 1e-12, "极小值也能保住");
  assert.ok(Math.abs(back[3] - (-0.000123456789)) < 1e-9, "5 位小数写法会把它抹成 -0.00012");
});

test("坏输入：空 / null / 乱码 / 长度不对 → 一律 null，不抛", () => {
  assert.equal(decodeVector(""), null);
  assert.equal(decodeVector(null), null);
  assert.equal(decodeVector(undefined), null);
  assert.equal(decodeVector(123), null);
  assert.equal(decodeVector("!!!!"), null);
  assert.equal(encodeVector(null), "");
  assert.equal(encodeVector([]), "");
  assert.equal(encodeVector("不是数组"), "");
});

test("isEncoded：区分新格式（字符串）与旧格式（数字数组）", () => {
  assert.equal(isEncoded(encodeVector(sample)), true);
  assert.equal(isEncoded(sample), false);
  assert.equal(isEncoded(""), false);
  assert.equal(isEncoded(null), false);
});

test("维度校验：长度不符的向量被丢弃（避免维度错位污染余弦）", () => {
  const wrong = encodeVector([1, 2, 3]);
  assert.equal(decodeVectorOfDim(wrong, DIM), null);
  assert.equal(decodeVectorOfDim(encodeVector(sample), DIM).length, DIM);
  assert.equal(decodeVectorOfDim(encodeVector(sample), 0).length, DIM, "dim 非法时只做解码，不校验");
});

test("深层多块：字符串数组解码 + 旧数字数组兼容 + 上限截断", () => {
  const chunks = [encodeVector(sample), sample, encodeVector(sample)];
  const out = normalizeChunks(chunks, DIM, 24);
  assert.equal(out.length, 3);
  assert.equal(out[1].length, DIM, "旧的数字数组形式照常接受");
  assert.equal(normalizeChunks(chunks, DIM, 2).length, 2, "上限生效");
  assert.equal(normalizeChunks([], DIM, 24), null);
  assert.equal(normalizeChunks(null, DIM, 24), null);
  assert.equal(normalizeChunks(["!!!", "???"], DIM, 24), null, "全是坏数据 → null");
  assert.equal(normalizeChunks(["!!!", encodeVector(sample)], DIM, 24).length, 1, "坏块跳过，好的留下");
});

/* ── v2 → v3 迁移 ─────────────────────────────────────────── */

test("迁移 v2→v3：数字数组换成 base64，维度/数值/时间戳都不丢", () => {
  const v2 = {
    version: 2,
    model: "Xenova/bge-small-zh-v1.5",
    dim: DIM,
    workspaces: { "e:\\demo": { m1: { at: "2026-01-02T03:04:05.000Z", s: sample, d: [sample, sample] } } },
  };
  const v3 = migrateVectorsV2ToV3(v2);
  assert.equal(v3.version, 3);
  assert.equal(v3.model, "Xenova/bge-small-zh-v1.5");
  assert.equal(v3.dim, DIM);
  const rec = v3.workspaces["e:\\demo"].m1;
  assert.equal(typeof rec.s, "string", "浅层改成 base64");
  assert.equal(rec.d.length, 2);
  assert.equal(typeof rec.d[0], "string", "深层每块也改成 base64");
  assert.equal(rec.at, "2026-01-02T03:04:05.000Z", "写入时间必须留住");
  const back = decodeVector(rec.s);
  assert.equal(back.length, DIM);
  assert.ok(Math.abs(back[100] - sample[100]) < 1e-6);
});

test("迁移 v2→v3：幂等（对已迁移过的数据再跑一次无副作用）", () => {
  const once = migrateVectorsV2ToV3({ version: 2, dim: DIM, workspaces: { w: { m: { at: "t", s: sample } } } });
  const twice = migrateVectorsV2ToV3(once);
  assert.equal(twice.version, 3);
  assert.equal(twice.workspaces.w.m.s, once.workspaces.w.m.s, "base64 原样带走");
});

test("迁移 v2→v3：坏数据不炸、空库不炸、坏块原样留着", () => {
  assert.equal(migrateVectorsV2ToV3(null).version, 3);
  assert.deepEqual(migrateVectorsV2ToV3({}).workspaces, {});
  assert.deepEqual(migrateVectorsV2ToV3({ workspaces: { w: null, v: 3 } }).workspaces, {}, "非对象桶被跳过");
  assert.deepEqual(migrateVectorsV2ToV3({ workspaces: { x: { bad: 42 } } }).workspaces, { x: {} }, "非对象条目被跳过，空桶保留");
  const mixed = migrateVectorsV2ToV3({ workspaces: { w: { a: { s: sample, d: [sample, "已损坏", sample] } } } });
  assert.equal(mixed.workspaces.w.a.d.length, 3, "坏块原样留着 —— 迁移不静默删东西");
});

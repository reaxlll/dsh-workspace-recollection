/**
 * lib/noise.js 的 v2.14 新增部分：缺席词判据。
 * `node --test tests/absent.test.mjs`
 *
 * 这条规则会直接让 memory_recall 返回「没找到」，判错了就是在说谎 —— 所以边界要钉死。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { queryAsciiWords, absentWords, ABSENT_WORD_MIN, ABSENT_TOP1_MAX } from "../lib/noise.js";

/* ── 提取 ─────────────────────────────────────────────────── */

test("提取 ASCII 专名，去重并忽略大小写", () => {
  assert.deepEqual(queryAsciiWords("frp 穿透和 FRP 端口"), ["frp"]);
});

test("太短的词不算（2 字符以内没判别力）", () => {
  assert.deepEqual(queryAsciiWords("a bb ccc"), ["ccc"]);
  assert.equal(ABSENT_WORD_MIN, 3);
});

test("URL 整体剥掉（碎片词不该拿来判「没记过」）", () => {
  assert.deepEqual(queryAsciiWords("https://github.com/topics/dsh-plugin"), []);
  assert.deepEqual(queryAsciiWords("看下 https://example.com/a/b 这个和 frp"), ["frp"]);
});

test("中文 query 提不出词就返回空（不能拿空数组去判「没记过」）", () => {
  assert.deepEqual(queryAsciiWords("昨天我们干了什么"), []);
});

test("版本号这类也照常提（它们同样是「没出现过就是没记过」）", () => {
  assert.ok(queryAsciiWords("v9.8.1 那个补丁").includes("v9.8.1"));
});

test("尾部的斜杠/冒号会被剥掉", () => {
  assert.ok(queryAsciiWords("看 lib/index.js/ 这里").includes("lib/index.js"));
});

test("坏输入不炸", () => {
  assert.deepEqual(queryAsciiWords(null), []);
  assert.deepEqual(queryAsciiWords(undefined), []);
  assert.deepEqual(queryAsciiWords(42), []);
});

/* ── 判缺席 ───────────────────────────────────────────────── */

test("全都不出现 → 全部报出来", () => {
  const hay = ["记忆插件 v2.10 上线", "表情包库在哪"];
  assert.deepEqual(absentWords(["frp", "kubeconfig"], hay), ["frp", "kubeconfig"]);
});

test("有一个出现过 → 那个不算缺席", () => {
  const hay = ["用 frp 做了内网穿透"];
  assert.deepEqual(absentWords(["frp", "kubeconfig"], hay), ["kubeconfig"]);
});

test("大小写不敏感（库里写 Frp 也算出现过）", () => {
  assert.deepEqual(absentWords(["frp"], ["Frp 穿透配置"]), []);
});

test("空输入返回空（没词或没库都不能判缺席）", () => {
  assert.deepEqual(absentWords([], ["任何东西"]), []);
  assert.deepEqual(absentWords(["frp"], []), []);
  assert.deepEqual(absentWords(null, null), []);
});

test("只在部分条目里出现也算出现过", () => {
  const hay = Array.from({ length: 100 }, (_, i) => "记忆 " + i);
  hay[73] = "这里提过 Dockerfile";
  assert.deepEqual(absentWords(["Dockerfile"], hay), []);
});

/* ── 常量 ─────────────────────────────────────────────────── */

test("分数闸在合理区间（太高会误判高置信命中，太低等于没有闸）", () => {
  assert.ok(ABSENT_TOP1_MAX > 0.6 && ABSENT_TOP1_MAX <= 0.8);
});

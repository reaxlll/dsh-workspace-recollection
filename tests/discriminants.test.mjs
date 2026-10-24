/**
 * lib/discriminants.js 的单元测试 —— `node --test tests/discriminants.test.mjs` 直接跑。
 *
 * 这一层的 ROI 全在「抓得准不准」：抓漏了等于没做，抓多了往索引里灌噪音。
 * 所以测试分两半——该抓的一定要抓到，不该抓的（裸数字、小数、中文标点）一定别进来。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractAnchors,
  anchorValues,
  anchorLine,
  anchorHits,
  anchorBoost,
  normalizeAnchors,
  MAX_ANCHORS,
} from "../lib/discriminants.js";

const vals = (text) => anchorValues(extractAnchors(text));
const has = (text, value) => vals(text).includes(value);

/* ── 该抓的 ───────────────────────────────────────────────── */

test("抓版本号：三段式与 v 前缀", () => {
  assert.ok(has("记忆插件 v2.10.0 上线", "2.10.0"));
  assert.ok(has("bge-small-zh-v1.5 是现状模型", "1.5"), "带 v 前缀的两段版本号要抓，模型名里的 v1.5 正是判别串");
  assert.ok(has("迁移到 2.3.1 版本", "2.3.1"));
  assert.ok(has("状态存储 STORE_VERSION=5，版本 5", "5"));
});

test("抓 v 前缀的两段版本号，但不抓裸小数", () => {
  assert.ok(has("现在跑在 v2.10", "2.10"));
  assert.ok(vals("相似度中位 0.658，p95 0.792").every((v) => !/^0\./.test(v)), "裸小数不该进索引");
});

test("抓 Windows 路径与家目录路径", () => {
  assert.ok(has("装在 E:\\DSHwork\\插件生成 下", "E:\\DSHwork\\插件生成"));
  assert.ok(has("配置在 ~/.dsh/plugins/dsh-session-memory", "~/.dsh/plugins/dsh-session-memory"));
  assert.ok(has("看 /usr/local/bin/memt", "/usr/local/bin/memt"));
});

test("抓文件名（只认常见扩展名）", () => {
  assert.ok(has("改 lib/index.js 和 package.json", "lib/index.js"));
  assert.ok(has("改 lib/index.js 和 package.json", "package.json"));
  assert.ok(has("向量存 vectors.json", "vectors.json"));
});

test("抓端口，但只认冒号或关键词后面那种", () => {
  assert.ok(has("GUI 在 127.0.0.1:50247", "50247"));
  assert.ok(has("端口 30000 是 SGLang", "30000"));
  assert.ok(has("port 8080 起服务", "8080"));
});

test("抓日期：ISO 与中文写法", () => {
  assert.ok(has("2026-10-23 这天", "2026-10-23"));
  assert.ok(has("10月23日 的会话", "10月23日"));
});

test("抓稳定标识符与反引号里的代码", () => {
  assert.ok(has("条目 mem_mv9iqanh_yrdndq 要删", "mem_mv9iqanh_yrdndq"));
  assert.ok(has("task-1 已完成", "task-1"));
  assert.ok(has("用 `pnpm add ./plugin` 装", "pnpm add ./plugin"));
});

test("抓 URL", () => {
  assert.ok(has("见 https://arxiv.org/abs/2610.26825 这篇", "https://arxiv.org/abs/2610.26825"));
});

/* ── 不该抓的 ─────────────────────────────────────────────── */

test("不抓裸数字与中文标点", () => {
  const out = vals("232 条记忆、1734 个深层块，命中 71%，R@1 是 0.400");
  assert.deepEqual(out, [], "纯数字/百分比/小数都不该算判别串，实际：" + JSON.stringify(out));
});

test("不抓孤零零的斜杠片段", () => {
  assert.equal(vals("/b 这种").includes("/b"), false);
});

/* ── 结构约束 ─────────────────────────────────────────────── */

test("按规则优先级排序，且同类去重", () => {
  const out = extractAnchors("v2.10.0 v2.10.0 2026-10-23 mem_abc lib/x.js");
  const values = out.map((item) => item.value);
  assert.equal(values.filter((v) => v === "2.10.0").length, 1, "同值只留一个");
  const kinds = out.map((item) => item.kind);
  assert.ok(kinds.indexOf("file") < kinds.indexOf("version"), "文件应先于版本号（规则优先级）");
});

test("上限截断", () => {
  const many = Array.from({ length: 40 }, (_, i) => "file" + i + ".json").join(" ");
  assert.equal(extractAnchors(many).length, MAX_ANCHORS);
  assert.equal(extractAnchors(many, { max: 3 }).length, 3);
});

test("空输入不炸", () => {
  assert.deepEqual(extractAnchors(""), []);
  assert.deepEqual(extractAnchors(null), []);
  assert.deepEqual(extractAnchors(undefined), []);
});

test("anchorLine 用尖括号包住、可空", () => {
  assert.equal(anchorLine([]), "");
  assert.equal(anchorLine(extractAnchors("package.json")), "⟪package.json⟫");
  assert.ok(anchorLine(extractAnchors("v2.10.0 和 lib/a.js")).startsWith("⟪"));
});

/* ── 加权 ─────────────────────────────────────────────────── */

test("同类型同值才算命中：跨类型不算", () => {
  const q = extractAnchors("v2.10.0");
  const same = extractAnchors("升级到 2.10.0，改了 lib/index.js");
  const other = extractAnchors("端口 21000 被占用");
  assert.equal(anchorHits(q, same), 1);
  assert.equal(anchorHits(q, other), 0);
});

test("大小写不敏感", () => {
  const q = [{ kind: "file", value: "Package.JSON" }];
  const e = [{ kind: "file", value: "package.json" }];
  assert.equal(anchorHits(q, e), 1);
});

test("加分对数增长、有封顶、命中越多不倒退", () => {
  assert.equal(anchorBoost(0), 0);
  assert.ok(anchorBoost(1) > 0);
  assert.ok(anchorBoost(2) > anchorBoost(1));
  assert.ok(anchorBoost(50) <= 0.12 + 1e-9);
  assert.ok(anchorBoost(-3) === 0);
});

/* ── 惰性兼容老条目 ───────────────────────────────────────── */

test("老条目没有 anchors 字段时从正文现算", () => {
  const out = normalizeAnchors(undefined, "改了 lib/index.js，版本 2.10.0");
  assert.ok(out.some((item) => item.value === "lib/index.js"));
});

test("已有 anchors 时原样采用（不重新抽，避免与已入库向量错位）", () => {
  const out = normalizeAnchors([{ kind: "file", value: "keep.json" }], "正文里写的是 lib/index.js");
  assert.deepEqual(out.map((i) => i.value), ["keep.json"]);
});

test("坏的 anchors 数据不会污染结构", () => {
  const out = normalizeAnchors([null, 3, { kind: "x" }, { value: "y" }], "");
  // 只有 value 没 kind 的算「misc」，不该被丢掉（宁可少分类也别丢串）；value 都没有的直接消失
  assert.deepEqual(out, [{ kind: "misc", value: "y" }]);
});

/**
 * lib/noise.js 的单元测试 —— 零依赖，直接 `node tests/noise.test.mjs` 跑。
 * 用例里的分数都是**真实回放出来的**（见交付说明：8 条真实查询的 top-8 分布），
 * 所以这组测试同时是「阈值有没有被改坏」的回归网。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { filterHits, hardTokensOf, hardHitCount, scoreEntry, rareHitOk, DEEP_GATE, INDEX_DF_MAX } from "../lib/noise.js";

const entry = (id, summary, tags = [], text = "") => ({ id, summary, tags, text });
const row = (id, score, summary, tags = [], text = "") => ({ entry: entry(id, summary, tags, text), score, layer: "shallow" });

const ids = (rows) => rows.map((item) => item.id);
const entryIds = (rows) => rows.map((item) => item.entry.id);

/* ── hardTokensOf ───────────────────────────────────────────── */

test("硬特征：抓 ASCII 专有名词 / 路径 / 常量名", () => {
  assert.deepEqual(hardTokensOf("PowerShell UTF8 编码 踩坑"), ["PowerShell", "UTF8"]);
  assert.deepEqual(hardTokensOf("dsh-workspace-recollection 的 MAX_TEXT_CHARS 在哪"), ["dsh-workspace-recollection", "MAX_TEXT_CHARS"]);
  // 反斜杠在词元内保留、结尾的路径分隔符被剥掉
  assert.deepEqual(hardTokensOf("E:\\work\\某目录 的路径"), ["E:\\work"]);
});

test("硬特征：纯中文泛指词不算（那是语义检索的活）", () => {
  assert.deepEqual(hardTokensOf("上次说的那个坑是什么来着"), []);
  assert.deepEqual(hardTokensOf("帮我看一下这个函数为什么报错"), []);
});

test("硬特征：emoji 算一个；去重不分大小写、最多 12 个", () => {
  assert.deepEqual(hardTokensOf("🐳 主题色"), ["🐳"]);
  assert.deepEqual(hardTokensOf("TTS TTS tts"), ["TTS"]);
  const many = Array.from({ length: 15 }, (_v, i) => "token" + String.fromCharCode(97 + i)).join(" ");
  assert.equal(hardTokensOf(many).length, 12);
});

test("硬特征命中：只查要点与标签，不查正文", () => {
  const target = entry("m1", "PowerShell 5.1 禁用 Get-Content", ["踩坑"], "正文里提到了 Markdown 和 emoji");
  assert.equal(hardHitCount(target, ["PowerShell"]), 1);
  assert.equal(hardHitCount(target, ["Markdown"]), 0, "正文里的词不该算命中");
  assert.equal(hardHitCount(target, ["踩坑"]), 1, "标签也算");
});

/* ── ① 绝对底线 ─────────────────────────────────────────────── */

test("底线：整体低于 0.45 → 一条都不留，并说明", () => {
  const rows = [row("m1", 0.402, "历史会话 A"), row("m2", 0.398, "历史会话 B")];
  const result = filterHits(rows, "今天晚饭吃什么好呢 天气怎么样");
  assert.equal(result.kept.length, 0);
  assert.equal(result.dropped.length, 2);
  assert.ok(result.dropped.every((item) => item.reason === "weak"));
  assert.match(result.notes.join("\n"), /没有明显相关的记忆/);
});

/* ── ② 硬特征 ───────────────────────────────────────────────── */

test("nokey：query 有两个以上硬特征时，要点一个都对不上就略去（哪怕分数更高）", () => {
  const rows = [
    row("m1", 0.732, "[踩坑/run_code] 模板字符串里写转义会让 TS 解析报错"),
    row("m2", 0.663, "PowerShell 5.1 禁用 Get-Content 和 Set-Content -Encoding UTF8", ["环境/踩坑"]),
  ];
  const result = filterHits(rows, "PowerShell UTF8 编码 踩坑");
  assert.deepEqual(entryIds(result.kept), ["m2"]);
  assert.deepEqual(ids(result.dropped), ["m1"]);
  assert.equal(result.dropped[0].reason, "nokey");
});

test("nokey 不误杀：query 只有一个硬特征时不开硬切（星标那条实测）", () => {
  const rows = [
    row("m1", 0.6693, "星标太浅需加深，支持自定义 emoji 替代"),
    row("m2", 0.6253, "DSH Web GUI 工作区侧栏加星标收藏，源码在 app.asar 里"),
    row("m3", 0.6062, "工作区行背景色匹配自选 emoji 🐳 主题色"),
  ];
  const result = filterHits(rows, "星标 收藏 工作区侧栏 emoji 自定义 颜色");
  assert.deepEqual(entryIds(result.kept), ["m1", "m2", "m3"], "三条真相关都得留下");
  assert.equal(result.dropped.length, 0);
});

test("nokey：全被切掉时留最接近的一条，并写明「可能也不相关」", () => {
  const rows = [row("m1", 0.542, "某条完全不搭边的会话"), row("m2", 0.531, "另一条不搭边的会话")];
  const result = filterHits(rows, "VPS 3X-UI Cloudflare 白名单");
  assert.deepEqual(entryIds(result.kept), ["m1"]);
  assert.match(result.notes.join("\n"), /勉强留下/);
});

/* ── ③ 长尾 ─────────────────────────────────────────────────── */

test("长尾：低于 top1 ×0.88 且差够大 → 略去", () => {
  const rows = [row("m1", 0.7179, "表情包插件上线：markdown 图片渲染"), row("m2", 0.6101, "Upscayl 处理图片")];
  const result = filterHits(rows, "表情包插件 markdown 图片渲染");
  assert.deepEqual(entryIds(result.kept), ["m1"]);
  assert.equal(result.dropped[0].reason, "low");
});

test("长尾豁免：硬特征命中的条目，分数低一点也留（TTS 实测）", () => {
  const rows = [
    row("m1", 0.6924, "TTS 音频生成后用 ffplay 自动播放"),
    row("m2", 0.6350, "配置 Qwen3-TTS（JIUHU 音色，port 8000）"),
    row("m3", 0.5890, "车万女仆模组 jar 解析与修改教程"),
    row("m4", 0.5751, "TTS 部署：faster-qwen3-tts 桌面音色"),
  ];
  const result = filterHits(rows, "TTS 音频生成 ffplay 播放 端口");
  assert.deepEqual(entryIds(result.kept), ["m1", "m2", "m4"], "m4 靠 TTS 豁免留下，m3 跑题该走");
  assert.deepEqual(ids(result.dropped).sort(), ["m3"]);
});

test("太远的长尾：硬特征也救不回（低于 top1 ×0.75）", () => {
  const rows = [
    row("m1", 0.9000, "TTS 配置"),
    row("m2", 0.6000, "TTS 的另一件事"), // 0.6 < 0.9*0.75=0.675
  ];
  const result = filterHits(rows, "TTS 端口");
  assert.deepEqual(entryIds(result.kept), ["m1"]);
  assert.equal(result.dropped[0].reason, "low");
});

test("分数密集（同主题多条）不误杀：差不够大就不算长尾", () => {
  const rows = [row("m1", 0.6244, "代理偏好 Cloudflare CDN"), row("m2", 0.6208, "VPS 152.42.185.125 3X-UI")];
  const result = filterHits(rows, "代理偏好");
  assert.equal(result.kept.length, 2);
  assert.equal(result.dropped.length, 0);
});

/* ── ④ 平局 ─────────────────────────────────────────────────── */

test("平局：前四条挤在 0.05 跨度里 → 只留前三条，其余按 flat 略去", () => {
  const rows = [
    row("m1", 0.6821, "a"), row("m2", 0.6547, "b"), row("m3", 0.6448, "c"),
    row("m4", 0.6409, "d"), row("m5", 0.6361, "e"),
  ];
  const result = filterHits(rows, "帮我看一下这个函数为什么报错");
  assert.deepEqual(entryIds(result.kept), ["m1", "m2", "m3"]);
  assert.equal(result.dropped.filter((item) => item.reason === "flat").length, 2);
  assert.match(result.notes.join("\n"), /几乎持平/);
});

test("不平局就不截：跨度够大时全留", () => {
  const rows = [row("m1", 0.7000, "a"), row("m2", 0.6600, "b"), row("m3", 0.6400, "c"), row("m4", 0.6200, "d")];
  const result = filterHits(rows, "某个查询");
  assert.equal(result.kept.length, 4);
});

/* ── 参数 ───────────────────────────────────────────────────── */

test("filter: off → 原样全给（旧行为）", () => {
  const rows = [row("m1", 0.30, "什么都不是"), row("m2", 0.29, "也不是")];
  const result = filterHits(rows, "随便", { mode: "off" });
  assert.equal(result.kept.length, 2);
  assert.equal(result.dropped.length, 0);
});

test("min_score：显式下限一律生效（不豁免）", () => {
  const rows = [row("m1", 0.6924, "TTS 音频生成"), row("m2", 0.6800, "TTS 别的事")];
  const result = filterHits(rows, "TTS", { minScore: 0.69 });
  assert.deepEqual(entryIds(result.kept), ["m1"]);
  assert.deepEqual(ids(result.dropped), ["m2"]);
});

test("strict：底线抬高到 0.55、单个硬特征也硬切", () => {
  const rows = [row("m1", 0.5200, "含 emoji 字样但整体偏弱"), row("m2", 0.5100, "不相干")];
  const result = filterHits(rows, "emoji 颜色", { mode: "strict" });
  assert.equal(result.kept.length, 0);
  assert.equal(result.dropped[0].reason, "weak");
});

test("非法 mode 值 → 落到 auto（工具参数不可信）", () => {
  const rows = [row("m1", 0.90, "a"), row("m2", 0.40, "b")];
  const mode = filterHits(rows, "q", { mode: "banana" }).mode;
  assert.equal(mode, "auto");
  assert.equal(filterHits(rows, "q", { mode: undefined }).mode, "auto");
});

/* ── 边界 ───────────────────────────────────────────────────── */

test("空输入 / 坏行不炸", () => {
  assert.deepEqual(filterHits([], "q").kept, []);
  assert.deepEqual(filterHits(null, "q").kept, []);
  assert.deepEqual(filterHits([null, { entry: null, score: 0.9 }], "q").dropped, []);
  assert.deepEqual(filterHits([{ score: NaN }], "q").kept, []);
});

test("结果保持分数降序，且条目对象原样带回", () => {
  const rows = [row("m1", 0.90, "a"), row("m2", 0.85, "b")];
  const result = filterHits(rows, "q");
  assert.deepEqual(entryIds(result.kept), ["m1", "m2"]);
  assert.equal(result.kept[0].entry.summary, "a");
  assert.equal(result.kept[0].layer, "shallow");
});

test("没给硬特征时不做硬切，只按分数（记忆插件那条实测）", () => {
  const rows = [
    row("m1", 0.7287, "记忆插件 v2.3.0 段级引索层上线"),
    row("m2", 0.7233, "记忆插件 v2.3.0 已上线实测生效"),
    row("m3", 0.6179, "记忆插件 2.1 已上线实测"),
  ];
  const result = filterHits(rows, "记忆插件 段级引索 上线 实测");
  assert.deepEqual(entryIds(result.kept), ["m1", "m2"]);
  assert.equal(result.dropped[0].reason, "low");
});

/* ── 排序分层（v2.5）：深层独占的资格门 ───────────────────────
 * 下面所有数字都来自 2026-10-15 的真实回放：190 条记忆 × 6 条查询，
 * 用同一个本地模型（bge-small-zh-v1.5 q8）算分，与插件口径完全一致。
 */

test("分层：浅层赢 → 用浅层分（深层分再高也不参与）", () => {
  // 要点赢的那条：s=0.722 / d=0.665
  assert.deepEqual(scoreEntry(0.722, 0.665, 1), { score: 0.722, layer: "shallow" });
  // 浅层微弱胜出的那条：s=0.456 / d=0.425
  assert.deepEqual(scoreEntry(0.456, 0.425, 0), { score: 0.456, layer: "shallow" });
});

test("分层：本次事故的三条跑题长文 → 全部降级（退回要点分）", () => {
  // query「10月6日 提问 做了什么」：深层分全靠正文块零散撞词，要点分全都够不着 0.45
  assert.deepEqual(scoreEntry(0.418, 0.548, 0), { score: 0.418, layer: "demoted" });
  assert.deepEqual(scoreEntry(0.369, 0.539, 0), { score: 0.369, layer: "demoted" });
  assert.deepEqual(scoreEntry(0.324, 0.532, 0), { score: 0.324, layer: "demoted" });
});

test("分层：真相关条目一条都不许误伤（三条资格）", () => {
  // ① 硬特征豁免：TTS 那条 s=0.332 / d=0.587，靠要点里的「Qwen3-TTS」命中硬特征
  assert.deepEqual(scoreEntry(0.332, 0.587, 1), { score: 0.587, layer: "deep" });
  assert.deepEqual(scoreEntry(0.394, 0.525, 1), { score: 0.525, layer: "deep" });
  // ② 要点分过门：s=0.452 ≥ 0.45
  assert.deepEqual(scoreEntry(0.452, 0.462, 0), { score: 0.462, layer: "deep" });
  // ③ 引索二级验证通过
  assert.deepEqual(scoreEntry(0.400, 0.560, 0, true), { score: 0.560, layer: "deep" });
  // 三条都不成立 → 降级
  assert.deepEqual(scoreEntry(0.400, 0.560, 0, false), { score: 0.400, layer: "demoted" });
});

test("分层：浅层向量缺失（还没总结完）不降级 —— 无分可降，别误伤", () => {
  assert.deepEqual(scoreEntry(null, 0.600, 0, null), { score: 0.600, layer: "deep" });
  assert.deepEqual(scoreEntry(null, 0.600, 0, false), { score: 0.600, layer: "deep" });
});

test("分层：门值与常量没被改坏", () => {
  assert.equal(DEEP_GATE, 0.45);
  assert.equal(INDEX_DF_MAX, 15);
  // 卡在门口：刚好 0.45 算通过（>=），0.4499 算降级
  assert.equal(scoreEntry(0.45, 0.9, 0).layer, "deep");
  assert.equal(scoreEntry(0.4499, 0.9, 0).layer, "demoted");
});

test("二级验证：泛词命中一律不通过（DF 门槛把「什么 / 10 / 日」挡在外面）", () => {
  // 真实 DF（190 条正文里出现过多少条）：什么=98、10=122、日=60、月=23、了什=28
  const df = new Map([["什么", 98], ["10", 122], ["日", 60], ["月", 23], ["了什", 28]]);
  const dfOf = (word) => df.get(word) ?? 999;
  // 这正是三条跑题长文的引索命中词 —— 一个实词都没有
  assert.equal(rareHitOk(["了什", "什么", "10"], dfOf), false);
  assert.equal(rareHitOk(["月", "日", "什么", "10"], dfOf), false);
  assert.equal(rareHitOk(["10", "什么"], dfOf), false);
  // 真相关那条（TTS / ffplay）的命中词：tts=15、ffplay=5、播放=6、音频=6
  const df2 = new Map([["tts", 15], ["ffplay", 5], ["播放", 6], ["音频", 6]]);
  const dfOf2 = (word) => df2.get(word) ?? 999;
  assert.equal(rareHitOk(["tts", "ffplay", "播放", "音频"], dfOf2), true);
  assert.equal(rareHitOk(["播放"], dfOf2), true, "单个实词也够（DF=6 ≤ 15）");
  assert.equal(rareHitOk(["tts"], dfOf2), true, "卡在门槛上也算（15 ≤ 15）");
});

test("二级验证：空命中 / 取不到 DF / 坏输入 → 一律不通过", () => {
  assert.equal(rareHitOk([], (word) => 1), false);
  assert.equal(rareHitOk(null, (word) => 1), false);
  assert.equal(rareHitOk(["a"], null), false);
  assert.equal(rareHitOk(["a"], () => NaN), false);
  assert.equal(rareHitOk(["a"], () => Infinity), false);
});

test("分层 + 过滤的联动：降级后的条目掉出前列，不再冒充相关", () => {
  // 模拟一次「无区分度查询」：三条跑题条目深层分都高，但要点分只有 0.3~0.4
  const raw = [
    { entry: entry("bad1", "某条历史会话的配置记录"), shallowScore: 0.418, deepScore: 0.548, hardHits: 0 },
    { entry: entry("good", "会话导入完成并已实测生效"), shallowScore: 0.689, deepScore: 0.627, hardHits: 1 },
    { entry: entry("bad2", "Palworld崩溃诊断"), shallowScore: 0.369, deepScore: 0.539, hardHits: 0 },
  ];
  const rows = raw.map((item) => {
    const decided = scoreEntry(item.shallowScore, item.deepScore, item.hardHits, null);
    return { entry: item.entry, score: decided.score, layer: decided.layer };
  }).sort((a, b) => b.score - a.score);
  assert.deepEqual(entryIds(rows), ["good", "bad1", "bad2"], "真相关的顶上来，跑题的按要点分沉底");
  assert.equal(rows[0].layer, "shallow");
  assert.deepEqual(rows.slice(1).map((item) => item.layer), ["demoted", "demoted"]);
});

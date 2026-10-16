/**
 * 段级引索层单测（纯函数，不需要 DSH 进程）：
 *   node tests/segments.test.mjs
 * 或者用 Electron 自带的 node：
 *   $env:ELECTRON_RUN_AS_NODE="1"; & "C:\DSH\DeepSeek Harness.exe" tests\segments.test.mjs
 */
import {
  segmentText,
  tokenize,
  locateSegments,
  SEGMENT_SPLIT_CHARS,
  SEGMENT_TARGET_CHARS,
} from "../lib/segments.js";

let pass = 0;
const failures = [];
function check(name, condition, detail = "") {
  if (condition) { pass += 1; return; }
  failures.push(name + (detail === "" ? "" : "  → " + detail));
}

/** 一条真实的会话导入记忆（结构由 renderSegment 决定）。 */
const SESSION_MEMORY = [
  "## 当时你说的话",
  "那个跨会话记忆插件的readme文件在哪里看",
  "",
  "## 当时我的思考（原文节选）",
  "先看插件目录 C:\\work\\plugins\\dsh-workspace-recollection，README.md 应该在根目录。" +
    "顺手确认下 package.json 的 version 字段，" + "这是一段用来把思考段撑长的填充文字。".repeat(30),
  "",
  "## 用到的工具",
  "pwsh×3、read×2",
  "",
  "## 当时的结论",
  "README 在 C:\\work\\plugins\\dsh-workspace-recollection\\README.md，8.0 KB / 128 行，最后更新 2026-10-06。",
  "",
  "---",
  "来源：会话 abc123def · 2026-10-15 20:03",
].join("\n");

/* ── 一、切段 ── */

const segs = segmentText(SESSION_MEMORY);
check("切段：会话记忆切出 3~4 段（碎节已并入前节）", segs.length >= 3 && segs.length <= 4, "实得 " + String(segs.length) + " 段");
check("切段：段号从 1 连续", segs.every((s, i) => s.idx === i + 1));
check("切段：首段标题被识别", segs[0].label === "当时你说的话", "实得 " + JSON.stringify(segs[0].label));
check("切段：标题不带 # 号", segs.every((s) => !s.label.startsWith("#")));
check("切段：--- 与来源行不单独成段", !segs.some((s) => s.text.startsWith("---")), JSON.stringify(segs.map((s) => s.text.slice(0, 12))));
check("切段：来源行并入上一段", segs.some((s) => s.text.includes("来源：会话 abc123def")));
check("切段：正文里没有连续空行残留", segs.every((s) => !/\n{3,}/.test(s.text)));
check("切段：每段都有预览", segs.every((s) => s.preview.length > 0));
check("切段：段首锚点能对上原文", segs.every((s) => s.start >= 0
  && SESSION_MEMORY.slice(s.start, s.start + Math.min(24, s.text.length)) === s.text.slice(0, Math.min(24, s.text.length))));

const twice = segmentText(SESSION_MEMORY);
check("切段：确定性（两次结果一致）", JSON.stringify(twice) === JSON.stringify(segs));

// 超长段再切
const long = "## 长段\n" + "这是很长的一段话，用来验证超长段会被切开。".repeat(120);
const longSegs = segmentText(long);
check("切段：超长段被切开", longSegs.length > 1, "实得 " + String(longSegs.length) + " 段");
check("切段：切完每段不超过切分阈值", longSegs.every((s) => s.chars <= SEGMENT_SPLIT_CHARS + SEGMENT_TARGET_CHARS), JSON.stringify(longSegs.map((s) => s.chars)));
check("切段：切出来的段带 (i/n) 序号", longSegs.length > 1 && /\(1\/\d+\)$/.test(longSegs[0].label), JSON.stringify(longSegs[0].label));
check("切段：切分不丢字", longSegs.map((s) => s.text).join("").replace(/\s/g, "").length >= long.replace(/\s/g, "").length * 0.95);

// 边界
check("切段：空文本 → 空数组", segmentText("").length === 0);
check("切段：纯空白 → 空数组", segmentText("   \n\n  \t ").length === 0);
check("切段：单段文本 → 1 段", segmentText("就是一句话，没有标题也没有空行。").length === 1);
check("切段：CRLF 被归一化", segmentText("## A\r\n" + "内容甲。".repeat(30) + "\r\n\r\n## B\r\n" + "内容乙。".repeat(30)).length === 2);

// 真实数据上踩到的坑：空行曾经被当成硬边界，把一整节「思考」剁成几十个没名字的碎片
const blanky = "第一段文字。" + "填充甲".repeat(80) + "\n\n" + "第二段文字。" + "填充乙".repeat(80) + "\n\n" + "第三段文字。" + "填充丙".repeat(40);
const blankySegs = segmentText(blanky);
check("切段：空行不是硬边界（整节不足阈值 → 只 1 段）", blankySegs.length === 1, "实得 " + String(blankySegs.length) + " 段");

const headed = "## 一节\n" + "内容句子。".repeat(200);
const headedSegs = segmentText(headed);
check("切段：长节被切开", headedSegs.length > 1, "实得 " + String(headedSegs.length) + " 段");
check("切段：切开后每片都继承节名", headedSegs.every((s) => s.heading === "一节"), JSON.stringify(headedSegs.map((s) => s.heading)));
check("切段：切片带 (i/n) 序号", /\(1\/\d+\)/.test(headedSegs[0].label), JSON.stringify(headedSegs[0].label));

// 真实数据上的第二种碎裂：`# 第一步：基础环境` 下面只有一行 ```bash
const crumb = "## 一节\n" + "内容甲。".repeat(30) + "\n## 碎屑\n```bash\n## 又一节\n" + "内容乙。".repeat(30);
const crumbSegs = segmentText(crumb);
check("切段：碎节并入前节（不占独立段号）", crumbSegs.length === 2, "实得 " + String(crumbSegs.length) + " 段");
check("切段：被吞的碎节标题写回正文（信息不丢）", crumbSegs[0].text.includes("碎屑"), JSON.stringify(crumbSegs.map((s) => s.text.slice(0, 30))));

// 极多小节时宁可粗一点，也不能丢内容
const many = Array.from({ length: 140 }, (_, i) => "## 标题" + String(i) + "\n" + "内容文字。".repeat(15)).join("\n");
const manySegs = segmentText(many);
check("切段：超过段数上限时合并尾部而不是丢弃", manySegs.length <= 96, "实得 " + String(manySegs.length) + " 段");
check("切段：尾部内容仍在（最后一段含最后一个标题）", manySegs[manySegs.length - 1].text.includes("标题139"), manySegs[manySegs.length - 1].text.slice(0, 40));

/* ── 二、抽词 ── */

const tokens = tokenize("VPN 的 DNS 漏了，改 E:\\work\\demo 里的 MAX_TEXT_CHARS，用 pnpm dsh web 重启");
check("抽词：中文 bigram", tokens.includes("漏了") || tokens.includes("插件"), JSON.stringify(tokens.slice(0, 12)));
check("抽词：路径原样保留（小写）", tokens.includes("e:\\work\\demo"), JSON.stringify(tokens.filter((t) => t.includes("work"))));
check("抽词：常量名保留", tokens.includes("max_text_chars"));
check("抽词：命令词保留", tokens.includes("pnpm") && tokens.includes("dsh") && tokens.includes("web"));
check("抽词：全停用字的 bigram 被丢掉", !tokens.includes("的了") && !tokens.includes("是在"));
check("抽词：单字母 ASCII 被丢掉", !tokens.includes("a"));
check("抽词：空文本 → 空数组", tokenize("").length === 0);

/* ── 三、段级定位 ── */

const byReadme = locateSegments(segs, "readme 在哪里看", 5);
check("定位：readme 查询命中非空", byReadme.length > 0);
check("定位：命中段含 readme 关键词", byReadme[0].hits.some((h) => h.includes("readme")) || byReadme[0].preview.toLowerCase().includes("readme"), JSON.stringify(byReadme[0]));
check("定位：命中结果带段号与字数", Number.isInteger(byReadme[0].idx) && byReadme[0].chars > 0);

const byPath = locateSegments(segs, "C:\\work\\plugins\\dsh-workspace-recollection\\README.md", 5);
check("定位：整条路径查询能命中", byPath.length > 0 && byPath[0].idx >= 1);
check("定位：路径权重生效（精确形态词）", byPath[0].hits.some((h) => h.includes("readme")));

const byTool = locateSegments(segs, "用了哪些工具 pwsh", 5);
check("定位：工具段可被定位", byTool.length > 0 && byTool[0].hits.includes("pwsh"), JSON.stringify(byTool.map((r) => [r.idx, r.hits])));

const none = locateSegments(segs, "量子力学搬砖指南", 5);
check("定位：完全不相关 → 空结果", none.length === 0);

check("定位：空查询回前 N 段", locateSegments(segs, "", 2).length === 2);
check("定位：空段落数组 → 空结果", locateSegments([], "readme").length === 0);
check("定位：limit 生效", locateSegments(segs, "会话 工具 结论", 1).length === 1);
check("定位：结果按分数降序", (() => {
  const rows = locateSegments(segs, "readme 结论 工具", 5);
  for (let i = 1; i < rows.length; i += 1) if (rows[i - 1].score < rows[i].score) return false;
  return true;
})());

/* ── 结果 ── */

console.log("段级引索层单测：" + String(pass) + " 通过 / " + String(failures.length) + " 失败");
if (failures.length > 0) {
  for (const item of failures) console.log("  ✗ " + item);
  process.exitCode = 1;
} else {
  console.log("  ✓ 全部通过");
}

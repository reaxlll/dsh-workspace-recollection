/**
 * lib/sessions.js 的单元测试 —— 零依赖，`node --test tests/sessions.test.mjs` 直接跑。
 *
 * 只测纯函数部分（切段与渲染）：读文件那两个函数要真实会话文件，靠端到端脚本覆盖。
 * 切段规则是「会话导入」和 session_read 共用的地基，错的代价是导入进一堆系统注入的
 * 噪音，或者把一次任务拆成两半 —— 都不会报错，只会让记忆变脏。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { segmentSession, renderSegment } from "../lib/sessions.js";

/** 造一条用户消息事件。 */
const userMsg = (text, options = {}) => ({
  type: "user/message",
  time: options.time === undefined ? 1_700_000_000_000 : options.time,
  data: {
    source: { kind: options.kind === undefined ? "user" : options.kind },
    content: options.blocks === undefined ? [{ type: "text", text }] : options.blocks,
  },
});

/** 造一条助手消息事件。 */
const assistantMsg = (blocks) => ({
  type: "assistant/message",
  data: { message: { content: blocks } },
});

const toolCall = (name) => ({ type: "tool/call", data: { name } });

/* ── 切段 ─────────────────────────────────────────────────── */

test("切段：一条用户消息就是一段，时间戳保留", () => {
  const segments = segmentSession([userMsg("第一件事", { time: 12345 })]);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].ask, "第一件事");
  assert.equal(segments[0].time, 12345);
  assert.deepEqual(segments[0].reasoning, []);
  assert.deepEqual(segments[0].said, []);
  assert.deepEqual(segments[0].tools, []);
});

test("切段：两条用户消息切成两段（不是一段包两条）", () => {
  const segments = segmentSession([userMsg("第一件事"), assistantMsg([{ type: "text", text: "做完了一" }]), userMsg("第二件事")]);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].ask, "第一件事");
  assert.deepEqual(segments[0].said, ["做完了一"]);
  assert.equal(segments[1].ask, "第二件事");
  assert.deepEqual(segments[1].said, []);
});

test("切段：非用户来源的消息被跳过（runtime-context 之类的系统注入是噪音）", () => {
  const segments = segmentSession([
    userMsg("系统注入的上下文", { kind: "runtime-context" }),
    userMsg("真正的问题"),
  ]);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].ask, "真正的问题");
});

test("切段：空文本 / 没有文本块的用户消息不算一段", () => {
  assert.deepEqual(segmentSession([userMsg("")]), []);
  assert.deepEqual(segmentSession([userMsg("   ")]), []);
  assert.deepEqual(segmentSession([userMsg("", { blocks: [{ type: "image", text: "" }] })]), []);
  assert.deepEqual(segmentSession([userMsg("", { blocks: [] })]), []);
});

test("切段：思考与结论分别落进 reasoning / said", () => {
  const segments = segmentSession([
    userMsg("问"),
    assistantMsg([
      { type: "reasoning", text: "先想想" },
      { type: "text", text: "答案是这样" },
      { type: "reasoning", text: "再想想" },
    ]),
  ]);
  assert.deepEqual(segments[0].reasoning, ["先想想", "再想想"]);
  assert.deepEqual(segments[0].said, ["答案是这样"]);
});

test("切段：工具调用按顺序记下（同名会重复出现，渲染时才聚合）", () => {
  const segments = segmentSession([userMsg("做"), toolCall("read"), toolCall("pwsh"), toolCall("read")]);
  assert.deepEqual(segments[0].tools, ["read", "pwsh", "read"]);
});

test("切段：用户消息之前的助手/工具事件被丢掉（不属于任何一段）", () => {
  const segments = segmentSession([assistantMsg([{ type: "text", text: "无主的回答" }]), toolCall("read"), userMsg("真正的起点")]);
  assert.equal(segments.length, 1);
  assert.deepEqual(segments[0].said, []);
  assert.deepEqual(segments[0].tools, []);
});

test("切段：坏事件 / 缺字段一律不炸", () => {
  const segments = segmentSession([
    userMsg("正常"),
    null,
    undefined,
    { type: "assistant/message" },
    { type: "assistant/message", data: null },
    { type: "assistant/message", data: { message: { content: "不是数组" } } },
    { type: "tool/call" },
    { type: "tool/call", data: {} },
    { type: "user/message", data: { source: { kind: "user" }, content: [null, { type: "text" }, { type: "text", text: 42 }] } },
    "字符串",
  ]);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].tools[0], "?");
});

test("切段：空输入 / 非数组返回空", () => {
  assert.deepEqual(segmentSession([]), []);
  assert.deepEqual(segmentSession(null), []);
  assert.deepEqual(segmentSession(undefined), []);
});

/* ── 渲染 ─────────────────────────────────────────────────── */

const seg = (over = {}) => ({ ask: "你问的话", time: 0, reasoning: [], said: [], tools: [], ...over });

test("渲染：基本结构含原话与来源行", () => {
  const text = renderSegment(seg(), "session-abc", "digest", 20000);
  assert.match(text, /## 当时你说的话/);
  assert.match(text, /你问的话/);
  assert.match(text, /来源：会话 session-abc/);
});

test("渲染：digest 模式不带思考，full 模式带（这是「省 token」与「要原文」的分界）", () => {
  const withReasoning = seg({ reasoning: ["当时的推理过程"] });
  assert.equal(renderSegment(withReasoning, "s", "digest", 20000).includes("当时的推理过程"), false);
  assert.equal(renderSegment(withReasoning, "s", "full", 20000).includes("当时的推理过程"), true);
  assert.match(renderSegment(withReasoning, "s", "full", 20000), /## 当时我的思考/);
});

test("渲染：工具按次数聚合（read×2、pwsh×1）", () => {
  const text = renderSegment(seg({ tools: ["read", "pwsh", "read"] }), "s", "digest", 20000);
  assert.match(text, /## 用到的工具/);
  assert.match(text, /read×2/);
  assert.match(text, /pwsh×1/);
});

test("渲染：没有工具 / 没有结论时，相应小节不出现", () => {
  const text = renderSegment(seg(), "s", "digest", 20000);
  assert.equal(text.includes("## 用到的工具"), false);
  assert.equal(text.includes("## 当时的结论"), false);
});

test("渲染：总长超过 maxChars 时截断，并明确标注", () => {
  const text = renderSegment(seg({ said: ["很长".repeat(5000)] }), "s", "digest", 1000);
  assert.ok(text.length <= 1000 + 30, "结果不该远超上限");
  assert.match(text, /本条超长，已截断/);
});

test("渲染：时间戳按传入的时区渲染到分钟", () => {
  const when = Date.UTC(2026, 9, 16, 13, 30);
  // 显式给时区（这条用例钉的就是「UTC 串 + 时区 = 本地钟点」）
  assert.match(renderSegment(seg({ time: when }), "s", "digest", 20000, "UTC"), /2026-10-16 13:30/);
  assert.match(renderSegment(seg({ time: when }), "s", "digest", 20000, "Asia/Shanghai"), /2026-10-16 21:30/);
  // 不给时区 = 本机本地（旧行为，但不再是 UTC）
  const local = renderSegment(seg({ time: when }), "s", "digest", 20000);
  const localText = String(new Date(when).getHours()).padStart(2, "0") + ":" + String(new Date(when).getMinutes()).padStart(2, "0");
  assert.match(local, new RegExp("2026-10-16 " + localText));
});

test("渲染：time 为 0 时不渲染时间（老数据没有时间戳）", () => {
  const text = renderSegment(seg({ time: 0 }), "s", "digest", 20000);
  assert.match(text, /来源：会话 s$/);
});

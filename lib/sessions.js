/**
 * 历史会话的读取与切段 —— 从 index.js 抽出来的一块。
 *
 * 为什么值得单独一个文件：这是「会话导入」与 session_read 共用的正门，也是容易出事的
 * 一段 —— 会话文件是 zstd 多帧流、事件结构随内核版本变、切段规则全靠事件类型判断。
 * 抽出来之后，纯函数那部分（segmentSession / renderSegment）能脱离 DSH 进程直接单测。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { workspaceKey } from "./store-logic.js";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

/* ────────────────────── 历史会话导入（面板功能） ────────────────────── */

/**
 * 会话文件的第一帧里就是会话头（cwd 之类）。只解第一帧就够 ——
 * zstdDecompressSync 遇到多帧流时正好只解第一帧，拿来读头刚好。
 */
export function readSessionHeader(file) {
  try {
    const first = zstdDecompressSync(readFileSync(file));
    const line = first.toString("utf8").split("\n")[0];
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * 列出某个工作区在磁盘上的历史会话（新→旧）。
 * 归属靠**读会话头里的 cwd** 判定，不去猜 sessions 目录名的编码规则
 * （那个规则会把 E:\foo 编成 E-foo，盘符的冒号也被吃掉了，逆推极易出错）。
 */
/**
 * @param {string} cwd 工作区目录
 * @param {string} sessionsRoot 会话根目录（由调用方注入：sessions.js 不依赖 DSH 运行时的 HOME 解析）
 */
export function listSessionFiles(cwd, sessionsRoot) {
  const key = workspaceKey(cwd);
  if (key === "" || typeof sessionsRoot !== "string" || sessionsRoot === "") return [];
  const rows = [];
  let projects = [];
  try { projects = readdirSync(sessionsRoot); } catch { return rows; }
  for (const project of projects) {
    const projectDir = join(sessionsRoot, project);
    let ids = [];
    try { ids = readdirSync(projectDir); } catch { continue; }
    for (const id of ids) {
      const file = join(projectDir, id, "session.v4.jsonl.zstd");
      if (!existsSync(file)) continue;
      const header = readSessionHeader(file);
      if (header === null || typeof header.cwd !== "string" || workspaceKey(header.cwd) !== key) continue;
      const stat = statSync(file);
      rows.push({ id, file, size: stat.size, mtime: stat.mtimeMs });
    }
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  return rows;
}

/**
 * 读一个会话的全部事件。文件是**多帧 zstd 追加流**：Node 的 zstdDecompressSync 只解第一帧，
 * 所以按魔数切开逐帧解压（实测一个 275KB 的会话有 86 帧，逐帧解压全部成功）。
 */
export function readSessionEvents(file) {
  const buffer = readFileSync(file);
  const offsets = [];
  for (let i = 0; i + 3 < buffer.length; i += 1) {
    if (buffer[i] === 0x28 && buffer[i + 1] === 0xb5 && buffer[i + 2] === 0x2f && buffer[i + 3] === 0xfd) offsets.push(i);
  }
  const parts = [];
  for (const offset of offsets) {
    try { parts.push(zstdDecompressSync(buffer.subarray(offset))); } catch { /* 坏帧跳过 */ }
  }
  const events = [];
  for (const line of Buffer.concat(parts).toString("utf8").split("\n")) {
    if (line.trim() === "") continue;
    try { events.push(JSON.parse(line)); } catch { /* 坏行跳过 */ }
  }
  return events;
}

/**
 * 切成「任务段」：每条真实用户消息开头，到下一条用户消息为止。
 * 跳过 source.kind !== "user" 的消息（runtime-context 之类的系统注入是噪音）。
 */
export function segmentSession(events) {
  // 容错：它现在是公开 API（开源后会被别人直接调），不该因为传了 null 就抛。
  // 注意这与原实现不同 —— 原来是「调用方保证传数组」，抽出来时顺手补上了这层保护。
  const list = Array.isArray(events) ? events : [];
  const segments = [];
  let current = null;
  for (const event of list) {
    // 会话文件里真的可能混进 JSON.parse("null") 这类行（坏行只在 parse 那一步被拦），
    // 所以进循环先挡一道，不要等到读 event.type 才炸。
    if (event === null || typeof event !== "object") continue;
    if (event.type === "user/message") {
      const source = event.data !== null && event.data !== undefined && event.data.source ? event.data.source.kind : "";
      if (source !== "user") continue;
      const content = Array.isArray(event.data.content) ? event.data.content : [];
      const text = content.filter((block) => block !== null && block.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n").trim();
      if (text === "") continue;
      if (current !== null) segments.push(current);
      current = { ask: text, time: typeof event.time === "number" ? event.time : 0, reasoning: [], said: [], tools: [] };
      continue;
    }
    if (current === null) continue;
    if (event.type === "assistant/message") {
      const message = event.data !== null && event.data !== undefined && event.data.message ? event.data.message : null;
      const content = message !== null && Array.isArray(message.content) ? message.content : [];
      for (const block of content) {
        if (block === null || typeof block !== "object" || typeof block.text !== "string" || block.text.trim() === "") continue;
        if (block.type === "reasoning") current.reasoning.push(block.text.trim());
        else if (block.type === "text") current.said.push(block.text.trim());
      }
      continue;
    }
    if (event.type === "tool/call") {
      const name = event.data !== null && event.data !== undefined && event.data.name ? String(event.data.name) : "?";
      current.tools.push(name);
    }
  }
  if (current !== null) segments.push(current);
  return segments;
}

/** 把一个任务段渲染成深层正文：你的原话 + 当时的思考（原文）+ 用到的工具 + 结论。 */
export function renderSegment(segment, sessionLabel, depth, maxChars) {
  const parts = ["## 当时你说的话\n" + segment.ask];
  if (depth === "full" && segment.reasoning.length > 0) {
    const joined = segment.reasoning.join("\n\n");
    const budget = Math.max(2000, Math.floor(maxChars * 0.55));
    parts.push("## 当时我的思考（原文节选）\n" + (joined.length > budget ? joined.slice(0, budget) + "\n…（思考过长，此处截断）" : joined));
  }
  if (segment.tools.length > 0) {
    const counts = new Map();
    for (const name of segment.tools) counts.set(name, (counts.get(name) || 0) + 1);
    parts.push("## 用到的工具\n" + [...counts.entries()].map(([name, count]) => name + "×" + count).join("、"));
  }
  if (segment.said.length > 0) {
    const joined = segment.said.join("\n\n");
    const budget = Math.max(2000, Math.floor(maxChars * 0.4));
    parts.push("## 当时的结论\n" + (joined.length > budget ? joined.slice(0, budget) + "\n…（结论过长，此处截断）" : joined));
  }
  parts.push("---\n来源：会话 " + sessionLabel + (segment.time > 0 ? " · " + new Date(segment.time).toISOString().slice(0, 16).replace("T", " ") : ""));
  const text = parts.join("\n\n");
  return text.length > maxChars ? text.slice(0, maxChars) + "\n…（本条超长，已截断）" : text;
}

/**
 * 「先看一眼记忆」守卫 —— 纯函数、零依赖，可脱离 DSH 进程直接用 node 单测。
 *
 * 为什么需要它：v2.9 那行常驻提示只提高了概率，没有提供保证。
 * 实测里模型甚至会先翻二十几条命令、最后才想起来调记忆 —— 而目录（`memory_index`）
 * 一眼就能看到答案。提示词管不住这种「最短路径」，只有把路堵上才行。
 *
 * 规则（故意做得很窄）：
 *   1. **只拦全新会话的第一个动作**：会话里已经有过对话轮次（即「有上下文」）就不拦 ——
 *      接着聊的人当然知道自己要干什么，不需要再被提醒一次；
 *   2. 新会话的第一个探索型调用（pwsh / read / glob …）如果还没碰过记忆工具 → deny 一次，
 *      理由里写清先调 memory_index；
 *   3. 被拦过之后**一定放行**：绝不因为模型不听话就把它卡死；
 *   4. 只拦「探索型」工具，写文件、登记任务这些一律不管；
 *   5. 拿不到 sessionId 就放行（宁可少拦，不可误伤）。
 */

/** 调过其中任一 = 本会话已经「看过记忆」了。 */
export const MEMORY_LOOK_TOOLS = Object.freeze([
  "memory_index",
  "memory_recall",
  "memory_search",
  "memory_detail",
  "memory_locate",
  "session_read",
]);

/** 会被拦的探索型工具：翻文件、跑命令（`run_code` 是万能入口，必须算进来）。 */
export const EXPLORE_TOOLS = Object.freeze(["pwsh", "bash", "read", "glob", "grep", "run_code"]);

/** 模型可见的拒绝理由 —— 要写清「为什么拦」和「下一步做什么」，别只写一句不许。 */
export const DENY_REASON =
  "先看一眼记忆，再动手：这是新会话的第一个动作，而你还没调过 memory_index / memory_recall。" +
  "本工作区的跨会话记忆里存着以前做过的事、当时的判断和踩过的坑 —— " +
  "先 memory_index 拿一眼目录（置顶在前、其余按更新时间倒序），知道要找什么了再用 memory_recall 按语义找；" +
  "条目很长时用 memory_locate 定位段号、memory_detail 只取那几段。" +
  "这条守卫只在新会话的第一次拦一下；已经带着上下文接着聊的会话不会被它打扰。";

/** 界面（用户可见）的一句话。 */
export const DISPLAY_REASON = Object.freeze({
  zh: "先看一眼工作区记忆再动手",
  en: "Read the workspace memory index first",
});

/** 每个会话的状态：passed = 已经看过记忆；reminded = 已经被拦过一次。 */
export function createFirstLookState() {
  return { passed: new Set(), reminded: new Set(), denied: 0, allowed: 0, skipped: 0, seen: new Map() };
}

/**
 * 判定一次工具调用该放行还是拦下。
 *
 * @returns {"next" | "deny"} —— "next" 表示放行（调用方负责 `return next()`）
 */
export function decideFirstLook(state, toolName, sessionId, hasContext = false) {
  if (state === null || typeof state !== "object") return "next";
  if (typeof sessionId !== "string" || sessionId === "") {
    state.skipped += 1;
    return "next";
  }
  if (typeof toolName !== "string" || toolName === "") return "next";

  if (state.seen instanceof Map) state.seen.set(sessionId, (state.seen.get(sessionId) ?? 0) + 1);

  if (MEMORY_LOOK_TOOLS.includes(toolName)) {
    state.passed.add(sessionId);
    return "next";
  }
  if (state.passed.has(sessionId)) {
    // 拦过一次之后一律放行；reminded 里的记录在这里计一次数然后清掉
    if (state.reminded.delete(sessionId) === true) state.allowed += 1;
    return "next";
  }
  // 这个会话已经有对话上下文了 —— 不拦。守卫只在「全新会话的第一个动作」出手。
  if (hasContext === true) return "next";
  if (EXPLORE_TOOLS.includes(toolName) === false) return "next";

  // 第一次探索：拦下，并**立刻**记进 passed —— 同一个 key 绝不会有第二次拦截。
  // v2.10.1 修正：原来是等「第二次调用」才放行，一旦调用方给的 id 每轮都变，就会轮轮被拦。
  state.reminded.add(sessionId);
  state.passed.add(sessionId);
  state.denied += 1;
  return "deny";
}

/** 给 status 用的快照（Set 不能直接进 JSON）。 */
export function firstLookReport(state) {
  const source = state !== null && typeof state === "object" ? state : createFirstLookState();
  const seen = source.seen instanceof Map ? [...source.seen.entries()] : [];
  return {
    denied: source.denied,
    allowed: source.allowed,
    skipped: source.skipped,
    reminded: source.reminded.size,
    passed: source.passed.size,
    recent: seen.slice(-8).map(([id, count]) => ({ id: String(id).slice(0, 16), count })),
  };
}

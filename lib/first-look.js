/**
 * 「先看一眼记忆」守卫 —— 纯函数、零依赖，可脱离 DSH 进程直接用 node 单测。
 *
 * 为什么需要它：v2.7 那行常驻提示只提高了概率，没有提供保证。
 * 实测里模型甚至会先翻二十几条命令、最后才想起来调记忆 —— 而目录（`memory_index`）
 * 一眼就能看到答案。提示词管不住这种「最短路径」，只有把路堵上才行。
 *
 * 规则（故意做得很窄）：
 *   1. **每个会话最多拦一次**：第一次调探索型工具（pwsh / read / glob …）时，
 *      如果本会话还没调过任何记忆工具 → deny 一次，理由里写清先调 memory_index；
 *   2. 被拦过之后**一定放行**：绝不因为模型不听话就把它卡死；
 *   3. 只拦「探索型」工具，写文件、登记任务这些一律不管；
 *   4. 拿不到 sessionId 就放行（宁可少拦，不可误伤）。
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
  "先看一眼记忆，再动手：这个会话还没调过 memory_index / memory_recall。" +
  "本工作区的跨会话记忆里存着以前做过的事、当时的判断和踩过的坑 —— " +
  "先 memory_index 拿一眼目录（置顶在前、其余按更新时间倒序），知道要找什么了再用 memory_recall 按语义找；" +
  "条目很长时用 memory_locate 定位段号、memory_detail 只取那几段。" +
  "这条守卫每个会话只拦一次，下一次调用会照常放行。";

/** 界面（用户可见）的一句话。 */
export const DISPLAY_REASON = Object.freeze({
  zh: "先看一眼工作区记忆再动手",
  en: "Read the workspace memory index first",
});

/** 每个会话的状态：passed = 已经看过记忆；reminded = 已经被拦过一次。 */
export function createFirstLookState() {
  return { passed: new Set(), reminded: new Set(), denied: 0, allowed: 0, skipped: 0 };
}

/**
 * 判定一次工具调用该放行还是拦下。
 *
 * @returns {"next" | "deny"} —— "next" 表示放行（调用方负责 `return next()`）
 */
export function decideFirstLook(state, toolName, sessionId) {
  if (state === null || typeof state !== "object") return "next";
  if (typeof sessionId !== "string" || sessionId === "") {
    state.skipped += 1;
    return "next";
  }
  if (typeof toolName !== "string" || toolName === "") return "next";

  if (MEMORY_LOOK_TOOLS.includes(toolName)) {
    state.passed.add(sessionId);
    return "next";
  }
  if (state.passed.has(sessionId)) return "next";
  if (EXPLORE_TOOLS.includes(toolName) === false) return "next";

  if (state.reminded.has(sessionId)) {
    // 拦过一次了还不去查 —— 放行，绝不把人卡死在原地
    state.passed.add(sessionId);
    state.allowed += 1;
    return "next";
  }
  state.reminded.add(sessionId);
  state.denied += 1;
  return "deny";
}

/** 给 status 用的快照（Set 不能直接进 JSON）。 */
export function firstLookReport(state) {
  const source = state !== null && typeof state === "object" ? state : createFirstLookState();
  return {
    denied: source.denied,
    allowed: source.allowed,
    skipped: source.skipped,
    reminded: source.reminded.size,
    passed: source.passed.size,
  };
}

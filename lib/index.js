/**
 * dsh-workspace-recollection · host 半段（v3：浅层 / 深层双层记忆 + AI 总结）
 *
 * 分层（事实源仍然只有一个）：
 *   1) $DSH_HOME/session-memory/memory.json
 *        text       深层：完整的思考、操作、细节、结论（可能很长）
 *        summary    浅层：AI 压缩出的一句话要点（用于快速定位）
 *   2) <工作区>/Memory.md          常驻索引（写的是浅层），注入 system prompt
 *   3) $DSH_HOME/session-memory/vectors.json
 *        每条记忆两份向量：s = 浅层向量，d = 深层向量
 *
 * 检索顺序（主人要的"优先浅层、需要细节再深层"）：
 *   memory_recall(query)            → 用浅层向量检索，只回要点 + id（token 省，定位准）
 *   memory_locate(id, query)        → v2.3 段级引索层：在**这条记忆内部**按关键词定位段号，
 *                                     只回段号 / 小标题 / 字数 / 命中词 / 预览，一个字正文都不回
 *   memory_detail(ids[, segments])  → 按 id 取深层完整内容；给了 segments 就只取那几段切片
 *   浅层向量缺失时自动回退深层向量；两者都不可用则回退关键词。
 *
 * 段级引索层（v2.3，见 lib/segments.js）：纯本地 CPU、零依赖、零联网、确定性 ——
 *   ① segmentText    语义优先切段（## 小节 / --- / 空行；超长段再按 380 字符在句末断开）
 *   ② tokenize       中文 bigram + ASCII 词元（路径 / 命令 / 常量名原样保留）
 *   ③ locateSegments 段级 BM25（k1=1.2, b=0.75）+ 精确形态词加权
 * 于是两万字的记忆可以只花几百字就读到要找的那一段。
 *
 * AI 总结：memory_write 可以由调用方直接给 summary（最准、零成本）；
 * 没给就进后台队列，由 ctx.llm.stream 压缩成一句话，完成后替换并更新浅层向量。
 * 总结失败不阻塞写入：先用规则摘要兜底，状态标成 failed，面板可重跑。
 *
 * 规范约束：不写静态 inject；会话→工作区走 workspaceRegistry.readSessionHeader().cwd；
 * 数据文件 UTF-8 无 BOM + 原子写；多个工具逐个独立注册并挂到 /status 的 tools 字段。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { basename, dirname, join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { segmentText, locateSegments } from "./segments.js";
import { filterHits, hardTokensOf, hardHitCount, scoreEntry, rareHitOk, DEEP_GATE, INDEX_DF_MAX } from "./noise.js";
import { parseTimeHint, inDayRange, clockOf } from "./timehint.js";
import { EMBED_MODEL_ID, MODEL_FILES, MODEL_MIRRORS, modelUrl, missingFiles, isComplete } from "./model.js";
import { encodeVector, decodeVectorOfDim, isEncoded, normalizeChunks, migrateVectorsV2ToV3 } from "./vector-codec.js";
import { lockPayload, parseLock, lockState, lockNotice } from "./lock.js";
import { sortEntries, trimEntries, partitionRemoval, clampInt, workspaceKey } from "./store-logic.js";
import { readSessionHeader, listSessionFiles, readSessionEvents, segmentSession, renderSegment } from "./sessions.js";
import { STORE_MIGRATIONS, VECTOR_MIGRATIONS, backupName, pickBackupsToKeep, resolveOnRead } from "./migrate.js";

export const name = "session-memory";

const HOME_DIR = join(resolveDshHome(), "session-memory");
const STORE_PATH = join(HOME_DIR, "memory.json");
const VECTORS_PATH = join(HOME_DIR, "vectors.json");
const MODELS_DIR = join(HOME_DIR, "models").replace(/\\/g, "/");
const BACKUP_DIR = join(HOME_DIR, "backups");
/** 每个数据文件最多留几份自动备份（迁移前 / 解析失败时生成）。 */
const BACKUP_KEEP = 5;

/**
 * v2 → v3：向量从「数字数组」改成 Float32 原始字节的 base64。
 * 实测 5833 个向量：24.1MB/174ms → 15.2MB/38ms（体积 -37%、落盘 CPU -78%）。
 * 只改表示形式，维度与数值不变；迁移前 MemoryStore/VectorStore 会自动备份。
 */
VECTOR_MIGRATIONS.set(2, migrateVectorsV2ToV3);

const LOCK_PATH = join(HOME_DIR, "write.lock");
/** 锁的兜底有效期：即使持有者 pid 看着还活着，超过这个时长也允许接管（防 pid 被复用）。 */
const LOCK_TTL_MS = 12 * 60 * 60 * 1000;
const SESSIONS_ROOT = join(resolveDshHome(), "sessions");
const IMPORT_MAX_CHARS = 20000;
const IMPORT_BATCH_LIMIT = 200;
/** 想用脚本直接解压会话文件时的显式放行标记（插件自身开发/调试用；不带它就是要绕过正门，会被拦）。 */
const SESSION_READ_ALLOW_MARK = "DSH-MEM-ALLOW-SESSION-READ";
const SESSION_READ_MAX_CHARS = 16000;
/** 命中「会话文件路径」的特征。 */
const SESSION_TARGET_RE = /(\.dsh[\\/]+sessions[\\/])|(session\.v4\.jsonl\.zstd)|(sessions[\\/]+[^\s]{0,80}session-)/i;
/** 命中「解压 / 读 zstd 流」的动作特征。 */
const SESSION_BYPASS_RE = /(zstd|zlib|decompress|0x28\s*,\s*0xb5|28\s*,\s*0xb5)/i;

const ROUTE_PREFIX = "/api/session-memory";
const SECTION_NAME = "plugin:session-memory";
const SECTION_ORDER = -5;
const MAX_BODY_BYTES = 1 << 20;

const STORE_VERSION = 3;
const VECTOR_VERSION = 3;
const EMBED_DIM = 512;
const MEMORY_FILE = "Memory.md";
const MANUAL_BEGIN = "<!-- MANUAL:BEGIN -->";
const MANUAL_END = "<!-- MANUAL:END -->";

/** 总结用的模型路由：偏好 deepseek-flash 这种便宜快的小模型。 */
const DEFAULT_SUMMARY_PROVIDER = "deepseek-official";
const DEFAULT_SUMMARY_MODEL = "deepseek-flash";
const SUMMARY_SYSTEM = [
  "你是记忆压缩助手。把用户给出的记忆条目压缩成一条中文要点，供将来的语义检索定位。",
  "硬性要求：只输出那一条要点；保留专有名词、文件名、路径、命令、数字等可检索关键词；不超过 60 个汉字；",
  "不要 Markdown、不要引号、不要编号、不要任何解释或前后缀。",
].join("");

const DEFAULT_BUDGET_CHARS = 6000;
const MIN_BUDGET_CHARS = 800;
const MAX_BUDGET_CHARS = 60000;
const MAX_TEXT_CHARS = 20000;
const MAX_SUMMARY_CHARS = 200;
/** 正文长于这个字数的记忆，在 memory_recall 清单里提示「可 memory_locate 细分」。 */
const LONG_ENTRY_CHARS = 1500;
/** 深层正文分块：每块字符数（安全落在 512 token 内），以及单条最多保留多少块。 */
const EMBED_CHUNK_CHARS = 380;
const MAX_CHUNKS_PER_ENTRY = 24;
/** 超时保护：想深层的事可以慢，但不能无限等。 */
const DEFAULT_SUMMARY_TIMEOUT_MS = 45000;
const DEFAULT_EMBED_TIMEOUT_MS = 120000;
const MIN_TIMEOUT_MS = 3000;
const MAX_TIMEOUT_MS = 600000;
const MAX_TAGS = 8;
const MAX_TAG_CHARS = 24;
const MAX_ENTRIES_PER_WORKSPACE = 500;
const SUMMARY_CHARS = 88;
/** 送给总结模型的正文上限：要点只要几十字，输入没必要超过这个数。 */
const SUMMARY_INPUT_CHARS = 3000;
const RECENT_IN_INDEX = 20;

/* ────────────────────────────── 基础工具 ────────────────────────────── */

function nowIso() { return new Date().toISOString(); }
function newId() { return "mem_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8); }

function normalizeTag(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_TAG_CHARS);
}

function normalizeTags(value) {
  const source = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,，、\s]+/) : [];
  const tags = [];
  for (const item of source) {
    const tag = normalizeTag(item);
    if (tag === "" || tags.includes(tag)) continue;
    tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}

function normalizeText(value, limit) {
  if (typeof value !== "string") return "";
  return value.replace(/\r\n/g, "\n").trim().slice(0, limit);
}

function oneLine(text) {
  return String(text).replace(/\s*\n+\s*/g, " ").replace(/\s{2,}/g, " ").trim();
}

function truncate(text, limit) {
  const value = String(text);
  return value.length <= limit ? value : value.slice(0, limit) + "…";
}

/** 规则摘要：AI 总结还没到位时的兜底，也是浅层向量的输入。 */
/** 规则摘要：跳过 Markdown 标题行（导入的深层正文首行往往是「## 当时你说的话」这种小标题）。 */
function ruleSummary(text, limit = SUMMARY_CHARS) {
  const lines = String(text).split("\n").map((line) => line.trim())
    .filter((line) => line !== "" && line.startsWith("#") === false);
  return truncate(lines.length > 0 ? lines[0] : String(text).trim(), limit);
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = path + "." + process.pid + "." + Math.random().toString(36).slice(2, 8) + ".tmp";
  writeFileSync(temporary, content, "utf8");
  renameSync(temporary, path);
}

/** 浅层文本 = 摘要 + 标签（标签也是很好的检索信号）。 */
function shallowText(entry) {
  const head = entry.summary !== "" ? entry.summary : ruleSummary(entry.text);
  return entry.tags.length > 0 ? head + " #" + entry.tags.join(" #") : head;
}

/* ────────────────────────────── 记忆本体 ────────────────────────────── */

function normalizeEntry(raw) {
  if (raw === null || typeof raw !== "object") return null;
  const text = normalizeText(raw.text, MAX_TEXT_CHARS);
  if (text === "") return null;
  const createdAt = typeof raw.createdAt === "string" && raw.createdAt !== "" ? raw.createdAt : nowIso();
  const updatedAt = typeof raw.updatedAt === "string" && raw.updatedAt !== "" ? raw.updatedAt : createdAt;
  const source = raw.source !== null && typeof raw.source === "object" ? raw.source : {};
  const summary = normalizeText(raw.summary, MAX_SUMMARY_CHARS);
  const state = raw.summaryState === "ready" || raw.summaryState === "failed" || raw.summaryState === "manual" || raw.summaryState === "pending"
    ? raw.summaryState
    : (summary === "" ? "pending" : "ready");
  return {
    id: typeof raw.id === "string" && raw.id !== "" ? raw.id : newId(),
    text,
    summary,
    summaryState: state,
    tags: normalizeTags(raw.tags),
    pinned: raw.pinned === true,
    meta: raw.meta === true,
    locked: raw.locked === true,
    source: {
      sessionId: typeof source.sessionId === "string" ? source.sessionId : "",
      at: typeof source.at === "string" ? source.at : createdAt,
      origin: typeof source.origin === "string" ? source.origin : "agent",
    },
    createdAt,
    updatedAt,
  };
}

function normalizeBucket(raw) {
  if (raw === null || typeof raw !== "object") return null;
  const cwd = typeof raw.cwd === "string" ? raw.cwd : "";
  const entries = [];
  const seen = new Set();
  const list = Array.isArray(raw.entries) ? raw.entries : [];
  for (const item of list) {
    const entry = normalizeEntry(item);
    if (entry === null || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  const createdAt = typeof raw.createdAt === "string" ? raw.createdAt : nowIso();
  return {
    cwd,
    enabled: raw.enabled !== false,
    injectMode: raw.injectMode === "full" || raw.injectMode === "off" ? raw.injectMode : "index",
    createdAt,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : createdAt,
    entries,
  };
}

function normalizeStore(raw) {
  const source = raw !== null && typeof raw === "object" ? raw : {};
  const workspaces = new Map();
  const rawWorkspaces = source.workspaces !== null && typeof source.workspaces === "object" ? source.workspaces : {};
  for (const [key, bucketRaw] of Object.entries(rawWorkspaces)) {
    if (typeof key !== "string" || key === "") continue;
    const bucket = normalizeBucket(bucketRaw);
    if (bucket === null) continue;
    workspaces.set(key, bucket);
  }
  return {
    version: STORE_VERSION,
    budgetChars: clampInt(source.budgetChars, MIN_BUDGET_CHARS, MAX_BUDGET_CHARS, DEFAULT_BUDGET_CHARS),
    summaryProvider: typeof source.summaryProvider === "string" && source.summaryProvider !== "" ? source.summaryProvider : DEFAULT_SUMMARY_PROVIDER,
    summaryModel: typeof source.summaryModel === "string" && source.summaryModel !== "" ? source.summaryModel : DEFAULT_SUMMARY_MODEL,
    summaryTimeoutMs: clampInt(source.summaryTimeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, DEFAULT_SUMMARY_TIMEOUT_MS),
    embedTimeoutMs: clampInt(source.embedTimeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, DEFAULT_EMBED_TIMEOUT_MS),
    workspaces,
  };
}

/** 本进程是否还活着（信号 0 只探测、不发送）。EPERM 表示进程在、只是没权限。 */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error !== null && typeof error === "object" && error.code === "EPERM";
  }
}

/**
 * 取写锁：memory.json / vectors.json 是「全量读改写成」，两个实例同时写会互相覆盖，
 * 所以同一份 $DSH_HOME 只允许一个写者。拿不到锁就进只读保护（能读能检索，不落盘）。
 * 崩溃残留的锁会被接管：先看 pid 还活着没有，再看时间戳兜底。
 */
function acquireLock() {
  const readLock = () => {
    try { return parseLock(readFileSync(LOCK_PATH, "utf8")); } catch { return null; }
  };
  const decide = (lock) => lockState({
    lock,
    now: Date.now(),
    selfPid: process.pid,
    isAlive: isProcessAlive,
    ttlMs: LOCK_TTL_MS,
  });

  const lock = readLock();
  const state = decide(lock);
  if (state === "mine") return { ok: true, notice: "" };
  if (state === "held") return { ok: false, notice: lockNotice("held", lock) };

  // broken / stale：尝试创建 —— wx 保证「已存在就失败」，只有一个赢家
  try {
    mkdirSync(HOME_DIR, { recursive: true });
    writeFileSync(LOCK_PATH, lockPayload(process.pid, Date.now(), HOME_DIR), { encoding: "utf8", flag: "wx" });
    return { ok: true, notice: state === "stale" ? lockNotice("stale", lock) : "" };
  } catch {
    // 被别人抢先创建了，或者那句 wx 撞上了残留锁 —— 再判一次
    const fresh = readLock();
    const again = decide(fresh);
    if (again === "mine") return { ok: true, notice: "" };
    if (again === "held") return { ok: false, notice: lockNotice("held", fresh) };
    // 仍是 stale：说明持有者确实不在了（刚判过），删掉再抢一次。
    // 少了这一步，崩溃残留的锁就永远抢占不了 —— 用户会再也写不进记忆。
    try {
      unlinkSync(LOCK_PATH);
      writeFileSync(LOCK_PATH, lockPayload(process.pid, Date.now(), HOME_DIR), { encoding: "utf8", flag: "wx" });
      return { ok: true, notice: lockNotice("stale", fresh) };
    } catch {
      return { ok: false, notice: "写锁争用：另一个实例刚拿到锁。为避免互相覆盖，本次进入只读保护。" };
    }
  }
}

/** 释放锁（只删自己持有的那份，别把别人的锁删了）。 */
function releaseLock() {
  try {
    const lock = parseLock(readFileSync(LOCK_PATH, "utf8"));
    if (lock !== null && lock.pid === process.pid) unlinkSync(LOCK_PATH);
  } catch { /* 锁文件不在了就算了 */ }
}

/**
 * 把数据文件复制到 backups/ 下（只留最近 BACKUP_KEEP 份）。
 * 迁移前、或解析失败时调用 —— 任何「可能改写用户数据」的动作之前，先留一份证据。
 * @returns {string} 备份文件完整路径；失败返回空串（不阻塞主流程）
 */
function backupFile(path) {
  try {
    mkdirSync(BACKUP_DIR, { recursive: true });
    const base = basename(path);
    const dest = join(BACKUP_DIR, backupName(base, Date.now()));
    copyFileSync(path, dest);
    const prefix = base + ".";
    const all = readdirSync(BACKUP_DIR).filter((name) => name.startsWith(prefix));
    for (const stale of pickBackupsToKeep(all, BACKUP_KEEP)) {
      try { unlinkSync(join(BACKUP_DIR, stale)); } catch { /* 删不掉就算了 */ }
    }
    return dest;
  } catch {
    return "";
  }
}

class MemoryStore {
  constructor() {
    this.protection = { readOnly: false, version: STORE_VERSION, notice: "", reason: "" };
    this.value = this.read();
  }

  read() {
    if (!existsSync(STORE_PATH)) return normalizeStore(null);
    let raw = null;
    try {
      raw = JSON.parse(readFileSync(STORE_PATH, "utf8"));
    } catch (error) {
      // 解析失败 ≠ 没有记忆：先留证据，再降级启动（不要静默显示空库）
      const saved = backupFile(STORE_PATH);
      this.protection = {
        readOnly: true,
        version: 0,
        notice: "memory.json 解析失败，已按空记忆启动（原文件" + (saved === "" ? "备份失败" : "已备份到 " + saved) + "）。",
        reason: String(error && error.message ? error.message : error).slice(0, 200),
      };
      return normalizeStore(null);
    }
    const decision = resolveOnRead(raw, STORE_VERSION, STORE_MIGRATIONS, "memory.json");
    this.protection = {
      readOnly: decision.readOnly === true,
      version: Number.isInteger(raw.version) ? raw.version : 0,
      notice: decision.notice,
      reason: decision.readOnly === true ? decision.notice : "",
    };
    if (decision.verdict === "migrate" && decision.readOnly === false) backupFile(STORE_PATH);
    return normalizeStore(decision.value);
  }

  flush() {
    if (this.protection.readOnly === true) return false;
    const workspaces = {};
    for (const [key, bucket] of this.value.workspaces) {
      workspaces[key] = {
        cwd: bucket.cwd,
        enabled: bucket.enabled,
        injectMode: bucket.injectMode,
        createdAt: bucket.createdAt,
        updatedAt: bucket.updatedAt,
        entries: bucket.entries,
      };
    }
    atomicWrite(STORE_PATH, JSON.stringify({
      version: STORE_VERSION,
      budgetChars: this.value.budgetChars,
      summaryProvider: this.value.summaryProvider,
      summaryModel: this.value.summaryModel,
      summaryTimeoutMs: this.value.summaryTimeoutMs,
      embedTimeoutMs: this.value.embedTimeoutMs,
      workspaces,
    }, null, 2));
    return true;
  }

  bucketOf(cwd) {
    const key = workspaceKey(cwd);
    if (key === "") return null;
    const bucket = this.value.workspaces.get(key);
    return bucket === undefined ? null : bucket;
  }

  entryOf(cwd, id) {
    const bucket = this.bucketOf(cwd);
    if (bucket === null) return null;
    const entry = bucket.entries.find((item) => item.id === id);
    return entry === undefined ? null : entry;
  }

  ensureBucket(cwd) {
    const key = workspaceKey(cwd);
    if (key === "" || typeof cwd !== "string" || cwd.trim() === "") {
      throw new Error("拿不到当前会话的工作区目录，无法读写工作区记忆");
    }
    let bucket = this.value.workspaces.get(key);
    if (bucket === undefined) {
      const at = nowIso();
      bucket = { cwd: cwd.trim().replace(/[\\/]+$/, ""), enabled: true, injectMode: "index", createdAt: at, updatedAt: at, entries: [] };
      this.value.workspaces.set(key, bucket);
    }
    return bucket;
  }

  trim(bucket) {
    // 规则抽在 store-logic.js（有单测钉着）：置顶的一律留下，其余按新→旧填满额度。
    // 没超上限时它原样返回、连重排都不做 —— 与旧行为一致。
    bucket.entries = trimEntries(bucket.entries, MAX_ENTRIES_PER_WORKSPACE).kept;
  }

  /** 写入/更新；needsSummary 表示需要排队做 AI 总结。 */
  add(cwd, input, origin, sessionId) {
    const bucket = this.ensureBucket(cwd);
    const text = normalizeText(input.text, MAX_TEXT_CHARS);
    if (text === "") throw new Error("记忆内容不能为空");
    const tags = normalizeTags(input.tags);
    const givenSummary = normalizeText(input.summary, MAX_SUMMARY_CHARS);
    const existing = bucket.entries.find((entry) => entry.text === text);
    const at = nowIso();
    if (existing !== undefined) {
      if (existing.locked) throw new Error("这条记忆已锁定，不能修改");
      const textChanged = existing.summary === "" || input.forceSummary === true || givenSummary !== "" || existing.text !== text;
      existing.tags = tags.length > 0 ? tags : existing.tags;
      if (typeof input.pinned === "boolean") existing.pinned = input.pinned;
      if (typeof input.meta === "boolean") existing.meta = input.meta;
      if (givenSummary !== "") {
        existing.summary = givenSummary;
        existing.summaryState = "manual";
      } else if (textChanged) {
        existing.summary = "";
        existing.summaryState = "pending";
      }
      existing.updatedAt = at;
      bucket.updatedAt = at;
      this.flush();
      return { entry: existing, created: false, needsSummary: existing.summaryState === "pending" };
    }
    const entry = {
      id: newId(),
      text,
      summary: givenSummary,
      summaryState: givenSummary === "" ? "pending" : "manual",
      tags,
      pinned: input.pinned === true,
      meta: input.meta === true,
      locked: false,
      source: { sessionId: typeof sessionId === "string" ? sessionId : "", at, origin },
      createdAt: at,
      updatedAt: at,
    };
    bucket.entries.push(entry);
    bucket.updatedAt = at;
    this.trim(bucket);
    this.flush();
    return { entry, created: true, needsSummary: entry.summaryState === "pending" };
  }

  keywordSearch(cwd, query, limit) {
    const bucket = this.bucketOf(cwd);
    if (bucket === null) return [];
    const words = String(query === undefined || query === null ? "" : query).toLowerCase().split(/\s+/).filter((word) => word !== "");
    const matched = bucket.entries.filter((entry) => {
      if (words.length === 0) return true;
      const haystack = (entry.text + " " + entry.summary + " " + entry.tags.join(" ")).toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
    return sortEntries(matched).slice(0, limit);
  }

  remove(cwd, ids) {
    const bucket = this.bucketOf(cwd);
    if (bucket === null) return { removed: [], skipped: [] };
    // 命中的才删；locked 的留下并把 id 报出来（静默失败会让用户以为删掉了）
    const { removed, skipped, kept } = partitionRemoval(bucket.entries, ids);
    if (removed.length > 0) {
      bucket.entries = kept;
      bucket.updatedAt = nowIso();
      this.flush();
    }
    return { removed, skipped };
  }

  update(cwd, id, patch) {
    const bucket = this.bucketOf(cwd);
    if (bucket === null) throw new Error("这个工作区还没有任何记忆");
    const entry = bucket.entries.find((item) => item.id === id);
    if (entry === undefined) throw new Error("找不到这条记忆，可能在别处被删掉了");
    if (entry.locked && patch.force !== true) throw new Error("这条记忆已锁定，先解锁再改");
    let contentChanged = false;
    if (typeof patch.text === "string") {
      const text = normalizeText(patch.text, MAX_TEXT_CHARS);
      if (text === "") throw new Error("记忆内容不能为空");
      if (text !== entry.text) { entry.text = text; contentChanged = true; }
    }
    if (typeof patch.summary === "string") {
      const summary = normalizeText(patch.summary, MAX_SUMMARY_CHARS);
      entry.summary = summary;
      entry.summaryState = summary === "" ? "pending" : "manual";
      if (summary === "") contentChanged = true;
    }
    if (patch.tags !== undefined) {
      const tags = normalizeTags(patch.tags);
      if (JSON.stringify(tags) !== JSON.stringify(entry.tags)) contentChanged = true;
      entry.tags = tags;
    }
    if (typeof patch.pinned === "boolean") entry.pinned = patch.pinned;
    if (typeof patch.locked === "boolean") entry.locked = patch.locked;
    entry.updatedAt = nowIso();
    bucket.updatedAt = entry.updatedAt;
    this.flush();
    return { entry, contentChanged };
  }

  setEnabled(cwd, enabled) {
    const bucket = this.ensureBucket(cwd);
    bucket.enabled = enabled === true;
    bucket.updatedAt = nowIso();
    this.flush();
    return bucket;
  }

  setInjectMode(cwd, mode) {
    const bucket = this.ensureBucket(cwd);
    bucket.injectMode = mode === "full" || mode === "off" ? mode : "index";
    bucket.updatedAt = nowIso();
    this.flush();
    return bucket;
  }

  clear(cwd) {
    const key = workspaceKey(cwd);
    const bucket = key === "" ? null : this.value.workspaces.get(key);
    if (bucket === null || bucket === undefined) return 0;
    const count = bucket.entries.length;
    bucket.entries = [];
    bucket.updatedAt = nowIso();
    this.flush();
    return count;
  }

  setBudget(chars) {
    this.value.budgetChars = clampInt(chars, MIN_BUDGET_CHARS, MAX_BUDGET_CHARS, DEFAULT_BUDGET_CHARS);
    this.flush();
    return this.value.budgetChars;
  }

  setTimeouts(summaryMs, embedMs) {
    if (Number.isFinite(Number(summaryMs))) this.value.summaryTimeoutMs = clampInt(summaryMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, DEFAULT_SUMMARY_TIMEOUT_MS);
    if (Number.isFinite(Number(embedMs))) this.value.embedTimeoutMs = clampInt(embedMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, DEFAULT_EMBED_TIMEOUT_MS);
    this.flush();
    return { summaryTimeoutMs: this.value.summaryTimeoutMs, embedTimeoutMs: this.value.embedTimeoutMs };
  }

  setSummaryRoute(provider, model) {
    if (typeof provider === "string" && provider !== "") this.value.summaryProvider = provider;
    if (typeof model === "string" && model !== "") this.value.summaryModel = model;
    this.flush();
    return { provider: this.value.summaryProvider, model: this.value.summaryModel };
  }

  overview() {
    const rows = [];
    for (const [key, bucket] of this.value.workspaces) {
      const pending = bucket.entries.filter((entry) => entry.summaryState === "pending").length;
      rows.push({
        key,
        cwd: bucket.cwd,
        enabled: bucket.enabled,
        injectMode: bucket.injectMode,
        count: bucket.entries.length,
        pending,
        updatedAt: bucket.updatedAt,
      });
    }
    rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return rows;
  }
}

/* ────────────────────────── 向量层（双层） ────────────────────────── */

function normalizeVector(raw) {
  // 新格式：Float32 原始字节的 base64；旧格式：数字数组（兼容手工改过的文件）
  if (isEncoded(raw)) return decodeVectorOfDim(raw, EMBED_DIM);
  if (!Array.isArray(raw) || raw.length !== EMBED_DIM) return null;
  const out = new Array(EMBED_DIM);
  for (let i = 0; i < EMBED_DIM; i += 1) {
    const value = Number(raw[i]);
    if (!Number.isFinite(value)) return null;
    out[i] = value;   // 不再截到 5 位小数：float32 本身就比那个精度高
  }
  return out;
}

/**
 * 落盘形式：内存里的数字数组 → Float32 base64。
 * 内存中仍保留数字数组（余弦计算直接用），只在写文件这一步编码。
 */
function encodeForDisk(value) {
  const workspaces = {};
  for (const [key, rows] of Object.entries(value.workspaces)) {
    const bucket = {};
    for (const [id, row] of Object.entries(rows)) {
      const next = {};
      if (typeof row.at === "string") next.at = row.at;
      if (Array.isArray(row.s)) next.s = encodeVector(row.s);
      if (Array.isArray(row.d)) next.d = row.d.map((chunk) => (Array.isArray(chunk) ? encodeVector(chunk) : chunk));
      if (next.s === undefined && next.d === undefined) continue;
      bucket[id] = next;
    }
    workspaces[key] = bucket;
  }
  return { version: VECTOR_VERSION, model: value.model, dim: value.dim, workspaces };
}

class VectorStore {
  constructor() {
    this.protection = { readOnly: false, version: VECTOR_VERSION, notice: "", reason: "" };
    this.dirty = false;
    this.value = this.read();   // 迁移可能在这里把 dirty 置位
  }

  read() {
    const empty = { version: VECTOR_VERSION, model: EMBED_MODEL_ID, dim: EMBED_DIM, workspaces: {} };
    if (!existsSync(VECTORS_PATH)) return empty;
    let raw = null;
    try {
      raw = JSON.parse(readFileSync(VECTORS_PATH, "utf8"));
    } catch (error) {
      const saved = backupFile(VECTORS_PATH);
      this.protection = {
        readOnly: true,
        version: 0,
        notice: "vectors.json 解析失败，已按空向量库启动（原文件" + (saved === "" ? "备份失败" : "已备份到 " + saved) + "）。记忆本体没丢，重建索引即可恢复。",
        reason: String(error && error.message ? error.message : error).slice(0, 200),
      };
      return empty;
    }
    if (raw === null || typeof raw !== "object") return empty;
    const decision = resolveOnRead(raw, VECTOR_VERSION, VECTOR_MIGRATIONS, "vectors.json");
    this.protection = {
      readOnly: decision.readOnly === true,
      version: Number.isInteger(raw.version) ? raw.version : 0,
      notice: decision.notice,
      reason: decision.readOnly === true ? decision.notice : "",
    };
    if (decision.verdict === "migrate" && decision.readOnly === false) {
      backupFile(VECTORS_PATH);
      this.dirty = true;   // 迁移结果要落盘，否则磁盘上会一直是旧格式
    }
    const source = decision.value.workspaces !== null && typeof decision.value.workspaces === "object" ? decision.value.workspaces : {};
      const workspaces = {};
      for (const [key, rows] of Object.entries(source)) {
        if (rows === null || typeof rows !== "object") continue;
        const bucket = {};
        for (const [id, row] of Object.entries(rows)) {
          if (row === null || typeof row !== "object") continue;
          const record = { at: typeof row.at === "string" ? row.at : nowIso() };
          const deep = normalizeDeepVector(row.d);
          const shallow = normalizeVector(row.s);
          if (deep !== null) record.d = deep;
          if (shallow !== null) record.s = shallow;
          if (record.d === undefined && record.s === undefined) continue;
          bucket[id] = record;
        }
        workspaces[key] = bucket;
      }
    return { version: VECTOR_VERSION, model: EMBED_MODEL_ID, dim: EMBED_DIM, workspaces };
  }

  flush() {
    if (this.protection.readOnly === true) return false;
    atomicWrite(VECTORS_PATH, JSON.stringify(encodeForDisk(this.value)));
    this.dirty = false;
    return true;
  }

  bucketFor(cwd, create) {
    const key = workspaceKey(cwd);
    if (key === "") return null;
    let bucket = this.value.workspaces[key];
    if (bucket === undefined) {
      if (create !== true) return null;
      bucket = {};
      this.value.workspaces[key] = bucket;
    }
    return bucket;
  }

  recordOf(cwd, id) {
    const bucket = this.bucketFor(cwd, false);
    if (bucket === null) return null;
    const row = bucket[id];
    return row === undefined ? null : row;
  }

  setDeep(cwd, id, vector) {
    const bucket = this.bucketFor(cwd, true);
    if (bucket === null) return;
    const record = bucket[id] === undefined ? { at: nowIso() } : bucket[id];
    record.d = vector;
    record.at = nowIso();
    bucket[id] = record;
    this.dirty = true;
  }

  setShallow(cwd, id, vector) {
    const bucket = this.bucketFor(cwd, true);
    if (bucket === null) return;
    const record = bucket[id] === undefined ? { at: nowIso() } : bucket[id];
    record.s = vector;
    record.at = nowIso();
    bucket[id] = record;
    this.dirty = true;
  }

  drop(cwd, ids) {
    const bucket = this.bucketFor(cwd, false);
    if (bucket === null) return;
    let changed = false;
    for (const id of ids) if (bucket[id] !== undefined) { delete bucket[id]; changed = true; }
    if (changed) this.dirty = true;
  }

  dropWorkspace(cwd) {
    const key = workspaceKey(cwd);
    if (key === "" || this.value.workspaces[key] === undefined) return;
    delete this.value.workspaces[key];
    this.dirty = true;
  }

  /** 浅层向量覆盖情况，给面板显示。 */
  counts(cwd, entries) {
    let shallow = 0;
    let deep = 0;
    let chunks = 0;
    for (const entry of entries) {
      const record = this.recordOf(cwd, entry.id);
      if (record === null) continue;
      if (record.s !== undefined) shallow += 1;
      if (record.d !== undefined) {
        deep += 1;
        chunks += Array.isArray(record.d) ? record.d.length : 1;
      }
    }
    return { shallow, deep, chunks, total: entries.length };
  }
}

/* ────────────────────────────── 嵌入器 ────────────────────────────── */

/** 嵌入超时（可通过面板调整；模块级变量让 embedTexts 不用到处传 store）。 */
let embedTimeoutMs = DEFAULT_EMBED_TIMEOUT_MS;

let embedderPromise = null;
const embedderStatus = { state: "idle", message: "", model: EMBED_MODEL_ID, dim: EMBED_DIM, loadedAt: 0, modelReady: false };

/* ── 模型自举：本地缺文件时自己拉（transformers 的运行时下载是关掉的，零联网） ── */

/** 模型应处的本地目录。 */
function modelDir() {
  return join(MODELS_DIR, EMBED_MODEL_ID);
}

/** 把清单里的文件量成「文件 → 字节数」表（读不到给 null）。 */
function modelSizes() {
  const table = {};
  for (const item of MODEL_FILES) {
    try {
      table[item.rel] = statSync(join(modelDir(), item.rel)).size;
    } catch {
      table[item.rel] = null;
    }
  }
  return table;
}

/** 跑一次 curl：退出码 0 才把 `.part` 改名成正式文件（半个文件不冒充完整）。 */
async function runCurl(subprocess, curlPath, url, dest) {
  const part = dest + ".part";
  try {
    const handle = subprocess.spawn({
      argv: [curlPath, "-L", "--fail", "-sS", "-m", "600", "-o", part, url],
      stdio: { stdout: { maxBytes: 2048 }, stderr: { maxBytes: 4096 } },
      graceMs: 5000,
    });
    const outcome = await handle.done;
    if (outcome === undefined || outcome.exitCode !== 0) {
      const code = outcome === undefined ? "?" : String(outcome.exitCode);
      let detail = "";
      try {
        detail = handle.collected.stderr.readFrom(0).text.trim().slice(0, 200);
      } catch { /* 拿不到就算了 */ }
      return { ok: false, message: "curl 退出码 " + code + (detail === "" ? "" : "：" + detail) };
    }
    renameSync(part, dest);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: String(error && error.message ? error.message : error).slice(0, 200) };
  }
}

/** 从镜像依次补齐缺失的模型文件。 */
async function downloadModel(ctx, report) {
  const subprocess = typeof ctx.get === "function" ? ctx.get("subprocess") : undefined;
  if (subprocess === undefined || typeof subprocess.spawn !== "function") {
    return { ok: false, message: "subprocess 服务不可用，无法自动下载模型" };
  }
  let curlPath = "curl.exe";
  try {
    const resolved = await subprocess.resolveExecutable("curl.exe");
    if (typeof resolved === "string" && resolved !== "") curlPath = resolved;
  } catch { /* 用裸名试 */ }

  const target = modelDir();
  try {
    mkdirSync(join(target, "onnx"), { recursive: true });
  } catch { /* 建不出来交给下载报错 */ }

  let lastError = "";
  for (const mirror of MODEL_MIRRORS) {
    let ok = true;
    for (const item of MODEL_FILES) {
      const dest = join(target, item.rel);
      try {
        if (statSync(dest).size >= item.min) continue;
      } catch { /* 缺文件，继续下 */ }
      report("正在下载嵌入模型 " + item.rel + "（" + mirror.replace(/^https?:\/\//, "") + "）…");
      const result = await runCurl(subprocess, curlPath, modelUrl(mirror, item.rel), dest);
      if (!result.ok) { ok = false; lastError = result.message; break; }
    }
    if (ok && isComplete(modelSizes())) return { ok: true, mirror: mirror };
  }
  return { ok: false, message: lastError === "" ? "所有下载源都失败了" : lastError };
}

let modelDownload = null;

/** 模型没到位就拉一遍（同一时刻只跑一个下载）。 */
async function ensureModel(ctx) {
  embedderStatus.modelReady = isComplete(modelSizes());
  if (embedderStatus.modelReady) return { ok: true, downloaded: false, mirror: "" };
  if (modelDownload !== null) return modelDownload;
  modelDownload = (async () => {
    const previous = embedderStatus.state;
    embedderStatus.state = "downloading";
    try {
      const result = await downloadModel(ctx, (text) => { embedderStatus.message = text; });
      const ready = isComplete(modelSizes());
      embedderStatus.modelReady = ready;
      if (result.ok === true && ready) {
        embedderStatus.state = "idle";
        embedderStatus.message = "";
        embedderPromise = null;   // 让下一次 ensureEmbedder 重新加载
        return { ok: true, downloaded: true, mirror: result.mirror === undefined ? "" : result.mirror };
      }
      embedderStatus.state = previous === "ready" ? "ready" : "idle";
      embedderStatus.message = result.message === undefined ? "模型下载失败" : result.message;
      return { ok: false, message: embedderStatus.message, mirror: "" };
    } finally {
      modelDownload = null;
    }
  })();
  return modelDownload;
}

function ensureEmbedder() {
  if (embedderPromise === null) {
    embedderStatus.state = "loading";
    embedderPromise = (async () => {
      const module = await import("@huggingface/transformers");
      module.env.allowRemoteModels = false;
      module.env.localModelPath = MODELS_DIR;
      const extractor = await module.pipeline("feature-extraction", EMBED_MODEL_ID, { dtype: "q8" });
      embedderStatus.state = "ready";
      embedderStatus.message = "";
      embedderStatus.loadedAt = Date.now();
      return extractor;
    })().catch((error) => {
      embedderPromise = null;
      embedderStatus.state = "failed";
      const raw = String(error && error.message ? error.message : error).slice(0, 400);
      embedderStatus.message = isComplete(modelSizes()) ? raw : "嵌入模型尚未就位（插件会自动下载；也可在面板点「加载模型」重试）：" + raw;
      throw error;
    });
  }
  return embedderPromise;
}

async function embedTexts(texts, timeoutMs) {
  const extractor = await ensureEmbedder();
  const budget = Number.isFinite(timeoutMs) ? timeoutMs : embedTimeoutMs;
  const output = await withTimeout(
    extractor(texts, { pooling: "mean", normalize: true }),
    budget,
    "嵌入计算（" + String(texts.length) + " 段）",
  );
  return output.tolist();
}

/** 给一个 promise 套超时；超时不取消底层工作，只是不再等它。 */
function withTimeout(promise, ms, label) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer = null;
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => { reject(new Error(label + "超时（" + String(ms) + "ms）")); }, ms);
  });
  return Promise.race([promise, guard]).finally(() => { if (timer !== null) clearTimeout(timer); });
}

/**
 * 深层正文分块：长记忆的**全文**都要进向量，而不是只有开头 512 token。
 * 尽量在换行/句号处断开；块数到上限时用最后一块承载结尾，保证头尾都有。
 */
function chunkText(text, chunkChars, maxChunks) {
  const source = String(text);
  if (source.length <= chunkChars) return [source];
  const pieces = [];
  let cursor = 0;
  while (cursor < source.length && pieces.length < maxChunks) {
    let end = Math.min(source.length, cursor + chunkChars);
    if (end < source.length) {
      const window = source.slice(cursor, end);
      const breakAt = Math.max(
        window.lastIndexOf("\n"),
        window.lastIndexOf("。"),
        window.lastIndexOf("；"),
        window.lastIndexOf("！"),
        window.lastIndexOf(". "),
      );
      if (breakAt > Math.floor(chunkChars * 0.55)) end = cursor + breakAt + 1;
    }
    const piece = source.slice(cursor, end).trim();
    if (piece !== "") pieces.push(piece);
    cursor = end;
  }
  if (cursor < source.length && pieces.length > 0) {
    pieces[pieces.length - 1] = source.slice(Math.max(0, source.length - chunkChars)).trim();
  }
  return pieces.length === 0 ? [source] : pieces;
}

/** 深层向量：三种形态都要认 —— base64 单串 / 旧的单向量数字数组 / 旧的多块数字数组。 */
function normalizeDeepVector(raw) {
  if (isEncoded(raw)) {
    const single = decodeVectorOfDim(raw, EMBED_DIM);
    return single === null ? null : [single];
  }
  if (!Array.isArray(raw) || raw.length === 0) return null;
  if (typeof raw[0] === "number") {
    const single = normalizeVector(raw);
    return single === null ? null : [single];
  }
  return normalizeChunks(raw, EMBED_DIM, MAX_CHUNKS_PER_ENTRY);
}

/** 多块深层向量的得分：取最相似的那一块。 */
function bestChunkScore(queryVector, chunks) {
  let best = -Infinity;
  for (const chunk of chunks) {
    const score = cosine(queryVector, chunk);
    if (score > best) best = score;
  }
  return best;
}

function cosine(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

/** 写入时把两份向量都算出来（浅层用摘要，深层用全文）。 */
/** 写入时算两份向量：浅层一块（摘要），深层分块覆盖全文。 */
async function embedEntry(vectors, cwd, entry) {
  const result = { shallow: false, deep: false, chunks: 0 };
  try {
    const chunks = chunkText(entry.text, EMBED_CHUNK_CHARS, MAX_CHUNKS_PER_ENTRY);
    const deepVectors = await embedTexts(chunks);
    if (deepVectors.length > 0) {
      vectors.setDeep(cwd, entry.id, deepVectors);
      result.deep = true;
      result.chunks = deepVectors.length;
    }
  } catch { /* 深层补不上就只靠浅层检索 */ }
  try {
    const [shallowVector] = await embedTexts([shallowText(entry)]);
    if (shallowVector !== undefined) { vectors.setShallow(cwd, entry.id, shallowVector); result.shallow = true; }
  } catch { /* 浅层补不上时检索会回退到深层 */ }
  return result;
}

/** 只补浅层向量（AI 总结完成后调用）。 */
async function embedShallowOnly(vectors, cwd, entry) {
  try {
    const [vector] = await embedTexts([shallowText(entry)]);
    if (vector !== undefined) { vectors.setShallow(cwd, entry.id, vector); return true; }
  } catch { /* ignore */ }
  return false;
}

/* ────────────────────────────── AI 总结层 ────────────────────────────── */

let llmService = null;
const summaryQueue = [];
let summaryRunning = false;
const summaryStatus = { done: 0, failed: 0, total: 0, lastError: "", lastAt: 0, busy: false };
/** 并发度：总结是纯 IO 等待，开 4 路足够快又不至于把 API 打爆。 */
const SUMMARY_CONCURRENCY = 4;

async function generateSummary(store, text) {
  if (llmService === null) throw new Error("LLM 服务不可用");
  const module = await import("@deepseek-ai/dsh-llm");
  // 要点只要几十个字，没必要把上万字的深层正文整段喂进去：既省 token/时间，
  // 也避免输入过长把推理模型带偏、输出直接冲到 maxTokens 上限。
  // 自适应：第一轮用 SUMMARY_INPUT_CHARS，若仍撞上限就砍到 1/4 再试一次（实测能把失败率压到近 0）。
  const budgets = [SUMMARY_INPUT_CHARS, Math.round(SUMMARY_INPUT_CHARS / 4)];
  let lastError = null;
  for (const budget of budgets) {
    const source = text.length > budget ? text.slice(0, budget) + "\n…（正文过长，此处只取开头节选）" : text;
    const messages = [module.createUserMessage({
      content: [{ type: "text", text: "记忆条目：\n" + source }],
      source: { kind: "dsh-workspace-recollection" },
    })];
    const assembler = new module.BlockAssembler();
    const timeoutMs = Number.isFinite(store.value.summaryTimeoutMs) ? store.value.summaryTimeoutMs : DEFAULT_SUMMARY_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => { try { controller.abort(); } catch { /* ignore */ } }, timeoutMs);
    try {
      for await (const chunk of llmService.stream({
        provider: store.value.summaryProvider,
        model: store.value.summaryModel,
        messages,
        system: SUMMARY_SYSTEM,
        maxTokens: 1024,
        reasoningEffort: "off",
        purpose: "session-memory-summary",
        signal: controller.signal,
      })) {
        assembler.push(chunk);
      }
    } finally {
      clearTimeout(timer);
    }
    const finish = assembler.finish;
    const blocks = assembler.blocks();
    const produced = blocks.filter((block) => block.type === "text").map((block) => block.text).join(" ").trim();
    if (produced !== "") {
      // 被截断也算成功：对「一句话要点」来说，截断下来的那部分通常已经够用。
      return produced;
    }
    if (finish !== undefined && finish !== null && finish.kind === "max-tokens") {
      lastError = new Error("总结模型在 " + String(budget) + " 字输入下仍撞上 max-tokens");
      continue;
    }
    if (finish !== undefined && finish !== null && finish.kind !== "stop") {
      const detail = finish.failure !== undefined && finish.failure !== null ? finish.failure.message : String(finish.kind);
      throw new Error("总结模型未正常结束（" + String(finish.kind) + "）：" + String(detail).slice(0, 300));
    }
    return produced;
  }
  throw lastError === null ? new Error("总结模型没有返回内容") : lastError;
}

function queueSummary(store, vectors, cwd, entryId) {
  if (!summaryQueue.some((job) => job.cwd === cwd && job.entryId === entryId)) {
    summaryQueue.push({ cwd, entryId });
    summaryStatus.total += 1;
  }
  void drainSummaryQueue(store, vectors);
}

/** 单个总结任务：拿要点 → 写回 → 补浅层向量 → 刷新索引。并发执行，互不干扰。 */
async function processSummaryJob(store, vectors, job) {
  const entry = store.entryOf(job.cwd, job.entryId);
  if (entry === null || entry.summaryState !== "pending") return;
  try {
    const summary = await generateSummary(store, entry.text);
    if (summary === "") throw new Error("总结模型没有返回内容");
    const fresh = store.entryOf(job.cwd, job.entryId);
    if (fresh === null) return;
    fresh.summary = normalizeText(summary, MAX_SUMMARY_CHARS);
    fresh.summaryState = "ready";
    fresh.updatedAt = nowIso();
    const bucket = store.bucketOf(job.cwd);
    if (bucket !== null) bucket.updatedAt = fresh.updatedAt;
    store.flush();
    await embedShallowOnly(vectors, job.cwd, fresh);
    vectors.flush();
    const latest = store.bucketOf(job.cwd);
    if (latest !== null) writeMemoryFile(latest);
    summaryStatus.done += 1;
  } catch (error) {
    summaryStatus.failed += 1;
    summaryStatus.lastError = String(error && error.message ? error.message : error).slice(0, 300);
    const fresh = store.entryOf(job.cwd, job.entryId);
    if (fresh !== null && fresh.summary === "") {
      fresh.summary = ruleSummary(fresh.text);
      fresh.summaryState = "failed";
      store.flush();
      await embedShallowOnly(vectors, job.cwd, fresh);
      vectors.flush();
      const failedBucket = store.bucketOf(job.cwd);
      if (failedBucket !== null) writeMemoryFile(failedBucket);
    }
  }
  summaryStatus.lastAt = Date.now();
}

async function drainSummaryQueue(store, vectors) {
  if (summaryRunning) return;
  summaryRunning = true;
  summaryStatus.busy = true;
  try {
    while (summaryQueue.length > 0) {
      const batch = summaryQueue.splice(0, SUMMARY_CONCURRENCY);
      await Promise.all(batch.map((job) => processSummaryJob(store, vectors, job)));
    }
  } finally {
    summaryRunning = false;
    summaryStatus.busy = false;
  }
}

/* 历史会话的读取与切段在 ./sessions.js —— 那边的纯函数部分有单测，改它之前先跑 tests/sessions.test.mjs */

/** session_read 的默认视图：一轮一行（你说的话 + 我的结论首句）。 */
function digestLine(segment, index) {
  const last = segment.said.length > 0 ? oneLine(segment.said[segment.said.length - 1]) : "（这一轮没有文字结论）";
  const when = segment.time > 0 ? new Date(segment.time).toISOString().slice(5, 16).replace("T", " ") : "";
  return "#" + String(index) + (when === "" ? "" : " " + when) + "  你：" + truncate(oneLine(segment.ask), 90) +
    "\n      我：" + truncate(last, 140);
}

/* ── 硬约束：不许绕过 session_read 去手工解压会话文件 ── */

/**
 * 工具调用前的同步判定。返回字符串 = deny（该字符串会作为模型可见的拒绝理由）；返回 null = 放行。
 * 设计意图：**用代码堵路，而不是用提示词劝告** —— 实测劝告在 system prompt 里也拦不住"最短路径"。
 */
function sessionFileGuard(exec) {
  const name = exec !== null && exec !== undefined && typeof exec.name === "string" ? exec.name : "";
  if (name !== "run_code" && name !== "pwsh" && name !== "bash") return null;
  const args = exec.arguments;
  if (args === null || typeof args !== "object") return null;
  const pieces = [];
  for (const key of ["code", "command", "description"]) {
    const value = args[key];
    if (typeof value === "string" && value !== "") pieces.push(value);
  }
  const text = pieces.join("\n");
  if (text === "") return null;
  if (text.includes(SESSION_READ_ALLOW_MARK)) return null;
  if (SESSION_TARGET_RE.test(text) === false) return null;
  if (SESSION_BYPASS_RE.test(text) === false) return null;
  return "已拦截：这条调用试图手工解压 .dsh/sessions 下的会话文件（多帧 zstd 流，成本高还容易读错）。" +
    "历史会话走正门 —— session_read：不带参数列出本工作区的会话；{ id: \"…\", tail: 8 } 看最近几轮摘要；" +
    "{ id: \"…\", mode: \"raw\", from: 1, to: 3 } 取指定轮次的完整原文（含当时的思考）。" +
    "要把它消化进长期记忆用 memory_import；检索已有记忆用 memory_recall / memory_detail。" +
    "确实需要在脚本里解压时（例如维护本插件自身），在命令或代码里带上标记 " + SESSION_READ_ALLOW_MARK + " 再调一次。" +
    "提示：凡是需要「以前做过什么 / 当时的细节」——先 memory_recall，记忆里没有再用 session_read，不要读原始会话文件。"+
    "";
}

/** 导入任务状态（后台跑，面板轮询）。 */
const importStatus = { running: false, sessionId: "", total: 0, done: 0, failed: 0, message: "", startedAt: 0, finishedAt: 0 };

/** 后台导入：逐段写入 + 向量化 + 排队 AI 总结。 */
async function runImport(store, vectors, cwd, files, depth, maxChars) {
  importStatus.running = true;
  importStatus.done = 0;
  importStatus.failed = 0;
  importStatus.message = "";
  importStatus.startedAt = Date.now();
  try {
    for (const item of files) {
      let segments = [];
      try { segments = segmentSession(readSessionEvents(item.file)); } catch (error) {
        importStatus.failed += 1;
        importStatus.message = "读会话失败：" + String(error && error.message ? error.message : error).slice(0, 200);
        continue;
      }
      for (const segment of segments) {
        const text = renderSegment(segment, item.id, depth, maxChars);
        try {
          const result = store.add(cwd, { text, tags: ["会话导入"] }, "import", item.id);
          await embedEntry(vectors, cwd, result.entry);
          vectors.flush();
          if (result.needsSummary) queueSummary(store, vectors, cwd, result.entry.id);
          importStatus.done += 1;
        } catch (error) {
          importStatus.failed += 1;
          importStatus.message = String(error && error.message ? error.message : error).slice(0, 200);
        }
      }
      const bucket = store.bucketOf(cwd);
      if (bucket !== null) writeMemoryFile(bucket);
    }
  } finally {
    importStatus.running = false;
    importStatus.finishedAt = Date.now();
    const bucket = store.bucketOf(cwd);
    if (bucket !== null) writeMemoryFile(bucket);
  }
}

/* ────────────────────────────── Memory.md ────────────────────────────── */

function memoryFilePath(cwd) {
  if (typeof cwd !== "string" || cwd.trim() === "") return "";
  return join(cwd.trim().replace(/[\\/]+$/, ""), MEMORY_FILE);
}

function extractManualBlock(text) {
  if (typeof text !== "string") return null;
  const begin = text.indexOf(MANUAL_BEGIN);
  const end = text.indexOf(MANUAL_END);
  if (begin === -1 || end === -1 || end < begin) return null;
  return text.slice(begin + MANUAL_BEGIN.length, end);
}

const DEFAULT_MANUAL = "## 手记\n\n（这块内容自动生成时不会被改动，想写什么写什么。）";

function tagPrefix(entry) {
  return entry.tags.length > 0 ? "[" + entry.tags.join("/") + "] " : "";
}

/** 索引里永远用浅层；没有 AI 摘要时退回规则摘要，并标出来。 */
function indexLine(entry) {
  const shallow = entry.summary !== "" ? entry.summary : ruleSummary(entry.text);
  const flag = entry.summaryState === "ready" || entry.summaryState === "manual" ? "" : (entry.summaryState === "pending" ? "（总结中）" : "（待总结）");
  return (entry.pinned ? "- ★ " : "- ") + tagPrefix(entry) + truncate(oneLine(shallow), SUMMARY_CHARS) + flag + "  `" + entry.id + "`";
}

function renderMemoryMarkdown(bucket, manualBlock) {
  const entries = bucket.entries;
  const pinned = entries.filter((entry) => entry.pinned);
  const recent = entries.filter((entry) => entry.pinned !== true).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, RECENT_IN_INDEX);
  const pending = entries.filter((entry) => entry.summaryState === "pending").length;
  const tagCount = new Map();
  for (const entry of entries) for (const tag of entry.tags) tagCount.set(tag, (tagCount.get(tag) || 0) + 1);
  const tagLine = [...tagCount.entries()].sort((a, b) => b[1] - a[1]).map(([tag, count]) => tag + "(" + count + ")").join(" · ");

  const head = [
    "# 工作区记忆 · " + (bucket.cwd || "（未知工作区）"),
    "",
    "> 本文件由 dsh-workspace-recollection 自动维护：MANUAL 区块之外的内容每次记忆变更都会重写，手改无效。",
    "> 这里列的是**浅层要点**（AI 压缩过的）；完整内容（思考/操作/细节）在深层向量库里，",
    "> 用 memory_recall 定位、memory_detail 取原文。",
    "",
    "**共 " + entries.length + " 条** · 置顶 " + pinned.length + (pending > 0 ? " · 待总结 " + pending : "") + " · 更新于 " + nowIso().slice(0, 16).replace("T", " "),
    "",
  ];
  const pinnedSection = pinned.length === 0
    ? ["## 置顶", "", "（还没有置顶的记忆。重要的那几条可以标 ★。）", ""]
    : ["## 置顶", "", ...pinned.map(indexLine), ""];
  const recentSection = recent.length === 0
    ? ["## 最近更新", "", "（本工作区还没有任何记忆。）", ""]
    : ["## 最近更新", "", ...recent.map(indexLine), ""];
  const tagsSection = tagLine === "" ? [] : ["## 标签", "", tagLine, ""];

  return head.concat(pinnedSection, recentSection, tagsSection, [
    MANUAL_BEGIN,
    (manualBlock !== null && manualBlock !== undefined ? manualBlock : DEFAULT_MANUAL).replace(/^\n+/, "").replace(/\n+$/, ""),
    MANUAL_END,
    "",
  ]).join("\n");
}

function writeMemoryFile(bucket) {
  const path = memoryFilePath(bucket.cwd);
  if (path === "") return { path: "", ok: false, reason: "工作区目录为空" };
  try {
    let manualBlock = null;
    if (existsSync(path)) {
      try { manualBlock = extractManualBlock(readFileSync(path, "utf8")); } catch { manualBlock = null; }
    }
    atomicWrite(path, renderMemoryMarkdown(bucket, manualBlock));
    return { path, ok: true, reason: "" };
  } catch (error) {
    return { path, ok: false, reason: String(error && error.message ? error.message : error).slice(0, 200) };
  }
}

function readMemoryFile(cwd) {
  const path = memoryFilePath(cwd);
  if (path === "" || !existsSync(path)) return "";
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

/* ─────────────────────────── 会话 → 工作区 ─────────────────────────── */

async function resolveCwd(ctx, sessionId) {
  if (typeof sessionId !== "string" || sessionId === "") return "";
  try {
    const live = ctx.get("agents")?.get?.(sessionId);
    const liveCwd = live?.session?.header?.cwd;
    if (typeof liveCwd === "string" && liveCwd !== "") return liveCwd;
  } catch { /* 继续下一级 */ }
  try {
    const registry = ctx.get("workspaceRegistry");
    const header = await registry?.readSessionHeader?.(sessionId);
    const cwd = header?.cwd;
    if (typeof cwd === "string" && cwd !== "") return cwd;
  } catch { /* 忽略 */ }
  return "";
}

/* ─────────────────────── system prompt 注入 ─────────────────────── */

/** 置顶条目在 prompt 里也用浅层（要细节让模型自己去 memory_detail）。 */
function pinnedLine(entry) {
  return "- ★ " + tagPrefix(entry) + oneLine(entry.summary !== "" ? entry.summary : ruleSummary(entry.text)) + "  `" + entry.id + "`";
}

/**
 * 取内容的顺序（注入进每一轮）。
 * 三层工具都在，但要写清「能停就停」——否则容易变成三层各调一遍的仪式。
 */
const FETCH_ORDER_LINE =
  "取内容**按需逐层、够用就停**（别为了『完整』逐层都调一遍）：① memory_recall 拿要点 → " +
  "② 要点不够，就用要点里的关键词 memory_locate 拿段号，再 memory_detail({ ids, segments }) 只取那几段切片 → " +
  "③ 浅层要点和切片都还不够，才 memory_detail({ ids }) 整条兜底。";

function renderSection(store, cwd) {
  const bucket = store.bucketOf(cwd);
  if (bucket === null || bucket.enabled === false || bucket.injectMode === "off" || bucket.entries.length === 0) return "";
  const budget = store.value.budgetChars;
  // 元信息（meta:true —— 施工/状态记录之类，生来就会过期）：只留在记忆库里可检索，不占注入预算。
  const metaCount = bucket.entries.filter((entry) => entry.meta === true).length;
  const injectable = metaCount === 0 ? bucket.entries : bucket.entries.filter((entry) => entry.meta !== true);
  if (injectable.length === 0) return "";
  const pinned = injectable.filter((entry) => entry.pinned);
  const lines = [];

  if (bucket.injectMode === "full") {
    const ordered = [...injectable].sort((a, b) => (a.pinned === b.pinned ? b.updatedAt.localeCompare(a.updatedAt) : a.pinned ? -1 : 1));
    let used = 0;
    let dropped = 0;
    const kept = [];
    for (const entry of ordered) {
      const line = indexLine(entry);
      if (kept.length > 0 && used + line.length + 1 > budget) { dropped += 1; continue; }
      kept.push(line);
      used += line.length + 1;
    }
    const skippedParts = [];
    if (metaCount > 0) skippedParts.push(String(metaCount) + " 条元信息");
    lines.push("## 工作区记忆（全量模式，共 " + injectable.length + " 条" + (skippedParts.length > 0 ? "，另有 " + skippedParts.join("、") + "（只可检索、不进注入）" : "") + "）",
      "下面是本工作区的浅层要点索引。",
      FETCH_ORDER_LINE,
      "要回忆「之前做过什么 / 当时怎么决定的 / 那个坑是什么」→ 先 memory_recall（它自带相关度过滤，跑题的和长尾会被略去并在末尾列出 id）；要某次历史会话的原文 → session_read（不带 id 时列出会话；mode:\"raw\" 取指定轮次原文）。",
      "手工解压 .dsh/sessions 下的 zstd 文件已被插件在工具层拦截（要放行须带显式标记），走上面两个正门即可。",
      kept.join("\n"));
    if (dropped > 0) lines.push("（还有 " + dropped + " 条因预算未展开。）");
    return lines.join("\n");
  }

  // 有被跳过的条目时不能直接用磁盘上的 Memory.md（它含全部条目），改为按「可注入集合」重渲染。
  const memoryFile = metaCount === 0 ? readMemoryFile(cwd) : "";
  const indexText = (memoryFile !== "" ? memoryFile : renderMemoryMarkdown({ ...bucket, entries: injectable }, null)).trim();
  const indexPart = indexText.length > budget
    ? truncate(indexText, budget) + "\n\n（索引超长已截断，完整索引见工作区的 " + MEMORY_FILE + "。）"
    : indexText;
  lines.push("## 工作区记忆（跨会话）",
    "**要回忆「之前做过什么 / 当时怎么决定的 / 那个坑是什么」时，第一件事是调 memory_recall。**",
    FETCH_ORDER_LINE,
    "要**某次历史会话的原始对话**（含当时的思考、工具与结论）用 session_read：不带 id 时列出本工作区会话，{ id, mode: \"raw\", from, to } 取指定轮次原文。",
    "手工解压 .dsh/sessions 下的 zstd 文件已被插件在工具层拦截，走正门即可。",
    "有值得长期保留的新信息用 memory_write 记下来。",
    "",
    indexPart);

  if (pinned.length > 0) {
    const pinnedBudget = Math.max(600, Math.round(budget / 2));
    let used = 0;
    let dropped = 0;
    const kept = [];
    for (const entry of pinned) {
      const line = pinnedLine(entry);
      if (kept.length > 0 && used + line.length + 1 > pinnedBudget) { dropped += 1; continue; }
      kept.push(line);
      used += line.length + 1;
    }
    lines.push("", "### 置顶记忆（要点）", kept.join("\n"));
    if (dropped > 0) lines.push("（还有 " + dropped + " 条置顶未展开。）");
  }

  return lines.join("\n");
}

/* ──────────────────────────── 工具 ──────────────────────────── */

const toolsReport = { at: 0, registered: [], failed: [], guard: "off", guardDenied: 0 };

function agentCwdOf(exec) {
  const cwd = exec?.agent?.session?.header?.cwd;
  return typeof cwd === "string" ? cwd : "";
}

function sessionIdOf(exec) {
  const id = exec?.agent?.id ?? exec?.agent?.session?.id;
  return typeof id === "string" ? id : "";
}

/** 被过滤掉的那些：折成一行 id + 分数，随时能复查是不是误杀（要点就不附了，省 token）。 */
function formatDroppedLine(dropped) {
  const list = Array.isArray(dropped) ? dropped.filter((item) => item !== null && typeof item === "object") : [];
  if (list.length === 0) return "";
  const shown = list.slice(0, 8);
  const rest = list.length - shown.length;
  return "（已略去 " + String(list.length) + " 条：" +
    shown.map((item) => (item.id === "" ? "?" : item.id) + " " + Number(item.score).toFixed(3)).join(" · ") +
    (rest > 0 ? " …等 " + String(rest) + " 条" : "") + "）";
}

/** 取内容的顺序：能停就停，别为了"完整"把三层都调一遍。 */
const HOW_TO_FETCH =
  "怎么取（够用就停，别逐层都调一遍）：① 上面的要点就够 → 直接用；" +
  "② 要点不够 → memory_locate({ id, query }) 拿段号，再 memory_detail({ ids, segments: [段号] }) 只取切片；" +
  "③ 浅层要点和切片都不够（要当时的思考、命令全文）→ 才 memory_detail({ ids }) 整条兜底。";

function formatShallowHits(rows, cwd, query, dropped = [], notes = []) {
  const noteLines = (Array.isArray(notes) ? notes : []).map((note) => "· " + note);
  const droppedLine = formatDroppedLine(dropped);
  if (rows.length === 0) {
    return [
      "没有找到与「" + query + "」相关的记忆（工作区：" + cwd + "）。",
      ...noteLines,
      droppedLine,
      "",
      "下一步：换个更具体的说法再查；确认这件事该记而没记，就用 memory_write 补上。",
    ].filter((line) => line !== "").join("\n");
  }
  const body = rows.map((row) => "  " + row.entry.id + "  " + row.score.toFixed(3) +
    (row.layer === "deep" ? " （深层命中）" : row.layer === "demoted" ? " （要点弱命中）" : "") +
    "  " + tagPrefix(row.entry) + oneLine(row.entry.summary !== "" ? row.entry.summary : ruleSummary(row.entry.text)) +
    (row.entry.text.length >= LONG_ENTRY_CHARS
      ? "  ↳ 长文 " + String(row.entry.text.length) + " 字，可 memory_locate 细分"
      : ""));
  return [
    "工作区：" + cwd + " · 浅层命中 " + String(rows.length) + " 条（相似度，已按相关度滤掉跑题的与长尾）",
    ...body,
    ...noteLines,
    droppedLine,
    "",
    HOW_TO_FETCH,
  ].filter((line) => line !== "").join("\n");
}

/**
 * 时间通道的输出（v2.5）：那天的条目按发生时间列出，末尾给出通向会话原文的桥。
 * 刻意不显示分数 —— 时间命中是硬条件（日历日过滤），不是相似度排序的结果。
 */
function formatTimeline(rows, cwd, query, hint, total, sessions) {
  const span = hint.from === hint.to ? hint.from : hint.from + " ~ " + hint.to;
  const lines = [
    "工作区：" + cwd + " · 时间通道：" + span + "（从「" + oneLine(query) + "」里认出「" + hint.label + "」）",
  ];
  for (const row of rows) {
    lines.push("  " + row.entry.id + "  " + clockOf(row.entry.createdAt) + "  " + tagPrefix(row.entry) +
      oneLine(row.entry.summary !== "" ? row.entry.summary : ruleSummary(row.entry.text)) +
      (row.entry.text.length >= LONG_ENTRY_CHARS
        ? "  ↳ 长文 " + String(row.entry.text.length) + " 字，可 memory_locate 细分"
        : ""));
  }
  if (total > rows.length) lines.push("（那天共 " + String(total) + " 条，已列前 " + String(rows.length) + " 条）");
  if (sessions.length > 0) {
    lines.push("");
    lines.push("那天的会话：" + sessions.map((item) =>
      item.sessionId + "（" + clockOf(item.first) + "–" + clockOf(item.last) + "，" + String(item.count) + " 条）").join("；"));
    lines.push("要看当时的对话原文：session_read({ id: \"" + sessions[0].sessionId + "\", tail: 8 })");
  }
  lines.push("");
  lines.push("提示：时间通道只认「时间可信」的来源（agent / panel 写入的条目）。" +
    "从旧环境导入的存档（import）时间=落库日，不参与反查 —— " +
    "那是「哪天导进来的」，不是「哪天发生的事」。");
  return lines.join("\n");
}

function formatDeepDetails(entries, wantedSegments = []) {
  if (entries.length === 0) return "没有找到这些 id 对应的记忆。";
  const pickedNumbers = Array.isArray(wantedSegments)
    ? [...new Set(wantedSegments.filter((value) => Number.isInteger(value) && value > 0))]
    : [];
  const parts = entries.map((entry) => {
    const tags = entry.tags.length > 0 ? " #" + entry.tags.join(" #") : "";
    const flags = (entry.pinned ? "★置顶 " : "") + (entry.locked ? "🔒锁定 " : "");
    const summaryLine = entry.summary !== "" ? "**要点**：" + oneLine(entry.summary) + "\n\n" : "";
    // 没给段号 = 老行为：整条正文原样返回（向后兼容）
    if (pickedNumbers.length === 0) {
      return "### " + entry.id + "\n" + summaryLine + flags + tags +
        " · 更新于 " + entry.updatedAt.slice(0, 10) + "\n\n" + entry.text;
    }
    // 给了段号 = 切片模式：只回这几段（memory_locate 定位出来的）
    const segments = segmentText(entry.text);
    const picked = segments.filter((segment) => pickedNumbers.includes(segment.idx));
    if (picked.length === 0) {
      return "### " + entry.id + "\n（没有段号 " + pickedNumbers.join("、") + "：这条共 " +
        String(segments.length) + " 段，先用 memory_locate 看段号）";
    }
    const missing = pickedNumbers.filter((value) => !picked.some((segment) => segment.idx === value));
    const body = picked.map((segment) => "**#" + String(segment.idx) + "**" +
      (segment.label === "" ? "" : " `" + segment.label + "`") +
      "（" + String(segment.chars) + " 字）\n" + segment.text).join("\n\n");
    return "### " + entry.id + " · 切片 " + picked.map((segment) => "#" + String(segment.idx)).join("、") +
      " / 共 " + String(segments.length) + " 段（全文 " + String(entry.text.length) + " 字）\n\n" +
      summaryLine + body + flags + tags +
      (missing.length > 0 ? "\n\n（这条里没有段号 " + missing.join("、") + "）" : "");
  });
  return truncate(parts.join("\n\n---\n\n"), MAX_TEXT_CHARS * 2);
}

/** 命中词展示：ASCII 词（路径 / 命令 / 常量名）优先，中文 bigram 只留前几个。 */
function displayHits(tokens) {
  const ascii = [];
  const cjk = [];
  for (const token of tokens) {
    if (/^[\x00-\x7f]+$/.test(token)) ascii.push(token);
    else cjk.push(token);
  }
  return [...ascii.slice(0, 5), ...cjk.slice(0, 4)];
}

/**
 * 段级引索清单：段号 / 小标题 / 字数 / 命中词 / 一句预览。
 * **正文一个字都不回** —— 这是这一层省 token 的全部理由。
 */
function formatSegmentIndex(entry, segments, hits, query, missed) {
  const head = "### " + entry.id + " · 共 " + String(segments.length) + " 段 / " +
    String(entry.text.length) + " 字" +
    (query === ""
      ? "（没给关键词，按顺序列出前几段）"
      : missed
        ? "（关键词「" + oneLine(query) + "」在这条里没命中，下面是前几段）"
        : "（按「" + oneLine(query) + "」定位）");
  const rows = hits.map((hit) => {
    const label = hit.label === "" ? "（无标题）" : "`" + hit.label + "`";
    const words = hit.hits.length === 0 ? "" : "  ↳ " + displayHits(hit.hits).join("、");
    return "  #" + String(hit.idx) + "  " + label + "  " + String(hit.chars) + " 字" + words +
      (hit.preview === "" ? "" : "\n      " + hit.preview);
  });
  return head + "\n" + rows.join("\n") +
    "\n\n取切片：memory_detail({ ids: [\"" + entry.id + "\"], segments: [" +
    hits.map((hit) => String(hit.idx)).join(", ") + "] })" +
    (hits.length < segments.length ? "（这条共 " + String(segments.length) + " 段，其余没列出）" : "");
}

function formatEntries(entries, cwd) {
  if (entries.length === 0) return "本工作区（" + cwd + "）里没有匹配的记忆。";
  const rows = entries.map((entry) => {
    const flags = (entry.pinned ? "★置顶 " : "") + (entry.locked ? "🔒锁定 " : "");
    const tags = entry.tags.length > 0 ? " #" + entry.tags.join(" #") : "";
    const state = entry.summaryState === "ready" || entry.summaryState === "manual" ? "" : "（" + entry.summaryState + "）";
    return "- " + entry.id + " " + flags + state + oneLine(entry.summary !== "" ? entry.summary : ruleSummary(entry.text)) + tags + "（" + entry.updatedAt.slice(0, 10) + "）";
  });
  return "工作区：" + cwd + "（" + entries.length + " 条，浅层要点）\n" + truncate(rows.join("\n"), MAX_TEXT_CHARS * 2) +
    "\n\n完整内容用 memory_detail({ ids: [...] }) 取。";
}

/* ───────────────── 时间通道 & 排序分层的辅助（v2.5） ───────────────── */

/**
 * 时间是否可信：只有 agent / panel 写入的条目，时间字段才代表「事件发生时间」。
 * 从旧环境导入的存档（import）createdAt 是**落库时间** ——
 * 那批存档全是导入那一天，拿它做时间反查会把它们一起捞出来。
 */
function timeTrustworthy(entry) {
  const origin = entry.source !== null && typeof entry.source === "object" && typeof entry.source.origin === "string"
    ? entry.source.origin
    : "agent";
  return origin !== "import" && !origin.startsWith("import-");
}

/** 时间通道：筛出「那天」的条目，按发生时间正序（保持那天的叙事顺序）。 */
function timelineRows(entries, hint, limit) {
  const picked = [];
  for (const entry of entries) {
    if (!timeTrustworthy(entry)) continue;
    if (!inDayRange(entry.createdAt, hint.from, hint.to) && !inDayRange(entry.updatedAt, hint.from, hint.to)) continue;
    picked.push(entry);
  }
  picked.sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt)));
  const cap = Math.max(limit, 12);
  return {
    rows: picked.slice(0, cap).map((entry) => ({ entry, score: 1, layer: "timeline" })),
    total: picked.length,
    sessions: groupSessions(picked),
  };
}

/** 那天的条目横跨了哪几次会话（source.sessionId）—— 这是通向 session_read 正门的桥。 */
function groupSessions(entries) {
  const map = new Map();
  for (const entry of entries) {
    const sid = entry.source !== null && typeof entry.source === "object" && typeof entry.source.sessionId === "string"
      ? entry.source.sessionId
      : "";
    if (sid === "") continue;
    const item = map.get(sid) || { sessionId: sid, count: 0, first: entry.createdAt, last: entry.createdAt };
    item.count += 1;
    if (entry.createdAt < item.first) item.first = entry.createdAt;
    if (entry.createdAt > item.last) item.last = entry.createdAt;
    map.set(sid, item);
  }
  return [...map.values()].sort((a, b) => a.last.localeCompare(b.last));
}

/**
 * 文档频率：词在多少条记忆的正文里出现过。同一轮查询里缓存，避免重复扫全库。
 * 只对 query 的少数几个词调用一次，开销约等于一次全库字符串扫描（几十毫秒）。
 */
function makeDfOf(entries) {
  const cache = new Map();
  return (word) => {
    const key = String(word).toLowerCase();
    if (cache.has(key)) return cache.get(key);
    let count = 0;
    for (const entry of entries) if (entry.text.toLowerCase().includes(key)) count += 1;
    cache.set(key, count);
    return count;
  };
}

/**
 * 引索二级验证（v2.5）：深层独占的候选，用**段级引索**再复核一次 —— 两条独立通道
 * （向量 vs 词面）交叉验证。只有命中「实词」（文档频率 ≤ INDEX_DF_MAX）才算通过：
 * 泛词命中毫无区分度（「什么」DF=98、「10」DF=122），实测会让跑题条目蒙混过关。
 *
 * @returns {boolean|null} true=通过；false/null=不通过（验证本身出错也按不通过处理）
 */
function verifyByIndex(text, query, dfOf) {
  try {
    const segments = segmentText(text);
    const hits = locateSegments(segments, query, 3);
    if (hits.length === 0) return false;
    const words = [];
    for (const hit of hits) for (const word of hit.hits) words.push(word);
    return rareHitOk(words, dfOf, INDEX_DF_MAX);
  } catch {
    return null;
  }
}

/** 浅层优先、深层兜底的检索。返回 { mode, rows, dropped, notes }；嵌入不可用返回 null。 */
async function recallEntries(store, vectors, cwd, query, limit, filterOptions = {}) {
  const bucket = store.bucketOf(cwd);
  if (bucket === null || bucket.entries.length === 0) return { mode: "empty", rows: [] };

  // ① 时间通道（v2.5）：query 里带「10月6日 / 九天前 / 昨天」→ 按本地日历日直接筛，不走向量。
  //    记忆的向量文本里从来没有时间戳，日期型查询在向量层没有任何落点（详见 lib/timehint.js）。
  const hint = parseTimeHint(query, new Date());
  if (hint !== null) {
    const timeline = timelineRows(bucket.entries, hint, limit);
    if (timeline.total > 0) {
      return {
        mode: "timeline",
        rows: timeline.rows,
        total: timeline.total,
        sessions: timeline.sessions,
        hint,
        dropped: [],
        notes: [],
      };
    }
  }

  const needsShallow = bucket.entries.filter((entry) => {
    const record = vectors.recordOf(cwd, entry.id);
    return record === null || record.s === undefined;
  });
  const needsDeep = bucket.entries.filter((entry) => {
    const record = vectors.recordOf(cwd, entry.id);
    return record === null || record.d === undefined;
  });
  if (needsShallow.length > 0 && needsShallow.length <= 200) {
    try {
      const embedded = await embedTexts(needsShallow.map((entry) => shallowText(entry)));
      needsShallow.forEach((entry, index) => { if (embedded[index] !== undefined) vectors.setShallow(cwd, entry.id, embedded[index]); });
    } catch { /* 补不上就只用已有的 */ }
  }
  if (needsDeep.length > 0 && needsDeep.length <= 200) {
    try {
      const embedded = await embedTexts(needsDeep.map((entry) => entry.text));
      needsDeep.forEach((entry, index) => { if (embedded[index] !== undefined) vectors.setDeep(cwd, entry.id, embedded[index]); });
    } catch { /* ignore */ }
  }
  if (vectors.dirty) vectors.flush();

  let queryVector = null;
  try {
    const [vector] = await embedTexts([query]);
    queryVector = vector;
  } catch {
    return null;
  }
  if (queryVector === null) return null;

  // ② 向量通道：两层都算分，但**深层赢要有资格**（v2.5 排序分层，见 noise.js 的 scoreEntry）。
  //    返回给模型的仍然只是要点 + id，深层分只影响排序，不会多花 token。
  const hardTokens = hardTokensOf(query);
  const dfOf = makeDfOf(bucket.entries);
  const scored = [];
  for (const entry of bucket.entries) {
    const record = vectors.recordOf(cwd, entry.id);
    if (record === null) continue;
    const shallowScore = record.s === undefined ? null : cosine(queryVector, record.s);
    const deepScore = record.d === undefined ? null : bestChunkScore(queryVector, record.d);
    if (shallowScore === null && deepScore === null) continue;
    scored.push({ entry, shallowScore, deepScore, hardHits: hardHitCount(entry, hardTokens) });
  }
  // 引索二级验证只对「可能进前列」的一段做：它要切段 + 扫全库算词频，
  // 没必要为第 50 名的东西付这份开销。先按现状分（max(浅层, 深层)）取一段。
  const verifyTop = Math.max(limit * 3, 12);
  scored.sort((a, b) =>
    Math.max(b.shallowScore ?? -1, b.deepScore ?? -1) - Math.max(a.shallowScore ?? -1, a.deepScore ?? -1));
  const rows = [];
  scored.forEach((item, index) => {
    const deepOnly = item.deepScore !== null && (item.shallowScore === null || item.deepScore > item.shallowScore);
    const risky = deepOnly && item.hardHits === 0 && (item.shallowScore ?? -1) < DEEP_GATE;
    const indexOk = index < verifyTop && risky ? verifyByIndex(item.entry.text, query, dfOf) : null;
    const decided = scoreEntry(item.shallowScore, item.deepScore, item.hardHits, indexOk);
    rows.push({ entry: item.entry, score: decided.score, layer: decided.layer });
  });
  rows.sort((a, b) => b.score - a.score);
  if (rows.length === 0) return { mode: "empty", rows: [], dropped: [], notes: [], filterMode: "auto" };
  // 先按 limit 取一段，再过噪音过滤（过滤只在这段里做，不改变「取多少条」的语义）。
  const filtered = filterHits(rows.slice(0, limit), query, filterOptions);
  return {
    mode: "hybrid",
    rows: filtered.kept,
    dropped: filtered.dropped,
    notes: filtered.notes,
    filterMode: filtered.mode,
  };
}

function registerTools(ctx, store, vectors) {
  ctx.inject(["tools"], (scoped) => {
    toolsReport.at = Date.now();
    // 硬约束：拦下「绕过正门手工解压会话文件」的工具调用（不依赖任何提示词自律）。
    try {
      scoped.effect(() => scoped.on("tools/pre-execute", (exec, next) => {
        const blocked = sessionFileGuard(exec);
        if (blocked === null) return next();
        toolsReport.guardDenied += 1;
        return Promise.resolve({
          kind: "deny",
          reason: blocked,
          displayReason: { zh: "已拦截：历史会话请用 session_read", en: "Blocked: use session_read for historical sessions" },
        });
      }), "session-memory: session-file guard");
      toolsReport.guard = "on";
    } catch (error) {
      toolsReport.guard = "failed: " + String(error && error.message ? error.message : error).slice(0, 160);
      ctx.logger?.warn?.("session-memory: guard not registered: %s", String(error && error.message ? error.message : error));
    }
    const attempt = (build) => {
      try {
        const tool = build();
        scoped.tools.register(tool);
        toolsReport.registered.push(tool.name);
      } catch (error) {
        toolsReport.failed.push(String(error && error.message ? error.message : error).slice(0, 300));
        ctx.logger?.warn?.("session-memory: tool not registered: %s", String(error && error.message ? error.message : error));
      }
    };

    attempt(() => defineTool({
      name: "memory_write",
      description:
        "把一条值得跨会话保留的信息写进当前工作区的长期记忆。text 写**完整**的深层内容（背景、当时的思考与判断、具体命令/路径、结果、教训都写进去，可以长）；" +
        "summary 写**一句话浅层要点**（60 字内、保留可检索的关键词），将来靠它被快速定位。summary 不给也行，会自动用 AI 压缩。",
      parameters: {
        text: { type: "string", required: true, description: "深层完整内容：是什么、为什么、怎么做、结果与细节。越具体越好。" },
        summary: { type: "string", description: "浅层一句话要点（60 字内，保留专有名词/路径/命令等关键词）。省略则自动 AI 总结。" },
        tags: { type: "array", description: "分类标签，例如 偏好/项目/约定/踩坑/环境。最多 8 个。", items: { type: "string", description: "标签文字" } },
        pinned: { type: "boolean", description: "置顶：索引里永远排最前，要点还会直接注入 system prompt。" },
        meta: {
          type: "boolean",
          description:
            "标记为「元信息」（我自己的施工/状态记录：改了哪个文件、待重启、自查等）。仍可被检索，但**不进 system prompt 注入**，" +
            "别让它占用注入预算。关于主人本人的事实、偏好、项目结论不要用这个。",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", required: true },
            created: { type: "boolean", required: true },
            total: { type: "integer", required: true },
            summary: { type: "string", required: true },
            pendingSummary: { type: "boolean", required: true },
          },
        },
        render: (_args, value) => [{
          type: "text",
          text: (value.created ? "已记住" : "已更新") + "（工作区共 " + String(value.total) + " 条）要点：" + truncate(oneLine(value.summary), 90) +
            (value.pendingSummary ? "（AI 总结排队中）" : ""),
        }],
      },
      execute: async (args, exec) => {
        const cwd = agentCwdOf(exec);
        if (cwd === "") throw new Error("拿不到当前会话的工作区目录，暂时无法写入工作区记忆");
        const result = store.add(cwd, args, "agent", sessionIdOf(exec));
        await embedEntry(vectors, cwd, result.entry);
        vectors.flush();
        const bucket = store.bucketOf(cwd);
        if (bucket !== null) writeMemoryFile(bucket);
        if (result.needsSummary) queueSummary(store, vectors, cwd, result.entry.id);
        return {
          id: result.entry.id,
          created: result.created,
          total: bucket === null ? 0 : bucket.entries.length,
          summary: result.entry.summary !== "" ? result.entry.summary : ruleSummary(result.entry.text),
          pendingSummary: result.needsSummary,
        };
      },
      presentCall: (args) => ({ card: "generic", title: "记住一条工作区记忆", kind: "other", rawInput: args }),
    }));

    attempt(() => defineTool({
      name: "memory_recall",
      description:
        "回忆「以前做过什么 / 当时怎么决定的 / 那个坑是什么」时**优先用它**——本工作区的历史沉淀都在记忆里，" +
        "比去翻 .dsh/sessions 下的会话文件快得多。在浅层记忆里语义检索，只返回要点和 id，很省 token。\n" +
        "**按需逐层取，拿到足够信息就停 —— 不要为了『完整』把三层都调一遍**：" +
        "① 本工具（浅层）回要点与 id；② 要点不够 → 用要点里的关键词调 memory_locate 定位段号，再 " +
        "memory_detail({ ids, segments }) 只取那几段切片；③ 浅层和切片都还不够（要看当时的思考、命令全文）→ 才 memory_detail({ ids }) 整条兜底。\n" +
        "query 里带日期或相对时间（「10月6日」「九天前」「昨天」）会走**时间通道**：直接列出那天的条目" +
        "以及涉及到的会话 id（可用 session_read 看原文），不走向量检索。\n" +
        "结果已按相关度自动过滤：跑题的、长尾的会折成一行 id+分数留在末尾（方便复查是不是误杀）；" +
        "看到「已略去」就说明本次确实没找到更相关的，别硬往那些条目上认。",
      parameters: {
        query: { type: "string", required: true, description: "想回忆什么，自然语言描述即可（例如「上次说的编码坑」）。" },
        limit: { type: "integer", description: "候选条数，默认 5，上限 20；过滤后可能少于它。" },
        filter: { type: "string", description: "过滤档位：\"auto\"（默认，略去跑题的与长尾）、\"off\"（全给，看原始排名）、\"strict\"（更严，只留明显相关的）。" },
        min_score: { type: "number", description: "显式相似度下限，低于它的一律略去；给了就以它为准。" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            count: { type: "integer", required: true },
            found: { type: "boolean", required: true },
            mode: { type: "string", required: true },
            text: { type: "string", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: String(value.text) }],
      },
      execute: async (args, exec) => {
        const cwd = agentCwdOf(exec);
        if (cwd === "") throw new Error("拿不到当前会话的工作区目录");
        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (query === "") throw new Error("要给出想回忆的内容");
        const limit = clampInt(args.limit, 1, 20, 5);
        const minScore = typeof args.min_score === "number" && Number.isFinite(args.min_score) ? args.min_score : null;
        const outcome = await recallEntries(store, vectors, cwd, query, limit, { mode: args.filter, minScore });
        if (outcome === null) {
          const fallback = store.keywordSearch(cwd, query, limit);
          return {
            count: fallback.length,
            found: fallback.length > 0,
            mode: "keyword-fallback",
            text: "（嵌入模型不可用，已退回关键词检索：" + embedderStatus.message + "）\n\n" + formatEntries(fallback, cwd),
          };
        }
        if (outcome.mode === "timeline") {
          return {
            count: outcome.rows.length,
            found: outcome.rows.length > 0,
            mode: "timeline",
            text: formatTimeline(outcome.rows, cwd, query, outcome.hint, outcome.total, outcome.sessions),
          };
        }
        return {
          count: outcome.rows.length,
          found: outcome.rows.length > 0,
          mode: outcome.mode,
          text: formatShallowHits(outcome.rows, cwd, query, outcome.dropped, outcome.notes),
        };
      },
      presentCall: (args) => ({ card: "generic", title: "定位工作区记忆", kind: "other", rawInput: args }),
    }));

    attempt(() => defineTool({
      name: "memory_locate",
      description:
        "在**已命中的那条记忆内部**定位到具体段落 —— 当 memory_recall 命中的条目很长（几千到两万字）时用它。" +
        "只返回段号、小标题、字数、命中的关键词和一句预览，**不回正文**，所以极其省 token；" +
        "拿到段号后再用 memory_detail({ ids, segments }) 只取那几段切片。" +
        "query 直接用 recall 要点里的关键词就行（路径 / 命令 / 常量名 / 专有名词最准），不用另起说法。" +
        "定位完全在本地 CPU 上跑（段级 BM25 + 中文 bigram），对路径、命令、常量名这类词特别准。",
      parameters: {
        id: { type: "string", description: "要细看的记忆 id（memory_recall / memory_search 拿到的）。" },
        ids: { type: "array", description: "也可以一次给多条（最多 5 条）。", items: { type: "string", description: "记忆 id" } },
        query: { type: "string", description: "要找什么。关键词最好用（路径 / 命令 / 专有名词 / 常量名）；省略则按顺序列出前几段。" },
        limit: { type: "integer", description: "每条最多列几段，默认 5，上限 20。" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            found: { type: "boolean", required: true },
            count: { type: "integer", required: true },
            text: { type: "string", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: String(value.text) }],
      },
      execute: (args, exec) => {
        const cwd = agentCwdOf(exec);
        if (cwd === "") throw new Error("拿不到当前会话的工作区目录");
        const wanted = [];
        if (typeof args.id === "string" && args.id.trim() !== "") wanted.push(args.id.trim());
        if (Array.isArray(args.ids)) {
          for (const item of args.ids) {
            if (typeof item === "string" && item.trim() !== "" && !wanted.includes(item.trim())) wanted.push(item.trim());
          }
        }
        if (wanted.length === 0) throw new Error("至少要给一个 id（id 或 ids）");
        const query = typeof args.query === "string" ? args.query.trim() : "";
        const limit = clampInt(args.limit, 1, 20, 5);
        const blocks = [];
        let found = 0;
        for (const id of wanted.slice(0, 5)) {
          const entry = store.entryOf(cwd, id);
          if (entry === null) {
            blocks.push("### " + id + "\n找不到这条记忆（可能不属于当前工作区），先用 memory_recall / memory_search 确认 id。");
            continue;
          }
          const segments = segmentText(entry.text);
          if (segments.length === 0) {
            blocks.push("### " + entry.id + "\n（这条记忆没有正文）");
            continue;
          }
          found += 1;
          let hits = locateSegments(segments, query, limit);
          const missed = hits.length === 0;
          // 没命中就直接把前几段摆出来（比空手回去有用）
          if (missed) {
            hits = segments.slice(0, limit).map((segment) => ({
              idx: segment.idx,
              score: 0,
              hits: [],
              label: segment.label,
              heading: segment.heading,
              preview: segment.preview,
              chars: segment.chars,
              start: segment.start,
            }));
          }
          blocks.push(formatSegmentIndex(entry, segments, hits, query, missed));
        }
        return Promise.resolve({
          found: found > 0,
          count: found,
          text: blocks.join("\n\n") +
            (found > 0 ? "\n\n（正文一个字都没回 —— 段号拿到后，用 memory_detail({ ids, segments }) 只取其切片。）" : ""),
        });
      },
      presentCall: (args) => ({ card: "generic", title: "定位记忆段落", kind: "other", rawInput: args }),
    }));

    attempt(() => defineTool({
      name: "memory_detail",
      description:
        "按 id 取出记忆的**深层完整内容**（背景、当时的思考、具体命令与路径、结果、细节）。" +
        "**这是最后一层，别一上来就用**：先用 memory_recall 拿 id；条目长时先 memory_locate 拿段号、" +
        "用 segments 只取那几段切片；只有**浅层要点和切片都不够**（确实要当时的思考原文、成段的命令与路径）时，" +
        "才省略 segments 整条取回。",
      parameters: {
        ids: { type: "array", required: true, description: "memory_recall / memory_search 返回的记忆 id 列表。", items: { type: "string", description: "记忆 id" } },
        segments: {
          type: "array",
          description: "只取这几段（段号来自 memory_locate 的 #N）。省略则返回整条正文。",
          items: { type: "integer", description: "段号，从 1 起" },
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            count: { type: "integer", required: true },
            text: { type: "string", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: String(value.text) }],
      },
      execute: (args, exec) => {
        const cwd = agentCwdOf(exec);
        if (cwd === "") throw new Error("拿不到当前会话的工作区目录");
        const ids = Array.isArray(args.ids) ? args.ids.filter((id) => typeof id === "string" && id !== "") : [];
        if (ids.length === 0) throw new Error("至少给一个 id");
        const entries = [];
        for (const id of ids.slice(0, 10)) {
          const entry = store.entryOf(cwd, id);
          if (entry !== null) entries.push(entry);
        }
        return Promise.resolve({ count: entries.length, text: formatDeepDetails(entries, args.segments) });
      },
      presentCall: (args) => ({ card: "generic", title: "读取记忆细节", kind: "other", rawInput: args }),
    }));

    attempt(() => defineTool({
      name: "memory_import",
      description:
        "把本工作区的历史会话导入长期记忆（一条用户消息 = 一条记忆，含当时的思考、命令与结论原文）。" +
        "需要回忆的事情发生在过往会话、而 memory_recall 找不到时用它。" +
        "不带参数时只列出可导入的会话（含哪些已导过），确认后再用 id 或 all=true 真正导入。" +
        "只想看某一轮原文、不打算入库时，用 session_read（读会话的正门）。",
      parameters: {
        id: { type: "string", description: "要导入的历史会话 id（不带参数调用时会列出全部候选）。" },
        all: { type: "boolean", description: "导入该工作区所有尚未导入的会话。" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            listed: { type: "boolean", required: true },
            imported: { type: "integer", required: true },
            failed: { type: "integer", required: true },
            text: { type: "string", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: String(value.text) }],
      },
      execute: async (args, exec) => {
        const cwd = agentCwdOf(exec);
        if (cwd === "") throw new Error("拿不到当前会话的工作区目录");
        const files = listSessionFiles(cwd, SESSIONS_ROOT);
        if (files.length === 0) return { listed: true, imported: 0, failed: 0, text: "这个工作区在磁盘上没有找到历史会话。" };
        const bucket = store.bucketOf(cwd);
        const done = new Set((bucket === null ? [] : bucket.entries).filter((entry) => entry.source.origin === "import").map((entry) => entry.source.sessionId));
        const all = args.all === true;
        const id = typeof args.id === "string" ? args.id.trim() : "";
        const wanted = id !== "" ? [id] : (all ? files.filter((item) => done.has(item.id) === false).map((item) => item.id) : []);
        if (wanted.length === 0) {
          const rows = files.map((item) => "  " + item.id + (done.has(item.id) ? "（已导过）" : "（未导入）") + "  " + String(Math.round(item.size / 1024)) + " KB");
          return { listed: true, imported: 0, failed: 0, text: "本工作区的历史会话（用 memory_import({ id }) 或 memory_import({ all: true }) 导入）：\n" + rows.join("\n") };
        }
        const picked = files.filter((item) => wanted.includes(item.id));
        if (picked.length === 0) throw new Error("找不到这些会话 id，先不带参数调一次看列表");
        let imported = 0;
        let failed = 0;
        for (const item of picked) {
          let segments = [];
          try { segments = segmentSession(readSessionEvents(item.file)); } catch { failed += 1; continue; }
          for (const segment of segments) {
            try {
              const text = renderSegment(segment, item.id, "full", IMPORT_MAX_CHARS);
              const added = store.add(cwd, { text, tags: ["会话导入"] }, "import", item.id);
              await embedEntry(vectors, cwd, added.entry);
              if (added.needsSummary) queueSummary(store, vectors, cwd, added.entry.id);
              imported += 1;
            } catch { failed += 1; }
          }
          const latest = store.bucketOf(cwd);
          if (latest !== null) writeMemoryFile(latest);
        }
        vectors.flush();
        return {
          listed: false,
          imported,
          failed,
          text: "已导入 " + String(imported) + " 条" + (failed > 0 ? "（失败 " + String(failed) + "）" : "") +
            "，来自会话 " + picked.map((item) => item.id.slice(0, 20)).join("、") +
            "。现在就能用 memory_recall / memory_search 找到它们；要点会在后台由 AI 补齐。",
        };
      },
      presentCall: (args) => ({ card: "generic", title: "导入历史会话", kind: "other", rawInput: args }),
    }));

    attempt(() => defineTool({
      name: "session_read",
      description:
        "读本工作区历史会话的**原文 / 摘要** —— 这是读会话的正门（自己去解压 .dsh/sessions 下的 zstd 文件那条路已被拦截）。" +
        "不带参数：列出本工作区的历史会话（id、大小、时间）；带 id：默认按轮次给摘要；mode=\"raw\" 时给指定轮次的完整原文（含当时的思考）。" +
        "只想回忆要点先用 memory_recall；要把会话消化进长期记忆用 memory_import。",
      parameters: {
        id: { type: "string", description: "会话 id（可以只给前 12 位）。不带则列出本工作区全部会话。" },
        mode: { type: "string", description: "\"digest\"（默认，每轮一行摘要）或 \"raw\"（指定轮次的完整原文）。" },
        from: { type: "integer", description: "起始轮次，1 起。不写则按 tail 取最后几轮。" },
        to: { type: "integer", description: "结束轮次。不写则到最后。" },
        tail: { type: "integer", description: "只看最后 N 轮（默认 8，上限 40）。" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            found: { type: "boolean", required: true },
            sessionId: { type: "string", required: true },
            turns: { type: "integer", required: true },
            text: { type: "string", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: String(value.text) }],
      },
      execute: (args, exec) => {
        const cwd = agentCwdOf(exec);
        if (cwd === "") throw new Error("拿不到当前会话的工作区目录");
        const files = listSessionFiles(cwd, SESSIONS_ROOT);
        if (files.length === 0) return Promise.resolve({ found: false, sessionId: "", turns: 0, text: "这个工作区在磁盘上没有找到历史会话。" });
        const stamp = (ms) => new Date(ms).toISOString().slice(5, 16).replace("T", " ");
        const wanted = typeof args.id === "string" ? args.id.trim() : "";
        if (wanted === "") {
          const rows = files.map((item) => "  " + item.id + "  " + String(Math.round(item.size / 1024)) + " KB  " + stamp(item.mtime));
          return Promise.resolve({
            found: true,
            sessionId: "",
            turns: 0,
            text: "本工作区的历史会话（新 → 旧）：\n" + rows.join("\n") +
              "\n\n看某次会话：session_read({ id: \"…\", tail: 8 })；要原始长文：session_read({ id: \"…\", mode: \"raw\", from: 1, to: 2 })。",
          });
        }
        const file = files.find((item) => item.id === wanted) !== undefined
          ? files.find((item) => item.id === wanted)
          : files.find((item) => item.id.startsWith(wanted));
        if (file === undefined) throw new Error("找不到这个会话 id，先不带参数调一次看列表");
        let segments = [];
        try { segments = segmentSession(readSessionEvents(file.file)); } catch (error) {
          throw new Error("读会话失败：" + String(error && error.message ? error.message : error).slice(0, 200));
        }
        if (segments.length === 0) return Promise.resolve({ found: false, sessionId: file.id, turns: 0, text: "这次会话里没有找到真实的用户消息。" });
        const total = segments.length;
        let from = clampInt(args.from, 1, total, 0);
        let to = clampInt(args.to, 1, total, 0);
        if (from === 0 || to === 0) {
          const tail = clampInt(args.tail, 1, 40, 8);
          from = Math.max(1, total - tail + 1);
          to = total;
        }
        if (to < from) { const swap = from; from = to; to = swap; }
        const picked = segments.slice(from - 1, to);
        const mode = args.mode === "raw" ? "raw" : "digest";
        const head = "会话 " + file.id + "（共 " + String(total) + " 轮，这里显示 " + String(from) + "–" + String(to) + "）：";
        const body = mode === "raw"
          ? picked.map((segment, index) => "# 第 " + String(from + index) + " 轮\n" + renderSegment(segment, file.id, "full", 6000)).join("\n\n")
          : picked.map((segment, index) => digestLine(segment, from + index)).join("\n");
        const text = head + "\n\n" + body;
        return Promise.resolve({
          found: true,
          sessionId: file.id,
          turns: total,
          text: text.length > SESSION_READ_MAX_CHARS ? text.slice(0, SESSION_READ_MAX_CHARS) + "\n…（输出超长已截断，用 from/to 缩小范围，或用 mode:\"digest\"）" : text,
        });
      },
      presentCall: (args) => ({ card: "generic", title: "读取历史会话", kind: "other", rawInput: args }),
    }));
    attempt(() => defineTool({
      name: "memory_search",
      description: "按关键词精确检索当前工作区的记忆要点（不走向量；想按语义找用 memory_recall）。query 留空则按「置顶 → 最近更新」列出全部。",
      parameters: {
        query: { type: "string", description: "关键词（空格分隔的多个词必须全部命中）。留空 = 列出全部。" },
        limit: { type: "integer", description: "最多返回多少条，默认 20，上限 100。" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            count: { type: "integer", required: true },
            found: { type: "boolean", required: true },
            text: { type: "string", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: String(value.text) }],
      },
      execute: (args, exec) => {
        const cwd = agentCwdOf(exec);
        if (cwd === "") throw new Error("拿不到当前会话的工作区目录");
        const entries = store.keywordSearch(cwd, args.query, clampInt(args.limit, 1, 100, 20));
        return Promise.resolve({ count: entries.length, found: entries.length > 0, text: formatEntries(entries, cwd) });
      },
      presentCall: (args) => ({ card: "generic", title: "检索工作区记忆", kind: "other", rawInput: args }),
    }));

    attempt(() => defineTool({
      name: "memory_forget",
      description: "删除当前工作区里过时或错误的记忆（两份向量一并清掉）。给 id 精确删除；给 query 则删除所有匹配该关键词的条目。被锁定的条目删不掉，会在结果里说明。",
      parameters: {
        id: { type: "string", description: "要删除的记忆 id（memory_recall / memory_search 的返回里有）。" },
        query: { type: "string", description: "删除所有匹配该关键词的条目。" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            removed: { type: "integer", required: true },
            skipped: { type: "integer", required: true },
            remaining: { type: "integer", required: true },
          },
        },
        render: (_args, value) => [{
          type: "text",
          text: "删除 " + String(value.removed) + " 条" + (value.skipped > 0 ? "，跳过 " + String(value.skipped) + " 条被锁定的" : "") + "；该工作区还剩 " + String(value.remaining) + " 条。",
        }],
      },
      execute: (args, exec) => {
        const cwd = agentCwdOf(exec);
        if (cwd === "") throw new Error("拿不到当前会话的工作区目录");
        const id = typeof args.id === "string" ? args.id.trim() : "";
        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (id === "" && query === "") throw new Error("至少给出 id 或 query 之一");
        const targets = id !== "" ? [id] : store.keywordSearch(cwd, query, 200).map((entry) => entry.id);
        const outcome = store.remove(cwd, targets);
        if (outcome.removed.length > 0) {
          vectors.drop(cwd, outcome.removed);
          vectors.flush();
          const changed = store.bucketOf(cwd);
          if (changed !== null) writeMemoryFile(changed);
        }
        const bucket = store.bucketOf(cwd);
        return Promise.resolve({ removed: outcome.removed.length, skipped: outcome.skipped.length, remaining: bucket === null ? 0 : bucket.entries.length });
      },
      presentCall: (args) => ({ card: "generic", title: "删除工作区记忆", kind: "other", rawInput: args }),
    }));
  });
}

/* ──────────────────────── HTTP 路由（客户端面板） ──────────────────────── */

let clientReport = { at: 0, status: "unknown", message: "" };

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("请求体过大"));
        if (typeof req.destroy === "function") req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (text === "") { resolve({}); return; }
      try { resolve(JSON.parse(text)); } catch { reject(new Error("请求体不是合法 JSON")); }
    });
    req.on("error", reject);
  });
}

function inputOf(body) {
  const input = body?.input;
  return input !== null && typeof input === "object" ? input : {};
}

function createRouteHandler(ctx, store, vectors) {
  const snapshotFor = async (sessionId, keyOverride) => {
    const cwd = await resolveCwd(ctx, sessionId);
    const key = workspaceKey(cwd);
    const targetKey = typeof keyOverride === "string" && keyOverride !== "" ? keyOverride : key;
    const bucket = targetKey === "" ? null : store.value.workspaces.get(targetKey);
    const entries = bucket === undefined || bucket === null ? [] : bucket.entries;
    const counts = bucket === undefined || bucket === null ? { shallow: 0, deep: 0, total: 0 } : vectors.counts(bucket.cwd, entries);
    return {
      activeKey: key,
      activeCwd: cwd === "" ? (bucket ? bucket.cwd : "") : cwd,
      targetKey,
      targetCwd: bucket ? bucket.cwd : "",
      targetEnabled: bucket ? bucket.enabled : true,
      targetInjectMode: bucket ? bucket.injectMode : "index",
      exists: bucket !== undefined && bucket !== null,
      budgetChars: store.value.budgetChars,
      summaryRoute: { provider: store.value.summaryProvider, model: store.value.summaryModel },
      timeouts: { summaryTimeoutMs: store.value.summaryTimeoutMs, embedTimeoutMs: store.value.embedTimeoutMs },
      workspaces: store.overview(),
      entries,
      counts,
      embedder: { state: embedderStatus.state, message: embedderStatus.message, model: embedderStatus.model, dim: embedderStatus.dim, modelReady: isComplete(modelSizes()) },
      summarizer: { ...summaryStatus, queued: summaryQueue.length },
      memoryFile: bucket ? memoryFilePath(bucket.cwd) : "",
      storage: { store: store.protection, vectors: vectors.protection },
    };
  };

  const afterChange = (cwd) => {
    const bucket = store.bucketOf(cwd);
    if (bucket !== null) writeMemoryFile(bucket);
  };

  const table = {
    status: () => ({
      ...clientReport,
      tools: toolsReport,
      embedder: { state: embedderStatus.state, message: embedderStatus.message },
      summarizer: { ...summaryStatus, queued: summaryQueue.length },
      importer: { ...importStatus },
    }),
    clientReady: (_scope, input) => {
      clientReport = { at: Date.now(), status: "ready", message: typeof input.message === "string" ? input.message.slice(0, 600) : "" };
      return clientReport;
    },
    clientError: (_scope, input) => {
      clientReport = { at: Date.now(), status: "error", message: typeof input.message === "string" ? input.message.slice(0, 900) : "" };
      return clientReport;
    },
    list: async (scope, input) => snapshotFor(scope.sessionId, typeof input.key === "string" ? input.key : ""),
    create: async (scope, input) => {
      const cwd = await resolveCwd(ctx, scope.sessionId);
      if (cwd === "") throw new Error("这个会话还没有工作区目录：先在会话里发一条消息再打开记忆面板");
      const result = store.add(cwd, { text: input.text, summary: input.summary, tags: input.tags, pinned: input.pinned === true, forceSummary: input.forceSummary === true }, "panel", scope.sessionId);
      await embedEntry(vectors, cwd, result.entry);
      vectors.flush();
      afterChange(cwd);
      if (result.needsSummary) queueSummary(store, vectors, cwd, result.entry.id);
      return snapshotFor(scope.sessionId);
    },
    update: async (scope, input) => {
      const cwd = await resolveCwd(ctx, scope.sessionId);
      if (cwd === "") throw new Error("拿不到这个会话的工作区目录");
      const id = typeof input.id === "string" ? input.id : "";
      if (id === "") throw new Error("缺少记忆 id");
      const result = store.update(cwd, id, {
        text: input.text,
        summary: input.summary,
        tags: input.tags,
        pinned: input.pinned,
        locked: input.locked,
        force: input.force === true,
      });
      if (result.contentChanged) {
        await embedEntry(vectors, cwd, result.entry);
      }
      vectors.flush();
      afterChange(cwd);
      if (result.entry.summaryState === "pending") queueSummary(store, vectors, cwd, result.entry.id);
      return snapshotFor(scope.sessionId);
    },
    remove: async (scope, input) => {
      const cwd = await resolveCwd(ctx, scope.sessionId);
      if (cwd === "") throw new Error("拿不到这个会话的工作区目录");
      const ids = Array.isArray(input.ids) ? input.ids.filter((id) => typeof id === "string") : [];
      if (ids.length === 0) throw new Error("缺少记忆 id");
      const outcome = store.remove(cwd, ids);
      vectors.drop(cwd, outcome.removed);
      vectors.flush();
      afterChange(cwd);
      return snapshotFor(scope.sessionId);
    },
    setEnabled: async (scope, input) => {
      const cwd = await resolveCwd(ctx, scope.sessionId);
      if (cwd === "") throw new Error("拿不到这个会话的工作区目录");
      store.setEnabled(cwd, input.enabled === true);
      return snapshotFor(scope.sessionId);
    },
    setInjectMode: async (scope, input) => {
      const cwd = await resolveCwd(ctx, scope.sessionId);
      if (cwd === "") throw new Error("拿不到这个会话的工作区目录");
      store.setInjectMode(cwd, input.mode);
      return snapshotFor(scope.sessionId);
    },
    clear: async (scope, input) => {
      const cwd = await resolveCwd(ctx, scope.sessionId);
      if (cwd === "") throw new Error("拿不到这个会话的工作区目录");
      if (input.confirm !== true) throw new Error("清空需要二次确认");
      store.clear(cwd);
      vectors.dropWorkspace(cwd);
      vectors.flush();
      afterChange(cwd);
      return snapshotFor(scope.sessionId);
    },
    setBudget: async (scope, input) => {
      store.setBudget(input.budgetChars);
      return snapshotFor(scope.sessionId);
    },
    setTimeouts: async (scope, input) => {
      const next = store.setTimeouts(input.summaryTimeoutMs, input.embedTimeoutMs);
      embedTimeoutMs = next.embedTimeoutMs;
      return snapshotFor(scope.sessionId);
    },
    setSummaryRoute: async (scope, input) => {
      store.setSummaryRoute(input.provider, input.model);
      return snapshotFor(scope.sessionId);
    },
    /** 重建两份向量；顺带把还没有 AI 摘要的条目排进总结队列。 */
    reindex: async (scope, input) => {
      const cwd = await resolveCwd(ctx, scope.sessionId);
      if (cwd === "") throw new Error("拿不到这个会话的工作区目录");
      const bucket = store.bucketOf(cwd);
      if (bucket === null) return { ...(await snapshotFor(scope.sessionId)), reindex: { ok: true, done: 0, total: 0, message: "" } };
      vectors.dropWorkspace(cwd);
      const entries = bucket.entries;
      let done = 0;
      for (let start = 0; start < entries.length; start += 16) {
        const slice = entries.slice(start, start + 16);
        try {
          const shallowVectors = await embedTexts(slice.map((entry) => shallowText(entry)));
          slice.forEach((entry, index) => {
            if (shallowVectors[index] !== undefined) vectors.setShallow(cwd, entry.id, shallowVectors[index]);
          });
          // 深层：把这批条目的所有块拉平一次算完，保证长记忆全文都被覆盖。
          const flat = [];
          const plans = [];
          for (const entry of slice) {
            const chunks = chunkText(entry.text, EMBED_CHUNK_CHARS, MAX_CHUNKS_PER_ENTRY);
            plans.push({ entry, offset: flat.length, count: chunks.length });
            for (const chunk of chunks) flat.push(chunk);
          }
          const flatVectors = flat.length > 0 ? await embedTexts(flat) : [];
          for (const plan of plans) {
            const own = flatVectors.slice(plan.offset, plan.offset + plan.count);
            if (own.length > 0) vectors.setDeep(cwd, plan.entry.id, own);
            done += 1;
          }
        } catch (error) {
          vectors.flush();
          return { ...(await snapshotFor(scope.sessionId)), reindex: { ok: false, done, total: entries.length, message: String(error && error.message ? error.message : error).slice(0, 300) } };
        }
      }
      vectors.flush();
      afterChange(cwd);
      if (input.summarize !== false) {
        for (const entry of entries) if (entry.summaryState === "pending") queueSummary(store, vectors, cwd, entry.id);
      }
      return { ...(await snapshotFor(scope.sessionId)), reindex: { ok: true, done, total: entries.length, message: "" } };
    },
    /** 把某个（或全部）条目重新排队做 AI 总结。 */
    resummarize: async (scope, input) => {
      const cwd = await resolveCwd(ctx, scope.sessionId);
      if (cwd === "") throw new Error("拿不到这个会话的工作区目录");
      const bucket = store.bucketOf(cwd);
      if (bucket === null) return snapshotFor(scope.sessionId);
      const id = typeof input.id === "string" ? input.id : "";
      let queued = 0;
      for (const entry of bucket.entries) {
        if (id !== "" && entry.id !== id) continue;
        if (entry.locked) continue;
        entry.summary = "";
        entry.summaryState = "pending";
        queueSummary(store, vectors, cwd, entry.id);
        queued += 1;
      }
      store.flush();
      afterChange(cwd);
      return { ...(await snapshotFor(scope.sessionId)), queued };
    },
    recallTest: async (scope, input) => {
      const cwd = await resolveCwd(ctx, scope.sessionId);
      if (cwd === "") throw new Error("拿不到这个会话的工作区目录");
      const query = typeof input.query === "string" ? input.query.trim() : "";
      if (query === "") throw new Error("先写一句要检索的话");
      const minScore = typeof input.min_score === "number" && Number.isFinite(input.min_score) ? input.min_score : null;
      const outcome = await recallEntries(store, vectors, cwd, query, clampInt(input.limit, 1, 20, 5), { mode: input.filter, minScore });
      if (outcome === null) return { mode: "keyword-fallback", count: 0, rows: [], message: "嵌入模型不可用：" + embedderStatus.message };
      if (vectors.dirty) vectors.flush();
      return {
        mode: outcome.mode,
        count: outcome.rows.length,
        message: "",
        notes: outcome.notes,
        dropped: outcome.dropped,
        filterMode: outcome.filterMode,
        rows: outcome.rows.map((row) => ({
          id: row.entry.id,
          score: Math.round(row.score * 1000) / 1000,
          summary: row.entry.summary !== "" ? row.entry.summary : ruleSummary(row.entry.text),
          text: row.entry.text,
        })),
      };
    },
    warmup: async () => {
      try {
        const model = await ensureModel(ctx);
        if (model.ok !== true) return { ok: false, state: embedderStatus.state, message: embedderStatus.message };
        await ensureEmbedder();
        return { ok: true, state: embedderStatus.state, message: embedderStatus.message };
      } catch (error) {
        return { ok: false, state: embedderStatus.state, message: String(error && error.message ? error.message : error).slice(0, 300) };
      }
    },
    /** 立刻试一次 AI 总结（面板用，验证路由与凭据是否可用）。 */
    testSummary: async (scope, input) => {
      const sample = typeof input.text === "string" && input.text.trim() !== ""
        ? input.text
        : "本机 PowerShell 是 5.1：处理 UTF-8 文本一律走 Node，不用 Get-Content（按 GBK 读会乱码）。";
      try {
        const started = Date.now();
        const summary = await generateSummary(store, sample);
        return { ok: true, summary, ms: Date.now() - started, provider: store.value.summaryProvider, model: store.value.summaryModel };
      } catch (error) {
        return { ok: false, summary: "", ms: 0, provider: store.value.summaryProvider, model: store.value.summaryModel, message: String(error && error.message ? error.message : error).slice(0, 400) };
      }
    },
    /** 列出该工作区在磁盘上的历史会话（可直接导入的那些）。 */
    importList: async (scope) => {
      const cwd = await resolveCwd(ctx, scope.sessionId);
      if (cwd === "") throw new Error("拿不到这个会话的工作区目录");
      const files = listSessionFiles(cwd, SESSIONS_ROOT);
      const rows = [];
      for (const item of files) {
        let segments = 0;
        try { segments = segmentSession(readSessionEvents(item.file)).length; } catch { segments = 0; }
        rows.push({ id: item.id, size: item.size, mtime: item.mtime, segments });
      }
      const stored = store.bucketOf(cwd);
      // 只有「导入」写进来的记忆才能说明某个会话导过了。
      // 面板手写或工具写的记忆虽然也带 sessionId，但那只是「当时我在哪个会话里」——
      // 拿它当凭据会误标（实测把一条种子记忆的会话误判成「已导过」）。
      const imported = new Set(
        stored === null ? [] : stored.entries
          .filter((entry) => entry.source.origin === "import")
          .map((entry) => entry.source.sessionId)
          .filter((id) => id !== ""),
      );
      return { cwd, sessions: rows, imported: [...imported], status: { ...importStatus }, depth: "full", maxChars: IMPORT_MAX_CHARS };
    },
    /** 预览：只算不写，让主人先看看到底会导入什么。 */
    importPreview: async (scope, input) => {
      const cwd = await resolveCwd(ctx, scope.sessionId);
      if (cwd === "") throw new Error("拿不到这个会话的工作区目录");
      const id = typeof input.id === "string" ? input.id : "";
      const file = listSessionFiles(cwd, SESSIONS_ROOT).find((item) => item.id === id);
      if (file === undefined) throw new Error("找不到这个会话文件");
      const depth = input.depth === "lean" ? "lean" : "full";
      const segments = segmentSession(readSessionEvents(file.file));
      const items = segments.map((segment) => {
        const text = renderSegment(segment, file.id, depth, IMPORT_MAX_CHARS);
        return { chars: text.length, head: text.slice(0, 600) };
      });
      return { id, depth, count: items.length, items };
    },
    /** 真正导入（后台跑，用 importProgress 轮询）。 */
    importRun: async (scope, input) => {
      const cwd = await resolveCwd(ctx, scope.sessionId);
      if (cwd === "") throw new Error("拿不到这个会话的工作区目录");
      if (importStatus.running) throw new Error("上一批还在导入中，等它跑完");
      const ids = Array.isArray(input.ids) ? input.ids.filter((id) => typeof id === "string") : [];
      if (ids.length === 0) throw new Error("先选要导入的会话");
      const all = listSessionFiles(cwd, SESSIONS_ROOT);
      const picked = ids.map((id) => all.find((item) => item.id === id)).filter((item) => item !== undefined);
      if (picked.length === 0) throw new Error("选中的会话文件都不在了");
      const depth = input.depth === "lean" ? "lean" : "full";
      importStatus.sessionId = picked.map((item) => item.id).join(",");
      importStatus.total = picked.length;
      void runImport(store, vectors, cwd, picked.slice(0, IMPORT_BATCH_LIMIT), depth, IMPORT_MAX_CHARS);
      return { started: true, sessions: picked.length, status: { ...importStatus } };
    },
    importProgress: async () => ({ ...importStatus, bucket: store.overview() }),
    readMemoryFile: async (scope) => {
      const cwd = await resolveCwd(ctx, scope.sessionId);
      if (cwd === "") throw new Error("拿不到这个会话的工作区目录");
      return { path: memoryFilePath(cwd), text: readMemoryFile(cwd) };
    },
    writeManualBlock: async (scope, input) => {
      const cwd = await resolveCwd(ctx, scope.sessionId);
      if (cwd === "") throw new Error("拿不到这个会话的工作区目录");
      const bucket = store.bucketOf(cwd);
      if (bucket === null) throw new Error("这个工作区还没有任何记忆");
      const path = memoryFilePath(cwd);
      if (path === "") throw new Error("工作区目录为空");
      const manual = typeof input.manual === "string" ? input.manual.slice(0, 20000) : DEFAULT_MANUAL;
      const block = manual.includes(MANUAL_BEGIN) ? extractManualBlock(manual) : (manual.trim() === "" ? DEFAULT_MANUAL : "\n" + manual.replace(/[\r\n]+$/, "") + "\n\n");
      try {
        atomicWrite(path, renderMemoryMarkdown(bucket, block === null ? DEFAULT_MANUAL : block));
      } catch (error) {
        throw new Error("写 Memory.md 失败：" + String(error && error.message ? error.message : error).slice(0, 200));
      }
      return { path, text: readMemoryFile(cwd) };
    },
  };

  return async (req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    const reply = (payload) => { res.statusCode = 200; res.end(JSON.stringify(payload)); };
    try {
      const pathname = String(req.url ? req.url : "").split("?")[0];
      const method = pathname.slice(pathname.lastIndexOf("/") + 1);
      const run = table[method];
      if (run === undefined) { reply({ ok: false, error: { message: "未知方法 " + method } }); return; }
      const body = await readJsonBody(req);
      const scope = { sessionId: typeof body?.sessionId === "string" ? body.sessionId : "" };
      const value = await run(scope, inputOf(body));
      reply({ ok: true, value });
    } catch (error) {
      reply({ ok: false, error: { message: String(error && error.message ? error.message : error).slice(0, 600) } });
    }
  };
}

/* ────────────────────────────── 入口 ────────────────────────────── */

export function apply(ctx) {
  try {
    const store = new MemoryStore();
    const vectors = new VectorStore();
    embedTimeoutMs = store.value.embedTimeoutMs;

    // 单实例写锁：拿不到就整体进只读保护，避免两个实例把对方的记忆覆盖掉
    const lock = acquireLock();
    if (lock.ok !== true) {
      store.protection = { readOnly: true, version: STORE_VERSION, notice: lock.notice, reason: lock.notice };
      vectors.protection = { readOnly: true, version: VECTOR_VERSION, notice: lock.notice, reason: lock.notice };
      ctx.logger?.warn?.("session-memory: %s", lock.notice);
    } else if (lock.notice !== "") {
      ctx.logger?.info?.("session-memory: %s", lock.notice);
    }
    try {
      ctx.effect(() => () => releaseLock());
    } catch { /* effect 不可用就不挂释放钩子，锁靠 pid 检查与 TTL 兜底 */ }

    // 数据进只读保护 / 发生过迁移时，日志里必须留痕（而不是静默按空记忆跑）
    if (store.protection.readOnly === true) ctx.logger?.warn?.("session-memory: memory.json 只读保护 —— %s", store.protection.reason);
    else if (store.protection.notice !== "") ctx.logger?.info?.("session-memory: %s", store.protection.notice);
    if (vectors.protection.readOnly === true) ctx.logger?.warn?.("session-memory: vectors.json 只读保护 —— %s", vectors.protection.reason);
    else if (vectors.protection.notice !== "") ctx.logger?.info?.("session-memory: %s", vectors.protection.notice);
    // 迁移结果立刻落盘：否则用户只要不写东西，磁盘上就一直是旧格式，每次启动重迁一遍
    if (vectors.dirty === true) vectors.flush();

    ctx.inject(["llm"], (scoped) => {
      try { llmService = scoped.llm; } catch { llmService = null; }
    });

    ctx.inject(["systemPrompt"], (scoped) => {
      try {
        scoped.systemPrompt.section({
          name: SECTION_NAME,
          order: SECTION_ORDER,
          text: (assembleContext) => {
            try {
              const cwd = assembleContext?.agent?.session?.header?.cwd;
              if (typeof cwd !== "string" || cwd === "") return "";
              return renderSection(store, cwd);
            } catch {
              return "";
            }
          },
        });
      } catch (error) {
        ctx.logger?.warn?.("session-memory: prompt section not registered: %s", String(error && error.message ? error.message : error));
      }
    });

    registerTools(ctx, store, vectors);

    const handler = createRouteHandler(ctx, store, vectors);
    ctx.inject(["webServer"], (scoped) => {
      try {
        scoped.effect(() => scoped.webServer.register({ kind: "prefix", path: ROUTE_PREFIX, handler }), "session-memory: http route");
      } catch (error) {
        ctx.logger?.warn?.("session-memory: http route not registered: %s", String(error && error.message ? error.message : error));
      }
    });

    // 首次使用：模型不在就后台拉下来（拉完自动加载）；已就位就只做一次预热。
    setTimeout(() => {
      void (async () => {
        const model = await ensureModel(ctx);
        if (model.ok !== true) return;
        await ensureEmbedder();
      })().catch(() => { /* 检索时会再试 */ });
    }, 1500);
    setTimeout(() => {
      try {
        for (const bucket of store.value.workspaces.values()) writeMemoryFile(bucket);
      } catch { /* 对齐失败不影响主流程 */ }
    }, 4000);

    // 重启后把「还是 pending」的条目重新排队：队列本身在内存里，重启就没了。
    setTimeout(() => {
      try {
        let requeued = 0;
        for (const bucket of store.value.workspaces.values()) {
          for (const entry of bucket.entries) {
            if (entry.summaryState === "pending") { queueSummary(store, vectors, bucket.cwd, entry.id); requeued += 1; }
          }
        }
        if (requeued > 0) ctx.logger?.info?.("session-memory: requeued %d pending summaries", requeued);
      } catch { /* 重排失败不影响主流程 */ }
    }, 6000);

    ctx.logger?.info?.("session-memory: store at %s", STORE_PATH);
  } catch (error) {
    ctx.logger?.warn?.("session-memory: apply degraded: %s", String(error && error.message ? error.message : error));
  }
}

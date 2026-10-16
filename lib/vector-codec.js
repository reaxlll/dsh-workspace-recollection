/**
 * 向量编解码 —— 纯函数、零依赖，能脱离 DSH 进程直接用 node 单测。
 *
 * 为什么不用「数字数组」直接写进 JSON：一条 512 维向量写成 JSON 文本约 4KB，
 * 读回来还要逐个 parse 成双精度浮点。用真实数据实测（5833 个向量 = 502 条记忆）：
 *
 *   数字数组格式   24.1MB   stringify 174ms
 *   base64 格式    15.2MB   encode 16ms + stringify 22ms
 *
 * 也就是每次落盘（每写一条记忆就付一次）**体积 -37%、CPU -78%**；
 * 代价是读入时多付一次解码（64ms / 5833 个向量）。
 *
 * 精度说明：float32 有约 7 位有效数字，比原先「保留 5 位小数」的写法精度**更高**；
 * 嵌入向量本来就是近似值，这个精度远超检索所需。
 *
 * 字节序：按小端写入 —— Node 支持的所有平台（x64 / arm64 / riscv64）都是小端。
 */

/** 本机是否小端（编译期常量级别的一次判断）。 */
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * 把浮点数组编成 base64 字符串（Float32 原始字节）。
 *
 * @param {number[]|Float32Array} values
 * @returns {string} 空数组 / 非法输入返回空串
 */
export function encodeVector(values) {
  if (values === null || values === undefined) return "";
  const source = values instanceof Float32Array ? values : (Array.isArray(values) ? values : null);
  if (source === null || source.length === 0) return "";
  const floats = source instanceof Float32Array ? source : Float32Array.from(source);
  if (!LITTLE_ENDIAN) {
    // 理论上到不了这里；真遇到大端就把字节反过来，保证文件在平台间可读
    const view = new DataView(new ArrayBuffer(floats.length * 4));
    for (let i = 0; i < floats.length; i += 1) view.setFloat32(i * 4, floats[i], true);
    return Buffer.from(view.buffer).toString("base64");
  }
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength).toString("base64");
}

/**
 * 解码回普通数字数组。
 *
 * @param {string} text
 * @returns {number[]|null} 坏输入返回 null（调用方据此跳过这条向量，而不是崩掉整个库）
 */
export function decodeVector(text) {
  if (typeof text !== "string" || text === "") return null;
  try {
    const buf = Buffer.from(text, "base64");
    if (buf.length === 0 || buf.length % 4 !== 0) return null;
    // 复制一份拿到干净、按 4 字节对齐的 ArrayBuffer（Buffer 可能来自共享内存池）
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const floats = LITTLE_ENDIAN ? new Float32Array(ab) : (() => {
      const view = new DataView(ab);
      const out = new Float32Array(view.byteLength / 4);
      for (let i = 0; i < out.length; i += 1) out[i] = view.getFloat32(i * 4, true);
      return out;
    })();
    const result = new Array(floats.length);
    for (let i = 0; i < floats.length; i += 1) result[i] = floats[i];
    return result;
  } catch {
    return null;
  }
}

/**
 * 判断一个字段是新的编码形式（字符串）还是旧的数字数组形式。
 * 用于向后兼容读取 —— 迁移与 normalize 都靠它分流。
 */
export function isEncoded(value) {
  return typeof value === "string" && value !== "";
}

/** 解码后校验维度（不符就丢这条向量，避免维度错位污染余弦计算）。 */
export function decodeVectorOfDim(text, dim) {
  const values = decodeVector(text);
  if (values === null) return null;
  if (Number.isInteger(dim) && dim > 0 && values.length !== dim) return null;
  return values;
}

/** 深层多块：字符串数组 → 向量数组；单块旧格式（数字数组）也兼容。 */
export function normalizeChunks(raw, dim, maxChunks) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const limit = Number.isInteger(maxChunks) && maxChunks > 0 ? maxChunks : list.length;
  for (const chunk of list) {
    if (out.length >= limit) break;
    let values = null;
    if (isEncoded(chunk)) values = decodeVectorOfDim(chunk, dim);
    else if (Array.isArray(chunk)) values = chunk;
    if (values !== null) out.push(values);
  }
  return out.length === 0 ? null : out;
}

/**
 * v2 → v3 的向量迁移：把每个向量的「数字数组」换成 Float32 base64。
 *
 * 只改表示形式，维度与数值不动；坏数据**原样留着**（读入时由 normalize 丢弃，
 * 不在迁移里静默删东西）。调用方会在迁移前自动备份 vectors.json。
 *
 * 幂等：已经是字符串的字段原样带走，所以对已经迁过的数据再跑一次不会有副作用。
 */
export function migrateVectorsV2ToV3(raw) {
  const source = raw !== null && typeof raw === "object" && raw.workspaces !== null && typeof raw.workspaces === "object"
    ? raw.workspaces
    : {};
  const workspaces = {};
  for (const [key, rows] of Object.entries(source)) {
    if (rows === null || typeof rows !== "object") continue;
    const bucket = {};
    for (const [id, row] of Object.entries(rows)) {
      if (row === null || typeof row !== "object") continue;
      const next = {};
      if (typeof row.at === "string" && row.at !== "") next.at = row.at;
      // 浅层向量
      if (Array.isArray(row.s)) next.s = encodeVector(row.s);
      else if (isEncoded(row.s)) next.s = row.s;
      // 深层分块
      if (Array.isArray(row.d)) {
        next.d = row.d.map((chunk) => (Array.isArray(chunk) ? encodeVector(chunk) : chunk));
      } else if (row.d !== undefined && row.d !== null) {
        next.d = row.d;
      }
      if (next.s === undefined && next.d === undefined) continue;
      bucket[id] = next;
    }
    workspaces[key] = bucket;
  }
  const out = { version: 3, workspaces };
  if (raw !== null && typeof raw === "object") {
    if (typeof raw.model === "string") out.model = raw.model;
    if (Number.isInteger(raw.dim)) out.dim = raw.dim;
  }
  return out;
}

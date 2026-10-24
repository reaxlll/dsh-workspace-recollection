/**
 * dsh-session-memory · 交叉编码重排（v2.13 新增）
 *
 * 前面两层（双塔向量、BM25）本质都是「把 query 和文档各自压成一个点再比」，
 * 所以对「同一句话换了个数字」这类差异天生钝。交叉编码器把 (query, passage)
 * **拼在一起**送进模型，让 token 之间直接交互 —— 同组候选上 logit 差能到 3+，
 * 而双塔余弦差只有 0.01~0.03，分辨率高两个数量级。
 *
 * 实测（记忆检索精度/eval-matrix.mjs，40 条计分）：主池基线 MRR 0.649 → 0.756，
 * 是这套系统里单点收益最大的一步。代价是每对约 7.4ms，所以只对头部 25 条做。
 *
 * 一个反直觉的结论：**有了重排之后词法通道就不划算了**。
 * 主池+重排 0.756，主池+词法+重排 0.741 —— 词法那点字面优势被重排覆盖，
 * 还要多付建索引的 5~15ms。所以上层是「重排可用就不跑词法，重排不可用才降级到词法」。
 *
 * 模型是本地权重（q8 量化 279MB），零联网；不存在就整体降级，不影响记忆功能。
 */

/** 重排模型标识（也是 `$DSH_HOME/session-memory/models/` 下的相对目录名）。 */
export const RERANK_MODEL_ID = "Xenova/bge-reranker-base";

/** 头部候选数：再往后重排的边际收益抵不过延迟。 */
export const RERANK_TOP = 25;

/** 送进重排的 passage 长度（字符）。窗口是 512 token，900 字符中文约在边界内。 */
export const RERANK_PASSAGE_CHARS = 900;

/** 模型文件清单（min 是最小合理字节数，用来识别空文件/截断）。 */
export const RERANK_FILES = [
  { rel: "config.json", min: 400 },
  { rel: "tokenizer.json", min: 10000000 },
  { rel: "tokenizer_config.json", min: 200 },
  { rel: "special_tokens_map.json", min: 50 },
  { rel: "onnx/model_quantized.onnx", min: 200000000 },
];

export const RERANK_MIRRORS = ["https://hf-mirror.com", "https://huggingface.co"];

export function rerankModelUrl(mirror, rel) {
  const base = String(mirror).replace(/\/+$/, "");
  const file = String(rel).replace(/^\/+/, "");
  return base + "/" + RERANK_MODEL_ID + "/resolve/main/" + file;
}

/** 按「文件 → 字节数」的表算还缺哪些。 */
export function missingRerankFiles(sizes) {
  const table = sizes !== null && typeof sizes === "object" ? sizes : {};
  return RERANK_FILES.filter((item) => {
    const size = table[item.rel];
    return !(typeof size === "number" && Number.isFinite(size) && size >= item.min);
  });
}

export function isRerankComplete(sizes) {
  return missingRerankFiles(sizes).length === 0;
}

/** 运行时状态（给面板和降级判断用）。 */
export const rerankStatus = {
  state: "idle",       // idle | loading | ready | failed | missing
  message: "",
  loadedAt: 0,
  modelReady: false,
};

let bundle = null;
let loading = null;
/** 试过且失败就别每次查询都重来（首次加载 700ms+，失败重试会把每条 query 都拖慢）。 */
let attempts = 0;

/**
 * 加载重排模型（懒加载 + 失败缓存）。
 *
 * 失败**不抛**给调用方：重排是增益项，不是必需项，缺了要能无声降级。
 * @returns {Promise<{tok:object, model:object}|null>}
 */
export async function ensureReranker(modelsDir) {
  if (bundle !== null) return bundle;
  if (loading !== null) return loading;
  if (attempts >= 2) return null;   // 连续失败两次就不再试了，等重启或面板手动重载
  loading = (async () => {
    rerankStatus.state = "loading";
    try {
      const module = await import("@huggingface/transformers");
      module.env.allowRemoteModels = false;
      module.env.allowLocalModels = true;
      if (typeof modelsDir === "string" && modelsDir !== "") module.env.localModelPath = modelsDir;
      const tok = await module.AutoTokenizer.from_pretrained(RERANK_MODEL_ID);
      const model = await module.AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL_ID, { dtype: "q8" });
      bundle = { tok, model };
      rerankStatus.state = "ready";
      rerankStatus.message = "";
      rerankStatus.loadedAt = Date.now();
      return bundle;
    } catch (error) {
      const raw = String(error && error.message ? error.message : error).slice(0, 300);
      rerankStatus.state = "failed";
      rerankStatus.message = raw;
      bundle = null;
      attempts += 1;
      return null;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** 已经加载好就直接给，不触发加载。 */
export function rerankerIfReady() {
  return bundle;
}

/**
 * 给一批 (query, doc) 打分，返回 logit（越大越相关）。
 * 单对失败不影响整批：那一对给 -Infinity 级别的最低分，让它沉底而不是炸掉整次检索。
 */
export async function scorePairs(query, docs) {
  const ready = bundle;
  if (ready === null) return null;
  const out = [];
  for (const doc of docs) {
    try {
      const inputs = await ready.tok(query, { text_pair: String(doc), padding: true, truncation: true, max_length: 512 });
      const result = await ready.model(inputs);
      const value = result.logits.data[0];
      out.push(Number.isFinite(value) ? value : -1000);
    } catch {
      out.push(-1000);
    }
  }
  return out;
}

/**
 * 把重排分合并回候选序列（纯函数，便于单测）。
 *
 * 只重排头部 head 个，尾部原样接在後面 —— 重排是「在已召回的好候选里挑顺序」，
 * 不是「让重排决定谁该被召回」（那样成本不可控）。
 *
 * @param {string[]} ids 候选 id，按原顺序
 * @param {number[]} scores 与 head 对齐的重排分
 * @param {number} head 头部长度
 * @returns {string[]} 新顺序
 */
export function mergeRerank(ids, scores, head) {
  const list = Array.isArray(ids) ? ids : [];
  const points = Array.isArray(scores) ? scores : [];
  const k = Number.isInteger(head) && head > 0 ? Math.min(head, list.length) : 0;
  if (k <= 1) return list.slice();
  const headIds = list.slice(0, k);
  const ordered = headIds
    .map((id, i) => ({ id, s: Number.isFinite(points[i]) ? points[i] : -1000, i }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((item) => item.id);
  return [...ordered, ...list.slice(k)];
}

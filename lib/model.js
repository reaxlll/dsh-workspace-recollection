/**
 * 嵌入模型的自举清单 —— 纯函数、零依赖，能脱离 DSH 进程直接用 node 单测。
 *
 * 为什么单独一层：语义检索依赖 `Xenova/bge-small-zh-v1.5`（512 维，ONNX 量化约 23MB），
 * 而插件运行时是**零联网**的（`allowRemoteModels = false`，不让 transformers 自己去下）。
 * 所以模型缺失时由插件自己补齐：先按清单核对本地文件，缺哪个拉哪个 ——
 * 先下到 `.part` 再 rename，避免「下了一半的文件」被当成完整的；
 * 下载源按顺序试，全都失败就保持「关键词检索」降级：功能变弱，但插件照常可用。
 */

/** 模型标识（同时也是 `$DSH_HOME/session-memory/models/` 下的相对目录名）。 */
export const EMBED_MODEL_ID = "Xenova/bge-small-zh-v1.5";

/**
 * 需要在位的文件清单。`min` 是最小合理字节数 —— 用来识别空文件 / 明显截断的文件。
 *
 * 大文件取「真实大小 × 0.8」：只防「下了一半」（配合 `.part` + rename 的原子性，
 * 正常路径不会产生半截文件，但手动拷贝 / 磁盘写满这类意外可能留下），
 * 留 20% 余量是为了将来官方更新模型时不至于误判。小文件用固定小阈值即可。
 */
export const MODEL_FILES = [
  { rel: "config.json", min: 400 },
  { rel: "tokenizer.json", min: 350000 },
  { rel: "tokenizer_config.json", min: 200 },
  { rel: "special_tokens_map.json", min: 50 },
  { rel: "vocab.txt", min: 87000 },
  { rel: "onnx/model_quantized.onnx", min: 19000000 },
];

/** 下载源，按顺序试：镜像优先（国内可达性好），再回官方。 */
export const MODEL_MIRRORS = [
  "https://hf-mirror.com",
  "https://huggingface.co",
];

/** 某个文件在指定镜像下的下载地址（`resolve/main` 是 HF 的原始文件路径）。 */
export function modelUrl(mirror, rel) {
  const base = String(mirror).replace(/\/+$/, "");
  const file = String(rel).replace(/^\/+/, "");
  return base + "/" + EMBED_MODEL_ID + "/resolve/main/" + file;
}

/**
 * 按「文件 → 字节数」的表算还缺哪些。
 *
 * @param {Record<string, number|null|undefined>} sizes 读不到 / 不存在的文件给 null
 * @returns {Array<{rel:string,min:number}>} 缺失清单（空数组 = 齐全）
 */
export function missingFiles(sizes) {
  const table = sizes !== null && typeof sizes === "object" ? sizes : {};
  return MODEL_FILES.filter((item) => {
    const size = table[item.rel];
    return !(typeof size === "number" && Number.isFinite(size) && size >= item.min);
  });
}

/** 是否齐全。 */
export function isComplete(sizes) {
  return missingFiles(sizes).length === 0;
}

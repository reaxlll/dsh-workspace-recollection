/**
 * dsh-session-memory · 工作区改名后的记忆认领（v2.15 新增）
 *
 * 场景：`E:\DSHwork\插件生成` 被改成 `E:\DSHwork\插件生成-旧` 或别的名字。
 * 路径变了，`workspaceKey` 跟着变，于是内存里冒出一个空的新工作区，旧记忆还在库里躺着。
 *
 * 这一层只做**决策**（纯函数），不动数据：给定「当前工作区的身份」和「库里所有工作区」，
 * 判断该不该把某个旧工作区的记忆认领过来。
 *
 * 三条铁律：
 * 1. **判不准就不认领。** 认错的代价是两条工作区的记忆混在一起，比"记忆暂时看不见"糟得多。
 * 2. **旧目录还活着就不动。** 只有确认旧路径已经不存在，才认为它是"改名"而不是"另一个副本"。
 * 3. **认领可回滚。** 认领时写 migratedFrom，事后能看出来源。
 *
 * 本文件不 import 任何包，可脱离 DSH 进程直接单测：node tests/workspace-migrate.test.mjs
 */

/**
 * @typedef {{ key:string, cwd:string, strong?:string, weak?:string }} Candidate
 * @typedef {{ verdict:"claim"|"suggest"|"none"|"ambiguous", key:string, message:string }} Verdict
 */

/**
 * 判断当前工作区能不能认领一个旧工作区的记忆。
 *
 * @param {Candidate[]} existing 库里已有的工作区（key 是 workspaceKey，不是路径）
 * @param {{key:string, strong?:string, weak?:string}} incoming 当前工作区的身份
 * @param {(cwd:string)=>boolean} isAlive 旧路径现在还存不存在
 * @param {{nameOf?:(key:string)=>string}} [options]
 * @returns {Verdict}
 */
export function findClaimable(existing, incoming, isAlive, options = {}) {
  const list = Array.isArray(existing) ? existing.filter((item) => item !== null && typeof item === "object") : [];
  const self = incoming !== null && typeof incoming === "object" ? incoming : {};
  const selfKey = typeof self.key === "string" ? self.key : "";
  const selfStrong = typeof self.strong === "string" ? self.strong : "";
  const selfWeak = typeof self.weak === "string" ? self.weak : "";
  const alive = typeof isAlive === "function" ? isAlive : () => true;
  const nameOf = typeof options.nameOf === "function" ? options.nameOf : (key) => key;

  if (selfKey === "") return { verdict: "none", key: "", message: "当前工作区没有可用的 key" };
  // 自己已经有一份记忆：不需要认领（哪怕是刚建的空桶，那也是这个工作区自己的）
  if (list.some((item) => item.key === selfKey)) {
    return { verdict: "none", key: "", message: "当前工作区已经有自己的记忆" };
  }
  if (selfStrong === "" && selfWeak === "") {
    return { verdict: "none", key: "", message: "拿不到当前工作区的身份特征" };
  }

  // 强指纹优先：有 strong 就只比 strong，绝不退化成 weak（弱指纹太容易碰巧相等）
  const strongMatched = selfStrong === ""
    ? []
    : list.filter((item) => item.strong === selfStrong);
  const weakMatched = selfStrong === "" && selfWeak !== ""
    ? list.filter((item) => item.weak === selfWeak)
    : [];
  const matched = strongMatched.length > 0 ? strongMatched : weakMatched;

  if (matched.length === 0) return { verdict: "none", key: "", message: "没有找到可能是改名前的旧工作区" };
  if (matched.length > 1) {
    const names = matched.map((item) => nameOf(item.key)).join("、");
    return {
      verdict: "ambiguous",
      key: "",
      message: "有 " + String(matched.length) + " 个旧工作区的身份特征相同（" + names + "），不敢自动认领 —— 请在面板里手动指定",
    };
  }

  const target = matched[0];
  const targetCwd = typeof target.cwd === "string" ? target.cwd : "";
  const usedStrong = strongMatched.length === 1;

  if (targetCwd !== "" && alive(targetCwd)) {
    return {
      verdict: "suggest",
      key: "",
      message: "「" + nameOf(target.key) + "」的身份特征和当前工作区一致，但那个目录还在 —— 可能是复制出来的副本，不自动搬；要合并请到面板手动操作",
    };
  }

  return {
    verdict: "claim",
    key: target.key,
    message: "认出改名前的旧工作区「" + nameOf(target.key) + "」（"
      + (usedStrong ? "git 仓库 / 包名一致" : "目录结构一致且旧路径已不存在")
      + "），已把它的记忆接过来",
  };
}

/**
 * 认领之后，旧 key 该不该从库里删掉。
 *
 * 恒为 true —— 认领是「搬家」不是「复制」：留着旧 key 只会让下次再撞一次同样的判定，
 * 而且旧 key 指向的路径已经不存在了，谁也访问不到它。真要回滚，migratedFrom 里留着来源。
 */
export function shouldDropOldKey() {
  return true;
}

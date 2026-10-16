/**
 * 外部模块的「存在性声明」。
 *
 * 这些模块由宿主（DSH）或运行时提供，仓库里不安装它们的类型声明，
 * 所以这里只声明「有这么一个模块」，让 tsc 安静放过 ——
 * 类型检查聚焦在本仓库自己的逻辑上，而不是去追第三方。
 *
 * 说明：`declare module "x";` 的写法会把它当作 any，不做进一步检查。
 */

// 宿主提供（peerDependencies）
declare module "@deepseek-ai/cordis";
declare module "@deepseek-ai/dsh-tools";
declare module "@deepseek-ai/dsh-home-paths";
declare module "@deepseek-ai/dsh-llm";

// 运行时装在 profile/node_modules 里，由 DSH 的模块系统注入浏览器半侧
declare module "react";
declare module "react-dom";
declare module "react-dom/client";
declare module "@huggingface/transformers";

// 浏览器半侧用的是 DSH 客户端模块加载器（见 lib/client.js 顶部）
interface Window {
  __ModuleLoader__?: {
    load: (options: { id: string; factory: (require: (name: string) => unknown) => unknown }) => void;
    require: (name: string) => unknown;
    register: (id: string, factory: (require: (name: string) => unknown) => unknown) => void;
  };
}

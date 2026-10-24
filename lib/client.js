window.__ModuleLoader__.load({
	id: "dsh-workspace-recollection",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		// 抽屉要用 position:fixed 贴右边；若某个祖先把 transform 变成了包含块，fixed 就会失效，
		// 所以能 portal 到 body 就 portal（拿不到 react-dom 时退回就地渲染，界面照样能用）。
		let reactDom = null;
		try { reactDom = require("react-dom"); } catch (ignored) { reactDom = null; }
		function portal(node) {
			try {
				if (reactDom !== null && typeof reactDom.createPortal === "function") return reactDom.createPortal(node, document.body);
			} catch (ignored) { /* 退回就地渲染 */ }
			return node;
		}

		/**
		 * dsh-workspace-recollection · 客户端半段
		 *
		 * 挂载点：会话头工具区的「记忆」按钮（slot conversation.session.header.utilities）。
		 * 点开是一个右侧抽屉：按工作区列出长期记忆，可新增/编辑/删除/置顶/锁定，
		 * 可开关「本工作区注入」与调整注入预算；另有单独的「新增」入口。
		 *
		 * 与 host 半段只走普通 HTTP：POST /api/session-memory/<method>
		 * body { sessionId, input } -> { ok: true, value } | { ok: false, error: { message } }
		 * （0.1.x 那套手写 typert 远程贡献在 0.2.x 网关的严格校验下会让客户端半段激活失败，
		 *   而桌面端把"有条目未激活"当致命 boot 错误，所以这里一律用 fetch。）
		 */

		const API_BASE = "/api/session-memory";
		const STYLE_ID = "dsh-workspace-recollection-style";
		const UI_VERSION = "3.4.0";
		const h = react.createElement;

		const CSS = `.smem-trigger{align-items:center;background:transparent;border:1px solid transparent;border-radius:6px;color:inherit;cursor:pointer;display:inline-flex;font:inherit;font-size:12px;gap:5px;height:26px;opacity:.75;padding:0 8px;transition:all .14s}
.smem-trigger:hover{background:rgba(127,127,127,.16);opacity:1}
.smem-trigger[data-open="true"]{background:rgba(127,127,127,.22);opacity:1}
.smem-trigger-badge{background:rgba(127,127,127,.26);border-radius:8px;font-size:10px;min-width:15px;padding:1px 5px;text-align:center}
.smem-scrim{background:rgba(0,0,0,.44);inset:0;position:fixed;z-index:1200}
.smem-drawer{--p1:#191920;--p2:#20202a;--p3:#262633;--line:rgba(255,255,255,.075);--line2:rgba(255,255,255,.14);--ink:#e9e9ee;--dim:#9b9ba6;--faint:#6e6e7a;--acc:#5b8cff;--acc2:rgba(91,140,255,.16);--ok:#4ade80;--warn:#fbbf24;--err:#f87171;--r:9px;background:var(--p1);bottom:0;box-shadow:-18px 0 52px rgba(0,0,0,.6);color:var(--ink);display:flex;flex-direction:column;font-size:13px;line-height:1.58;position:fixed;right:0;top:0;width:min(486px,94vw);z-index:1201}
.smem-drawer *{box-sizing:border-box}
.smem-drawer ::-webkit-scrollbar{height:8px;width:8px}
.smem-drawer ::-webkit-scrollbar-thumb{background:rgba(255,255,255,.13);border-radius:4px}
.smem-drawer ::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.22)}
.smem-drawer ::-webkit-scrollbar-track{background:transparent}
.smem-head{background:linear-gradient(180deg,rgba(255,255,255,.045),transparent);border-bottom:1px solid var(--line);padding:46px 16px 13px}
.smem-head-row{align-items:flex-start;display:flex;gap:6px}
.smem-title{font-size:14.5px;font-weight:600;letter-spacing:.2px;margin:0;white-space:nowrap}
.smem-sub{color:var(--dim);font-size:11px;line-height:1.5;margin-top:4px;overflow-wrap:anywhere}
.smem-dot{border-radius:50%;display:inline-block;height:7px;margin-right:7px;vertical-align:baseline;width:7px}
.smem-dot[data-state="ready"]{background:var(--ok);box-shadow:0 0 9px rgba(74,222,128,.8)}
.smem-dot[data-state="idle"]{background:var(--warn)}
.smem-dot[data-state="error"]{background:var(--err)}
.smem-spacer{flex:1;min-width:0}
.smem-bar{align-items:center;border-bottom:1px solid var(--line);display:flex;flex-wrap:wrap;gap:8px;padding:11px 16px}
.smem-bar-last{border-bottom:none;padding-bottom:6px}
.smem-icon-btn{background:transparent;border:1px solid transparent;border-radius:6px;color:var(--dim);cursor:pointer;font:inherit;font-size:13px;height:26px;line-height:1;padding:0 9px;transition:all .14s}
.smem-icon-btn:hover{background:var(--p3);border-color:var(--line2);color:var(--ink)}
.smem-icon-btn:disabled{opacity:.4}
.smem-input,.smem-select,.smem-textarea,.smem-search{background:var(--p2);border:1px solid var(--line2);border-radius:7px;color:inherit;font:inherit;font-size:12px;padding:6px 9px;transition:border-color .14s,box-shadow .14s}
.smem-input::placeholder,.smem-search::placeholder,.smem-textarea::placeholder{color:var(--faint)}
.smem-input:focus,.smem-select:focus,.smem-textarea:focus,.smem-search:focus{border-color:rgba(91,140,255,.6);box-shadow:0 0 0 3px var(--acc2);outline:none}
.smem-select{cursor:pointer;max-width:100%}
.smem-select option{background:#1d1d26;color:var(--ink)}
.smem-search{flex:1;min-width:130px}
.smem-textarea{line-height:1.6;min-height:84px;resize:vertical;width:100%}
.smem-btn{background:var(--p2);border:1px solid var(--line2);border-radius:7px;color:var(--ink);cursor:pointer;font:inherit;font-size:12px;padding:6px 12px;transition:all .14s;white-space:nowrap}
.smem-btn:hover:not(:disabled){background:var(--p3);border-color:rgba(255,255,255,.22)}
.smem-btn:disabled{cursor:not-allowed;opacity:.42}
.smem-btn-primary{background:var(--acc2);border-color:rgba(91,140,255,.5);color:#cfe0ff}
.smem-btn-primary:hover:not(:disabled){background:rgba(91,140,255,.28);border-color:rgba(91,140,255,.75)}
.smem-btn-danger{background:rgba(248,113,113,.13);border-color:rgba(248,113,113,.36);color:#ffc9c9}
.smem-btn-danger:hover:not(:disabled){background:rgba(248,113,113,.22)}
.smem-btn-ghost{background:transparent;border-color:transparent;color:var(--dim)}
.smem-btn-ghost:hover:not(:disabled){background:var(--p3);border-color:var(--line2);color:var(--ink)}
.smem-list{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:12px 16px 20px}
.smem-empty{color:var(--faint);font-size:12px;padding:36px 12px;text-align:center}
.smem-card{background:var(--p2);border:1px solid var(--line);border-radius:var(--r);margin-bottom:9px;padding:11px 13px;transition:border-color .14s,background .14s}
.smem-card:hover{border-color:var(--line2)}
.smem-card[data-pinned="true"]{background:linear-gradient(180deg,rgba(251,191,36,.07),rgba(251,191,36,.02));border-color:rgba(251,191,36,.34)}
.smem-card[data-locked="true"]{border-color:rgba(91,140,255,.34)}
.smem-summary{font-size:13px;font-weight:500;line-height:1.55;word-break:break-word}
.smem-text{color:#c6c6d0;font-size:12px;line-height:1.65;white-space:pre-wrap;word-break:break-word}
.smem-deep{margin-top:7px}
.smem-deep>summary{color:var(--faint);cursor:pointer;font-size:11px;list-style:none;transition:color .14s}
.smem-deep>summary:hover{color:var(--dim)}
.smem-deep>summary::-webkit-details-marker{display:none}
.smem-deep>summary::before{content:"▸ ";display:inline-block;transition:transform .16s}
.smem-deep[open]>summary::before{content:"▾ "}
.smem-deep .smem-text{background:rgba(0,0,0,.24);border-radius:6px;margin-top:7px;padding:9px 10px}
.smem-meta{align-items:center;color:var(--faint);display:flex;flex-wrap:wrap;font-size:11px;gap:7px;margin-top:8px}
.smem-tag{background:rgba(255,255,255,.07);border-radius:20px;color:var(--dim);padding:1px 8px}
.smem-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px}
.smem-actions .smem-btn{font-size:11px;padding:4px 9px}
.smem-foot{border-top:1px solid var(--line);flex:0 1 auto;max-height:52%;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:12px 16px 14px}
.smem-foot-row{align-items:center;background:var(--p1);color:var(--dim);display:flex;flex-wrap:wrap;font-size:12px;gap:8px;padding:2px 0 4px;position:sticky;top:-1px;z-index:2}
.smem-error{background:rgba(248,113,113,.12);border:1px solid rgba(248,113,113,.36);border-radius:7px;color:#ffc9c9;font-size:12px;margin:10px 16px 0;padding:8px 11px}
.smem-note{color:var(--faint);font-size:11px;line-height:1.6;margin-top:8px}
.smem-editor{background:var(--p2);border:1px solid var(--line2);border-radius:var(--r);margin-bottom:11px;padding:12px}
.smem-editor-row{align-items:center;display:flex;flex-wrap:wrap;gap:7px;margin-top:9px}
.smem-switch{align-items:center;color:var(--dim);cursor:pointer;display:inline-flex;font-size:12px;gap:7px;user-select:none}
.smem-switch input{accent-color:var(--acc);height:14px;width:14px}
.smem-preview{background:rgba(0,0,0,.3);border:1px solid var(--line);border-radius:7px;color:#bfbfca;font-family:ui-monospace,Consolas,monospace;font-size:11px;line-height:1.6;margin-top:8px;max-height:210px;overflow:auto;padding:9px 11px;white-space:pre-wrap;word-break:break-word}
.smem-status{align-items:center;border-bottom:1px solid var(--line);display:flex;flex-wrap:wrap;gap:7px;padding:9px 16px}
.smem-pill{background:rgba(255,255,255,.06);border-radius:20px;color:var(--dim);font-size:11px;padding:2px 9px}
.smem-pill[data-state="ready"]{background:rgba(74,222,128,.15);color:#9ff0bd}
.smem-pill[data-state="loading"]{background:rgba(251,191,36,.16);color:#ffdd94}
.smem-pill[data-state="failed"]{background:rgba(248,113,113,.16);color:#ffb4b4}
.smem-block{border-top:1px solid var(--line);margin-top:9px;padding-top:10px}
.smem-import-list{border:1px solid var(--line);border-radius:8px;margin-top:9px;max-height:210px;overflow:auto}
.smem-import-row{align-items:center;cursor:pointer;display:flex;flex-wrap:wrap;font-size:11px;gap:7px;padding:5px 10px;transition:background .12s}
.smem-import-row:hover{background:rgba(255,255,255,.05)}
.smem-import-id{color:var(--dim);font-family:ui-monospace,Consolas,monospace}
.smem-import-label{color:#c6c6d0;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.smem-progress{background:rgba(255,255,255,.1);border-radius:3px;height:4px;margin:9px 16px 0;overflow:hidden}
.smem-progress-bar{background:linear-gradient(90deg,#5b8cff,#4ade80);border-radius:3px;height:100%;transition:width .45s ease}
.smem-progress-text{color:var(--faint);font-size:11px;margin:5px 16px 0}`;


		/**
		 * 独立管理台的样式（v2.15）。
		 * 不复用 .smem-drawer 的变量：抽屉是 position:fixed 的浮层，管理台要能嵌进设置页，
		 * 两者层级和尺寸约束不同，共用一套变量只会在某一边出问题。
		 */
		const MANAGER_CSS = `.smem-mgr{--mp1:#13131a;--mp2:#1b1b24;--mp3:#232330;--mline:rgba(255,255,255,.08);--mline2:rgba(255,255,255,.16);--mink:#e9e9ee;--mdim:#9b9ba6;--mfaint:#6e6e7a;--macc:#5b8cff;--mok:#4ade80;--mwarn:#fbbf24;--merr:#f87171;background:var(--mp1);border:1px solid var(--mline);border-radius:10px;color:var(--mink);display:flex;flex-direction:column;font-size:13px;line-height:1.55;min-height:460px;overflow:hidden}
.smem-mgr *{box-sizing:border-box}
.smem-mgr ::-webkit-scrollbar{height:8px;width:8px}
.smem-mgr ::-webkit-scrollbar-thumb{background:rgba(255,255,255,.13);border-radius:4px}
.smem-mgr-head{align-items:center;background:linear-gradient(180deg,rgba(255,255,255,.05),transparent);border-bottom:1px solid var(--mline);display:flex;gap:10px;padding:12px 14px}
.smem-mgr-title{font-size:14px;font-weight:600;margin:0}
.smem-mgr-sub{color:var(--mdim);font-size:11px;margin-top:2px}
.smem-mgr-body{display:flex;flex:1;min-height:0}
.smem-mgr-list{border-right:1px solid var(--mline);flex-shrink:0;overflow:auto;width:236px}
.smem-mgr-ws{background:transparent;border:none;border-bottom:1px solid var(--mline);color:var(--mink);cursor:pointer;display:block;font:inherit;padding:9px 12px;text-align:left;width:100%}
.smem-mgr-ws:hover{background:rgba(255,255,255,.05)}
.smem-mgr-ws[data-active="true"]{background:rgba(91,140,255,.16);box-shadow:inset 3px 0 0 var(--macc)}
.smem-mgr-ws-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.smem-mgr-ws-meta{color:var(--mdim);font-size:11px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.smem-mgr-main{display:flex;flex:1;flex-direction:column;min-width:0}
.smem-mgr-info{border-bottom:1px solid var(--mline);padding:10px 14px}
.smem-mgr-path{color:var(--mdim);font-family:ui-monospace,Consolas,monospace;font-size:11px;overflow-wrap:anywhere}
.smem-mgr-actions{align-items:center;display:flex;flex-wrap:wrap;gap:7px;margin-top:8px}
.smem-mgr-entries{flex:1;overflow:auto}
.smem-mgr-entry{border-bottom:1px solid var(--mline);display:flex;gap:9px;padding:8px 14px}
.smem-mgr-entry:hover{background:rgba(255,255,255,.03)}
.smem-mgr-entry-body{flex:1;min-width:0}
.smem-mgr-entry-sum{overflow-wrap:anywhere}
.smem-mgr-entry-meta{color:var(--mfaint);font-family:ui-monospace,Consolas,monospace;font-size:10.5px;margin-top:3px}
.smem-mgr-empty{color:var(--mdim);padding:26px 14px;text-align:center}
.smem-mgr-tag{background:rgba(91,140,255,.14);border-radius:4px;color:#a8c2ff;font-size:10.5px;padding:0 5px}
.smem-mgr-badge{border-radius:4px;font-size:10.5px;padding:0 5px}
.smem-mgr-badge[data-kind="ok"]{background:rgba(74,222,128,.16);color:#9ff0bd}
.smem-mgr-badge[data-kind="warn"]{background:rgba(251,191,36,.16);color:#ffdd94}
.smem-mgr-badge[data-kind="info"]{background:rgba(91,140,255,.16);color:#a8c2ff}
.smem-mgr-btn{background:var(--mp3);border:1px solid var(--mline2);border-radius:6px;color:var(--mink);cursor:pointer;font:inherit;font-size:12px;height:26px;padding:0 10px}
.smem-mgr-btn:hover{background:rgba(255,255,255,.1)}
.smem-mgr-btn:disabled{opacity:.45;cursor:default}
.smem-mgr-btn[data-tone="danger"]{color:#ffb4b4}
.smem-mgr-x{background:transparent;border:none;color:var(--mfaint);cursor:pointer;font:inherit;font-size:15px;line-height:1;padding:2px 6px}
.smem-mgr-x:hover{color:var(--merr)}
.smem-mgr-select{background:var(--mp2);border:1px solid var(--mline2);border-radius:6px;color:var(--mink);font:inherit;font-size:12px;height:26px;max-width:220px;padding:0 6px}
.smem-mgr-note{color:var(--mwarn);font-size:11px;margin-top:6px}
.smem-mgr-overlay{background:#13131a;border:1px solid rgba(255,255,255,.16);border-radius:12px;box-shadow:0 24px 70px rgba(0,0,0,.7);display:flex;height:min(720px,86vh);left:50%;position:fixed;top:50%;transform:translate(-50%,-50%);width:min(1080px,92vw);z-index:1301}
.smem-mgr-overlay .smem-mgr{border:none;border-radius:0;flex:1;min-height:0}`;

		/** 全屏内置面板的样式（v2.18）：看起来像独立窗口，实际仍在本界面里。 */
		const OVERLAY_CSS = [
			'.smem-ov-mask{align-items:center;background:rgba(6,6,10,.72);backdrop-filter:blur(4px);display:flex;inset:0;justify-content:center;position:fixed;z-index:2000}',
			'.smem-ov-panel{background:#0e0e13;border:1px solid rgba(255,255,255,.16);border-radius:14px;box-shadow:0 30px 90px rgba(0,0,0,.7);display:flex;flex-direction:column;height:min(880px,92vh);overflow:hidden;width:min(1360px,94vw)}',
			'.smem-ov-bar{align-items:center;border-bottom:1px solid rgba(255,255,255,.08);color:#e8e8ef;display:flex;gap:10px;padding:10px 16px}',
			'.smem-ov-title{font-size:13.5px;font-weight:600}',
			'.smem-ov-close{background:transparent;border:1px solid transparent;border-radius:6px;color:#9a9aa8;cursor:pointer;font:inherit;font-size:15px;height:28px;line-height:1;padding:0 10px}',
			'.smem-ov-close:hover{background:rgba(255,255,255,.08);color:#e8e8ef}',
			'.smem-ov-frame{border:none;flex:1;width:100%}',
		].join("");

		function ensureStyle() {
			try {
				if (document.getElementById(STYLE_ID) !== null) return;
				const style = document.createElement("style");
				style.id = STYLE_ID;
				style.textContent = CSS + MANAGER_CSS + OVERLAY_CSS;
				document.head.appendChild(style);
			} catch (ignored) { /* 样式注入失败不该拖垮界面 */ }
		}

		function report(method, message) {
			try {
				void fetch(API_BASE + "/" + method, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ sessionId: "", input: { message: String(message === undefined ? "" : message).slice(0, 800) } }),
				});
			} catch (ignored) { /* 上报永不抛错 */ }
		}

		function createApi() {
			const invoke = async (method, sessionId, input) => {
				try {
					const response = await fetch(API_BASE + "/" + method, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ sessionId, input }),
					});
					const text = await response.text();
					let payload = null;
					try { payload = JSON.parse(text); } catch { payload = null; }
					if (payload === null || typeof payload !== "object") {
						return { ok: false, error: { message: "session-memory: 服务端响应无法解析（HTTP " + response.status + "）" } };
					}
					return payload;
				} catch (error) {
					return { ok: false, error: { message: "session-memory: 请求失败（" + String(error && error.message ? error.message : error) + "）" } };
				}
			};
			return {
				invoke,
				async call(method, sessionId, input) {
					const payload = await invoke(method, sessionId, input);
					if (payload.ok) return { ok: true, value: payload.value };
					return { ok: false, message: String(payload.error && payload.error.message ? payload.error.message : "未知错误") };
				},
			};
		}

		function shortDate(value) {
			const text = String(value === undefined || value === null ? "" : value);
			return text.length >= 10 ? text.slice(0, 10) : text;
		}

		function workspaceLabel(row) {
			if (row === null || typeof row !== "object") return "";
			const cwd = String(row.cwd ?? "");
			const parts = cwd.split(/[\\/]+/).filter((part) => part !== "");
			const tail = parts.length > 0 ? parts[parts.length - 1] : cwd;
			return tail + " （" + String(row.count ?? 0) + " 条）";
		}

		/** 工作区显示名：路径最后一段（没有 cwd 就退回 key）。 */
		function workspaceName(row) {
			const cwd = row !== null && row !== undefined && typeof row.cwd === "string" ? row.cwd : "";
			const parts = cwd.split(/[\\/]+/).filter((part) => part !== "");
			if (parts.length > 0) return parts[parts.length - 1];
			return row !== null && row !== undefined && typeof row.key === "string" && row.key !== "" ? row.key : "（未知工作区）";
		}

		/**
		 * 记忆管理台（v2.15）：**跨工作区**的独立界面，不依赖当前会话。
		 *
		 * 和右边抽屉的分工：抽屉是「随手看看当前工作区」，管理台是「把整套记忆当资产管理」——
		 * 能看到所有工作区（包括路径已经不存在的老工作区）、能看到某条记忆是从哪个旧路径认领来的、
		 * 能把一个工作区的记忆整体搬到另一个（工作区改名后半自动的那一半）。
		 *
		 * 它同时挂在两个地方：设置页里的一个分区（常驻），以及侧边栏底部的按钮（浮层）。
		 * 两处渲染的是同一个组件，只是外层容器不同。
		 */
		/**
		 * 右上角那颗「记忆」按钮（v2.17）。
		 *
		 * 它现在只干两件事：把当前工作区的条数显示成徽章、点一下打开独立管理台窗口。
		 * 原来那六百行抽屉代码全删了 —— 功能已经整体搬到 /api/session-memory/page 那个页面，
		 * 留在宿主界面里的只剩入口。
		 */
		/**
		 * 全屏内置面板（v2.18）。
		 *
		 * 为什么不再跳系统浏览器：那是「外挂」—— 开源版用户的机器上未必有默认浏览器、
		 * 防火墙可能拦 127.0.0.1、自定义协议 dsh-app:// 也只有 Electron 认。
		 * 这里用 iframe 把同一份页面载在 DSH 里，看上去是个独立窗口，实际不离开应用。
		 */
		function MemoryOverlay(props) {
			const onClose = props.onClose;
			react.useEffect(() => {
				const onKey = (event) => { if (event.key === "Escape") onClose(); };
				document.addEventListener("keydown", onKey);
				return () => { document.removeEventListener("keydown", onKey); };
			}, [onClose]);
			return portal(h("div", { className: "smem-ov-mask", onClick: onClose },
				h("div", { className: "smem-ov-panel", onClick: (event) => { event.stopPropagation(); } },
					h("div", { className: "smem-ov-bar" },
						h("span", { className: "smem-ov-title" }, "工作区记忆"),
						h("span", { className: "smem-spacer" }),
						h("button", { type: "button", className: "smem-ov-close", title: "关闭（Esc）", onClick: onClose }, "✕"),
					),
					h("iframe", { className: "smem-ov-frame", src: API_BASE + "/page", title: "工作区记忆管理台" }),
				),
			));
		}

		function MemoryTrigger(props) {
			const api = props.api;
			const sessionId = typeof props.sessionId === "string" ? props.sessionId : "";
			const [count, setCount] = react.useState("");
			const [open, setOpen] = react.useState(false);

			react.useEffect(() => {
				let alive = true;
				(async () => {
					try {
						const result = await api.call("list", sessionId, {});
						if (!alive || !result.ok) return;
						const snap = result.value !== null && typeof result.value === "object" ? result.value : {};
						const rows = Array.isArray(snap.workspaces) ? snap.workspaces : [];
						const key = typeof snap.targetKey === "string" ? snap.targetKey : "";
						const row = rows.find((item) => item.key === key);
						setCount(row === undefined ? "" : String(row.count === undefined ? 0 : row.count));
					} catch (ignored) { /* 徽章拿不到不影响按钮能用 */ }
				})();
				return () => { alive = false; };
			}, [api, sessionId]);

			return h(react.Fragment, null,
				h("button", {
					type: "button",
					className: "smem-trigger",
					"data-open": open ? "true" : "false",
					title: "打开工作区记忆面板",
					onClick: () => { setOpen(true); },
				},
					h("span", { "aria-hidden": "true" }, "🧠"),
					h("span", null, "记忆"),
					count === "" || count === "0" ? null : h("span", { className: "smem-trigger-badge" }, count),
				),
				open ? h(MemoryOverlay, { onClose: () => { setOpen(false); } }) : null,
			);
		}

		/** 设置页里的「记忆」分区（v2.18）：一个入口按钮，打开的是同一个内置面板。 */
		function MemorySettingsSection(props) {
			const [open, setOpen] = react.useState(false);
			return h("div", { style: { color: "#e8e8ef", fontSize: "13px", lineHeight: "1.7" } },
				h("h3", { style: { fontSize: "15px", margin: "0 0 6px" } }, "工作区记忆"),
				h("p", { style: { color: "#9a9aa8", margin: "0 0 12px" } },
					"记忆按工作区隔离、跨会话共享。点开是一个全屏面板 —— 会话还在后面，按 Esc 或点空白处关掉。"),
				h("button", {
					type: "button",
					onClick: () => { setOpen(true); },
					style: {
						background: "linear-gradient(180deg,#5b8cff,#4a7bf0)", border: "1px solid #5b8cff", borderRadius: "8px",
						color: "#fff", cursor: "pointer", font: "inherit", fontSize: "13px", fontWeight: 600,
						height: "32px", padding: "0 16px",
					},
				}, "打开记忆面板"),
				open ? h(MemoryOverlay, { onClose: () => { setOpen(false); } }) : null,
			);
		}
		async function openConsoleWindow(api) {
			try {
				const win = window.open(API_BASE + "/page", "dsh-memory-console",
					"width=1180,height=820,menubar=no,toolbar=no,location=no,status=no");
				if (win !== null && win !== undefined) {
					try { win.focus(); } catch (ignored) { /* 聚焦失败不影响窗口已开 */ }
					return;
				}
			} catch (ignored) { /* 继续往下试 */ }
			// 第二级：让 host 自己拼地址。WebView 的 location.origin 是 dsh-app://app，
			// 那是 Electron 的自定义协议，系统浏览器不认 —— 所以这个 URL 只能由 host
			// 从请求头里捞真实的 127.0.0.1:<port> 再拼出来。
			let hint = "";
			try {
				const result = await api.call("openConsole", "", {});
				if (result.ok) return;
				hint = result.message === undefined ? "" : String(result.message);
			} catch (error) { hint = String(error && error.message ? error.message : error); }
			try {
				window.alert("打不开独立窗口。\n" + (hint === "" ? "可以在浏览器里打开 /api/session-memory/page。" : hint));
			} catch (ignored) { /* 连 alert 都没有就算了 */ }
		}

		exports.inject = ["slots"];

		async function apply(ctx) {
			// 客户端半段绝不允许把整个 Web boot 拖挂：任何失败都安静降级（只是少一个面板）。
			try {
				ensureStyle();
				const slots = ctx.get("slots");
				if (slots === undefined || slots === null) throw new Error("session-memory: slots service unavailable");
				const api = createApi();
				const registration = slots.inject("conversation.session.header.utilities", () => slots.register(
					{
						name: "conversation.session.header.utilities",
						id: "session-memory",
						order: 30,
						inject: (sessionId) => ({ sessionId, api }),
					},
					MemoryTrigger,
				));
				if (registration !== undefined && registration !== null && typeof registration.then === "function") await registration;

				// v2.15 独立化：设置页里一个常驻分区 + 侧边栏一个快捷入口，都不依赖当前会话。
				// 单独 try 包住 —— 这两个 slot 在某些内核版本可能不存在，缺了也不该让会话头那个面板一起挂掉。
				try {
					const settingsReg = slots.inject("settings.section", () => slots.register(
						{
							name: "settings.section",
							id: "session-memory",
							order: 17,
							label: () => "记忆",
							inject: () => ({ api }),
						},
						(props) => h(MemorySettingsSection, { api: (props !== null && props !== undefined && props.api !== undefined) ? props.api : api }),
					));
					if (settingsReg !== undefined && settingsReg !== null && typeof settingsReg.then === "function") await settingsReg;
					report("settingsSection", "slot settings.section registered");
				} catch (settingsError) {
					report("settingsSectionFailed", String(settingsError && settingsError.message ? settingsError.message : settingsError).slice(0, 200));
				}
				// v2.17：左下角那个「记忆」入口去掉了 —— 用户明确只要右上角那一个，
				// 而且点开的是独立窗口，不需要在侧边栏再摆一个。
				report("clientReady", "slots registered (header → 独立管理台 + settings.section); ui " + UI_VERSION);
			} catch (error) {
				const message = String(error && error.message ? error.message : error);
				console.error("session-memory: client half disabled ->", error);
				report("clientError", message);
			}
		}

		exports.apply = apply;
		return module.exports;
	},
});

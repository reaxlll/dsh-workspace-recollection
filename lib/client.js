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

		function ensureStyle() {
			try {
				if (document.getElementById(STYLE_ID) !== null) return;
				const style = document.createElement("style");
				style.id = STYLE_ID;
				style.textContent = CSS;
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

		function MemoryPanel(props) {
			const sessionId = typeof props.sessionId === "string" ? props.sessionId : "";
			const api = props.api;
			const [open, setOpen] = react.useState(false);
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState("");
			const [snapshot, setSnapshot] = react.useState(null);
			const [query, setQuery] = react.useState("");
			const [viewKey, setViewKey] = react.useState("");
			const [editingId, setEditingId] = react.useState("");
			const [draftText, setDraftText] = react.useState("");
			const [draftTags, setDraftTags] = react.useState("");
			const [composing, setComposing] = react.useState(false);
			const [budget, setBudget] = react.useState("");
			const [preview, setPreview] = react.useState(null);
			const [panelMode, setPanelMode] = react.useState("");
			const [recallQuery, setRecallQuery] = react.useState("");
			const [recallResult, setRecallResult] = react.useState(null);
			const [fileText, setFileText] = react.useState("");
			const [fileDraft, setFileDraft] = react.useState("");
			const [fileEditing, setFileEditing] = react.useState(false);
			const [note, setNote] = react.useState("");
			const [draftSummary, setDraftSummary] = react.useState("");
			const [importSessions, setImportSessions] = react.useState(null);
			const [importPicked, setImportPicked] = react.useState([]);
			const [importPreview, setImportPreview] = react.useState(null);
			const [importDepth, setImportDepth] = react.useState("full");
			const [importStatus, setImportStatus] = react.useState(null);
			const [importImported, setImportImported] = react.useState([]);

			const refresh = react.useCallback(async (keyOverride) => {
				setBusy(true);
				const key = typeof keyOverride === "string" ? keyOverride : viewKey;
				const result = await api.call("list", sessionId, key === "" ? {} : { key });
				setBusy(false);
				if (!result.ok) { setError(result.message); return; }
				setError("");
				setSnapshot(result.value);
				setBudget(String(result.value.budgetChars));
				setViewKey(String(result.value.targetKey ?? ""));
			}, [api, sessionId, viewKey]);

			react.useEffect(() => {
				if (!open) return;
				void refresh(viewKey);
			}, [open, sessionId]);

			react.useEffect(() => {
				if (!open) return;
				const onKeyDown = (event) => {
					if (event.key !== "Escape") return;
					if (composing || editingId !== "") { setComposing(false); setEditingId(""); return; }
					setOpen(false);
				};
				document.addEventListener("keydown", onKeyDown);
				return () => { document.removeEventListener("keydown", onKeyDown); };
			}, [open, composing, editingId]);

			react.useEffect(() => {
				if (!open || panelMode !== "import") return undefined;
				const timer = setInterval(() => { void pollImport(); }, 2500);
				return () => { clearInterval(timer); };
			}, [open, panelMode]);

			const entries = snapshot !== null && Array.isArray(snapshot.entries) ? snapshot.entries : [];
			const visible = query.trim() === ""
				? entries
				: entries.filter((entry) => {
					const haystack = (String(entry.text ?? "") + " " + (Array.isArray(entry.tags) ? entry.tags.join(" ") : "")).toLowerCase();
					return query.trim().toLowerCase().split(/\s+/).every((word) => haystack.includes(word));
				});
			const ordered = [...visible].sort((a, b) => (a.pinned === b.pinned) ? String(b.updatedAt).localeCompare(String(a.updatedAt)) : (a.pinned ? -1 : 1));
			const embedder = snapshot !== null && snapshot.embedder ? snapshot.embedder : { state: "idle", message: "", model: "" };
			const embedderLabel = embedder.state === "ready" ? "就绪" : embedder.state === "loading" ? "加载中" : embedder.state === "failed" ? "失败" : "未加载";
			const injectMode = snapshot !== null && typeof snapshot.targetInjectMode === "string" ? snapshot.targetInjectMode : "index";
			const counts = snapshot !== null && snapshot.counts ? snapshot.counts : { shallow: 0, deep: 0, total: 0 };
			const pendingCount = entries.filter((entry) => entry.summaryState === "pending").length;
			const summaryRoute = snapshot !== null && snapshot.summaryRoute ? snapshot.summaryRoute : { provider: "", model: "" };
			const shallowOf = (entry) => {
				const value = entry && typeof entry.summary === "string" ? entry.summary : "";
				if (value !== "") return value;
				const text = String(entry && entry.text ? entry.text : "");
				const line = text.split("\n").map((part) => part.trim()).filter((part) => part !== "")[0] || text.trim();
				return line.length > 88 ? line.slice(0, 88) + "…" : line;
			};
			const previewText = preview === null ? "（点「预览注入」看看此刻会喂给模型什么）" : (preview.text === "" ? "（当前不会注入任何内容：没有记忆，或这个工作区被关掉了注入。）" : preview.text);
			const injectDotState = embedder.state === "failed"
				? "error"
				: injectMode === "off"
					? "idle"
					: (snapshot !== null && snapshot.targetEnabled !== false && entries.length > 0 ? "ready" : "idle");
			const injectDotText = injectDotState === "ready"
				? "注入已生效 · 浅层 " + String(counts.shallow) + " / 深层 " + String(counts.deep) + " 块 · 细节用 memory_recall"
				: injectDotState === "error"
					? "嵌入模型不可用，语义检索会降级成关键词"
					: injectMode === "off" ? "本工作区的注入已关闭" : "这个工作区还没有记忆，我记下东西后这里会亮";
			const importRunning = importStatus !== null && importStatus.running === true;
			const sumInfo = snapshot !== null && snapshot.summarizer ? snapshot.summarizer : null;
			const sumSettled = sumInfo === null ? 0 : (sumInfo.done || 0) + (sumInfo.failed || 0);
			const sumTotal = sumInfo === null ? 0 : (sumInfo.total || 0);
			const sumActive = sumInfo !== null && ((sumInfo.queued || 0) > 0 || sumInfo.busy === true);
			const progress = importRunning
				? { label: "正在导入会话…已完成 " + String(importStatus.done) + " 条" + (importStatus.failed > 0 ? "（失败 " + String(importStatus.failed) + "）" : ""), pct: importStatus.total > 0 ? Math.min(96, Math.round((importStatus.done / Math.max(1, importStatus.total * 8)) * 100)) : 25 }
				: sumActive
					? { label: "AI 要点总结中… " + String(sumSettled) + "/" + String(sumTotal), pct: sumTotal > 0 ? Math.round((sumSettled / sumTotal) * 100) : 30 }
					: null;

			const mutate = async (method, input) => {
				setBusy(true);
				const result = await api.call(method, sessionId, input);
				setBusy(false);
				if (!result.ok) { setError(result.message); return false; }
				setError("");
				setSnapshot(result.value);
				setBudget(String(result.value.budgetChars));
				return true;
			};

			const loadImport = async () => {
				setBusy(true);
				const result = await api.call("importList", sessionId, {});
				const fresh = await api.call("list", sessionId, {});
				setBusy(false);
				if (!result.ok) { setError(result.message); return; }
				setError("");
				if (fresh.ok) { setSnapshot(fresh.value); }
				setImportSessions(result.value.sessions);
				setImportStatus(result.value.status);
				// 「已导过」只认 origin === "import" 的记忆：别的记忆带的 sessionId 只是
				// 「当时写在哪个会话里」，拿来当导入凭据会把没导过的会话误标。
				setImportImported(
					fresh.ok && Array.isArray(fresh.value.entries)
						? fresh.value.entries
							.filter((entry) => entry.source && entry.source.origin === "import")
							.map((entry) => entry.source.sessionId)
						: (result.value.imported || []),
				);
			};
			const togglePicked = (id) => {
				setImportPicked((current) => current.includes(id) ? current.filter((item) => item !== id) : current.concat([id]));
			};
			const toggleAll = (ids) => {
				setImportPicked((current) => (current.length > 0 && ids.every((id) => current.includes(id)) ? [] : [...ids]));
			};
			const previewImport = async (id) => {
				setBusy(true);
				const result = await api.call("importPreview", sessionId, { id, depth: importDepth });
				setBusy(false);
				if (!result.ok) { setError(result.message); return; }
				setError("");
				setImportPreview(result.value);
			};
			const startImport = async () => {
				if (importPicked.length === 0) { setError("先勾选要导入的会话"); return; }
				setBusy(true);
				const result = await api.call("importRun", sessionId, { ids: importPicked, depth: importDepth });
				setBusy(false);
				if (!result.ok) { setError(result.message); return; }
				setError("");
									setImportStatus(result.value.status);
					setNote("已开始导入 " + String(result.value.sessions) + " 个会话，后台跑着（深层写原文，要点稍后由 AI 补齐）");
			};
			const pollImport = async () => {
				const result = await api.call("importProgress", sessionId, {});
				if (result.ok) setImportStatus(result.value);
			};
			const openPanel = async (mode) => {
				if (panelMode === mode) { setPanelMode(""); return; }
				setPanelMode(mode);
				setNote("");
				if (mode === "import") { void loadImport(); }
				if (mode === "file") {
					const result = await api.call("readMemoryFile", sessionId, {});
					if (result.ok) { setFileText(result.value.text); setFileDraft(result.value.text); } else { setError(result.message); }
				}
				if (mode === "preview") {
					setBusy(true);
					const result = await api.call("preview", sessionId, {});
					setBusy(false);
					if (result.ok) { setPreview(result.value); } else { setError(result.message); }
				}
				if (mode === "recall") { setNote("嵌入模型：" + embedderLabel); void api.call("warmup", sessionId, {}); }
			};
			const runRecallTest = async () => {
				if (recallQuery.trim() === "") { setError("先写一句要检索的话"); return; }
				setBusy(true);
				const result = await api.call("recallTest", sessionId, { query: recallQuery, limit: 5 });
				setBusy(false);
				if (!result.ok) { setError(result.message); return; }
				setError("");
				setRecallResult(result.value);
			};
			const doReindex = async () => {
				setBusy(true);
				setNote("正在重建索引…");
				const result = await api.call("reindex", sessionId, {});
				setBusy(false);
				if (!result.ok) { setError(result.message); setNote(""); return; }
				setError("");
				setSnapshot(result.value);
				setNote("重建完成：" + String(result.value.reindex ? result.value.reindex.done : 0) + "/" + String(result.value.reindex ? result.value.reindex.total : 0) + " 条" + (result.value.reindex && result.value.reindex.message ? "（" + result.value.reindex.message + "）" : ""));
			};
			const saveManual = async () => {
				setBusy(true);
				const result = await api.call("writeManualBlock", sessionId, { manual: fileDraft });
				setBusy(false);
				if (!result.ok) { setError(result.message); return; }
				setError("");
				setFileText(result.value.text);
				setFileEditing(false);
				setNote("Memory.md 已更新");
			};
			const doResummarize = async () => {
				setBusy(true);
				setNote("已排队重新总结…");
				const result = await api.call("resummarize", sessionId, {});
				setBusy(false);
				if (!result.ok) { setError(result.message); setNote(""); return; }
				setError("");
				setSnapshot(result.value);
				setNote("已排队 " + String(result.value.queued) + " 条，后台逐个总结中（模型：" + String(summaryRoute.model) + "）");
			};
			const warmModel = async () => {
				setNote("正在加载嵌入模型…");
				const result = await api.call("warmup", sessionId, {});
				setNote(result.ok ? "嵌入模型已就绪" : "加载失败：" + String(result.value ? result.value.message : ""));
				void refresh(viewKey);
			};
			const togglePreview = async () => {
				if (preview !== null) { setPreview(null); return; }
				setBusy(true);
				const result = await api.call("preview", sessionId, {});
				setBusy(false);
				if (!result.ok) { setError(result.message); return; }
				setError("");
				setPreview(result.value);
			};

			const submitDraft = async () => {
				if (draftText.trim() === "") { setError("记忆内容不能为空"); return; }
				const tags = draftTags.split(/[,，、\s]+/).map((tag) => tag.trim()).filter((tag) => tag !== "");
				const summaryText = draftSummary.trim();
				const ok = editingId === ""
					? await mutate("create", { text: draftText, summary: summaryText, tags })
					: await mutate("update", { id: editingId, text: draftText, summary: summaryText, tags });
				if (!ok) return;
				setComposing(false);
				setEditingId("");
				setDraftText("");
				setDraftTags("");
			};

			const startEdit = (entry) => {
				setEditingId(String(entry.id));
				setDraftText(String(entry.text ?? ""));
				setDraftSummary(String(entry.summary ?? ""));
				setDraftTags(Array.isArray(entry.tags) ? entry.tags.join(", ") : "");
				setComposing(true);
			};

			const removeEntry = async (entry) => {
				await mutate("remove", { ids: [String(entry.id)] });
			};

			const toggleFlag = async (entry, flag) => {
				await mutate("update", { id: String(entry.id), [flag]: entry[flag] !== true, force: true });
			};

			const triggerBadge = snapshot !== null ? String(Array.isArray(snapshot.entries) ? snapshot.entries.length : 0) : "";

			const editor = composing
				? h("div", { className: "smem-editor" },
					h("input", {
						className: "smem-input",
						style: { marginBottom: "7px", width: "100%" },
						placeholder: "浅层要点（一句话，省略则 AI 自动总结）",
						value: draftSummary,
						onChange: (event) => { setDraftSummary(event.target.value); },
					}),
					h("textarea", {
						className: "smem-textarea",
						placeholder: "一条独立、自洽、具体的事实或约定，例如：本工作区的 Node 是 v24，pwsh 是 5.1，处理 UTF-8 文本一律走 Node 而不是 Set-Content。",
						value: draftText,
						onChange: (event) => { setDraftText(event.target.value); },
					}),
					h("input", {
						className: "smem-input",
						style: { marginTop: "7px", width: "100%" },
						placeholder: "标签，逗号分隔，例如：偏好, 项目, 踩坑",
						value: draftTags,
						onChange: (event) => { setDraftTags(event.target.value); },
					}),
					h("div", { className: "smem-editor-row" },
						h("button", { type: "button", className: "smem-btn smem-btn-primary", disabled: busy, onClick: () => { void submitDraft(); } }, editingId === "" ? "保存记忆" : "保存修改"),
						h("button", { type: "button", className: "smem-btn", disabled: busy, onClick: () => { setComposing(false); setEditingId(""); setDraftText(""); setDraftTags(""); setDraftSummary(""); } }, "取消"),
					),
				)
				: null;

			const cardOf = (entry) => h("div", {
				key: String(entry.id),
				className: "smem-card",
				"data-pinned": entry.pinned === true ? "true" : "false",
				"data-locked": entry.locked === true ? "true" : "false",
			},
				h("div", { className: "smem-summary" }, shallowOf(entry)),
				h("details", { className: "smem-deep" },
					h("summary", null, "深层原文" + (entry.summaryState === "pending" ? "（AI 总结中）" : entry.summaryState === "failed" ? "（AI 总结失败，上面是规则摘要）" : "")),
					h("div", { className: "smem-text" }, String(entry.text ?? "")),
				),
				h("div", { className: "smem-meta" },
					entry.pinned === true ? h("span", null, "★ 置顶") : null,
					entry.locked === true ? h("span", null, "🔒 锁定") : null,
					(Array.isArray(entry.tags) ? entry.tags : []).map((tag) => h("span", { key: "tag-" + String(tag), className: "smem-tag" }, "#" + String(tag))),
					h("span", { className: "smem-spacer" }),
					h("span", null, shortDate(entry.updatedAt)),
				),
				h("div", { className: "smem-actions" },
					h("button", { type: "button", className: "smem-btn smem-btn-ghost", disabled: busy, onClick: () => { void toggleFlag(entry, "pinned"); } }, entry.pinned === true ? "取消置顶" : "置顶"),
					h("button", { type: "button", className: "smem-btn smem-btn-ghost", disabled: busy, onClick: () => { void toggleFlag(entry, "locked"); } }, entry.locked === true ? "解锁" : "锁定"),
					h("button", { type: "button", className: "smem-btn smem-btn-ghost", disabled: busy, onClick: () => { startEdit(entry); } }, "编辑"),
					h("button", { type: "button", className: "smem-btn smem-btn-danger", disabled: busy, onClick: () => { void removeEntry(entry); } }, "删除"),
				),
			);

			const drawer = open
				? [
					portal(h("div", { key: "scrim", className: "smem-scrim", onClick: () => { setOpen(false); } })),
					portal(h("div", { key: "drawer", className: "smem-drawer", role: "dialog", "aria-label": "工作区记忆" },
						h("div", { className: "smem-head" },
	h("div", { className: "smem-head-row" },
		h("div", { className: "smem-spacer" },
			h("h2", { className: "smem-title" }, "🧠 工作区记忆"),
			h("div", { className: "smem-sub" }, snapshot !== null ? String(snapshot.targetCwd === "" ? "（未识别到工作区目录）" : snapshot.targetCwd) : "加载中…"),
		),
		h("button", { type: "button", className: "smem-icon-btn", title: "刷新", disabled: busy, onClick: () => { void refresh(viewKey); } }, "⟳"),
		h("button", { type: "button", className: "smem-icon-btn", title: "关闭（Esc）", onClick: () => { setOpen(false); } }, "✕"),
	),
	h("div", { className: "smem-sub" },
		h("span", { className: "smem-dot", "data-state": injectDotState }),
		h("span", null, injectDotText),
	),
),
h("div", { className: "smem-bar" },
							h("select", {
								className: "smem-select",
								value: viewKey,
								onChange: (event) => { setViewKey(event.target.value); void refresh(event.target.value); },
							},
								(snapshot !== null && Array.isArray(snapshot.workspaces) ? snapshot.workspaces : []).map((row) =>
									h("option", { key: String(row.key), value: String(row.key) }, workspaceLabel(row))),
								(snapshot !== null && Array.isArray(snapshot.workspaces) && snapshot.workspaces.some((row) => String(row.key) === viewKey)) || viewKey === ""
									? null
									: h("option", { value: viewKey }, viewKey),
							),
							h("label", { className: "smem-switch" },
								h("input", {
									type: "checkbox",
									checked: snapshot !== null && snapshot.targetEnabled === true,
									disabled: busy || snapshot === null,
									onChange: (event) => { void mutate("setEnabled", { enabled: event.target.checked }); },
								}),
								"在本工作区注入",
							),
						),
						h("div", { className: "smem-bar" },
							h("input", {
								className: "smem-search",
								placeholder: "搜索本工作区的记忆…",
								value: query,
								onChange: (event) => { setQuery(event.target.value); },
							}),
							h("button", {
								type: "button",
								className: "smem-btn smem-btn-primary",
								disabled: busy,
								onClick: () => { setComposing(true); setEditingId(""); setDraftText(""); setDraftTags(""); setDraftSummary(""); },
							}, "+ 新增"),
						),
						h("div", { className: "smem-status" },
							h("span", { className: "smem-pill", "data-state": embedder.state }, embedder.state === "ready" ? "向量就绪" : "模型 " + embedderLabel),
							h("span", { className: "smem-pill" }, "浅层 " + String(counts.shallow) + "/" + String(entries.length) + " · 深层 " + String(counts.chunks) + " 块"),
							pendingCount > 0 ? h("span", { className: "smem-pill", "data-state": "loading" }, "待总结 " + String(pendingCount)) : null,
							h("span", { className: "smem-spacer" }),
							h("select", { className: "smem-select", value: injectMode, disabled: busy || snapshot === null, onChange: (event) => { void mutate("setInjectMode", { mode: event.target.value }); } },
								h("option", { value: "index" }, "注入：索引"),
								h("option", { value: "full" }, "注入：全量"),
								h("option", { value: "off" }, "注入：关闭"),
							),
							h("button", { type: "button", className: "smem-btn", disabled: busy, onClick: () => { void doReindex(); } }, "重建索引"),
							h("button", { type: "button", className: "smem-btn", disabled: busy, onClick: () => { void doResummarize(); } }, "重新总结"),
							embedder.state === "ready" ? null : h("button", { type: "button", className: "smem-btn", disabled: busy, onClick: () => { void warmModel(); } }, "加载模型"),
						),
						progress === null ? null : h("div", null,
							h("div", { className: "smem-progress" },
								h("div", { className: "smem-progress-bar", style: { width: String(Math.max(4, Math.min(100, progress.pct))) + "%" } }),
							),
							h("div", { className: "smem-progress-text" }, progress.label),
						),
						h("div", { className: "smem-list" },
							editor,
							ordered.length === 0
								? h("div", { className: "smem-empty" },
									entries.length === 0
										? "这个工作区还没有任何记忆。可以让助手在对话里记下重要的事，也可以点上面的「+ 新增」手写一条。"
										: "没有匹配「" + query + "」的记忆。")
								: ordered.map(cardOf),
						),
						h("div", { className: "smem-foot" },
							h("div", { className: "smem-foot-row" },
								h("span", null, "共 " + String(entries.length) + " 条"),
								h("span", null, "·"),
								h("span", null, "注入预算"),
								h("input", {
									className: "smem-input",
									style: { width: "86px" },
									value: budget,
									onChange: (event) => { setBudget(event.target.value.replace(/[^0-9]/g, "")); },
								}),
								h("span", null, "字"),
								h("button", {
									type: "button",
									className: "smem-btn",
									disabled: busy,
									onClick: () => { void mutate("setBudget", { budgetChars: Number(budget) }); },
								}, "保存"),
								h("button", { type: "button", className: "smem-btn", disabled: busy, onClick: () => { void openPanel("preview"); } }, panelMode === "preview" ? "收起预览" : "预览注入"),
								h("button", { type: "button", className: "smem-btn", disabled: busy, onClick: () => { void openPanel("recall"); } }, panelMode === "recall" ? "收起检索" : "检索测试"),
								h("button", { type: "button", className: "smem-btn", disabled: busy, onClick: () => { void openPanel("file"); } }, panelMode === "file" ? "收起 Memory.md" : "Memory.md"),
								h("button", { type: "button", className: "smem-btn", disabled: busy, onClick: () => { void openPanel("import"); } }, panelMode === "import" ? "收起导入" : "导入会话"),
							),
							note === "" ? null : h("div", { className: "smem-note" }, note),
							panelMode === "preview" ? h("pre", { className: "smem-preview" }, previewText) : null,
							panelMode === "recall" ? h("div", { className: "smem-block" },
								h("div", { className: "smem-editor-row" },
									h("input", { className: "smem-input", style: { flex: 1 }, placeholder: "试一句话，看能从记忆里召回什么…", value: recallQuery, onChange: (event) => setRecallQuery(event.target.value), onKeyDown: (event) => { if (event.key === "Enter") { event.preventDefault(); void runRecallTest(); } } }),
									h("button", { type: "button", className: "smem-btn smem-btn-primary", disabled: busy, onClick: () => { void runRecallTest(); } }, "检索"),
									h("button", { type: "button", className: "smem-btn", onClick: () => { void openPanel("recall"); }, title: "收起检索面板" }, "收起 ✕"),
								),
								recallResult === null ? h("div", { className: "smem-note" }, "按语义检索（不是关键词匹配），不会改动任何数据。") : h("div", null,
									h("div", { className: "smem-note" }, recallResult.mode === "vector" ? "命中 " + String(recallResult.count) + " 条（模型：" + String(embedder.model) + "）" : String(recallResult.message || "")),
									(Array.isArray(recallResult.rows) ? recallResult.rows : []).map((row) => h("div", { key: String(row.id), className: "smem-card" },
										h("div", { className: "smem-summary" }, String(row.summary !== undefined && row.summary !== "" ? row.summary : row.text)),
										h("details", { className: "smem-deep" }, h("summary", null, "深层原文"), h("div", { className: "smem-text" }, String(row.text))),
										h("div", { className: "smem-meta" },
											h("span", { className: "smem-tag" }, "相似度 " + String(row.score)),
											h("span", { className: "smem-spacer" }),
											h("span", null, String(row.id)),
										),
									)),
								),
							) : null,
							panelMode === "file" ? h("div", { className: "smem-block" },
								h("div", { className: "smem-note" }, "路径：" + String(snapshot !== null && snapshot.memoryFile ? snapshot.memoryFile : "（未知）")),
								fileEditing ? h("div", null,
									h("textarea", { className: "smem-textarea", style: { minHeight: "180px" }, value: fileDraft, onChange: (event) => setFileDraft(event.target.value) }),
									h("div", { className: "smem-editor-row" },
										h("button", { type: "button", className: "smem-btn smem-btn-primary", disabled: busy, onClick: () => { void saveManual(); } }, "保存"),
										h("button", { type: "button", className: "smem-btn", disabled: busy, onClick: () => { setFileEditing(false); setFileDraft(fileText); } }, "取消"),
									),
								) : h("div", null,
									h("pre", { className: "smem-preview" }, fileText === "" ? "（还没有生成）" : fileText),
									h("div", { className: "smem-editor-row" },
										h("button", { type: "button", className: "smem-btn", disabled: busy || fileText === "", onClick: () => { setFileEditing(true); setFileDraft(fileText); } }, "编辑手记区块"),
									),
								),
							) : null,
							panelMode === "import" ? h("div", { className: "smem-block" },
								h("div", { className: "smem-editor-row" },
									h("button", { type: "button", className: "smem-btn", disabled: busy || importRunning, onClick: () => { void loadImport(); } }, "刷新"),
									h("button", {
										type: "button",
										className: "smem-btn",
										disabled: busy || importRunning || importSessions === null || importSessions.length === 0,
										onClick: () => {
											toggleAll((importSessions || []).filter((row) => !importImported.includes(row.id)).map((row) => row.id));
										},
									}, "全选未导"),
								),
								h("div", { className: "smem-note" }, "从这台机器的历史会话导入：每条记忆 = 你当时说的话 + 我的思考原文 + 用到的工具 + 结论。深层写原文（不过 LLM、不花 token），要点交给 AI 总结队列补。"),
								importSessions === null
										? h("div", { className: "smem-note" }, "读取会话列表中…")
										: importSessions.length === 0
											? h("div", { className: "smem-note" }, "这个工作区没有找到历史会话文件。")
											: h("div", { className: "smem-import-list" }, importSessions.map((row) => h("label", { key: row.id, className: "smem-import-row" },
												h("input", { type: "checkbox", checked: importPicked.includes(row.id), onChange: () => { togglePicked(row.id); } }),
												h("span", { className: "smem-import-id" }, String(row.id).replace(/^session-/, "").slice(0, 12)),
												h("span", { className: "smem-tag" }, String(Math.round(row.size / 1024)) + " KB"),
												h("span", { className: "smem-tag" }, String(row.segments) + " 条"),
												importImported.includes(row.id) ? h("span", { className: "smem-tag" }, "已导过") : null,
												h("button", { type: "button", className: "smem-btn smem-btn-ghost", disabled: busy, onClick: (event) => { event.preventDefault(); void previewImport(row.id); } }, "预览"),
											))),
								h("div", { className: "smem-editor-row" },
									h("select", { className: "smem-select", value: importDepth, onChange: (event) => { setImportDepth(event.target.value); } },
										h("option", { value: "full" }, "深层：完整思考 + 结论"),
										h("option", { value: "lean" }, "深层：只留结论"),
									),
									h("button", { type: "button", className: "smem-btn smem-btn-primary", disabled: busy || importRunning || importPicked.length === 0, onClick: () => { void startImport(); } }, "开始导入（已选 " + String(importPicked.length) + "）"),
								),
								importStatus !== null && (importStatus.running || importStatus.done > 0)
									? h("div", { className: "smem-note" }, importStatus.running
										? "导入中… 已完成 " + String(importStatus.done) + (importStatus.total > 0 ? " / " + String(importStatus.total) : " 条") + (importStatus.failed > 0 ? "，失败 " + String(importStatus.failed) : "")
										: "上次导入：" + String(importStatus.done) + " 条，失败 " + String(importStatus.failed) + " 条")
									: null,
								importPreview === null ? null : h("div", null,
									h("div", { className: "smem-note" }, "预览 " + String(importPreview.count) + " 条，合计 " + String(importPreview.items.reduce((sum, item) => sum + item.chars, 0)) + " 字（只显示前 3 条）"),
									importPreview.items.slice(0, 3).map((item, index) => h("pre", { key: "ip-" + String(index), className: "smem-preview" }, item.head)),
								),
							) : null,
							h("div", { className: "smem-note" }, "记忆按工作区隔离、跨会话共享；锁定后助手改不了也删不掉。要点由 AI 压缩，细节走 memory_recall 按需取。"),
						),
					)),
				]
				: null;

			return h(react.Fragment, null,
				h("button", {
					type: "button",
					className: "smem-trigger",
					"data-open": open ? "true" : "false",
					title: "工作区记忆（跨会话）",
					onClick: () => { setOpen((current) => !current); },
				},
					h("span", { "aria-hidden": "true" }, "🧠"),
					h("span", null, "记忆"),
					triggerBadge === "" || triggerBadge === "0" ? null : h("span", { className: "smem-trigger-badge" }, triggerBadge),
				),
				drawer,
			);
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
					MemoryPanel,
				));
				if (registration !== undefined && registration !== null && typeof registration.then === "function") await registration;
				report("clientReady", "slot conversation.session.header.utilities registered; ui " + UI_VERSION);
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

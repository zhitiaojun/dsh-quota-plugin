/**
 * dsh-quota-plugin — browser half.
 *
 * A standalone DSH client bundle: an always-visible quota read-out in the
 * composer dock, a click-open detail panel in the shell overlay, and a
 * configuration page on the Plugins page. It depends on nothing but React and
 * its own host routes under /plugins/dsh-quota/, so it keeps working when any
 * other plugin is uninstalled.
 */
window.__ModuleLoader__.load({
	id: "dsh-quota-plugin",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		const jsx = react_jsx_runtime.jsx;
		const jsxs = react_jsx_runtime.jsxs;
		const Fragment = react_jsx_runtime.Fragment;
		/** Stable browser-plugin name, also the bundle's plugins.bundle.config key. */
		const PLUGIN_NAME = "dsh-quota-plugin";
		/** Locale namespace owned by this bundle. */
		const NS = "dsh-quota";
		/** Host routes. Literal strings, not computed, so both halves can diff them. */
		const STATE_PATH = "/plugins/dsh-quota/state";
		const REFRESH_PATH = "/plugins/dsh-quota/refresh";
		const SOURCES_PATH = "/plugins/dsh-quota/sources";
		const KIND_WORKBUDDY = "workbuddy";
		const KIND_GOOGLE = "google";
		/** Prefix for every guarded contribution's degradation log. */
		const CONTRIBUTION_FAILED = "[dsh-quota-plugin] client contribution failed to load (the rest of the plugin is unaffected):";
		/** Disposer substituted when a deferred registration degraded: nothing to undo. */
		const NOOP_DISPOSER = () => {};

		//#region locale
		/** Simplified Chinese copy, the default when no locale service answers. */
		const zh = {
			panelTitle: "\u989d\u5ea6\u8be6\u60c5",
			close: "\u5173\u95ed",
			refreshing: "\u5237\u65b0\u4e2d\u2026",
			refreshOneName: "\u5237\u65b0 {name}",
			resetAt: "\u91cd\u7f6e {time}",
			readFailed: "\u8bfb\u53d6\u5931\u8d25\uff1a{message}",
			noSources: "\u5c1a\u672a\u914d\u7f6e\u4efb\u4f55\u6765\u6e90",
			noMetrics: "\u6682\u65e0\u6570\u636e",
			unknown: "\u672a\u77e5",
			rowAria: "\u989d\u5ea6\u8bfb\u6570\uff0c\u70b9\u51fb\u67e5\u770b\u8be6\u60c5",
			rowEmpty: "\u989d\u5ea6\u672a\u914d\u7f6e",
			settingsTitle: "\u989d\u5ea6\u6765\u6e90",
			settingsSummary: "\u6c47\u603b\u591a\u4e2a\u6765\u6e90\u7684\u5269\u4f59\u989d\u5ea6",
			displayName: "\u663e\u793a\u540d\u79f0",
			kind: "\u7c7b\u578b",
			apiKey: "API Key",
			baseUrl: "Base URL",
			token: "Token",
			addSource: "\u6dfb\u52a0\u6765\u6e90",
			deleteSource: "\u5220\u9664",
			save: "\u4fdd\u5b58",
			saving: "\u4fdd\u5b58\u4e2d\u2026",
			saved: "\u5df2\u4fdd\u5b58",
			configFailed: "\u4fdd\u5b58\u5931\u8d25\uff1a{message}",
			kindWorkbuddy: "WorkBuddy",
			kindGoogle: "Google"
		};
		/** English copy. */
		const en = {
			panelTitle: "Quota details",
			close: "Close",
			refreshing: "Refreshing\u2026",
			refreshOneName: "Refresh {name}",
			resetAt: "Resets {time}",
			readFailed: "Read failed: {message}",
			noSources: "No sources configured yet",
			noMetrics: "No data",
			unknown: "Unknown",
			rowAria: "Quota read-out, click for details",
			rowEmpty: "Quota not configured",
			settingsTitle: "Quota sources",
			settingsSummary: "Aggregate remaining quota across sources",
			displayName: "Display name",
			kind: "Type",
			apiKey: "API Key",
			baseUrl: "Base URL",
			token: "Token",
			addSource: "Add source",
			deleteSource: "Delete",
			save: "Save",
			saving: "Saving\u2026",
			saved: "Saved",
			configFailed: "Save failed: {message}",
			kindWorkbuddy: "WorkBuddy",
			kindGoogle: "Google"
		};
		/** Interpolate `{name}` placeholders; an unknown key renders as itself. */
		function interpolate(template, params) {
			if (typeof template !== "string") return "";
			if (params === void 0) return template;
			return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
		}
		/**
		* The translation function for this bundle.
		*
		* Uses the host's locale service when it is available, so the copy follows
		* the active UI language; otherwise it answers from the built-in Chinese
		* dictionary, which is the documented default. Read the service through
		* `ctx.locale`, never by walking the context object.
		*/
		function bindTranslator(ctx) {
			try {
				const locale = ctx === void 0 ? void 0 : ctx.locale;
				if (locale !== void 0 && typeof locale.bind === "function") return locale.bind(NS);
			} catch {
				// fall through to the local dictionary
			}
			return (key, params) => interpolate(zh[key], params);
		}
		//#endregion

		//#region wire documents
		/** Parse one status reply. Returns null when the body is not a status document. */
		function parseStateDocument(value) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
			if (!Array.isArray(value.sources)) return null;
			const sources = [];
			for (const entry of value.sources) {
				const source = normalizeSource(entry);
				if (source !== null) sources.push(source);
			}
			return {
				sources,
				updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null
			};
		}
		/** Accept one source, discarding anything the renderer cannot dereference. */
		function normalizeSource(value) {
			if (typeof value !== "object" || value === null) return null;
			if (typeof value.id !== "string" || value.id.length === 0) return null;
			const metrics = [];
			if (Array.isArray(value.metrics)) {
				for (const entry of value.metrics) {
					const metric = normalizeMetric(entry);
					if (metric !== null) metrics.push(metric);
				}
			}
			return {
				id: value.id,
				kind: value.kind === KIND_GOOGLE ? KIND_GOOGLE : KIND_WORKBUDDY,
				label: typeof value.label === "string" && value.label.length > 0 ? value.label : value.id,
				status: value.status === "error" ? "error" : value.status === "loading" ? "loading" : "ok",
				error: typeof value.error === "string" && value.error.length > 0 ? value.error : null,
				refreshedAt: typeof value.refreshedAt === "string" ? value.refreshedAt : null,
				metrics
			};
		}
		/** Accept one metric. `percent: null` means "unknown", never "zero". */
		function normalizeMetric(value) {
			if (typeof value !== "object" || value === null) return null;
			if (typeof value.key !== "string" || value.key.length === 0) return null;
			const metric = {
				key: value.key,
				label: typeof value.label === "string" && value.label.length > 0 ? value.label : value.key,
				percent: typeof value.percent === "number" && Number.isFinite(value.percent) ? value.percent : null
			};
			if (typeof value.remaining === "number" && Number.isFinite(value.remaining)) metric.remaining = value.remaining;
			if (typeof value.total === "number" && Number.isFinite(value.total)) metric.total = value.total;
			if (typeof value.resetTime === "string" && value.resetTime.length > 0) metric.resetTime = value.resetTime;
			return metric;
		}
		/** Parse one sources reply. Returns null when the body is not a sources document. */
		function parseSourcesDocument(value) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
			if (!Array.isArray(value.sources)) return null;
			const sources = [];
			for (const entry of value.sources) {
				if (typeof entry !== "object" || entry === null) continue;
				if (typeof entry.id !== "string" || entry.id.length === 0) continue;
				const kind = entry.kind === KIND_GOOGLE ? KIND_GOOGLE : KIND_WORKBUDDY;
				const item = {
					id: entry.id,
					kind,
					label: typeof entry.label === "string" ? entry.label : entry.id
				};
				if (kind === KIND_WORKBUDDY) {
					if (typeof entry.apiKey === "string") item.apiKey = entry.apiKey;
				} else {
					if (typeof entry.baseUrl === "string") item.baseUrl = entry.baseUrl;
					if (typeof entry.token === "string") item.token = entry.token;
				}
				sources.push(item);
			}
			return sources;
		}
		/** A fresh blank source whose id does not collide with the current list. */
		function blankSource(sources) {
			let highest = 0;
			for (const item of sources) {
				const match = /(\d+)$/.exec(typeof item.id === "string" ? item.id : "");
				if (match !== null) highest = Math.max(highest, Number(match[1]));
			}
			return {
				id: `source-${highest + 1}`,
				kind: KIND_WORKBUDDY,
				label: "",
				apiKey: ""
			};
		}
		//#endregion

		//#region store
		/**
		* The bundle's one observable state holder.
		*
		* Both surfaces read the same snapshot so the dock line and the detail panel
		* can never disagree, and a failed request keeps the previous document on
		* screen with the failure beside it rather than blanking the read-out.
		*/
		function createQuotaStore() {
			const listeners = new Set();
			let disposed = false;
			let loadSequence = 0;
			let refreshSequence = 0;
			let configSequence = 0;
			let state = {
				sources: [],
				updatedAt: null,
				readError: null,
				loading: 0,
				loadingIds: [],
				open: false,
				/**
				* Viewport rect of the row that opened the panel, so the panel can sit
				* next to the control the user actually clicked instead of being pinned
				* to a corner. `anchorEl` is kept so a window resize can re-measure.
				*/
				anchor: null,
				anchorEl: null,
				config: null,
				configLoaded: false,
				configLoading: false,
				configError: null,
				saving: false,
				savedAt: 0
			};
			function getSnapshot() {
				return state;
			}
			function subscribe(listener) {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			}
			function emit(patch) {
				if (disposed) return;
				state = Object.assign({}, state, patch);
				for (const listener of Array.from(listeners)) listener();
			}
			function describeError(error) {
				return error instanceof Error && error.message.length > 0 ? error.message : String(error);
			}
			/** One JSON round trip. A non-2xx status is a failure, whatever the body says. */
			async function call(pathname, init) {
				const request = {
					method: init.method,
					credentials: "same-origin",
					headers: { accept: "application/json" }
				};
				if (init.body !== void 0) {
					request.headers["Content-Type"] = "application/json";
					request.body = init.body;
				}
				const response = await fetch(pathname, request);
				const value = await response.json().catch(() => void 0);
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				return value;
			}
			/**
			* Measure an element's viewport rect, defensively.
			*
			* `getBoundingClientRect` is missing in the DOM-free test harness, so a
			* missing or failing implementation yields `null` and the panel falls back
			* to a fixed placement rather than throwing.
			*/
			function measureElement(element) {
				if (element === null || element === void 0) return null;
				if (typeof element.getBoundingClientRect !== "function") return null;
				try {
					const rect = element.getBoundingClientRect();
					if (rect === null || typeof rect !== "object") return null;
					const values = [rect.top, rect.bottom, rect.left, rect.right];
					if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) return null;
					return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height };
				} catch (error) {
					return null;
				}
			}
			/** Open or close the panel, remembering the anchor it was opened from. */
			function setOpen(open, element) {
				const next = open === true;
				if (next) {
					const rect = measureElement(element);
					if (state.open !== next || rect !== state.anchor) {
						emit({ open: true, anchor: rect, anchorEl: element ?? null });
					}
					return;
				}
				if (state.open !== false) emit({ open: false, anchor: null, anchorEl: null });
			}
			/** Re-measure the remembered anchor, e.g. after a resize or a scroll. */
			function reanchor() {
				if (!state.open || state.anchorEl === null) return;
				const rect = measureElement(state.anchorEl);
				if (rect !== null && rect !== state.anchor) emit({ anchor: rect });
			}
			/** Read the aggregated state. Keeps the last good document on failure. */
			async function load() {
				if (disposed) return;
				const sequence = ++loadSequence;
				emit({ loading: state.loading + 1 });
				try {
					const parsed = parseStateDocument(await call(STATE_PATH, { method: "GET" }));
					if (parsed === null) throw new Error("unreadable state reply");
					if (disposed || sequence !== loadSequence) return;
					emit({ sources: parsed.sources, updatedAt: parsed.updatedAt, readError: null });
				} catch (error) {
					if (!disposed && sequence === loadSequence) emit({ readError: describeError(error) });
				} finally {
					if (!disposed) emit({ loading: Math.max(0, state.loading - 1) });
				}
			}
			/**
			* Refresh ONE source when `sourceId` is a non-empty string, otherwise every
			* source. The single-source body carries that id and nothing else, which is
			* what keeps one card's button from spending the other sources' requests.
			*/
			async function refresh(sourceId) {
				if (disposed) return;
				const single = typeof sourceId === "string" && sourceId.length > 0;
				const sequence = ++refreshSequence;
				emit({
					loading: state.loading + 1,
					loadingIds: single ? state.loadingIds.concat([sourceId]) : state.loadingIds
				});
				try {
					const body = JSON.stringify(single ? { sourceId } : {});
					const parsed = parseStateDocument(await call(REFRESH_PATH, { method: "POST", body }));
					if (parsed === null) throw new Error("unreadable refresh reply");
					if (disposed || sequence !== refreshSequence) return;
					emit({ sources: parsed.sources, updatedAt: parsed.updatedAt, readError: null });
				} catch (error) {
					if (!disposed && sequence === refreshSequence) emit({ readError: describeError(error) });
				} finally {
					if (!disposed) {
						emit({
							loading: Math.max(0, state.loading - 1),
							loadingIds: single ? state.loadingIds.filter((id) => id !== sourceId) : state.loadingIds
						});
					}
				}
			}
			/** Read the configured sources once; the page then edits a local draft. */
			async function loadConfig() {
				if (disposed || state.configLoaded) return;
				const sequence = ++configSequence;
				emit({ configLoading: true });
				try {
					const parsed = parseSourcesDocument(await call(SOURCES_PATH, { method: "GET" }));
					if (parsed === null) throw new Error("unreadable sources reply");
					if (disposed || sequence !== configSequence) return;
					emit({ config: parsed, configLoaded: true, configError: null });
				} catch (error) {
					if (!disposed && sequence === configSequence) emit({ configLoaded: true, configError: describeError(error) });
				} finally {
					if (!disposed) emit({ configLoading: false });
				}
			}
			/** Write the whole list. Returns whether the host accepted it. */
			async function saveConfig(sources) {
				if (disposed) return false;
				const sequence = ++configSequence;
				emit({ saving: true });
				try {
					const body = JSON.stringify({ sources });
					const parsed = parseSourcesDocument(await call(SOURCES_PATH, { method: "PUT", body }));
					if (parsed === null) throw new Error("unreadable sources reply");
					if (disposed || sequence !== configSequence) return false;
					emit({ config: parsed, configError: null, saving: false, savedAt: Date.now() });
					return true;
				} catch (error) {
					if (!disposed && sequence === configSequence) emit({ saving: false, configError: describeError(error) });
					return false;
				}
			}
			function dispose() {
				disposed = true;
				listeners.clear();
			}
			return {
				getSnapshot,
				subscribe,
				setOpen,
				reanchor,
				load,
				refresh,
				loadConfig,
				saveConfig,
				dispose
			};
		}
		//#endregion

		//#region formatting
		function formatNumber(value) {
			try {
				return new Intl.NumberFormat(void 0).format(value);
			} catch {
				return String(value);
			}
		}
		/** `98%`, `99.5%` — at most one decimal, no trailing `.0`. */
		function formatPercent(percent) {
			const clamped = Math.max(0, Math.min(100, percent));
			return `${Math.round(clamped * 10) / 10}%`;
		}
		/**
		* Format an ISO timestamp compactly: `10-15 09:29`.
		*
		* Deliberately short. A full medium date ("2026\u5e7410\u670815\u65e5 09:29")
		* dominates the panel and is mostly noise — the year and the seconds are
		* never what the reader is deciding on. Anything unparseable is shown
		* verbatim so a raw upstream string is never lost.
		*/
		function formatTime(value) {
			if (typeof value !== "string" || value.length === 0) return "";
			const parsed = Date.parse(value);
			if (Number.isNaN(parsed)) return value;
			const date = new Date(parsed);
			try {
				return new Intl.DateTimeFormat(void 0, {
					month: "2-digit",
					day: "2-digit",
					hour: "2-digit",
					minute: "2-digit",
					hour12: false
				}).format(date);
			} catch {
				const pad = (n) => String(n).padStart(2, "0");
				return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
			}
		}
		/** Colour threshold name: >50% neutral, 20-50% amber, <20% red. */
		function barColorName(percent) {
			if (typeof percent !== "number" || !Number.isFinite(percent)) return "unknown";
			if (percent < 20) return "red";
			if (percent <= 50) return "amber";
			return "neutral";
		}
		function barColorValue(name) {
			if (name === "red") return "var(--dsw-alias-state-error-primary, #d92d20)";
			if (name === "amber") return "var(--dsw-alias-state-warning-primary, #d29922)";
			return "var(--dsw-alias-brand-primary, #1677ff)";
		}
		/** `周98%` — one metric in the compact dock token. */
		function compactMetricToken(metric) {
			if (metric.percent === null) return metric.label;
			return `${metric.label}${formatPercent(metric.percent)}`;
		}
		/**
		* One source's compact token for the always-visible line: Google shows its
		* two most relevant buckets, WorkBuddy shows the remaining credit number, and
		* a failed source shows a short marker instead of an empty gap.
		*/
		function compactSourceToken(source) {
			if (source.status === "error") return `${source.label} \u26a0`;
			if (source.kind === KIND_WORKBUDDY) {
				const credit = source.metrics.find((metric) => typeof metric.remaining === "number");
				return credit === void 0 ? source.label : `${source.label} ${formatNumber(credit.remaining)}`;
			}
			const tokens = source.metrics.slice(0, 2).map(compactMetricToken);
			return tokens.length === 0 ? source.label : `${source.label} ${tokens.join(" ")}`;
		}
		//#endregion

		//#region styles
		const bodyStyle = {
			margin: 0,
			fontSize: 13,
			lineHeight: "20px",
			color: "var(--dsw-alias-label-secondary)"
		};
		const metaStyle = {
			margin: 0,
			fontSize: 12,
			lineHeight: "18px",
			color: "var(--dsw-alias-label-tertiary)"
		};
		const errorStyle = Object.assign({}, bodyStyle, {
			color: "var(--dsw-alias-state-error-primary, #d92d20)"
		});
		const buttonStyle = {
			boxSizing: "border-box",
			minHeight: 28,
			padding: "4px 12px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 14,
			background: "var(--dsw-alias-bg-layer-1)",
			color: "var(--dsw-alias-label-primary)",
			font: "inherit",
			fontSize: 13,
			cursor: "pointer"
		};
		const rowStyle = {
			boxSizing: "border-box",
			display: "flex",
			alignItems: "center",
			gap: 6,
			minWidth: 0,
			maxWidth: "100%",
			overflow: "hidden",
			whiteSpace: "nowrap",
			textOverflow: "ellipsis",
			border: 0,
			padding: "1px 8px",
			borderRadius: 999,
			background: "transparent",
			color: "var(--dsw-alias-label-tertiary)",
			font: "inherit",
			fontSize: 12,
			fontVariantNumeric: "tabular-nums",
			lineHeight: "18px",
			cursor: "pointer"
		};
		/**
		* The overlay is a transparent, click-through full-viewport layer; only the
		* panel itself takes pointer events. It anchors near the row rather than in a
		* corner, so the panel appears where the user clicked.
		*/
		const overlayStyle = {
			position: "fixed",
			inset: 0,
			zIndex: 60,
			pointerEvents: "none"
		};
		const PANEL_WIDTH = 230;
		const PANEL_MARGIN = 10;
		const PANEL_GAP = 8;

		/**
		* Place the panel next to the anchor rect.
		*
		* Preference order: above the anchor (the row sits at the bottom of the
		* window, so above almost always fits), then below, then clamped into the
		* viewport. Horizontally it aligns to the anchor's left edge and is pulled
		* back inside the viewport. A missing anchor or a DOM-free context degrades
		* to a centred panel rather than throwing.
		*/
		function anchoredPanelStyle(anchor) {
			const base = {
				pointerEvents: "auto",
				boxSizing: "border-box",
				width: PANEL_WIDTH,
				minWidth: 200,
				maxWidth: "100%",
				maxHeight: "70vh",
				overflowY: "auto",
				display: "flex",
				flexDirection: "column",
				gap: 10,
				padding: "12px 14px 14px",
				border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: 12,
				background: "var(--dsw-alias-bg-module-platform, var(--dsw-alias-bg-layer-1))",
				boxShadow: "var(--dsw-elevation-panel, 0 8px 24px rgba(0, 0, 0, 0.18))",
				position: "fixed"
			};
			if (anchor === null || anchor === void 0) {
				// No measurement available: centre it so it is at least reachable.
				return Object.assign({}, base, { left: "50%", top: "50%", transform: "translate(-50%, -50%)" });
			}
			const hasViewport =
				typeof window !== "undefined" &&
				typeof window.innerWidth === "number" &&
				typeof window.innerHeight === "number";
			const viewportWidth = hasViewport ? window.innerWidth : PANEL_WIDTH + PANEL_MARGIN * 2;
			const viewportHeight = hasViewport ? window.innerHeight : 800;

			// Vertical: prefer above the anchor, else below, then clamp.
			const spaceAbove = anchor.top - PANEL_GAP;
			const spaceBelow = viewportHeight - anchor.bottom - PANEL_GAP;
			const placeAbove = spaceAbove >= Math.min(320, spaceBelow) || spaceAbove >= spaceBelow;
			let top;
			let bottom;
			if (placeAbove) {
				bottom = Math.max(PANEL_MARGIN, viewportHeight - anchor.top + PANEL_GAP);
			} else {
				top = Math.min(viewportHeight - PANEL_MARGIN, anchor.bottom + PANEL_GAP);
			}

			// Horizontal: align left edges, then keep it inside the viewport.
			const maxLeft = Math.max(PANEL_MARGIN, viewportWidth - PANEL_WIDTH - PANEL_MARGIN);
			const left = Math.min(Math.max(anchor.left, PANEL_MARGIN), maxLeft);

			const placement = Object.assign({}, base, { left });
			if (placeAbove) placement.bottom = bottom;
			else placement.top = top;
			return placement;
		}
		const panelHeadStyle = {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: 8
		};
		const titleStyle = {
			minWidth: 0,
			fontSize: 13,
			fontWeight: 600,
			color: "var(--dsw-alias-label-primary)"
		};
		/** Compact icon buttons: a text button per row cost more width than the data. */
		const iconButtonStyle = {
			flex: "0 0 auto",
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			width: 22,
			height: 22,
			padding: 0,
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 6,
			background: "transparent",
			color: "var(--dsw-alias-label-secondary)",
			font: "inherit",
			fontSize: 13,
			lineHeight: 1,
			cursor: "pointer"
		};
		const closeButtonStyle = {
			flex: "0 0 auto",
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			width: 22,
			height: 22,
			padding: 0,
			border: "none",
			borderRadius: 6,
			background: "transparent",
			color: "var(--dsw-alias-label-tertiary)",
			font: "inherit",
			fontSize: 18,
			lineHeight: 1,
			cursor: "pointer"
		};
		/** The list of source cards. Tight gaps: this is a status popover, not a page. */
		const cardsStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 10
		};
		const cardStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 6
		};
		const cardHeadStyle = {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: 8
		};
		const cardNameStyle = {
			minWidth: 0,
			overflow: "hidden",
			textOverflow: "ellipsis",
			whiteSpace: "nowrap",
			fontSize: 12,
			fontWeight: 600,
			color: "var(--dsw-alias-label-primary)"
		};
		const metricStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 6
		};
		const metricHeadStyle = {
			display: "flex",
			alignItems: "baseline",
			justifyContent: "space-between",
			gap: 10,
			fontSize: 12,
			lineHeight: "16px",
			color: "var(--dsw-alias-label-secondary)"
		};
		const metricLabelStyle = {
			minWidth: 0,
			overflow: "hidden",
			textOverflow: "ellipsis",
			whiteSpace: "nowrap"
		};
		/** The percentage is the one figure the eye goes to, so it keeps its own slot. */
		const metricPercentStyle = {
			flex: "0 0 auto",
			fontVariantNumeric: "tabular-nums",
			color: "var(--dsw-alias-label-primary)"
		};
		/** Reset times sit on a quiet line of their own at this panel width. */
		const resetLineStyle = {
			fontSize: 11,
			lineHeight: "14px",
			color: "var(--dsw-alias-label-tertiary)"
		};
		const trackStyle = {
			height: 8,
			overflow: "hidden",
			borderRadius: 999,
			background: "var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.08))"
		};
		const fieldStyle = {
			display: "flex",
			alignItems: "center",
			gap: 10
		};
		const labelStyle = {
			flex: "0 0 96px",
			fontSize: 13,
			color: "var(--dsw-alias-label-secondary)"
		};
		const inputStyle = {
			boxSizing: "border-box",
			flex: "1 1 auto",
			minWidth: 0,
			height: 30,
			padding: "0 10px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 8,
			background: "var(--dsw-alias-bg-layer-1)",
			color: "var(--dsw-alias-label-primary)",
			font: "inherit",
			fontSize: 13
		};
		const actionRowStyle = {
			display: "flex",
			justifyContent: "flex-end",
			gap: 8
		};
		/** The unfilled remainder keeps the threshold colour visible under the fill. */
		function fillStyle(percent, color) {
			return {
				width: `${Math.max(0, Math.min(100, percent))}%`,
				height: "100%",
				borderRadius: "inherit",
				background: color
			};
		}
		//#endregion

		//#region components
		/** One metric as a labelled progress bar plus its percentage and reset time. */
		function MetricBar(props) {
			const metric = props.metric;
			const t = props.t;
			const percent = metric.percent;
			const color = barColorName(percent);
			const amount = typeof metric.remaining === "number" && typeof metric.total === "number" ? `${formatNumber(metric.remaining)} / ${formatNumber(metric.total)}` : null;
			return jsxs("div", {
				style: metricStyle,
				"data-dsh-quota": "metric",
				"data-dsh-quota-metric": metric.key,
				children: [
					jsxs("div", {
						style: metricHeadStyle,
						children: [
							jsx("span", {
								style: metricLabelStyle,
								title: amount === null ? metric.label : `${metric.label} \u00b7 ${amount}`,
								children: amount === null ? metric.label : `${metric.label} \u00b7 ${amount}`
							}),
							jsx("span", {
								style: metricPercentStyle,
								"data-dsh-quota-percent": "",
								children: percent === null ? t("unknown") : formatPercent(percent)
							})
						]
					}),
					jsx("div", {
						style: trackStyle,
						role: "progressbar",
						"aria-label": metric.label,
						"data-dsh-quota-color": color,
						...percent === null ? { "aria-valuetext": t("unknown") } : {
							"aria-valuemin": 0,
							"aria-valuemax": 100,
							"aria-valuenow": percent
						},
						children: percent === null ? null : jsx("div", {
							style: fillStyle(percent, barColorValue(color)),
							"data-dsh-quota-fill": ""
						})
					}),
					// The reset time gets its own quiet line. At half width it cannot
					// share a row with the amount and the percentage without one of the
					// three being truncated, and the reset time is the one that matters
					// least often.
					metric.resetTime === void 0 ? null : jsx("div", {
						style: resetLineStyle,
						"data-dsh-quota-reset": "",
						children: t("resetAt", { time: formatTime(metric.resetTime) })
					})
				]
			});
		}
		/** One source: its display name, a compact refresh control, its metrics. */
		function SourceCard(props) {
			const source = props.source;
			const busy = props.busy;
			const t = props.t;
			return jsxs("div", {
				style: cardStyle,
				"data-dsh-quota": "card",
				"data-dsh-quota-source": source.id,
				children: [
					jsxs("div", {
						style: cardHeadStyle,
						children: [
							jsx("span", {
								style: cardNameStyle,
								title: source.label,
								children: source.label
							}),
							jsx("button", {
								type: "button",
								style: iconButtonStyle,
								disabled: busy,
								"data-dsh-quota-refresh": source.id,
								"aria-label": t("refreshOneName", { name: source.label }),
								title: busy ? t("refreshing") : t("refreshOneName", { name: source.label }),
								onClick: () => {
									props.onRefresh(source.id);
								},
								children: busy ? "\u22ef" : "\u21bb"
							})
						]
					}),
					source.status === "error" && source.error !== null ? jsx("p", {
						style: errorStyle,
						"data-dsh-quota-error": source.id,
						children: source.error
					}) : null,
					// "No data" is only worth saying when nothing else explains the gap.
					// An errored source already printed its reason above.
					source.metrics.length !== 0 ? jsx("div", {
						style: metricStyle,
						children: source.metrics.map((metric) => jsx(MetricBar, { metric, t }, metric.key))
					}) : source.status === "error" ? null : jsx("p", { style: bodyStyle, children: t("noMetrics") })
				]
			});
		}
		/**
		* The most recently mounted row element.
		*
		* There is exactly one read-out in the composer, so a single slot is
		* sufficient and avoids depending on `useRef` being present in every
		* rendering context (the DOM-free test harness has no real refs).
		*/
		const rowElementRef = { value: null };

		/**
		* The always-visible read-out in `conversation.composer.dock`.
		*
		* Text only and one line tall: DSH's own stats bar shares this flex row, so a
		* chart or a wrapping block here would push that bar off screen. A failed
		* source renders a marker, never a gap, and the whole line grows a trailing
		* ellipsis while any refresh is in flight.
		*/
		function QuotaRow(props) {
			const store = props.store;
			const t = props.t;
			const snapshot = react.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
			react.useEffect(() => {
				store.load();
			}, [store]);
			const tokens = snapshot.sources.map(compactSourceToken);
			const line = tokens.length === 0 ? t("rowEmpty") : tokens.join(" \u00b7 ");
			const busy = snapshot.loading > 0;
			/**
			* The click target is this button; its rect is what the panel anchors to.
			* `currentTarget` is preferred over `target` so a click landing on an inner
			* node still anchors to the whole row.
			*/
			const onClick = (event) => {
				const element =
					event !== null && event !== void 0 && event.currentTarget !== void 0 && event.currentTarget !== null
						? event.currentTarget
						: rowElementRef.value;
				store.setOpen(!snapshot.open, element);
			};
			return jsx("button", {
				type: "button",
				ref: (element) => {
					rowElementRef.value = element ?? null;
				},
				style: rowStyle,
				title: line,
				"data-dsh-quota": "row",
				"aria-expanded": snapshot.open,
				"aria-label": t("rowAria"),
				onClick,
				children: busy ? `${line} \u2026` : line
			});
		}
		/**
		* The detail panel in `shell.overlay`.
		*
		* Deliberately a separate slot from the row: the overlay is the documented
		* seat for a surface that floats over the whole app, and it keeps the panel
		* out of the composer's flex row. Both surfaces share one store, so the row's
		* click is the panel's open state.
		*/
		function QuotaPanel(props) {
			const store = props.store;
			const t = props.t;
			const snapshot = react.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
			const open = snapshot.open;
			/**
			* Close on an outside interaction.
			*
			* The overlay is click-through (`pointerEvents: none`), so it cannot catch
			* the click itself; a document-level listener is what implements "click
			* anywhere else to dismiss". The click that OPENED the panel needs no
			* special handling: its `pointerdown`/`mousedown` already fired before this
			* effect could run, and a press on the row is filtered out by `closest`
			* anyway.
			*/
			react.useEffect(() => {
				if (!open) return void 0;
				if (typeof document === "undefined" || typeof document.addEventListener !== "function") return void 0;
				const inside = (node) => {
					if (node === null || node === void 0 || typeof node !== "object") return false;
					if (typeof node.closest !== "function") return false;
					try {
						return node.closest("[data-dsh-quota='panel'], [data-dsh-quota='row']") !== null;
					} catch {
						return false;
					}
				};
				const onPointerDown = (event) => {
					if (inside(event === null || event === void 0 ? void 0 : event.target)) return;
					store.setOpen(false);
				};
				document.addEventListener("pointerdown", onPointerDown, true);
				document.addEventListener("mousedown", onPointerDown, true);
				return () => {
					document.removeEventListener("pointerdown", onPointerDown, true);
					document.removeEventListener("mousedown", onPointerDown, true);
				};
			}, [store, open]);
			react.useEffect(() => {
				if (!open) return void 0;
				if (typeof window === "undefined" || typeof window.addEventListener !== "function") return void 0;
				const onKeyDown = (event) => {
					if (event !== null && event.key === "Escape") store.setOpen(false);
				};
				// Keep the panel beside the row when the window changes size.
				const onReflow = () => store.reanchor();
				window.addEventListener("keydown", onKeyDown);
				window.addEventListener("resize", onReflow);
				window.addEventListener("scroll", onReflow, true);
				return () => {
					window.removeEventListener("keydown", onKeyDown);
					window.removeEventListener("resize", onReflow);
					window.removeEventListener("scroll", onReflow, true);
				};
			}, [store, open]);
			if (!open) return null;
			return jsx("div", {
				style: overlayStyle,
				"data-dsh-quota": "overlay",
				children: jsxs("div", {
					style: anchoredPanelStyle(snapshot.anchor),
					role: "dialog",
					"aria-modal": false,
					"aria-label": t("panelTitle"),
					"data-dsh-quota": "panel",
					children: [
						jsxs("div", {
							style: panelHeadStyle,
							children: [
								jsx("span", {
									style: titleStyle,
									children: t("panelTitle")
								}),
								jsx("button", {
									type: "button",
									style: closeButtonStyle,
									"data-dsh-quota-close": "",
									"aria-label": t("close"),
									title: t("close"),
									onClick: () => {
										store.setOpen(false);
									},
									children: "\u00d7"
								})
							]
						}),
						snapshot.readError === null ? null : jsx("p", {
							style: errorStyle,
							"data-dsh-quota-read-error": "",
							children: t("readFailed", { message: snapshot.readError })
						}),
						snapshot.sources.length === 0 ? jsx("p", {
							style: bodyStyle,
							"data-dsh-quota-empty": "",
							children: t("noSources")
						}) : jsx("div", {
							style: cardsStyle,
							children: snapshot.sources.map((source) => jsx(SourceCard, {
								source,
								t,
								busy: snapshot.loadingIds.includes(source.id),
								onRefresh: (id) => {
									store.refresh(id);
								}
							}, source.id))
						})
					]
				})
			});
		}
		/** One editable source row on the configuration page. Hook-free; the page owns the draft. */
		function ConfigSourceRow(props) {
			const item = props.item;
			const t = props.t;
			/**
			* One label + text input. The `key` is the jsx key argument, NOT a prop:
			* React's dev runtime warns about a `key` inside a props object, and the
			* element would end up unkeyed in the google variant's field array.
			*/
			const textField = (label, attribute, field, value, jsxKey) => jsxs("div", {
				style: fieldStyle,
				children: [
					jsx("span", { style: labelStyle, children: label }),
					jsx("input", {
						type: "text",
						style: inputStyle,
						[attribute]: item.id,
						value: value === void 0 ? "" : value,
						onChange: (event) => {
							props.onChange(item.id, { [field]: event.currentTarget.value });
						}
					})
				]
			}, jsxKey);
			return jsxs("div", {
				style: cardStyle,
				"data-dsh-quota": "config-row",
				"data-dsh-quota-config": item.id,
				children: [
					textField(t("displayName"), "data-dsh-quota-name", "label", item.label, "label"),
					jsxs("div", {
						style: fieldStyle,
						children: [
							jsx("span", { style: labelStyle, children: t("kind") }),
							jsx("select", {
								style: inputStyle,
								"data-dsh-quota-kind": item.id,
								value: item.kind,
								onChange: (event) => {
									props.onChange(item.id, { kind: event.currentTarget.value });
								},
								children: [
									jsx("option", { value: KIND_WORKBUDDY, children: t("kindWorkbuddy") }, KIND_WORKBUDDY),
									jsx("option", { value: KIND_GOOGLE, children: t("kindGoogle") }, KIND_GOOGLE)
								]
							})
						]
					}, "kind"),
					item.kind === KIND_WORKBUDDY ? textField(t("apiKey"), "data-dsh-quota-apikey", "apiKey", item.apiKey, "apiKey") : null,
					item.kind === KIND_GOOGLE ? [
						textField(t("baseUrl"), "data-dsh-quota-baseurl", "baseUrl", item.baseUrl, "baseUrl"),
						textField(t("token"), "data-dsh-quota-token", "token", item.token, "token")
					] : null,
					jsx("div", {
						style: actionRowStyle,
						children: jsx("button", {
							type: "button",
							style: buttonStyle,
							"data-dsh-quota-delete": item.id,
							onClick: () => {
								props.onDelete(item.id);
							},
							children: t("deleteSource")
						})
					}, "actions")
				]
			});
		}
		/**
		* The bundle's configuration page in `plugins.bundle.config`.
		*
		* The draft is local and starts from the host's list, so leaving the page
		* discards staged edits; only Save writes. Names come from the user, never
		* from a hard-coded table.
		*/
		function QuotaConfigPage(props) {
			const store = props.store;
			const t = props.t;
			const snapshot = react.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
			react.useEffect(() => {
				store.loadConfig();
			}, [store]);
			const [draft, setDraft] = react.useState(null);
			if (props.view === "summary") return jsx("span", { children: t("settingsSummary") });
			const saved = snapshot.config === null ? [] : snapshot.config;
			const sources = draft === null ? saved : draft;
			const change = (id, patch) => {
				setDraft(sources.map((item) => (item.id === id ? Object.assign({}, item, patch) : item)));
			};
			const remove = (id) => {
				setDraft(sources.filter((item) => item.id !== id));
			};
			const add = () => {
				setDraft(sources.concat([blankSource(sources)]));
			};
			const save = () => {
				store.saveConfig(sources).then((accepted) => {
					if (accepted) setDraft(null);
				});
			};
			return jsxs("div", {
				style: cardStyle,
				"data-dsh-quota": "config-page",
				children: [
					jsx("div", {
						style: titleStyle,
						children: t("settingsTitle")
					}),
					snapshot.configError === null ? null : jsx("p", {
						style: errorStyle,
						"data-dsh-quota-config-error": "",
						children: t("configFailed", { message: snapshot.configError })
					}),
					snapshot.configLoading && sources.length === 0 ? jsx("p", { style: bodyStyle, children: t("refreshing") }) : null,
					sources.length === 0 ? jsx("p", {
						style: bodyStyle,
						"data-dsh-quota-config-empty": "",
						children: t("noSources")
					}) : sources.map((item) => jsx(ConfigSourceRow, {
						item,
						t,
						onChange: change,
						onDelete: remove
					}, item.id)),
					jsxs("div", {
						style: actionRowStyle,
						children: [
							snapshot.savedAt > 0 ? jsx("span", {
								style: metaStyle,
								"data-dsh-quota-saved": "",
								children: t("saved")
							}) : null,
							jsx("button", {
								type: "button",
								style: buttonStyle,
								"data-dsh-quota-add": "",
								onClick: add,
								children: t("addSource")
							}),
							jsx("button", {
								type: "button",
								style: buttonStyle,
								disabled: snapshot.saving,
								"data-dsh-quota-save": "",
								onClick: save,
								children: snapshot.saving ? t("saving") : t("save")
							})
						]
					})
				]
			});
		}
		//#endregion

		//#region plugin
		/**
		* Run ONE browser-side contribution, degrading its failure to a
		* `console.error` instead of throwing into the DSH loader.
		*
		* Every contribution is guarded at both boundaries where it can throw: the
		* eager `ctx.slots.inject(...)` call inside `apply()`, and the deferred
		* callback the slot runtime invokes later, once the declaring package
		* commits the slot. A broken settings seam must not take the read-out with
		* it, and vice versa.
		*/
		function guardClientContribution(label, fn) {
			try {
				return fn();
			} catch (error) {
				console.error(`${CONTRIBUTION_FAILED} ${label}`, error);
				return void 0;
			}
		}
		/** Register one guarded slot entry, substituting a no-op disposer on failure. */
		function registerSlot(ctx, label, options, component) {
			guardClientContribution(label, () => {
				ctx.slots.inject(options.name, () => guardClientContribution(label, () => ctx.slots.register(options, component)) ?? NOOP_DISPOSER);
			});
		}
		/**
		* Mount the read-out, the detail panel and the configuration page.
		*
		* `inject` names the services actually read here: `slots` for the three
		* registrations and `locale` for the dictionary and the bound translator.
		*/
		function apply(ctx) {
			const t = bindTranslator(ctx);
			guardClientContribution("locale dictionary", () => {
				if (ctx === void 0 || ctx.locale === void 0 || typeof ctx.locale.register !== "function") return;
				if (typeof ctx.effect === "function") {
					ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-quota-plugin: locale dictionary");
					return;
				}
				ctx.locale.register(NS, { zh, en });
			});
			const store = createQuotaStore();
			guardClientContribution("store lifecycle", () => {
				if (ctx === void 0 || typeof ctx.effect !== "function") return;
				ctx.effect(() => () => store.dispose(), "dsh-quota-plugin: quota store");
			});
			registerSlot(ctx, "composer read-out", {
				name: "conversation.composer.dock",
				id: "dsh-quota",
				order: 10,
				locale: NS,
				inject: () => ({ store, t })
			}, QuotaRow);
			registerSlot(ctx, "detail panel", {
				name: "shell.overlay",
				id: "dsh-quota-panel",
				order: 60,
				locale: NS,
				inject: () => ({ store, t })
			}, QuotaPanel);
			registerSlot(ctx, "settings page", {
				name: "plugins.bundle.config",
				key: PLUGIN_NAME,
				locale: NS,
				inject: () => ({ store, t })
			}, QuotaConfigPage);
		}
		/** Client services this browser half reads. */
		const inject = ["slots", "locale"];
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.name = PLUGIN_NAME;
		return module.exports;
	}
});

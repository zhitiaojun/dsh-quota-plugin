/**
 * dsh-quota-plugin — browser-half behavioural test.
 *
 * DOM-free, per the dsh-client-bundle-patch methodology: the bundle is
 * evaluated to capture its `__ModuleLoader__` factory, the factory is called
 * with a `require` shim, and the returned component tree is rendered by a tiny
 * harness that implements React hooks over a Map keyed by component path, so
 * hook state survives re-renders.
 *
 * Run:  node test/client.test.mjs
 *   env DSH_QUOTA_CLIENT=<path>  render a different bundle (used for the
 *   deliberate-failure experiment; see .scratch/README.md).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const BUNDLE_PATH = process.env.DSH_QUOTA_CLIENT === undefined
  ? resolve(here, "..", "lib", "client.js")
  : resolve(process.env.DSH_QUOTA_CLIENT);

/* ------------------------------------------------------------------ *
 * assertion bookkeeping
 * ------------------------------------------------------------------ */
let failures = 0;
let checks = 0;
function check(condition, message) {
  checks += 1;
  if (condition) {
    console.log(`ok   ${message}`);
  } else {
    failures += 1;
    console.error(`FAIL ${message}`);
  }
}
function section(title) {
  console.log(`\n=== ${title} ===`);
}
/** Numbers go through Intl.NumberFormat in the bundle, so match that form. */
function formatted(value) {
  return new Intl.NumberFormat(void 0).format(value);
}

/* ------------------------------------------------------------------ *
 * react resolution: the profile's node_modules is a broken junction here,
 * so probe the known-good installs and use the first that resolves.
 * ------------------------------------------------------------------ */
function loadReact() {
  const candidates = [
    process.env.DSH_QUOTA_REACT_DIR,
    "C:/Users/Hoshino/.dsh/profiles/node_modules/",
    "C:/Users/Hoshino/.dsh/profiles/desktop/node_modules/",
    "C:/Users/Hoshino/.dsh/profiles/web/node_modules/",
    "D:/Project/think/dsh-effort-slider/node_modules/",
    "D:/Project/1/_dshm/fork/node_modules/",
    resolve(here, "..") + "/"
  ].filter((dir) => typeof dir === "string" && dir.length > 0);
  const errors = [];
  for (const dir of candidates) {
    try {
      const req = createRequire(dir.endsWith("/") ? dir + "noop.js" : dir + "/noop.js");
      return { react: req("react"), jsxRuntime: req("react/jsx-runtime"), from: dir };
    } catch (error) {
      errors.push(`${dir}: ${String(error && error.message).split("\n")[0]}`);
    }
  }
  throw new Error(`react is not resolvable from any candidate directory:\n  ${errors.join("\n  ")}`);
}
const { react: realReact, jsxRuntime: realJsxRuntime, from: reactFrom } = loadReact();

/**
 * A stub jsx runtime, per the methodology: the bundle is rendered by THIS
 * harness, not by React, so the element tree keeps a shape the walker owns
 * (`{type, props, key}`) and the assertions never depend on React internals.
 */
function makeStubRuntime() {
  return {
    Fragment: Symbol.for("react.fragment"),
    jsx: (type, props, key) => ({ type, props: props === undefined ? {} : props, key }),
    jsxs: (type, props, key) => ({ type, props: props === undefined ? {} : props, key })
  };
}
/** The runtime the bundle's elements are currently created with. */
let jsxRuntime = makeStubRuntime();

/* ------------------------------------------------------------------ *
 * the hook runtime
 * ------------------------------------------------------------------ */
const records = new Map();
const pendingEffects = [];
let activePath = null;
let renderEpoch = 0;
let dirty = false;

function beginComponent(path, typeName) {
  let record = records.get(path);
  if (record === undefined || record.typeName !== typeName) {
    record = { path, typeName, slots: [], cursor: 0, epoch: -1 };
    records.set(path, record);
  }
  if (record.epoch !== renderEpoch) {
    record.epoch = renderEpoch;
    record.cursor = 0;
  }
  return record;
}
function activeRecord() {
  const record = records.get(activePath);
  if (record === undefined) throw new Error(`hook called outside a component render at ${String(activePath)}`);
  return record;
}
function sameDeps(a, b) {
  if (a === null || b === null) return false;
  if (a.length !== b.length) return false;
  return a.every((value, index) => Object.is(value, b[index]));
}

function useState(initial) {
  const record = activeRecord();
  const index = record.cursor++;
  let slot = record.slots[index];
  if (slot === undefined || slot.kind !== "state") {
    slot = { kind: "state", value: typeof initial === "function" ? initial() : initial };
    slot.setter = (next) => {
      const value = typeof next === "function" ? next(slot.value) : next;
      if (Object.is(value, slot.value)) return;
      slot.value = value;
      dirty = true;
    };
    record.slots[index] = slot;
  }
  return [slot.value, slot.setter];
}
function useRef(initial) {
  const record = activeRecord();
  const index = record.cursor++;
  let slot = record.slots[index];
  if (slot === undefined || slot.kind !== "ref") {
    slot = { kind: "ref", value: { current: initial } };
    record.slots[index] = slot;
  }
  return slot.value;
}
function useMemo(factory, deps) {
  const record = activeRecord();
  const index = record.cursor++;
  let slot = record.slots[index];
  const list = deps === undefined ? null : deps;
  if (slot === undefined || slot.kind !== "memo" || !sameDeps(slot.deps, list)) {
    slot = { kind: "memo", deps: list, value: factory() };
    record.slots[index] = slot;
  }
  return slot.value;
}
function useCallback(fn, deps) {
  return useMemo(() => fn, deps);
}
function useEffect(create, deps) {
  const record = activeRecord();
  const index = record.cursor++;
  const list = deps === undefined ? null : deps;
  let slot = record.slots[index];
  const changed = slot === undefined || slot.kind !== "effect" || !sameDeps(slot.deps, list);
  if (changed) {
    // React runs the previous cleanup before the next effect. Replacing the slot
    // first would silently drop it, so a leaked listener could never be caught.
    if (slot !== undefined && slot.kind === "effect" && typeof slot.cleanup === "function") {
      try {
        slot.cleanup();
      } catch {
        /* a stale cleanup must not abort the run */
      }
    }
    slot = { kind: "effect", deps: list, create, cleanup: undefined };
    record.slots[index] = slot;
    pendingEffects.push({ path: record.path, index });
  }
  return undefined;
}
function useSyncExternalStore(subscribe, getSnapshot) {
  const value = getSnapshot();
  useEffect(() => {
    const unsubscribe = subscribe(() => {
      dirty = true;
    });
    return typeof unsubscribe === "function" ? unsubscribe : undefined;
  }, [subscribe]);
  return value;
}
let idCounter = 0;
function useId() {
  const record = activeRecord();
  return `:${record.path}:${idCounter++}`;
}
const ReactShim = Object.assign({}, realReact, {
  useState,
  useRef,
  useMemo,
  useCallback,
  useEffect,
  useSyncExternalStore,
  useId
});

/* ------------------------------------------------------------------ *
 * tree rendering
 * ------------------------------------------------------------------ */
/**
 * Flatten children in document order. Nested arrays are walked (the bundle
 * returns arrays from a couple of helpers), and each element gets a stable
 * path so hook state can be keyed by component position.
 */
function renderChildren(children, path) {
  const out = [];
  const list = Array.isArray(children)
    ? children
    : children === undefined || children === null ? [] : [children];
  list.forEach((child, index) => {
    if (child === null || child === undefined || typeof child === "boolean") return;
    if (Array.isArray(child)) {
      out.push(...renderChildren(child, `${path}/${index}`));
      return;
    }
    if (typeof child === "string" || typeof child === "number") {
      out.push(String(child));
      return;
    }
    const childPath = child.key === undefined || child.key === null
      ? `${path}/i${index}`
      : `${path}/k${String(child.key)}`;
    const rendered = renderElement(child, childPath);
    if (rendered !== null) out.push(rendered);
  });
  return out;
}
function renderElement(element, path) {
  if (element === null || element === undefined || typeof element === "boolean") return null;
  if (typeof element === "string" || typeof element === "number") return String(element);
  if (Array.isArray(element)) return null;
  const type = element.type;
  const props = element.props === undefined ? {} : element.props;
  if (type === jsxRuntime.Fragment) {
    return { type: "#fragment", props, path, children: renderChildren(props.children, path) };
  }
  if (typeof type === "function") {
    beginComponent(path, type.name || "Anonymous");
    const previous = activePath;
    activePath = path;
    let rendered;
    try {
      rendered = type(props);
    } finally {
      activePath = previous;
    }
    return { type, props, path, children: renderChildren(rendered, path) };
  }
  return { type, props, path, children: renderChildren(props.children, path) };
}
function flushEffects() {
  const batch = pendingEffects.slice();
  pendingEffects.length = 0;
  for (const item of batch) {
    const record = records.get(item.path);
    if (record === undefined) continue;
    const slot = record.slots[item.index];
    if (slot === undefined || slot.kind !== "effect") continue;
    if (typeof slot.cleanup === "function") {
      try {
        slot.cleanup();
      } catch {
        /* a stale cleanup must not abort the run */
      }
      slot.cleanup = undefined;
    }
    const result = slot.create();
    if (typeof result === "function") slot.cleanup = result;
  }
}
/** Render the mounted root, flushing effects, until no state moved. */
function renderAndFlush() {
  let guard = 0;
  do {
    dirty = false;
    renderEpoch += 1;
    pendingEffects.length = 0;
    CURRENT_TREE = renderElement(CURRENT_ROOT, CURRENT_ROOT_PATH);
    flushEffects();
    guard += 1;
  } while (dirty && guard < 200);
  if (guard >= 200) throw new Error("render loop did not settle (200 passes)");
  return CURRENT_TREE;
}
let CURRENT_ROOT = null;
let CURRENT_ROOT_PATH = "r";
let CURRENT_TREE = null;
function mount(rootPath, element) {
  CURRENT_ROOT = element;
  CURRENT_ROOT_PATH = rootPath;
  return renderAndFlush();
}
/** Let queued promises and timers run, then re-render. */
async function settle(times = 8) {
  for (let index = 0; index < times; index += 1) {
    await new Promise((done) => setTimeout(done, 0));
    renderAndFlush();
  }
  return CURRENT_TREE;
}

/* ------------------------------------------------------------------ *
 * tree queries
 * ------------------------------------------------------------------ */
function walk(tree, visit) {
  if (tree === null || typeof tree === "string") return;
  visit(tree);
  for (const child of tree.children) walk(child, visit);
}
function text(tree) {
  if (tree === null || tree === undefined) return "";
  if (typeof tree === "string") return tree;
  return tree.children.map(text).join("");
}
function nodes(tree) {
  const out = [];
  walk(tree, (node) => out.push(node));
  return out;
}
function findByProp(tree, name, value) {
  return nodes(tree).find((node) => node.props !== undefined && node.props[name] === value) ?? null;
}
function findAllByProp(tree, name, value) {
  return nodes(tree).filter((node) => node.props !== undefined && node.props[name] === value);
}

/* ------------------------------------------------------------------ *
 * the host stub: routes + recorded calls
 * ------------------------------------------------------------------ */
const ISO_NOW = new Date(Date.now() - 60_000).toISOString();
const ISO_RESET = new Date(Date.now() + 3 * 3600_000).toISOString();
const WEEKLY_LABEL = "\u5468"; // 周
const GEMINI_GROUP = "Gemini Models";
const CLAUDE_GROUP = "Claude and GPT models";
const CREDIT_LABEL = "\u5269\u4f59\u79ef\u5206"; // 剩余积分
const WB_PRIMARY = "WorkBuddy \u4e3b\u53f7"; // WorkBuddy 主号

/**
 * The host's state document, built fresh on demand.
 *
 * Sections later in this file mutate `host.state`, so they must each start from
 * a known shape. Sharing one builder keeps the Google fixture (two groups that
 * reuse the window names) identical everywhere, which is what makes the group
 * assertions meaningful.
 */
function makeHostState() {
  return {
    ok: true,
    updatedAt: new Date().toISOString(),
    sources: [
      {
        id: "google-1",
        kind: "google",
        label: "Google (DR)",
        status: "ok",
        refreshedAt: new Date().toISOString(),
        metrics: [
          { key: "gemini-weekly", group: GEMINI_GROUP, label: WEEKLY_LABEL, percent: 98, resetTime: ISO_RESET },
          { key: "gemini-5h", group: GEMINI_GROUP, label: "5h", percent: 99, resetTime: ISO_RESET },
          { key: "claude-weekly", group: CLAUDE_GROUP, label: WEEKLY_LABEL, percent: 98.5, resetTime: ISO_RESET },
          { key: "claude-5h", group: CLAUDE_GROUP, label: "5h", percent: 100, resetTime: ISO_RESET }
        ]
      },
      {
        id: "workbuddy-1",
        kind: "workbuddy",
        label: WB_PRIMARY,
        status: "ok",
        refreshedAt: new Date().toISOString(),
        metrics: [
          { key: "credits", label: CREDIT_LABEL, percent: 78.4, remaining: 1568, total: 2000, resetTime: ISO_RESET }
        ]
      },
      {
        id: "workbuddy-2",
        kind: "workbuddy",
        label: "WorkBuddy1",
        status: "error",
        error: "HTTP 401",
        refreshedAt: null,
        metrics: []
      }
    ]
  };
}

const host = {
  calls: [],
  failState: false,
  state: makeHostState(),
  config: {
    ok: true,
    sources: [
      { id: "workbuddy-1", kind: "workbuddy", label: WB_PRIMARY, apiKey: "ck_abc" },
      { id: "google-1", kind: "google", label: "Google (DR)", baseUrl: "https://192.3.64.212:28317", token: "tok-1" }
    ]
  }
};

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload
  };
}

globalThis.fetch = async (url, init) => {
  const method = (init && init.method) || "GET";
  const rawBody = init ? init.body : undefined;
  host.calls.push({ url: String(url), method, body: rawBody === undefined ? null : rawBody });
  if (String(url) === "/plugins/dsh-quota/state") {
    if (host.failState) throw new Error("network down");
    return jsonResponse(host.state);
  }
  if (String(url) === "/plugins/dsh-quota/refresh") {
    let parsed = {};
    try {
      parsed = JSON.parse(rawBody ?? "{}");
    } catch {
      parsed = {};
    }
    if (typeof parsed.sourceId === "string" && parsed.sourceId.length > 0) {
      host.state = {
        ...host.state,
        updatedAt: new Date().toISOString(),
        sources: host.state.sources.map((source) => source.id === parsed.sourceId
          ? { ...source, refreshedAt: new Date().toISOString() }
          : source)
      };
    } else {
      host.state = { ...host.state, updatedAt: new Date().toISOString() };
    }
    return jsonResponse(host.state);
  }
  if (String(url) === "/plugins/dsh-quota/sources") {
    if (method === "PUT") {
      let parsed = {};
      try {
        parsed = JSON.parse(rawBody ?? "{}");
      } catch {
        parsed = {};
      }
      host.config = { ok: true, sources: Array.isArray(parsed.sources) ? parsed.sources : [] };
      return jsonResponse(host.config);
    }
    return jsonResponse(host.config);
  }
  return jsonResponse({ ok: false, error: `unrouted ${method} ${url}` }, 404);
};

/* ------------------------------------------------------------------ *
 * load the bundle
 * ------------------------------------------------------------------ */
section("bundle loading");
check(realReact !== undefined && typeof realReact.createElement === "function", `react resolved from ${reactFrom}`);
check(typeof jsxRuntime.jsx === "function" && typeof jsxRuntime.jsxs === "function", "react/jsx-runtime exposes jsx and jsxs");

const source = readFileSync(BUNDLE_PATH, "utf8");
const windowStub = { __ModuleLoader__: { load: (handoff) => { captured = handoff; } } };
let captured = null;
// eslint-disable-next-line no-new-func
new Function("window", source)(windowStub);
check(captured !== null, "bundle registered a module with __ModuleLoader__.load");
check(captured !== null && captured.id === "dsh-quota-plugin", "module id is dsh-quota-plugin");
check(typeof captured.factory === "function", "module exposes a factory");

const requireShim = (spec) => {
  if (spec === "react") return ReactShim;
  if (spec === "react/jsx-runtime") return jsxRuntime;
  throw new Error(`bundle required an undeclared module: ${spec}`);
};const api = captured.factory(requireShim);
check(api !== undefined && api !== null, "factory returned its exports");
check(typeof api.apply === "function", "exports.apply is a function");
check(api.name === "dsh-quota-plugin", `exports.name is dsh-quota-plugin (got ${String(api.name)})`);
check(Array.isArray(api.inject), "exports.inject is an array");
check(JSON.stringify(api.inject) === JSON.stringify(["slots", "locale"]), `exports.inject is [slots, locale] (got ${JSON.stringify(api.inject)})`);

/* ------------------------------------------------------------------ *
 * apply(): slot registrations
 * ------------------------------------------------------------------ */
section("slot registrations");
const registrations = [];
const effects = [];
const localeDicts = {};
const localeService = {
  active: "zh-CN",
  register(namespace, dicts) {
    localeDicts[namespace] = dicts;
    return () => {
      delete localeDicts[namespace];
    };
  },
  bind(namespace) {
    return (key, params) => {
      const dict = localeDicts[namespace] === undefined ? {} : localeDicts[namespace];
      const table = dict[this.active] ?? dict.zh ?? dict.en ?? {};
      const template = table[key] ?? key;
      if (typeof template !== "string") return String(template);
      if (params === undefined) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
    };
  }
};
const ctx = {
  slots: {
    inject(name, callback) {
      return callback();
    },
    register(options, component) {
      registrations.push({ options, component });
      return () => {};
    }
  },
  locale: localeService,
  effect(fn) {
    const disposer = fn();
    effects.push(disposer);
    return disposer;
  }
};
api.apply(ctx);

check(localeDicts["dsh-quota"] !== undefined, "locale dictionary registered under the dsh-quota namespace");
check(
  localeDicts["dsh-quota"] !== undefined && localeDicts["dsh-quota"].zh !== undefined && localeDicts["dsh-quota"].en !== undefined,
  "dict has both zh and en"
);
check(registrations.length === 3, `exactly three contributions registered (got ${registrations.length})`);

const byName = (name) => registrations.filter((entry) => entry.options.name === name);
const dockReg = byName("conversation.composer.dock")[0];
const overlayReg = byName("shell.overlay")[0];
const configReg = byName("plugins.bundle.config")[0];
check(dockReg !== undefined && dockReg.options.id === "dsh-quota" && dockReg.options.order === 10, "conversation.composer.dock id=dsh-quota order=10");
check(overlayReg !== undefined && overlayReg.options.id === "dsh-quota-panel" && overlayReg.options.order === 60, "shell.overlay id=dsh-quota-panel order=60");
check(configReg !== undefined && configReg.options.key === "dsh-quota-plugin", "plugins.bundle.config key=dsh-quota-plugin");
check(typeof dockReg.component === "function" && typeof overlayReg.component === "function" && typeof configReg.component === "function", "all three registrations carry a component function");

function mountSurface(registration, rootPath, extraProps) {
  return mount(rootPath, {
    type: registration.component,
    props: Object.assign({}, registration.options.inject(), extraProps ?? {}),
    key: rootPath
  });
}
async function mountSurfaceSettled(registration, rootPath, extraProps) {
  mountSurface(registration, rootPath, extraProps);
  return settle();
}

/* ------------------------------------------------------------------ *
 * 1. the always-visible row
 * ------------------------------------------------------------------ */
section("always-visible row");
await mountSurfaceSettled(dockReg, "row");

const rowNode = findByProp(CURRENT_TREE, "data-dsh-quota", "row");
check(rowNode !== null, "row container carries data-dsh-quota=row");
check(rowNode !== null && rowNode.type === "button", "the row is a button (clickable)");
const rowText = text(rowNode);
check(rowText.includes("Google (DR)"), `row shows the Google source's custom label (got: ${rowText})`);
check(rowText.includes(WB_PRIMARY), "row shows the WorkBuddy source's custom label");
check(rowText.includes("WorkBuddy1"), "row shows the error source's custom label");
check(rowText.includes("98%") && rowText.includes("99%"), "row shows the two Google buckets as percentages");
check(rowText.includes(formatted(1568)), `row shows the WorkBuddy remaining credit number (got: ${rowText})`);
check(rowText.includes("\u26a0"), "an errored source renders a marker, never an empty gap");
check(!rowText.includes("undefined") && !rowText.includes("NaN"), "row has no undefined/NaN leakage");
check(host.calls.filter((call) => call.url === "/plugins/dsh-quota/state" && call.method === "GET").length === 1, "the dock row reads the state route once on mount");

/* ------------------------------------------------------------------ *
 * 2. click the row -> the detail panel
 * ------------------------------------------------------------------ */
section("detail panel");

// Simulate a real click: the row sits near the BOTTOM of the window (that is
// where the composer is), and the click event carries the button as
// currentTarget. A panel pinned to a corner would ignore this rect entirely.
// The bundle reads `window` from the value passed to its factory, so the
// viewport is configured on that same stub — not on globalThis.
const ROW_RECT = { top: 600, bottom: 628, left: 300, right: 700, width: 400, height: 28 };
windowStub.innerWidth = 1280;
windowStub.innerHeight = 720;
windowStub.addEventListener = () => {};
windowStub.removeEventListener = () => {};
rowNode.props.onClick({ currentTarget: { getBoundingClientRect: () => ROW_RECT } });
renderAndFlush();
mountSurface(overlayReg, "panel");
await settle();

const panelNode = findByProp(CURRENT_TREE, "data-dsh-quota", "panel");
check(panelNode !== null, "panel is present after clicking the row (open state shared through the store)");
const panelText = text(panelNode);
check(panelText.includes("Google (DR)") && panelText.includes(WB_PRIMARY), "panel lists every source under its own display name");
check(panelText.includes("98%"), "panel shows a percentage");
const cards = findAllByProp(CURRENT_TREE, "data-dsh-quota", "card");
check(cards.length === 3, `one card per source (got ${cards.length})`);

/* --- anchoring: the panel must appear near the click, not in a corner --- */
const panelBox = panelNode.props.style;
check(panelBox.position === "fixed", "the panel is positioned against the viewport");
check(
  typeof panelBox.left === "number" && Math.abs(panelBox.left - ROW_RECT.left) <= 1,
  `panel aligns to the row's left edge, not a corner (got left=${panelBox.left}, row left=${ROW_RECT.left})`,
);
check(
  !("right" in panelBox),
  "panel is not right-pinned (right-pinning is what put it in the far corner)",
);
check(
  panelBox.top === undefined && typeof panelBox.bottom === "number",
  `panel opens ABOVE the row when there is room (got bottom=${panelBox.bottom})`,
);
// 720 - 600 + gap = 128: it sits just above the row, not at the viewport top.
check(
  typeof panelBox.bottom === "number" && panelBox.bottom > 100 && panelBox.bottom < 160,
  `panel sits just above the row rather than at the window top (got bottom=${panelBox.bottom})`,
);
// The panel is a status popover. At 460px it read as a wide slab next to the
// composer; the user asked for half that.
check(
  typeof panelBox.width === "number" && panelBox.width <= 240,
  `the panel is narrow, not a wide slab (got width=${panelBox.width})`,
);

const closeButton = findByProp(CURRENT_TREE, "data-dsh-quota-close", "");
check(closeButton !== null, "the panel offers a close control");
if (closeButton !== null) {
  closeButton.props.onClick();
  renderAndFlush();
}
mountSurface(overlayReg, "panel");
const closed = findByProp(CURRENT_TREE, "data-dsh-quota", "panel");
check(closed === null, "closing hides the panel");
// Re-open for the remaining checks, anchored again.
rowNode.props.onClick({ currentTarget: { getBoundingClientRect: () => ROW_RECT } });
renderAndFlush();
mountSurface(overlayReg, "panel");
await settle();

const creditBar = findByProp(CURRENT_TREE, "data-dsh-quota-metric", "credits");
check(creditBar !== null, "the WorkBuddy credit metric renders a bar");
check(text(creditBar).includes(`${formatted(1568)} / ${formatted(2000)}`), `the credit bar shows remaining / total (got: ${text(creditBar)})`);
const fill = findByProp(creditBar, "data-dsh-quota-fill", "");
check(fill !== null && typeof fill.props.style.width === "string" && fill.props.style.width.endsWith("%"), "the bar has a filled inner div with a percentage width");
const track = findByProp(creditBar, "data-dsh-quota-color", "neutral");
check(track !== null, "78.4% uses the neutral colour threshold and 12% would be red");
check(byName.length > 0 && text(creditBar).length > 0, "metric bar carries readable content");

const amberBar = nodes(CURRENT_TREE).find((node) => node.props && node.props["data-dsh-quota-color"] === "amber");
const redBar = nodes(CURRENT_TREE).find((node) => node.props && node.props["data-dsh-quota-color"] === "red");
check(amberBar === undefined && redBar === undefined, "no amber/red bar for the current all-high fixture");

/* ------------------------------------------------------------------ *
 * 3. per-source refresh: exactly one POST, carrying that source's id
 * ------------------------------------------------------------------ */
section("per-source refresh");
host.calls.length = 0;
const googleButton = findByProp(CURRENT_TREE, "data-dsh-quota-refresh", "google-1");
check(googleButton !== null, "each card has its own refresh button");
check(googleButton !== null && googleButton.type === "button", "the per-source refresh control is a button");
googleButton.props.onClick();
await settle();

const refreshPosts = host.calls.filter((call) => call.url === "/plugins/dsh-quota/refresh" && call.method === "POST");
check(refreshPosts.length === 1, `clicking one card's refresh issues exactly one POST (got ${refreshPosts.length})`);
let refreshBody = null;
try {
  refreshBody = refreshPosts.length === 1 ? JSON.parse(refreshPosts[0].body) : null;
} catch {
  refreshBody = null;
}
check(refreshBody !== null && refreshBody.sourceId === "google-1", `that POST carries the clicked source's id only (got ${String(refreshPosts[0] && refreshPosts[0].body)})`);
check(refreshBody !== null && Object.keys(refreshBody).length === 1, "the single-source body has no other fields (no refresh-all fallback)");
check(!refreshPosts.some((call) => call.body === null || call.body === "{}"), "no refresh-all POST was sent");
const stateGets = host.calls.filter((call) => call.url === "/plugins/dsh-quota/state");
check(stateGets.length === 0, "a manual refresh goes through the refresh route, not a re-read");

/* ------------------------------------------------------------------ *
 * 4. an errored source shows its message in red
 * ------------------------------------------------------------------ */
section("error surface");
const errorNode = findByProp(CURRENT_TREE, "data-dsh-quota-error", "workbuddy-2");
check(errorNode !== null, "an errored source renders its error element");
check(errorNode !== null && text(errorNode).includes("HTTP 401"), `the error text is rendered (got ${errorNode === null ? "nothing" : text(errorNode)})`);
check(
  errorNode !== null && String(errorNode.props.style.color).includes("error"),
  "the error text uses the theme's error colour"
);
check(text(CURRENT_TREE).includes("WorkBuddy1"), "the errored source still renders its card rather than disappearing");

/* ------------------------------------------------------------------ *
 * 5. the configuration page
 * ------------------------------------------------------------------ */
section("configuration page");
await mountSurfaceSettled(configReg, "config", { view: "page" });

const configRows = findAllByProp(CURRENT_TREE, "data-dsh-quota", "config-row");
check(configRows.length === 2, `one editable row per configured source (got ${configRows.length})`);
const nameFields = nodes(CURRENT_TREE).filter((node) => node.props && node.props["data-dsh-quota-name"] !== undefined);
check(nameFields.length === 2, `every source has a display-name field (got ${nameFields.length})`);
const wbName = findByProp(CURRENT_TREE, "data-dsh-quota-name", "workbuddy-1");
const ggName = findByProp(CURRENT_TREE, "data-dsh-quota-name", "google-1");
check(wbName !== null && wbName.props.value === WB_PRIMARY, "the display-name field is seeded from the host's custom name");
check(ggName !== null && ggName.props.value === "Google (DR)", "the second source's name field is seeded too");
check(findByProp(CURRENT_TREE, "data-dsh-quota-apikey", "workbuddy-1") !== null, "a workbuddy source renders an API-key field");
check(findByProp(CURRENT_TREE, "data-dsh-quota-baseurl", "google-1") !== null, "a google source renders a Base URL field");
check(findByProp(CURRENT_TREE, "data-dsh-quota-token", "google-1") !== null, "a google source renders a Token field");
check(findByProp(CURRENT_TREE, "data-dsh-quota-kind", "workbuddy-1") !== null, "each source has a type selector");
check(findByProp(CURRENT_TREE, "data-dsh-quota-add", "") !== null, "the page offers an add-source control");
check(findByProp(CURRENT_TREE, "data-dsh-quota-delete", "workbuddy-1") !== null, "the page offers a delete control per source");

const RENAMED = "Renamed \u4e3b\u53f7";
host.calls.length = 0;
wbName.props.onChange({ currentTarget: { value: RENAMED } });
renderAndFlush();
const saveButton = findByProp(CURRENT_TREE, "data-dsh-quota-save", "");
check(saveButton !== null, "the page offers a save control");
saveButton.props.onClick();
await settle();

const puts = host.calls.filter((call) => call.url === "/plugins/dsh-quota/sources" && call.method === "PUT");
check(puts.length === 1, `save issues exactly one PUT (got ${puts.length})`);
let putBody = null;
try {
  putBody = puts.length === 1 ? JSON.parse(puts[0].body) : null;
} catch {
  putBody = null;
}
check(putBody !== null && Array.isArray(putBody.sources) && putBody.sources.length === 2, "the PUT body carries the whole source list");
check(
  putBody !== null && putBody.sources.some((item) => item.id === "workbuddy-1" && item.label === RENAMED),
  "the edited display name reaches the host"
);
check(
  putBody !== null && putBody.sources.some((item) => item.id === "workbuddy-1" && item.apiKey === "ck_abc"),
  "an untouched field (the API key) is preserved"
);
check(text(CURRENT_TREE).includes("Removed") === false, "no stray copy in the saved page");

/* ------------------------------------------------------------------ *
 * 6. resilience: a failed read keeps the last data and surfaces the error
 * ------------------------------------------------------------------ */
section("resilience");
host.failState = true;
await mountSurfaceSettled(dockReg, "row2");
const rowText2 = text(findByProp(CURRENT_TREE, "data-dsh-quota", "row"));
check(rowText2.includes("Google (DR)") && rowText2.includes("WorkBuddy1"), "a failed read keeps the row's previous labels on screen");
check(!rowText2.includes("undefined"), "a failed read does not blank the row into undefined");
mountSurface(overlayReg, "panel2");
await settle();
const readError = findByProp(CURRENT_TREE, "data-dsh-quota-read-error", "");
check(readError !== null && text(readError).includes("network down"), `the panel surfaces the read failure (got ${readError === null ? "nothing" : text(readError)})`);
host.failState = false;

/* ------------------------------------------------------------------ *
 * 7. React dev validation: the delivered components must be warning-free.
 *
 * React's dev jsx runtime validates keys while elements are CREATED, which a
 * DOM-free harness can observe. The bundle captures `jsx`/`jsxs` from its
 * `require("react/jsx-runtime")` at factory time, so this section must
 * re-materialize the factory with a shim that returns React's REAL runtime —
 * swapping a variable afterwards would leave the captured functions pointing at
 * the stub and the check would be vacuous (it passed on a deliberately
 * key-less build until this was fixed).
 * ------------------------------------------------------------------ */
section("React dev warnings");
const reactWarnings = [];
const realConsoleError = console.error;
console.error = (...args) => {
  reactWarnings.push(String(args[0]));
};
let devRegistrations = [];
const realRequireShim = (spec) => {
  if (spec === "react") return ReactShim;
  if (spec === "react/jsx-runtime") return realJsxRuntime;
  throw new Error(`bundle required an undeclared module: ${spec}`);
};
const devApi = captured.factory(realRequireShim);
const devCtx = {
  slots: {
    inject(name, callback) {
      return callback();
    },
    register(options, component) {
      devRegistrations.push({ options, component });
      return () => {};
    }
  },
  locale: localeService,
  effect(fn) {
    return fn();
  }
};
try {
  devApi.apply(devCtx);
} catch (error) {
  console.error = realConsoleError;
  check(false, `the bundle registers against the real jsx runtime: ${String(error && error.message)}`);
}

const devDock = devRegistrations.find((entry) => entry.options.name === "conversation.composer.dock");
const devOverlay = devRegistrations.find((entry) => entry.options.name === "shell.overlay");
const devConfig = devRegistrations.find((entry) => entry.options.name === "plugins.bundle.config");
check(
  devDock !== undefined && devOverlay !== undefined && devConfig !== undefined,
  "the factory re-materialized a full set of contributions against the real jsx runtime"
);

try {
  // The dock row first: its effect starts the async state read.
  mount("dev-row", { type: devDock.component, props: devDock.options.inject(), key: "dev-row" });
  await settle();
  // Open the panel and let the state document land, so the metric list — the
  // array whose key the variant removes — is actually rendered.
  const devStore = devDock.options.inject().store;
  devStore.setOpen(true);
  mount("dev-panel", { type: devOverlay.component, props: devOverlay.options.inject(), key: "dev-panel" });
  await settle();
  check(
    findByProp(CURRENT_TREE, "data-dsh-quota-metric", "credits") !== null,
    "the dev pass rendered the metric list (otherwise the key check would be vacuous)"
  );
  // The config page renders two list children of its own, both async-loaded.
  mount("dev-config", {
    type: devConfig.component,
    props: Object.assign({}, devConfig.options.inject(), { view: "page" }),
    key: "dev-config"
  });
  await settle();
  check(
    findAllByProp(CURRENT_TREE, "data-dsh-quota", "config-row").length === 2,
    "the dev pass rendered the configuration rows"
  );
} catch (error) {
  console.error = realConsoleError;
  check(false, `the bundle renders through React's real jsx runtime: ${String(error && error.message)}`);
} finally {
  console.error = realConsoleError;
}
check(devRegistrations.length === 3, "all three contributions registered in the dev pass");
const keyWarnings = reactWarnings.filter((message) => message.includes("unique") && message.includes("key"));
check(
  keyWarnings.length === 0,
  `the delivered components emit no "unique key" warnings (got ${keyWarnings.length}${keyWarnings.length ? `: ${keyWarnings[0].slice(0, 90)}` : ""})`
);
check(
  reactWarnings.length === 0,
  `the delivered components emit no React warnings at all (got ${reactWarnings.length}${reactWarnings.length ? `: ${reactWarnings[0].slice(0, 90)}` : ""})`
);

/* ------------------------------------------------------------------ *
 * click-outside-to-close
 *
 * The overlay is click-through (pointerEvents: none), so it can never catch
 * the click itself — a document-level listener is what implements dismissal.
 * These checks drive that listener directly, and they FAIL if it is missing,
 * which is exactly the reported bug ("must press the close button").
 * ------------------------------------------------------------------ */
section("dismiss on outside click");

const documentListeners = new Map();
const documentStub = {
  addEventListener: (type, fn) => {
    const list = documentListeners.get(type) ?? [];
    list.push(fn);
    documentListeners.set(type, list);
  },
  removeEventListener: (type, fn) => {
    const list = documentListeners.get(type) ?? [];
    documentListeners.set(type, list.filter((entry) => entry !== fn));
  },
};
const previousDocument = globalThis.document;
globalThis.document = documentStub;

try {
  // Fresh mount with a clean listener table. `records` is cleared too: hook
  // state is keyed by component path, so the panel mounted earlier in this file
  // left a slot table whose deps already match — its effects would then be
  // treated as unchanged, never run, and these checks would be vacuous.
  documentListeners.clear();
  records.clear();
  host.state = makeHostState();
  // `mount` renders ONE root, so the panel must be mounted last: mounting the
  // row afterwards would replace the tree and make the checks vacuous.
  mountSurface(dockReg, "row");
  await settle();
  const ocStore = dockReg.options.inject().store;
  ocStore.setOpen(true);
  mountSurface(overlayReg, "panel");
  await settle();
  check(
    findByProp(CURRENT_TREE, "data-dsh-quota", "panel") !== null,
    "the panel is open before testing dismissal",
  );

  // The listener is armed on a later task so the opening click cannot dismiss.
  await new Promise((done) => setTimeout(done, 0));
  flushEffects();

  const pointerListeners = documentListeners.get("pointerdown") ?? [];
  const mouseListeners = documentListeners.get("mousedown") ?? [];
  check(
    pointerListeners.length > 0 || mouseListeners.length > 0,
    "opening the panel attaches a document-level dismiss listener",
  );

  // A click on empty space: target is outside the panel and outside the row.
  const outsideTarget = {
    closest: () => null,
  };
  for (const listener of [...pointerListeners, ...mouseListeners]) {
    listener({ target: outsideTarget });
  }
  renderAndFlush();
  check(
    findByProp(CURRENT_TREE, "data-dsh-quota", "panel") === null,
    "clicking outside the panel closes it (the reported bug: it only closed via the button)",
  );

  // Re-open, then click INSIDE the panel: it must stay open.
  documentListeners.clear();
  ocStore.setOpen(true, { getBoundingClientRect: () => ROW_RECT });
  renderAndFlush();
  await new Promise((done) => setTimeout(done, 0));
  flushEffects();
  const insideTarget = { closest: (selector) => (selector.includes("panel") ? {} : null) };
  for (const listener of [...(documentListeners.get("pointerdown") ?? []), ...(documentListeners.get("mousedown") ?? [])]) {
    listener({ target: insideTarget });
  }
  renderAndFlush();
  check(
    findByProp(CURRENT_TREE, "data-dsh-quota", "panel") !== null,
    "clicking inside the panel keeps it open",
  );

  // Closing must tear the listener down, or every close leaks a handler.
  const ocClose = findByProp(CURRENT_TREE, "data-dsh-quota-close", "");
  check(ocClose !== null, "the panel still offers an explicit close button");
  if (ocClose !== null) ocClose.props.onClick();
  renderAndFlush();
  await new Promise((done) => setTimeout(done, 0));
  flushEffects();
  const remaining =
    (documentListeners.get("pointerdown") ?? []).length + (documentListeners.get("mousedown") ?? []).length;
  check(remaining === 0, `closing removes the document listener (got ${remaining} left)`);
} finally {
  globalThis.document = previousDocument;
  documentListeners.clear();
}

/* ------------------------------------------------------------------ *
 * the panel stays compact
 *
 * The panel is a status popover: a full medium date, a per-source
 * "last refreshed" line and a text button per row made it dominate the
 * screen. These checks pin the trimmed shape so it cannot creep back.
 * ------------------------------------------------------------------ */
section("panel compactness");

// Restore the three-source fixture the dismiss section replaced, and start from
// a clean hook table so the count below is not affected by leftover state.
records.clear();
host.state = makeHostState();

mountSurface(dockReg, "row");
await settle();
const compactStore = dockReg.options.inject().store;
compactStore.setOpen(true, { getBoundingClientRect: () => ROW_RECT });
mountSurface(overlayReg, "panel");
await settle();

const compactPanel = findByProp(CURRENT_TREE, "data-dsh-quota", "panel");
const compactText = text(compactPanel);
check(compactPanel !== null, "panel renders for the compactness checks");

// A medium date would contain a 4-digit year; the compact form is MM-DD HH:mm.
const YEAR = String(new Date().getFullYear());
check(
  !compactText.includes(YEAR),
  `the panel no longer prints a verbose year (got: ${compactText.slice(0, 140)})`,
);
// The per-source "last refreshed" line was removed; the row's own data remains.
check(
  !compactText.includes("\u4e0a\u6b21\u5237\u65b0"),
  "the redundant per-source 'last refreshed' line is gone",
);
// The kind badge duplicated the user's own custom source name.
check(
  !/\bWorkBuddy\b\s*$/.test(compactText.trim()) || !compactText.includes("WorkBuddy\n"),
  "the per-card kind badge no longer duplicates the custom source name",
);
check(
  findAllByProp(CURRENT_TREE, "data-dsh-quota-refresh", "").length + findAllByProp(CURRENT_TREE, "data-dsh-quota-refresh", "workbuddy-1").length > 0,
  "each source keeps its own refresh control",
);

// One compact card per source, and the credit figures survive the trim.
const compactCards = findAllByProp(CURRENT_TREE, "data-dsh-quota", "card");
check(compactCards.length === 3, `still one card per source (got ${compactCards.length})`);
const compactCredit = findByProp(CURRENT_TREE, "data-dsh-quota-metric", "credits");
check(compactCredit !== null, "the credit metric still renders");
check(
  text(compactCredit).includes(formatted(1568)) && text(compactCredit).includes(formatted(2000)),
  `the trimmed credit bar still shows remaining / total (got: ${text(compactCredit)})`,
);
check(
  "data-dsh-quota-percent" in (compactCredit.props ? compactCredit.props : {}) || findByProp(compactCredit, "data-dsh-quota-percent", "") !== null,
  "the percentage survives the trim",
);
// At 230px the amount and the reset time cannot share a line with the label
// without one being ellipsised, so the reset time moved to its own line. Both
// must still be present and readable.
check(
  findByProp(compactCredit, "data-dsh-quota-reset", "") !== null,
  "the reset time still renders on the narrow panel",
);
const resetLine = findByProp(compactCredit, "data-dsh-quota-reset", "");
check(
  resetLine !== null && text(resetLine).length > 0 && !text(resetLine).includes("\u2026"),
  `the reset time is complete, not truncated (got: ${resetLine === null ? "-" : text(resetLine)})`,
);
const amountLabel = findByProp(compactCredit, "data-dsh-quota-metric", "credits");
check(
  text(compactPanel).includes(formatted(1568)) && text(compactPanel).includes(formatted(2000)),
  "remaining and total both survive at the narrow width",
);
// Narrow layout, revised after the design review: the value slot carries exactly
// ONE number. A credit balance shows its absolute amount there (more useful than
// a percentage of it, and the bar still encodes the ratio); a rate window shows
// "N% left". Previously the amount ALSO appeared on a line under the bar, which
// stated the same ratio three times over.
const creditMeta = findByProp(compactCredit, "data-dsh-quota-amount", "");
check(creditMeta !== null, "the amount renders in the value slot");
check(
  creditMeta !== null && creditMeta.props["data-dsh-quota-percent"] === "",
  "the amount shares the value slot with the percentage marker (no third encoding)",
);
// The reset line stays a separate, wrapping row so it can never clip a number.
const resetParent = nodes(compactCredit).find(
  (node) =>
    node !== null &&
    typeof node === "object" &&
    Array.isArray(node.children) &&
    node.children.some((child) => child !== null && typeof child === "object" && child.props && child.props["data-dsh-quota-reset"] === ""),
);
check(resetParent !== undefined, "the reset line sits in its own container");
check(
  resetParent !== undefined && resetParent.props.style.flexWrap === "wrap",
  `the reset line wraps instead of clipping (got flexWrap=${resetParent === undefined ? "-" : resetParent.props.style.flexWrap})`,
);
check(
  text(compactPanel).length < 400,
  `the panel's total text stays small (got ${text(compactPanel).length} chars)`,
);
// An errored source shows its reason; a bare "No data" beside it is noise.
check(
  !(compactText.includes("HTTP 401") && compactText.includes("\u6682\u65e0\u6570\u636e")),
  "an errored source does not also print a redundant 'no data' line",
);
check(
  compactText.includes("HTTP 401"),
  "an errored source still shows its error reason",
);

/* ------------------------------------------------------------------ *
 * Google groups
 *
 * Google reports the SAME window names ("周", "5h") in two groups. Without a
 * heading the card shows two bare "周" and two bare "5h" with nothing to tell
 * them apart — which is exactly what the user reported as "not quite right".
 * ------------------------------------------------------------------ */
section("grouped metrics");

mountSurface(dockReg, "row");
await settle();
const grpStore = dockReg.options.inject().store;
grpStore.setOpen(true, { getBoundingClientRect: () => ROW_RECT });
mountSurface(overlayReg, "panel");
await settle();

const googCard = findByProp(CURRENT_TREE, "data-dsh-quota-source", "google-1");
check(googCard !== null, "the Google card renders");

const geminiHead = findByProp(CURRENT_TREE, "data-dsh-quota-group", GEMINI_GROUP);
const claudeHead = findByProp(CURRENT_TREE, "data-dsh-quota-group", CLAUDE_GROUP);
check(geminiHead !== null, "the Gemini group is labelled");
check(claudeHead !== null, "the Claude/GPT group is labelled");
check(
  geminiHead !== null && text(geminiHead).includes(GEMINI_GROUP),
  "the Gemini heading shows the upstream group name",
);
check(
  claudeHead !== null && text(claudeHead).includes(CLAUDE_GROUP),
  "the Claude/GPT heading shows the upstream group name",
);
// The heading must be distinct in the rendered text, or the ambiguity returns.
const googText = text(googCard);
check(
  googText.includes(GEMINI_GROUP) && googText.includes(CLAUDE_GROUP),
  `both group names appear in the card (got: ${googText.slice(0, 120)})`,
);
// Group order follows the upstream order, Gemini first.
check(
  googText.indexOf(GEMINI_GROUP) < googText.indexOf(CLAUDE_GROUP),
  "groups keep the upstream order (Gemini before Claude/GPT)",
);
// Four bars, not two: the second group's rows must NOT be swallowed.
const googleMetrics = findAllByProp(googCard, "data-dsh-quota", "metric");
check(
  googleMetrics.length === 4,
  `the Google card renders all four windows across both groups (got ${googleMetrics.length})`,
);
// A WorkBuddy metric carries no group, so it must render WITHOUT a heading.
const wbCard = findByProp(CURRENT_TREE, "data-dsh-quota-source", "workbuddy-1");
check(wbCard !== null, "the WorkBuddy card renders");
check(
  findAllByProp(wbCard, "data-dsh-quota-group", "").length === 0 &&
    !text(wbCard).includes(GEMINI_GROUP),
  "an ungrouped source grows no heading",
);

/* ------------------------------------------------------------------ *
 * dock wrap
 *
 * DSH's composer dock is a non-wrapping flex row that also holds the
 * built-in stats. The read-out must occupy its OWN line, so the container
 * needs a wrap rule keyed off our own attribute (not a hashed class name).
 * ------------------------------------------------------------------ */
section("dock second line");

check(
  /flex-wrap:\s*wrap/.test(source),
  "the bundle injects a flex-wrap rule for the dock container",
);
check(
  /\[data-dsh-quota-dock-wrap\]/.test(source),
  "the wrap rule is scoped to our own marker attribute, not a DSH class name",
);
check(
  /data-dsh-quota-dock-wrap\]>:has\(\[data-dsh-quota='row'\]\)\{flex:1 0 100%\}/.test(
    source.replace(/\\/g, ""),
  ),
  "the read-out's wrapper claims a full row (flex-basis 100%), reached via :has on the dock's direct child",
);
// The first attempt marked row.parentElement, which is DSH's slot WRAPPER, not
// the dock — so the container never wrapped. The finder must walk up.
check(
  /function findDockRow/.test(source),
  "the dock is located by walking up to a horizontal flex container",
);
check(
  /getComputedStyle/.test(source),
  "the dock finder inspects computed styles rather than assuming a fixed parent",
);
check(
  /depth < 6/.test(source) && /tag === "BODY" \|\| tag === "HTML"/.test(source),
  "the upward walk is bounded and refuses to mark body/html",
);
// The bundle must handle a DOM-free context rather than throwing.
check(
  /typeof document === "undefined"/.test(source),
  "the wrap helper is guarded for a context without a document",
);

/* ------------------------------------------------------------------ *
 * presentation conventions adopted from the design review
 *
 * The review of comparable products (CodexBar, the Copilot quota extension,
 * Anthropic/Cursor usage pages) found three recurring rules this panel now
 * follows. Each is asserted because each is easy to regress.
 * ------------------------------------------------------------------ */
section("value wording and thresholds");

// Countdown formatter, exercised directly: it is pure and the cases are the
// whole point (relative beats wall-clock; far-future falls back to a date).
const countdownFn = new Function(
  `${source.match(/function formatShortDate[\s\S]*?\n\t\t\}/)[0]};` +
    `${source.match(/function formatCountdown[\s\S]*?\n\t\t\}/)[0]};` +
    `return formatCountdown;`,
)();
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const H = 3600_000;
const D = 24 * H;
// The formatter FLOORS to whole minutes, so a fixture built at exactly N minutes
// loses one the moment any time elapses before it is read — it passed alone and
// failed in the full run for exactly that reason. Half a minute of slack makes
// the boundary deterministic without weakening what is being asserted.
const SLACK = 30_000;
check(
  countdownFn(iso(2 * H + 14 * 60_000 + SLACK)) === "2h 14m",
  `sub-day reads as hours and minutes (got ${countdownFn(iso(2 * H + 14 * 60_000 + SLACK))})`,
);
check(
  countdownFn(iso(45 * 60_000 + SLACK)) === "45m",
  `under an hour reads as minutes (got ${countdownFn(iso(45 * 60_000 + SLACK))})`,
);
check(
  countdownFn(iso(6 * D + 23 * H + SLACK)) === "6d 23h",
  `multi-day reads as days and hours (got ${countdownFn(iso(6 * D + 23 * H + SLACK))})`,
);
check(countdownFn(iso(-H)) === "", "a past reset yields no countdown rather than a negative one");
check(
  countdownFn(iso(20 * D)) !== "" && !countdownFn(iso(20 * D)).includes("d "),
  `far-future falls back to a date (got ${countdownFn(iso(20 * D))})`,
);
check(countdownFn("not a date") === "not a date", "an unparseable value is shown verbatim, never dropped");

// Thresholds: 30% warns, 10% is critical (the Copilot-extension convention).
const colorFn = new Function(`${source.match(/function barColorName[\s\S]*?\n\t\t\}/)[0]}; return barColorName;`)();
check(colorFn(100) === "neutral" && colorFn(31) === "neutral", "healthy headroom stays neutral");
check(colorFn(30) === "amber" && colorFn(11) === "amber", "30% down to 11% warns in amber");
check(colorFn(10) === "red" && colorFn(0) === "red", "10% and below is critical");
check(colorFn(null) === "unknown", "an unknown percentage is not coloured as zero");

// The direction word. A bare "78%" leaves the reader guessing which way the bar
// runs, so the value must say what it means.
check(
  source.includes("percentLeft") && source.includes("resetsIn"),
  "the wording keys for remaining percentage and reset countdown exist",
);
// The bar fills with REMAINING, so the text and the bar must agree in direction.
const fillFn = new Function(`${source.match(/function fillStyle[\s\S]*?\n\t\t\}/)[0]}; return fillStyle;`)();
check(
  fillFn(25, "#000").width === "25%",
  "the fill width equals the REMAINING percentage, matching the text",
);

/* ------------------------------------------------------------------ *
 * exhausted state
 * ------------------------------------------------------------------ */
section("exhausted state");

records.clear();
host.state = makeHostState();
// A zeroed weekly window, with a reset still to come.
host.state.sources[0].metrics[0] = {
  key: "gemini-weekly",
  group: GEMINI_GROUP,
  label: WEEKLY_LABEL,
  percent: 0,
  resetTime: iso(2 * H + 14 * 60_000),
};
mountSurface(dockReg, "row");
await settle();
const exStore = dockReg.options.inject().store;
exStore.setOpen(true, { getBoundingClientRect: () => ROW_RECT });
mountSurface(overlayReg, "panel");
await settle();

const zeroBar = findByProp(CURRENT_TREE, "data-dsh-quota-metric", "gemini-weekly");
check(zeroBar !== null, "the zeroed metric renders");
const zeroText = text(zeroBar);
// At zero the percentage is the least useful fact; the countdown replaces it.
// Match loosely on "2h 1Xm": real time elapses between building the fixture and
// rendering, so pinning the exact minute would be flaky.
check(
  /2h 1\d+m/.test(zeroText),
  `the exhausted metric shows when it comes back (got: ${zeroText})`,
);
check(
  !zeroText.includes("0%"),
  `the useless "0% left" is replaced rather than shown beside the countdown (got: ${zeroText})`,
);
// The countdown must appear exactly ONCE: it moved into the value slot, so the
// reset line beneath the bar must be suppressed rather than repeating it.
const countdownHits = (zeroText.match(/\u540e\u91cd\u7f6e/g) ?? []).length;
check(
  countdownHits === 1,
  `the exhausted metric states its reset once, not twice (got ${countdownHits} in: ${zeroText})`,
);
// A low-but-nonzero metric gets the chip; a healthy one must not.
const healthyBar = findByProp(CURRENT_TREE, "data-dsh-quota-metric", "gemini-5h");
check(
  healthyBar !== null && findByProp(healthyBar, "data-dsh-quota-low", "") === null,
  "a healthy metric grows no low chip",
);

/* ------------------------------------------------------------------ *
 * brand icons
 *
 * Each source is identified by its product's real mark, in both surfaces. The
 * icons are inlined data URIs: the browser half's `require` supports only react
 * and react/jsx-runtime, so a separate module could not be imported.
 * ------------------------------------------------------------------ */
section("brand icons");

check(
  /data:image\/png;base64,[A-Za-z0-9+/=]{400,}/.test(source),
  "a brand icon is inlined as a PNG data URI",
);
check(
  (source.match(/data:image\/png;base64,[A-Za-z0-9+/=]{400,}/g) ?? []).length === 2,
  "both marks (WorkBuddy and Antigravity) are inlined",
);
check(
  /function sourceIcon\(kind\)/.test(source),
  "a kind -> icon mapping exists",
);
// The mapping must actually distinguish the two kinds, or every source would
// wear the same badge.
const iconFn = new Function(
  `${source.match(/const WORKBUDDY_ICON = "[^"]+";/)[0]}` +
    `${source.match(/const GOOGLE_ICON = "[^"]+";/)[0]}` +
    `const KIND_GOOGLE = "google";` +
    `${source.match(/function sourceIcon\(kind\) \{[\s\S]*?\n\t\t\}/)[0]};` +
    `return sourceIcon;`,
)();
check(iconFn("google") !== iconFn("workbuddy"), "the two kinds get different marks");
check(iconFn("google") === iconFn("google"), "the mapping is stable");

// Detail panel: every card carries its source's mark.
records.clear();
host.state = makeHostState();
mountSurface(dockReg, "row");
await settle();
const iconStore = dockReg.options.inject().store;
iconStore.setOpen(true, { getBoundingClientRect: () => ROW_RECT });
mountSurface(overlayReg, "panel");
await settle();

const googleCard = findByProp(CURRENT_TREE, "data-dsh-quota-source", "google-1");
const wbCardIcon = findByProp(CURRENT_TREE, "data-dsh-quota-source", "workbuddy-1");
const googleIcon = findByProp(googleCard, "data-dsh-quota-icon", "google");
const workbuddyIcon = findByProp(wbCardIcon, "data-dsh-quota-icon", "workbuddy");
check(googleIcon !== null, "the Google card shows its mark");
check(workbuddyIcon !== null, "the WorkBuddy card shows its mark");
check(
  googleIcon !== null && workbuddyIcon !== null && googleIcon.props.src !== workbuddyIcon.props.src,
  "the two cards do not share one icon",
);
check(
  googleIcon !== null && googleIcon.props.src.startsWith("data:image/png;base64,"),
  "the card icon is the inlined asset, not a network URL",
);
// Decorative: the label beside it already names the source.
check(
  googleIcon !== null && googleIcon.props.alt === "" && googleIcon.props["aria-hidden"] === "true",
  "the card icon is marked decorative so a screen reader does not repeat the name",
);
check(
  findAllByProp(CURRENT_TREE, "data-dsh-quota-icon", "google").length === 1,
  "exactly one Google card icon renders (no duplicate badges)",
);

// Dock read-out: same marks, smaller. Checked from the ROW's own mount, since
// `mount` renders one root and mounting the panel replaced the tree.
records.clear();
host.state = makeHostState();
mountSurface(dockReg, "row");
await settle();
const dockIcon = findByProp(CURRENT_TREE, "data-dsh-quota-row-icon", "google");
const dockWbIcon = findByProp(CURRENT_TREE, "data-dsh-quota-row-icon", "workbuddy");
check(dockIcon !== null, "the dock read-out shows the source's mark");
check(dockWbIcon !== null, "the dock read-out shows every source's mark");
check(
  dockIcon !== null && dockWbIcon !== null && dockIcon.props.src !== dockWbIcon.props.src,
  "the read-out does not reuse one icon for both kinds",
);
check(
  dockIcon !== null && dockIcon.props.src.startsWith("data:image/png;base64,"),
  "the read-out icon is the inlined asset",
);
check(
  dockIcon !== null && dockIcon.props.alt === "" && dockIcon.props["aria-hidden"] === "true",
  "the read-out icon is decorative (the read-out text names the source)",
);
check(
  dockIcon !== null && typeof dockIcon.props.style.width === "number" && dockIcon.props.style.width < 14,
  `the read-out icon is smaller than the panel's (got ${dockIcon === null ? "-" : dockIcon.props.style.width})`,
);
// The read-out text must still be present beside the icon.
const dockRow = findByProp(CURRENT_TREE, "data-dsh-quota", "row");
check(
  text(dockRow).includes("Google (DR)") && text(dockRow).includes("WorkBuddy"),
  `the read-out keeps its text beside the icons (got: ${text(dockRow)})`,
);

/* ------------------------------------------------------------------ *
 * summary
 * ------------------------------------------------------------------ */
console.log(`\n${checks - failures}/${checks} checks passed${failures === 0 ? "" : `, ${failures} FAILED`}`);
console.log(failures === 0 ? "ALL CLIENT CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);


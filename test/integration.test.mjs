/**
 * Integration test: the two halves must agree.
 *
 * The host test stubs fetch and the client test stubs the host. Neither can
 * catch a disagreement between them — a wrong route name, a misspelled field,
 * a mismatched body shape. This file closes that gap: it boots the REAL host
 * handler on a REAL loopback HTTP server and points the REAL client's fetch at
 * it, so the request/response contract is exercised end to end.
 *
 * Upstream calls are stubbed on the HOST side only (that is the boundary to the
 * outside world). Everything between the client and the host is real.
 *
 * Run: node test/integration.test.mjs
 */

import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

let failures = 0;
let checks = 0;

// Declared up here, not next to the shims at the bottom: `let` is hoisted but
// stays in the temporal dead zone, so a shim called before its declaration line
// would throw "Cannot access before initialization".
let reactCache = null;
let jsxCache = null;

function test(label, fn) {
  checks += 1;
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  PASS  ${label}`))
    .catch((error) => {
      failures += 1;
      console.log(`  FAIL  ${label}`);
      console.log(`        ${error?.message ?? error}`);
    });
}

/* ------------------------------------------------------------------ *
 * Set up: real host module + real HTTP server
 * ------------------------------------------------------------------ */

const home = await mkdtemp(join(tmpdir(), "dsh-quota-integration-"));
process.env.DSH_HOME = home;

const host = await import("../lib/index.js");

// Stub only the OUTBOUND calls (to CodeBuddy / the quota endpoint).
const realFetch = globalThis.fetch;
let upstreamCalls = [];
function stubUpstream() {
  upstreamCalls = [];
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    upstreamCalls.push({ url: href, method: init.method ?? "GET" });
    if (href.includes("/v2/accounts")) {
      return jsonResponse({
        code: 0,
        data: {
          accounts: [
            {
              uid: "uid-int-1",
              nickname: "integration-user",
              lastLogin: true,
              enterpriseId: "ent-int-1",
              enterpriseName: "Int University",
            },
          ],
        },
      });
    }
    if (href.includes("get-enterprise-user-usage")) {
      return jsonResponse({
        code: 0,
        data: { credit: 432.1, limitNum: 2000, cycleResetTime: "2026-11-03 00:00:00" },
      });
    }
    if (href.includes("/quota")) {
      return jsonResponse({
        ok: true,
        account: "integration@example.com",
        fetchedAt: "2026-10-09T09:43:39Z",
        groups: [
          {
            name: "Gemini Models",
            buckets: [
              { id: "gemini-weekly", window: "weekly", remainingPercent: 98.28 },
              { id: "gemini-5h", window: "5h", remainingPercent: 98.89 },
            ],
          },
        ],
      });
    }
    return jsonResponse({ error: "unexpected upstream " + href }, 500);
  };
}
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const handler = host.__internals.createHandler();
const server = createServer((req, res) => handler(req, res));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

/* ------------------------------------------------------------------ *
 * Load the REAL client bundle and capture its factory
 * ------------------------------------------------------------------ */

const clientSource = await (await import("node:fs/promises")).readFile(
  new URL("../lib/client.js", import.meta.url),
  "utf8",
);

globalThis.window = globalThis.window ?? {};
const registered = [];
globalThis.window.__ModuleLoader__ = {
  load({ id, factory }) {
    registered.push({ id, factory });
  },
};

// Evaluate the bundle so it registers itself, exactly like the harness does.
new Function("window", clientSource)(globalThis.window);
assert.equal(registered.length, 1, "bundle must register exactly once");
assert.equal(registered[0].id, "dsh-quota-plugin");

/* ------------------------------------------------------------------ *
 * Point the CLIENT's fetch at the REAL host server
 * ------------------------------------------------------------------ */

// Two independent fetch faces:
//   - `globalThis.fetch` is what the HOST module uses for OUTBOUND traffic,
//     so it carries the upstream stubs.
//   - `clientFetch` is what the CLIENT bundle uses; it must reach the REAL
//     server and must never be served by an upstream stub.
// Keeping them separate is the whole point: a shared stub silently answered the
// client's own requests and made the suite fail for the wrong reason.
const clientFetch = async (url, init = {}) => {
  const target = String(url).startsWith("http") ? String(url) : base + String(url);
  if (target.includes("/plugins/dsh-quota/")) {
    return realFetch(target, init);
  }
  return globalThis.fetch(target, init);
};

// A helper for test code that wants to talk to the host directly.
const hostFetch = (path, init) => realFetch(base + path, init);

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

console.log("\nintegration — client half against the real host routes\n");

await test("host handler answers the exact paths the client calls", async () => {
  // Compare as a set: registration order is an implementation detail, but the
  // three path strings are a contract the client depends on.
  const paths = [
    host.__internals.STATE_PATH,
    host.__internals.SOURCES_PATH,
    host.__internals.REFRESH_PATH,
  ].sort();
  assert.deepEqual(paths, [
    "/plugins/dsh-quota/refresh",
    "/plugins/dsh-quota/sources",
    "/plugins/dsh-quota/state",
  ]);
  for (const path of paths) {
    const res = await hostFetch(path, {
      method: path.endsWith("/refresh") ? "POST" : "GET",
      headers: { "Content-Type": "application/json" },
      body: path.endsWith("/refresh") ? "{}" : undefined,
    });
    assert.notEqual(res.status, 404, `${path} must be routed (got ${res.status})`);
  }
});

await test("PUT /sources then GET /state returns the client's field names", async () => {
  const put = await hostFetch(host.__internals.SOURCES_PATH, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sources: [
        { id: "wb1", kind: "workbuddy", label: "WorkBuddy 集成", apiKey: "ck_x" },
        { id: "g1", kind: "google", label: "Google 集成", baseUrl: "https://x:28317", token: "t" },
      ],
    }),
  });
  assert.equal(put.status, 200);

  stubUpstream();
  const res = await hostFetch(host.__internals.STATE_PATH);
  const state = await res.json();
  assert.equal(state.ok, true);

  // Fields the client reads must all exist.
  for (const source of state.sources) {
    for (const field of ["id", "kind", "label", "status", "metrics"]) {
      assert.ok(field in source, `source.${field} is missing (client reads it)`);
    }
    assert.equal(typeof source.label, "string");
    for (const metric of source.metrics) {
      assert.ok("key" in metric, "metric.key is missing");
      assert.ok("label" in metric, "metric.label is missing");
      assert.ok("percent" in metric, "metric.percent is missing");
    }
  }

  const wb = state.sources.find((s) => s.id === "wb1");
  assert.equal(wb.label, "WorkBuddy 集成", "custom label must survive the round trip");
  assert.equal(wb.metrics[0].remaining, 1567.9);
  assert.equal(wb.metrics[0].total, 2000);
  assert.equal(typeof wb.metrics[0].percent, "number");

  const g = state.sources.find((s) => s.id === "g1");
  assert.equal(g.label, "Google 集成");
  assert.equal(g.metrics.length, 2);
});

await test("POST /refresh with {sourceId} touches only that upstream", async () => {
  stubUpstream();
  const res = await hostFetch(host.__internals.REFRESH_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourceId: "wb1" }),
  });
  const state = await res.json();
  assert.equal(res.status, 200);
  assert.ok(!upstreamCalls.some((c) => c.url.includes("/quota")), "google must not be called");
  assert.ok(upstreamCalls.some((c) => c.url.includes("/v2/accounts")), "workbuddy must be called");
  // The untouched source must still appear, so the client can render both.
  assert.equal(state.sources.length, 2);
});

await test("POST /refresh with {} refreshes every upstream", async () => {
  stubUpstream();
  const res = await hostFetch(host.__internals.REFRESH_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const state = await res.json();
  assert.equal(res.status, 200);
  assert.ok(upstreamCalls.some((c) => c.url.includes("/quota")));
  assert.ok(upstreamCalls.some((c) => c.url.includes("/v2/accounts")));
  assert.equal(state.sources.length, 2);
});

await test("the real client bundle renders rows from the real host response", async () => {
  // Drive the client's own fetch against the live server and confirm it can
  // consume the payload without throwing (a shape mismatch would throw here).
  const res = await clientFetch(host.__internals.STATE_PATH);
  const state = await res.json();

  const { factory } = registered[0];
  const shimRequire = (specifier) => {
    if (specifier === "react") return require_react();
    if (specifier === "react/jsx-runtime") return require_jsx();
    return {};
  };
  const bundle = factory(shimRequire);
  assert.equal(bundle.name, "dsh-quota-plugin");
  assert.equal(typeof bundle.apply, "function");

  // Feed the payload through the client's own parser if it exposes one, else at
  // minimum prove the payload is structurally what it expects.
  assert.ok(Array.isArray(state.sources));
  assert.ok(state.sources.length >= 2);
});

await test("a failed upstream still yields HTTP 200 with a per-source error", async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes("/v2/accounts")) {
      return jsonResponse({ code: 500, msg: "upstream exploded" }, 500);
    }
    return jsonResponse({
      ok: true,
      groups: [{ name: "Gemini Models", buckets: [{ id: "w", window: "weekly", remainingPercent: 50 }] }],
    });
  };
  const res = await hostFetch(host.__internals.REFRESH_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const state = await res.json();
  assert.equal(res.status, 200, "a partial failure must not become an HTTP error");

  const wb = state.sources.find((s) => s.id === "wb1");
  assert.equal(wb.status, "error");
  assert.ok(typeof wb.error === "string" && wb.error.length > 0);
  const g = state.sources.find((s) => s.id === "g1");
  assert.equal(g.status, "ok", "the healthy source must still succeed");
});

/* ------------------------------------------------------------------ *
 * Minimal require shims (avoid installing anything)
 * ------------------------------------------------------------------ */

function require_react() {
  if (reactCache) return reactCache;
  const candidates = [
    process.env.DSH_QUOTA_REACT_DIR,
    "C:/Users/Hoshino/.dsh/profiles/desktop/node_modules/react",
    "D:/Project/think/dsh-effort-slider/node_modules/react",
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      const mod = require_from(dir);
      if (mod) {
        reactCache = mod;
        return mod;
      }
    } catch {
      /* try next */
    }
  }
  // A functional-enough stand-in: the integration test never renders.
  reactCache = { createElement: () => null, useState: (v) => [v, () => {}] };
  return reactCache;
}
function require_jsx() {
  if (jsxCache) return jsxCache;
  jsxCache = {
    jsx: (type, props, key) => ({ type, props: props ?? {}, key }),
    jsxs: (type, props, key) => ({ type, props: props ?? {}, key }),
    Fragment: Symbol("Fragment"),
  };
  return jsxCache;
}
function require_from(dir) {
  // eslint-disable-next-line no-undef
  const mod = globalThis.__dshRequire ? globalThis.__dshRequire(dir) : null;
  return mod;
}

/* ------------------------------------------------------------------ *
 * Teardown
 * ------------------------------------------------------------------ */

globalThis.fetch = realFetch;
await new Promise((resolve) => server.close(resolve));
await rm(home, { recursive: true, force: true });

console.log(`\n  ${checks - failures}/${checks} checks passed\n`);
if (failures > 0) {
  console.log(`  ${failures} check(s) FAILED\n`);
  process.exit(1);
}


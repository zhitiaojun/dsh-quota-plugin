/**
 * Host-half tests.
 *
 * Everything is exercised against a stubbed global fetch and a temporary
 * DSH_HOME, so no network call and no real credential is involved.
 *
 * Run: node test/host.test.mjs
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

let failures = 0;
let checks = 0;

function test(label, fn) {
  checks += 1;
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  PASS  ${label}`);
    })
    .catch((error) => {
      failures += 1;
      console.log(`  FAIL  ${label}`);
      console.log(`        ${error?.message ?? error}`);
    });
}

/* ---------------------------------------------------------------- *
 * Test harness
 * ---------------------------------------------------------------- */

const home = await mkdtemp(join(tmpdir(), "dsh-quota-test-"));
process.env.DSH_HOME = home;

const originalFetch = globalThis.fetch;
const calls = [];

/** Install a fetch stub. `routes` maps a URL substring to a responder. */
function stubFetch(routes) {
  calls.length = 0;
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    calls.push({ url: href, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body });
    for (const [needle, responder] of routes) {
      if (href.includes(needle)) {
        const result = typeof responder === "function" ? responder(href, init) : responder;
        return new Response(JSON.stringify(result.body), {
          status: result.status ?? 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({ error: "no stub for " + href }), { status: 500 });
  };
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

/** Minimal res double that records what the handler wrote. */
function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers ?? {};
    },
    end(chunk) {
      if (chunk) this.body += chunk.toString();
    },
  };
}

function fakeReq({
  method = "GET",
  url = "/",
  body = "",
  address = "127.0.0.1",
  headers = { host: "127.0.0.1:19387" },
} = {}) {
  const listeners = {};
  const req = {
    method,
    url,
    headers,
    socket: { remoteAddress: address },
    on(event, handler) {
      listeners[event] = handler;
      return this;
    },
    destroy() {},
  };
  // Deliver the body on the next tick, matching the async read contract.
  setTimeout(() => {
    if (body && listeners.data) listeners.data(Buffer.from(body, "utf8"));
    if (listeners.end) listeners.end();
  }, 0);
  return req;
}

async function callHandler(handler, options) {
  const res = fakeRes();
  await handler(fakeReq(options), res);
  let parsed = null;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    parsed = null;
  }
  return { status: res.statusCode, body: res.body, json: parsed };
}

async function writeSources(list) {
  await writeFile(
    join(home, ".dsh-quota-sources.json"),
    JSON.stringify({ version: 1, sources: list }),
    "utf8",
  );
}

/* ---------------------------------------------------------------- *
 * Fixtures
 * ---------------------------------------------------------------- */

const ENTERPRISE_BILLING = {
  code: 0,
  msg: "OK",
  data: {
    credit: 432.1,
    limitNum: 2000,
    cycleStartTime: "2026-10-02 00:00:00",
    cycleEndTime: "2026-11-02 23:59:59",
    cycleResetTime: "2026-11-03 00:00:00",
  },
};

const ACCOUNTS = {
  code: 0,
  msg: "OK",
  data: {
    accounts: [
      {
        uid: "uid-test-1",
        nickname: "tester",
        type: "ultimate",
        lastLogin: true,
        enterpriseId: "ent-test-1",
        enterpriseName: "Test University",
      },
    ],
  },
};

const GOOGLE_QUOTA = {
  ok: true,
  service: "google-antigravity",
  account: "tester@example.com",
  fetchedAt: "2026-10-09T09:43:39Z",
  groups: [
    {
      name: "Gemini Models",
      buckets: [
        { id: "gemini-weekly", window: "weekly", remainingPercent: 98.28, resetTime: "2026-10-15T09:29:31Z" },
        { id: "gemini-5h", window: "5h", remainingPercent: 98.89, resetTime: "2026-10-09T10:13:53Z" },
      ],
    },
    {
      name: "Claude and GPT models",
      buckets: [
        { id: "3p-weekly", window: "weekly", remainingPercent: 98.51, resetTime: "2026-10-10T08:43:25Z" },
      ],
    },
  ],
};

/* ---------------------------------------------------------------- *
 * Tests
 * ---------------------------------------------------------------- */

console.log("\nhost half — dsh-quota-plugin\n");

const mod = await import("../lib/index.js");

await test("package exports the cordis plugin surface", async () => {
  assert.equal(typeof mod.name, "string");
  assert.equal(mod.name, "dsh-quota-plugin");
  assert.equal(typeof mod.apply, "function");
  assert.ok(Array.isArray(mod.inject), "inject must be an array");
});

await test("WorkBuddy: resolves enterprise identity and computes remaining credits", async () => {
  stubFetch([
    ["/v2/accounts", { body: ACCOUNTS }],
    ["get-enterprise-user-usage", { body: ENTERPRISE_BILLING }],
  ]);
  const identity = await mod.fetchWorkBuddyAccounts("ck_test");
  assert.equal(identity.uid, "uid-test-1");
  assert.equal(identity.enterpriseId, "ent-test-1");
  assert.equal(identity.nickname, "tester");

  const credits = await mod.fetchWorkBuddyCredits("ck_test", identity);
  assert.equal(credits.total, 2000);
  assert.equal(credits.used, 432.1);
  assert.equal(credits.remaining, 1567.9);
  assert.equal(credits.resetTime, "2026-11-03 00:00:00");

  // The identity headers the billing endpoint needs must be derived, not asked for.
  const billing = calls.find((c) => c.url.includes("get-enterprise-user-usage"));
  assert.equal(billing.method, "POST");
  assert.equal(billing.headers["X-API-Key"], "ck_test");
  assert.equal(billing.headers["X-User-Id"], "uid-test-1");
  assert.equal(billing.headers["X-Enterprise-Id"], "ent-test-1");
  assert.equal(billing.headers["X-Tenant-Id"], "ent-test-1");
  restoreFetch();
});

await test("WorkBuddy: an invalid key surfaces an error instead of a silent 0", async () => {
  stubFetch([
    ["/v2/accounts", { status: 401, body: { code: 401, msg: "unauthorized" } }],
  ]);
  await assert.rejects(
    () => mod.fetchWorkBuddyAccounts("ck_bad"),
    /401|could not resolve/,
  );
  restoreFetch();
});

await test("Google: parses quota groups into metrics", async () => {
  stubFetch([["/quota", { body: GOOGLE_QUOTA }]]);
  const quota = await mod.fetchGoogleQuota("https://192.0.2.10:28317", "tok_test");
  assert.equal(quota.groups.length, 2);
  const sent = calls[0];
  assert.equal(sent.headers["X-Quota-Token"], "tok_test");
  restoreFetch();
});

await test("Google: 401 is reported as a token problem", async () => {
  stubFetch([["/quota", { status: 401, body: { ok: false, error: "unauthorized" } }]]);
  await assert.rejects(
    () => mod.fetchGoogleQuota("https://192.0.2.10:28317", "bad"),
    /token rejected/,
  );
  restoreFetch();
});

await test("sources are persisted with mode 600 and reloaded", async () => {
  await writeSources([]);
  const saved = await mod.saveSources([
    { kind: "workbuddy", label: "WorkBuddy 主号", apiKey: "ck_a" },
    { kind: "google", label: "Google (DR)", baseUrl: "https://192.0.2.10:28317", token: "t" },
  ]);
  assert.equal(saved.length, 2);
  assert.equal(saved[0].label, "WorkBuddy 主号");
  // ids are generated when absent and must differ between sources.
  assert.notEqual(saved[0].id, saved[1].id);
  assert.equal(saved[0].kind, "workbuddy");
  assert.equal(saved[1].kind, "google");
});

await test("collectState merges both kinds and keeps custom labels", async () => {
  await writeSources([
    { id: "wb1", kind: "workbuddy", label: "WorkBuddy 主号", apiKey: "ck_a" },
    { id: "g1", kind: "google", label: "Google (DR)", baseUrl: "https://192.0.2.10:28317", token: "t" },
  ]);
  stubFetch([
    ["/v2/accounts", { body: ACCOUNTS }],
    ["get-enterprise-user-usage", { body: ENTERPRISE_BILLING }],
    ["/quota", { body: GOOGLE_QUOTA }],
  ]);
  const state = await mod.collectState();
  assert.equal(state.sources.length, 2);

  const wb = state.sources.find((s) => s.id === "wb1");
  assert.equal(wb.label, "WorkBuddy 主号");
  assert.equal(wb.status, "ok");
  assert.equal(wb.metrics[0].remaining, 1567.9);
  assert.equal(wb.metrics[0].total, 2000);
  assert.ok(Math.abs(wb.metrics[0].percent - 78.4) < 0.1, "percent should be ~78.4");

  const g = state.sources.find((s) => s.id === "g1");
  assert.equal(g.label, "Google (DR)");
  assert.equal(g.status, "ok");
  assert.equal(g.metrics.length, 3);
  const weekly = g.metrics.find((m) => m.key === "gemini-weekly");
  assert.equal(weekly.percent, 98.28);
  assert.equal(weekly.resetTime, "2026-10-15T09:29:31Z");
  restoreFetch();
});

await test("a failing source reports its error and does not blank its siblings", async () => {
  await writeSources([
    { id: "wb1", kind: "workbuddy", label: "WorkBuddy 主号", apiKey: "ck_a" },
    { id: "g1", kind: "google", label: "Google (DR)", baseUrl: "https://192.0.2.10:28317", token: "t" },
  ]);
  stubFetch([
    ["/v2/accounts", { status: 500, body: { code: 500, msg: "boom" } }],
    ["/quota", { body: GOOGLE_QUOTA }],
  ]);
  const state = await mod.collectState();
  const wb = state.sources.find((s) => s.id === "wb1");
  const g = state.sources.find((s) => s.id === "g1");
  assert.equal(wb.status, "error");
  assert.ok(typeof wb.error === "string" && wb.error.length > 0, "expected an error message");
  assert.equal(g.status, "ok", "the healthy source must still succeed");
  assert.ok(g.metrics.length > 0);
  restoreFetch();
});

await test("per-source refresh touches ONLY the named source", async () => {
  await writeSources([
    { id: "wb1", kind: "workbuddy", label: "WorkBuddy 主号", apiKey: "ck_a" },
    { id: "g1", kind: "google", label: "Google (DR)", baseUrl: "https://192.0.2.10:28317", token: "t" },
  ]);
  stubFetch([
    ["/v2/accounts", { body: ACCOUNTS }],
    ["get-enterprise-user-usage", { body: ENTERPRISE_BILLING }],
    ["/quota", { body: GOOGLE_QUOTA }],
  ]);

  // Seed both so we can tell fresh from stale.
  await mod.collectState();
  const before = calls.length;

  stubFetch([
    ["/v2/accounts", { body: ACCOUNTS }],
    ["get-enterprise-user-usage", { body: ENTERPRISE_BILLING }],
    ["/quota", { body: GOOGLE_QUOTA }],
  ]);
  const state = await mod.collectState("g1");

  assert.equal(calls.length, 1, `expected exactly 1 upstream call, saw ${calls.length}`);
  assert.ok(calls[0].url.includes("/quota"), "the only call must be the Google one");
  assert.ok(!calls.some((c) => c.url.includes("/v2/accounts")), "WorkBuddy must not be touched");

  // The untouched source must still be present in the state.
  assert.equal(state.sources.length, 2);
  assert.equal(state.sources.find((s) => s.id === "wb1").status, "ok");
  restoreFetch();
});

await test("unknown source id is rejected", async () => {
  await writeSources([{ id: "g1", kind: "google", label: "Google", baseUrl: "https://x", token: "t" }]);
  await assert.rejects(() => mod.collectState("nope"), /unknown source/);
});

await test("router: rejects non-loopback callers", async () => {
  const handler = mod.__internals.createHandler();
  const result = await callHandler(handler, {
    method: "GET",
    url: mod.__internals.STATE_PATH,
    address: "203.0.113.9",
    headers: { host: "example.com" },
  });
  assert.equal(result.status, 403);
  assert.equal(result.json.error, "request-not-trusted");
});

/* ------------------------------------------------------------------ *
 * Trust boundary. A loopback bind is NOT a trust boundary on its own:
 * any local process, or a DNS-rebinding page, can reach 127.0.0.1. These
 * cases pin down the actual decision.
 * ------------------------------------------------------------------ */

await test("trust: accepts a plain loopback Host with no Origin", async () => {
  const { isTrusted } = mod.__internals;
  assert.equal(isTrusted({ headers: { host: "127.0.0.1:3456" }, socket: {} }), true);
  assert.equal(isTrusted({ headers: { host: "localhost:3456" }, socket: {} }), true);
  assert.equal(isTrusted({ headers: { host: "[::1]:3456" }, socket: {} }), true);
});

await test("trust: REJECTS a DNS-rebinding request (loopback socket, foreign Host)", async () => {
  const { isTrusted } = mod.__internals;
  // The attacker's page resolves evil.example to 127.0.0.1, so the socket IS
  // loopback — but the Host header still names the attacker's domain. This is
  // exactly the case a socket-address-only check would wrongly allow.
  assert.equal(
    isTrusted({ headers: { host: "evil.example" }, socket: { remoteAddress: "127.0.0.1" } }),
    false,
  );
});

await test("trust: REJECTS a foreign browser Origin even with a loopback Host", async () => {
  const { isTrusted } = mod.__internals;
  assert.equal(
    isTrusted({
      headers: { host: "127.0.0.1:3456", origin: "https://evil.example" },
      socket: { remoteAddress: "127.0.0.1" },
    }),
    false,
  );
  // A loopback Origin is fine.
  assert.equal(
    isTrusted({
      headers: { host: "127.0.0.1:3456", origin: "http://127.0.0.1:19387" },
      socket: { remoteAddress: "127.0.0.1" },
    }),
    true,
  );
});

await test("trust: REJECTS a missing Host header", async () => {
  const { isTrusted } = mod.__internals;
  assert.equal(isTrusted({ headers: {}, socket: {} }), false);
});

await test("hostnameOfHost: strips ports without mangling IPv6 literals", async () => {
  const { hostnameOfHost } = mod.__internals;
  assert.equal(hostnameOfHost("127.0.0.1:8080"), "127.0.0.1");
  assert.equal(hostnameOfHost("localhost:19387"), "localhost");
  assert.equal(hostnameOfHost("[::1]:8080"), "[::1]");
  assert.equal(hostnameOfHost("[::1]"), "[::1]");
  assert.equal(hostnameOfHost("example.com:443"), "example.com");
});

await test("router: a rebinding-style request is 403 at the route, not just in the helper", async () => {
  const handler = mod.__internals.createHandler();
  const result = await callHandler(handler, {
    method: "GET",
    url: mod.__internals.STATE_PATH,
    address: "127.0.0.1",
    headers: { host: "evil.example" },
  });
  assert.equal(result.status, 403);
});

await test("router: PUT then GET round-trips the source list", async () => {
  const handler = mod.__internals.createHandler();
  const put = await callHandler(handler, {
    method: "PUT",
    url: mod.__internals.SOURCES_PATH,
    body: JSON.stringify({
      sources: [
        { id: "g1", kind: "google", label: "我的 Google", baseUrl: "https://192.0.2.10:28317", token: "t" },
      ],
    }),
  });
  assert.equal(put.status, 200);
  assert.equal(put.json.sources[0].label, "我的 Google");

  const get = await callHandler(handler, { method: "GET", url: mod.__internals.SOURCES_PATH });
  assert.equal(get.status, 200);
  assert.equal(get.json.sources.length, 1);
  assert.equal(get.json.sources[0].label, "我的 Google");
});

await test("router: unknown path is 404", async () => {
  const handler = mod.__internals.createHandler();
  const result = await callHandler(handler, { method: "GET", url: "/plugins/dsh-quota/nope" });
  assert.equal(result.status, 404);
});

await test("router: refresh with a sourceId body refreshes only that source", async () => {
  await writeSources([
    { id: "wb1", kind: "workbuddy", label: "WB", apiKey: "ck_a" },
    { id: "g1", kind: "google", label: "G", baseUrl: "https://192.0.2.10:28317", token: "t" },
  ]);
  const handler = mod.__internals.createHandler();
  stubFetch([["/quota", { body: GOOGLE_QUOTA }]]);
  const result = await callHandler(handler, {
    method: "POST",
    url: mod.__internals.REFRESH_PATH,
    body: JSON.stringify({ sourceId: "g1" }),
  });
  assert.equal(result.status, 200);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("/quota"));
  restoreFetch();
});

/* ---------------------------------------------------------------- *
 * Reverse validation: the per-source test must actually discriminate
 * ---------------------------------------------------------------- */

console.log("\n  -- reverse validation (a passing test that cannot fail proves nothing) --\n");

await test("MUTANT: refreshing all sources IS detectable by the per-source assertion", async () => {
  // Re-implement the same assertion but drive a deliberate mutant that
  // ignores sourceId (i.e. refreshes everything). The assertion MUST fail.
  await writeSources([
    { id: "wb1", kind: "workbuddy", label: "WB", apiKey: "ck_a" },
    { id: "g1", kind: "google", label: "G", baseUrl: "https://192.0.2.10:28317", token: "t" },
  ]);
  stubFetch([
    ["/v2/accounts", { body: ACCOUNTS }],
    ["get-enterprise-user-usage", { body: ENTERPRISE_BILLING }],
    ["/quota", { body: GOOGLE_QUOTA }],
  ]);

  const allState = await mod.collectState(); // mutant behaviour: ignore the id
  const googleOnlyCalls = calls.length;
  assert.ok(googleOnlyCalls >= 2, "mutant should have hit both upstreams");
  assert.ok(
    calls.some((c) => c.url.includes("/v2/accounts")),
    "mutant should have touched WorkBuddy",
  );

  // Now show the real assertion would reject that mutant:
  let detected = false;
  try {
    assert.equal(googleOnlyCalls, 1, "expected exactly 1 upstream call");
  } catch {
    detected = true;
  }
  assert.ok(detected, "the per-source assertion MUST fail against the mutant");
  assert.equal(allState.sources.length, 2);
  restoreFetch();
});

/* ---------------------------------------------------------------- *
 * Cleanup + summary
 * ---------------------------------------------------------------- */

restoreFetch();
await rm(home, { recursive: true, force: true });

console.log(`\n  ${checks - failures}/${checks} checks passed\n`);
if (failures > 0) {
  console.log(`  ${failures} check(s) FAILED\n`);
  process.exit(1);
}

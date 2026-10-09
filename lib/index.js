/**
 * DSH Quota — host half.
 *
 * Aggregates remaining quota from independent sources and serves it to the
 * browser half over same-origin routes.
 *
 * Two source kinds are supported:
 *
 *   workbuddy  A `ck_...` API key for CodeBuddy / WorkBuddy. The key is sent as
 *              `X-API-Key`; the account identity (uid, enterpriseId) is
 *              discovered from `/v2/accounts`, so the user only pastes a key.
 *              Credits come from the billing endpoint, and remaining is
 *              `limitNum - credit`.
 *
 *   google     An HTTPS endpoint (see the companion `quota-api` service) that
 *              reports Google Antigravity 5-hour and weekly windows. The token
 *              travels in `X-Quota-Token`.
 *
 * This module deliberately depends on NO other plugin. It re-implements the
 * upstream calls it needs rather than importing them.
 *
 * @module dsh-quota-plugin
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const name = "dsh-quota-plugin";

/** Services this plugin uses from the host context. */
export const inject = [];

const STATE_PATH = "/plugins/dsh-quota/state";
const REFRESH_PATH = "/plugins/dsh-quota/refresh";
const SOURCES_PATH = "/plugins/dsh-quota/sources";

const FETCH_TIMEOUT_MS = 20_000;
const WORKBUDDY_BILLING_TIMEOUT_MS = 25_000;

/* ------------------------------------------------------------------ *
 * Paths
 * ------------------------------------------------------------------ */

function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();
  return join(homedir(), ".dsh");
}

export function sourcesFilePath() {
  return join(dshHome(), ".dsh-quota-sources.json");
}

/* ------------------------------------------------------------------ *
 * Upstream: WorkBuddy / CodeBuddy
 * ------------------------------------------------------------------ */

/** Origins that serve the same CodeBuddy SaaS API. */
const WORKBUDDY_ORIGINS = ["https://www.workbuddy.cn", "https://copilot.tencent.com"];

async function fetchJson(url, init, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(
        `upstream returned non-JSON (http ${response.status}): ${text.slice(0, 160)}`,
      );
    }
    return { response, document: parsed };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve the account behind an API key.
 *
 * `/v2/accounts` is reachable with the API key alone, which is what lets a
 * user configure a source with nothing but `ck_...` — the identity headers the
 * billing endpoint wants are derived here instead of being asked for.
 */
export async function fetchWorkBuddyAccounts(apiKey) {
  const headers = {
    Accept: "application/json",
    "X-API-Key": apiKey,
    "X-Requested-With": "XMLHttpRequest",
    "User-Agent": "CLI/2.63.2 CodeBuddy/2.63.2",
  };

  let lastError;
  for (const origin of WORKBUDDY_ORIGINS) {
    try {
      const { response, document } = await fetchJson(`${origin}/v2/accounts`, {
        method: "GET",
        headers,
      });
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status} from ${origin}/v2/accounts`);
        continue;
      }
      if (typeof document?.code === "number" && document.code !== 0) {
        throw new Error(
          `upstream code ${document.code}: ${String(document.msg ?? "").slice(0, 160)}`,
        );
      }
      const accounts = document?.data?.accounts;
      if (!Array.isArray(accounts) || accounts.length === 0) {
        throw new Error("API key is valid but no account was returned");
      }
      const account = accounts.find((item) => item?.lastLogin) ?? accounts[0];
      return {
        origin,
        uid: typeof account?.uid === "string" ? account.uid : "",
        enterpriseId:
          typeof account?.enterpriseId === "string" ? account.enterpriseId : "",
        nickname: typeof account?.nickname === "string" ? account.nickname : "",
        domain: typeof account?.domain === "string" && account.domain ? account.domain : "www.workbuddy.cn",
        enterpriseName:
          typeof account?.enterpriseName === "string" ? account.enterpriseName : "",
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("could not resolve the WorkBuddy account for this key");
}

function workBuddyBillingHeaders(apiKey, identity) {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-API-Key": apiKey,
    "X-Requested-With": "XMLHttpRequest",
    "User-Agent": "CLI/2.63.2 CodeBuddy/2.63.2",
  };
  if (identity.uid) headers["X-User-Id"] = identity.uid;
  if (identity.enterpriseId) {
    headers["X-Enterprise-Id"] = identity.enterpriseId;
    headers["X-Tenant-Id"] = identity.enterpriseId;
  }
  if (identity.domain) headers["X-Domain"] = identity.domain;
  return headers;
}

function numberAt(source, ...keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

/**
 * Enterprise accounts answer `/v2/billing/meter/get-enterprise-user-usage`
 * with a single cycle quota: `limitNum` total, `credit` consumed.
 * Personal accounts have no enterprise id and use the package list instead.
 */
export async function fetchWorkBuddyCredits(apiKey, identity) {
  const enterprise = Boolean(identity.enterpriseId);

  if (enterprise) {
    const url = `${identity.origin}/v2/billing/meter/get-enterprise-user-usage`;
    const { response, document } = await fetchJson(
      url,
      { method: "POST", headers: workBuddyBillingHeaders(apiKey, identity), body: "{}" },
      WORKBUDDY_BILLING_TIMEOUT_MS,
    );
    if (!response.ok) throw new Error(`HTTP ${response.status} from billing`);
    if (typeof document?.code === "number" && document.code !== 0) {
      throw new Error(`upstream code ${document.code}: ${String(document.msg ?? "").slice(0, 160)}`);
    }
    const data = document?.data ?? {};
    const limit = numberAt(data, "limitNum", "limit_num");
    const used = numberAt(data, "credit", "used_num");
    if (limit === undefined) {
      throw new Error("billing response carried no quota limit (expected limitNum)");
    }
    if (limit === -1) {
      return {
        unlimited: true,
        remaining: null,
        total: null,
        resetTime: typeof data.cycleResetTime === "string" ? data.cycleResetTime : undefined,
      };
    }
    if (used === undefined) {
      throw new Error("billing response carried a limit but no usage (expected credit)");
    }
    return {
      unlimited: false,
      remaining: Math.max(0, limit - used),
      used,
      total: limit,
      resetTime: typeof data.cycleResetTime === "string" ? data.cycleResetTime : undefined,
      cycleStartTime: typeof data.cycleStartTime === "string" ? data.cycleStartTime : undefined,
      cycleEndTime: typeof data.cycleEndTime === "string" ? data.cycleEndTime : undefined,
    };
  }

  // Personal path: a list of credit packages.
  const url = `${identity.origin}/v2/billing/meter/get-user-resource`;
  const { response, document } = await fetchJson(
    url,
    {
      method: "POST",
      headers: workBuddyBillingHeaders(apiKey, identity),
      body: JSON.stringify({
        PageNumber: 1,
        PageSize: 100,
        ProductCode: "p_tcaca",
        Status: [0, 3],
      }),
    },
    WORKBUDDY_BILLING_TIMEOUT_MS,
  );
  if (!response.ok) throw new Error(`HTTP ${response.status} from billing`);
  if (typeof document?.code === "number" && document.code !== 0) {
    throw new Error(`upstream code ${document.code}: ${String(document.msg ?? "").slice(0, 160)}`);
  }
  const inner = document?.data?.Response?.Data ?? {};
  const accounts = Array.isArray(inner.Accounts) ? inner.Accounts : [];
  let remaining = 0;
  let total = 0;
  let sawUnlimited = false;
  for (const entry of accounts) {
    const size = numberAt(entry, "size", "Size");
    const remain = numberAt(entry, "remain", "Remain");
    if (size === -1) {
      sawUnlimited = true;
      continue;
    }
    if (typeof size === "number") total += size;
    if (typeof remain === "number") remaining += remain;
  }
  if (sawUnlimited) {
    return { unlimited: true, remaining: null, total: null };
  }
  if (total === 0 && remaining === 0 && accounts.length === 0) {
    throw new Error("no credit package was returned for this account");
  }
  return { unlimited: false, remaining, total };
}

/* ------------------------------------------------------------------ *
 * Upstream: Google (Antigravity quota-api)
 * ------------------------------------------------------------------ */

export async function fetchGoogleQuota(baseUrl, token) {
  const trimmed = String(baseUrl).trim().replace(/\/+$/, "");
  const url = `${trimmed}/quota`;
  const { response, document } = await fetchJson(url, {
    method: "GET",
    headers: { Accept: "application/json", "X-Quota-Token": token },
  });
  if (response.status === 401) throw new Error("token rejected (401)");
  if (!response.ok) {
    const detail = document?.error ? String(document.error).slice(0, 160) : "";
    throw new Error(`HTTP ${response.status}${detail ? ` — ${detail}` : ""}`);
  }
  if (document?.ok === false) throw new Error(String(document.error ?? "upstream reported failure"));
  if (!Array.isArray(document?.groups)) throw new Error("quota response carried no groups");
  return { groups: document.groups, fetchedAt: document.fetchedAt, account: document.account };
}

/* ------------------------------------------------------------------ *
 * Normalisation into the shared Metric shape
 * ------------------------------------------------------------------ */

function googleMetrics(groups) {
  const metrics = [];
  for (const group of groups) {
    const groupName = typeof group?.name === "string" ? group.name : "Google";
    for (const bucket of group?.buckets ?? []) {
      const window = bucket?.window === "weekly" ? "周" : bucket?.window === "5h" ? "5h" : String(bucket?.window ?? "");
      metrics.push({
        key: String(bucket?.id ?? `${groupName}-${window}`),
        group: groupName,
        label: window,
        percent:
          typeof bucket?.remainingPercent === "number"
            ? bucket.remainingPercent
            : typeof bucket?.remainingFraction === "number"
              ? Math.round(bucket.remainingFraction * 10000) / 100
              : null,
        resetTime: typeof bucket?.resetTime === "string" ? bucket.resetTime : undefined,
      });
    }
  }
  return metrics;
}

function workBuddyMetrics(credits) {
  if (credits.unlimited) {
    return [{ key: "credits", label: "剩余积分", percent: null, remaining: null, total: null, unlimited: true }];
  }
  const percent =
    typeof credits.remaining === "number" && typeof credits.total === "number" && credits.total > 0
      ? Math.round((credits.remaining / credits.total) * 10000) / 100
      : null;
  return [
    {
      key: "credits",
      label: "剩余积分",
      percent,
      remaining: credits.remaining,
      total: credits.total,
      resetTime: credits.resetTime,
    },
  ];
}

/* ------------------------------------------------------------------ *
 * Source configuration
 * ------------------------------------------------------------------ */

export function defaultSources() {
  return [];
}

/** Validate and normalise one user-supplied source. */
export function normaliseSource(raw, index) {
  const kind = raw?.kind === "google" ? "google" : "workbuddy";
  const id =
    typeof raw?.id === "string" && raw.id.trim() !== ""
      ? raw.id.trim()
      : `${kind}-${index + 1}`;
  const label =
    typeof raw?.label === "string" && raw.label.trim() !== ""
      ? raw.label.trim()
      : kind === "google"
        ? `Google ${index + 1}`
        : `WorkBuddy ${index + 1}`;
  return {
    id,
    kind,
    label,
    apiKey: typeof raw?.apiKey === "string" ? raw.apiKey.trim() : "",
    baseUrl: typeof raw?.baseUrl === "string" ? raw.baseUrl.trim() : "",
    token: typeof raw?.token === "string" ? raw.token.trim() : "",
  };
}

/**
 * Read the source list from disk.
 *
 * Deliberately uncached: the file is tiny, it can be edited by hand or by a
 * second DSH window, and a stale cache made a just-saved source invisible until
 * restart. Reading it fresh on every call removes that whole class of bug.
 */
export async function loadSources() {
  try {
    const text = await readFile(sourcesFilePath(), "utf8");
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed?.sources) ? parsed.sources : [];
    return list.map(normaliseSource);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      // A corrupt file must not wedge the plugin; start empty and let the user re-save.
      console.error("[dsh-quota] could not read sources, starting empty:", error?.message);
    }
    return defaultSources();
  }
}

export async function saveSources(list) {
  const normalised = list.map(normaliseSource);
  const path = sourcesFilePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({ version: 1, sources: normalised }, null, 2) + "\n",
    { encoding: "utf8", mode: 0o600 },
  );
  return normalised;
}

/* ------------------------------------------------------------------ *
 * Refresh orchestration
 * ------------------------------------------------------------------ */

/** Last known state per source, so a failed refresh keeps the previous numbers. */
const lastGood = new Map();

async function refreshOne(source) {
  const base = {
    id: source.id,
    kind: source.kind,
    label: source.label,
    refreshedAt: new Date().toISOString(),
  };

  try {
    if (source.kind === "google") {
      if (!source.baseUrl) throw new Error("尚未填写 Base URL / Base URL is not set");
      if (!source.token) throw new Error("尚未填写 Token / Token is not set");
      const quota = await fetchGoogleQuota(source.baseUrl, source.token);
      const state = {
        ...base,
        status: "ok",
        error: null,
        account: quota.account ?? null,
        metrics: googleMetrics(quota.groups),
      };
      lastGood.set(source.id, state);
      return state;
    }

    if (!source.apiKey) throw new Error("尚未填写 API Key / API key is not set");
    const identity = await fetchWorkBuddyAccounts(source.apiKey);
    const credits = await fetchWorkBuddyCredits(source.apiKey, identity);
    const state = {
      ...base,
      status: "ok",
      error: null,
      account: identity.nickname || null,
      enterpriseName: identity.enterpriseName || null,
      metrics: workBuddyMetrics(credits),
    };
    lastGood.set(source.id, state);
    return state;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const previous = lastGood.get(source.id);
    return {
      ...base,
      status: "error",
      error: message,
      // Keep showing the last good numbers, clearly marked stale by refreshedAt.
      account: previous?.account ?? null,
      metrics: previous?.metrics ?? [],
      stale: previous !== undefined,
    };
  }
}

export async function collectState(sourceId) {
  const sources = await loadSources();
  const targets =
    typeof sourceId === "string" && sourceId !== ""
      ? sources.filter((item) => item.id === sourceId)
      : sources;
  if (typeof sourceId === "string" && sourceId !== "" && targets.length === 0) {
    throw new Error(`unknown source: ${sourceId}`);
  }
  const results = await Promise.all(targets.map(refreshOne));
  return {
    ok: true,
    updatedAt: new Date().toISOString(),
    sources: sources.map((source) => {
      const fresh = results.find((item) => item.id === source.id);
      if (fresh) return fresh;
      // Not refreshed this round: report the last known state, or a placeholder.
      const known = lastGood.get(source.id);
      return (
        known ?? {
          id: source.id,
          kind: source.kind,
          label: source.label,
          status: "loading",
          error: null,
          refreshedAt: null,
          metrics: [],
        }
      );
    }),
  };
}

/* ------------------------------------------------------------------ *
 * HTTP plumbing
 * ------------------------------------------------------------------ */

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.length),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Hosts that count as loopback.
 *
 * A loopback *bind* is not by itself a trust boundary: any local process — or
 * a page that uses DNS rebinding to point its own hostname at 127.0.0.1 — can
 * reach the port. So the Host header (and, when a browser sends one, the
 * Origin) is what actually has to be loopback. Non-browser callers such as the
 * plugin's own `fetch` send no Origin, which is allowed.
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function hostnameOfHost(host) {
  const trimmed = String(host).trim();
  // Strip the port: "[::1]:8080" and "127.0.0.1:8080" both reduce to a host.
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end === -1 ? trimmed : trimmed.slice(0, end + 1);
  }
  const colon = trimmed.lastIndexOf(":");
  // A bare IPv6 literal has several colons and no port.
  if (colon !== -1 && trimmed.indexOf(":") === colon) return trimmed.slice(0, colon);
  return trimmed;
}

function hostIsLoopback(host) {
  if (host === undefined || String(host).trim() === "") return false;
  return LOOPBACK_HOSTS.has(hostnameOfHost(host));
}

function originIsLoopback(origin) {
  if (origin === undefined || String(origin).trim() === "") return true;
  try {
    const { hostname } = new URL(origin);
    return LOOPBACK_HOSTS.has(hostname) || hostname === "::1";
  } catch {
    return false;
  }
}

/**
 * Trust decision for these routes.
 *
 * Requires a loopback Host and, if a browser sent one, a loopback Origin. The
 * socket address is checked too when it is available, as defence in depth, but
 * is not the primary signal.
 */
function isTrusted(req) {
  if (!hostIsLoopback(req.headers?.host)) return false;
  if (!originIsLoopback(req.headers?.origin)) return false;
  const address = req.socket?.remoteAddress;
  if (typeof address === "string" && address !== "") {
    const normalised = address.startsWith("::ffff:") ? address.slice(7) : address;
    if (!LOOPBACK_HOSTS.has(normalised) && normalised !== "::1") return false;
  }
  return true;
}

function createHandler() {
  return async (req, res) => {
    try {
      if (!isTrusted(req)) {
        sendJson(res, 403, { ok: false, error: "request-not-trusted" });
        return;
      }
      const path = String(req.url ?? "").split("?")[0].replace(/\/+$/, "") || "/";

      if (path === STATE_PATH && req.method === "GET") {
        sendJson(res, 200, await collectState());
        return;
      }

      if (path === REFRESH_PATH && req.method === "POST") {
        const raw = await readBody(req);
        let sourceId = "";
        if (raw.trim() !== "") {
          const parsed = JSON.parse(raw);
          if (typeof parsed?.sourceId === "string") sourceId = parsed.sourceId;
        }
        sendJson(res, 200, await collectState(sourceId));
        return;
      }

      if (path === SOURCES_PATH) {
        if (req.method === "GET") {
          sendJson(res, 200, { ok: true, sources: await loadSources() });
          return;
        }
        if (req.method === "PUT") {
          const raw = await readBody(req);
          const parsed = JSON.parse(raw || "{}");
          const list = Array.isArray(parsed?.sources) ? parsed.sources : [];
          const saved = await saveSources(list);
          sendJson(res, 200, { ok: true, sources: saved });
          return;
        }
        sendJson(res, 405, { ok: false, error: "method not allowed" });
        return;
      }

      sendJson(res, 404, { ok: false, error: "not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[dsh-quota] route failed:", message);
      sendJson(res, 500, { ok: false, error: message });
    }
  };
}

/* ------------------------------------------------------------------ *
 * Plugin entry
 * ------------------------------------------------------------------ */

export function apply(ctx) {
  ctx.inject(["webServer"], (webCtx) => {
    for (const route of [STATE_PATH, REFRESH_PATH, SOURCES_PATH]) {
      ctx.effect(() => {
        const dispose = webCtx.webServer.register({
          kind: "exact",
          path: route,
          handler: createHandler(),
        });
        return () => dispose();
      }, `dsh-quota: route ${route}`);
    }
  });
}

/* Re-exported for tests. */
export const __internals = {
  STATE_PATH,
  REFRESH_PATH,
  SOURCES_PATH,
  WORKBUDDY_ORIGINS,
  LOOPBACK_HOSTS,
  createHandler,
  hostIsLoopback,
  originIsLoopback,
  hostnameOfHost,
  isTrusted,
  lastGood,
};

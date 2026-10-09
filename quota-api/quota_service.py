#!/usr/bin/env python3
"""
Quota API — exposes Google Antigravity (agy) 5h / weekly quota as JSON over HTTPS.

Design notes
------------
* Runs as root by necessity: `agy` reads its OAuth token from /root/.gemini,
  which is mode 700 root-only. The unit therefore applies sandboxing instead
  (see quota-api.service).
* No caching, by explicit requirement: every authenticated request really
  executes `agy -p "/usage"`. Requests are serialised by a lock so concurrent
  callers cannot stack up agy processes (each takes ~6s and ~117MB RSS on a
  1.9GB box).
* Token is compared in constant time and travels only in a header, never in the
  query string, so it cannot leak into access logs.
"""

import hmac
import json
import logging
import os
import re
import ssl
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("QUOTA_PORT", "28317"))
TOKEN_PATH = os.environ.get("QUOTA_TOKEN_FILE", "/opt/quota-api/token")
CERT_PATH = os.environ.get("QUOTA_CERT", "/opt/cliproxyapi/certs/fullchain.pem")
KEY_PATH = os.environ.get("QUOTA_KEY", "/opt/cliproxyapi/certs/privkey.pem")
AGY_BIN = os.environ.get("QUOTA_AGY", "/root/.local/bin/agy")
OAUTH_TOKEN = "/root/.gemini/antigravity-cli/antigravity-oauth-token"

AGY_TIMEOUT = 90          # agy normally returns in ~6s
MAX_LOCK_WAIT = 45        # after this, answer 503 instead of queueing forever
RATE_WINDOW = 60.0
RATE_MAX = 20             # requests per window per client IP

TOKEN_HEADER = "X-Quota-Token"

log = logging.getLogger("quota-api")

_agy_lock = threading.Lock()
_rate_lock = threading.Lock()
_rate_state: dict[str, list[float]] = {}


def load_token() -> str:
    try:
        with open(TOKEN_PATH, "r", encoding="utf-8") as fh:
            token = fh.read().strip()
    except OSError as exc:
        log.error("cannot read token file %s: %s", TOKEN_PATH, exc)
        return ""
    if len(token) < 16:
        log.error("token file %s is too short to be a real secret", TOKEN_PATH)
        return ""
    return token


def read_email() -> str | None:
    """Best-effort: report which Google account the quota belongs to."""
    try:
        with open(OAUTH_TOKEN, "r", encoding="utf-8") as fh:
            doc = json.load(fh)
        import base64

        id_token = doc.get("id_token") or ""
        payload = id_token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        claims = json.loads(base64.urlsafe_b64decode(payload))
        return claims.get("email")
    except Exception:
        return None


def parse_agy_json(stdout: str) -> dict:
    """agy prints pure JSON for --output-format json, but be forgiving."""
    text = stdout.strip()
    if not text:
        raise ValueError("agy produced no output")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            return json.loads(text[start : end + 1])
        raise


def normalize(doc: dict) -> list[dict]:
    command = doc.get("command") or {}
    data = command.get("data") or {}
    groups = []
    for group in data.get("groups") or []:
        buckets = []
        for bucket in group.get("buckets") or []:
            frac = bucket.get("remaining_fraction")
            buckets.append(
                {
                    "id": bucket.get("id"),
                    "name": bucket.get("name"),
                    "window": bucket.get("window"),
                    "remainingFraction": frac,
                    "remainingPercent": round(frac * 100, 2)
                    if isinstance(frac, (int, float))
                    else None,
                    "resetTime": bucket.get("reset_time"),
                    "description": bucket.get("description"),
                }
            )
        groups.append(
            {
                "name": group.get("name"),
                "description": group.get("description"),
                "buckets": buckets,
            }
        )
    if not groups:
        raise ValueError("agy response carried no quota groups")
    return groups


def fetch_quota() -> dict:
    if not _agy_lock.acquire(timeout=MAX_LOCK_WAIT):
        raise TimeoutError("another quota fetch is already running; try again shortly")
    try:
        env = dict(os.environ)
        env["HOME"] = "/root"
        started = time.time()
        proc = subprocess.run(
            [AGY_BIN, "-p", "/usage", "--output-format", "json"],
            capture_output=True,
            text=True,
            timeout=AGY_TIMEOUT,
            cwd="/root",
            env=env,
        )
        elapsed = round(time.time() - started, 2)
        if proc.returncode != 0:
            raise RuntimeError(
                f"agy exited {proc.returncode}: {(proc.stderr or '').strip()[:300]}"
            )
        doc = parse_agy_json(proc.stdout)
        return {
            "groups": normalize(doc),
            "agySeconds": elapsed,
        }
    finally:
        _agy_lock.release()


def rate_limited(client_ip: str) -> bool:
    now = time.time()
    with _rate_lock:
        hits = [t for t in _rate_state.get(client_ip, []) if now - t < RATE_WINDOW]
        if len(hits) >= RATE_MAX:
            _rate_state[client_ip] = hits
            return True
        hits.append(now)
        _rate_state[client_ip] = hits
        if len(_rate_state) > 4096:  # bound memory on a public port
            for key in list(_rate_state)[:2048]:
                if not _rate_state[key]:
                    _rate_state.pop(key, None)
        return False


class Handler(BaseHTTPRequestHandler):
    server_version = "quota-api/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # route through logging, not stderr spam
        log.info("%s - %s", self.address_string(), fmt % args)

    def _send(self, status: int, payload: dict, extra: dict | None = None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802 (stdlib naming)
        path = self.path.split("?", 1)[0].rstrip("/") or "/"

        if path == "/health":
            self._send(200, {"ok": True, "service": "quota-api"})
            return

        if path != "/quota":
            self._send(404, {"ok": False, "error": "not found"})
            return

        expected = self.server.token  # type: ignore[attr-defined]
        if not expected:
            self._send(500, {"ok": False, "error": "server token not configured"})
            return

        supplied = self.headers.get(TOKEN_HEADER, "")
        if not supplied or not hmac.compare_digest(supplied, expected):
            log.warning("rejected unauthorized request from %s", self.address_string())
            self._send(401, {"ok": False, "error": "unauthorized"})
            return

        client_ip = self.client_address[0]
        if rate_limited(client_ip):
            self._send(
                429,
                {"ok": False, "error": "rate limited"},
                {"Retry-After": str(int(RATE_WINDOW))},
            )
            return

        try:
            result = fetch_quota()
        except TimeoutError as exc:
            self._send(503, {"ok": False, "error": str(exc)})
        except subprocess.TimeoutExpired:
            self._send(504, {"ok": False, "error": f"agy exceeded {AGY_TIMEOUT}s"})
        except Exception as exc:  # noqa: BLE001 - report any upstream failure
            log.exception("quota fetch failed")
            self._send(502, {"ok": False, "error": str(exc)[:500]})
        else:
            self._send(
                200,
                {
                    "ok": True,
                    "service": "google-antigravity",
                    "account": read_email(),
                    "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "groups": result["groups"],
                    "agySeconds": result["agySeconds"],
                },
            )


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        stream=sys.stderr,
    )

    token = load_token()
    if not token:
        log.error("refusing to start without a usable token")
        return 1

    if not (os.path.exists(CERT_PATH) and os.path.exists(KEY_PATH)):
        log.error("certificate or key missing (%s / %s)", CERT_PATH, KEY_PATH)
        return 1

    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    httpd.daemon_threads = True
    httpd.token = token  # type: ignore[attr-defined]

    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(certfile=CERT_PATH, keyfile=KEY_PATH)
    httpd.socket = context.wrap_socket(httpd.socket, server_side=True)

    log.info("quota-api listening on https://0.0.0.0:%d (endpoints: /quota, /health)", PORT)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())

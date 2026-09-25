#!/usr/bin/env node
/**
 * Localhost admin API for Immobilien Eichmann.
 * Bound to 127.0.0.1 only; nginx reverse-proxies /admin/api/.
 *
 * Auth: email allowlist + password_sha256 (same as public admin/config.json)
 *       → HttpOnly Secure SameSite=Strict session cookie (HMAC-signed).
 * No GitHub PAT required for Eigen CRUD or Immowelt visibility.
 *
 * Env:
 *   EICHMANN_DB_PATH      (default /var/lib/eichmann/listings.db)
 *   EICHMANN_SITE_ROOT    (default /var/www/immobilieneichmann.de)
 *   EICHMANN_ADMIN_CONFIG (default $SITE_ROOT/admin/config.json)
 *   EICHMANN_SESSION_SECRET_FILE (default /var/lib/eichmann/admin-session.secret)
 *   EICHMANN_ADMIN_API_PORT (default 3847)
 *   EICHMANN_ADMIN_API_HOST (default 127.0.0.1)
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  openDb,
  resolveDbPath,
  upsertEigenListing,
  deleteEigenListing,
  setSiteHidden,
  listByOrigin,
  listAllListings,
  getListingById,
  exportListingsDocument,
  allSlugs,
  countByOrigin,
  ORIGIN_EIGEN,
  ORIGIN_IMMOWELT,
  REPO_ROOT,
} from "./lib/db.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.EICHMANN_ADMIN_API_HOST || "127.0.0.1";
const PORT = Number(process.env.EICHMANN_ADMIN_API_PORT || 3847);
const SITE_ROOT = path.resolve(
  process.env.EICHMANN_SITE_ROOT ||
    (fs.existsSync("/var/www/immobilieneichmann.de")
      ? "/var/www/immobilieneichmann.de"
      : REPO_ROOT)
);
const CONFIG_PATH =
  process.env.EICHMANN_ADMIN_CONFIG || path.join(SITE_ROOT, "admin", "config.json");
const SECRET_FILE =
  process.env.EICHMANN_SESSION_SECRET_FILE ||
  "/var/lib/eichmann/admin-session.secret";
const COOKIE_NAME = "eichmann_admin_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const MAX_BODY = 512 * 1024;

process.env.EICHMANN_SITE_ROOT = SITE_ROOT;

let publishLock = Promise.resolve();

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  return JSON.parse(raw);
}

function ensureSecret() {
  const dir = path.dirname(SECRET_FILE);
  if (!fs.existsSync(SECRET_FILE)) {
    fs.mkdirSync(dir, { recursive: true });
    const secret = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
    try {
      fs.chmodSync(SECRET_FILE, 0o600);
    } catch {
      /* ignore */
    }
  }
  return fs.readFileSync(SECRET_FILE, "utf8").trim();
}

const SESSION_SECRET = ensureSecret();

function sha256Hex(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromB64url(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  return Buffer.from((s + pad).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function signSession(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(
    crypto.createHmac("sha256", SESSION_SECRET).update(body).digest()
  );
  return `${body}.${sig}`;
}

function verifySession(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expect = b64url(
    crypto.createHmac("sha256", SESSION_SECRET).update(body).digest()
  );
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(fromB64url(body).toString("utf8"));
  } catch {
    return null;
  }
  if (!payload?.exp || Date.now() > payload.exp) return null;
  if (!payload?.email) return null;
  return payload;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

function normalizeEmail(e) {
  return String(e || "")
    .trim()
    .toLowerCase();
}

function emailAllowed(config, email) {
  const list = (config.admin_emails || []).map(normalizeEmail).filter(Boolean);
  if (!list.length) return true;
  return list.includes(normalizeEmail(email));
}

/** Simple per-IP rate limit (login + mutating). */
const buckets = new Map();
function rateLimit(ip, { limit = 30, windowMs = 60_000 } = {}) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now - b.start > windowMs) {
    b = { start: now, n: 0 };
    buckets.set(ip, b);
  }
  b.n += 1;
  return b.n <= limit;
}

function clientIp(req) {
  // Only trust X-Forwarded-For from local nginx
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

function sameOriginOk(req) {
  const origin = req.headers.origin;
  const host = req.headers.host || "";
  if (origin) {
    try {
      const u = new URL(origin);
      const allowed = new Set([
        "immobilieneichmann.de",
        "www.immobilieneichmann.de",
        "localhost",
        "127.0.0.1",
      ]);
      if (allowed.has(u.hostname)) return true;
      // also allow exact Host match (dev)
      if (host && u.host === host) return true;
      return false;
    } catch {
      return false;
    }
  }
  // Same-origin navigations / fetch without Origin: require Referer from our host
  const ref = req.headers.referer || req.headers.referrer;
  if (!ref) return true; // allow curl/tools from localhost
  try {
    const u = new URL(ref);
    return (
      u.hostname === "immobilieneichmann.de" ||
      u.hostname === "www.immobilieneichmann.de" ||
      u.hostname === "localhost" ||
      u.hostname === "127.0.0.1"
    );
  } catch {
    return false;
  }
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      const err = new Error("Body too large");
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return null;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return null;
  const ct = req.headers["content-type"] || "";
  if (ct.includes("application/json") || raw.startsWith("{") || raw.startsWith("[")) {
    try {
      return JSON.parse(raw);
    } catch {
      const err = new Error("Invalid JSON");
      err.status = 400;
      throw err;
    }
  }
  return raw;
}

function send(res, status, data, extraHeaders = {}) {
  const body = data === null || data === undefined ? "" : JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  res.end(body);
}

function setSessionCookie(res, token) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  return parts.join("; ");
}

function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

function requireAuth(req) {
  const cookies = parseCookies(req.headers.cookie);
  const session = verifySession(cookies[COOKIE_NAME]);
  if (!session) {
    const err = new Error("Nicht angemeldet");
    err.status = 401;
    throw err;
  }
  return session;
}

async function runPublish(db) {
  const job = publishLock.then(async () => {
    const doc = exportListingsDocument(db);
    const slugs = allSlugs(db);
    const { publishSiteFromDocument } = await import("./lib/publish.mjs");
    await publishSiteFromDocument(doc, { siteRoot: SITE_ROOT, knownSlugs: slugs });
    return { listing_count: doc.listing_count, active_listing_count: doc.active_listing_count };
  });
  // Keep chain alive even on failure
  publishLock = job.catch(() => {});
  return job;
}

function openApiDb() {
  return openDb(resolveDbPath());
}

function routePath(url) {
  const u = new URL(url, "http://127.0.0.1");
  let p = u.pathname;
  // Accept both /admin/api/... and /...
  if (p.startsWith("/admin/api")) p = p.slice("/admin/api".length) || "/";
  if (!p.startsWith("/")) p = `/${p}`;
  return { path: p, searchParams: u.searchParams };
}

async function handle(req, res) {
  const ip = clientIp(req);
  const method = req.method || "GET";

  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Credentials": "true",
    });
    return res.end();
  }

  const { path: p, searchParams } = routePath(req.url || "/");

  try {
    if (p === "/health") {
      return send(res, 200, { ok: true, service: "eichmann-admin-api" });
    }

    // Login is stricter rate-limited
    if (method === "POST" && p === "/login") {
      if (!rateLimit(ip, { limit: 10, windowMs: 60_000 })) {
        return send(res, 429, { ok: false, error: "Zu viele Versuche – bitte warten." });
      }
      if (!sameOriginOk(req)) {
        return send(res, 403, { ok: false, error: "Origin abgelehnt" });
      }
      const body = (await readBody(req)) || {};
      const email = normalizeEmail(body.email);
      const password = String(body.password || "");
      const config = loadConfig();
      if (!emailAllowed(config, email)) {
        return send(res, 403, { ok: false, error: "E-Mail nicht freigeschaltet" });
      }
      const hash = sha256Hex(password);
      const expect = String(config.password_sha256 || "").toLowerCase();
      if (!expect || hash !== expect) {
        return send(res, 401, { ok: false, error: "Passwort falsch" });
      }
      const token = signSession({
        email,
        exp: Date.now() + SESSION_TTL_MS,
        iat: Date.now(),
      });
      return send(
        res,
        200,
        { ok: true, email, auth_mode: "password_session" },
        { "Set-Cookie": setSessionCookie(res, token) }
      );
    }

    if (method === "POST" && p === "/logout") {
      return send(res, 200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
    }

    if (method === "GET" && p === "/me") {
      const cookies = parseCookies(req.headers.cookie);
      const session = verifySession(cookies[COOKIE_NAME]);
      if (!session) return send(res, 401, { ok: false, authenticated: false });
      return send(res, 200, { ok: true, authenticated: true, email: session.email });
    }

    // Everything below requires auth
    if (!rateLimit(ip, { limit: 120, windowMs: 60_000 })) {
      return send(res, 429, { ok: false, error: "Rate limit" });
    }

    const session = requireAuth(req);

    if (method !== "GET" && !sameOriginOk(req)) {
      return send(res, 403, { ok: false, error: "Origin abgelehnt" });
    }

    if (method === "GET" && p === "/listings") {
      const db = openApiDb();
      try {
        const origin = String(searchParams.get("origin") || "all").toLowerCase();
        let listings;
        if (origin === "eigen") listings = listByOrigin(db, ORIGIN_EIGEN);
        else if (origin === "immowelt") listings = listByOrigin(db, ORIGIN_IMMOWELT);
        else listings = listAllListings(db);
        const counts = countByOrigin(db);
        return send(res, 200, { ok: true, counts, listings });
      } finally {
        db.close();
      }
    }

    if (method === "GET" && p === "/status") {
      const db = openApiDb();
      let counts;
      try {
        counts = countByOrigin(db);
      } finally {
        db.close();
      }
      let sync = {};
      try {
        const statusPath = path.join(SITE_ROOT, "data", "immowelt-sync-status.json");
        if (fs.existsSync(statusPath)) {
          sync = JSON.parse(fs.readFileSync(statusPath, "utf8"));
        }
      } catch {
        /* ignore */
      }
      return send(res, 200, {
        ok: true,
        counts,
        immowelt_sync: sync,
        sot: "sqlite",
        db: resolveDbPath(),
        site_root: SITE_ROOT,
        email: session.email,
      });
    }

    if (method === "POST" && p === "/eigen") {
      const body = (await readBody(req)) || {};
      const listing = body.listing || body;
      if (!listing || typeof listing !== "object") {
        return send(res, 400, { ok: false, error: "listing object required" });
      }
      const db = openApiDb();
      try {
        const result = upsertEigenListing(db, listing);
        const saved = getListingById(db, result.id);
        const published = await runPublish(db);
        return send(res, 200, { ok: true, result, listing: saved, published });
      } finally {
        db.close();
      }
    }

    if (
      (method === "DELETE" && p === "/eigen") ||
      (method === "POST" && p === "/eigen/delete")
    ) {
      const body = (method === "POST" ? await readBody(req) : null) || {};
      const id = body.id || searchParams.get("id");
      if (!id) return send(res, 400, { ok: false, error: "id required" });
      const db = openApiDb();
      try {
        const result = deleteEigenListing(db, id);
        const published = await runPublish(db);
        return send(res, 200, { ok: true, result, published });
      } finally {
        db.close();
      }
    }

    if (method === "POST" && p === "/visibility") {
      const body = (await readBody(req)) || {};
      const id = body.id;
      if (!id) return send(res, 400, { ok: false, error: "id required" });
      if (typeof body.site_hidden !== "boolean") {
        return send(res, 400, { ok: false, error: "site_hidden boolean required" });
      }
      const db = openApiDb();
      try {
        const result = setSiteHidden(db, id, body.site_hidden);
        const saved = getListingById(db, id);
        const published = await runPublish(db);
        return send(res, 200, { ok: true, result, listing: saved, published });
      } finally {
        db.close();
      }
    }

    if (method === "POST" && p === "/publish") {
      const db = openApiDb();
      try {
        const published = await runPublish(db);
        return send(res, 200, { ok: true, published });
      } finally {
        db.close();
      }
    }

    return send(res, 404, { ok: false, error: `Unknown route ${method} ${p}` });
  } catch (e) {
    const status = e.status || 500;
    console.error(`[admin-api] ${method} ${req.url}:`, e.message || e);
    return send(res, status, { ok: false, error: e.message || String(e) });
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error("[admin-api] unhandled", e);
    try {
      send(res, 500, { ok: false, error: "Internal error" });
    } catch {
      /* ignore */
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(
    `eichmann-admin-api listening on http://${HOST}:${PORT} (site=${SITE_ROOT}, db=${resolveDbPath()}, config=${CONFIG_PATH})`
  );
});

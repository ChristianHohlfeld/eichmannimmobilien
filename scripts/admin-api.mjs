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
import { spawn } from "node:child_process";
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
  setMeta,
  getMeta,
  ORIGIN_EIGEN,
  ORIGIN_IMMOWELT,
  REPO_ROOT,
} from "./lib/db.mjs";
import {
  parseMultipart,
  storeEigenImage,
  applyGalleryToListing,
  removeEigenImageFiles,
  removeAllEigenMedia,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_LISTING,
  publicUrlForBase,
} from "./lib/eigen-images.mjs";
import {
  previewPublish,
  previewImmoweltSync,
  previewEigenUpsert,
  previewEigenDelete,
  previewVisibility,
  loadLiveListings,
} from "./lib/publish-preview.mjs";

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
const MAX_BODY = 512 * 1024; // JSON bodies
const MAX_MULTIPART = 40 * 1024 * 1024;

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


function requireConfirm(body) {
  if (!body || body.confirm !== true) {
    const err = new Error("Bitte Änderungen zuerst prüfen und freigeben.");
    err.status = 428; // Precondition Required
    err.requires_confirm = true;
    throw err;
  }
}

function changeSummaryFromPreview(preview) {
  const items = [];
  for (const x of preview.added || []) {
    items.push({ action: "hinzukommen", ...x });
  }
  for (const x of preview.removed || []) {
    items.push({ action: "wegfallen", ...x });
  }
  for (const x of preview.changed || []) {
    items.push({ action: "geändert", ...x });
  }
  for (const x of preview.visibility || []) {
    items.push({
      action: "Sichtbarkeit",
      title: x.title,
      location: x.location,
      origin: x.origin,
      detail: `${x.from} → ${x.to}`,
    });
  }
  return items;
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
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
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

    // --- Immowelt Sync (updates SQLite only; live site needs Abnahme / Übernehmen) ---
    if (method === "POST" && p === "/immowelt/sync") {
      const body = (await readBody(req)) || {};
      const appRoot = fs.existsSync("/var/lib/eichmann/app/scripts/sync-immowelt.mjs")
        ? "/var/lib/eichmann/app"
        : path.resolve(__dirname, "..");
      const script = path.join(appRoot, "scripts", "sync-immowelt.mjs");
      if (!fs.existsSync(script)) {
        return send(res, 500, { ok: false, error: "Immowelt-Sync ist hier nicht verfügbar." });
      }
      // Never auto-publish: sync writes SQLite; Chris must Übernehmen via /publish
      const env = {
        ...process.env,
        EICHMANN_DB_PATH: resolveDbPath(),
        EICHMANN_SITE_ROOT: SITE_ROOT,
        EICHMANN_AUTO_PUBLISH: "0",
      };
      const result = await new Promise((resolve) => {
        const child = spawn(process.execPath, [script], {
          cwd: appRoot,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        const timer = setTimeout(() => {
          try { child.kill("SIGTERM"); } catch { /* ignore */ }
          resolve({ timedOut: true, out, err, code: -1 });
        }, 240000);
        child.stdout.on("data", (c) => { out += c; if (out.length > 200000) out = out.slice(-100000); });
        child.stderr.on("data", (c) => { err += c; if (err.length > 80000) err = err.slice(-40000); });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ timedOut: false, out, err, code });
        });
      });
      const db = openApiDb();
      try {
        const doc = exportListingsDocument(db);
        const preview = previewImmoweltSync(SITE_ROOT, doc);
        if (!getMeta(db, "publish_pending") && preview.has_changes) {
          setMeta(
            db,
            "publish_pending",
            JSON.stringify({
              reason: "immowelt_sync",
              at: new Date().toISOString(),
              listing_count: doc.listing_count,
              active_listing_count: doc.active_listing_count,
              message: "Immowelt-Sync abgeschlossen – bitte Ist und Neu prüfen, dann Übernehmen.",
            })
          );
        }
        const pendingRaw = getMeta(db, "publish_pending");
        return send(res, 200, {
          ok: result.code === 0 || preview.has_changes,
          sync: {
            exit_code: result.code,
            timed_out: result.timedOut === true,
            log_tail: (result.out || result.err || "").split("\n").slice(-30).join("\n"),
          },
          ...preview,
          changes: changeSummaryFromPreview(preview),
          publish_pending: pendingRaw ? JSON.parse(pendingRaw) : null,
          requires_confirm: preview.has_changes,
          path: "immowelt_sync",
          message: preview.has_changes
            ? "Immowelt-Sync: bitte Ist (jetzt online) und Neu vergleichen."
            : "Immowelt-Sync: keine sichtbaren Änderungen zur Website.",
        });
      } finally {
        db.close();
      }
    }

    // --- Publish preview (no writes) ---
    if (method === "GET" && p === "/publish/preview") {
      const db = openApiDb();
      try {
        const doc = exportListingsDocument(db);
        const pendingRaw = getMeta(db, "publish_pending");
        let pending = null;
        try {
          pending = pendingRaw ? JSON.parse(pendingRaw) : null;
        } catch {
          pending = null;
        }
        const preview =
          pending?.reason === "immowelt_sync"
            ? previewImmoweltSync(SITE_ROOT, doc)
            : previewPublish(SITE_ROOT, doc);
        return send(res, 200, {
          ...preview,
          changes: changeSummaryFromPreview(preview),
          publish_pending: pending,
        });
      } finally {
        db.close();
      }
    }

    // --- Eigen upsert: preview without confirm, apply+publish with confirm:true ---
    if (method === "POST" && p === "/eigen") {
      const body = (await readBody(req)) || {};
      const listing = body.listing || body;
      if (!listing || typeof listing !== "object") {
        return send(res, 400, { ok: false, error: "Inserat-Daten fehlen" });
      }
      const db = openApiDb();
      try {
        const all = listAllListings(db);
        const preview = previewEigenUpsert(SITE_ROOT, all, {
          ...listing,
          origin: "eigen",
          source: "eigen",
        });
        if (body.confirm !== true) {
          return send(res, 200, {
            ok: true,
            preview: true,
            requires_confirm: true,
            ...preview,
            changes: changeSummaryFromPreview(preview),
          });
        }
        if (preview.empty_risk && body.allow_empty !== true) {
          return send(res, 409, {
            ok: false,
            error: "Abbruch: Danach wären keine Inserate mehr öffentlich.",
            ...preview,
            changes: changeSummaryFromPreview(preview),
          });
        }
        const result = upsertEigenListing(db, listing);
        const saved = getListingById(db, result.id);
        const published = await runPublish(db);
        setMeta(db, "publish_pending", "");
        return send(res, 200, {
          ok: true,
          confirmed: true,
          result,
          listing: saved,
          published,
          changes: changeSummaryFromPreview(preview),
        });
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
      if (!id) return send(res, 400, { ok: false, error: "Inserat-Nummer fehlt" });
      const db = openApiDb();
      try {
        const all = listAllListings(db);
        const preview = previewEigenDelete(SITE_ROOT, all, id);
        if (body.confirm !== true) {
          return send(res, 200, {
            ok: true,
            preview: true,
            requires_confirm: true,
            ...preview,
            changes: changeSummaryFromPreview(preview),
          });
        }
        if (preview.empty_risk && body.allow_empty !== true) {
          return send(res, 409, {
            ok: false,
            error: "Abbruch: Danach wären keine Inserate mehr öffentlich.",
            ...preview,
            changes: changeSummaryFromPreview(preview),
          });
        }
        const existing = getListingById(db, id);
        const result = deleteEigenListing(db, id);
        await removeAllEigenMedia(SITE_ROOT, id);
        const published = await runPublish(db);
        setMeta(db, "publish_pending", "");
        return send(res, 200, {
          ok: true,
          confirmed: true,
          result,
          deleted: existing,
          published,
          changes: changeSummaryFromPreview(preview),
        });
      } finally {
        db.close();
      }
    }

    // Multi-image upload (multipart). Updates DB gallery fields but does NOT publish.
    if (method === "POST" && p === "/eigen/images") {
      const { fields, files } = await parseMultipart(req, { maxTotalBytes: MAX_MULTIPART });
      const listingId = String(fields.id || fields.listing_id || "").trim();
      if (!listingId) return send(res, 400, { ok: false, error: "id (listing) required" });
      const uploads = files.filter((f) => f.field === "images" || f.field === "image" || f.field === "file");
      if (!uploads.length) return send(res, 400, { ok: false, error: "Keine Bilddatei ausgewählt" });

      const db = openApiDb();
      try {
        let listing = getListingById(db, listingId);
        // Allow upload before first save: create a minimal eigen stub if missing
        if (!listing) {
          const stub = {
            id: listingId,
            slug: fields.slug || `objekt-${listingId.replace(/[^a-z0-9]/gi, "").slice(0, 8) || "neu"}`,
            title: fields.title || "Neues Eigen-Inserat (Entwurf)",
            origin: "eigen",
            source: "eigen",
            active: false,
            detail_page: true,
            site_hidden: true,
            images: [],
            gallery_bases: [],
            main_image_url: null,
            image_base: null,
            sync_policy: "independent",
          };
          upsertEigenListing(db, stub);
          listing = getListingById(db, listingId);
        }
        if (listing.origin !== ORIGIN_EIGEN) {
          return send(res, 400, { ok: false, error: "Bilder nur für eigene Inserate" });
        }
        let bases = Array.isArray(listing.gallery_bases) ? [...listing.gallery_bases] : [];
        const stored = [];
        for (const file of uploads) {
          if (bases.length >= MAX_IMAGES_PER_LISTING) break;
          if (file.buffer.length > MAX_IMAGE_BYTES) {
            return send(res, 413, {
              ok: false,
              error: `Datei ${file.filename} zu groß (max ${MAX_IMAGE_BYTES / 1024 / 1024} MB)`,
            });
          }
          const one = await storeEigenImage(SITE_ROOT, listingId, file.buffer, {
            filename: file.filename,
            existingBases: bases,
          });
          bases.push(one.base);
          stored.push(one);
        }
        applyGalleryToListing(listing, bases);
        upsertEigenListing(db, listing);
        const saved = getListingById(db, listingId);
        return send(res, 200, {
          ok: true,
          published: false,
          note: "Bilder gespeichert – Website ändert sich erst nach Freigabe.",
          stored,
          listing: saved,
        });
      } finally {
        db.close();
      }
    }

    // Delete one image or reorder; no publish
    if (method === "POST" && p === "/eigen/images/delete") {
      const body = (await readBody(req)) || {};
      const id = body.id;
      const base = body.base;
      if (!id || !base) return send(res, 400, { ok: false, error: "Bildangabe fehlt" });
      const db = openApiDb();
      try {
        const listing = getListingById(db, id);
        if (!listing || listing.origin !== ORIGIN_EIGEN) {
          return send(res, 404, { ok: false, error: "Eigen-Inserat nicht gefunden" });
        }
        const bases = (listing.gallery_bases || []).filter((b) => b !== base);
        await removeEigenImageFiles(SITE_ROOT, base);
        applyGalleryToListing(listing, bases);
        upsertEigenListing(db, listing);
        return send(res, 200, {
          ok: true,
          published: false,
          listing: getListingById(db, id),
        });
      } finally {
        db.close();
      }
    }

    if (method === "POST" && p === "/eigen/images/reorder") {
      const body = (await readBody(req)) || {};
      const id = body.id;
      const order = body.gallery_bases || body.order;
      if (!id || !Array.isArray(order)) {
        return send(res, 400, { ok: false, error: "Bildreihenfolge fehlt" });
      }
      const db = openApiDb();
      try {
        const listing = getListingById(db, id);
        if (!listing || listing.origin !== ORIGIN_EIGEN) {
          return send(res, 404, { ok: false, error: "Eigen-Inserat nicht gefunden" });
        }
        const allowed = new Set(listing.gallery_bases || []);
        const next = order.filter((b) => allowed.has(b));
        for (const b of listing.gallery_bases || []) {
          if (!next.includes(b)) next.push(b);
        }
        applyGalleryToListing(listing, next);
        upsertEigenListing(db, listing);
        return send(res, 200, {
          ok: true,
          published: false,
          listing: getListingById(db, id),
        });
      } finally {
        db.close();
      }
    }

    if (method === "POST" && p === "/visibility") {
      const body = (await readBody(req)) || {};
      const id = body.id;
      if (!id) return send(res, 400, { ok: false, error: "Inserat-Nummer fehlt" });
      if (typeof body.site_hidden !== "boolean") {
        return send(res, 400, { ok: false, error: "Sichtbarkeit ungültig" });
      }
      const db = openApiDb();
      try {
        const all = listAllListings(db);
        const preview = previewVisibility(SITE_ROOT, all, id, body.site_hidden);
        if (body.confirm !== true) {
          return send(res, 200, {
            ok: true,
            preview: true,
            requires_confirm: true,
            ...preview,
            changes: changeSummaryFromPreview(preview),
          });
        }
        if (preview.empty_risk && body.allow_empty !== true) {
          return send(res, 409, {
            ok: false,
            error: "Abbruch: Danach wären keine Inserate mehr öffentlich.",
            ...preview,
            changes: changeSummaryFromPreview(preview),
          });
        }
        const result = setSiteHidden(db, id, body.site_hidden);
        const saved = getListingById(db, id);
        const published = await runPublish(db);
        setMeta(db, "publish_pending", "");
        return send(res, 200, {
          ok: true,
          confirmed: true,
          result,
          listing: saved,
          published,
          changes: changeSummaryFromPreview(preview),
        });
      } finally {
        db.close();
      }
    }

    if (method === "POST" && p === "/publish") {
      const body = (await readBody(req)) || {};
      const db = openApiDb();
      try {
        const doc = exportListingsDocument(db);
        const preview = previewPublish(SITE_ROOT, doc);
        if (body.confirm !== true) {
          return send(res, 200, {
            ok: true,
            preview: true,
            requires_confirm: true,
            ...preview,
            changes: changeSummaryFromPreview(preview),
          });
        }
        if (preview.empty_risk && body.allow_empty !== true) {
          return send(res, 409, {
            ok: false,
            error: "Abbruch: Danach wären keine Inserate mehr öffentlich.",
            ...preview,
            changes: changeSummaryFromPreview(preview),
          });
        }
        const published = await runPublish(db);
        setMeta(db, "publish_pending", "");
        return send(res, 200, {
          ok: true,
          confirmed: true,
          published,
          changes: changeSummaryFromPreview(preview),
          counts: preview.counts,
        });
      } finally {
        db.close();
      }
    }

    return send(res, 404, { ok: false, error: `Unknown route ${method} ${p}` });
  } catch (e) {
    const status = e.status || 500;
    console.error(`[admin-api] ${method} ${req.url}:`, e.message || e);
    const payload = { ok: false, error: e.message || String(e) };
    if (e.requires_confirm) payload.requires_confirm = true;
    return send(res, status, payload);
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

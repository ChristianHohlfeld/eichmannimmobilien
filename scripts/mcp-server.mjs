#!/usr/bin/env node
/**
 * Public Streamable-HTTP MCP for Immobilien Eichmann listings.
 * Bound to 127.0.0.1; nginx reverse-proxies /mcp.
 *
 * Data source: same ai/listings.json the website publishes (no second list).
 *
 * Env:
 *   EICHMANN_SITE_ROOT   (default /var/www/immobilieneichmann.de)
 *   EICHMANN_MCP_HOST    (default 127.0.0.1)
 *   EICHMANN_MCP_PORT    (default 3848)
 *   EICHMANN_LISTINGS_URL (optional override; default $SITE_ROOT/ai/listings.json via file,
 *                          fallback https://immobilieneichmann.de/ai/listings.json)
 *   EICHMANN_MCP_CACHE_MS (default 15000)
 */
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROTOCOL = "2025-03-26";
const SERVER_INFO = {
  name: "immobilien-eichmann-listings",
  version: "1.1.0",
  title: "Immobilien Eichmann – Angebote & Anfragen",
};

const HOST = process.env.EICHMANN_MCP_HOST || "127.0.0.1";
const PORT = Number(process.env.EICHMANN_MCP_PORT || 3848);
const SITE_ROOT =
  process.env.EICHMANN_SITE_ROOT || "/var/www/immobilieneichmann.de";
const LISTINGS_FILE = path.join(SITE_ROOT, "ai", "listings.json");
const LISTINGS_URL =
  process.env.EICHMANN_LISTINGS_URL ||
  "https://immobilieneichmann.de/ai/listings.json";
const FLYER_FILE = path.join(SITE_ROOT, "ai", "flyer-allmannsdorf.json");
const FLYER_URL =
  process.env.EICHMANN_FLYER_URL ||
  "https://immobilieneichmann.de/ai/flyer-allmannsdorf.json";
const FORMS_BASE =
  process.env.EICHMANN_FORMS_BASE ||
  "https://forms.digitalisierungsplanung.de/v1/immobilieneichmann";
const SITE_ORIGIN =
  process.env.EICHMANN_SITE_ORIGIN || "https://immobilieneichmann.de";
const CACHE_MS = Number(process.env.EICHMANN_MCP_CACHE_MS || 15000);

const TOOLS = [
  {
    name: "search_listings",
    description:
      "Öffentliche Kaufangebote von Immobilien Eichmann (Konstanz/Bodensee) suchen und filtern. Quelle = Live-Website ai/listings.json.",
    inputSchema: {
      type: "object",
      properties: {
        q: {
          type: "string",
          description: "Freitext in Titel, Ort, Typ, Kurzbeschreibung",
        },
        min_price_eur: { type: "number", description: "Mindestpreis in EUR" },
        max_price_eur: { type: "number", description: "Maximalpreis in EUR" },
        rooms: {
          type: "string",
          description: 'Zimmer-Filter, z.B. "3" oder "3 Zimmer"',
        },
        location: {
          type: "string",
          description: "Ort/Stadtteil, z.B. Wollmatingen, Petershausen",
        },
        type: {
          type: "string",
          description: "Objekttyp, z.B. Wohnung, Penthouse, Maisonette",
        },
        limit: {
          type: "number",
          description: "Max. Treffer (default 20, max 50)",
        },
      },
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "get_listing",
    description:
      "Ein öffentliches Kaufangebot per slug oder id aus dem Live-Index laden.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "URL-Slug des Objekts" },
        id: { type: "string", description: "Listing-UUID / Immowelt-ID" },
      },
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "get_flyer",
    description:
      "Neubauprojekt-Flyer Konstanz-Allmannsdorf laden (5 Mehrfamilienhäuser, 44 Wohnungen, Seesicht). Quelle = ai/flyer-allmannsdorf.json – keine erfundenen Einzelwohnungen.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "submit_inquiry",
    description:
      "Interessenten-Anfrage / Lead an Immobilien Eichmann senden. flow=contact (allgemein oder Vormerkung Allmannsdorf) oder flow=expose (Exposé zu einem Kaufobjekt). Nutzt dieselben Formular-Endpoints wie die Website. privacy_consent=true erforderlich (Datenschutz).",
    inputSchema: {
      type: "object",
      properties: {
        flow: {
          type: "string",
          description: '"contact" (Kontakt/Vormerkung) oder "expose" (Exposé-Anfrage)',
        },
        name: { type: "string", description: "Nachname (contact: voller Name; expose: Nachname)" },
        email: { type: "string", description: "E-Mail (Pflicht)" },
        phone: { type: "string", description: "Telefon (optional)" },
        message: {
          type: "string",
          description: "Nachricht (Pflicht bei flow=contact)",
        },
        anliegen: {
          type: "string",
          description:
            'Betreff, z.B. "Vormerkung Neubau Allmannsdorf", "Vermittlung / Kauf", "Allgemeine Anfrage"',
        },
        privacy_consent: {
          type: "boolean",
          description: "Muss true sein (Einwilligung Datenschutz / Kontaktaufnahme)",
        },
        anrede: { type: "string", description: 'expose: "Herr" | "Frau" | "Familie"' },
        vorname: { type: "string", description: "expose: Vorname" },
        strasse: { type: "string", description: "expose: Straße und Hausnummer" },
        plz: { type: "string", description: "expose: PLZ" },
        ort: { type: "string", description: "expose: Ort" },
        objekt: { type: "string", description: "expose: Objekttitel" },
        objekt_url: {
          type: "string",
          description: "expose: https://immobilieneichmann.de/objekt/<slug>.html",
        },
      },
      required: ["flow", "email", "privacy_consent"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
];

let cache = { at: 0, doc: null };

async function loadListingsDoc() {
  const now = Date.now();
  if (cache.doc && now - cache.at < CACHE_MS) return cache.doc;

  let raw = null;
  let source = "file";
  try {
    raw = await fs.readFile(LISTINGS_FILE, "utf8");
  } catch {
    source = "http";
    const res = await fetch(LISTINGS_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`listings fetch HTTP ${res.status}`);
    raw = await res.text();
  }

  const doc = JSON.parse(raw);
  if (!Array.isArray(doc.listings)) {
    throw new Error("listings.json missing listings[]");
  }
  doc._source = source;
  cache = { at: now, doc };
  return doc;
}

let flyerCache = { at: 0, doc: null };

async function loadFlyerDoc() {
  const now = Date.now();
  if (flyerCache.doc && now - flyerCache.at < CACHE_MS) return flyerCache.doc;
  let raw = null;
  let source = "file";
  try {
    raw = await fs.readFile(FLYER_FILE, "utf8");
  } catch {
    source = "http";
    const res = await fetch(FLYER_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`flyer fetch HTTP ${res.status}`);
    raw = await res.text();
  }
  const doc = JSON.parse(raw);
  if (!doc || doc.unit_count !== 44) {
    throw new Error("flyer-allmannsdorf.json missing or unit_count != 44");
  }
  doc._source = source;
  flyerCache = { at: now, doc };
  return doc;
}

function validEmail(value) {
  const s = String(value || "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

async function submitInquiry(args = {}) {
  const flow = String(args.flow || "").trim().toLowerCase();
  if (flow !== "contact" && flow !== "expose") {
    return { error: "flow muss contact oder expose sein", ok: false };
  }
  if (args.privacy_consent !== true) {
    return {
      error: "privacy_consent muss true sein (Datenschutz-Einwilligung)",
      ok: false,
    };
  }
  if (!validEmail(args.email)) {
    return { error: "E-Mail ist ungültig", ok: false };
  }

  let payload;
  if (flow === "contact") {
    const name = String(args.name || "").trim();
    const message = String(args.message || "").trim();
    if (!name) return { error: "name fehlt", ok: false };
    if (!message) return { error: "message fehlt", ok: false };
    payload = {
      name,
      email: String(args.email).trim(),
      phone: String(args.phone || "").trim(),
      anliegen: String(args.anliegen || "Allgemeine Anfrage").trim() || "Allgemeine Anfrage",
      message,
    };
  } else {
    const required = ["anrede", "vorname", "name", "strasse", "plz", "ort", "objekt", "objekt_url"];
    for (const key of required) {
      if (!String(args[key] || "").trim()) {
        return { error: `${key} fehlt`, ok: false };
      }
    }
    if (!["Herr", "Frau", "Familie"].includes(String(args.anrede).trim())) {
      return { error: 'anrede muss Herr, Frau oder Familie sein', ok: false };
    }
    payload = {
      anrede: String(args.anrede).trim(),
      vorname: String(args.vorname).trim(),
      name: String(args.name).trim(),
      strasse: String(args.strasse).trim(),
      plz: String(args.plz).trim(),
      ort: String(args.ort).trim(),
      phone: String(args.phone || "").trim(),
      email: String(args.email).trim(),
      objekt: String(args.objekt).trim(),
      objekt_url: String(args.objekt_url).trim(),
    };
  }

  const endpoint = `${FORMS_BASE}/${flow}`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Origin: SITE_ORIGIN,
      Referer: `${SITE_ORIGIN}/mcp`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (!res.ok || data.success !== true) {
    return {
      ok: false,
      http_status: res.status,
      error: data.error || data.message || `forms HTTP ${res.status}`,
      requestId: data.requestId || null,
      endpoint,
    };
  }
  return {
    ok: true,
    flow,
    requestId: data.requestId || null,
    endpoint,
    anliegen: payload.anliegen || null,
    message: "Anfrage übermittelt. Immobilien Eichmann meldet sich.",
  };
}

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

function searchListings(doc, args = {}) {
  let rows = doc.listings.slice();
  const q = norm(args.q);
  if (q) {
    rows = rows.filter((L) => {
      const hay = norm(
        [L.title, L.location, L.type, L.short_description, L.rooms, L.slug].join(
          " "
        )
      );
      return hay.includes(q);
    });
  }
  if (args.location) {
    const loc = norm(args.location);
    rows = rows.filter((L) => norm(L.location).includes(loc));
  }
  if (args.type) {
    const t = norm(args.type);
    rows = rows.filter((L) => norm(L.type).includes(t));
  }
  if (args.rooms) {
    const r = String(args.rooms).replace(/[^\d.,]/g, "");
    if (r) {
      rows = rows.filter((L) => String(L.rooms || "").includes(r));
    }
  }
  if (args.min_price_eur != null && Number.isFinite(Number(args.min_price_eur))) {
    const min = Number(args.min_price_eur);
    rows = rows.filter(
      (L) => L.price_eur == null || Number(L.price_eur) >= min
    );
  }
  if (args.max_price_eur != null && Number.isFinite(Number(args.max_price_eur))) {
    const max = Number(args.max_price_eur);
    rows = rows.filter(
      (L) => L.price_eur == null || Number(L.price_eur) <= max
    );
  }
  const limit = Math.min(50, Math.max(1, Number(args.limit) || 20));
  const sliced = rows.slice(0, limit);
  return {
    count: sliced.length,
    total_matched: rows.length,
    listing_count_index: doc.listing_count,
    generated_at: doc.generated_at,
    source: doc._source,
    listings: sliced,
  };
}

function getListing(doc, args = {}) {
  const slug = args.slug ? String(args.slug).trim() : "";
  const id = args.id ? String(args.id).trim() : "";
  if (!slug && !id) {
    return { error: "slug oder id erforderlich" };
  }
  const hit = doc.listings.find(
    (L) =>
      (slug && L.slug === slug) ||
      (id && (L.id === id || String(L.id) === id))
  );
  if (!hit) return { error: "nicht gefunden", slug: slug || null, id: id || null };
  return { listing: hit, generated_at: doc.generated_at, source: doc._source };
}

function textResult(obj) {
  return {
    content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
    structuredContent: obj,
  };
}

async function callTool(name, args) {
  if (name === "get_flyer") {
    const flyer = await loadFlyerDoc();
    const { _source, ...clean } = flyer;
    return textResult({ flyer: clean, source: _source });
  }
  if (name === "submit_inquiry") {
    const out = await submitInquiry(args || {});
    if (!out.ok) {
      return {
        content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
        isError: true,
        structuredContent: out,
      };
    }
    return textResult(out);
  }
  const doc = await loadListingsDoc();
  if (name === "search_listings") return textResult(searchListings(doc, args || {}));
  if (name === "get_listing") {
    const out = getListing(doc, args || {});
    if (out.error) {
      return {
        content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
        isError: true,
        structuredContent: out,
      };
    }
    return textResult(out);
  }
  return {
    content: [{ type: "text", text: `Unknown tool: ${name}` }],
    isError: true,
  };
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleRpc(msg) {
  if (!msg || msg.jsonrpc !== "2.0") {
    return jsonRpcError(msg?.id ?? null, -32600, "Invalid Request");
  }
  const { id, method, params } = msg;

  // notifications → no response body (handled by caller)
  if (id === undefined || id === null) {
    return { __notification: true };
  }

  try {
    switch (method) {
      case "initialize":
        return jsonRpcResult(id, {
          protocolVersion: PROTOCOL,
          capabilities: {
            tools: { listChanged: false },
            resources: { listChanged: false },
          },
          serverInfo: SERVER_INFO,
          instructions:
            "Immobilien Eichmann Konstanz. Tools: search_listings, get_listing (Kaufangebote), get_flyer (Allmannsdorf 44 WE), submit_inquiry (Leads). Daten: ai/listings.json + ai/flyer-allmannsdorf.json",
        });
      case "ping":
        return jsonRpcResult(id, {});
      case "tools/list":
        return jsonRpcResult(id, { tools: TOOLS });
      case "tools/call": {
        const name = params?.name;
        const args = params?.arguments || {};
        if (!name) return jsonRpcError(id, -32602, "name required");
        const result = await callTool(name, args);
        return jsonRpcResult(id, result);
      }
      case "resources/list":
        return jsonRpcResult(id, {
          resources: [
            {
              uri: "https://immobilieneichmann.de/ai/listings.json",
              name: "listings_index",
              title: "AI Listings Index",
              mimeType: "application/json",
              description: "Schlanker öffentlicher Angebots-Index inkl. projects[] (Allmannsdorf 44 WE)",
            },
            {
              uri: "https://immobilieneichmann.de/ai/flyer-allmannsdorf.json",
              name: "flyer_allmannsdorf",
              title: "Flyer Neubau Allmannsdorf",
              mimeType: "application/json",
              description: "5 MFH / 44 Wohnungen – strukturierte Flyer-Fakten",
            },
            {
              uri: "https://immobilieneichmann.de/llms.txt",
              name: "llms_txt",
              mimeType: "text/plain",
              description: "AI-lesbare Einstiegsseite",
            },
          ],
        });
      case "resources/read": {
        const uri = params?.uri;
        if (uri === "https://immobilieneichmann.de/ai/listings.json") {
          const doc = await loadListingsDoc();
          const { _source, ...clean } = doc;
          return jsonRpcResult(id, {
            contents: [
              {
                uri,
                mimeType: "application/json",
                text: JSON.stringify(clean, null, 2),
              },
            ],
          });
        }
        if (uri === "https://immobilieneichmann.de/ai/flyer-allmannsdorf.json") {
          const flyer = await loadFlyerDoc();
          const { _source, ...clean } = flyer;
          return jsonRpcResult(id, {
            contents: [
              {
                uri,
                mimeType: "application/json",
                text: JSON.stringify(clean, null, 2),
              },
            ],
          });
        }
        if (uri === "https://immobilieneichmann.de/llms.txt") {
          const file = path.join(SITE_ROOT, "llms.txt");
          let text;
          try {
            text = await fs.readFile(file, "utf8");
          } catch {
            const res = await fetch("https://immobilieneichmann.de/llms.txt", {
              signal: AbortSignal.timeout(10000),
            });
            text = await res.text();
          }
          return jsonRpcResult(id, {
            contents: [{ uri, mimeType: "text/plain", text }],
          });
        }
        return jsonRpcError(id, -32002, `Unknown resource: ${uri}`);
      }
      case "prompts/list":
        return jsonRpcResult(id, { prompts: [] });
      default:
        return jsonRpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    return jsonRpcError(id, -32603, err?.message || String(err));
  }
}

function setCors(res, origin) {
  // Public read-only MCP; allow browser clients with explicit Origin.
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID"
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

function originAllowed(origin) {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

function isMcpPath(pathname) {
  return pathname === "/mcp" || pathname === "/mcp/" || pathname === "/";
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && !originAllowed(origin)) {
    res.writeHead(403).end("Forbidden origin");
    return;
  }
  setCors(res, origin || null);

  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  const pathname = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  if (pathname === "/health" || pathname === "/mcp/health") {
    try {
      const doc = await loadListingsDoc();
      const flyer = await loadFlyerDoc();
      sendJson(res, 200, {
        ok: true,
        service: "eichmann-mcp",
        listing_count: doc.listing_count,
        flyer_unit_count: flyer.unit_count,
        generated_at: doc.generated_at,
        source: doc._source,
        tools: ["search_listings", "get_listing", "get_flyer", "submit_inquiry"],
      });
    } catch (err) {
      sendJson(res, 503, { ok: false, error: err.message });
    }
    return;
  }

  if (!isMcpPath(pathname)) {
    res.writeHead(404).end("Not Found");
    return;
  }

  if (req.method === "GET") {
    // Stateless: no long-lived SSE GET required; advertise Method Not Allowed
    // so clients use POST Streamable HTTP.
    res.writeHead(405, { Allow: "POST, OPTIONS" }).end();
    return;
  }

  if (req.method === "DELETE") {
    // Stateless sessions — nothing to delete.
    res.writeHead(405).end();
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }

  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    res.writeHead(err.status || 400).end(err.message);
    return;
  }

  let payload;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    sendJson(res, 400, jsonRpcError(null, -32700, "Parse error"));
    return;
  }

  const messages = Array.isArray(payload) ? payload : [payload];
  const responses = [];
  let onlyNotifications = true;

  for (const msg of messages) {
    const out = await handleRpc(msg);
    if (out?.__notification) continue;
    onlyNotifications = false;
    responses.push(out);
  }

  if (onlyNotifications) {
    res.writeHead(202).end();
    return;
  }

  const body = Array.isArray(payload) ? responses : responses[0];
  sendJson(res, 200, body);
});

server.listen(PORT, HOST, () => {
  console.log(
    `eichmann-mcp listening on http://${HOST}:${PORT}/mcp (site=${SITE_ROOT}, listings=${LISTINGS_FILE})`
  );
});

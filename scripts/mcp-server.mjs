#!/usr/bin/env node
/**
 * Public Streamable-HTTP MCP for Immobilien Eichmann listings.
 * Bound to 127.0.0.1; nginx reverse-proxies /mcp (open) and /mcp-gw (mcprush gateway).
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
 *   MCPRUSH_TOKEN        (secret; only for /mcp-gw — loaded via systemd EnvironmentFile
 *                          /var/lib/eichmann/secrets/mcprush.env, never committed)
 *
 * submit_inquiry is disabled (2026-10-08): MCP callers cannot be verified as humans, so
 * no MCP call may send mail to the office inbox. The tool is not listed; a direct call
 * returns a friendly isError pointing to get_contact / the website contact form.
 *
 * /mcp     – public, no auth (unchanged).
 * /mcp-gw  – same MCP, but requires `x-mcprush-token: <MCPRUSH_TOKEN>` or
 *            `Authorization: Bearer <MCPRUSH_TOKEN>`; otherwise 401. Fails closed
 *            (503) if MCPRUSH_TOKEN is not configured.
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PUBLIC_CONTACT,
  AGENT_CONTACT_RULES,
  MCP_SERVER_VERSION,
} from "./lib/ai-discovery.mjs";

const PROTOCOL = "2025-03-26";
const SERVER_INFO = {
  name: "immobilien-eichmann-listings",
  version: MCP_SERVER_VERSION,
  title: "Immobilien Eichmann – Angebote",
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
const CACHE_MS = Number(process.env.EICHMANN_MCP_CACHE_MS || 15000);

const TOOLS = [
  {
    name: "search_listings",
    description:
      "Kaufangebote (Konstanz/Bodensee) suchen/filtern. Bei q/location zu Neubau, Allmannsdorf oder Wohnung Konstanz zusätzlich projects[] (Allmannsdorf 44 WE) – kein Suchwort 'Flyer' nötig. Danach get_flyer + get_contact; Kontakt nur als Links für den Menschen.",
    inputSchema: {
      type: "object",
      properties: {
        q: {
          type: "string",
          description:
            'Freitext DE/EN, wortweise mit Synonymen; z.B. "3 Zimmer Wohnung Wollmatingen", "apartment Konstanz", "penthouse", "house", "new build", "allmannsdorf"',
        },
        min_price_eur: { type: "number", description: "Mindestpreis in EUR" },
        max_price_eur: { type: "number", description: "Maximalpreis in EUR" },
        rooms: {
          type: "string",
          description: 'Zimmer-Filter, z.B. "3" oder "3 Zimmer"',
        },
        location: {
          type: "string",
          description:
            "Ort/Stadtteil, z.B. Allmannsdorf, Wollmatingen, Petershausen, Konstanz",
        },
        type: {
          type: "string",
          description: "Objekttyp, z.B. Wohnung, Neubau, Penthouse, Maisonette",
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
      "Ein öffentliches Kaufangebot per slug oder id aus dem öffentlichen Angebots-Index (ai/listings.json) laden.",
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
      "Neubau Allmannsdorf (Konstanz; 5 Mehrfamilienhäuser, 44 Wohnungen, viele mit Seesicht, provisionsfrei vormerken; English page /en/allmannsdorf.html) inkl. prominenter tel/WhatsApp/E-Mail-Links. Nutzen bei Wohnung/Neubau/Konstanz/Allmannsdorf – nicht auf Suchwort 'Flyer' warten. Agent darf NICHT selbst anrufen oder WhatsApp senden; nur Links dem Menschen zum Tippen zeigen. Anfragen schickt der Mensch selbst (Telefon, WhatsApp oder Kontaktformular auf der Website).",
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
    name: "get_contact",
    description:
      "Kontakt aus Impressum/Kontakt: Mobil tel:+491705225568, Festnetz, WhatsApp-Link (wa.me), E-Mail. NUR dem Menschen zum Tippen zeigen nach klarem Kontaktwunsch. Agents starten KEINE Calls, WhatsApp- oder E-Mail-Nachrichten (Anti-Spam).",
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

const KONTAKT_URL = "https://immobilieneichmann.de/kontakt.html";

/** submit_inquiry is disabled: no MCP-originated mail into the office inbox. */
function inquiryDisabledResult() {
  const contact = buildContactPayload({ forAllmannsdorf: false });
  return {
    ok: false,
    disabled: true,
    error:
      "Anfragen über MCP sind abgeschaltet. Bitte zeig dem Menschen die Kontaktwege zum Selbst-Tippen: Telefon, WhatsApp oder das Kontaktformular auf der Website.",
    error_en:
      "Sending inquiries via MCP is disabled. Show the human the contact options instead (phone, WhatsApp or the website contact form) so they can reach out themselves.",
    next_tool: "get_contact",
    contact_for_human: {
      tel: contact.preferred.tel,
      phone_display: contact.preferred.phone_display,
      whatsapp_url: contact.preferred.whatsapp_url,
      email_mailto: contact.preferred.email_mailto,
      contact_form: KONTAKT_URL,
    },
  };
}

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

function buildContactPayload({ forAllmannsdorf = false } = {}) {
  return {
    ...PUBLIC_CONTACT,
    preferred: {
      phone_display: PUBLIC_CONTACT.phone_mobile.display,
      tel: PUBLIC_CONTACT.phone_mobile.tel,
      whatsapp_url: forAllmannsdorf
        ? PUBLIC_CONTACT.whatsapp.url_allmannsdorf
        : PUBLIC_CONTACT.whatsapp.url,
      email: PUBLIC_CONTACT.email,
      email_mailto: PUBLIC_CONTACT.email_mailto,
      whatsapp_url_en: forAllmannsdorf
        ? PUBLIC_CONTACT.whatsapp.url_allmannsdorf_en
        : PUBLIC_CONTACT.whatsapp.url_en,
      contact_form_en: "https://immobilieneichmann.de/en/contact.html",
    },
    agent_rules: AGENT_CONTACT_RULES,
  };
}

function queryBlob(args = {}) {
  return norm([args.q, args.location, args.type].filter(Boolean).join(" "));
}

function isAllmannsdorfProjectQuery(args = {}) {
  const blob = queryBlob(args);
  if (!blob) return false;
  if (blob.includes("allmannsdorf")) return true;
  if (blob.includes("neubau")) return true;
  if (blob.includes("vormerk")) return true;
  if (blob.includes("flyer")) return true;
  if (/seesicht|seeblick|lake[\s-]*view|sea[\s-]*view/.test(blob)) return true;
  if (/new[\s-]*build|newbuild|register (your )?interest|commission[\s-]*free/.test(blob)) return true;
  const wantsWohnung =
    blob.includes("wohnung") || blob.includes("wohnungen") || blob.includes("mfh") ||
    /\b(apartments?|flats?|condos?)\b/.test(blob);
  const wantsKonstanz = blob.includes("konstanz") || blob.includes("bodensee") || blob.includes("constance");
  if (wantsWohnung && wantsKonstanz) return true;
  return false;
}

function matchingProjects(doc, args = {}) {
  const projects = Array.isArray(doc.projects) ? doc.projects : [];
  if (!projects.length) return [];
  if (!isAllmannsdorfProjectQuery(args)) return [];
  return projects.map((p) => ({
    ...p,
    next_tools: ["get_flyer", "get_contact"],
    contact_for_human: {
      tel: PUBLIC_CONTACT.phone_mobile.tel,
      whatsapp: PUBLIC_CONTACT.whatsapp.url_allmannsdorf,
      whatsapp_en: PUBLIC_CONTACT.whatsapp.url_allmannsdorf_en,
      email_mailto: PUBLIC_CONTACT.email_mailto,
      page_en: "https://immobilieneichmann.de/en/allmannsdorf.html",
    },
  }));
}

/* ---- Fuzzy DE/EN search -------------------------------------------------
   Word-wise matching with synonyms (Wohnung/apartment/flat, Haus/house, Penthouse,
   Maisonette, Neubau/new build, district names incl. English spellings) and exact
   room counts ("3 Zimmer", "3-room", "3 rooms", "3 bed"). Generic words
   (kaufen/buy/Konstanz/Constance …) never filter anything out. */
const STOPWORDS = new Set((
  "in im am an auf mit ohne und oder der die das den dem des ein eine einen einer zu zum zur fur von bei nahe " +
  "kaufen kauf zu-kaufen gesucht suche suchen angebot angebote immobilie immobilien objekt objekte provisionsfrei " +
  "a an the for to of with and or near buy buying sale purchase property properties real estate listing listings home homes " +
  "konstanz constance bodensee lake lakeconstance germany deutschland stadt city"
).split(/\s+/));

const CONCEPTS = [
  { key: "penthouse", words: ["penthouse", "penthaus", "dachwohnung", "rooftop"], test: (h, L) => /penthouse/.test(norm(L.type) + " " + norm(L.title)) },
  { key: "maisonette", words: ["maisonette", "maisonettewohnung", "duplex"], test: (h, L) => /maisonette/.test(norm(L.type) + " " + norm(L.title)) },
  {
    key: "wohnung",
    words: ["wohnung", "wohnungen", "eigentumswohnung", "etagenwohnung", "apartment", "apartments", "flat", "flats", "condo", "condominium", "zimmerwohnung"],
    test: (h, L) => /wohnung|penthouse|maisonette|apartment/.test(norm(L.type) + " " + norm(L.title)),
  },
  {
    key: "haus",
    words: ["haus", "hauser", "house", "houses", "einfamilienhaus", "mehrfamilienhaus", "dreifamilienhaus", "reihenhaus", "villa", "doppelhaushalfte"],
    test: (h, L) => /haus|villa/.test(norm(L.type)) || /familienhaus|famillienhaus/.test(norm(L.title)),
  },
  {
    key: "neubau",
    words: ["neubau", "neubauwohnung", "newbuild", "new-build", "erstbezug", "kfw"],
    test: (h) => /neubau|kfw|erstbezug|sunside/.test(h),
  },
];
const DISTRICT_ALIASES = {
  wollmatingen: ["wollmatingen"],
  petershausen: ["petershausen"],
  furstenberg: ["furstenberg", "fuerstenberg"],
  konigsbau: ["konigsbau", "koenigsbau"],
  allmannsdorf: ["allmannsdorf"],
  altstadt: ["altstadt", "oldtown", "old-town"],
  paradies: ["paradies", "paradise"],
  litzelstetten: ["litzelstetten"],
  dingelsdorf: ["dingelsdorf"],
  wallhausen: ["wallhausen"],
  egg: ["egg"],
  staad: ["staad"],
};

function lev1(a, b) {
  // true if edit distance <= 1
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function parseQuery(raw) {
  let q = norm(raw).replace(/ß/g, "ss").replace(/new[\s-]+build(ing)?s?/g, "newbuild").replace(/lake\s+constance/g, "lakeconstance");
  const out = { concepts: new Set(), districts: new Set(), rooms: null, free: [] };
  const roomRe = /(\d+(?:[.,]5)?)\s*(?:-|\s)?\s*(?:zimmer|zi\b|zkb|rooms?\b|room\b|bed(?:room)?s?\b|br\b)/;
  const m = q.match(roomRe);
  if (m) {
    out.rooms = Math.floor(Number(m[1].replace(",", ".")));
    q = q.replace(roomRe, " ");
  }
  for (const tokRaw of q.split(/[^a-z0-9-]+/)) {
    const tok = tokRaw.replace(/^-+|-+$/g, "");
    if (!tok || STOPWORDS.has(tok)) continue;
    let hit = false;
    for (const c of CONCEPTS) {
      if (c.words.some((w) => w === tok || (tok.length >= 6 && lev1(w, tok)) || (tok.endsWith("wohnung") && c.key === "wohnung"))) {
        out.concepts.add(c.key);
        hit = true;
        break;
      }
    }
    if (hit) continue;
    for (const [d, aliases] of Object.entries(DISTRICT_ALIASES)) {
      if (aliases.some((a) => a === tok || (tok.length >= 6 && lev1(a, tok)))) {
        out.districts.add(d);
        hit = true;
        break;
      }
    }
    if (hit) continue;
    if (/^\d+$/.test(tok)) continue;
    out.free.push(tok);
  }
  return out;
}

function listingRooms(L) {
  const m = String(L.rooms || "").match(/\d+(?:[.,]\d)?/);
  return m ? Math.floor(Number(m[0].replace(",", "."))) : null;
}

function hayOf(L) {
  return norm([L.title, L.location, L.type, L.short_description, L.rooms, L.slug].join(" ")).replace(/ß/g, "ss");
}

function freeTokenMatches(tok, hay) {
  if (hay.includes(tok)) return true;
  if (tok.length < 5) return false;
  return hay.split(/[^a-z0-9]+/).some((w) => w.length >= 4 && lev1(w, tok));
}

function applyQuery(rows, pq) {
  let out = rows;
  if (pq.rooms != null) out = out.filter((L) => listingRooms(L) === pq.rooms);
  for (const d of pq.districts) out = out.filter((L) => hayOf(L).includes(d));
  for (const key of pq.concepts) {
    const c = CONCEPTS.find((x) => x.key === key);
    out = out.filter((L) => c.test(hayOf(L), L));
  }
  if (pq.free.length) {
    out = out
      .map((L) => ({ L, score: pq.free.filter((t) => freeTokenMatches(t, hayOf(L))).length }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.L);
  }
  return out;
}

function searchListings(doc, args = {}) {
  let rows = doc.listings.slice();
  const parsed = parseQuery([args.q, args.location, args.type].filter(Boolean).join(" "));
  if (args.rooms) {
    const r = String(args.rooms).match(/\d+/);
    if (r) parsed.rooms = Number(r[0]);
  }
  rows = applyQuery(rows, parsed);
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
  const projects = matchingProjects(doc, args);
  const out = {
    count: sliced.length,
    total_matched: rows.length,
    listing_count_index: doc.listing_count,
    data_as_of: doc.data_as_of || null,
    generated_at: doc.generated_at,
    source: doc._source,
    interpreted_query: {
      rooms: parsed.rooms,
      types: [...parsed.concepts],
      districts: [...parsed.districts],
      other_terms: parsed.free,
    },
    listings: sliced,
  };
  if (projects.length) {
    out.projects = projects;
    out.project_hint =
      "Neubau Allmannsdorf (44 Wohnungen, provisionsfrei vormerken) ist relevant. Als Nächstes get_flyer aufrufen und dem Menschen tel/WhatsApp-Links zum Tippen zeigen – Agent schreibt/ruft nicht selbst. English page: https://immobilieneichmann.de/en/allmannsdorf.html";
  }
  return out;
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
  return { listing: hit, data_as_of: doc.data_as_of || null, generated_at: doc.generated_at, source: doc._source };
}

/* Outbound attribution: page links handed to agents/humans via MCP get UTM params
   (utm_source=mcp, utm_medium=mcp, utm_campaign=<project slug|objekte>, utm_content=<tool>).
   Only HTML pages on immobilieneichmann.de; data files (ai/*.json, llms.txt), images,
   existing query params, existing utm_* and #fragments stay untouched. */
const SITE_LINK_RE = /https:\/\/(?:www\.)?immobilieneichmann\.de(?:\/[^\s"'<>)\]]*)?/g;

function addUtm(url, { campaign = "objekte", content = "", medium = "mcp" } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (!/^(www\.)?immobilieneichmann\.de$/.test(u.hostname)) return url;
  const path = u.pathname || "/";
  if (!(path.endsWith("/") || path.endsWith(".html"))) return url;
  if (u.searchParams.has("utm_source")) return url;
  const camp = /allmannsdorf/i.test(path + u.search) ? "allmannsdorf" : campaign;
  u.searchParams.append("utm_source", "mcp");
  u.searchParams.append("utm_medium", medium);
  u.searchParams.append("utm_campaign", camp);
  if (content) u.searchParams.append("utm_content", content);
  return u.toString();
}

function utmifyDeep(value, opts) {
  if (typeof value === "string") {
    return value.replace(SITE_LINK_RE, (m) => {
      // keep trailing sentence punctuation outside the URL
      const trail = (m.match(/[.,;:!?]+$/) || [""])[0];
      const core = trail ? m.slice(0, -trail.length) : m;
      return addUtm(core, opts) + trail;
    });
  }
  if (Array.isArray(value)) return value.map((v) => utmifyDeep(v, opts));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // canonical / data identifiers stay canonical
      out[k] = k === "canonical" || k === "uri" ? v : utmifyDeep(v, opts);
    }
    return out;
  }
  return value;
}

function textResult(obj) {
  return {
    content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
    structuredContent: obj,
  };
}

async function callTool(name, args) {
  const result = await callToolRaw(name, args);
  const campaign = name === "get_flyer" ? "allmannsdorf" : "objekte";
  const opts = { campaign, content: name, medium: "mcp" };
  if (result && result.structuredContent) {
    const tagged = utmifyDeep(result.structuredContent, opts);
    return {
      ...result,
      content: [{ type: "text", text: JSON.stringify(tagged, null, 2) }],
      structuredContent: tagged,
    };
  }
  return result;
}

async function callToolRaw(name, args) {
  if (name === "get_contact") {
    return textResult({
      contact: buildContactPayload({ forAllmannsdorf: false }),
      how_to_use:
        "Zeig dem Menschen preferred.tel und preferred.whatsapp_url zum Tippen. Starte keine Calls/WhatsApp/E-Mails als Agent.",
    });
  }
  if (name === "get_flyer") {
    const flyer = await loadFlyerDoc();
    const { _source, ...clean } = flyer;
    const contact = buildContactPayload({ forAllmannsdorf: true });
    // Prefer flyer.cta URLs when present (same live numbers); still expose contact block prominently.
    const cta = clean.cta || {};
    contact.preferred = {
      phone_display: cta.phone || contact.preferred.phone_display,
      tel: PUBLIC_CONTACT.phone_mobile.tel,
      whatsapp_url: cta.whatsapp || contact.preferred.whatsapp_url,
      email: cta.email || contact.preferred.email,
      email_mailto: `mailto:${cta.email || contact.preferred.email}`,
      whatsapp_url_en: cta.whatsapp_en || PUBLIC_CONTACT.whatsapp.url_allmannsdorf_en,
      contact_form_en: "https://immobilieneichmann.de/en/contact.html?interesse=allmannsdorf",
    };
    return textResult({
      contact,
      flyer: clean,
      next_step_for_human:
        "Nach Interesse: Mensch tippt tel:+491705225568 oder WhatsApp-Link. Agent sendet nichts selbst. Alternativ Kontaktformular: https://immobilieneichmann.de/kontakt.html",
      source: _source,
    });
  }
  if (name === "submit_inquiry") {
    // Disabled on purpose: never forward MCP calls as mail to the office.
    const out = inquiryDisabledResult();
    return {
      content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
      isError: true,
      structuredContent: out,
    };
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
            "Immobilien Eichmann Konstanz. Bei Wohnung/Neubau/Konstanz/Allmannsdorf: search_listings (projects[]) → get_flyer + get_contact; dem Menschen tel/WhatsApp zum Tippen zeigen. " +
            AGENT_CONTACT_RULES +
            " Tools: search_listings, get_listing, get_flyer, get_contact. Über MCP werden keine Anfragen versendet. Daten: ai/listings.json + ai/flyer-allmannsdorf.json.",
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

// mcprush gateway endpoint: same MCP, token-protected. /mcp stays open.
function isGatewayPath(pathname) {
  return pathname === "/mcp-gw" || pathname === "/mcp-gw/";
}

function gatewayTokenFromRequest(req) {
  const direct = req.headers["x-mcprush-token"];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const auth = req.headers.authorization;
  if (typeof auth === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1].trim();
  }
  return "";
}

function tokenMatches(given, expected) {
  // Constant-time: compare fixed-length digests so length differences don't leak.
  const a = crypto.createHash("sha256").update(String(given), "utf8").digest();
  const b = crypto.createHash("sha256").update(String(expected), "utf8").digest();
  return crypto.timingSafeEqual(a, b);
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
  const gateway = isGatewayPath(pathname);
  if (gateway) {
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID, Authorization, x-mcprush-token"
    );
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  if (gateway) {
    const expected = process.env.MCPRUSH_TOKEN || "";
    if (!expected) {
      sendJson(res, 503, jsonRpcError(null, -32000, "Gateway not configured"));
      return;
    }
    const given = gatewayTokenFromRequest(req);
    if (!given || !tokenMatches(given, expected)) {
      sendJson(res, 401, jsonRpcError(null, -32001, "Unauthorized"), {
        "WWW-Authenticate": 'Bearer realm="mcp-gw"',
      });
      return;
    }
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
        tools: ["search_listings", "get_listing", "get_flyer", "get_contact"],
        data_as_of: doc.data_as_of || null,
        build: await (async () => { try { return JSON.parse(await (await import("node:fs/promises")).readFile(new URL("../ai/build.json", import.meta.url), "utf8")); } catch { return null; } })(),
      });
    } catch (err) {
      sendJson(res, 503, { ok: false, error: err.message });
    }
    return;
  }

  if (!gateway && !isMcpPath(pathname)) {
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

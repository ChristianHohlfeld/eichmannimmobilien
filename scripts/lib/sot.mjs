/**
 * Single source of truth (SSOT) – the only module that reads data/sot/.
 *
 *   data/sot/contact.json   Name, Adresse, Nummern, E-Mail, WhatsApp-Texte je Sprache
 *   data/sot/wording.json   feste Begriffe DE/EN, Regeln (Chris), erlaubte Zahlen
 *   data/sot/projects.json  Fakten mit Beleg + Texte DE/EN mit {{fact.*}}/{{contact.*}}-Platzhaltern
 *   data/sot/listings.json  Objekt-Schicht, die uns gehört: Slug (eingefroren), Status, Prüfdatum/Prüfer,
 *                           Overrides, Ausnahmen. Felder/Exposé-Wortlaut liefert der Importer
 *                           (Immowelt/Admin → data/listings.json), sie werden hier zusammengeführt.
 *   data/sot/pages.json     Seitenregister: Pfade je Sprache, Titel, Description, Sitemap, Regel-Ausnahmen
 *   data/sot/evidence/      Belege (Flyer)
 *
 * Generated from it: data/projects.json (Kompatibilitäts-Export), DE/EN-Seiten, Objektseiten,
 * JSON-LD, sitemap.xml, llms.txt, agents.txt, ai/*.json, mcp.json, MCP-Antworten, build.json.
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SOT_FILES = ["contact", "wording", "projects", "listings", "pages"];
export const LANGS = ["de", "en"];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const cache = new Map();
export function loadSot(root = process.env.EICHMANN_SITE_ROOT || DEFAULT_ROOT, { fresh = false } = {}) {
  root = path.resolve(root);
  if (!fresh && cache.has(root)) return cache.get(root);
  const dir = path.join(root, "data", "sot");
  const raw = SOT_FILES.map((f) => readFileSync(path.join(dir, `${f}.json`), "utf8"));
  const [contact, wording, projects, listings, pages] = raw.map((s) => JSON.parse(s));
  const sot = {
    root, dir, contact, wording, pages,
    projects: projects.projects,
    listings: listings.listings,
    hash: createHash("sha256").update(raw.join("\n")).digest("hex").slice(0, 12),
  };
  sot.activeListings = sot.listings.filter((l) => l.status === "active");
  // Ältestes Prüfdatum unter den gezeigten Objekten = Datenstand, den die Website druckt.
  sot.dataAsOf = sot.activeListings.map((l) => l.verified_at).filter(Boolean).sort()[0] ?? null;
  cache.set(root, sot);
  return sot;
}

/* ---------- Kontakt ---------- */
export function whatsappUrl(sot, text) {
  return `https://wa.me/${sot.contact.phone_mobile.e164.replace(/^\+/, "")}?text=${encodeURIComponent(text)}`;
}
/** Shape used by ai-discovery / MCP (formerly hard-coded PUBLIC_CONTACT). */
export function publicContact(sot = loadSot(), origin = "https://immobilieneichmann.de") {
  const c = sot.contact;
  const ph = (p) => ({ display: p.display, e164: p.e164, tel: `tel:${p.e164}` });
  return {
    source_pages: { kontakt: origin + "/kontakt.html", impressum: origin + "/impressum.html" },
    person: c.person,
    company: c.name,
    address: `${c.address.street}, ${c.address.postal_code} ${c.address.city}`,
    email: c.email,
    email_mailto: `mailto:${c.email}`,
    phone_mobile: ph(c.phone_mobile),
    phone_landline: ph(c.phone_landline),
    whatsapp: {
      display: c.phone_mobile.display,
      url: whatsappUrl(sot, c.whatsapp_text.de),
      url_allmannsdorf: whatsappUrl(sot, c.whatsapp_text_project.de),
      url_allmannsdorf_en: whatsappUrl(sot, c.whatsapp_text_project.en),
      url_en: whatsappUrl(sot, c.whatsapp_text.en),
    },
  };
}

/* ---------- Fakten & Platzhalter ---------- */
const nf = { de: new Intl.NumberFormat("de-DE"), en: new Intl.NumberFormat("en-GB") };
const WORDS = {
  de: ["null", "eins", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun", "zehn", "elf", "zwölf"],
  en: ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"],
};
const unitOf = (f, x, lang) => {
  const n = nf[lang].format(x);
  if (f.unit === "eur") return lang === "de" ? `${n} €` : `€${n}`;
  if (f.unit === "m2") return `${n} m²`;
  return n;
};
/** One fact, formatted for a language. Numbers reach a page only through this function. */
export function formatFact(f, lang, part = null, mod = null) {
  const n = (x) => nf[lang].format(x);
  if (part) {
    const x = f[part];
    if (x == null) throw new Error(`Fakt hat kein ${part}`);
    if (mod === "n") return n(x);
    if (mod === "word") return WORDS[lang][x] ?? n(x);
    return unitOf(f, x, lang);
  }
  if (mod === "n") return f.value != null ? n(f.value) : `${n(f.min)}–${n(f.max)}`;
  if (mod === "word" && f.value != null) return WORDS[lang][f.value] ?? n(f.value);
  const range = f.value != null ? [f.value] : [f.min, f.max];
  let s;
  if (f.unit === "eur") s = lang === "de" ? `${range.map(n).join("–")} €` : range.map((x) => `€${n(x)}`).join("–");
  else if (f.unit === "m2") s = `${range.map(n).join("–")} m²`;
  else s = range.map(n).join("–");
  return f.approx ? `${lang === "de" ? "ca." : "approx."} ${s}` : s;
}

/** Resolve {{fact.x}}, {{fact.x.min}}, {{fact.x|n}}, {{fact.x|word}}, {{contact.a.b}}, {{term.x}}. Unknown → throw. */
export function renderText(template, { project, contact, wording, lang }) {
  return String(template).replace(/\{\{\s*(fact|contact|term)\.([\w.]+)(?:\|(\w+))?\s*\}\}/g, (_, kind, key, mod) => {
    if (kind === "fact") {
      const [name, part] = key.split(".");
      const f = project?.facts?.[name];
      if (!f) throw new Error(`Unbekannter Fakt {{fact.${key}}}`);
      return formatFact(f, lang, part || null, mod || null);
    }
    if (kind === "term") {
      const v = wording?.terms?.[key]?.[lang];
      if (typeof v !== "string") throw new Error(`Unbekannter Begriff {{term.${key}}}`);
      return v;
    }
    const v = key.split(".").reduce((o, k) => o?.[k], contact);
    if (typeof v !== "string") throw new Error(`Unbekannter Kontaktwert {{contact.${key}}}`);
    return v;
  });
}
export function renderDeep(value, ctx) {
  if (typeof value === "string") return renderText(value, ctx);
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, ctx));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderDeep(v, ctx)]));
  return value;
}
/** All template strings of a project with their key path (for rule checks). */
export function projectTemplates(p) {
  const out = [];
  const walk = (v, keyPath, lang) => {
    if (typeof v === "string") out.push({ key: keyPath, lang, text: v });
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${keyPath}[${i}]`, lang));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, keyPath ? `${keyPath}.${k}` : k, lang);
  };
  walk(p.page?.de ?? {}, "page.de", "de");
  walk(p.page?.en ?? {}, "page.en", "en");
  return out;
}
const ctxFor = (sot, p, lang) => ({ project: p, contact: sot.contact, wording: sot.wording, lang });

/** Texts of a project for a language, placeholders resolved. */
export function projectTexts(sot, id, lang) {
  const p = sot.projects.find((x) => x.id === id || x.slug === id);
  if (!p) throw new Error(`Projekt ${id} fehlt in data/sot/projects.json`);
  return renderDeep(p.page[lang], ctxFor(sot, p, lang));
}
export function projectFacts(sot, id) {
  const p = sot.projects.find((x) => x.id === id || x.slug === id);
  return p?.facts ?? {};
}

/** Kompatibilitäts-Export im alten Schema (eichmann.projects.sot/v1) – erzeugt, nie von Hand pflegen. */
export function projectsDocument(sot = loadSot()) {
  return {
    schema: "eichmann.projects.sot/v1",
    description: "ERZEUGT aus data/sot/projects.json (scripts/lib/sot.mjs) – nicht von Hand bearbeiten.",
    updated_at: sot.projects.map((p) => p.updated_at).filter(Boolean).sort().pop() ?? null,
    projects: sot.projects.map((p) => {
      const de = renderDeep(p.page.de, ctxFor(sot, p, "de"));
      const f = p.facts;
      const legacy = {
        id: p.legacy_id || p.id,
        slug: p.slug,
        active: p.active,
        kind: p.kind,
        ...de,
      };
      // numerische Felder nur aus belegten Fakten
      if (f.units) legacy.unit_count = f.units.value;
      if (f.buildings) legacy.building_count = f.buildings.value;
      if (f.price) legacy.price_eur = { low: f.price.min, high: f.price.max, currency: "EUR" };
      if (f.living_area) legacy.area_m2 = { min: f.living_area.min, max: f.living_area.max };
      if (f.rooms) legacy.rooms = { min: f.rooms.min, max: f.rooms.max };
      legacy.images = p.images;
      legacy.pages = p.pages;
      // stabile Schlüsselreihenfolge wie im alten Dokument
      const order = p.legacy_key_order || Object.keys(legacy);
      const outObj = {};
      for (const k of order) if (k in legacy) outObj[k] = legacy[k];
      for (const k of Object.keys(legacy)) if (!(k in outObj)) outObj[k] = legacy[k];
      return outObj;
    }),
  };
}

/* ---------- Objekte ---------- */
export function listingLayer(sot, listing) {
  const id = String(listing?.immowelt_id || listing?.id || "");
  return sot.listings.find((l) => l.id === id) || null;
}
/**
 * Merge our layer into importer rows (in place). status sold/hidden → not public;
 * overrides.title/meta_description (de) win; verified_at per row.
 */
export function applyListingLayer(sot, data) {
  for (const L of data?.listings || []) {
    const lay = listingLayer(sot, L);
    if (!lay) continue;
    if (lay.status === "sold" || lay.status === "hidden") { L.site_hidden = true; L.sot_status = lay.status; }
    if (lay.verified_at) L.verified_at = lay.verified_at;
    if (lay.overrides?.title?.de) L.title = lay.overrides.title.de;
    if (lay.overrides?.meta_description?.de) L.meta_description_override = lay.overrides.meta_description.de;
    if (lay.waivers?.length) L.waivers = lay.waivers;
  }
  if (sot.dataAsOf) data.data_as_of = sot.dataAsOf;
  return data;
}
/** "dd.mm.yyyy" – ältestes Prüfdatum der aktiven Objekte. */
export function dataAsOfLabel(sot = loadSot(), lang = "de") {
  if (!sot.dataAsOf) return lang === "de" ? "unbekannt" : "unknown";
  const [y, m, d] = sot.dataAsOf.split("-");
  return lang === "de" ? `${d}.${m}.${y}` : `${d}/${m}/${y}`;
}

/** Write listings.json layer back (CLI, mirror check). */
export function saveListingsLayer(sot, listings) {
  const fp = path.join(sot.dir, "listings.json");
  const doc = JSON.parse(readFileSync(fp, "utf8"));
  doc.listings = listings;
  writeFileSync(fp, JSON.stringify(doc, null, 2) + "\n", "utf8");
  cache.delete(sot.root);
}

/* ---------- Seiten ---------- */
export function pageEntries(sot = loadSot()) { return sot.pages.pages; }
export function hreflangPairs(sot = loadSot()) {
  return sot.pages.pages.filter((p) => p.paths?.de && p.paths?.en).map((p) => ({ de: p.paths.de, en: p.paths.en }));
}
export function sitemapStatic(sot = loadSot()) {
  const out = [];
  for (const lang of LANGS)
    for (const p of sot.pages.pages) {
      const loc = p.paths?.[lang];
      const s = p.sitemap?.[lang];
      if (!loc || !s) continue;
      out.push({ loc, priority: s.priority, changefreq: s.changefreq });
    }
  return out;
}

/* ---------- Struktur ---------- */
export function checkStructure(sot) {
  const errs = [];
  const need = (cond, msg) => { if (!cond) errs.push(msg); };
  const c = sot.contact;
  need(/^\+\d{8,15}$/.test(c.phone_mobile?.e164 ?? ""), "contact.phone_mobile.e164 fehlt oder ungültig");
  need(/^\+\d{8,15}$/.test(c.phone_landline?.e164 ?? ""), "contact.phone_landline.e164 fehlt oder ungültig");
  need(/@/.test(c.email ?? ""), "contact.email fehlt");
  for (const lang of LANGS) {
    need(c.whatsapp_text?.[lang], `contact.whatsapp_text.${lang} fehlt`);
    need(c.whatsapp_text_project?.[lang], `contact.whatsapp_text_project.${lang} fehlt`);
  }
  for (const key of ["project", "commission_free", "register"])
    for (const lang of LANGS) need(sot.wording.terms?.[key]?.[lang], `wording.terms.${key}.${lang} fehlt`);

  for (const p of sot.projects) {
    for (const [name, f] of Object.entries(p.facts ?? {})) {
      const where = `projects.${p.id}.facts.${name}`;
      need(f.value != null || (f.min != null && f.max != null), `${where}: value oder min/max fehlt`);
      need(["count", "m2", "eur"].includes(f.unit), `${where}: unit ungültig`);
      need(f.evidence && existsSync(path.join(sot.dir, f.evidence)), `${where}: Beleg-Datei fehlt (${f.evidence})`);
      need(f.confirmed_by, `${where}: confirmed_by fehlt`);
      need(ISO_DATE.test(f.confirmed_at ?? ""), `${where}: confirmed_at fehlt`);
    }
    for (const lang of LANGS) need(p.page?.[lang], `projects.${p.id}.page.${lang} fehlt`);
    for (const k of ["h1", "lead", "meta_description", "page_title"])
      for (const lang of LANGS) need(p.page?.[lang]?.[k], `projects.${p.id}.page.${lang}.${k} fehlt`);
  }

  const seen = new Set();
  for (const l of sot.listings) {
    const where = `listings.${l.slug ?? l.id}`;
    need(l.id && l.slug, `${where}: id/slug fehlt`);
    need(!seen.has(l.slug), `${where}: slug doppelt`); seen.add(l.slug);
    need(["active", "sold", "hidden"].includes(l.status), `${where}: status ungültig`);
    need(["immowelt", "manual", "eigen"].includes(l.source), `${where}: source ungültig`);
    need(ISO_DATE.test(l.verified_at ?? ""), `${where}: verified_at fehlt`);
    need(l.verified_by, `${where}: verified_by fehlt`);
    for (const w of l.waivers ?? [])
      need(w.rule && w.match && w.reason && w.by && ISO_DATE.test(w.until ?? ""), `${where}: Ausnahme unvollständig`);
  }
  const seenPath = new Set();
  for (const pg of sot.pages.pages) {
    need(pg.id && pg.paths?.de, `pages.${pg.id}: id/paths.de fehlt`);
    for (const lang of LANGS) if (pg.paths?.[lang]) {
      need(!seenPath.has(pg.paths[lang]), `pages.${pg.id}: Pfad doppelt ${pg.paths[lang]}`);
      seenPath.add(pg.paths[lang]);
    }
  }
  return errs;
}

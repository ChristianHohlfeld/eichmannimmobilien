#!/usr/bin/env node
/**
 * Comparison table: Immowelt API ↔ what the server says it published ↔ what the pages show.
 *
 *   node scripts/verify/inventory-report.mjs [--base https://immobilieneichmann.de] [--api] [--out report.md] [--report-only]
 *        [--json report.json]            the same result as data (shown per offer on the review page)
 *        [--api-snapshot snapshot.json]  with --api: the complete API state as read (texts, picture URLs; never the key) –
 *                                        input for capture-screens.mjs --label immowelt-api
 *
 *   A  API           fresh, complete read of the Immowelt account (only with --api; needs the key via
 *                    IMMOWELT_API_KEY or the server's secrets file – read-only, nothing is stored)
 *   B  published     <base>/ai/immowelt-snapshot.json   (written by the build that is live)
 *   C  rendered      every offer page, parsed
 *
 * Per offer: ids, Kauf/Miete, price, area, rooms, number and ORDER of pictures and floor plans,
 * every text section (hash of the markup), every fact row, active state. Any difference is listed
 * and the exit code is 1 – there is no "roughly equal".
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { inspectExposeHtml } from "../lib/release-verify.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const base = String(opt("--base", "https://immobilieneichmann.de")).replace(/\/+$/, "");
const sha = (t) => createHash("sha256").update(String(t ?? "")).digest("hex");
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const diffs = [];
const note = (id, msg) => diffs.push(`${id}: ${msg}`);

async function get(url, as = "json") {
  const res = await fetch(url, { headers: { "Cache-Control": "no-cache", "User-Agent": "eichmann-verify/1" }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return null;
  return as === "json" ? res.json() : res.text();
}

// ---------- A: API ----------
let A = null;
if (args.includes("--api")) {
  const { loadConfig } = await import("../lib/immowelt/config.mjs");
  const { fetchSnapshot } = await import("../lib/immowelt/pipeline.mjs");
  const { validateSnapshot } = await import("../lib/immowelt/validate.mjs");
  const { readImmoweltCredentials } = await import("../lib/immowelt-secrets.mjs");
  const key = (process.env.IMMOWELT_API_KEY || "").trim() || readImmoweltCredentials()?.api_key || "";
  if (!key) {
    console.error("--api: kein Schlüssel verfügbar (IMMOWELT_API_KEY oder Secrets-Datei).");
    process.exit(2);
  }
  const { snapshot } = await fetchSnapshot(key, loadConfig(), { log: () => {} });
  const verdict = validateSnapshot(snapshot);
  if (!verdict.ok) {
    console.error(`API-Stand ist nicht vollständig/konsistent: ${verdict.errors.map((e) => e.message).join("; ")}`);
    process.exit(1);
  }
  if (opt("--api-snapshot")) fs.writeFileSync(opt("--api-snapshot"), `${JSON.stringify({ fetched_at: snapshot.fetched_at, listings: snapshot.listings }, null, 1)}\n`);
  A = snapshot.listings.map((L) => ({
    position: L.position, online_id: L.immowelt_online_id, estate_id: L.immowelt_estate_id, guid: L.immowelt_guid,
    marketing: L.marketing, price_on_request: L.price_on_request, price_eur: L.price_eur, price: L.price, title: L.title,
    rooms: L.rooms_value ?? null, living_area_m2: L.living_area_value ?? null,
    facts: L.fact_rows.map((r) => [r.label, r.value]),
    sections: L.sections.filter((s) => s.html).map((s) => ({ id: s.id || null, title: s.title, chars: s.text.length, html_sha256: sha(s.html) })),
    pictures: L.media.map((m) => ({ role: m.role, asset: m.asset_key })),
  }));
}

// ---------- B: published ----------
const published = await get(`${base}/ai/immowelt-snapshot.json`);
const build = await get(`${base}/ai/build.json`);
const B = published?.listings || null;
const Bby = new Map((B || []).map((L) => [L.online_id, L]));
if (!B) note("–", "ai/immowelt-snapshot.json nicht abrufbar – es ist (noch) kein Immowelt-Stand veröffentlicht, nichts verglichen");

// ---------- C: rendered ----------
const C = new Map();
for (const L of B || []) {
  const html = await get(L.url.replace(/^https?:\/\/[^/]+/, base), "text");
  C.set(L.online_id, html ? inspectExposeHtml(html) : null);
  if (html) C.get(L.online_id).raw = html;
}

const ids = A ? A.map((L) => L.online_id) : (B || []).map((L) => L.online_id);
const rows = [];
for (const id of ids) {
  const a = A ? A.find((L) => L.online_id === id) : null;
  const b = Bby.get(id) || null;
  const c = C.get(id) || null;
  const before = diffs.length;
  if (A && !b) note(id, "in der API aktiv, aber nicht veröffentlicht");
  if (a && b) {
    for (const k of ["position", "estate_id", "guid", "marketing", "price_on_request", "price_eur", "price", "title", "rooms", "living_area_m2"]) {
      if (!eq(a[k], b[k])) note(id, `${k}: API ${JSON.stringify(a[k])} ≠ veröffentlicht ${JSON.stringify(b[k])}`);
    }
    if (!eq(a.facts, b.facts)) note(id, `Fakten weichen ab (API ${a.facts.length} Zeilen, veröffentlicht ${b.facts.length})`);
    if (!eq(a.sections, b.sections)) note(id, `Textabschnitte weichen ab (API ${a.sections.map((s) => `${s.title}:${s.chars}`).join(", ")} | veröffentlicht ${b.sections.map((s) => `${s.title}:${s.chars}`).join(", ")})`);
    if (!eq(a.pictures, b.pictures.map((p) => ({ role: p.role, asset: p.asset })))) note(id, `Bilder/Reihenfolge weichen ab (API ${a.pictures.length}, veröffentlicht ${b.pictures.length})`);
  }
  if (b) {
    if (!c) note(id, "Objektseite nicht abrufbar");
    else {
      if (c.online_id !== id) note(id, `Seite gehört zu ${c.online_id}`);
      if (c.content_hash !== b.content_hash) note(id, "Seite stammt nicht aus dem veröffentlichten Stand (content_hash)");
      if (c.marketing !== b.marketing) note(id, `Seite zeigt ${c.marketing}, veröffentlicht ist ${b.marketing}`);
      // identical bytes are shown once → compare the unique file order
      const uniq = (list) => [...new Set(list)];
      const photos = uniq(b.pictures.filter((p) => p.role === "photo").map((p) => `../${p.file}`));
      const plans = uniq(b.pictures.filter((p) => p.role === "floorplan").map((p) => `../${p.file}`));
      if (!eq(c.gallery_images, photos)) note(id, `Galerie: Seite ${c.gallery_images.length} Bilder, veröffentlicht ${photos.length} (Anzahl oder Reihenfolge)`);
      if (!eq(c.floorplan_images, plans)) note(id, `Grundrisse: Seite ${c.floorplan_images.length}, veröffentlicht ${plans.length}`);
      if (!eq(c.sections.map((s) => [s.title, sha(s.html)]), b.sections.map((s) => [esc(s.title), s.html_sha256]))) note(id, "Textabschnitte der Seite weichen vom veröffentlichten Stand ab");
      if (!eq(c.facts, b.facts.map(([k, v]) => [esc(k), esc(v)]))) note(id, "Fakten der Seite weichen vom veröffentlichten Stand ab");
      if (!c.hero.includes(esc(b.price))) note(id, `Preiszeile der Seite zeigt nicht „${b.price}“ (sondern: ${c.hero})`);
      if (b.price_on_request && /\d\s*€/.test(c.hero)) note(id, "Betrag sichtbar, obwohl Immowelt „auf Anfrage“ meldet");
    }
  }
  const src = a || b;
  rows.push({
    id,
    data: {
      online_id: id, position: src.position, estate_id: src.estate_id, guid: src.guid, marketing: src.marketing, price: src.price,
      living_area_m2: src.living_area_m2 ?? null, rooms: src.rooms ?? null, title: src.title,
      photos_api: src.pictures.filter((p) => p.role === "photo").length, photos_page: c ? c.gallery_images.length : null,
      floorplans_api: src.pictures.filter((p) => p.role === "floorplan").length, floorplans_page: c ? c.floorplan_images.length : null,
      sections: src.sections.map((s) => ({ title: s.title, chars: s.chars })), facts: src.facts.length,
      online: Boolean(b), url: b?.url || null, equal: diffs.length === before, differences: diffs.slice(before),
    },
    cells: [
      src.position + 1, id, src.estate_id, String(src.guid).slice(0, 8) + "…", src.marketing === "miete" ? "Miete" : "Kauf",
      src.price, src.living_area_m2 ?? "–", src.rooms ?? "–",
      `${src.pictures.filter((p) => p.role === "photo").length}${c ? ` / ${c.gallery_images.length}` : ""}`,
      `${src.pictures.filter((p) => p.role === "floorplan").length}${c ? ` / ${c.floorplan_images.length}` : ""}`,
      src.sections.map((s) => `${s.title} (${s.chars})`).join("; ") || "–",
      src.facts.length,
      b ? "ja" : "nein",
      diffs.length === before ? "✓" : `✗ ${diffs.length - before}`,
    ],
  });
}
// offers the site shows from Immowelt that the API no longer lists
if (A) for (const b of B || []) if (!A.some((a) => a.online_id === b.online_id)) note(b.online_id, "veröffentlicht, aber nicht (mehr) im API-Bestand");
// offer pages on the site that are not part of the published Immowelt state (scraper-era leftovers)
const ai = await get(`${base}/ai/listings.json`);
const leftovers = (ai?.listings || []).filter((L) => L.origin !== "eigen" && !L.online_id);
for (const L of leftovers) note(L.slug, "Immowelt-Angebot auf der Website ohne API-Kennung (Stand vor der Umstellung)");

const head = ["#", "Online-ID", "Objekt-ID", "GUID", "Art", "Preis", "m²", "Zi.", `Fotos${B ? " API/Seite" : ""}`, "Grundrisse", "Textabschnitte (Zeichen)", "Fakten", "online", "gleich"];
const lines = [
  `# Immowelt ↔ Website – ${base}`,
  "",
  `Erstellt ${new Date().toISOString()} · Release ${build?.release_id || "–"} · Datenstand ${published?.data_as_of || build?.data_as_of || "–"} · Vergleich: ${A ? "API ↔ veröffentlicht ↔ Seiten" : "veröffentlicht ↔ Seiten (ohne --api)"}`,
  "",
  `Angebote: API ${A ? A.length : "–"} · veröffentlicht ${B ? B.length : "noch kein API-Stand veröffentlicht"} · Website gesamt ${ai?.listing_count ?? "–"}`,
  "",
  `| ${head.join(" | ")} |`,
  `| ${head.map(() => "---").join(" | ")} |`,
  ...rows.map((r) => `| ${r.cells.map((c) => String(c).replace(/\|/g, "\\|")).join(" | ")} |`),
  "",
  diffs.length ? `## ${diffs.length} Abweichung(en)\n\n${diffs.map((d) => `- ${d}`).join("\n")}` : "## Keine Abweichungen\n\nJedes Angebot stimmt in Kennungen, Vermarktungsart, Preis, Fläche, Zimmern, Bildern (Anzahl und Reihenfolge), Grundrissen, Textabschnitten und Fakten überein.",
  "",
];
const report = lines.join("\n");
if (opt("--out")) fs.writeFileSync(opt("--out"), report);
if (opt("--json")) {
  fs.writeFileSync(opt("--json"), `${JSON.stringify({
    schema: "eichmann.verify-inventory/v1", base, created_at: new Date().toISOString(), release_id: build?.release_id || null,
    data_as_of: published?.data_as_of || build?.data_as_of || null, compared: A ? "API ↔ veröffentlicht ↔ Seiten" : "veröffentlicht ↔ Seiten",
    counts: { api: A ? A.length : null, published: B ? B.length : null, site: ai?.listing_count ?? null },
    offers: rows.map((r) => r.data), differences: diffs,
  }, null, 2)}\n`);
}
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
console.log(report);
process.exit(diffs.length && !args.includes("--report-only") ? 1 : 0);

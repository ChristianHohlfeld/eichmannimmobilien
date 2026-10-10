#!/usr/bin/env node
/**
 * Claude review fixes (final round): static HTML/data checks + MCP fuzzy DE/EN search.
 * MCP_URL=https://immobilieneichmann.de/mcp runs the search checks against the live server.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFile(path.join(root, f), "utf8");
const problems = [];
const check = (ok, msg) => { if (!ok) problems.push(msg); };

/* ---------- static ---------- */
const listings = JSON.parse(await read("data/listings.json")).listings.filter((L) => L.active !== false && L.site_hidden !== true && L.detail_page !== false);
const htmlFiles = [
  ...(await readdir(root)).filter((f) => f.endsWith(".html")),
  ...(await readdir(path.join(root, "en"))).filter((f) => f.endsWith(".html")).map((f) => "en/" + f),
  ...(await readdir(path.join(root, "objekt"))).filter((f) => f.endsWith(".html")).map((f) => "objekt/" + f),
];
for (const f of htmlFiles) {
  const h = await read(f);
  if (/^(admin|google|yandex)/.test(f)) continue;
  check(!/Neubauprojekt Konstanz-Allmannsdorf|NEUBAUPROJEKT/.test(h), `${f}: old project name`);
  check(!/Baubegin|Fertigstellung|Bauantrag|Baugenehmigung/i.test(h), `${f}: project status/date wording`);
  check(!/InStock/.test(h), `${f}: InStock`);
  for (const m of h.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try { JSON.parse(m[1]); } catch (e) { problems.push(`${f}: JSON-LD parse error ${e.message}`); }
  }
  check(!/href="#"(?![^>]*data-open-cookie-settings)/.test(h), `${f}: link to bare #`);
  const nav = (h.match(/<nav class="nav"[\s\S]*?<\/nav>/) || [""])[0];
  if (nav && !f.startsWith("en/")) {
    check(/<a href="tel:\+491705225568" class="nav-cta btn-call" data-location="header_number">Anrufen<span class="nav-cta-num"> 0170 522 5568<\/span><\/a>/.test(nav), `${f}: nav CTA must be Anrufen`);
    check(/>Kontakt<\/a>/.test(nav), `${f}: nav Kontakt link missing`);
    check(!/href="(\.\.\/)?index\.html/.test(nav), `${f}: nav links index.html instead of /`);
  }
  if (h.includes('id="flyerModal"')) {
    // Flyer kommt aus EINEM Partial (SSOT); Seiten enthalten nur den Container
    check(/id="flyerModal" hidden data-flyer-src="\/partials\/flyer-modal\.html\?v=[0-9a-f]{8}"><\/div>/.test(h), `${f}: flyer container/partial missing`);
    const fl0 = await read("partials/flyer-modal.html");
    const fl = fl0.slice(0, fl0.indexOf('<div class="flyer-foot">'));
    check(/NEUBAU<br><span>ALLMANNSDORF<\/span>/.test(fl), `${f}: flyer title`);
    check(fl.includes('<p class="flyer-cta-script">Jetzt vormerken lassen!</p>'), `${f}: flyer heading`);
    check(!/Vormerken per Kontakt/.test(fl), `${f}: flyer still has 'Vormerken per Kontakt'`);
    check(!/<a class="btn btn-primary" href="#vormerk-flyer">Vormerken<\/a>/.test(fl), `${f}: flyer still has Vormerken button`);
    check((fl.match(/class="btn btn-accent" href="tel:/g) || []).length === 1, `${f}: flyer must have exactly one Anrufen button`);
  }
}
// objekt pages
for (const L of listings) {
  const h = await read(L.local_url);
  check(!/Nettokaltmiete/.test(h), `${L.slug}: Nettokaltmiete on purchase object`);
  const h1 = (h.match(/<h1 class="expose-title">([\s\S]*?)<\/h1>/) || ["", ""])[1].replace(/<[^>]+>/g, "");
  check(!/^[A-Z]\d+\d+ Zimmer/.test(h1) && !/^[A-Z]\d+(?=[^\d\s·])/.test(h1), `${L.slug}: H1 runs reference into title: ${h1}`);
  const sec = (h.match(/<div class="expose-secondary-actions">([\s\S]*?)<\/div>/) || ["", ""])[1];
  const btns = [...sec.matchAll(/<a class="btn[^"]*"[^>]*>([^<]*)<\/a>/g)].map((m) => m[1].trim());
  check(btns.length === 2 && /^Anrufen/.test(btns[0]) && /WhatsApp zu diesem Objekt/.test(btns[1]), `${L.slug}: buttons ${JSON.stringify(btns)}`);
  check(!/Per WhatsApp teilen|Zum Kontaktformular/.test(h), `${L.slug}: removed buttons still present`);
  check(/<p class="expose-textlinks"><a href="https:\/\/www\.immowelt\.de\/expose\//.test(h), `${L.slug}: Immowelt text link missing`);
  const desc = (h.match(/<meta name="description" content="([^"]*)"/) || ["", ""])[1];
  check(desc.length <= 165 && /^(Wohnung|Penthouse|Maisonette|Mehrfamilienhaus|Haus|Immobilie)/.test(desc) && /Konstanz/.test(desc) && desc.includes(L.price.replace(/\s+/g, " ").trim()), `${L.slug}: meta description not structured: ${desc}`);
}
const sun = listings.filter((L) => /Sunside/.test(L.title));
for (const L of sun) {
  const h = await read(L.local_url);
  const others = sun.filter((x) => x.slug !== L.slug);
  check(others.every((x) => h.includes(`../${x.local_url}`)), `${L.slug}: missing sibling links`);
}
// topic pages
const woll = await read("wollmatingen.html");
for (const L of listings.filter((x) => /Wollmatingen/.test(x.location))) check(woll.includes(`href="${L.local_url}"`), `wollmatingen.html: missing ${L.slug}`);
const wk = await read("wohnung-kaufen-konstanz.html");
for (const L of listings.filter((x) => /Wohnung|Penthouse|Maisonette/.test(x.type + " " + x.title))) check(wk.includes(`href="${L.local_url}"`), `wohnung-kaufen-konstanz.html: missing ${L.slug}`);
// stand
const idx = await read("index.html");
check(/Stand der Angebote: \d{2}\.\d{2}\.\d{4} \(mit den öffentlichen Exposés abgeglichen\)\./.test(idx), "index.html: Stand date missing");
check(!/Stand: Oktober 2026/.test(idx), "index.html: month-only Stand");
// sitemap
const sm = await read("sitemap.xml");
const locs = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
check(locs.every((u) => u.endsWith("/") || u.endsWith(".html")), "sitemap: non-HTML entries: " + locs.filter((u) => !(u.endsWith("/") || u.endsWith(".html"))).join(","));
// discovery
const llms = await read("llms.txt");
check(llms.includes("https://immobilieneichmann.de/en/allmannsdorf.html") && !llms.includes("data/listings.json") && !/Live-Stand/.test(llms), "llms.txt: /en/ missing or data export / Live wording");
const mcpj = JSON.parse(await read(".well-known/mcp.json"));
check(mcpj.pages_en?.allmannsdorf && mcpj.data_as_of && !JSON.stringify(mcpj).includes("data/listings.json") && !/Live MCP/.test(JSON.stringify(mcpj)), "mcp.json: en/data_as_of/no full export");
const card = JSON.parse(await read("ai/server-card.json"));
const mcpSrc = await read("scripts/mcp-server.mjs");
check(/version: MCP_SERVER_VERSION/.test(mcpSrc) && card.version === (await import("./lib/ai-discovery.mjs")).MCP_SERVER_VERSION, "version mismatch server-card vs MCP");
const flyer = JSON.parse(await read("ai/flyer-allmannsdorf.json"));
check(flyer.title === "Neubau Allmannsdorf" && /Seesicht/.test(JSON.stringify(flyer)) && flyer.pages.project_en && flyer.cta.whatsapp_en, "flyer json: name/seesicht/en");
const ai = JSON.parse(await read("ai/listings.json"));
check(!/[A-Za-zäöü]$/.test(ai.projects[0].short_description) || ai.projects[0].short_description.endsWith("."), "project short_description cut mid-word");
// EN
const enA = await read("en/allmannsdorf.html");
const enH1 = (enA.match(/<h1>([^<]*)<\/h1>/) || ["", ""])[1];
const enLead = (enA.match(/<p class="lead">([^<]*)<\/p>/) || ["", ""])[1];
check(enH1 && enLead && !enLead.includes(enH1) && !/register your interest/.test(enH1), "en/allmannsdorf: H1/lead duplicate");
check(/commission\u2011free/.test(enA) && /commission\u2011free/.test(await read("en/index.html")), "EN: non-breaking hyphen in commission‑free");
check(/hero-cta-vormerken/.test(enA) && /hero-cta-vormerken/.test(await read("allmannsdorf.html")), "allmannsdorf: desktop-primary Vormerken class");
const kontakt = await read("kontakt.html");
check(/href="kontakt\.html\?interesse=allmannsdorf#contact-form" data-open-flyer/.test(kontakt), "kontakt.html: Neubau vormerken fallback href");

/* ---------- MCP search ---------- */
async function rpc(url, method, params) {
  if (process.env.MCP_URL) await new Promise((r) => setTimeout(r, 2500)); // live nginx limit: 30 req/min
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const txt = await res.text();
  const json = JSON.parse(txt.startsWith("event:") || txt.startsWith("data:") ? txt.split("\n").find((l) => l.startsWith("data:")).slice(5) : txt);
  return json.result;
}
let child = null;
let url = process.env.MCP_URL;
if (!url) {
  const PORT = 19950 + Math.floor(Math.random() * 40);
  child = spawn(process.execPath, [path.join(root, "scripts", "mcp-server.mjs")], {
    env: { ...process.env, EICHMANN_SITE_ROOT: root, EICHMANN_MCP_HOST: "127.0.0.1", EICHMANN_MCP_PORT: String(PORT), EICHMANN_MCP_CACHE_MS: "1000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  url = `http://127.0.0.1:${PORT}/mcp`;
  for (let i = 0; i < 50; i++) {
    const ok = await new Promise((r) => http.get(`http://127.0.0.1:${PORT}/health`, (res) => r(res.statusCode === 200)).on("error", () => r(false)));
    if (ok) break;
    await new Promise((r) => setTimeout(r, 100));
  }
}
const search = async (args) => (await rpc(url, "tools/call", { name: "search_listings", arguments: args })).structuredContent;
const cases = [
  [{ q: "Wohnung" }, (r) => r.total_matched >= 8, "Wohnung"],
  [{ q: "apartment Konstanz" }, (r) => r.total_matched >= 8 && r.projects?.length, "apartment Konstanz (+project)"],
  [{ q: "flat in Constance" }, (r) => r.total_matched >= 8, "flat in Constance"],
  [{ q: "3 Zimmer Wohnung Konstanz" }, (r) => r.total_matched >= 2 && r.listings.every((L) => /^3\b/.test(L.rooms)), "3 Zimmer Wohnung"],
  [{ q: "3-room apartment" }, (r) => r.total_matched >= 2 && r.listings.every((L) => /^3\b/.test(L.rooms)), "3-room apartment"],
  [{ q: "Wohnung kaufen Konstanz" }, (r) => r.total_matched >= 8, "Wohnung kaufen Konstanz"],
  [{ q: "penthouse" }, (r) => r.total_matched >= 2 && r.listings.every((L) => /penthouse/i.test(L.type + L.title)), "penthouse"],
  [{ q: "maisonette" }, (r) => r.total_matched >= 1 && r.listings.every((L) => /maisonette/i.test(L.type)), "maisonette"],
  [{ q: "house" }, (r) => r.total_matched >= 1 && r.listings.every((L) => /haus/i.test(L.type) || /famil+ienhaus/i.test(L.title)), "house"],
  [{ q: "Haus" }, (r) => r.total_matched >= 1 && !r.listings.some((L) => /penthouse/i.test(L.type)), "Haus"],
  [{ q: "Wollmatingen" }, (r) => r.total_matched >= 6 && r.listings.every((L) => /Wollmatingen/.test(L.location)), "Wollmatingen"],
  [{ q: "Fuerstenberg" }, (r) => r.total_matched >= 1, "Fuerstenberg (ASCII)"],
  [{ q: "Petershausen apartment" }, (r) => r.total_matched >= 1 && r.listings.every((L) => /Petershausen/.test(L.location)), "Petershausen apartment"],
  [{ q: "new build" }, (r) => r.projects?.length && r.total_matched >= 1, "new build"],
  [{ rooms: "1" }, (r) => r.total_matched >= 1 && r.listings.every((L) => /^1\b/.test(L.rooms)), "rooms=1 exact"],
  [{ q: "Wohnug" }, (r) => r.total_matched >= 8, "typo Wohnug"],
];
const mcpOut = [];
try {
  for (const [args, ok, label] of cases) {
    const r = await search(args);
    const pass = Boolean(ok(r));
    mcpOut.push(`${pass ? "ok  " : "FAIL"} ${label}: ${r.total_matched} listings${r.projects ? " + Allmannsdorf" : ""}`);
    if (!pass) problems.push(`MCP search ${label}: ${JSON.stringify({ n: r.total_matched, q: r.interpreted_query, l: r.listings.map((L) => L.slug) })}`);
  }
  const fl = (await rpc(url, "tools/call", { name: "get_flyer", arguments: {} })).structuredContent;
  check(fl.flyer.title === "Neubau Allmannsdorf" && fl.contact.preferred.whatsapp_url_en, "MCP get_flyer: name / EN WhatsApp");
  const init = await rpc(url, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  check(init.serverInfo.version === card.version, `MCP version ${init.serverInfo.version} != server-card ${card.version}`);
} finally {
  if (child) child.kill();
}
console.log(mcpOut.join("\n"));
if (problems.length) {
  console.error("Claude-final checks FAILED:\n - " + problems.join("\n - "));
  process.exit(1);
}
console.log(`Claude-final OK: ${htmlFiles.length} HTML files, ${listings.length} objekt pages, sitemap HTML-only, discovery /en/, MCP DE/EN search (${cases.length} queries) via ${process.env.MCP_URL ? "live" : "local"} server`);

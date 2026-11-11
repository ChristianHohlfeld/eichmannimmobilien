/**
 * Visual verification without a browser: complete page inventory, review page (before · after ·
 * Immowelt), API reference card. The screenshots themselves need Playwright and run in CI / locally.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverPages, normalizePagePath, pageKey, buildReviewHtml, referenceCardHtml } from "../scripts/verify/lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The repository is a static site: serve it as it is. */
function serveRepo() {
  const types = { ".html": "text/html; charset=utf-8", ".xml": "application/xml", ".json": "application/json", ".css": "text/css", ".js": "text/javascript" };
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { "content-type": "text/html" });
      res.end("<html><body>404</body></html>");
      return;
    }
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })));
}

test("Seitenbestand: Pfade werden einheitlich und nur für Seiten dieser Website gebildet", () => {
  const base = "http://127.0.0.1:8080";
  const n = (href, from = `${base}/objekt/a.html`) => normalizePagePath(href, from, base);
  assert.equal(n("../projekte.html"), "/projekte.html");
  assert.equal(n("https://immobilieneichmann.de/kontakt.html#form"), "/kontakt.html", "absolute Produktions-Links zählen als intern");
  assert.equal(n("/index.html"), "/");
  assert.equal(n("/en/index.html?x=1"), "/en/");
  assert.equal(n("/leistungen"), "/leistungen.html", "nginx leitet Adressen ohne Endung auf .html um");
  for (const skip of ["mailto:a@b.de", "tel:+49", "#top", "https://www.immowelt.de/expose/2ql2c52", "/admin/", "/admin/index.html", "/assets/logo.svg", "/data/sot/x.json", "/media/eigen/a.jpg", "/mcp", "javascript:void(0)", "/flyer.pdf"]) {
    assert.equal(n(skip), null, skip);
  }
  assert.deepEqual([pageKey("/"), pageKey("/objekt/wohnung-x-2ql2c52.html"), pageKey("/en/"), pageKey("/en/property/a.html")], ["home", "objekt_wohnung-x-2ql2c52", "en", "en_property_a"]);
});

test("Seitenbestand: Sitemap ∪ alle intern verlinkten Seiten – deutsch, englisch, Angebots- und Rechtsseiten", async () => {
  const site = await serveRepo();
  try {
    const { pages, truncated } = await discoverPages(site.base);
    const paths = pages.map((p) => p.path);
    assert.equal(truncated, false);
    assert.equal(paths[0], "/");
    assert.equal(new Set(paths).size, paths.length, "keine Seite doppelt");
    for (const must of ["/projekte.html", "/impressum.html", "/datenschutz.html", "/kontakt.html", "/leistungen.html", "/sunside-living-wollmatingen.html", "/en/", "/en/contact.html"]) assert.ok(paths.includes(must), `${must} fehlt`);
    const objekt = fs.readdirSync(path.join(ROOT, "objekt")).filter((f) => f.endsWith(".html")).map((f) => `/objekt/${f}`);
    for (const p of objekt) assert.ok(paths.includes(p), `${p} fehlt`);
    const en = fs.readdirSync(path.join(ROOT, "en", "property")).filter((f) => f.endsWith(".html")).map((f) => `/en/property/${f}`);
    for (const p of en) assert.ok(paths.includes(p), `${p} fehlt`);
    assert.ok(!paths.some((p) => /^\/(admin|assets|data|ai|media)\/|^\/mcp(\/|$)/.test(p)), "keine Werkzeug-/Datenpfade");
    assert.ok(paths.includes("/mcp.html"), "die öffentliche Seite mcp.html gehört dazu, der Endpunkt /mcp nicht");
    // jede öffentliche HTML-Seite des Repos im Wurzelverzeichnis ist erfasst (Komplettbestand)
    const rootPages = fs.readdirSync(ROOT).filter((f) => f.endsWith(".html") && f !== "index.html" && !/^google[0-9a-f]+\.html$/.test(f)).map((f) => `/${f}`);
    const missing = rootPages.filter((p) => !paths.includes(p));
    assert.deepEqual(missing, [], "nicht erfasste Seiten");
    assert.ok(pages.every((p) => p.status === 200 && /^[0-9a-f]{64}$/.test(p.html_sha256)), "alle Seiten antworten, Quelltext-Hash vorhanden");
    // Begrenzung wird gemeldet, nicht verschwiegen
    const cut = await discoverPages(site.base, { maxPages: 5 });
    assert.deepEqual([cut.pages.length, cut.truncated], [5, true]);
  } finally {
    await site.close();
  }
});

const shot = (viewport, key, sha, extra = {}) => ({ path: key, key, viewport, files: [`${viewport}/${key.replace(/\W+/g, "_")}.jpg`], sha256: sha, http_status: 200, title: `Titel ${key}`, ...extra });
const both = (key, sha, extra = {}) => [shot("desktop", key, sha, extra), shot("mobile", key, `${sha}m`, extra)];

test("Sichtprüfung: je Seite drei Bilder – Vorher (dt-1) · Nachher (dt) · Immowelt (dt)", () => {
  const b9 = { listing_id: "7bff84e7-8370-471d-b359-5319c8df10ef", online_id: "2zbf747", marketing: "kauf", h1: "4 Zimmer <script>alert(1)</script> B9", hero: "Konstanz · Preis auf Anfrage", gallery_count: 16, floorplan_count: 1 };
  const neu = { listing_id: "x", online_id: "2gwzk5x", marketing: "kauf", h1: "DG-Wohnung", hero: "Konstanz · 826.925 €", gallery_count: 12, floorplan_count: 0 };
  const before = { label: "before", base: "https://immobilieneichmann.de", captured_at: "2026-11-12T08:00:00Z", release_id: null, pages: [
    ...both("/", "same", { html_sha256: "h1" }),
    ...both("/impressum.html", "imp-a", { html_sha256: "imp" }),
    ...both("/objekt/wohnung-wollmatingen-7bff84e7.html", "b9-alt", { html_sha256: "b9a" }),
    ...both("/objekt/mehrfamilienhaus-wollmatingen-32a8908e.html", "dfh", { html_sha256: "dfh" }),
  ] };
  const after = { label: "after", base: "https://immobilieneichmann.de", captured_at: "2026-11-12T10:00:00Z", release_id: "20261112T095900Z-abc123", pages: [
    ...both("/", "same", { html_sha256: "h1" }),
    ...both("/impressum.html", "imp-b", { html_sha256: "imp" }),
    ...both("/objekt/wohnung-wollmatingen-7bff84e7.html", "b9-neu", { html_sha256: "b9b", listing: b9 }),
    ...both("/objekt/wohnung-konstanz-2gwzk5x.html", "dg", { html_sha256: "dg", listing: neu }),
    ...both("/en/property/wohnung-konstanz-2gwzk5x.html", "dg-en", { html_sha256: "dgen" }),
    ...both("/objekt/eigen-testobjekt.html", "eig", { html_sha256: "eig", listing: { listing_id: "eigen-1", online_id: null, h1: "Eigenes Objekt" } }),
  ] };
  const immowelt = { label: "immowelt", captured_at: "2026-11-12T10:05:00Z", pages: [
    { key: "2zbf747", online_id: "2zbf747", path: "/expose/2zbf747", viewport: "desktop", files: ["desktop/2zbf747-1.jpg", "desktop/2zbf747-2.jpg"], sha256: "iw", http_status: 200 },
    { key: "2zbf747", online_id: "2zbf747", path: "/expose/2zbf747", viewport: "mobile", files: ["mobile/2zbf747.jpg"], sha256: "iwm", http_status: 200 },
    { key: "2gwzk5x", online_id: "2gwzk5x", path: "/expose/2gwzk5x", viewport: "desktop", files: [], http_status: 403, blocked: "HTTP 403" },
    { key: "2gwzk5x", online_id: "2gwzk5x", path: "/expose/2gwzk5x", viewport: "mobile", files: [], http_status: 403, blocked: "HTTP 403" },
  ] };
  const immoweltApi = { label: "immowelt-api", captured_at: "2026-11-12T10:02:00Z", pages: [
    { key: "2gwzk5x", online_id: "2gwzk5x", path: "/expose/2gwzk5x", viewport: "desktop", files: ["desktop/2gwzk5x.jpg"], sha256: "api", http_status: 200 },
    { key: "2gwzk5x", online_id: "2gwzk5x", path: "/expose/2gwzk5x", viewport: "mobile", files: ["mobile/2gwzk5x.jpg"], sha256: "apim", http_status: 200 },
  ] };
  const report = { compared: "API ↔ veröffentlicht ↔ Seiten", differences: ["2gwzk5x: Galerie: Seite 11 Bilder, veröffentlicht 12"], offers: [
    { online_id: "2gwzk5x", position: 0, price: "826.925 €", living_area_m2: 106.7, rooms: 3, photos_api: 12, floorplans_api: 0, equal: false, differences: ["Galerie: Seite 11 Bilder, veröffentlicht 12"] },
    { online_id: "2zbf747", position: 1, price: "Preis auf Anfrage", living_area_m2: 93.22, rooms: 4, photos_api: 16, floorplans_api: 1, equal: true, differences: [] },
  ] };
  const html = buildReviewHtml({ before, after, immowelt, immoweltApi, report });

  // Angebote: Reihenfolge wie bei Immowelt (Position), je drei Spalten
  assert.ok(html.indexOf("DG-Wohnung") < html.indexOf("B9"), "Angebote in Immowelt-Reihenfolge");
  const section = (needle) => html.split('<section class="item').find((s) => s.includes(needle));
  const b9s = section("2zbf747");
  assert.equal((b9s.match(/class="tri vp-desktop"/g) || []).length, 1);
  assert.match(b9s, /Vorher \(dt‑1\)[\s\S]*Nachher \(dt\)[\s\S]*Immowelt \(dt\) · öffentliche Seite/);
  assert.match(b9s, /src="\.\.\/screens\/before\/desktop\/_objekt_wohnung_wollmatingen_7bff84e7_html\.jpg\?v=b9-alt"/);
  assert.match(b9s, /src="\.\.\/screens\/after\/desktop\//);
  assert.match(b9s, /src="\.\.\/screens\/immowelt\/desktop\/2zbf747-1\.jpg\?v=iw"[\s\S]*src="\.\.\/screens\/immowelt\/desktop\/2zbf747-2\.jpg\?v=iw"/, "lange Seiten: alle Teile untereinander");
  assert.match(b9s, /Adresse unverändert/);
  assert.match(b9s, /Datenvergleich ✓/);
  assert.match(b9s, /chip geändert/);
  assert.ok(!html.includes("<script>alert(1)</script>") && html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "Texte aus den Seiten werden maskiert");
  // neues Angebot: kein Vorher unter dieser Adresse; öffentliche Immowelt-Seite verweigert → API-Referenz, ausdrücklich so beschriftet
  const dg = section("DG-Wohnung");
  assert.match(dg, /neue Adresse/);
  assert.match(dg, /nicht vorhanden/);
  assert.match(dg, /Immowelt \(dt\) · API-Referenz[^<]*öffentliche Seite nicht aufgenommen/);
  assert.match(dg, /src="\.\.\/screens\/immowelt-api\/desktop\/2gwzk5x\.jpg\?v=api"/);
  assert.match(dg, /Datenvergleich ✗ 1/);
  assert.match(dg, /Galerie: Seite 11 Bilder, veröffentlicht 12/);
  // englische Fassung bekommt dieselbe Immowelt-Referenz
  assert.match(section("/en/property/wohnung-konstanz-2gwzk5x.html"), /Online-ID <b>2gwzk5x<\/b> \(englische Fassung\)[\s\S]*immowelt-api\/desktop\/2gwzk5x\.jpg\?v=api/);
  // entfallene Seite, eigenes Inserat, unveränderte und nur in der Darstellung abweichende Seite
  assert.match(section("mehrfamilienhaus-wollmatingen-32a8908e"), /chip entfällt[\s\S]*src="\.\.\/screens\/before\/desktop\//);
  assert.match(section("eigen-testobjekt"), /ohne Immowelt-Kennung/);
  assert.match(html.split('<section class="item').find((s) => s.includes("<h3>/ <small>")), /chip pixelgleich/);
  assert.match(section("/impressum.html"), /chip HTML-gleich/);
  assert.match(html, /Datenvergleich: <b>1 Abweichung\(en\)<\/b>/);
  assert.match(html, /1 nicht aufgenommen/);

  // eigene Verzeichnisse (z. B. heruntergeladene Artefakte) und fehlende Teile
  const only = buildReviewHtml({ before: null, after, prefix: { after: "../../after-run/" } });
  assert.match(only, /src="\.\.\/\.\.\/after-run\/desktop\//);
  assert.match(only, /noch keine Immowelt-Aufnahme für 2zbf747/);
});

test("API-Referenz: zeigt, was Immowelt liefert – Art, Preis, Fakten, Texte, Bilder in Reihenfolge", () => {
  const html = referenceCardHtml({
    immowelt_online_id: "2ql2c52", immowelt_estate_id: "90187795", position: 0, marketing: "miete", title: "1-Zimmer <b>Königsbau</b>", price: "1.200 € Warmmiete", location: "78462 Konstanz",
    fact_rows: [{ label: "Wohnfläche", value: "26 m²" }, { label: "Zimmer", value: "1" }],
    sections: [{ id: "Info1", title: "Objektbeschreibung", text: "Erster Absatz.\nZweiter Absatz.", html: "<p>Erster Absatz.</p><p>Zweiter Absatz.</p>" }],
    media: [{ role: "photo", xxl_url: "https://img.example/a/640x0" }, { role: "floorplan", url: "https://img.example/b/640x0" }],
  }, { fetchedAt: "2026-11-12T10:02:00Z" });
  assert.match(html, /Art <b>Miete<\/b>/);
  assert.match(html, /1\.200 € Warmmiete/);
  assert.ok(html.includes("1-Zimmer &lt;b&gt;Königsbau&lt;/b&gt;"));
  assert.match(html, /<p>Erster Absatz\.<\/p><p>Zweiter Absatz\.<\/p>/);
  assert.match(html, /1 Fotos, 1 Grundrisse/);
  assert.ok(html.indexOf("img.example/a/640x0") < html.indexOf("img.example/b/640x0"));
  assert.match(html, /1 · Foto[\s\S]*2 · Grundriss/);
});

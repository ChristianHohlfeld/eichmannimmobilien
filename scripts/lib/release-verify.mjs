/**
 * Verification of a built release BEFORE it may go live: the files on disk must show exactly
 * the listings document they were built from – no offer missing, none too many, every picture
 * present, every text section rendered. Pure file checks, no network.
 */
import fs from "node:fs";
import path from "node:path";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const count = (text, re) => (text.match(re) || []).length;
const isPublic = (L) => Boolean(L) && L.active !== false && L.site_hidden !== true;
const hasDetail = (L) => isPublic(L) && L.detail_page !== false;

/** Facts of one rendered exposé page, used by the gate and by the comparison report. */
export function inspectExposeHtml(html) {
  const main = /<main\b[^>]*>/i.exec(html)?.[0] || "";
  const a = (name) => new RegExp(`\\b${name}="([^"]*)"`).exec(main)?.[1] ?? null;
  const gallery = /<div class="expose-gallery-stage">([\s\S]*?)<\/div>\s*(?:<div class="expose-thumbs">|<\/div>)/.exec(html)?.[1] || "";
  const galleryImages = [...gallery.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
  const plans = /<section class="expose-section" id="grundriss">([\s\S]*?)<\/section>/.exec(html)?.[1] || "";
  const planImages = [...plans.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
  const sections = [...html.matchAll(/<section class="expose-section"[^>]*data-section="([^"]*)"[^>]*>\s*<h2>([\s\S]*?)<\/h2>\s*<div[^>]*><!-- SOURCE-TEXT:START -->([\s\S]*?)<!-- SOURCE-TEXT:END --><\/div>/g)].map((m) => ({ id: m[1], title: m[2].replace(/<[^>]+>/g, "").trim(), html: m[3] }));
  const facts = [...html.matchAll(/<li><span class="expose-fact-label">([\s\S]*?)<\/span><span class="expose-fact-value">([\s\S]*?)<\/span><\/li>/g)].map((m) => [m[1], m[2]]);
  return {
    listing_id: a("data-listing-id"),
    online_id: a("data-online-id"),
    content_hash: a("data-content-hash"),
    marketing: a("data-marketing"),
    h1: (/<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1] || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(),
    // the line under the headline: location · price (as text, non-breaking spaces normalised)
    hero: (/<p class="expose-hero-facts">([\s\S]*?)<\/p>/.exec(html)?.[1] || "").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim(),
    gallery_images: galleryImages,
    floorplan_images: planImages,
    sections,
    facts,
  };
}

/**
 * @param {string} dir   release directory (as it will be served)
 * @param {object} doc   exportListingsDocument() of the database the release was built from
 * @returns {{ ok: boolean, problems: string[], summary: object }}
 */
export function verifyRelease(dir, doc, { releaseId = null } = {}) {
  const problems = [];
  const bad = (msg) => problems.push(msg);
  const read = (rel) => {
    try {
      return fs.readFileSync(path.join(dir, rel), "utf8");
    } catch {
      return null;
    }
  };
  const exists = (rel) => fs.existsSync(path.join(dir, rel));
  const listDir = (rel, re) => {
    try {
      return fs.readdirSync(path.join(dir, rel)).filter((f) => re.test(f));
    } catch {
      return [];
    }
  };

  for (const f of ["index.html", "projekte.html", "sitemap.xml", "robots.txt", "impressum.html", "datenschutz.html", "kontakt.html", "css/styles.css", "ai/listings.json", "ai/build.json"]) {
    if (!exists(f)) bad(`Pflichtdatei fehlt: ${f}`);
  }
  for (const f of ["scripts", "package.json", "node_modules", "deploy", ".git"]) if (exists(f)) bad(`Nicht öffentliche Datei im Release: ${f}`);

  let build = null;
  try {
    build = JSON.parse(read("ai/build.json") || "null");
  } catch {
    bad("ai/build.json ist kein JSON");
  }
  if (releaseId && build?.release_id !== releaseId) bad(`ai/build.json gehört zu Release ${build?.release_id || "?"}, erwartet ${releaseId}`);

  const all = Array.isArray(doc?.listings) ? doc.listings : [];
  const pub = all.filter(isPublic);
  const detail = all.filter(hasDetail);
  const wantSlugs = new Set(detail.map((L) => L.slug));

  // machine index
  let ai = null;
  try {
    ai = JSON.parse(read("ai/listings.json") || "null");
  } catch {
    bad("ai/listings.json ist kein JSON");
  }
  if (ai) {
    const aiSlugs = new Set((ai.listings || []).map((L) => L.slug));
    if (ai.listing_count !== detail.length) bad(`ai/listings.json nennt ${ai.listing_count} Angebote, erwartet ${detail.length}`);
    for (const s of wantSlugs) if (!aiSlugs.has(s)) bad(`ai/listings.json: Angebot fehlt (${s})`);
    for (const s of aiSlugs) if (!wantSlugs.has(s)) bad(`ai/listings.json: Angebot zu viel (${s})`);
  }

  // exactly the expected detail pages, DE and EN
  for (const [folder, label] of [["objekt", "Objektseite"], ["en/property", "EN-Objektseite"]]) {
    const have = new Set(listDir(folder, /\.html$/).map((f) => f.replace(/\.html$/, "")));
    for (const s of wantSlugs) if (!have.has(s)) bad(`${label} fehlt: ${folder}/${s}.html`);
    for (const s of have) {
      if (wantSlugs.has(s)) continue;
      // a previous address of a published offer may exist – as a redirect to exactly that offer
      const owner = detail.find((L) => Array.isArray(L.previous_slugs) && L.previous_slugs.includes(s));
      const stub = owner ? read(`${folder}/${s}.html`) || "" : "";
      if (owner && stub.length < 1200 && stub.includes(`/${folder}/${owner.slug}.html">`) && /http-equiv="refresh"/.test(stub)) continue;
      bad(`${label} eines nicht mehr veröffentlichten Angebots: ${folder}/${s}.html`);
    }
  }

  // no page of the release may still link an offer that is not published (e.g. a block that was not re-rendered)
  for (const page of [...listDir(".", /\.html$/), ...listDir("partials", /\.html$/).map((f) => `partials/${f}`), ...listDir("en", /\.html$/).map((f) => `en/${f}`)]) {
    const html = read(page) || "";
    for (const m of html.matchAll(/href="(?:\.\.\/|\/)?(?:objekt|property)\/([a-z0-9-]+)\.html"/g)) {
      if (!wantSlugs.has(m[1])) bad(`${page}: Link auf nicht veröffentlichtes Angebot ${m[1]}`);
    }
  }

  // overview pages show every public offer exactly once
  for (const page of ["index.html", "projekte.html"]) {
    const html = read(page) || "";
    const grid = /<!-- IMMWELT-LISTINGS:START -->([\s\S]*?)<!-- IMMWELT-LISTINGS:END -->/.exec(html)?.[1];
    if (grid == null) {
      bad(`${page}: Angebotsbereich nicht gefunden`);
      continue;
    }
    const cards = count(grid, /class="listing-card[ "]/g);
    if (cards !== pub.length) bad(`${page}: ${cards} Karten, erwartet ${pub.length}`);
    for (const L of detail) if (!grid.includes(`href="objekt/${L.slug}.html"`)) bad(`${page}: Karte für ${L.slug} fehlt`);
  }

  const sitemap = read("sitemap.xml") || "";
  for (const L of detail) if (!sitemap.includes(`/objekt/${L.slug}.html</loc>`)) bad(`sitemap.xml: ${L.slug} fehlt`);
  for (const m of sitemap.matchAll(/\/objekt\/([a-z0-9-]+)\.html<\/loc>/g)) if (!wantSlugs.has(m[1])) bad(`sitemap.xml: nicht mehr veröffentlichtes Angebot ${m[1]}`);

  // every detail page shows this offer, completely
  let pictures = 0;
  for (const L of detail) {
    const rel = `objekt/${L.slug}.html`;
    const html = read(rel);
    if (!html || !html.trim()) {
      bad(`${rel}: Seite fehlt oder ist leer`);
      continue;
    }
    const page = inspectExposeHtml(html);
    if (L.immowelt_api === true && L.price_on_request) {
      // "auf Anfrage": no amount anywhere – page markup, structured data, English page
      if (/"price"\s*:/.test(html)) bad(`${rel}: strukturierte Daten nennen einen Preis trotz „auf Anfrage“`);
      const en = read(`en/property/${L.slug}.html`) || "";
      if (/"price"\s*:/.test(en) || /€\s?\d|\d\s?€/.test(en.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<h2>More properties in Konstanz<\/h2>[\s\S]*?<\/ul>/, ""))) bad(`en/property/${L.slug}.html: Betrag trotz „auf Anfrage“`);
    }
    if (page.listing_id !== L.id) bad(`${rel}: gehört zu ${page.listing_id || "?"}, erwartet ${L.id}`);
    if (L.immowelt_api === true) {
      // (scraper-era rows still pass through the old display rules; only API offers are compared 1:1)
      if (page.h1 !== String(L.title).replace(/\s+/g, " ").trim() && !html.includes(`<span>${esc(L.title)}</span></h1>`)) bad(`${rel}: Überschrift des Angebots fehlt oder weicht ab`);
      if (page.content_hash !== L.content_hash) bad(`${rel}: Inhalt stammt nicht aus dem aktuellen Stand (Hash ${String(page.content_hash).slice(0, 8)} ≠ ${String(L.content_hash).slice(0, 8)})`);
      if (page.marketing !== L.marketing) bad(`${rel}: Vermarktungsart ${page.marketing} ≠ ${L.marketing}`);
      const gallery = (L.gallery_bases || []).map((b) => `../${b}.jpg`);
      const plans = (L.floor_plan_bases || []).map((b) => `../${b}.jpg`);
      if (page.gallery_images.join("|") !== gallery.join("|")) bad(`${rel}: Galerie zeigt ${page.gallery_images.length} Bild(er), erwartet ${gallery.length} in API-Reihenfolge`);
      if (page.floorplan_images.join("|") !== plans.join("|")) bad(`${rel}: ${page.floorplan_images.length} Grundriss(e), erwartet ${plans.length}`);
      const wantSections = (L.sections || []).map((s) => s.title);
      if (page.sections.map((s) => s.title).join("|") !== wantSections.map(esc).join("|")) bad(`${rel}: Textabschnitte weichen ab (${page.sections.length} statt ${wantSections.length})`);
      for (const s of L.sections || []) if (s.html && !html.includes(s.html)) bad(`${rel}: Abschnitt „${s.title}“ ist nicht vollständig wiedergegeben`);
      for (const r of L.fact_rows || []) {
        if (!page.facts.some(([k, v]) => k === esc(r.label) && v === esc(r.value))) bad(`${rel}: Angabe „${r.label}“ fehlt oder weicht ab`);
      }
      if (!page.hero.split(" · ").map((x) => x.trim()).includes(esc(L.price))) bad(`${rel}: Preiszeile zeigt nicht „${L.price}“`);
      if (L.price_on_request && /\d\s*€/.test(page.hero)) bad(`${rel}: Betrag sichtbar, obwohl Immowelt „auf Anfrage“ meldet`);
      // the card on the overview carries the same headline and price
      const index = read("index.html") || "";
      const at = index.indexOf(`href="objekt/${L.slug}.html"`);
      const card = at >= 0 ? index.slice(at, index.indexOf("</a>", at)) : "";
      if (!card.includes(`>${esc(L.title)}<`)) bad(`index.html: Karte ${L.slug} zeigt nicht die Überschrift von Immowelt`);
      if (!card.includes(`<p class="listing-price">${esc(L.price)}</p>`)) bad(`index.html: Karte ${L.slug} zeigt nicht „${L.price}“`);
    }
    for (const base of [...(L.gallery_bases || []), ...(L.floor_plan_bases || [])]) {
      if (typeof base !== "string") continue;
      const fileBase = base.includes("/") ? base : `assets/listings/${base}`;
      pictures++;
      for (const ext of [".jpg", ".webp"]) if (!exists(fileBase + ext)) bad(`${rel}: Bilddatei fehlt (${path.basename(fileBase)}${ext})`);
    }
  }

  return { ok: problems.length === 0, problems, summary: { public: pub.length, detail: detail.length, pictures, immowelt: pub.filter((L) => L.origin !== "eigen").length, eigen: pub.filter((L) => L.origin === "eigen").length } };
}

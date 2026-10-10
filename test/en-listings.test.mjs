// Claude global concept: English page per listing – pairs, canonical, hreflang, sitemap, JSON-LD, AI index.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSot } from "../scripts/lib/sot.mjs";
import { listingEn } from "../scripts/lib/listing-en.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const O = "https://immobilieneichmann.de";
const sot = loadSot(ROOT, { fresh: true });
const files = readdirSync(path.join(ROOT, "en/property")).filter((f) => f.endsWith(".html")).sort();
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

test("je aktives Objekt eine EN-Seite", () => {
  assert.deepEqual(files.map((f) => f.replace(/\.html$/, "")), sot.activeListings.map((l) => l.slug).sort());
});
test("Canonical selbst, hreflang de/en/x-default gegenseitig, keine Weiterleitung", () => {
  for (const f of files) {
    const de = `${O}/objekt/${f}`, en = `${O}/en/property/${f}`;
    for (const [h, self] of [[read(`en/property/${f}`), en], [read(`objekt/${f}`), de]]) {
      const head = h.slice(0, h.indexOf("</head>"));
      assert.ok(head.includes(`<link rel="canonical" href="${self}">`), `${f} canonical`);
      assert.ok(head.includes(`hreflang="de" href="${de}"`) && head.includes(`hreflang="en" href="${en}"`) && head.includes(`hreflang="x-default" href="${en}"`), `${f} hreflang`);
      assert.ok(!/http-equiv="refresh"/i.test(head));
    }
    assert.match(read(`en/property/${f}`), /<html lang="en">/);
  }
});
test("Sitemap: EN-URL je Objekt mit hreflang-Paar", () => {
  const sm = read("sitemap.xml");
  for (const f of files) {
    assert.ok(sm.includes(`<loc>${O}/en/property/${f}</loc>`), f);
    assert.ok(sm.includes(`<xhtml:link rel="alternate" hreflang="en" href="${O}/en/property/${f}"/>`), f);
  }
});
test("JSON-LD gültig, RealEstateListing + Offer EUR, keine Verfügbarkeit", () => {
  for (const f of files) {
    const h = read(`en/property/${f}`);
    const j = JSON.parse(h.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
    const l = j["@graph"].find((x) => x["@type"] === "RealEstateListing");
    assert.equal(l.offers.priceCurrency, "EUR");
    assert.ok(!/availability|availabilityStarts/i.test(JSON.stringify(j)));
  }
});
test("Harte Regeln + Titel/Description-Länge + Anruf-Knopf", () => {
  for (const f of files) {
    const h = read(`en/property/${f}`);
    assert.ok(!/planning permission|building permit|construction (start|begins)|completion|Baubegin|Genehmigung|countdown|only \d+ left|last (units|chance)|hurry/i.test(h), f);
    assert.ok(h.match(/<title>([^<]*)<\/title>/)[1].length <= 60, f);
    assert.ok(h.match(/name="description" content="([^"]*)"/)[1].length <= 160, f);
    assert.match(h, /class="[^"]*btn-call[^"]*"[^>]*>Call <span class="nowrap">\+49 170 522 5568/);
  }
});
test("Zahlen nur aus den Objektdaten (Preis/Fläche aus dem Exposé)", () => {
  const data = JSON.parse(read("data/listings.json"));
  for (const L of data.listings.filter((x) => files.includes(`${x.slug}.html`))) {
    const m = listingEn(L);
    const h = read(`en/property/${L.slug}.html`);
    assert.ok(h.includes(`€${m.price.toLocaleString("en-GB")}`), L.slug);
    assert.equal(m.price, Number(String(L.facts?.Kaufpreis || L.price).replace(/[^\d]/g, "")));
  }
});
test("AI-Index + llms.txt + /en/ verlinken alle EN-Seiten", () => {
  const ai = JSON.parse(read("ai/listings.json"));
  assert.ok(ai.listings.every((l) => l.url_en === `${O}/en/property/${l.slug}.html` && l.title_en));
  const llms = read("llms.txt"), home = read("en/index.html");
  for (const f of files) { assert.ok(llms.includes(`${O}/en/property/${f}`)); assert.ok(home.includes(`/en/property/${f}`)); }
});

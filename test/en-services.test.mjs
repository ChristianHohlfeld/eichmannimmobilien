// Local SEO EN: English service pages – pairs, hreflang (x-default = en), title/H1, keyword in first sentence,
// why block, FAQ + FAQPage, word count, links, nav, sitemap, llms.txt, hard rules.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EN_SERVICES } from "../scripts/lib/en-services.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const O = "https://immobilieneichmann.de";
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");
const main = (h) => h.slice(h.indexOf("<main"), h.indexOf("</main>"));
const text = (h) => main(h).replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();

test("8 EN service pages", () => assert.equal(EN_SERVICES.length, 8));
for (const sv of EN_SERVICES) {
  const en = read(sv.en.slice(1)), de = read(sv.deFile);
  test(`${sv.en}: canonical + hreflang de/en/x-default(en) both ways`, () => {
    assert.match(en, /<html lang="en">/);
    assert.ok(en.includes(`<link rel="canonical" href="${O}${sv.en}">`));
    for (const h of [en, de]) {
      const head = h.slice(0, h.indexOf("</head>"));
      assert.ok(head.includes(`hreflang="de" href="${O}${sv.de}"`) && head.includes(`hreflang="en" href="${O}${sv.en}"`) && head.includes(`hreflang="x-default" href="${O}${sv.en}"`));
      assert.equal((head.match(/hreflang="x-default"/g) || []).length, 1);
    }
    assert.ok(de.includes(`href="${sv.en}" hreflang="en"`), "DE page links to EN");
  });
  test(`${sv.en}: title, H1, keyword in first sentence, why block, FAQ + FAQPage, length`, () => {
    const title = en.match(/<title>(.*?)<\/title>/)[1];
    assert.match(title, /^[A-Z][\w -]+ \| Immobilien Eichmann$/);
    const kw = title.split(" | ")[0].toLowerCase();
    const h1 = en.match(/<h1>(.*?)<\/h1>/)[1].toLowerCase();
    const lead = en.match(/<p class="lead">(.*?)<\/p>/)[1].toLowerCase();
    const core = kw.replace(/^(buy|sell) (a |an )?/, "").replace(/ konstanz$/, "");
    const first = lead.split(/[.:?]/)[0];
    assert.ok(core.split(" ").every((w) => h1.includes(w) && first.includes(w)), `keyword „${core}“ in H1/first sentence`);
    assert.match(en, /Why Immobilien Eichmann/);
    const ld = [...en.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
    const faq = ld.flatMap((d) => d["@graph"] || [d]).find((n) => n["@type"] === "FAQPage");
    assert.ok(faq && faq.mainEntity.length >= 3);
    assert.equal((en.match(/class="faq-item"/g) || []).length, faq.mainEntity.length);
    const words = text(en).split(" ").length;
    assert.ok(words >= 380 && words <= 700, `${words} words`);
  });
  test(`${sv.en}: links to other service pages, nav, hard rules`, () => {
    const m = main(en);
    assert.ok(EN_SERVICES.filter((x) => x !== sv).every((x) => m.includes(`href="${x.en}"`)));
    assert.match(en, /<nav class="nav"[\s\S]*href="\/en\/services.html"/);
    assert.doesNotMatch(text(en), /building permit|planning permission|construction start|Bauantrag|Baubeginn|Genehmigung|countdown|days left|sea view|lake view/i);
    // Confirmed by Chris 2026-10-11: one neutral "Languages" line per page (not tied to one person, not per CTA).
    assert.equal((en.match(/Languages: English, German/g) || []).length, 1);
    assert.doesNotMatch(en, /We answer enquiries in English and German/);
    assert.doesNotMatch(text(en), /Helmut Eichmann answers|English-speaking/i);
  });
}
test("property pages link to services; sitemap + llms.txt contain all EN service pages", () => {
  const sm = read("sitemap.xml"), llms = read("llms.txt");
  for (const sv of EN_SERVICES) { assert.ok(sm.includes(`<loc>${O}${sv.en}</loc>`), sv.en); assert.ok(llms.includes(`${O}${sv.en}`), sv.en); }
  assert.ok(EN_SERVICES.filter((s) => s.listings).some((s) => main(read(s.en.slice(1))).includes('href="/en/property/')));
  assert.match(read("en/property/wohnung-petershausen-86a7d4f6.html"), /href="\/en\/services.html"/);
});

test("EN language line + company JSON-LD languages (de, en)", async () => {
  const fs = await import("node:fs");
  const pages = ["en/index.html", "en/contact.html", "en/allmannsdorf.html", "en/services.html", ...fs.readdirSync("en/property").filter((f) => f.endsWith(".html")).map((f) => `en/property/${f}`)];
  for (const p of pages) {
    const h = fs.readFileSync(p, "utf8");
    assert.equal((h.match(/data-lang-note>Languages: English, German</g) || []).length, 1, p);
    assert.doesNotMatch(h, /We answer enquiries in English and German|viewings, documents/i, p);
    assert.doesNotMatch(h, /Helmut Eichmann (answers|speaks)|English-speaking/i, p);
  }
  assert.match(fs.readFileSync("en/contact.html", "utf8"), /<li data-lang-note>Languages: English, German<\/li>/);
  for (const p of ["index.html", "en/index.html"]) {
    const h = fs.readFileSync(p, "utf8");
    assert.match(h, /"knowsLanguage":\s*\[\s*"de",\s*"en"\s*\]/, p);
    assert.match(h, /"availableLanguage":\s*\[\s*"de",\s*"en"\s*\]/, p);
  }
  assert.match(fs.readFileSync("llms.txt", "utf8"), /English and German/);
});

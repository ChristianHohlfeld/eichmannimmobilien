import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { loadSot, checkStructure, renderText, formatFact, projectsDocument, projectTexts, publicContact, dataAsOfLabel, sitemapStatic, hreflangPairs } from "../scripts/lib/sot.mjs";
import { compileRules, checkWording, checkNoRawNumbers, allowedNumberSet, checkNumbersInOutput } from "../scripts/lib/rules.mjs";
import { flyerModalInner } from "../scripts/lib/flyer-modal.mjs";

const sot = loadSot();
const rules = compileRules(sot.wording);
const hits = (text, opts) => checkWording(text, rules, { where: "test", ...opts }).map((v) => v.rule);
const P = sot.projects[0];
const ctx = (lang) => ({ project: P, contact: sot.contact, wording: sot.wording, lang });

test("Quelle ist strukturell gültig", () => assert.deepEqual(checkStructure(sot), []));
test("validate-sot läuft grün", () => { execFileSync(process.execPath, ["scripts/validate-sot.mjs"], { stdio: "pipe" }); });

test("Wahres & Verkaufsrelevantes ist erlaubt (keine Vorsichts-Regeln)", () => {
  assert.deepEqual(hits("Neubau Allmannsdorf – jetzt provisionsfrei vormerken"), []);
  assert.deepEqual(hits("Viele Wohnungen mit traumhafter Seesicht"), []);
  assert.deepEqual(hits("many with views of Lake Constance"), []);
  assert.deepEqual(hits("NEUBAUPROJEKT Sunside Living – hier entsteht Wohnraum"), []);
});
test("Harte Regeln: Bauantrag/Baubeginn/Genehmigung, Countdowns", () => {
  assert.deepEqual(hits("Bauantrag gestellt"), ["construction_status"]);
  assert.deepEqual(hits("Baubeginn nach Genehmigung"), ["construction_status", "construction_status"]);
  assert.deepEqual(hits("Fertigstellung Oktober 2026"), ["construction_status"]);
  assert.deepEqual(hits("building permit granted"), ["construction_status"]);
  assert.deepEqual(hits("Nur noch 3 Wohnungen"), ["countdown"]);
  assert.deepEqual(hits("only 2 left"), ["countdown"]);
});
test("Ausnahme gilt nur bis zum Ablaufdatum", () => {
  const waivers = [{ rule: "construction_status", match: "Genehmigung", until: "2027-03-31" }];
  assert.deepEqual(hits("vorbehaltlich der Genehmigung durch die Stadt", { waivers, today: "2026-10-10" }), []);
  assert.deepEqual(hits("vorbehaltlich der Genehmigung durch die Stadt", { waivers, today: "2027-04-01" }), ["construction_status"]);
});
test("Zahlen nur über belegte Fakten (Quelle)", () => {
  assert.equal(checkNoRawNumbers("{{fact.units}} Wohnungen", rules, { where: "t" }).length, 0);
  assert.equal(checkNoRawNumbers("44 Wohnungen in fünf Häusern", rules, { where: "t" }).length, 2);
});
test("Zahlen ohne Beleg in der Ausgabe werden erkannt", () => {
  const allowed = allowedNumberSet(sot, rules);
  assert.equal(checkNumbersInOutput("44 Wohnungen, 295.000–1.450.000 €, +49 170 522 5568", allowed, { where: "t" }).length, 0);
  assert.equal(checkNumbersInOutput("nur 12 Wohnungen frei", allowed, { where: "t" }).length, 1);
});
test("Fakten je Sprache formatiert, Platzhalter aufgelöst", () => {
  assert.equal(formatFact(P.facts.price, "de"), "295.000–1.450.000 €");
  assert.equal(formatFact(P.facts.price, "en"), "€295,000–€1,450,000");
  assert.equal(formatFact(P.facts.plot_area, "de"), "ca. 4.000 m²");
  assert.equal(renderText("{{fact.buildings|word}} / {{fact.living_area.min|n}} bis {{fact.living_area.max}}", ctx("en")), "five / 40 bis 124 m²");
  assert.throws(() => renderText("{{fact.unbekannt}}", ctx("de")));
});
test("Kein Bau-Status/Countdown in allen Projekttexten (DE+EN), Seesicht aus dem Flyer vorhanden", () => {
  for (const lang of ["de", "en"]) {
    const t = JSON.stringify(projectTexts(sot, "allmannsdorf", lang));
    assert.deepEqual(hits(t), [], lang);
  }
  assert.match(JSON.stringify(projectTexts(sot, "allmannsdorf", "de")), /Seesicht/);
  assert.match(JSON.stringify(projectTexts(sot, "allmannsdorf", "en")), /Lake Constance/);
});
test("Kompatibilitäts-Export data/projects.json = SSOT", () => {
  const onDisk = JSON.parse(readFileSync("data/projects.json", "utf8"));
  assert.deepEqual(onDisk.projects, projectsDocument(sot).projects);
});
test("Kontakt kommt aus contact.json", () => {
  const c = publicContact(sot);
  assert.equal(c.phone_mobile.tel, "tel:+491705225568");
  assert.match(c.whatsapp.url_allmannsdorf, /Neubau%20Allmannsdorf/);
});
test("Seitenregister: Sitemap + hreflang-Paare", () => {
  const sm = sitemapStatic(sot).map((x) => x.loc);
  assert.ok(sm.includes("/") && sm.includes("/en/") && sm.includes("/en/allmannsdorf.html"));
  assert.ok(!sm.some((x) => !/(\.html|\/)$/.test(x)), "nur HTML in der Sitemap");
  assert.deepEqual(hreflangPairs(sot).map((p) => p.en).sort(), ["/en/", "/en/allmannsdorf.html", "/en/buying-from-abroad.html", "/en/contact.html"]);
});
test("Datenstand = ältestes Prüfdatum aktiver Objekte", () => {
  const oldest = sot.listings.filter((l) => l.status === "active").map((l) => l.verified_at).sort()[0];
  assert.equal(sot.dataAsOf, oldest);
  assert.match(dataAsOfLabel(sot), /^\d{2}\.\d{2}\.\d{4}$/);
});
test("Flyer-Fenster: ein Template, Zahlen aus Fakten, Bildhinweis, Seesicht-Highlight", () => {
  const h = flyerModalInner(sot);
  assert.match(h, /44 Wohnungen/);
  assert.match(h, /Visualisierung/);
  assert.match(h, /Seesicht/);
  assert.deepEqual(hits(h), []);
  assert.ok(existsSync("partials/flyer-modal.html"));
});
test("check-output: Ausgabe regelkonform", () => { execFileSync(process.execPath, ["scripts/check-output.mjs"], { stdio: "pipe" }); });

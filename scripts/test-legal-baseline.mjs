#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = [];
async function walk(dir) {
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    if (["node_modules",".git","test-results"].includes(ent.name)) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) await walk(p);
    else if (ent.isFile() && p.endsWith(".html")) html.push(p);
  }
}
await walk(ROOT);

for (const file of html) {
  const s = await readFile(file, "utf8");
  assert.ok(!s.includes("fonts.googleapis.com"), file + ": external Google Fonts");
  assert.ok(!s.includes("fonts.gstatic.com"), file + ": external Google Fonts preconnect");
  assert.ok(!/maps\.google\.com\/maps\?[^"']*output=embed/.test(s), file + ": automatic Google Maps embed");
  assert.ok(!/\snovalidate(?=[\s>])/.test(s), file + ": native validation disabled");
  assert.ok(!s.includes("[Platzhalter"), file + ": legal placeholder");
  assert.ok(!s.includes('name="datenschutz"'), file + ": unnecessary mandatory privacy-consent checkbox");
  assert.ok(!s.includes("Einwilligung oder Maklervertrag in Textform zurücknehmen"), file + ": privacy/contract withdrawal conflated");
  assert.ok(!s.includes("Ausführliche Objektbeschreibung folgt mit dem nächsten Immowelt-Abgleich"), file + ": synthetic expose-description fallback must never appear");
  assert.ok(!s.includes("Die ausführliche Objektbeschreibung stellen wir Ihnen gerne auf Anfrage zu"), file + ": generic expose-description fallback must never appear");
}
for (const file of html) {
  const s = await readFile(file, "utf8");
  assert.ok(!s.includes('name="privacy_ack"'), file + ": unnecessary privacy acknowledgement checkbox");
}
const impressum = await readFile(path.join(ROOT, "impressum.html"), "utf8");
assert.ok(impressum.includes("Industrie- und Handelskammer Hochrhein-Bodensee"), "Impressum: §34c authority missing");
const datenschutz = await readFile(path.join(ROOT, "datenschutz.html"), "utf8");
for (const needle of ["GitHub Pages","forms.digitalisierungsplanung.de","Amazon Simple Email Service","Google Analytics","Local Storage","Landesbeauftragte"]) assert.ok(datenschutz.includes(needle), "Datenschutz missing " + needle);
assert.ok(!datenschutz.includes("FormSubmit"), "Datenschutz: retired FormSubmit reference");
const immoweltAttribution = "Immobilien-Daten bereitgestellt von immowelt.de";
for (const rel of ["index.html", "projekte.html"]) {
  const s = await readFile(path.join(ROOT, rel), "utf8");
  assert.ok(s.includes(immoweltAttribution), rel + ": required Immowelt API attribution missing");
  assert.ok(/href="https:\/\/www\.immowelt\.de\/?"/.test(s), rel + ": Immowelt attribution must link to immowelt.de");
}
for (const file of html.filter((p) => p.includes(path.sep + "objekt" + path.sep))) {
  const s = await readFile(file, "utf8");
  assert.ok(s.includes(immoweltAttribution), file + ": required Immowelt API attribution missing");
}

const kontakt = await readFile(path.join(ROOT, "kontakt.html"), "utf8");
assert.ok(kontakt.includes("Durch das Absenden kommt kein Maklervertrag zustande."), "Kontakt: no-contract notice missing");
assert.ok(kontakt.includes('action="https://forms.digitalisierungsplanung.de/v1/immobilieneichmann/contact"'), "Kontakt: own form gateway missing");
assert.ok(!kontakt.includes("formsubmit.co"), "Kontakt: retired FormSubmit action");
const widerruf = await readFile(path.join(ROOT, "widerrufsbelehrung.html"), "utf8");
assert.ok(widerruf.includes("vierzehn Tagen"), "Widerruf: 14 days missing");
assert.ok(!widerruf.includes("30 Tagen"), "Widerruf: obsolete 30 days");
assert.ok(!widerruf.includes("Kontakt-, Vormerkungs- oder Exposé-Anfrage"), "Widerrufsbelehrung: request disclaimer should not be present");
const vertragWiderrufen = await readFile(path.join(ROOT, "vertrag-widerrufen.html"), "utf8");
assert.ok(!vertragWiderrufen.includes("bloße Kontakt-, Vormerkungs- oder Exposé-Anfrage"), "Vertrag widerrufen: unnecessary request disclaimer should not be present");
const generator = await readFile(path.join(ROOT, "scripts", "sync-immowelt.mjs"), "utf8");
assert.ok(generator.includes("cookie-consent.js"), "Generator: cookie consent missing");
assert.ok(!generator.includes('src="${p}js/analytics.js"'), "Generator: direct analytics load");
assert.ok(generator.includes("Durch das Absenden kommt kein Maklervertrag zustande."), "Generator: no-contract notice missing");
assert.ok(!generator.includes('name="privacy_ack"'), "Generator: unnecessary privacy acknowledgement present");
assert.ok(generator.includes('action="https://forms.digitalisierungsplanung.de/v1/immobilieneichmann/expose"'), "Generator: own expose gateway missing");
assert.ok(!generator.includes("formsubmit.co"), "Generator: retired FormSubmit action");
assert.ok(!generator.includes("Ausführliche Objektbeschreibung folgt mit dem nächsten Immowelt-Abgleich"), "Generator: synthetic expose-description fallback must never return");
assert.ok(!generator.includes("Die ausführliche Objektbeschreibung stellen wir Ihnen gerne auf Anfrage zu"), "Generator: generic expose-description fallback must never return");
assert.ok(!kontakt.includes("Die Anfrage ist unverbindlich;"), "Kontakt: verbose request notice should be removed");
assert.ok(generator.includes("logo-header.svg?v=header-safe-v1"), "Generator: safe header logo missing");
console.log("Legal baseline OK: " + html.length + " HTML files checked.");

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
}
for (const file of html) {
  const s = await readFile(file, "utf8");
  if (s.includes('id="contact-form"')) {
    assert.ok(/name="privacy_ack"[^>]*required|required[^>]*name="privacy_ack"/.test(s), file + ": contact-form missing required privacy acknowledgement");
  }
}
const impressum = await readFile(path.join(ROOT, "impressum.html"), "utf8");
assert.ok(impressum.includes("Industrie- und Handelskammer Hochrhein-Bodensee"), "Impressum: §34c authority missing");
const datenschutz = await readFile(path.join(ROOT, "datenschutz.html"), "utf8");
for (const needle of ["GitHub Pages","FormSubmit","Google Analytics","Local Storage","Landesbeauftragte"]) assert.ok(datenschutz.includes(needle), "Datenschutz missing " + needle);
const kontakt = await readFile(path.join(ROOT, "kontakt.html"), "utf8");
assert.ok(kontakt.includes("Die Anfrage ist unverbindlich; durch das Absenden kommt kein Maklervertrag zustande."), "Kontakt: non-binding notice missing");
const widerruf = await readFile(path.join(ROOT, "widerrufsbelehrung.html"), "utf8");
assert.ok(widerruf.includes("vierzehn Tagen"), "Widerruf: 14 days missing");
assert.ok(!widerruf.includes("30 Tagen"), "Widerruf: obsolete 30 days");
const generator = await readFile(path.join(ROOT, "scripts", "sync-immowelt.mjs"), "utf8");
assert.ok(generator.includes("cookie-consent.js"), "Generator: cookie consent missing");
assert.ok(!generator.includes('src="${p}js/analytics.js"'), "Generator: direct analytics load");
assert.ok(generator.includes("Die Anfrage ist unverbindlich; durch das Absenden kommt kein Maklervertrag zustande."), "Generator: non-binding notice missing");
assert.ok(generator.includes('name="privacy_ack"') && generator.includes("required"), "Generator: required privacy acknowledgement missing");
assert.ok(generator.includes("logo-header.svg?v=header-safe-v1"), "Generator: safe header logo missing");
console.log("Legal baseline OK: " + html.length + " HTML files checked.");

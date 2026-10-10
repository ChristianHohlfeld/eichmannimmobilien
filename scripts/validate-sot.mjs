#!/usr/bin/env node
// Schritt 1 des Builds: Abbruch, bevor gerendert wird, wenn die Quelle (data/sot/) eine Regel bricht.
import { execFileSync } from "node:child_process";
import { loadSot, checkStructure, renderText, projectTemplates } from "./lib/sot.mjs";
import { compileRules, checkWording, checkNoRawNumbers } from "./lib/rules.mjs";
import { stripProjectStatus } from "./lib/listing-text.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";

const sot = loadSot(undefined, { fresh: true });
const rules = compileRules(sot.wording);
const today = new Date().toISOString().slice(0, 10);
const problems = checkStructure(sot).map((message) => ({ where: "struktur", rule: "schema", hit: "", message }));

// Felder, deren Werte keine Fließtexte sind (Pfade, IDs, Schlüssel)
const NON_TEXT = /^page\.\w+\.(images|pages|cta\.(phone|email))\b|\.key$/;
for (const p of sot.projects) {
  for (const { key, lang, text } of projectTemplates(p)) {
    const where = `projects.${p.id}.${key}`;
    problems.push(...checkWording(text, rules, { where, today }));
    if (!NON_TEXT.test(key)) problems.push(...checkNoRawNumbers(text, rules, { where }));
    try { renderText(text, { project: p, contact: sot.contact, wording: sot.wording, lang }); }
    catch (e) { problems.push({ where, rule: "placeholder", hit: "", message: e.message }); }
  }
}
for (const [k, t] of Object.entries(sot.contact.whatsapp_text_project || {}))
  problems.push(...checkWording(t, rules, { where: `contact.whatsapp_text_project.${k}` }));

// Exposé-Wortlaut gehört dem Importer: Regeln gelten, Ausnahmen mit Ablaufdatum möglich.
// Projektstatus-Sätze (Baubeginn/Fertigstellung …) werden beim Rendern ohnehin ausgelassen (listing-text.mjs).
for (const l of sot.listings) {
  const where = `listings.${l.slug}`;
  for (const w of l.waivers ?? []) if (w.until < today)
    problems.push({ where, rule: "waiver_expired", hit: w.match, message: `Ausnahme abgelaufen (${w.until}) – erneut prüfen oder Text ändern.` });
  for (const [key, byLang] of Object.entries(l.overrides ?? {}))
    for (const [lang, text] of Object.entries(byLang))
      problems.push(...checkWording(text, rules, { where: `${where}.overrides.${key}.${lang}` }));
}

// Exposé-Wortlaut (data/listings.json, vom Importer) so prüfen, wie er gerendert wird.
// Projektname-Regel gilt nur für Allmannsdorf (andere Neubauten heißen bei Immowelt „Neubauprojekt …“).
try {
  const imp = JSON.parse(readFileSync(path.join(sot.root, "data", "listings.json"), "utf8"));
  for (const L of imp.listings || []) {
    const lay = sot.listings.find((l) => l.id === String(L.immowelt_id || L.id));
    if (!lay || lay.status !== "active") continue;
    for (const key of ["description", "location_description", "additional_information"]) {
      const text = stripProjectStatus(L[key] || "");
      problems.push(...checkWording(text, rules, { where: `listings.${lay.slug}.source_text.${key}`, waivers: lay.waivers, today, skip: ["project_name"] }));
    }
  }
} catch (e) { problems.push({ where: "data/listings.json", rule: "schema", hit: "", message: e.message }); }

// Slugs sind eingefroren: Vergleich mit origin/main (wenn verfügbar).
const base = process.env.SOT_SLUG_BASE || "origin/main";
try {
  const prev = JSON.parse(execFileSync("git", ["show", `${base}:data/sot/listings.json`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  const now = new Map(sot.listings.map((l) => [l.id, l.slug]));
  for (const l of prev.listings || []) {
    if (now.has(l.id) && now.get(l.id) !== l.slug)
      problems.push({ where: `listings.${l.id}`, rule: "slug_frozen", hit: `${l.slug} → ${now.get(l.id)}`, message: "Slug geändert – Slugs sind eingefroren (URLs/Backlinks)." });
  }
} catch { /* erster Lauf oder kein git: nichts zu vergleichen */ }

if (problems.length) {
  for (const p of problems) console.error(`✗ ${p.where} [${p.rule}] ${p.hit ? `„${p.hit}“ ` : ""}${p.message}`);
  console.error(`\n${problems.length} Verstoß/Verstöße. Build abgebrochen.`);
  process.exit(1);
}
console.log(`✓ SSOT gültig · Hash ${sot.hash} · ${sot.activeListings.length} aktive Objekte · Datenstand ${sot.dataAsOf}`);

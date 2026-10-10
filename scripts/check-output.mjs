#!/usr/bin/env node
/**
 * Letzter Schritt des Builds: prüft, was ausgeliefert wird (HTML, JSON, TXT, XML), mit denselben Regeln
 * wie die Quelle. Fängt Texte, die in Templates statt in data/sot/ stehen.
 *  - Wording-Regeln (Chris) auf der ganzen Datei inkl. JSON-LD, Meta, alt-Texte, ai/*.json, llms.txt
 *  - zitierter Exposé-Wortlaut steht in <!-- SOURCE-TEXT:START/END --> → nur in der Quelle geprüft
 *  - Zahlenprüfung auf den Projektseiten (nur belegte Fakten, Kontakt, Objektzahl, Allowlist)
 *  - Konsistenz: hreflang gegenseitig + x-default, Objektzahl überall gleich, Datenstand überall gleich
 * Usage: node scripts/check-output.mjs [root] [--report]
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { loadSot, dataAsOfLabel } from "./lib/sot.mjs";
import { checkPage } from "./lib/page-checks.mjs";
import { compileRules, checkWording, allowedNumberSet, checkNumbersInOutput } from "./lib/rules.mjs";

const args = process.argv.slice(2);
const REPORT = args.includes("--report");
const root = path.resolve(args.find((a) => !a.startsWith("--")) || path.join(path.dirname(new URL(import.meta.url).pathname), ".."));
const sot = loadSot(root, { fresh: true });
const rules = compileRules(sot.wording);
const today = new Date().toISOString().slice(0, 10);

// Was öffentlich ausgeliefert wird
const PUBLIC_DIRS = ["", "en", "en/property", "objekt", "ai", ".well-known", "partials"];
const files = [];
for (const d of PUBLIC_DIRS) {
  const dir = path.join(root, d);
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isFile() && /\.(html|json|txt|xml)$/.test(f) && !/^(package(-lock)?|tsconfig)\.json$/.test(f)) files.push(p);
  }
}

const stripSourceText = (s) => s.replace(/<!-- SOURCE-TEXT:START -->[\s\S]*?<!-- SOURCE-TEXT:END -->/g, " ");
const visibleText = (html) => html
  .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, " ")
  .replace(/<(script|style)[\s\S]*?<\/\1>/g, " ")
  .replace(/<!--[\s\S]*?-->/g, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ")
  .replace(/&[a-z]+;|&#\d+;/g, " ");

const pageByFile = new Map();
for (const p of sot.pages.pages) for (const [lang, f] of Object.entries(p.file || {})) pageByFile.set(f, p);
const allowed = allowedNumberSet(sot, rules);
for (const lab of [dataAsOfLabel(sot, "de")]) lab.split(".").forEach((x) => allowed.add(x));
const allWaivers = sot.listings.flatMap((l) => l.waivers ?? []);

const problems = [];
for (const file of files) {
  const rel = path.relative(root, file);
  const raw = stripSourceText(readFileSync(file, "utf8"));
  const page = pageByFile.get(rel);
  const skip = page?.rule_exempt || [];
  // Rohdatei → JSON-LD, Meta, alt-Texte, JSON/TXT sind abgedeckt
  problems.push(...checkWording(raw, rules, { where: rel, waivers: allWaivers, today, skip }));
  if (/\.html$/.test(rel) && !rel.startsWith("partials/") && !/^(admin|mcp-static)\//.test(rel)) problems.push(...checkPage(readFileSync(file, "utf8"), rel)); // Claude R4 Code 3
  const isProjectPage = sot.projects.some((p) => Object.values(p.paths).includes(rel));
  if (isProjectPage) {
    const text = visibleText(raw.replace(/<footer[\s\S]*?<\/footer>/, " ").replace(/<header[\s\S]*?<\/header>/, " "));
    problems.push(...checkNumbersInOutput(text, allowed, { where: rel }));
  }
}

// Konsistenz: hreflang gegenseitig
const O = "https://immobilieneichmann.de";
for (const p of sot.pages.pages.filter((x) => x.paths?.en)) {
  for (const lang of ["de", "en"]) {
    const f = p.file?.[lang];
    if (!f || !existsSync(path.join(root, f))) { problems.push({ where: p.id, rule: "hreflang", hit: lang, message: "Datei fehlt" }); continue; }
    const h = readFileSync(path.join(root, f), "utf8");
    const head = h.slice(0, h.indexOf("</head>"));
    for (const [l, target] of [["de", p.paths.de], ["en", p.paths.en], ["x-default", p.paths.de]])
      if (!head.includes(`hreflang="${l}" href="${O}${target}"`))
        problems.push({ where: f, rule: "hreflang", hit: l, message: `hreflang ${l} → ${target} fehlt im <head>` });
  }
}
// Konsistenz: EN-Objektseiten (Claude global) – je aktives Objekt ein Paar, hreflang gegenseitig, Canonical selbst
{
  const enDir = path.join(root, "en/property");
  const enFiles = existsSync(enDir) ? readdirSync(enDir).filter((f) => f.endsWith(".html")) : [];
  if (enFiles.length !== sot.activeListings.length)
    problems.push({ where: "en/property", rule: "consistency", hit: String(enFiles.length), message: `EN-Objektseiten ≠ aktive Objekte (${sot.activeListings.length})` });
  for (const f of enFiles) {
    const slug = f.replace(/\.html$/, "");
    const de = `${O}/objekt/${slug}.html`, en = `${O}/en/property/${slug}.html`;
    const eh = readFileSync(path.join(enDir, f), "utf8"), dp = path.join(root, "objekt", f);
    if (!existsSync(dp)) { problems.push({ where: `en/property/${f}`, rule: "hreflang", hit: "", message: "deutsche Objektseite fehlt" }); continue; }
    const dh = readFileSync(dp, "utf8");
    if (!eh.includes(`<link rel="canonical" href="${en}">`)) problems.push({ where: `en/property/${f}`, rule: "canonical", hit: "", message: "Canonical nicht selbstreferenzierend" });
    if (!dh.includes(`<link rel="canonical" href="${de}">`)) problems.push({ where: `objekt/${f}`, rule: "canonical", hit: "", message: "Canonical nicht selbstreferenzierend" });
    for (const h of [eh, dh]) for (const [l, t] of [["de", de], ["en", en], ["x-default", de]])
      if (!h.slice(0, h.indexOf("</head>")).includes(`hreflang="${l}" href="${t}"`)) problems.push({ where: f, rule: "hreflang", hit: l, message: `hreflang ${l} fehlt (${h === eh ? "EN" : "DE"})` });
  }
}
// Konsistenz: Objektzahl + Datenstand
try {
  const ai = JSON.parse(readFileSync(path.join(root, "ai/listings.json"), "utf8"));
  if (ai.listing_count !== sot.activeListings.length)
    problems.push({ where: "ai/listings.json", rule: "consistency", hit: String(ai.listing_count), message: `Objektzahl ≠ SSOT (${sot.activeListings.length})` });
  if (String(ai.data_as_of || "").slice(0, 10) !== sot.dataAsOf)
    problems.push({ where: "ai/listings.json", rule: "consistency", hit: String(ai.data_as_of), message: `data_as_of ≠ SSOT (${sot.dataAsOf})` });
} catch (e) { problems.push({ where: "ai/listings.json", rule: "consistency", hit: "", message: e.message }); }
const idx = readFileSync(path.join(root, "index.html"), "utf8");
if (!idx.includes(`Stand der Angebote: ${dataAsOfLabel(sot, "de")}`))
  problems.push({ where: "index.html", rule: "consistency", hit: "", message: "sichtbarer Datenstand ≠ SSOT" });
if (!readFileSync(path.join(root, "projekte.html"), "utf8").includes(`Stand der Angebote: ${dataAsOfLabel(sot, "de")}`))
  problems.push({ where: "projekte.html", rule: "consistency", hit: "", message: "sichtbarer Datenstand ≠ SSOT" });

if (problems.length) {
  for (const p of problems) console.error(`✗ ${p.where} [${p.rule}] „${p.hit}“ ${p.message}`);
  console.error(`\n${problems.length} Verstoß/Verstöße in der Ausgabe (${files.length} Dateien).${REPORT ? " (nur Bericht)" : " Kein Deploy."}`);
  process.exit(REPORT ? 0 : 1);
}
console.log(`✓ Ausgabe regelkonform (${files.length} Dateien, hreflang/Objektzahl/Datenstand konsistent)`);

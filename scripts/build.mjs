#!/usr/bin/env node
/**
 * Ein Build aus der SSOT (data/sot/). Reihenfolge:
 *  1 validate-sot      Quelle: Struktur, Belege, Wording, Zahlen nur über Fakten, Ausnahmen gültig, Slugs eingefroren
 *  2 Export            data/projects.json (Kompatibilität für ältere Leser) aus data/sot/projects.json
 *  3 Render            Objektseiten, Raster, Projektseite, JSON-LD, Sitemap, llms.txt, agents.txt, ai/*.json, mcp.json
 *  4 EN                /en/ (Texte + Fakten aus der SSOT)
 *  5 Flyer             partials/flyer-modal.html (ein Template) + Container in allen Seiten
 *  6 Seiten-Meta       <title>/description aus data/sot/pages.json
 *  7 Cache-Hashes      ?v=<Inhalts-Hash> für css/js/assets/partials
 *  8 check-output      Ausgabe: dieselben Regeln + Konsistenz (hreflang, Objektzahl, Datenstand)
 *  9 build.json        SSOT-Hash, Datenstand, Build-Zeit, Commit
 * Usage: node scripts/build.mjs [--no-render]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSot, projectsDocument, projectTexts } from "./lib/sot.mjs";
import { publishFlyerModal } from "./lib/flyer-modal.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (file, ...args) => execFileSync(process.execPath, [path.join(ROOT, file), ...args], { stdio: "inherit", cwd: ROOT, env: { ...process.env, EICHMANN_SITE_ROOT: ROOT } });
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

run("scripts/validate-sot.mjs");
const sot = loadSot(ROOT, { fresh: true });
writeFileSync(path.join(ROOT, "data/projects.json"), JSON.stringify(projectsDocument(sot), null, 2) + "\n");
if (!process.argv.includes("--no-render")) {
  run("scripts/sync-immowelt.mjs", "--render-only");
  run("scripts/build-en-pages.mjs");
}
const fl = await publishFlyerModal({ siteRoot: ROOT });
console.log(`Flyer: ${fl.partial} (${fl.pages} Seiten mit Container)`);

// Startseite: Hero-Unterzeile = Allmannsdorf-Lead aus der SSOT (Zahlen nur aus Fakten, Claude R3 #4)
{
  const fp = path.join(ROOT, "index.html");
  const s0 = readFileSync(fp, "utf8");
  const lead = projectTexts(sot, "allmannsdorf", "de").lead;
  const s1 = s0.replace(/(<p class="lead" data-sot-lead="allmannsdorf">)[\s\S]*?(<\/p>)/, `$1${esc(lead)}$2`);
  if (s1 !== s0) writeFileSync(fp, s1);
}

// Seiten-Meta aus dem Register
let metaChanged = 0;
for (const p of sot.pages.pages) {
  for (const [lang, file] of Object.entries(p.file || {})) {
    const title = p.title?.[lang], desc = p.description?.[lang];
    if (!title && !desc) continue;
    const fp = path.join(ROOT, file);
    const s = readFileSync(fp, "utf8");
    let out = s;
    if (title) out = out.replace(/<title>[\s\S]*?<\/title>/, `<title>${title}</title>`);
    if (desc) out = out.replace(/(<meta name="description" content=")[^"]*(")/, `$1${desc}$2`);
    if (out !== s) { writeFileSync(fp, out); metaChanged++; }
  }
}
console.log(`Seiten-Meta: ${metaChanged} Datei(en) aus data/sot/pages.json aktualisiert`);

run("scripts/cache-bust.mjs");
run("scripts/check-output.mjs");

let commit = null;
try { commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(); } catch {}
const info = { sot_hash: sot.hash, data_as_of: sot.dataAsOf, active_listings: sot.activeListings.length, built_from_commit: commit, schema: "eichmann.build/v1" };
writeFileSync(path.join(ROOT, "ai/build.json"), JSON.stringify(info, null, 2) + "\n");
console.log(`✓ Build fertig · SSOT ${sot.hash} · Datenstand ${sot.dataAsOf}`);

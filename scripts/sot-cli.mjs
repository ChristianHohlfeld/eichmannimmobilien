#!/usr/bin/env node
/**
 * Pflege der Objekte OHNE Immowelt-Key (Fallback). Jeder Befehl ändert die Quelle, setzt Prüfdatum + Prüfer
 * und läuft danach durch denselben Build (node scripts/build.mjs) und dieselben Regeln.
 *
 *   node scripts/sot-cli.mjs verify --all [--by "Name"]     alle aktiven Objekte von Hand mit den Exposés abgeglichen
 *   node scripts/sot-cli.mjs price <slug> <betrag> [--by …]  Preis geändert (z. B. 349000)
 *   node scripts/sot-cli.mjs sold <slug> [--by …]            verkauft/offline → Seite entfällt beim nächsten Build
 *   node scripts/sot-cli.mjs status                           Datenstand + Prüfdaten je Objekt
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadSot, saveListingsLayer } from "./lib/sot.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const byIdx = rest.indexOf("--by");
const by = byIdx >= 0 ? rest.splice(byIdx, 2)[1] : (process.env.GIT_AUTHOR_NAME || "manuell");
const sot = loadSot(undefined, { fresh: true });
const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" }).format(new Date());
const IMPORT = path.join(sot.root, "data", "listings.json");
const find = (slug) => {
  const l = sot.listings.find((x) => x.slug === slug);
  if (!l) { console.error(`Unbekannter Slug: ${slug}`); process.exit(1); }
  return l;
};
const touch = (l, extra = {}) => ({ ...l, ...extra, verified_at: today, verified_by: by });

if (cmd === "verify" && rest[0] === "--all") {
  saveListingsLayer(sot, sot.listings.map((l) => (l.status === "active" ? touch(l) : l)));
  console.log(`✓ ${sot.activeListings.length} aktive Objekte geprüft am ${today} (${by}). Jetzt: node scripts/build.mjs`);
} else if (cmd === "price" && rest.length === 2) {
  const [slug, raw] = rest;
  const n = Number(String(raw).replace(/[^\d]/g, ""));
  if (!Number.isFinite(n) || n < 1000) { console.error("Betrag ungültig"); process.exit(1); }
  const l = find(slug);
  const doc = JSON.parse(readFileSync(IMPORT, "utf8"));
  const row = doc.listings.find((x) => String(x.immowelt_id || x.id) === l.id);
  if (!row) { console.error("Objekt nicht in data/listings.json"); process.exit(1); }
  row.price = `${new Intl.NumberFormat("de-DE").format(n)} €`;
  writeFileSync(IMPORT, JSON.stringify(doc, null, 2) + "\n");
  saveListingsLayer(sot, sot.listings.map((x) => (x.slug === slug ? touch(x) : x)));
  console.log(`✓ ${slug}: Preis ${row.price} (${by}, ${today}). Jetzt: node scripts/build.mjs`);
} else if (cmd === "sold" && rest.length === 1) {
  find(rest[0]);
  saveListingsLayer(sot, sot.listings.map((x) => (x.slug === rest[0] ? touch(x, { status: "sold" }) : x)));
  console.log(`✓ ${rest[0]}: verkauft/offline (${by}, ${today}). Jetzt: node scripts/build.mjs`);
} else if (cmd === "status") {
  console.log(`Datenstand (ältestes Prüfdatum aktiver Objekte): ${sot.dataAsOf}`);
  for (const l of sot.listings) console.log(`${l.status.padEnd(6)} ${l.verified_at}  ${l.slug}  (${l.verified_by})`);
} else {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(2, 10).join("\n"));
  process.exit(cmd ? 1 : 0);
}

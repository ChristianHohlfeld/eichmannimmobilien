#!/usr/bin/env node
/**
 * Read-only freshness check of the published listings against the public
 * syndication mirror (immobilien.sparkasse.de shows the identical SIP offers;
 * immowelt.de itself blocks datacenter IPs via DataDome).
 *
 * For every public listing with a known mirror URL: HTTP 200 and the same price
 * string must appear. For listings already inactive: the mirror should be gone
 * (404/410). Only if ALL checks pass, data/immowelt-sync-status.json gets
 * last_verified_at = now → the site shows "Stand der Angebote: <that date>".
 * Any mismatch: nothing is changed (fail-closed), exit 2 with a report – a human
 * (Helmut) must then update Immowelt / the admin. Never edits listing data.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadSot, saveListingsLayer } from "./lib/sot.mjs";
import { fileURLToPath } from "node:url";

const ROOT = process.env.EICHMANN_SITE_ROOT
  ? path.resolve(process.env.EICHMANN_SITE_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATUS = path.join(ROOT, "data", "immowelt-sync-status.json");
const DRY = process.argv.includes("--dry-run");

async function mirrorMap() {
  const src = await readFile(path.join(ROOT, "scripts", "sync-immowelt.mjs"), "utf8");
  const m = src.match(/SPARKASSE_EXPOSE_BY_IMMOWELT_ID = Object\.freeze\(\{([\s\S]*?)\}\)/);
  const out = {};
  if (!m) return out;
  for (const mm of m[1].matchAll(/"([0-9a-f-]{36})":\s*"([^"]+)"/g)) out[mm[1]] = mm[2];
  return out;
}

function priceDigits(p) {
  return String(p || "").replace(/[^\d]/g, "");
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36",
      "Accept-Language": "de-DE,de;q=0.9",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(30000),
  });
  return { status: res.status, text: res.status === 200 ? await res.text() : "" };
}

const data = JSON.parse(await readFile(path.join(ROOT, "data", "listings.json"), "utf8"));
const map = await mirrorMap();
const results = [];
for (const L of data.listings || []) {
  const id = String(L.immowelt_id || L.id || "");
  const url = map[id];
  if (!url) continue;
  const isPublic = L.active !== false && L.site_hidden !== true;
  let r;
  try { r = await fetchText(url); } catch (e) { r = { status: 0, text: "", error: String(e.message || e) }; }
  const want = priceDigits(L.price);
  const pageDigits = r.text.replace(/\./g, "");
  const priceOk = !isPublic || (want && pageDigits.includes(want + " €") || pageDigits.includes(want + "&nbsp;€") || pageDigits.includes(want + "\u00a0€"));
  const ok = isPublic ? r.status === 200 && priceOk : r.status === 404 || r.status === 410;
  results.push({ slug: L.slug, public: isPublic, mirror: url, http: r.status, price: L.price, price_ok: isPublic ? priceOk : null, ok, ...(r.error ? { error: r.error } : {}) });
}

const failed = results.filter((x) => !x.ok);
console.log(JSON.stringify({ checked: results.length, failed: failed.length, results }, null, 2));
if (!results.length) { console.error("No mirror URLs – nothing verified."); process.exit(2); }
if (failed.length) {
  console.error(`Mirror check FAILED for ${failed.length} listing(s) – status file unchanged (fail-closed).`);
  process.exit(2);
}
// Datum rückt nur vor, wenn JEDES aktive Objekt der SSOT abgeglichen wurde und übereinstimmt.
const sot = loadSot(ROOT, { fresh: true });
const checkedPublic = new Set(results.filter((x) => x.public && x.ok).map((x) => x.slug));
const missing = sot.activeListings.filter((l) => !checkedPublic.has(l.slug));
if (missing.length) {
  console.error(`Mirror check incomplete: ${missing.length} active listing(s) without match (${missing.map((l) => l.slug).join(", ")}) – data date unchanged (fail-closed).`);
  process.exit(2);
}
if (!DRY) {
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" }).format(new Date());
  saveListingsLayer(sot, sot.listings.map((l) => l.status === "active"
    ? { ...l, verified_at: today, verified_by: "mirror-check (öffentliche Exposés, alle Objekte identisch)" }
    : l));
  console.log(`SSOT: verified_at=${today} für ${sot.activeListings.length} aktive Objekte (data/sot/listings.json)`);
  let st = {};
  try { st = JSON.parse(await readFile(STATUS, "utf8")); } catch {}
  st.last_verified_at = new Date().toISOString();
  st.last_verified_via = "öffentliche Exposés derselben Angebote (immobilien.sparkasse.de, Immowelt-Syndikation): alle aktiven Objekte online, Preise identisch; inaktive offline";
  st.last_verified_count = results.filter((x) => x.public).length;
  await writeFile(STATUS, JSON.stringify(st, null, 2) + "\n", "utf8");
  console.log(`Verified ${st.last_verified_count} public listings → last_verified_at ${st.last_verified_at}`);
}

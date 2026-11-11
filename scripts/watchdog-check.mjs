#!/usr/bin/env node
/**
 * Independent check of the Immowelt sync. No dependencies, no database.
 *
 *   node scripts/watchdog-check.mjs --url https://immobilieneichmann.de
 *       From OUTSIDE (GitHub Actions): reads the public status and checks that the site really
 *       serves the release the status names, with the same number of offers, and that every
 *       offer page answers. Exit 1 with reasons when stale / failed / inconsistent.
 *
 *   node scripts/watchdog-check.mjs --local
 *       ON the server (systemd timer): the sync job cannot report that it did not run – this
 *       does. Exit 1 and notifies the configured alarm sinks when stale or failed.
 */
import { evaluateStatus, readStatus, notifySinks } from "./lib/immowelt/status.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const problems = [];
const notes = [];

async function getJson(url) {
  const res = await fetch(url, { headers: { "Cache-Control": "no-cache", "User-Agent": "eichmann-watchdog/1" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

if (args.includes("--local")) {
  const { loadConfig } = await import("./lib/immowelt/config.mjs").catch(() => ({ loadConfig: null }));
  const stateDir = process.env.EICHMANN_STATE_DIR || "/var/lib/eichmann";
  const statusFile = loadConfig ? loadConfig().statusFile : `${stateDir}/status/immowelt-sync-status.json`;
  const alarmFile = loadConfig ? loadConfig().alarmFile : `${stateDir}/secrets/alarm.json`;
  const status = readStatus(statusFile);
  const verdict = evaluateStatus(status);
  console.log(JSON.stringify({ ok: verdict.ok, level: verdict.level, age_minutes: verdict.age_minutes, state: status?.state || null, problems: verdict.problems }));
  if (!verdict.ok) {
    await notifySinks(alarmFile, { state: "stale_or_failed", ok: false, last_attempt_at: new Date().toISOString(), last_success_at: status?.last_success_at || null, error: { code: "watchdog", message: verdict.problems.join(" ") }, published: status?.published || null }, { state: status?.state || null }, { log: (m) => console.error(m) });
    process.exit(1);
  }
  process.exit(0);
}

const base = String(opt("--url", "https://immobilieneichmann.de")).replace(/\/+$/, "");
let status = null;
let build = null;
let ai = null;
try {
  status = await getJson(`${base}/data/immowelt-sync-status.json`);
} catch (e) {
  problems.push(`Statusdatei nicht abrufbar (${e.message}).`);
}
try {
  build = await getJson(`${base}/ai/build.json`);
  ai = await getJson(`${base}/ai/listings.json`);
} catch (e) {
  problems.push(`Website-Index nicht abrufbar (${e.message}).`);
}

if (status) {
  const verdict = evaluateStatus(status, { staleAfterMinutes: opt("--stale-minutes") ? Number(opt("--stale-minutes")) : null });
  problems.push(...(verdict.level === "alarm" ? verdict.problems : []));
  if (verdict.level === "warn") notes.push(...verdict.problems);
  notes.push(`Zustand ${status.state}, letzter vollständiger Abgleich vor ${verdict.age_minutes ?? "?"} Minuten.`);
  if (build && ai && status.published) {
    if (status.published.release_id && build.release_id !== status.published.release_id) {
      problems.push(`Website liefert Release ${build.release_id || "ohne Kennung"}, der Abgleich meldet ${status.published.release_id}.`);
    }
    if (status.published.fingerprint && build.immowelt_fingerprint && build.immowelt_fingerprint !== status.published.fingerprint) {
      problems.push("Website zeigt einen anderen Immowelt-Stand als der Abgleich zuletzt bestätigt hat.");
    }
    // /ai/listings.json lists the public offers that have their own page → compare like with like
    const expected = status.published.detail_total ?? status.published.public_total;
    if (expected != null && ai.listing_count !== expected) {
      problems.push(`Website zeigt ${ai.listing_count} Angebote, der Abgleich meldet ${expected}.`);
    }
    if (status.published.data_as_of && String(ai.data_as_of || "").slice(0, 10) !== status.published.data_as_of) {
      problems.push(`Datenstand der Website (${String(ai.data_as_of).slice(0, 10)}) ≠ Abgleich (${status.published.data_as_of}).`);
    }
  }
}
if (ai && Array.isArray(ai.listings) && !args.includes("--no-pages")) {
  for (const L of ai.listings) {
    try {
      const res = await fetch(String(L.url).replace(/^https?:\/\/[^/]+/, base), { method: "GET", headers: { "User-Agent": "eichmann-watchdog/1" }, signal: AbortSignal.timeout(20_000) });
      if (res.status !== 200) problems.push(`Objektseite ${L.slug} antwortet mit HTTP ${res.status}.`);
    } catch (e) {
      problems.push(`Objektseite ${L.slug} nicht erreichbar (${e.name}).`);
    }
  }
  notes.push(`${ai.listings.length} Objektseite(n) geprüft.`);
}

for (const n of notes) console.log(`· ${n}`);
if (problems.length) {
  console.error(`\nALARM: Immowelt-Abgleich für ${base} ist nicht in Ordnung:`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const fs = await import("node:fs");
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## ✗ Immowelt-Abgleich nicht in Ordnung\n\n${problems.map((p) => `- ${p}`).join("\n")}\n`);
  }
  process.exit(1);
}
console.log(`✓ Immowelt-Abgleich in Ordnung (${base}).`);

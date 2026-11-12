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
 *       does. It also fetches the public site like a visitor. All fine → sign of life to the
 *       configured healthcheck; stale, failed or site not right → "fail" there at once, exit 1.
 */
import { evaluateStatus, readStatus, notifySinks } from "./lib/immowelt/status.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const problems = [];
const notes = [];

/**
 * What a visitor gets: does the site serve the release the sync reports, with the same number of
 * offers, and does every offer page answer?
 */
async function checkPublic(base, { timeoutMs = 20_000, staleMinutes = null, pages = true } = {}) {
  const problems = [];
  const notes = [];
  const getJson = async (url) => {
    const res = await fetch(url, { headers: { "Cache-Control": "no-cache", "User-Agent": "eichmann-watchdog/1" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };
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
    const verdict = evaluateStatus(status, { staleAfterMinutes: staleMinutes });
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
  if (ai && Array.isArray(ai.listings) && pages) {
    const queue = [...ai.listings];
    const worker = async () => {
      for (let L = queue.shift(); L; L = queue.shift()) {
        try {
          const res = await fetch(String(L.url).replace(/^https?:\/\/[^/]+/, base), { method: "GET", headers: { "User-Agent": "eichmann-watchdog/1" }, signal: AbortSignal.timeout(timeoutMs) });
          if (res.status !== 200) problems.push(`Objektseite ${L.slug} antwortet mit HTTP ${res.status}.`);
        } catch (e) {
          problems.push(`Objektseite ${L.slug} nicht erreichbar (${e.name}).`);
        }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    notes.push(`${ai.listings.length} Objektseite(n) geprüft.`);
  }
  return { problems, notes };
}

if (args.includes("--local")) {
  const { loadConfig } = await import("./lib/immowelt/config.mjs").catch(() => ({ loadConfig: null }));
  const stateDir = process.env.EICHMANN_STATE_DIR || "/var/lib/eichmann";
  const config = loadConfig ? loadConfig() : null;
  const statusFile = config ? config.statusFile : `${stateDir}/status/immowelt-sync-status.json`;
  const alarmFile = config ? config.alarmFile : `${stateDir}/secrets/alarm.json`;
  const status = readStatus(statusFile);
  const verdict = evaluateStatus(status);
  const found = verdict.ok ? [] : [...verdict.problems];
  // The sync is fine – is the website, as visitors reach it? (skipped with --no-public)
  let checked = null;
  if (verdict.ok && config?.publicOrigin && !args.includes("--no-public")) {
    const pub = await checkPublic(config.publicOrigin, { timeoutMs: 8_000 });
    found.push(...pub.problems);
    checked = pub.notes.at(-1) || null;
  }
  const ok = found.length === 0;
  const now = new Date().toISOString();
  // Sign of life: the configured healthcheck hears "ok" only from here, after everything was checked,
  // and "fail" at once when something is wrong. No answer from here at all is what the service alerts on.
  const sent = await notifySinks(
    alarmFile,
    ok
      ? { state: status.state, ok: true, last_attempt_at: now, last_success_at: status.last_success_at, error: null, published: status.published || null }
      : { state: "stale_or_failed", ok: false, last_attempt_at: now, last_success_at: status?.last_success_at || null, error: { code: "watchdog", message: found.join(" ") }, published: status?.published || null },
    { state: status?.state || null },
    { log: (m) => console.error(m) },
  );
  console.log(JSON.stringify({ ok, level: ok ? verdict.level : "alarm", age_minutes: verdict.age_minutes, state: status?.state || null, public: checked, problems: ok ? verdict.problems : found, sign_of_life: sent.sent.map((x) => `${x.sink}:${x.ok ? "ok" : "nicht zugestellt"}`) }));
  process.exit(ok ? 0 : 1);
}

const base = String(opt("--url", "https://immobilieneichmann.de")).replace(/\/+$/, "");
const { problems: publicProblems, notes: publicNotes } = await checkPublic(base, { staleMinutes: opt("--stale-minutes") ? Number(opt("--stale-minutes")) : null, pages: !args.includes("--no-pages") });
problems.push(...publicProblems);
notes.push(...publicNotes);

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

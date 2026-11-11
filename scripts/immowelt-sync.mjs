#!/usr/bin/env node
/**
 * Immowelt → website: the one command the server runs.
 *
 *   node scripts/immowelt-sync.mjs run [--trigger timer|admin|deploy|manual] [--wait <s>] [--dry-run [--no-media]]
 *       Read the complete inventory from the official API, validate, publish atomically.
 *       Exit 0 = site shows the current Immowelt state (or nothing changed / confirmation pending / busy)
 *       Exit 1 = failed; last complete state stays online, status file + alarm say why
 *       Exit 3 = one-time identity migration must be approved first
 *
 *   node scripts/immowelt-sync.mjs status                 status + verdict (exit 1 when stale or failed)
 *   node scripts/immowelt-sync.mjs probe                  read-only API contract check, prints structure only
 *   node scripts/immowelt-sync.mjs identity-plan          which old rows map to which offers (evidence table)
 *   node scripts/immowelt-sync.mjs identity-apply --plan-hash <hash>
 *   node scripts/immowelt-sync.mjs hold --reason "…"            pause: nothing is published automatically (sync and admin saves wait)
 *   node scripts/immowelt-sync.mjs resume                       lift the hold; the next run publishes the current state
 *   node scripts/immowelt-sync.mjs rollback [--backup <file>]   Immowelt rows back to a pre-publish backup, rebuild, hold
 *       (site only, without touching data: node scripts/release.mjs rollback)
 *   node scripts/immowelt-sync.mjs history [--limit 20]
 *
 * The API key is read from /var/lib/eichmann/secrets/immowelt-api.json (path overridable via
 * IMMOWELT_SECRETS_FILE). IMMOWELT_API_KEY (the value) is honoured for CI probes.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./lib/db.mjs";
import { readImmoweltCredentials } from "./lib/immowelt-secrets.mjs";
import { loadConfig } from "./lib/immowelt/config.mjs";
import { runSync, fetchSnapshot, publishFromDatabase, planHash, setHold, clearHold } from "./lib/immowelt/pipeline.mjs";
import { validateSnapshot } from "./lib/immowelt/validate.mjs";
import { snapshotFingerprint } from "./lib/immowelt/normalize.mjs";
import { readStatus, evaluateStatus } from "./lib/immowelt/status.mjs";
import { getState, restoreImmoweltRows, pendingLegacyRows } from "./lib/immowelt/store.mjs";
import { acquireLock, LockBusyError } from "./lib/immowelt/lock.mjs";
import { copyProcessor } from "./lib/immowelt/media.mjs";

function parseArgs(argv) {
  const [cmd = "run", ...rest] = argv;
  const opt = (name, fallback = null) => {
    const i = rest.indexOf(name);
    return i >= 0 && rest[i + 1] !== undefined ? rest[i + 1] : fallback;
  };
  return { cmd, rest, opt, has: (name) => rest.includes(name) };
}

/** Test seam: a fixture module may replace network + image processing. Refused outside NODE_ENV=test. */
async function testDeps() {
  const mod = process.env.EICHMANN_TEST_DEPS;
  if (!mod) return {};
  if (process.env.NODE_ENV !== "test") throw new Error("EICHMANN_TEST_DEPS ist nur mit NODE_ENV=test erlaubt.");
  const m = await import(mod);
  return { ...(await m.default()), imageProcessor: copyProcessor() };
}

/** The timer treats "busy"/"held" as nothing to do; a person who started a command must see that nothing happened. */
const operatorExit = (res, trigger) => (trigger === "timer" ? res.exitCode : res.outcome === "busy" ? 75 : res.outcome === "held" ? 1 : res.exitCode);

function printPlan(plan) {
  const ev = (d) => (d.evidence || []).map((e) => e.type).join("+") || "kein Beleg";
  console.log(`\nIdentitätsplan ${plan.plan_hash} (Bestand ${String(plan.snapshot_fingerprint || "").slice(0, 12)})`);
  console.log("Alt-Datensatz (Slug)                               öffentlich  Entscheidung  Beleg                      → Online-ID");
  for (const d of plan.legacy) {
    console.log(`${String(d.slug || d.legacy_id).padEnd(50)} ${String(d.was_public ? "ja" : "nein").padEnd(11)} ${String(d.decision).padEnd(13)} ${ev(d).padEnd(26)} ${d.target?.online_id || "–"}`);
  }
  console.log(`Neu aus der API (kein Alt-Datensatz): ${plan.created.map((c) => c.target.online_id).join(", ") || "–"}`);
  const retire = plan.legacy.filter((d) => d.decision === "retire" && d.was_public);
  if (retire.length) console.log(`\nACHTUNG: ${retire.length} heute öffentliche(s) Angebot(e) gehen mit der Freigabe offline, weil sie nicht im vollständigen API-Bestand sind:\n${retire.map((d) => `  · ${d.slug}  (${d.legacy_title || "ohne Titel"}, ${d.legacy_price || "ohne Preis"})`).join("\n")}`);
  const hints = plan.legacy.filter((d) => d.evidence.some((e) => e.type === "media_asset_overlap_ambiguous"));
  if (hints.length) {
    console.log(`\n${hints.length} Alt-Angebot(e) teilen Bilder mit mehreren API-Angeboten (z. B. Einheiten desselben Projekts) – das belegt keine Zuordnung.\nOhne Eintrag in data/sot/immowelt-identity-map.json verlieren sie ihre bisherige Adresse; das Angebot selbst erscheint unter einer neuen:\n${hints.map((d) => `  · ${d.slug}  (${d.legacy_title || "ohne Titel"}) – Kandidaten: ${d.evidence.find((e) => e.candidates)?.candidates.join(", ")}`).join("\n")}`);
  }
  if (plan.ambiguous) {
    console.log(`\n${plan.ambiguous} WIDERSPRUCH/WIDERSPRÜCHE in den Belegen – Freigabe erst möglich, wenn data/sot/immowelt-identity-map.json korrigiert ist:\n${plan.legacy.filter((d) => d.decision === "ambiguous").map((d) => `  · ${d.slug}: ${d.evidence.map((e) => `${e.type} → ${e.api_online_id}${e.also_claimed_by?.length ? ` (auch beansprucht von ${e.also_claimed_by.join(", ")})` : ""}`).join("; ")}`).join("\n")}`);
  }
  console.log(`\nFreigabe: node scripts/immowelt-sync.mjs identity-apply --plan-hash ${plan.plan_hash}`);
}

export async function main(argv = process.argv.slice(2)) {
  const { cmd, rest, opt, has } = parseArgs(argv);
  const config = loadConfig();
  const deps = await testDeps();

  if (cmd === "run") {
    const trigger = opt("--trigger", process.env.EICHMANN_SYNC_TRIGGER || "manual");
    const res = await runSync({ trigger, dryRun: has("--dry-run"), skipMedia: has("--no-media"), waitMs: Number(opt("--wait", "0")) * 1000, deps });
    if (res.outcome === "migration_required" && res.plan) printPlan(res.plan);
    if (res.outcome === "dry_run") {
      console.log(JSON.stringify({ outcome: "dry_run", fingerprint: res.fingerprint, count: res.snapshot.listings.length, change: res.change, warnings: res.warnings }, null, 2));
    }
    console.log(`Ergebnis: ${res.outcome}${res.status?.published ? ` · veröffentlicht: ${res.status.published.count} Immowelt-Angebote, Datenstand ${res.status.published.data_as_of || "–"}` : ""}`);
    return operatorExit(res, trigger);
  }

  if (cmd === "identity-plan") {
    // Planning must never publish: without open scraper-era rows there is nothing to plan and no run is started.
    const pdb = openDb(config.dbPath);
    const open = pendingLegacyRows(pdb).length;
    pdb.close();
    if (!open) {
      console.log("Keine Alt-Datensätze offen – keine Identitätsmigration nötig.");
      return 0;
    }
    const res = await runSync({ trigger: "identity-plan", deps });
    if (res.plan) {
      printPlan(res.plan);
      return 0;
    }
    console.log(res.outcome === "failed" ? `Plan nicht erstellbar: ${res.error?.message}` : `Kein Plan erstellt (Ergebnis: ${res.outcome}).`);
    return 1;
  }

  if (cmd === "identity-apply") {
    const want = opt("--plan-hash");
    let plan = null;
    try {
      plan = JSON.parse(fs.readFileSync(config.identityPlanFile, "utf8"));
    } catch {
      console.error("Kein Identitätsplan vorhanden. Erst: node scripts/immowelt-sync.mjs identity-plan");
      return 2;
    }
    if (!want || want !== plan.plan_hash || planHash(plan) !== plan.plan_hash) {
      console.error(`Plan-Hash stimmt nicht (erwartet ${plan.plan_hash}). Plan erneut ansehen und mit genau diesem Hash freigeben.`);
      return 2;
    }
    const res = await runSync({ trigger: "identity-apply", identityPlan: plan, deps });
    console.log(`Ergebnis: ${res.outcome}`);
    if (res.summary?.identity) console.log(JSON.stringify(res.summary.identity, null, 2));
    return operatorExit(res, "identity-apply");
  }

  if (cmd === "status") {
    const status = readStatus(config.statusFile);
    const verdict = evaluateStatus(status);
    console.log(JSON.stringify({ verdict, status }, null, 2));
    return verdict.ok ? 0 : 1;
  }

  if (cmd === "probe") {
    // Read-only: no database, no status file, no pictures. Prints structure and public ids only.
    const apiKey = (process.env.IMMOWELT_API_KEY || "").trim() || readImmoweltCredentials()?.api_key || "";
    if (!apiKey) {
      console.error("Kein API-Schlüssel (weder Secrets-Datei noch IMMOWELT_API_KEY).");
      return 1;
    }
    try {
      const { snapshot } = await fetchSnapshot(apiKey, config, { fetchImpl: deps.fetchImpl, sleepImpl: deps.sleepImpl, log: (m) => console.log(m) });
      const verdict = validateSnapshot(snapshot, { allowedImageHosts: config.allowedImageHosts });
      console.log(JSON.stringify({
        ok: verdict.ok,
        geo_ids: snapshot.geo_ids,
        reported_total_counts: snapshot.reported_total_counts,
        count: snapshot.listings.length,
        core_fingerprint: snapshotFingerprint(snapshot.listings).slice(0, 16),
        errors: verdict.errors,
        warnings: verdict.warnings,
        listings: snapshot.listings.map((L) => ({
          position: L.position, online_id: L.immowelt_online_id, estate_id: L.immowelt_estate_id, guid: L.immowelt_guid,
          marketing: L.marketing, price_on_request: L.price_on_request, has_price: L.price_eur != null,
          rooms: L.rooms_value, living_area: L.living_area_value, zip: L.zip,
          pictures: L.media.length, photos: L.images.length, floorplans: L.floor_plans.length,
          sections: L.sections.map((s) => `${s.id || "?"}:${s.title} (${s.text.length} Zeichen)`),
          fact_ids: L.fact_rows.map((r) => r.id || r.label),
          extensions: L.extensions, unmapped: L.api_notes.unmapped_elements,
        })),
      }, null, 2));
      return verdict.ok ? 0 : 1;
    } catch (err) {
      console.error(`Probe fehlgeschlagen [${err.code || err.name}] ${err.message}`);
      return 1;
    }
  }

  if (cmd === "hold" || cmd === "resume") {
    const db = openDb(config.dbPath);
    try {
      if (cmd === "hold") {
        const { hold } = setHold(db, config, { reason: opt("--reason", "ohne Angabe") });
        console.log(`Angehalten (${hold.reason}). Bis „resume“ wird nichts automatisch veröffentlicht: kein Immowelt-Abgleich; Änderungen aus dem Admin-Bereich werden gespeichert und warten.`);
      } else {
        const was = getState(db).hold;
        clearHold(db);
        console.log(was ? `Fortgesetzt (angehalten war seit ${was.at}: ${was.reason}). Der nächste Lauf veröffentlicht wieder: node scripts/immowelt-sync.mjs run` : "Es war nichts angehalten.");
      }
    } finally {
      db.close();
    }
    return 0;
  }

  if (cmd === "rollback") {
    let lock;
    try {
      lock = await acquireLock(config.lockDir, { purpose: "immowelt rollback", waitMs: 300_000, staleMinutes: config.lockStaleMinutes });
    } catch (err) {
      if (err instanceof LockBusyError) {
        console.error(err.message);
        return 75;
      }
      throw err;
    }
    const db = openDb(config.dbPath);
    try {
      let backup = opt("--backup");
      if (!backup) {
        const names = fs.existsSync(config.backupsDir) ? fs.readdirSync(config.backupsDir).filter((n) => n.endsWith(".db")).sort() : [];
        if (!names.length) {
          console.error("Keine Datenbank-Sicherung vorhanden.");
          return 1;
        }
        backup = path.join(config.backupsDir, names[names.length - 1]);
      }
      const at = new Date().toISOString();
      const res = restoreImmoweltRows(db, path.resolve(backup), { now: at });
      // Hold first: if the rebuild below fails, the next timer run must not re-apply the state that was just rolled back.
      setHold(db, config, { reason: `Daten-Rollback auf ${path.basename(backup)}`, now: new Date(at) });
      const rel = await publishFromDatabase(config, { db, reason: "rollback", lockToken: lock.token, log: (m) => console.log(m) });
      setHold(db, config, { reason: `Daten-Rollback auf ${path.basename(backup)}`, now: new Date(at), published: { release_id: rel.id, fingerprint: getState(db).fingerprint, count: res.active_after, public_total: rel.manifest?.summary?.public ?? null, detail_total: rel.manifest?.summary?.detail ?? null, data_as_of: getState(db).checkedDate } });
      console.log(JSON.stringify({ ok: true, backup: path.basename(backup), ...res, release_id: rel.id, held: true }));
      console.log("Der Abgleich ist angehalten. Nach der Ursachenklärung: node scripts/immowelt-sync.mjs resume && node scripts/immowelt-sync.mjs run");
      return 0;
    } catch (err) {
      console.error(`Rollback fehlgeschlagen [${err.code || err.name}] ${err.message}`);
      return 1;
    } finally {
      db.close();
      lock.release();
    }
  }

  if (cmd === "history") {
    const db = openDb(config.dbPath);
    try {
      const rows = db.prepare("SELECT run_id, started_at, trigger, outcome, total_count, error_code, release_id FROM immowelt_runs ORDER BY started_at DESC LIMIT ?").all(Number(opt("--limit", "20")));
      for (const r of rows) console.log(`${r.started_at}  ${String(r.trigger || "").padEnd(14)} ${String(r.outcome).padEnd(22)} ${String(r.total_count ?? "–").padStart(3)}  ${r.error_code || ""} ${r.release_id || ""}`);
      const legacy = pendingLegacyRows(db).length;
      if (legacy) console.log(`Offene Alt-Datensätze (Identitätsmigration): ${legacy}`);
    } finally {
      db.close();
    }
    return 0;
  }

  console.error("Befehle: run | status | probe | identity-plan | identity-apply | hold | resume | rollback | history");
  return 2;
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  main().then(
    (code) => process.exit(code ?? 0),
    (err) => {
      console.error(err);
      process.exit(1);
    }
  );
}

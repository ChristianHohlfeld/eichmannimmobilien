#!/usr/bin/env node
/**
 * Releases of the public site (see scripts/lib/release.mjs).
 *
 *   node scripts/release.mjs build [--reason deploy] [--wait 300]   build from the live database, verify, switch
 *        (--bootstrap: allowed before the webroot symlink exists; used once by install-release-layout.sh)
 *   node scripts/release.mjs list                                   releases on disk (current / previous marked)
 *   node scripts/release.mjs rollback [<release-id>]                switch back to the previous (or named) release AND hold
 *        (site only – data rollback: immowelt-sync.mjs rollback; continue with: immowelt-sync.mjs resume)
 *   node scripts/release.mjs gc                                     remove old releases and unused picture renditions
 */
import { openDb } from "./lib/db.mjs";
import { loadConfig } from "./lib/immowelt/config.mjs";
import { acquireLock, LockBusyError } from "./lib/immowelt/lock.mjs";
import { publishFromDatabase, rollbackSite } from "./lib/immowelt/pipeline.mjs";
import { getState } from "./lib/immowelt/store.mjs";
import { listReleases, gcReleases, isLayoutActive, currentReleaseId } from "./lib/release.mjs";
import { gcMedia } from "./lib/immowelt/media.mjs";

const [cmd = "list", ...rest] = process.argv.slice(2);
const VALUE_OPTIONS = new Set(["--reason", "--wait"]);
const opt = (name, fallback = null) => {
  const i = rest.indexOf(name);
  return i >= 0 && rest[i + 1] !== undefined ? rest[i + 1] : fallback;
};
/** Arguments that are neither an option nor the value of one. */
const positional = rest.filter((a, i) => !a.startsWith("--") && !VALUE_OPTIONS.has(rest[i - 1]));
const config = loadConfig();

async function locked(purpose, fn) {
  let lock;
  try {
    lock = await acquireLock(config.lockDir, { purpose, waitMs: Number(opt("--wait", "300")) * 1000, staleMinutes: config.lockStaleMinutes });
  } catch (err) {
    if (err instanceof LockBusyError) {
      console.error(err.message);
      process.exit(75);
    }
    throw err;
  }
  try {
    return await fn(lock);
  } finally {
    lock.release();
  }
}

try {
  if (cmd === "build") {
    // --bootstrap: first release while the webroot is still a plain directory (install-release-layout.sh
    // switches the webroot afterwards). Without it a build is refused until the layout is active.
    if (!isLayoutActive(config) && !rest.includes("--bootstrap")) {
      console.error("Release-Layout ist nicht aktiv (Webroot ist kein Symlink in das Release-Verzeichnis). Erst deploy/install-release-layout.sh ausführen.");
      process.exit(2);
    }
    const reason = opt("--reason", "manual");
    let hold = null;
    const rel = await locked(`release build (${reason})`, async (lock) => {
      const db = openDb(config.dbPath);
      try {
        hold = getState(db).hold;
        return await publishFromDatabase(config, { db, reason, lockToken: lock.token, log: (m) => console.log(m) });
      } finally {
        db.close();
      }
    });
    console.log(JSON.stringify({ ok: true, release_id: rel.id, summary: rel.manifest.summary, data: rel.manifest.data }));
    // A build is a deliberate act and publishes also while the sync is on hold – say so, the hold stays.
    if (hold) console.log(`Hinweis: Der Immowelt-Abgleich ist weiterhin angehalten (${hold.reason}). Freigeben: node scripts/immowelt-sync.mjs resume`);
  } else if (cmd === "list") {
    const rows = listReleases(config);
    if (!rows.length) console.log("Keine Releases vorhanden.");
    for (const r of rows) {
      const m = r.manifest || {};
      console.log(`${r.current ? "→" : r.previous ? "←" : " "} ${r.id}  ${String(m.reason || "?").padEnd(10)} ${m.summary ? `${m.summary.public} öffentlich (${m.summary.immowelt} Immowelt, ${m.summary.eigen} eigen)` : ""}  Datenstand ${m.data?.immowelt_checked_date || "–"}  Commit ${m.commit || "–"}`);
    }
    console.log(`Layout aktiv: ${isLayoutActive(config) ? "ja" : "nein"} · aktuell: ${currentReleaseId(config) || "–"}`);
  } else if (cmd === "rollback") {
    const target = positional[0] || null;
    const res = await locked("release rollback", async () => {
      const db = openDb(config.dbPath);
      try {
        return await rollbackSite(config, { db, targetId: target });
      } finally {
        db.close();
      }
    });
    console.log(JSON.stringify({ ok: true, release_id: res.id, replaced: res.previous, held: true }));
    console.log("Die Website zeigt wieder dieses Release; der Abgleich ist angehalten (Status „held“, die Wächter melden das).");
    console.log("Weiter nach der Ursachenklärung: Korrektur deployen (baut ein neues Release) bzw. direkt freigeben mit");
    console.log("  node scripts/immowelt-sync.mjs resume && node scripts/immowelt-sync.mjs run");
  } else if (cmd === "gc") {
    const res = await locked("release gc", async () => {
      const gc = await gcReleases(config);
      const media = await gcMedia(config, gc.media);
      return { kept: gc.kept, removed: gc.removed, media_removed: media.removed };
    });
    console.log(JSON.stringify(res));
  } else {
    console.error("Befehle: build | list | rollback [id] | gc");
    process.exit(2);
  }
} catch (err) {
  console.error(`FEHLER [${err.code || err.name}] ${err.message}`);
  if (err.problems) for (const p of err.problems.slice(0, 40)) console.error(`  · ${p}`);
  if (err.buildLog) console.error(err.buildLog);
  process.exit(1);
}

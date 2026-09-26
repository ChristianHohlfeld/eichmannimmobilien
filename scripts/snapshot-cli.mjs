#!/usr/bin/env node
/**
 * CLI for app snapshots (cron + manual ops).
 *   node scripts/snapshot-cli.mjs create [--prune]
 *   node scripts/snapshot-cli.mjs list
 *   node scripts/snapshot-cli.mjs prune
 *   node scripts/snapshot-cli.mjs restore <id> --confirm=RESTAURIEREN [--no-restart]
 */
import {
  createSnapshot,
  listSnapshots,
  pruneSnapshots,
  restoreSnapshot,
  formatBytes,
  RETENTION,
  RESTORE_PHRASE,
} from "./lib/snapshots.mjs";

const args = process.argv.slice(2);
const cmd = args[0] || "list";

function flag(name) {
  const exact = args.find((a) => a === `--${name}`);
  if (exact) return true;
  const pref = args.find((a) => a.startsWith(`--${name}=`));
  return pref ? pref.slice(name.length + 3) : null;
}

try {
  if (cmd === "create") {
    const snap = await createSnapshot({ reason: "cron" });
    if (flag("prune") !== null || true) {
      // createSnapshot already prunes; report list size
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          id: snap.id,
          created_at: snap.created_at,
          total_bytes: snap.total_bytes,
          total_human: formatBytes(snap.total_bytes),
          deploy_commit: snap.deploy_commit,
          retention: RETENTION,
        },
        null,
        2
      )
    );
  } else if (cmd === "list") {
    const rows = listSnapshots();
    console.log(
      JSON.stringify(
        {
          ok: true,
          count: rows.length,
          snapshots: rows.map((s) => ({
            id: s.id,
            created_at: s.created_at,
            deploy_commit: s.deploy_commit,
            total_bytes: s.total_bytes,
            total_human: formatBytes(s.total_bytes),
            parts: s.parts,
          })),
        },
        null,
        2
      )
    );
  } else if (cmd === "prune") {
    const result = pruneSnapshots(RETENTION);
    console.log(JSON.stringify({ ok: true, retention: RETENTION, ...result }, null, 2));
  } else if (cmd === "restore") {
    const id = args[1];
    if (!id) {
      console.error("Usage: snapshot-cli.mjs restore <id> --confirm=RESTAURIEREN");
      process.exit(2);
    }
    const phrase = flag("confirm") || "";
    const noRestart = flag("no-restart") !== null;
    const result = await restoreSnapshot(id, {
      confirmPhrase: phrase === true ? RESTORE_PHRASE : phrase,
      scheduleRestart: !noRestart,
    });
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.error(`Unknown command: ${cmd}`);
    process.exit(2);
  }
} catch (e) {
  console.error(JSON.stringify({ ok: false, error: e.message || String(e) }));
  process.exit(1);
}

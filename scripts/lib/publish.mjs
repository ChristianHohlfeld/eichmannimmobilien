/**
 * Shared publish entry for admin API, snapshot restore and scripts/publish-from-db.mjs.
 *
 * On the server (release layout active) NOTHING renders into the served tree any more: a publish
 * builds a complete release from the live database, verifies it and switches atomically – under
 * the same lock as the Immowelt sync, so there is exactly one writer of the public site.
 * Without the release layout (local development, CI) the old in-place render is used.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { REPO_ROOT, openDb } from "./db.mjs";

/**
 * Build + verify + switch a release from the live database. Waits for a running sync.
 *
 * reason "admin" (a save in the admin UI) is the only ROUTINE publish. It is refused while publishing
 * is on hold: the change is already stored in the database and goes out with the next release once
 * publishing is resumed. Deliberate publishes (deploy, restore, manual) are never refused.
 */
export async function publishViaRelease(config, { reason = "admin", waitMs = 180_000, log = (m) => console.log(m) } = {}) {
  const { acquireLock } = await import("./immowelt/lock.mjs");
  const { publishFromDatabase } = await import("./immowelt/pipeline.mjs");
  const { getState } = await import("./immowelt/store.mjs");
  const lock = await acquireLock(config.lockDir, { purpose: `publish (${reason})`, waitMs, staleMinutes: config.lockStaleMinutes });
  try {
    const db = openDb(config.dbPath);
    try {
      const hold = getState(db).hold;
      if (reason === "admin" && hold) {
        const err = new Error(`Gespeichert, aber noch nicht veröffentlicht: Die Veröffentlichung ist angehalten (${hold.reason}). Die Änderung erscheint, sobald wieder freigegeben ist.`);
        err.status = 423;
        err.code = "held";
        throw err;
      }
      const rel = await publishFromDatabase(config, { db, reason, lockToken: lock.token, log });
      return { release_id: rel.id, summary: rel.manifest.summary };
    } finally {
      db.close();
    }
  } finally {
    lock.release();
  }
}

/**
 * @param {object} doc exportListingsDocument() result (used by the in-place path only; a release
 *                     is always built from the database itself)
 * @param {{ siteRoot?: string, knownSlugs?: string[], reason?: string }} [opts]
 */
export async function publishSiteFromDocument(doc, opts = {}) {
  const { loadConfig } = await import("./immowelt/config.mjs");
  const { isLayoutActive } = await import("./release.mjs");
  const config = loadConfig();
  if (isLayoutActive(config)) return publishViaRelease(config, { reason: opts.reason || "admin" });

  const siteRoot = opts.siteRoot || process.env.EICHMANN_SITE_ROOT || REPO_ROOT;
  process.env.EICHMANN_SITE_ROOT = siteRoot;

  const sync = await import("../sync-immowelt.mjs");
  if (typeof sync.publishListingsDocument !== "function") {
    throw new Error("sync-immowelt.mjs must export publishListingsDocument");
  }
  return sync.publishListingsDocument(doc, {
    siteRoot,
    knownSlugs: opts.knownSlugs,
  });
}

export async function writeListingsJsonExport(doc, siteRoot = REPO_ROOT) {
  const outPath = path.join(siteRoot, "data", "listings.json");
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const payload = {
    ...doc,
    sot: "sqlite",
    exported_at: new Date().toISOString(),
  };
  await fs.writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return outPath;
}

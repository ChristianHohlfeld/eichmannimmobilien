/**
 * Applying an Immowelt snapshot to SQLite – the only code that writes origin=immowelt rows.
 *
 * Hard one-way takeover:
 *   - every offer in the snapshot replaces its row completely (payload = snapshot, nothing merged)
 *   - active=1, site_hidden=0, detail_page=1 are forced: visibility is decided on Immowelt
 *   - every Immowelt row that is not in the (complete) snapshot is retired, not deleted
 *   - the only things a row keeps are its primary key, its slug (frozen URL) and created_at
 *   - origin=eigen is never read into, written or retired here
 * Everything happens in ONE transaction; every change is appended to listing_history.
 */
import fs from "node:fs";
import path from "node:path";
import { ORIGIN_IMMOWELT, ORIGIN_EIGEN, rowToListing, setMeta, getMeta } from "../db.mjs";
import { ImmoweltError } from "./soap.mjs";
import { dashedGuid, normalizeGuid } from "./identity.mjs";
import { stableJson } from "./normalize.mjs";

function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-")
    .slice(0, 48);
}

export function proposeSlug(L) {
  const type = slugify(L.type || "objekt") || "objekt";
  const place = slugify(L.district || L.city || "konstanz") || "konstanz";
  return `${type}-${place}-${L.immowelt_online_id}`;
}

function uniqueSlug(db, wanted, ownId) {
  let slug = wanted;
  for (let n = 2; n < 100; n++) {
    const owner = db.prepare("SELECT id FROM listings WHERE slug = ?").get(slug);
    if (!owner || owner.id === ownId) return slug;
    slug = `${wanted}-${n}`;
  }
  throw new ImmoweltError("slug_conflict", `Kein freier Slug für ${wanted}.`);
}

const json = (v) => (v == null ? null : JSON.stringify(v));

/**
 * One-time: give every published Immowelt offer the address derived from Immowelt itself
 * (<objektart>-<ort>-<online-id>). The previous address is remembered and keeps redirecting.
 */
export function reslugToCanonical(db, { now = new Date().toISOString() } = {}) {
  const tx = db.transaction(() => {
    const changed = [];
    for (const row of db.prepare("SELECT * FROM listings WHERE origin = ? AND immowelt_guid IS NOT NULL AND active = 1").all(ORIGIN_IMMOWELT)) {
      const L = rowToListing(row);
      if (!L.immowelt_online_id || String(row.slug).endsWith(`-${L.immowelt_online_id}`)) continue;
      const slug = uniqueSlug(db, proposeSlug(L), row.id);
      db.prepare("INSERT OR REPLACE INTO listing_aliases (alias, listing_id, kind, created_at) VALUES (?, ?, 'previous_slug', ?)").run(row.slug, row.id, now);
      const previous = db.prepare("SELECT alias FROM listing_aliases WHERE listing_id = ? AND kind = 'previous_slug'").all(row.id).map((r) => r.alias);
      const payload = { ...JSON.parse(row.payload), slug, local_url: `objekt/${slug}.html`, previous_slugs: previous };
      db.prepare("UPDATE listings SET slug = ?, payload = ?, updated_at = ? WHERE id = ?").run(slug, JSON.stringify(payload), now, row.id);
      history(db, { at: now, runId: null, id: row.id, change: "reslug", before: { slug: row.slug }, after: { slug } });
      changed.push({ online_id: L.immowelt_online_id, from: row.slug, to: slug });
    }
    return changed;
  });
  return tx.immediate ? tx.immediate() : tx();
}

export function getState(db) {
  const parse = (key) => {
    const raw = getMeta(db, key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };
  return {
    hold: parse("immowelt_hold"),
    identityMigration: parse("immowelt_identity_migration"),
    pendingConfirmation: parse("immowelt_pending_confirmation"),
    fingerprint: getMeta(db, "immowelt_fingerprint") || null,
    checkedDate: getMeta(db, "immowelt_checked_date") || null,
    releasePending: getMeta(db, "release_pending") || null,
    releaseLive: getMeta(db, "release_live") || null,
  };
}

export function setJsonMeta(db, key, value) {
  setMeta(db, key, value == null ? "" : JSON.stringify(value));
}

/** Scraper-era Immowelt rows that have not been through the identity migration yet. */
export function pendingLegacyRows(db) {
  return db
    .prepare("SELECT * FROM listings WHERE origin = ? AND immowelt_guid IS NULL AND retired_at IS NULL ORDER BY title COLLATE NOCASE")
    .all(ORIGIN_IMMOWELT)
    .map(rowToListing);
}

/** Currently published API offers, in API order (basis for change detection). */
export function publishedApiListings(db) {
  return db
    .prepare("SELECT * FROM listings WHERE origin = ? AND immowelt_guid IS NOT NULL AND active = 1 ORDER BY position ASC")
    .all(ORIGIN_IMMOWELT)
    .map(rowToListing);
}

function history(db, { at, runId, id, change, before = null, after = null }) {
  db.prepare("INSERT INTO listing_history (at, run_id, listing_id, change, before, after) VALUES (?, ?, ?, ?, ?, ?)").run(at, runId || null, id, change, json(before), json(after));
}

function findRow(db, L) {
  const id = dashedGuid(L.immowelt_guid);
  const hits = new Map();
  const add = (row, via) => row && hits.set(row.id, { row, via: [...(hits.get(row.id)?.via || []), via] });
  add(db.prepare("SELECT * FROM listings WHERE id = ?").get(id), "id");
  for (const row of db.prepare("SELECT * FROM listings WHERE immowelt_guid = ?").all(L.immowelt_guid)) add(row, "guid");
  for (const row of db.prepare("SELECT * FROM listings WHERE immowelt_estate_id = ?").all(L.immowelt_estate_id)) add(row, "estate_id");
  for (const row of db.prepare("SELECT * FROM listings WHERE immowelt_online_id = ?").all(L.immowelt_online_id)) add(row, "online_id");
  if (hits.size > 1) {
    throw new ImmoweltError("identity_conflict", `Angebot ${L.immowelt_online_id}: Kennungen zeigen auf ${hits.size} verschiedene Datensätze (${[...hits.values()].map((h) => `${h.row.slug} über ${h.via.join("+")}`).join("; ")}).`);
  }
  const hit = [...hits.values()][0] || null;
  if (hit && hit.row.origin !== ORIGIN_IMMOWELT) {
    throw new ImmoweltError("identity_conflict", `Angebot ${L.immowelt_online_id}: Kennung gehört zu einem eigenen Inserat (${hit.row.slug}).`);
  }
  return hit;
}

function applyIdentityPlan(db, plan, snapshot, { at, runId }) {
  const pending = new Map(pendingLegacyRows(db).map((r) => [String(r.id).toLowerCase(), r]));
  const decisions = new Map((plan.legacy || []).map((d) => [String(d.legacy_id).toLowerCase(), d]));
  const missing = [...pending.keys()].filter((id) => !decisions.has(id));
  if (missing.length) throw new ImmoweltError("identity_plan_incomplete", `Identitätsplan deckt ${missing.length} Alt-Datensatz/-sätze nicht ab.`);
  if ((plan.legacy || []).some((d) => d.decision === "ambiguous")) throw new ImmoweltError("identity_plan_ambiguous", "Identitätsplan enthält mehrdeutige Zuordnungen – bitte per Beleg auflösen.");
  const inSnapshot = new Set(snapshot.listings.map((L) => L.immowelt_guid));
  const out = { rekeyed: [], retired: [], kept: [] };
  for (const [legacyId, d] of decisions) {
    const row = db.prepare("SELECT * FROM listings WHERE id = ? AND origin = ?").get(legacyId, ORIGIN_IMMOWELT);
    if (!row || row.immowelt_guid) continue; // already migrated or gone
    const before = rowToListing(row);
    if (d.decision === "match") {
      const guid = normalizeGuid(d.target?.guid);
      if (!guid || !inSnapshot.has(guid)) throw new ImmoweltError("identity_plan_stale", `Identitätsplan verweist auf ein Angebot, das nicht mehr im Bestand ist (${d.target?.online_id || "?"}).`);
      const newId = dashedGuid(guid);
      if (newId !== legacyId) {
        if (db.prepare("SELECT 1 AS x FROM listings WHERE id = ?").get(newId)) throw new ImmoweltError("identity_conflict", `Zielkennung für ${row.slug} ist bereits vergeben.`);
        db.prepare("UPDATE listings SET id = ?, immowelt_id = ? WHERE id = ? AND origin = ?").run(newId, newId, legacyId, ORIGIN_IMMOWELT);
        db.prepare("INSERT OR REPLACE INTO listing_aliases (alias, listing_id, kind, created_at) VALUES (?, ?, 'legacy_website_uuid', ?)").run(legacyId, newId, at);
        out.rekeyed.push({ slug: row.slug, from: legacyId, to: newId, evidence: (d.evidence || []).map((e) => e.type) });
      } else out.kept.push({ slug: row.slug, id: legacyId, evidence: (d.evidence || []).map((e) => e.type) });
      // mark as migrated so findRow() can pick it up by its API GUID
      db.prepare("UPDATE listings SET immowelt_guid = ? WHERE id = ?").run(guid, newId);
      history(db, { at, runId, id: newId, change: "rekey", before: { id: legacyId, slug: row.slug }, after: { id: newId, evidence: d.evidence || [] } });
    } else {
      const after = { ...before, active: false, missing_on_immowelt: true, retired_reason: "not_in_api_inventory_at_cutover" };
      db.prepare("UPDATE listings SET active = 0, retired_at = ?, payload = ?, updated_at = ? WHERE id = ? AND origin = ?").run(at, JSON.stringify(after), at, legacyId, ORIGIN_IMMOWELT);
      history(db, { at, runId, id: legacyId, change: "retire", before, after: { reason: after.retired_reason, evidence: d.evidence || [] } });
      out.retired.push({ slug: row.slug, id: legacyId, was_public: before.active !== false && before.site_hidden !== true });
    }
  }
  return out;
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {object} snapshot  validated snapshot with media applied (content_hash, bases)
 * @param {{ runId: string, now: string, checkedDate: string, fingerprint: string, identityPlan?: object|null }} ctx
 */
export function applySnapshot(db, snapshot, ctx) {
  const { runId, now, checkedDate, fingerprint, identityPlan = null } = ctx;
  const eigenBefore = stableJson(db.prepare("SELECT id, slug, active, site_hidden, payload, updated_at FROM listings WHERE origin = ? ORDER BY id").all(ORIGIN_EIGEN));

  const tx = db.transaction(() => {
    const summary = { inserted: [], updated: [], reactivated: [], retired: [], reordered: 0, unchanged: 0, identity: null };
    if (identityPlan) {
      summary.identity = applyIdentityPlan(db, identityPlan, snapshot, { at: now, runId });
      setJsonMeta(db, "immowelt_identity_migration", { applied_at: now, plan_hash: identityPlan.plan_hash || null, run_id: runId, ...Object.fromEntries(Object.entries(summary.identity).map(([k, v]) => [k, v.length])) });
    } else if (pendingLegacyRows(db).length) {
      throw new ImmoweltError("migration_required", "Alt-Datensätze aus der Scraper-Zeit sind noch nicht zugeordnet (Identitätsplan fehlt).");
    }

    const touched = new Set();
    for (const L of snapshot.listings) {
      const hit = findRow(db, L);
      const id = hit ? hit.row.id : dashedGuid(L.immowelt_guid);
      const prev = hit ? rowToListing(hit.row) : null;
      const slug = hit ? hit.row.slug : uniqueSlug(db, proposeSlug(L), id);
      const payload = {
        ...L,
        id,
        immowelt_id: id,
        slug,
        local_url: `objekt/${slug}.html`,
        first_seen_at: prev?.first_seen_at || hit?.row.created_at || now,
        ...(Array.isArray(prev?.legacy_ids) && prev.legacy_ids.length ? { legacy_ids: prev.legacy_ids } : {}),
      };
      const aliasRows = db.prepare("SELECT alias, kind FROM listing_aliases WHERE listing_id = ?").all(id);
      const aliases = aliasRows.filter((r) => r.kind !== "previous_slug").map((r) => r.alias);
      if (aliases.length) payload.legacy_ids = aliases;
      const previousSlugs = aliasRows.filter((r) => r.kind === "previous_slug").map((r) => r.alias);
      if (previousSlugs.length) payload.previous_slugs = previousSlugs; // old addresses keep redirecting
      touched.add(id);

      if (!hit) {
        db.prepare(
          `INSERT INTO listings (id, origin, slug, title, active, site_hidden, detail_page, immowelt_id, payload, created_at, updated_at,
             immowelt_guid, immowelt_estate_id, immowelt_online_id, position, retired_at, content_hash)
           VALUES (?, 'immowelt', ?, ?, 1, 0, 1, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
        ).run(id, slug, L.title, id, JSON.stringify(payload), now, now, L.immowelt_guid, L.immowelt_estate_id, L.immowelt_online_id, L.position, L.content_hash);
        history(db, { at: now, runId, id, change: "insert", after: payload });
        summary.inserted.push(L.immowelt_online_id);
        continue;
      }

      const wasActive = hit.row.active === 1 && hit.row.site_hidden === 0;
      const sameContent = hit.row.content_hash === L.content_hash && hit.row.immowelt_guid === L.immowelt_guid && hit.row.immowelt_online_id === L.immowelt_online_id;
      const samePosition = hit.row.position === L.position;
      if (wasActive && sameContent && samePosition) {
        summary.unchanged++;
        continue;
      }
      db.prepare(
        `UPDATE listings SET slug = ?, title = ?, active = 1, site_hidden = 0, detail_page = 1, immowelt_id = ?, payload = ?,
           updated_at = ?, immowelt_guid = ?, immowelt_estate_id = ?, immowelt_online_id = ?, position = ?, retired_at = NULL, content_hash = ?
         WHERE id = ? AND origin = 'immowelt'`
      ).run(slug, L.title, id, JSON.stringify(payload), wasActive && sameContent ? hit.row.updated_at : now, L.immowelt_guid, L.immowelt_estate_id, L.immowelt_online_id, L.position, L.content_hash, id);
      if (!wasActive) {
        history(db, { at: now, runId, id, change: "reactivate", before: prev, after: payload });
        summary.reactivated.push(L.immowelt_online_id);
      } else if (!sameContent) {
        history(db, { at: now, runId, id, change: "update", before: prev, after: payload });
        summary.updated.push(L.immowelt_online_id);
      } else summary.reordered++;
    }

    // Everything Immowelt no longer lists goes offline. The list is complete (TotalCount proof), so absence is the proof.
    for (const row of db.prepare("SELECT * FROM listings WHERE origin = ? AND active = 1").all(ORIGIN_IMMOWELT)) {
      if (touched.has(row.id)) continue;
      const before = rowToListing(row);
      const after = { ...before, active: false, missing_on_immowelt: true, retired_reason: "not_in_immowelt_inventory" };
      db.prepare("UPDATE listings SET active = 0, retired_at = ?, payload = ?, updated_at = ? WHERE id = ? AND origin = 'immowelt'").run(now, JSON.stringify(after), now, row.id);
      history(db, { at: now, runId, id: row.id, change: "retire", before, after: { reason: after.retired_reason } });
      summary.retired.push(row.immowelt_online_id || row.slug);
    }

    setMeta(db, "immowelt_scraped_at", snapshot.fetched_at);
    setMeta(db, "immowelt_checked_date", checkedDate);
    setMeta(db, "immowelt_fingerprint", fingerprint);
    setMeta(db, "immowelt_profile", "https://www.immowelt.de/profil/3b18336c6a2e401da38e9cc20268270d");
    setMeta(db, "publish_pending", ""); // the old manual "Abnahme" step no longer exists for Immowelt data
    setMeta(db, "immowelt_pending_confirmation", "");
    archiveSnapshot(db, snapshot, fingerprint, now, { published: true });
    return summary;
  });
  const summary = tx.immediate ? tx.immediate() : tx();

  const eigenAfter = stableJson(db.prepare("SELECT id, slug, active, site_hidden, payload, updated_at FROM listings WHERE origin = ? ORDER BY id").all(ORIGIN_EIGEN));
  if (eigenBefore !== eigenAfter) throw new Error("BUG: Immowelt-Übernahme hat eigene Inserate verändert");
  summary.changed = Boolean(summary.inserted.length || summary.updated.length || summary.reactivated.length || summary.retired.length || summary.reordered || summary.identity);
  return summary;
}

/** Only the "checked today" marker moves (nothing changed on Immowelt, the date on the site rolls on). */
export function touchCheckedDate(db, checkedDate, fetchedAt) {
  setMeta(db, "immowelt_checked_date", checkedDate);
  if (fetchedAt) setMeta(db, "immowelt_scraped_at", fetchedAt);
}

export function archiveSnapshot(db, snapshot, fingerprint, now, { published = false } = {}) {
  const row = db.prepare("SELECT fingerprint FROM immowelt_snapshots WHERE fingerprint = ?").get(fingerprint);
  if (row) {
    db.prepare(`UPDATE immowelt_snapshots SET last_seen_at = ?${published ? ", published_at = COALESCE(published_at, ?)" : ""} WHERE fingerprint = ?`).run(...(published ? [now, now, fingerprint] : [now, fingerprint]));
  } else {
    db.prepare("INSERT INTO immowelt_snapshots (fingerprint, first_seen_at, last_seen_at, published_at, total_count, document) VALUES (?, ?, ?, ?, ?, ?)").run(fingerprint, now, now, published ? now : null, snapshot.listings.length, JSON.stringify(snapshot));
  }
}

export function recordRun(db, run) {
  db.prepare(
    `INSERT INTO immowelt_runs (run_id, started_at, finished_at, trigger, outcome, fingerprint, total_count, error_code, error_message, release_id, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id) DO UPDATE SET finished_at = excluded.finished_at, outcome = excluded.outcome, fingerprint = excluded.fingerprint,
       total_count = excluded.total_count, error_code = excluded.error_code, error_message = excluded.error_message, release_id = excluded.release_id, details = excluded.details`
  ).run(run.runId, run.startedAt, run.finishedAt || null, run.trigger || null, run.outcome, run.fingerprint || null, run.totalCount ?? null, run.errorCode || null, run.errorMessage ? String(run.errorMessage).slice(0, 500) : null, run.releaseId || null, json(run.details));
  // unchanged heartbeats would otherwise grow without bound
  db.prepare("DELETE FROM immowelt_runs WHERE outcome = 'unchanged' AND run_id NOT IN (SELECT run_id FROM immowelt_runs WHERE outcome = 'unchanged' ORDER BY started_at DESC LIMIT 500)").run();
}

/** Consistent copy of the live database (works while other processes write). */
export function backupDatabase(db, destPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.rmSync(destPath, { force: true });
  db.exec(`VACUUM INTO '${String(destPath).replace(/'/g, "''")}'`);
  fs.chmodSync(destPath, 0o600);
  return destPath;
}

export function pruneFiles(dir, keep, filter = () => true) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter(filter).sort();
  } catch {
    return 0;
  }
  const drop = names.slice(0, Math.max(0, names.length - keep));
  for (const n of drop) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
  return drop.length;
}

/**
 * Data rollback: put the Immowelt rows (and the Immowelt meta keys) back to the state of a
 * backup taken before a publish. Runs inside the live database (ATTACH + one transaction) –
 * no file is swapped under running services, and origin=eigen is not touched.
 */
export function restoreImmoweltRows(db, backupPath, { now = new Date().toISOString(), runId = null } = {}) {
  if (!fs.existsSync(backupPath)) throw new ImmoweltError("backup_missing", "Datenbank-Sicherung nicht gefunden.");
  db.exec(`ATTACH DATABASE '${String(backupPath).replace(/'/g, "''")}' AS bak`);
  try {
    const live = db.prepare("PRAGMA main.table_info(listings)").all().map((c) => c.name);
    const old = new Set(db.prepare("PRAGMA bak.table_info(listings)").all().map((c) => c.name));
    const cols = live.filter((c) => old.has(c));
    const list = cols.map((c) => `"${c}"`).join(", ");
    const tx = db.transaction(() => {
      const before = db.prepare("SELECT COUNT(*) AS n FROM main.listings WHERE origin = 'immowelt' AND active = 1").get().n;
      db.prepare("DELETE FROM main.listings WHERE origin = 'immowelt'").run();
      db.prepare(`INSERT INTO main.listings (${list}) SELECT ${list} FROM bak.listings WHERE origin = 'immowelt'`).run();
      for (const key of ["immowelt_fingerprint", "immowelt_checked_date", "immowelt_scraped_at", "immowelt_identity_migration", "immowelt_pending_confirmation"]) {
        const row = db.prepare("SELECT value FROM bak.meta WHERE key = ?").get(key);
        if (row) db.prepare("INSERT INTO main.meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, row.value);
        else db.prepare("DELETE FROM main.meta WHERE key = ?").run(key);
      }
      const after = db.prepare("SELECT COUNT(*) AS n FROM main.listings WHERE origin = 'immowelt' AND active = 1").get().n;
      history(db, { at: now, runId, id: "*", change: "rollback", before: { active: before }, after: { active: after, backup: path.basename(backupPath) } });
      return { active_before: before, active_after: after };
    });
    return tx.immediate ? tx.immediate() : tx();
  } finally {
    db.exec("DETACH DATABASE bak");
  }
}

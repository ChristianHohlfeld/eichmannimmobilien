/**
 * Immowelt → website, one run.
 *
 *   lock → key → fetch complete inventory + every exposé → normalize → gate → pictures
 *        → unchanged? heartbeat : candidate DB → build release → verify
 *        → live DB (one transaction) → switch release (one rename) → status
 *
 * Fail-closed: any error before the switch leaves database, pictures in use and the public
 * site exactly as they were (last-known-good); the run ends non-zero and the status file says
 * why. Nothing is ever published partially.
 *
 * Crash-safe: the live DB records which release it expects (release_pending). A run that finds
 * the public site on another release finishes that switch first (or rebuilds from the DB).
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { openDb, exportListingsDocument, setMeta } from "../db.mjs";
import { readImmoweltCredentials } from "../immowelt-secrets.mjs";
import { loadConfig, berlinDate, utcStamp } from "./config.mjs";
import { acquireLock, LockBusyError } from "./lock.mjs";
import { fetchInventory, fetchExpose, soapCall, parseListResponse, buildByGuidsEnvelope, ImmoweltError, ESTATE_SERVICE_URL, ACTION_BY_GUIDS } from "./soap.mjs";
import { attr, child } from "./xml.mjs";
import { buildSnapshot, snapshotFingerprint, stableJson } from "./normalize.mjs";
import { validateSnapshot, classifyChange, needsConfirmation, confirmationState } from "./validate.mjs";
import { planLegacyMigration, normalizeGuid } from "./identity.mjs";
import { ensureMedia, gcMedia } from "./media.mjs";
import { applySnapshot, archiveSnapshot, backupDatabase, getState, pendingLegacyRows, publishedApiListings, pruneFiles, recordRun, setJsonMeta, touchCheckedDate } from "./store.mjs";
import { readStatus, writeStatus, writeJsonAtomic, notifySinks, STATUS_SCHEMA } from "./status.mjs";
import { buildRelease, activateRelease, rollbackRelease, listReleases, currentReleaseId, gcReleases, isLayoutActive, releasePaths } from "../release.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Hash of the identity DECISIONS (which old row maps to which offer, which is retired, which
 * offers are new). Text or price edits on Immowelt between planning and approval do not
 * invalidate an approved plan; a different inventory or a different mapping does.
 */
export function planHash(plan) {
  const reduced = {
    legacy: (plan.legacy || []).map((d) => [d.legacy_id, d.decision, d.target?.guid || null]).sort(),
    created: (plan.created || []).map((d) => d.target?.guid || null).sort(),
  };
  return createHash("sha256").update(stableJson(reduced)).digest("hex").slice(0, 16);
}

function loadManualEvidence(config) {
  try {
    const doc = JSON.parse(fs.readFileSync(config.identityMapFile, "utf8"));
    return Array.isArray(doc.evidence) ? doc.evidence : [];
  } catch {
    return [];
  }
}

/** GUIDs named in data/sot/immowelt-extra-guids.json (pointers only, no content). Missing file = none. */
export function readExtraGuids(file) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw new ImmoweltError("immowelt_config", `Zusatzliste nicht lesbar (${path.basename(file)}): ${err.message}`);
  }
  const out = [];
  for (const o of doc.offers || []) {
    const g = normalizeGuid(o?.guid);
    if (!g) throw new ImmoweltError("immowelt_config", `Zusatzliste (${path.basename(file)}): ungültige GUID.`);
    if (!out.includes(g)) out.push(g);
  }
  return out;
}

/** Read the API completely. Throws on anything that is not a complete, consistent answer. */
export async function fetchSnapshot(apiKey, config, { fetchImpl = globalThis.fetch, sleepImpl = sleep, now = new Date(), log = () => {} } = {}) {
  const soap = { ...config.soap, fetchImpl, sleepImpl, onRetry: ({ attempt, code }) => log(`Immowelt-Abruf wird wiederholt (Versuch ${attempt + 1}, ${code}).`) };
  const call = (url, action, envelope) => soapCall(url, action, envelope, soap);
  const inventories = [];
  for (const geoId of config.geoIds) {
    const full = await fetchInventory(apiKey, { geoId, pageSize: config.pageSize, sort: config.listSort, call });
    if (config.includeHomepageOnly) {
      inventories.push(full);
      continue;
    }
    // The list also delivers offers that Immowelt releases for the customer's own homepage only
    // ("Projekt extern", not public on immowelt.de). The same list without IncludeIwObj names exactly
    // those. They are hidden until it is decided that they belong on the website
    // (IMMOWELT_INCLUDE_HOMEPAGE_ONLY=true shows them).
    const own = await fetchInventory(apiKey, { geoId, pageSize: config.pageSize, sort: config.listSort, includeIwObj: false, call });
    const ownGuids = new Set(own.properties.map((p) => p.guid));
    const fullGuids = new Set(full.properties.map((p) => p.guid));
    const stray = own.properties.filter((p) => !fullGuids.has(p.guid));
    if (stray.length) {
      throw new ImmoweltError("immowelt_list_unstable", `Homepage-Liste nennt ${stray.length} Angebot(e), die im Gesamtbestand fehlen (${stray.map((p) => p.onlineId).join(", ")}).`);
    }
    const excluded = full.properties.filter((p) => ownGuids.has(p.guid)).map((p) => p.onlineId);
    if (excluded.length) log(`Immowelt: ${excluded.length} Angebot(e) nur für die eigene Homepage freigegeben – ausgeblendet (${excluded.join(", ")}).`);
    inventories.push({ ...full, properties: full.properties.filter((p) => !ownGuids.has(p.guid)), totalCount: full.totalCount - excluded.length, apiTotal: full.totalCount, homepageOnly: excluded, extraPages: own.pages });
  }
  const exposes = new Map();
  const raw = {
    lists: inventories.flatMap((inv) => [
      ...inv.pages.map((p) => ({ geo_id: inv.geoId, page: p.page, xml: p.xml })),
      ...(inv.extraPages || []).map((p) => ({ geo_id: `${inv.geoId}-homepage`, page: p.page, xml: p.xml })),
    ]),
    exposes: [],
  };

  // Offers that are online on Immowelt but missing in every list of the API (no location id in
  // Immowelt's data) are named in data/sot/immowelt-extra-guids.json and fetched by their GUID.
  // Only the pointer is ours; whether the offer exists and everything it says comes from the API.
  const listed = new Set(inventories.flatMap((inv) => inv.properties.map((p) => normalizeGuid(p.guid))));
  const wanted = readExtraGuids(config.extraGuidsFile).filter((g) => !listed.has(g));
  const byGuid = new Set();
  if (wanted.length && inventories.length) {
    if (!config.profileGuid) throw new ImmoweltError("immowelt_config", "Einzelabruf per GUID braucht die Anbieter-Kennung (IMMOWELT_PROFILE_GUID).");
    const xml = await call(ESTATE_SERVICE_URL, ACTION_BY_GUIDS, buildByGuidsEnvelope(apiKey, wanted));
    const parsed = parseListResponse(xml);
    raw.lists.push({ geo_id: "guids", page: 1, xml });
    const got = parsed.properties.filter((p) => wanted.includes(normalizeGuid(p.guid)));
    if (got.length !== parsed.properties.length || new Set(got.map((p) => normalizeGuid(p.guid))).size !== got.length) {
      throw new ImmoweltError("immowelt_list_unstable", "Einzelabruf per GUID lieferte nicht angefragte oder doppelte Angebote.");
    }
    // Not delivered = gone, but only when the exposé says so too (two independent answers, never a silent drop).
    for (const guid of wanted.filter((g) => !got.some((p) => normalizeGuid(p.guid) === g))) {
      let stillThere = true;
      try {
        await fetchExpose(apiKey, guid, { call });
      } catch (err) {
        if (!(err instanceof ImmoweltError) || err.code !== "immowelt_expose_status") throw err;
        stillThere = false;
      }
      if (stillThere) throw new ImmoweltError("immowelt_list_unstable", `Einzelabruf: Angebot ${guid.slice(0, 8)} fehlt in der Antwort, das Exposé ist aber lieferbar.`);
      log(`Immowelt: per GUID benanntes Angebot ${guid.slice(0, 8)}… ist bei Immowelt nicht mehr vorhanden – offline.`);
    }
    if (got.length) {
      const inv = inventories[0];
      const merged = [...inv.properties, ...got];
      // keep Immowelt's own order (newest first) when every entry carries its creation date
      const at = (p) => {
        const m = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(p.attrs?.CreateDate || ""));
        return m ? Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]) : null;
      };
      if (config.listSort === "createdatedesc" && merged.every((p) => at(p) != null)) {
        const order = new Map(merged.map((p, i) => [p, i]));
        merged.sort((a, b) => at(b) - at(a) || order.get(a) - order.get(b));
      }
      inventories[0] = { ...inv, properties: merged, totalCount: inv.totalCount + got.length, listTotal: inv.totalCount, byGuid: got.map((p) => p.onlineId) };
      for (const p of got) byGuid.add(p.guid);
      log(`Immowelt: ${got.length} Angebot(e) per GUID ergänzt, die in der Liste fehlen (${got.map((p) => p.onlineId).join(", ")}).`);
    }
  }
  for (const inv of inventories) {
    for (const prop of inv.properties) {
      if (exposes.has(prop.guid)) continue;
      if (exposes.size && config.exposeDelayMs) await sleepImpl(config.exposeDelayMs);
      try {
        const { xml, expose } = await fetchExpose(apiKey, prop.guid, { call });
        if (byGuid.has(prop.guid) && normalizeGuid(attr(child(expose, "address"), "AdrGuid")) !== normalizeGuid(config.profileGuid)) {
          throw new ImmoweltError("immowelt_owner_mismatch", "Per GUID benanntes Angebot gehört laut Exposé nicht zum Eichmann-Profil.");
        }
        exposes.set(prop.guid, expose);
        raw.exposes.push({ online_id: prop.onlineId, xml });
      } catch (err) {
        if (err instanceof ImmoweltError) {
          err.message = `Angebot ${prop.onlineId}: ${err.message}`;
          err.onlineId = prop.onlineId;
        }
        throw err; // one missing exposé = no snapshot (never a list stub instead of the real content)
      }
    }
  }
  const snapshot = buildSnapshot({ inventories, exposes, fetchedAt: now.toISOString(), config });
  return { snapshot, raw };
}

async function archiveRaw(config, fingerprint, snapshot, raw) {
  const dir = path.join(config.snapshotsDir, fingerprint.slice(0, 16));
  if (fs.existsSync(path.join(dir, "snapshot.json.gz"))) return dir;
  await fsp.mkdir(dir, { recursive: true, mode: 0o750 });
  const gz = (name, text) => fsp.writeFile(path.join(dir, name), zlib.gzipSync(text), { mode: 0o640 });
  for (const l of raw.lists) await gz(`list-geo${l.geo_id}-p${l.page}.xml.gz`, l.xml);
  for (const e of raw.exposes) await gz(`expose-${e.online_id}.xml.gz`, e.xml);
  await gz("snapshot.json.gz", JSON.stringify(snapshot, null, 1));
  return dir;
}

function publishedSummary(db, releaseId) {
  const st = getState(db);
  const doc = exportListingsDocument(db);
  // detail_total = what /ai/listings.json counts (public offers with their own page); the external watchdog compares exactly that
  const detailTotal = doc.listings.filter((L) => L.active !== false && L.site_hidden !== true && L.detail_page !== false).length;
  return { release_id: releaseId, fingerprint: st.fingerprint, count: publishedApiListings(db).length, public_total: doc.active_listing_count, detail_total: detailTotal, data_as_of: st.checkedDate };
}

/**
 * Build a release from the live database and switch to it (deploys, admin publishes, healing).
 * Caller holds the lock.
 */
export async function publishFromDatabase(config, { db, reason, lockToken, log = () => {}, fetchImpl } = {}) {
  const runDir = path.join(config.runsDir, `publish-${utcStamp()}`);
  await fsp.mkdir(runDir, { recursive: true });
  const copy = backupDatabase(db, path.join(runDir, "build.db"));
  const cdb = openDb(copy);
  const doc = exportListingsDocument(cdb);
  cdb.close();
  const rel = await buildRelease(config, { dbPath: copy, doc, reason, lockToken, log });
  setMeta(db, "release_pending", rel.id);
  await activateRelease(config, rel.id, { reason, fetchImpl });
  setMeta(db, "release_live", rel.id);
  await fsp.rm(runDir, { recursive: true, force: true });
  // the status names what is online – otherwise the external watchdog would report every deploy as a mismatch
  const st = readStatus(config.statusFile);
  if (st?.schema === STATUS_SCHEMA) writeJsonAtomic(config.statusFile, { ...st, published: publishedSummary(db, rel.id) });
  return rel;
}

/**
 * Operator hold: nothing is published automatically – the sync neither fetches nor publishes, and
 * saves from the admin UI are stored but not published. Deliberate builds (deploy, release.mjs
 * build, restore of a backup) still publish. Lifted with "resume".
 */
export function setHold(db, config, { reason, now = new Date(), published = null } = {}) {
  const hold = { at: now.toISOString(), reason: String(reason || "ohne Angabe").slice(0, 200) };
  setJsonMeta(db, "immowelt_hold", hold);
  const status = writeStatus(config.statusFile, { state: "held", now: hold.at, trigger: "operator", error: { code: "held", message: `Veröffentlichung pausiert: ${hold.reason}` }, ...(published ? { published } : {}) }, { staleAfterMinutes: config.staleAfterMinutes });
  return { hold, status };
}

export function clearHold(db) {
  setJsonMeta(db, "immowelt_hold", null);
}

/**
 * Put the public site back on the previous (or a named) release and pause publishing (hold) –
 * otherwise the next run would rebuild from the database and undo the rollback within half an
 * hour. Data is not touched; after "resume" the next run publishes the current state again.
 * Caller holds the lock.
 */
export async function rollbackSite(config, { db, targetId = null, now = new Date(), fetchImpl } = {}) {
  const res = await rollbackRelease(config, targetId, { fetchImpl });
  const manifest = listReleases(config).find((r) => r.id === res.id)?.manifest || null;
  const published = {
    release_id: res.id,
    fingerprint: manifest?.data?.immowelt_fingerprint || null,
    count: manifest?.summary?.immowelt ?? null,
    public_total: manifest?.summary?.public ?? null,
    detail_total: manifest?.summary?.detail ?? null,
    data_as_of: manifest?.data?.immowelt_checked_date || null,
  };
  const { hold, status } = setHold(db, config, { reason: `Release-Rollback auf ${res.id}`, now, published });
  return { ...res, hold, status };
}

/**
 * @param {{ trigger?: string, identityPlan?: object|null, dryRun?: boolean, env?: object, deps?: object }} opts
 * @returns {Promise<{ outcome: string, exitCode: number, status: object|null, [k: string]: any }>}
 *   outcome: published | unchanged | date_roll | republished | pending_confirmation | held | busy   (exit 0)
 *            failed | awaiting_api_key (exit 1) · migration_required (exit 3) · dry_run (exit 0, nothing written)
 */
export async function runSync(opts = {}) {
  const { trigger = "timer", identityPlan = null, dryRun = false, env = process.env, deps = {} } = opts;
  const config = deps.config || loadConfig(env);
  const now = deps.now ? deps.now() : new Date();
  const nowIso = now.toISOString();
  const log = deps.log || ((msg) => console.log(msg));
  const runId = `${utcStamp(now)}-${process.pid}`;
  const previousStatus = readStatus(config.statusFile);
  const statusOpts = { staleAfterMinutes: config.staleAfterMinutes };

  let lock;
  try {
    lock = await acquireLock(config.lockDir, { purpose: `immowelt-sync (${trigger})`, waitMs: opts.waitMs ?? 0, staleMinutes: config.lockStaleMinutes, env });
  } catch (err) {
    if (err instanceof LockBusyError) {
      // Not a failure of the sync: another publish is running. The watchdog still sees the age of last_success_at.
      log(err.message);
      return { outcome: "busy", exitCode: 0, status: previousStatus };
    }
    throw err;
  }
  if (lock.tookOverFrom) log(`Verwaiste Sperre übernommen (PID ${lock.tookOverFrom.pid}, ${lock.tookOverFrom.purpose}).`);

  let db = null;
  let runDir = null;
  let apiKey = "";
  const finish = async (state, extra = {}) => {
    let status = null;
    if (!dryRun) {
      status = writeStatus(config.statusFile, { state, now: nowIso, runId, trigger, ...extra }, statusOpts);
      if (db) {
        try {
          recordRun(db, { runId, startedAt: nowIso, finishedAt: new Date().toISOString(), trigger, outcome: extra.outcome || state, fingerprint: extra.fingerprint, totalCount: extra.totalCount, errorCode: extra.error?.code, errorMessage: extra.error?.message, releaseId: extra.published?.release_id, details: extra.change || null });
        } catch (e) {
          log(`Laufprotokoll konnte nicht geschrieben werden (${e.code || e.name}).`);
        }
      }
      await notifySinks(config.alarmFile, status, previousStatus, { fetchImpl: deps.sinkFetch || globalThis.fetch, log });
    }
    return status;
  };

  try {
    db = openDb(config.dbPath);
    const state0 = getState(db);
    const layout = isLayoutActive(config);
    if (!layout && !dryRun) {
      // Without the release layout a changed database could not be shown atomically – do not create that half state.
      throw new ImmoweltError("layout_missing", "Release-Layout ist auf dem Server noch nicht eingerichtet (deploy/install-release-layout.sh).");
    }

    // --- operator hold: nothing is fetched, applied or switched (a dry run may still look) ---
    // Checked before anything else touches the public site: a hold after a release rollback must
    // not be undone by the recovery below.
    if (state0.hold && !opts.ignoreHold && !dryRun) {
      const status = await finish("held", { error: { code: "held", message: `Veröffentlichung pausiert seit ${state0.hold.at}: ${state0.hold.reason || "ohne Angabe"}` }, published: previousStatus?.published });
      return { outcome: "held", exitCode: 0, status };
    }

    // --- crash recovery: a switch was begun (release_pending) and not completed (release_live) ---
    // A site that was put on another release on purpose (release.mjs rollback) is not this case:
    // there pending == live, and the run further down rebuilds from the database once resumed.
    if (!dryRun && state0.releasePending && state0.releasePending !== state0.releaseLive) {
      const pendingIndex = path.join(releasePaths(config).dir, state0.releasePending, "index.html");
      if (state0.releasePending === currentReleaseId(config)) {
        // the switch happened, only the bookkeeping is missing
        setMeta(db, "release_live", state0.releasePending);
      } else if (fs.existsSync(pendingIndex)) {
        log(`Unterbrochener Lauf erkannt: Release ${state0.releasePending} wird nachträglich live geschaltet.`);
        await activateRelease(config, state0.releasePending, { reason: "recovery", fetchImpl: deps.smokeFetch });
        setMeta(db, "release_live", state0.releasePending);
      } else {
        log("Unterbrochener Lauf erkannt: Release wird aus der Datenbank neu gebaut.");
        await publishFromDatabase(config, { db, reason: "recovery", lockToken: lock.token, log, fetchImpl: deps.smokeFetch });
      }
    }

    // --- credentials (file on the droplet; IMMOWELT_API_KEY only for CI probes) ---
    apiKey = deps.apiKey || (env.IMMOWELT_API_KEY || "").trim() || readImmoweltCredentials()?.api_key || "";
    if (!apiKey) {
      const status = await finish("awaiting_api_key", { error: { code: "awaiting_api_key", message: "Immowelt-API-Schlüssel fehlt auf dem Server. Der letzte vollständige Stand bleibt online." } });
      return { outcome: "awaiting_api_key", exitCode: 1, status };
    }

    // --- read Immowelt completely ---
    const { snapshot, raw } = await fetchSnapshot(apiKey, config, { fetchImpl: deps.fetchImpl, sleepImpl: deps.sleepImpl, now, log });
    const verdict = validateSnapshot(snapshot, { allowedImageHosts: config.allowedImageHosts });
    if (!verdict.ok) {
      const first = verdict.errors[0];
      throw new ImmoweltError(first.code, `Snapshot unvollständig oder widersprüchlich: ${first.online_id ? `Angebot ${first.online_id}: ` : ""}${first.message}${verdict.errors.length > 1 ? ` (+${verdict.errors.length - 1} weitere)` : ""}`);
    }
    if (!(dryRun && opts.skipMedia)) {
      await ensureMedia(snapshot, config, { fetchImpl: deps.imageFetch || deps.fetchImpl, processor: deps.imageProcessor, now, log });
    }
    const fingerprint = snapshotFingerprint(snapshot.listings);
    const today = berlinDate(now);
    log(`Immowelt: ${snapshot.listings.length} Angebot(e) vollständig gelesen (TotalCount bestätigt), Fingerabdruck ${fingerprint.slice(0, 12)}.`);

    // --- one-time identity migration (scraper-era rows) ---
    const legacy = pendingLegacyRows(db);
    let plan = null;
    if (legacy.length) {
      const fresh = planLegacyMigration(legacy, snapshot.listings, loadManualEvidence(config));
      fresh.snapshot_fingerprint = fingerprint;
      fresh.plan_hash = planHash(fresh);
      if (!identityPlan) {
        if (!dryRun) {
          await fsp.mkdir(path.dirname(config.identityPlanFile), { recursive: true });
          await fsp.writeFile(config.identityPlanFile, `${JSON.stringify({ ...fresh, created_at: nowIso }, null, 2)}\n`, { mode: 0o640 });
          archiveSnapshot(db, snapshot, fingerprint, nowIso);
        }
        const status = await finish("migration_required", {
          fingerprint,
          totalCount: snapshot.listings.length,
          error: { code: "migration_required", message: `Einmalige Zuordnung nötig: ${legacy.length} Alt-Datensätze, davon ${fresh.legacy.filter((d) => d.decision === "match").length} belegt zugeordnet, ${fresh.legacy.filter((d) => d.decision === "retire").length} ohne Beleg. Plan prüfen und freigeben (Plan ${fresh.plan_hash}).` },
        });
        return { outcome: "migration_required", exitCode: 3, status, plan: fresh, snapshot };
      }
      if (identityPlan.plan_hash !== fresh.plan_hash) {
        throw new ImmoweltError("identity_plan_stale", `Freigegebener Identitätsplan (${identityPlan.plan_hash}) passt nicht mehr zum aktuellen Bestand (${fresh.plan_hash}). Bitte neu planen.`);
      }
      plan = fresh;
    }

    // --- what would change? ---
    const published = publishedApiListings(db);
    const change = classifyChange(published, snapshot.listings);
    const state = getState(db);
    const sameData = !plan && state.fingerprint === fingerprint && change.unchanged;
    // "live" = the site is on the release the database names AND that release was built from this very state
    // (a crash right after the data commit leaves an older release live – then the run rebuilds instead of reporting "unchanged")
    const liveManifest = listReleases(config).find((r) => r.current)?.manifest || null;
    const liveOk = Boolean(state.releaseLive) && state.releaseLive === currentReleaseId(config) && liveManifest?.data?.immowelt_fingerprint === state.fingerprint;
    const dateRolled = state.checkedDate !== today;

    if (dryRun) {
      return { outcome: "dry_run", exitCode: 0, status: null, snapshot, fingerprint, change, plan, warnings: verdict.warnings };
    }

    // A remembered "large disappearance" only counts when the very next complete read repeats it.
    // Any complete read that needs no confirmation discards it – a single odd answer days later starts from zero.
    if (state.pendingConfirmation && (sameData || !needsConfirmation(change, { minRemoved: config.confirmMinRemoved }))) setJsonMeta(db, "immowelt_pending_confirmation", null);

    if (sameData && liveOk && !dateRolled) {
      archiveSnapshot(db, snapshot, fingerprint, nowIso);
      const status = await finish("current", { outcome: "unchanged", fingerprint, totalCount: snapshot.listings.length, warnings: verdict.warnings, published: publishedSummary(db, state.releaseLive || currentReleaseId(config)) });
      return { outcome: "unchanged", exitCode: 0, status, fingerprint, change };
    }

    // --- large disappearance: wait for the identical second answer ---
    if (!plan && !sameData) {
      const reason = needsConfirmation(change, { minRemoved: config.confirmMinRemoved });
      if (reason) {
        const conf = confirmationState(state.pendingConfirmation, { fingerprint, reason, now: nowIso, minMinutes: config.confirmMinMinutes });
        if (!conf.confirmed) {
          setJsonMeta(db, "immowelt_pending_confirmation", conf.pending);
          archiveSnapshot(db, snapshot, fingerprint, nowIso);
          await archiveRaw(config, fingerprint, snapshot, raw);
          log(`Großer Wegfall (${reason}): ${change.removed.length} von ${change.published_count} Angeboten fehlen. Veröffentlichung erst nach identischer zweiter Antwort (≥ ${config.confirmMinMinutes} min).`);
          const status = await finish("pending_confirmation", { fingerprint, totalCount: snapshot.listings.length, pending: { ...conf.pending, removed: change.removed.length, candidate_count: change.candidate_count }, warnings: verdict.warnings, published: publishedSummary(db, state.releaseLive || currentReleaseId(config)) });
          return { outcome: "pending_confirmation", exitCode: 0, status, fingerprint, change };
        }
        log(`Großer Wegfall (${reason}) durch zweite identische Antwort bestätigt.`);
      }
    }

    // --- candidate database → release (nothing public is touched yet) ---
    runDir = path.join(config.runsDir, runId);
    await fsp.mkdir(runDir, { recursive: true, mode: 0o750 });
    const candidatePath = backupDatabase(db, path.join(runDir, "candidate.db"));
    const cdb = openDb(candidatePath);
    let summary;
    let doc;
    try {
      if (sameData) touchCheckedDate(cdb, today, snapshot.fetched_at);
      else summary = applySnapshot(cdb, snapshot, { runId, now: nowIso, checkedDate: today, fingerprint, identityPlan: plan });
      doc = exportListingsDocument(cdb);
    } finally {
      cdb.close();
    }

    // published = Immowelt changed · date_roll = same data, new day · republished = same data, but the
    // site was not on the release the database expects (after a release rollback + resume, or a lost switch)
    const kind = !sameData ? "published" : dateRolled ? "date_roll" : "republished";
    const releaseReason = { published: "immowelt", date_roll: "date-roll", republished: "republish" }[kind];
    const release = await buildRelease(config, { dbPath: candidatePath, doc, reason: releaseReason, lockToken: lock.token, buildDate: today, log, meta: { run_id: runId } });

    // --- point of no return: live database (one transaction), then the switch (one rename) ---
    backupDatabase(db, path.join(config.backupsDir, `listings-before-${runId}.db`));
    if (sameData) touchCheckedDate(db, today, snapshot.fetched_at);
    else summary = applySnapshot(db, snapshot, { runId, now: nowIso, checkedDate: today, fingerprint, identityPlan: plan });
    // If the switch fails (web server does not serve the release) the run ends "failed" with the
    // site on the previous release. The database already holds the validated new state and names
    // the release it expects; the next run finishes the switch (see crash recovery above).
    setMeta(db, "release_pending", release.id);
    await activateRelease(config, release.id, { reason: releaseReason, fetchImpl: deps.smokeFetch });
    setMeta(db, "release_live", release.id);

    await archiveRaw(config, fingerprint, snapshot, raw);
    const changeOut = sameData ? { [kind]: true } : { added: summary.inserted, changed: summary.updated, reactivated: summary.reactivated, removed: summary.retired, reordered: summary.reordered > 0, identity: summary.identity ? Object.fromEntries(Object.entries(summary.identity).map(([k, v]) => [k, v.length])) : undefined };
    const status = await finish("current", { outcome: kind, changed: !sameData, change: sameData ? undefined : { at: nowIso, ...changeOut }, fingerprint, totalCount: snapshot.listings.length, warnings: verdict.warnings, published: publishedSummary(db, release.id) });
    log(kind === "republished" ? `Immowelt unverändert; die Website stand nicht auf dem erwarteten Release und wurde neu veröffentlicht (Release ${release.id}).` : sameData ? `Unverändert; Datenstand auf ${today} fortgeschrieben (Release ${release.id}).` : `Veröffentlicht als Release ${release.id}: +${summary.inserted.length} neu, ${summary.updated.length} geändert, ${summary.reactivated.length} wieder aktiv, ${summary.retired.length} offline.`);

    // --- housekeeping (never fails the run) ---
    try {
      await fsp.rm(runDir, { recursive: true, force: true });
      pruneFiles(config.backupsDir, config.keepDbBackups, (n) => n.endsWith(".db"));
      pruneFiles(config.runsDir, config.keepRuns);
      const gc = await gcReleases(config);
      await gcMedia(config, gc.media);
    } catch (e) {
      log(`Aufräumen übersprungen (${e.code || e.name}).`);
    }
    return { outcome: kind, exitCode: 0, status, fingerprint, change: changeOut, release, summary };
  } catch (err) {
    const known = err instanceof ImmoweltError || err?.name === "ReleaseError";
    const error = { code: err?.code || "internal_error", message: known ? err.message : `Interner Fehler im Abgleich (${err?.name || "Error"}). Details im Server-Log.` };
    // whatever an upstream fault text quotes: the key never reaches status, log or admin UI
    if (apiKey) error.message = error.message.split(apiKey).join("[Schlüssel]");
    if (!known) console.error(err);
    log(`FEHLGESCHLAGEN [${error.code}] ${error.message} – der letzte vollständige Stand bleibt online.`);
    const status = dryRun ? null : await finish("failed", { error, outcome: "failed" });
    return { outcome: "failed", exitCode: 1, status, error };
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
    // a failed run leaves no working copies behind
    if (runDir) await fsp.rm(runDir, { recursive: true, force: true }).catch(() => {});
    lock.release();
  }
}

/**
 * Atomic releases of the public site.
 *
 *   <releases>/<id>/          complete public tree, built in <id>.staging, never edited afterwards
 *   <releases>/<id>.json      manifest (what it was built from, which media it references)
 *   <releases>/current        symlink → <id>; switched with one rename(2)
 *   <webroot>                 symlink → <releases>/current (set up once, see deploy/install-release-layout.sh)
 *
 * A release is built by the code INSIDE its own staging copy (scripts/build.mjs resolves the
 * site root from its location), from one SQLite file. Deploys, Immowelt changes and admin
 * publishes all go through here, under the pipeline lock – there is no second writer and no
 * in-place edit of what visitors see.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { utcStamp } from "./immowelt/config.mjs";
import { verifyRelease } from "./release-verify.mjs";
import { mediaFilesOf } from "./immowelt/media.mjs";

export class ReleaseError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "ReleaseError";
    this.code = code;
    Object.assign(this, extra);
  }
}

const RELEASE_ID_RE = /^\d{8}T\d{6}Z-[a-z0-9]{6}$/;
/** Never copied into a release (top-level names of the app tree). */
const COPY_EXCLUDE = new Set([".git", ".github", "node_modules", "var", "media", "snapshots", "test-results", "test", "test-support", "docs", "deploy", "README.md", ".gitignore", ".deploy-commit"]);
/** Needed to build, removed before the release is verified and served. */
const BUILD_ONLY = ["scripts", "package.json", "package-lock.json", "node_modules"];

export function releasePaths(config) {
  return { dir: config.releasesDir, current: path.join(config.releasesDir, "current"), state: path.join(config.releasesDir, "state.json") };
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export function currentReleaseId(config) {
  try {
    return path.basename(fs.readlinkSync(releasePaths(config).current));
  } catch {
    return null;
  }
}

/** True once the webroot is the symlink into the releases directory. */
export function isLayoutActive(config) {
  try {
    if (!fs.lstatSync(config.webroot).isSymbolicLink()) return false;
    return fs.realpathSync(config.webroot).startsWith(fs.realpathSync(config.releasesDir) + path.sep);
  } catch {
    return false;
  }
}

export function listReleases(config) {
  const p = releasePaths(config);
  const current = currentReleaseId(config);
  const state = readJson(p.state, {});
  let names = [];
  try {
    names = fs.readdirSync(p.dir).filter((n) => RELEASE_ID_RE.test(n) && fs.statSync(path.join(p.dir, n)).isDirectory());
  } catch {
    names = [];
  }
  return names.sort().map((id) => ({ id, current: id === current, previous: id === state.previous, manifest: readJson(path.join(p.dir, `${id}.json`), null) }));
}

function runNode(script, args, { cwd, env, timeoutMs = 300_000 }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const add = (c) => {
      out += c;
      if (out.length > 400_000) out = out.slice(-200_000);
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, out });
    });
  });
}

async function symlinkFresh(target, linkPath) {
  await fsp.rm(linkPath, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(linkPath), { recursive: true });
  await fsp.symlink(target, linkPath);
}

/**
 * Build and verify a release from one database file. Does NOT make it live.
 * @param {object} config
 * @param {{ dbPath: string, doc: object, reason: string, commit?: string|null, lockToken?: string|null, meta?: object, log?: Function }} input
 *        doc = exportListingsDocument() of dbPath (what the release must show)
 */
export async function buildRelease(config, { dbPath, doc, reason, commit = null, lockToken = null, buildDate = null, meta = {}, log = () => {} }) {
  const p = releasePaths(config);
  await fsp.mkdir(p.dir, { recursive: true });
  const id = `${utcStamp()}-${randomBytes(3).toString("hex")}`;
  const staging = path.join(p.dir, `${id}.staging`);
  const fail = async (code, message, extra = {}) => {
    const kept = path.join(p.dir, `${id}.failed`);
    // keep only the newest failed build for diagnosis – a failure that repeats every run must not fill the disk
    for (const n of await fsp.readdir(p.dir).catch(() => [])) if (n.endsWith(".failed")) await fsp.rm(path.join(p.dir, n), { recursive: true, force: true });
    await fsp.rm(kept, { recursive: true, force: true });
    await fsp.rename(staging, kept).catch(() => fsp.rm(staging, { recursive: true, force: true }));
    throw new ReleaseError(code, message, { releaseId: id, keptAt: kept, ...extra });
  };

  // 1. private copy of the app tree (templates, assets, code of this revision)
  await fsp.cp(config.appDir, staging, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (src) => {
      const rel = path.relative(config.appDir, src);
      if (!rel) return true;
      const top = rel.split(path.sep)[0];
      if (COPY_EXCLUDE.has(top)) return false;
      if (rel === path.join(".well-known", "acme-challenge")) return false;
      return true;
    },
  });
  await fsp.mkdir(path.join(config.mediaDir, "eigen"), { recursive: true });
  await symlinkFresh(config.mediaDir, path.join(staging, "media"));
  const appModules = path.join(config.appDir, "node_modules");
  if (fs.existsSync(appModules)) await symlinkFresh(appModules, path.join(staging, "node_modules"));
  // the build must not read a stale repo mirror as if it were data
  await fsp.rm(path.join(staging, "data", "listings.json"), { force: true });

  // 2. build with the staged code, from the given database only
  const env = {
    ...process.env,
    EICHMANN_DB_PATH: dbPath,
    EICHMANN_SITE_ROOT: staging,
    EICHMANN_RELEASE_BUILD: "1",
    EICHMANN_RELEASE_ID: id,
    EICHMANN_BUILD_COMMIT: commit || readDeployCommit(config) || "",
    ...(buildDate ? { EICHMANN_BUILD_DATE: buildDate } : {}),
    ...(lockToken ? { EICHMANN_LOCK_TOKEN: lockToken } : {}),
  };
  const built = await runNode(path.join(staging, "scripts", "build.mjs"), [], { cwd: staging, env });
  if (built.code !== 0) {
    const tail = built.out.split("\n").filter((l) => l.trim() && !/ExperimentalWarning|trace-warnings/.test(l)).slice(-25).join("\n");
    log(tail);
    await fail("release_build_failed", `Build des Releases fehlgeschlagen (Exit ${built.code ?? built.signal}).`, { buildLog: tail });
  }

  // 3. the data mirror in the release holds public offers only (retired ones stay in the database, not on the web server)
  const mirror = path.join(staging, "data", "listings.json");
  try {
    const m = JSON.parse(await fsp.readFile(mirror, "utf8"));
    m.listings = (m.listings || []).filter((L) => L.active !== false && L.site_hidden !== true);
    m.listing_count = m.listings.length;
    await fsp.writeFile(mirror, `${JSON.stringify(m, null, 2)}\n`);
  } catch {
    /* no mirror written by this build */
  }

  // strip build-only files, wire the persistent parts
  for (const name of BUILD_ONLY) await fsp.rm(path.join(staging, name), { recursive: true, force: true });
  await fsp.mkdir(path.dirname(config.statusFile), { recursive: true });
  await symlinkFresh(config.statusFile, path.join(staging, "data", "immowelt-sync-status.json"));
  if (fs.existsSync(config.adminConfigFile)) await symlinkFresh(config.adminConfigFile, path.join(staging, "admin", "config.json"));
  await fsp.mkdir(config.acmeDir, { recursive: true });
  await symlinkFresh(config.acmeDir, path.join(staging, ".well-known", "acme-challenge"));

  // 4. gate
  const verdict = verifyRelease(staging, doc, { releaseId: id });
  if (!verdict.ok) {
    log(verdict.problems.slice(0, 30).join("\n"));
    await fail("release_verify_failed", `Release-Prüfung fehlgeschlagen: ${verdict.problems.length} Abweichung(en), z. B. ${verdict.problems[0]}`, { problems: verdict.problems });
  }

  // 5. finalize (still not live)
  const dir = path.join(p.dir, id);
  await fsp.rename(staging, dir);
  const manifest = {
    schema: "eichmann.release/v1",
    id,
    built_at: new Date().toISOString(),
    reason,
    commit: env.EICHMANN_BUILD_COMMIT || null,
    summary: verdict.summary,
    data: { immowelt_fingerprint: doc.immowelt_fingerprint || null, immowelt_checked_date: doc.immowelt_checked_date || null, listing_count: doc.listing_count, active_listing_count: doc.active_listing_count },
    media: [...mediaFilesOf(doc.listings)].sort(),
    ...meta,
  };
  writeJson(path.join(p.dir, `${id}.json`), manifest);
  return { id, dir, manifest };
}

export function readDeployCommit(config) {
  try {
    return fs.readFileSync(path.join(config.appDir, ".deploy-commit"), "utf8").trim().slice(0, 40) || null;
  } catch {
    return null;
  }
}

function switchCurrent(config, id) {
  const p = releasePaths(config);
  if (!RELEASE_ID_RE.test(id) || !fs.existsSync(path.join(p.dir, id, "index.html"))) throw new ReleaseError("release_missing", `Release ${id} existiert nicht.`);
  const tmp = path.join(p.dir, `current.tmp-${process.pid}`);
  fs.rmSync(tmp, { force: true });
  fs.symlinkSync(id, tmp); // relative target: the releases directory can be moved as a whole
  fs.renameSync(tmp, p.current); // atomic: visitors see the old or the new tree, never a mix being written
  try {
    const fd = fs.openSync(p.dir, "r");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  } catch {
    /* fsync of a directory is best effort */
  }
}

async function smoke(config, id, { fetchImpl = globalThis.fetch } = {}) {
  if (!config.smokeUrl || !isLayoutActive(config)) return { skipped: true };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchImpl(config.smokeUrl, { headers: { "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const body = await res.json();
        if (body?.release_id === id) return { ok: true };
        return { ok: false, reason: `Webserver liefert Release ${body?.release_id || "?"} statt ${id}` };
      }
      if (attempt === 2) return { ok: false, reason: `Webserver antwortet mit HTTP ${res.status}` };
    } catch (err) {
      if (attempt === 2) return { ok: false, reason: `Webserver nicht erreichbar (${err?.name || "Fehler"})` };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false, reason: "unbekannt" };
}

/**
 * Make a verified release live. If the web server does not serve it afterwards, the previous
 * release is switched back in and the call fails.
 */
export async function activateRelease(config, id, { reason = "publish", fetchImpl } = {}) {
  const p = releasePaths(config);
  const before = currentReleaseId(config);
  if (before === id) return { id, previous: readJson(p.state, {}).previous || null, unchanged: true };
  switchCurrent(config, id);
  const check = await smoke(config, id, { fetchImpl });
  if (check.ok === false) {
    if (before) switchCurrent(config, before);
    throw new ReleaseError("release_smoke_failed", `Release ${id} wurde zurückgenommen: ${check.reason}.`, { releaseId: id, restored: before });
  }
  const state = readJson(p.state, { history: [] });
  const history = [{ id, activated_at: new Date().toISOString(), reason, from: before }, ...(state.history || [])].slice(0, 50);
  writeJson(p.state, { current: id, previous: before, history });
  return { id, previous: before, smoke: check };
}

/** Switch back to the previous (or a named) release. Data rollback is separate, see immowelt-sync.mjs rollback. */
export async function rollbackRelease(config, targetId = null, { fetchImpl } = {}) {
  const p = releasePaths(config);
  const state = readJson(p.state, {});
  const target = targetId || state.previous;
  if (!target) throw new ReleaseError("release_missing", "Kein früheres Release vorhanden.");
  return activateRelease(config, target, { reason: "rollback", fetchImpl });
}

/** Keep current, previous and the newest N; remove the rest and old staging/failed directories. */
export async function gcReleases(config, { now = Date.now() } = {}) {
  const p = releasePaths(config);
  const state = readJson(p.state, {});
  const all = listReleases(config).map((r) => r.id);
  const keep = new Set([currentReleaseId(config), state.previous, ...all.slice(-config.keepReleases)].filter(Boolean));
  const removed = [];
  for (const id of all) {
    if (keep.has(id)) continue;
    await fsp.rm(path.join(p.dir, id), { recursive: true, force: true });
    await fsp.rm(path.join(p.dir, `${id}.json`), { force: true });
    removed.push(id);
  }
  for (const name of await fsp.readdir(p.dir).catch(() => [])) {
    if (!/\.(staging|failed)$/.test(name)) continue;
    const st = await fsp.stat(path.join(p.dir, name)).catch(() => null);
    const maxAgeMin = name.endsWith(".failed") ? 3 * 24 * 60 : 60;
    if (st && (now - st.mtimeMs) / 60000 > maxAgeMin) await fsp.rm(path.join(p.dir, name), { recursive: true, force: true });
  }
  const media = new Set();
  for (const id of keep) for (const f of readJson(path.join(p.dir, `${id}.json`), {})?.media || []) media.add(f);
  return { kept: [...keep], removed, media };
}

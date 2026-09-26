/**
 * App snapshots (Stufe A) for Immobilien Eichmann.
 *
 * Layout: /var/lib/eichmann/snapshots/YYYYMMDD-HHMM/
 *   listings.db              – SQLite online backup
 *   media/eigen/             – Eigen image tree
 *   immowelt-sync-status.json
 *   admin-config.json        – admin/config.json (no session secret)
 *   manifest.json
 *
 * NEVER packages admin-session.secret.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { resolveDbPath, REPO_ROOT } from "./db.mjs";

export const SNAPSHOTS_ROOT =
  process.env.EICHMANN_SNAPSHOTS_DIR || "/var/lib/eichmann/snapshots";
export const RETENTION = Math.max(
  1,
  Number(process.env.EICHMANN_SNAPSHOT_RETENTION || 14)
);
export const RESTORE_PHRASE = "RESTAURIEREN";
const DEPLOY_REF = "/root/.eichmann-deploy-ref";
const TZ = "Europe/Berlin";

function siteRoot() {
  if (process.env.EICHMANN_SITE_ROOT) {
    return path.resolve(process.env.EICHMANN_SITE_ROOT);
  }
  if (fs.existsSync("/var/www/immobilieneichmann.de")) {
    return "/var/www/immobilieneichmann.de";
  }
  return REPO_ROOT;
}

function berlinParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "shortOffset",
  });
  const parts = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  return parts;
}

/** Folder id: YYYYMMDD-HHMM in Europe/Berlin. */
export function berlinSnapshotId(date = new Date()) {
  const p = berlinParts(date);
  return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}`;
}

export function berlinIso(date = new Date()) {
  const p = berlinParts(date);
  // en-GB shortOffset: "GMT+2" or "GMT+02:00"
  let off = String(p.timeZoneName || "GMT+2").replace(/^GMT/i, "");
  if (!off || off === "Z") off = "+00:00";
  if (/^[+-]\d$/.test(off)) off = `${off[0]}0${off.slice(1)}:00`;
  else if (/^[+-]\d{2}$/.test(off)) off = `${off}:00`;
  else if (!/^[+-]\d{2}:\d{2}$/.test(off)) {
    // last resort: format via toLocaleString offset
    off = "+02:00";
  }
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${off}`;
}

/** Strict snapshot folder id: YYYYMMDD-HHMM or YYYYMMDD-HHMM-N */
export function assertSafeSnapshotId(id) {
  const s = String(id || "").trim();
  if (!/^\d{8}-\d{4}(-\d+)?$/.test(s)) {
    const err = new Error("Ungültige Sicherungs-ID");
    err.status = 400;
    throw err;
  }
  return s;
}

/** Resolve snapshot directory under SNAPSHOTS_ROOT; blocks path traversal. */
export function resolveSnapshotDir(id) {
  const safe = assertSafeSnapshotId(id);
  const root = path.resolve(SNAPSHOTS_ROOT);
  const dir = path.resolve(root, safe);
  const rel = path.relative(root, dir);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    const err = new Error("Ungültige Sicherungs-ID");
    err.status = 400;
    throw err;
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    const err = new Error(`Sicherung „${safe}“ nicht gefunden`);
    err.status = 404;
    throw err;
  }
  return dir;
}

const DOWNLOAD_EXCLUDES = [
  "admin-session.secret",
  ".env",
  "credentials",
  "*.pem",
  "*secret*",
  "*.key",
];

/**
 * Stream a .tar.gz of the snapshot directory onto an HTTP ServerResponse.
 * Excludes session secrets / env / credential files if somehow present.
 * Returns a Promise that resolves when the stream finishes.
 */
export function streamSnapshotDownload(id, res) {
  const safe = assertSafeSnapshotId(id);
  const dir = resolveSnapshotDir(safe);
  const parent = path.dirname(dir);
  const base = path.basename(dir);
  const filename = `eichmann-sicherung-${safe}.tar.gz`;

  const args = ["-C", parent, "-czf", "-", "--ignore-failed-read"];
  for (const ex of DOWNLOAD_EXCLUDES) {
    args.push(`--exclude=${ex}`);
  }
  args.push(base);

  res.writeHead(200, {
    "Content-Type": "application/gzip",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });

  const child = spawn("tar", args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 2000) stderr = stderr.slice(-2000);
    });
    child.stdout.pipe(res);
    child.on("error", (e) => {
      try {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "Archiv konnte nicht erzeugt werden" }));
        } else {
          res.destroy(e);
        }
      } catch {
        /* ignore */
      }
      reject(e);
    });
    child.on("close", (code) => {
      if (code !== 0 && !res.writableEnded) {
        try {
          res.destroy();
        } catch {
          /* ignore */
        }
        const err = new Error(
          `Archiv fehlgeschlagen${stderr ? ": " + stderr.slice(0, 200) : ""}`
        );
        err.status = 500;
        reject(err);
        return;
      }
      resolve({ ok: true, id: safe, filename });
    });
    res.on("close", () => {
      if (!child.killed) {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }
    });
  });
}

function readDeployCommit() {
  try {
    if (!fs.existsSync(DEPLOY_REF)) return null;
    const raw = fs.readFileSync(DEPLOY_REF, "utf8");
    const m = raw.match(/DEPLOYED_COMMIT=([0-9a-fA-F]+)/);
    return m ? m[1] : raw.trim() || null;
  } catch {
    return null;
  }
}

function fileBytes(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

function dirBytes(root) {
  let total = 0;
  if (!fs.existsSync(root)) return 0;
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile()) total += fileBytes(full);
    }
  };
  walk(root);
  return total;
}

function fsyncPath(p) {
  try {
    const fd = fs.openSync(p, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* ignore — some FS don't support fsync on dirs the same way */
  }
}

function fsyncParent(filePath) {
  fsyncPath(path.dirname(filePath));
}

function copyFileAtomic(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.__tmp_${process.pid}`;
  fs.copyFileSync(src, tmp);
  const fd = fs.openSync(tmp, "r+");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, dest);
  fsyncParent(dest);
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  if (!fs.existsSync(src)) return;
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (ent.isDirectory()) copyTree(from, to);
    else if (ent.isFile()) copyFileAtomic(from, to);
  }
}

async function sqliteOnlineBackup(srcDbPath, destDbPath) {
  fs.mkdirSync(path.dirname(destDbPath), { recursive: true });
  const tmp = `${destDbPath}.__bak_${process.pid}`;
  rmrf(tmp);
  // Prefer sqlite3 CLI online .backup when available
  const cli = spawnSync(
    "sqlite3",
    [srcDbPath, `.backup '${tmp.replace(/'/g, "''")}'`],
    { encoding: "utf8", timeout: 120_000 }
  );
  if (cli.status !== 0 || !fs.existsSync(tmp)) {
    // Fallback: better-sqlite3 backup API (Promise)
    const src = new Database(srcDbPath, { readonly: true, fileMustExist: true });
    try {
      await src.backup(tmp);
    } finally {
      src.close();
    }
  }
  if (!fs.existsSync(tmp)) {
    throw new Error("SQLite-Sicherung fehlgeschlagen");
  }
  const fd = fs.openSync(tmp, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, destDbPath);
  fsyncParent(destDbPath);
  return fileBytes(destDbPath);
}

function uniqueSnapshotId(baseId) {
  let id = baseId;
  let n = 2;
  while (fs.existsSync(path.join(SNAPSHOTS_ROOT, id))) {
    id = `${baseId}-${n}`;
    n += 1;
  }
  return id;
}

export function listSnapshots() {
  if (!fs.existsSync(SNAPSHOTS_ROOT)) return [];
  const ids = fs
    .readdirSync(SNAPSHOTS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => /^\d{8}-\d{4}/.test(name))
    .sort()
    .reverse();
  return ids.map((id) => readManifest(id)).filter(Boolean);
}

export function readManifest(id) {
  let safe;
  try {
    safe = assertSafeSnapshotId(id);
  } catch {
    return null;
  }
  const dir = path.join(SNAPSHOTS_ROOT, safe);
  const manPath = path.join(dir, "manifest.json");
  if (!fs.existsSync(manPath)) {
    if (!fs.existsSync(dir)) return null;
    // Minimal fallback if legacy folder without manifest
    return {
      id: safe,
      created_at: null,
      timezone: TZ,
      deploy_commit: null,
      parts: {},
      total_bytes: dirBytes(dir),
      path: dir,
    };
  }
  try {
    const man = JSON.parse(fs.readFileSync(manPath, "utf8"));
    return { ...man, path: dir };
  } catch {
    return null;
  }
}

export function pruneSnapshots(keep = RETENTION) {
  const all = listSnapshots();
  const drop = all.slice(keep);
  const removed = [];
  for (const s of drop) {
    const dir = path.join(SNAPSHOTS_ROOT, s.id);
    rmrf(dir);
    removed.push(s.id);
  }
  return { kept: all.slice(0, keep).map((s) => s.id), removed };
}

/**
 * Create a new snapshot. Returns manifest.
 */
export async function createSnapshot({ reason = "manual" } = {}) {
  const site = siteRoot();
  const dbPath = resolveDbPath();
  if (!fs.existsSync(dbPath)) {
    const err = new Error(`Datenbank nicht gefunden: ${dbPath}`);
    err.status = 500;
    throw err;
  }

  fs.mkdirSync(SNAPSHOTS_ROOT, { recursive: true, mode: 0o755 });
  const id = uniqueSnapshotId(berlinSnapshotId());
  const dir = path.join(SNAPSHOTS_ROOT, id);
  const staging = `${dir}.__staging_${process.pid}`;
  rmrf(staging);
  fs.mkdirSync(staging, { recursive: true });

  try {
    const dbDest = path.join(staging, "listings.db");
    const dbBytes = await sqliteOnlineBackup(dbPath, dbDest);

    const mediaSrc = path.join(site, "media", "eigen");
    const mediaDest = path.join(staging, "media", "eigen");
    copyTree(mediaSrc, mediaDest);
    const mediaBytes = dirBytes(mediaDest);

    const syncSrc = path.join(site, "data", "immowelt-sync-status.json");
    const syncDest = path.join(staging, "immowelt-sync-status.json");
    let syncBytes = 0;
    if (fs.existsSync(syncSrc)) {
      copyFileAtomic(syncSrc, syncDest);
      syncBytes = fileBytes(syncDest);
    } else {
      fs.writeFileSync(syncDest, "{}\n", "utf8");
      syncBytes = fileBytes(syncDest);
    }

    const configSrc =
      process.env.EICHMANN_ADMIN_CONFIG || path.join(site, "admin", "config.json");
    const configDest = path.join(staging, "admin-config.json");
    let configBytes = 0;
    if (fs.existsSync(configSrc)) {
      copyFileAtomic(configSrc, configDest);
      configBytes = fileBytes(configDest);
    }

    // Explicitly never package session secret
    const secretProbe = path.join(staging, "admin-session.secret");
    if (fs.existsSync(secretProbe)) rmrf(secretProbe);

    const parts = {
      "listings.db": { bytes: dbBytes },
      "media/eigen": { bytes: mediaBytes },
      "immowelt-sync-status.json": { bytes: syncBytes },
      "admin-config.json": { bytes: configBytes },
    };
    const total_bytes = Object.values(parts).reduce((a, p) => a + (p.bytes || 0), 0);
    const created = new Date();
    const manifest = {
      id,
      created_at: berlinIso(created),
      timezone: TZ,
      deploy_commit: readDeployCommit(),
      reason,
      parts,
      total_bytes,
      includes_session_secret: false,
    };
    fs.writeFileSync(
      path.join(staging, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      "utf8"
    );
    fsyncPath(path.join(staging, "manifest.json"));

    fs.renameSync(staging, dir);
    fsyncParent(dir);

    pruneSnapshots(RETENTION);
    return readManifest(id);
  } catch (e) {
    rmrf(staging);
    throw e;
  }
}

/** Human-readable overwrite list for restore confirm UI (no secrets/hashes). */
export function restoreOverwriteList(id) {
  const safeId = assertSafeSnapshotId(id);
  const man = readManifest(safeId);
  if (!man) {
    const err = new Error(`Sicherung „${safeId}“ nicht gefunden`);
    err.status = 404;
    throw err;
  }
  const site = siteRoot();
  const items = [
    {
      key: "listings.db",
      label: "Inserate-Datenbank",
      detail: "Alle Immowelt- und Eigen-Inserate werden durch den Stand der Sicherung ersetzt.",
      bytes: man.parts?.["listings.db"]?.bytes ?? null,
    },
    {
      key: "media/eigen",
      label: "Eigen-Bilder",
      detail: `Ordner ${path.join(site, "media", "eigen")} wird ersetzt.`,
      bytes: man.parts?.["media/eigen"]?.bytes ?? null,
    },
    {
      key: "immowelt-sync-status.json",
      label: "Immowelt-Sync-Status",
      detail: "Zuletzt bekannter Sync-Stand wird zurückgesetzt.",
      bytes: man.parts?.["immowelt-sync-status.json"]?.bytes ?? null,
    },
    {
      key: "admin-config.json",
      label: "Admin-Einstellungen",
      detail: "Anmelde-Einstellungen (E-Mail-Freigaben) werden zurückgesetzt. Geheimnisse werden nicht angezeigt.",
      bytes: man.parts?.["admin-config.json"]?.bytes ?? null,
    },
    {
      key: "publish",
      label: "Website neu erzeugen",
      detail: "Nach dem Zurückspielen wird die öffentliche Website aus der Datenbank neu gebaut.",
      bytes: null,
    },
    {
      key: "api-restart",
      label: "Admin-Dienst neu starten",
      detail: "Der Admin-Dienst wird kurz neu gestartet.",
      bytes: null,
    },
  ];
  return {
    id: man.id,
    created_at: man.created_at,
    deploy_commit: man.deploy_commit,
    total_bytes: man.total_bytes,
    confirm_phrase: RESTORE_PHRASE,
    overwrite: items,
  };
}

function swapDir(livePath, incomingPath) {
  const parent = path.dirname(livePath);
  const base = path.basename(livePath);
  const oldPath = path.join(parent, `${base}.__old_${process.pid}`);
  rmrf(oldPath);
  if (fs.existsSync(livePath)) {
    fs.renameSync(livePath, oldPath);
  }
  fs.renameSync(incomingPath, livePath);
  fsyncParent(livePath);
  rmrf(oldPath);
}

function swapFile(livePath, incomingPath) {
  const parent = path.dirname(livePath);
  const base = path.basename(livePath);
  const oldPath = path.join(parent, `${base}.__old_${process.pid}`);
  // Drop WAL/SHM beside live DB so we don't mix journals
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const side = `${livePath}${suffix}`;
    if (fs.existsSync(side)) rmrf(side);
  }
  if (fs.existsSync(livePath)) {
    fs.renameSync(livePath, oldPath);
  }
  fs.renameSync(incomingPath, livePath);
  fsyncParent(livePath);
  rmrf(oldPath);
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const side = `${oldPath}${suffix}`;
    if (fs.existsSync(side)) rmrf(side);
  }
}

function runPublishFromDb() {
  const appRoot = fs.existsSync("/var/lib/eichmann/app/scripts/publish-from-db.mjs")
    ? "/var/lib/eichmann/app"
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const script = path.join(appRoot, "scripts", "publish-from-db.mjs");
  const env = {
    ...process.env,
    EICHMANN_DB_PATH: resolveDbPath(),
    EICHMANN_SITE_ROOT: siteRoot(),
  };
  const r = spawnSync(process.execPath, [script], {
    cwd: appRoot,
    env,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (r.status !== 0) {
    const err = new Error(
      `Website neu erzeugen fehlgeschlagen: ${(r.stderr || r.stdout || "").slice(-500)}`
    );
    err.status = 500;
    throw err;
  }
  return { ok: true, out: (r.stdout || "").trim().slice(-400) };
}

export function scheduleApiRestart() {
  // Delay restart so the HTTP response can flush; run outside the API cgroup.
  const unit = `eichmann-snapshot-restart-${Date.now()}`;
  const r = spawnSync(
    "systemd-run",
    [
      `--unit=${unit}`,
      "--collect",
      "--on-active=3s",
      "--timer-property=AccuracySec=1s",
      "/bin/systemctl",
      "restart",
      "eichmann-admin-api.service",
    ],
    { encoding: "utf8", timeout: 15_000 }
  );
  if (r.status !== 0) {
    spawnSync(
      "bash",
      [
        "-c",
        "nohup bash -c 'sleep 3; systemctl restart eichmann-admin-api.service' >/dev/null 2>&1 &",
      ],
      { encoding: "utf8", timeout: 5_000 }
    );
    return {
      ok: true,
      unit: null,
      fallback: true,
      stderr: (r.stderr || "").slice(0, 300),
    };
  }
  return { ok: true, unit };
}

/**
 * Atomic restore: stage → fsync → swap DB+media+config+status → publish → schedule API restart.
 * Does NOT include or overwrite admin-session.secret.
 */
export async function restoreSnapshot(id, { confirmPhrase, scheduleRestart = true } = {}) {
  const safeId = assertSafeSnapshotId(id);
  if (String(confirmPhrase || "").trim() !== RESTORE_PHRASE) {
    const err = new Error(
      `Bitte zur Bestätigung genau „${RESTORE_PHRASE}“ eingeben.`
    );
    err.status = 400;
    throw err;
  }
  const man = readManifest(safeId);
  if (!man) {
    const err = new Error(`Sicherung „${safeId}“ nicht gefunden`);
    err.status = 404;
    throw err;
  }
  const snapDir = resolveSnapshotDir(safeId);
  id = safeId;
  const site = siteRoot();
  const dbPath = resolveDbPath();
  const stagingRoot = path.join(SNAPSHOTS_ROOT, `.__restore_${id}_${process.pid}`);
  rmrf(stagingRoot);
  fs.mkdirSync(stagingRoot, { recursive: true });

  try {
    const snapDb = path.join(snapDir, "listings.db");
    if (!fs.existsSync(snapDb)) {
      const err = new Error("Sicherung enthält keine Datenbank");
      err.status = 500;
      throw err;
    }
    const stagedDb = path.join(stagingRoot, "listings.db");
    // Re-backup from snapshot file to get a clean single-file DB
    await sqliteOnlineBackup(snapDb, stagedDb);

    const stagedMedia = path.join(stagingRoot, "media", "eigen");
    copyTree(path.join(snapDir, "media", "eigen"), stagedMedia);

    const snapSync = path.join(snapDir, "immowelt-sync-status.json");
    const stagedSync = path.join(stagingRoot, "immowelt-sync-status.json");
    if (fs.existsSync(snapSync)) copyFileAtomic(snapSync, stagedSync);

    const snapCfg = path.join(snapDir, "admin-config.json");
    const stagedCfg = path.join(stagingRoot, "admin-config.json");
    if (fs.existsSync(snapCfg)) copyFileAtomic(snapCfg, stagedCfg);

    // --- swap into live paths ---
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    swapFile(dbPath, stagedDb);

    const liveMedia = path.join(site, "media", "eigen");
    fs.mkdirSync(path.dirname(liveMedia), { recursive: true });
    // Stage media next to live, then swap
    const mediaIncoming = path.join(site, "media", `eigen.__incoming_${process.pid}`);
    rmrf(mediaIncoming);
    copyTree(stagedMedia, mediaIncoming);
    swapDir(liveMedia, mediaIncoming);
    try {
      // Match install-admin-api ownership
      spawnSync("chown", ["-R", "www-data:www-data", path.join(site, "media")], {
        timeout: 30_000,
      });
    } catch {
      /* ignore */
    }

    const liveSync = path.join(site, "data", "immowelt-sync-status.json");
    if (fs.existsSync(stagedSync)) {
      fs.mkdirSync(path.dirname(liveSync), { recursive: true });
      const syncIncoming = `${liveSync}.__incoming_${process.pid}`;
      copyFileAtomic(stagedSync, syncIncoming);
      swapFile(liveSync, syncIncoming);
    }

    const liveCfg =
      process.env.EICHMANN_ADMIN_CONFIG || path.join(site, "admin", "config.json");
    if (fs.existsSync(stagedCfg)) {
      fs.mkdirSync(path.dirname(liveCfg), { recursive: true });
      const cfgIncoming = `${liveCfg}.__incoming_${process.pid}`;
      copyFileAtomic(stagedCfg, cfgIncoming);
      swapFile(liveCfg, cfgIncoming);
    }

    const published = runPublishFromDb();

    rmrf(stagingRoot);

    let restart = null;
    if (scheduleRestart) {
      restart = scheduleApiRestart();
    }

    return {
      ok: true,
      id,
      restored_at: berlinIso(),
      published,
      restart,
      overwrite: restoreOverwriteList(id).overwrite,
    };
  } catch (e) {
    rmrf(stagingRoot);
    throw e;
  }
}

export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / (1024 * 1024)).toFixed(2)} MB`;
}

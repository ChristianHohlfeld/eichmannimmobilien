/**
 * One place for every path and tunable of the Immowelt → website pipeline.
 * All values have production defaults; tests and local runs override via environment.
 *
 * Environment variables that hold a PATH end in _DIR / _FILE / _PATH.
 * IMMOWELT_API_KEY is the only variable that holds the key VALUE (CI probe only);
 * on the droplet the key is read from IMMOWELT_SECRETS_FILE (default below).
 */
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT, resolveDbPath } from "../db.mjs";

const int = (v, d) => (v != null && /^\d+$/.test(String(v).trim()) ? Number(v) : d);
const list = (v, d) => (v ? String(v).split(",").map((s) => s.trim()).filter(Boolean) : d);

export const DEFAULT_PROFILE_GUID = "3b18336c6a2e401da38e9cc20268270d";

/**
 * Tunables that may be set in the server's settings file <state>/sync.env (KEY=VALUE, no secrets).
 * Everything that changes WHAT is published (address mode, picture size, GeoIDs …) is read from
 * there by every entry point – timer, SSH/ops, admin button, deploy – so that two ways of starting
 * a run can never publish two different renderings of the same Immowelt state.
 * The API key is deliberately not in this list: it is never read from the settings file.
 */
export const SETTING_KEYS = new Set([
  "IMMOWELT_GEO_IDS", "IMMOWELT_PAGE_SIZE", "IMMOWELT_LIST_SORT", "IMMOWELT_PROFILE_GUID",
  "IMMOWELT_TIMEOUT_MS", "IMMOWELT_RETRIES", "IMMOWELT_BACKOFF_MS", "IMMOWELT_EXPOSE_DELAY_MS",
  "IMMOWELT_ADDRESS_MODE", "IMMOWELT_IMAGE_HOSTS", "IMMOWELT_IMAGE_SIZE", "IMMOWELT_IMAGE_REVALIDATE_HOURS",
  "IMMOWELT_IMAGE_TIMEOUT_MS", "IMMOWELT_IMAGE_MAX_BYTES", "IMMOWELT_IMAGE_CONCURRENCY",
  "IMMOWELT_CONFIRM_MIN_MINUTES", "IMMOWELT_CONFIRM_MIN_REMOVED", "IMMOWELT_STALE_AFTER_MINUTES",
  "EICHMANN_LOCK_STALE_MINUTES", "EICHMANN_KEEP_RELEASES", "EICHMANN_KEEP_DB_BACKUPS", "EICHMANN_KEEP_RUNS",
  "EICHMANN_SMOKE_URL",
]);

/** Parse KEY=VALUE lines (comments and unknown keys ignored; an empty value is a value). */
export function readSettingsFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || !SETTING_KEYS.has(m[1])) continue;
    out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

export function loadConfig(processEnv = process.env) {
  const stateDir = path.resolve(processEnv.EICHMANN_STATE_DIR || "/var/lib/eichmann");
  const settingsFile = path.resolve(processEnv.EICHMANN_SETTINGS_FILE || path.join(stateDir, "sync.env"));
  // The environment wins over the file (systemd loads the same file; tests set values directly).
  const env = { ...readSettingsFile(settingsFile), ...processEnv };
  const immoweltDir = path.join(stateDir, "immowelt");
  const addressMode = env.IMMOWELT_ADDRESS_MODE === "street" ? "street" : "locality";
  return {
    appDir: path.resolve(env.EICHMANN_APP_DIR || REPO_ROOT),
    stateDir,
    settingsFile,
    dbPath: env.EICHMANN_DB_PATH ? path.resolve(env.EICHMANN_DB_PATH) : resolveDbPath(),
    webroot: path.resolve(env.EICHMANN_WEBROOT || "/var/www/immobilieneichmann.de"),
    releasesDir: path.resolve(env.EICHMANN_RELEASES_DIR || path.join(stateDir, "releases")),
    mediaDir: path.resolve(env.EICHMANN_MEDIA_DIR || path.join(stateDir, "media")),
    statusFile: path.resolve(env.EICHMANN_STATUS_FILE || path.join(stateDir, "status", "immowelt-sync-status.json")),
    lockDir: path.resolve(env.EICHMANN_LOCK_DIR || path.join(stateDir, "locks")),
    adminConfigFile: path.resolve(env.EICHMANN_ADMIN_CONFIG_STORE || path.join(stateDir, "admin-config.json")),
    acmeDir: path.resolve(env.EICHMANN_ACME_DIR || path.join(stateDir, "acme-challenge")),
    alarmFile: path.resolve(env.EICHMANN_ALARM_FILE || path.join(stateDir, "secrets", "alarm.json")),
    immoweltDir,
    snapshotsDir: path.join(immoweltDir, "snapshots"),
    originalsDir: path.join(immoweltDir, "originals"),
    runsDir: path.join(immoweltDir, "runs"),
    backupsDir: path.join(immoweltDir, "db-backups"),
    mediaIndexFile: path.join(immoweltDir, "media-index.json"),
    identityPlanFile: path.join(immoweltDir, "identity-plan.json"),
    identityMapFile: path.resolve(env.EICHMANN_IDENTITY_MAP_FILE || path.join(env.EICHMANN_APP_DIR || REPO_ROOT, "data", "sot", "immowelt-identity-map.json")),

    // Immowelt API
    geoIds: list(env.IMMOWELT_GEO_IDS, ["108"]).map(Number),
    pageSize: int(env.IMMOWELT_PAGE_SIZE, 50),
    listSort: env.IMMOWELT_LIST_SORT || "createdatedesc",
    profileGuid: env.IMMOWELT_PROFILE_GUID === "" ? null : env.IMMOWELT_PROFILE_GUID || DEFAULT_PROFILE_GUID,
    soap: { timeoutMs: int(env.IMMOWELT_TIMEOUT_MS, 30_000), retries: int(env.IMMOWELT_RETRIES, 3), backoffMs: int(env.IMMOWELT_BACKOFF_MS, 1_500) },
    exposeDelayMs: int(env.IMMOWELT_EXPOSE_DELAY_MS, 250),
    addressMode,

    // media
    allowedImageHosts: list(env.IMMOWELT_IMAGE_HOSTS, ["immowelt.org", "immowelt.de", "immowelt.com", "immowelt.net"]),
    imageSize: /^\d{2,4}x\d{1,4}$/.test(env.IMMOWELT_IMAGE_SIZE || "") ? env.IMMOWELT_IMAGE_SIZE : null,
    imageRevalidateHours: int(env.IMMOWELT_IMAGE_REVALIDATE_HOURS, 24),
    imageTimeoutMs: int(env.IMMOWELT_IMAGE_TIMEOUT_MS, 30_000),
    imageMaxBytes: int(env.IMMOWELT_IMAGE_MAX_BYTES, 25 * 1024 * 1024),
    imageConcurrency: Math.max(1, Math.min(6, int(env.IMMOWELT_IMAGE_CONCURRENCY, 3))),

    // gates and housekeeping
    confirmMinMinutes: int(env.IMMOWELT_CONFIRM_MIN_MINUTES, 20),
    confirmMinRemoved: int(env.IMMOWELT_CONFIRM_MIN_REMOVED, 3),
    staleAfterMinutes: int(env.IMMOWELT_STALE_AFTER_MINUTES, 120),
    lockStaleMinutes: int(env.EICHMANN_LOCK_STALE_MINUTES, 45),
    keepReleases: Math.max(3, int(env.EICHMANN_KEEP_RELEASES, 6)),
    keepDbBackups: Math.max(3, int(env.EICHMANN_KEEP_DB_BACKUPS, 14)),
    keepRuns: Math.max(5, int(env.EICHMANN_KEEP_RUNS, 40)),
    smokeUrl: env.EICHMANN_SMOKE_URL === "" ? null : env.EICHMANN_SMOKE_URL || "http://127.0.0.1/ai/build.json",
    timeZone: "Europe/Berlin",
  };
}

/** YYYY-MM-DD in Europe/Berlin – the day the website prints as "Stand der Angebote". */
export function berlinDate(date = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" }).format(date);
}

/** Sortable UTC stamp for ids: 20261111T101500Z */
export function utcStamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

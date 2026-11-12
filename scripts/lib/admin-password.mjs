/**
 * Admin password (SHA-256 hex of utf8).
 *
 * Preferred store (droplet-only, never git):
 *   /var/lib/eichmann/secrets/admin-auth.json  (mode 600, dir 700)
 * Override: EICHMANN_ADMIN_AUTH_FILE
 *
 * Fallback: password_sha256 in EICHMANN_ADMIN_CONFIG / admin/config.json
 * (legacy; deploy must not overwrite live config — see deploy-droplet.yml).
 *
 * No plaintext in logs. Session HMAC secret is separate and untouched.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MIN_PASSWORD_LENGTH = 8;

const DEFAULT_SECRETS_DIR = "/var/lib/eichmann/secrets";
const DEFAULT_AUTH_FILE = path.join(DEFAULT_SECRETS_DIR, "admin-auth.json");

export function sha256Hex(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

export function isSha256Hex(value) {
  return /^[0-9a-f]{64}$/.test(String(value || "").toLowerCase());
}

export function adminAuthSecretsPath() {
  return process.env.EICHMANN_ADMIN_AUTH_FILE || DEFAULT_AUTH_FILE;
}

function ensureSecretsDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* ignore on non-unix / tests */
  }
}

function readAuthFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!data || typeof data !== "object") return null;
    return data;
  } catch {
    return null;
  }
}

function readHashFromConfig(configPath) {
  if (!configPath || !fs.existsSync(configPath)) return "";
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const h = String(config.password_sha256 || "").toLowerCase().trim();
    return isSha256Hex(h) ? h : "";
  } catch {
    return "";
  }
}

/**
 * Resolve expected password hash: secrets file first, then config.json fallback.
 * @param {string} [configPath] path to admin/config.json (fallback only)
 * @returns {string} lowercase sha256 hex or ""
 */
export function loadPasswordHash(configPath) {
  const authPath = adminAuthSecretsPath();
  const fromSecrets = readAuthFile(authPath);
  if (fromSecrets) {
    const h = String(fromSecrets.password_sha256 || "").toLowerCase().trim();
    if (isSha256Hex(h)) return h;
  }
  return readHashFromConfig(configPath);
}

/**
 * Validate change-password fields (everyday German errors).
 * @returns {{ ok: true, newHash: string } | { ok: false, status: number, error: string }}
 */
export function validatePasswordChange({
  currentPassword,
  newPassword,
  newPasswordRepeat,
  expectHash,
}) {
  const current = String(currentPassword || "");
  const neu = String(newPassword || "");
  const wieder = String(newPasswordRepeat || "");
  const expect = String(expectHash || "").toLowerCase();

  if (!current || !neu || !wieder) {
    return {
      ok: false,
      status: 400,
      error:
        "Bitte alle drei Felder ausfüllen: aktuelles Passwort, neues Passwort und Wiederholung.",
    };
  }
  if (neu.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      status: 400,
      error: "Das neue Passwort muss mindestens 8 Zeichen haben.",
    };
  }
  if (neu !== wieder) {
    return {
      ok: false,
      status: 400,
      error: "Neues Passwort und Wiederholung stimmen nicht überein.",
    };
  }
  if (!expect || sha256Hex(current) !== expect) {
    return { ok: false, status: 401, error: "Aktuelles Passwort ist falsch." };
  }
  const newHash = sha256Hex(neu);
  if (newHash === expect) {
    return {
      ok: false,
      status: 400,
      error: "Das neue Passwort muss sich vom bisherigen unterscheiden.",
    };
  }
  return { ok: true, newHash };
}

/**
 * Persist password_sha256 to the secrets file (mode 600).
 * Does not write plaintext. Does not touch the session HMAC secret.
 * @param {string} [_configPath] unused; kept for call-site compatibility
 * @param {string} newHash
 * @returns {string} normalized hash
 */
export function savePasswordHash(_configPath, newHash) {
  const hash = String(newHash || "").toLowerCase().trim();
  if (!isSha256Hex(hash)) {
    const err = new Error("Interner Fehler beim Speichern des Passworts.");
    err.status = 500;
    throw err;
  }
  const filePath = adminAuthSecretsPath();
  ensureSecretsDir(filePath);
  const prev = readAuthFile(filePath) || {};
  const payload = {
    ...prev,
    password_sha256: hash,
    updated_at: new Date().toISOString(),
  };
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const body = JSON.stringify(payload, null, 2) + "\n";
  fs.writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    /* ignore */
  }
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* ignore */
  }
  return hash;
}

/**
 * One-shot migrate: if secrets missing but config has a real hash, copy it.
 * Safe to call on every install; never overwrites an existing secrets hash.
 * @returns {{ migrated: boolean, path: string, prefix: string }}
 */
export function migratePasswordHashFromConfig(configPath) {
  const filePath = adminAuthSecretsPath();
  const existing = loadPasswordHash(""); // secrets only (empty config path)
  if (existing) {
    return { migrated: false, path: filePath, prefix: existing.slice(0, 7) };
  }
  const fromConfig = readHashFromConfig(configPath);
  if (!fromConfig) {
    return { migrated: false, path: filePath, prefix: "" };
  }
  savePasswordHash(configPath, fromConfig);
  return { migrated: true, path: filePath, prefix: fromConfig.slice(0, 7) };
}

const normalizeEmail = (e) => String(e || "").trim().toLowerCase();
const cleanEmails = (list) => [...new Set((Array.isArray(list) ? list : []).map(normalizeEmail).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)))];

function readEmailsFromConfig(configPath) {
  if (!configPath || !fs.existsSync(configPath)) return [];
  try {
    return cleanEmails(JSON.parse(fs.readFileSync(configPath, "utf8")).admin_emails);
  } catch {
    return [];
  }
}

/**
 * Who may sign in. Server-only store first (same file as the password hash); the public
 * admin/config.json is only read as long as the list has not been moved yet.
 * @returns {string[]} lowercase addresses; empty = no restriction by address
 */
export function loadAdminEmails(configPath) {
  const fromSecrets = readAuthFile(adminAuthSecretsPath());
  if (fromSecrets && Array.isArray(fromSecrets.admin_emails)) return cleanEmails(fromSecrets.admin_emails);
  return readEmailsFromConfig(configPath);
}

/** Store the list of sign-in addresses in the server-only file (keeps the password hash). */
export function saveAdminEmails(list) {
  const emails = cleanEmails(list);
  const filePath = adminAuthSecretsPath();
  ensureSecretsDir(filePath);
  const prev = readAuthFile(filePath) || {};
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify({ ...prev, admin_emails: emails, updated_at: new Date().toISOString() }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* ignore */
  }
  return emails;
}

/**
 * One-shot: move the sign-in addresses out of the publicly served admin/config.json into the
 * server-only file, then remove them (and the internal note) from the public file.
 * Never overwrites a list that is already stored server-side; the public file is only cleaned
 * after the server-side list has been written and read back identically.
 * @returns {{ moved: boolean, cleaned: boolean, count: number }}
 */
export function migrateAdminEmailsFromConfig(configPath) {
  const stored = readAuthFile(adminAuthSecretsPath());
  const hasStored = Boolean(stored && Array.isArray(stored.admin_emails));
  const fromConfig = readEmailsFromConfig(configPath);
  let moved = false;
  if (!hasStored && fromConfig.length) {
    saveAdminEmails(fromConfig);
    moved = true;
  }
  const now = readAuthFile(adminAuthSecretsPath());
  const safe = Boolean(now && Array.isArray(now.admin_emails)) && (!moved || JSON.stringify(cleanEmails(now.admin_emails)) === JSON.stringify(fromConfig));
  let cleaned = false;
  if (safe && configPath && fs.existsSync(configPath)) {
    try {
      const real = fs.realpathSync(configPath);
      const config = JSON.parse(fs.readFileSync(real, "utf8"));
      if ("admin_emails" in config || "note" in config) {
        delete config.admin_emails;
        delete config.note;
        const tmp = `${real}.tmp-${process.pid}-${Date.now()}`;
        fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { encoding: "utf8", mode: fs.statSync(real).mode & 0o777 });
        fs.renameSync(tmp, real);
        cleaned = true;
      }
    } catch {
      /* the public file stays as it is; signing in keeps working from the server-side list */
    }
  }
  return { moved, cleaned, count: cleanEmails(readAuthFile(adminAuthSecretsPath())?.admin_emails).length };
}

/**
 * The publicly served admin/config.json must not carry the password hash. Once the server-only
 * file holds a valid hash, the copy in the public file is blanked (the fallback is then unused).
 * Never touches the public file while it is still the only place the hash is stored.
 * @returns {{ cleaned: boolean }}
 */
export function scrubPasswordHashFromPublicConfig(configPath) {
  if (!loadPasswordHash("")) return { cleaned: false }; // secrets file has no hash yet → keep the fallback
  if (!configPath || !fs.existsSync(configPath)) return { cleaned: false };
  try {
    const real = fs.realpathSync(configPath);
    const config = JSON.parse(fs.readFileSync(real, "utf8"));
    if (!config.password_sha256) return { cleaned: false };
    config.password_sha256 = "";
    const tmp = `${real}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { encoding: "utf8", mode: fs.statSync(real).mode & 0o777 });
    fs.renameSync(tmp, real);
    return { cleaned: true };
  } catch {
    return { cleaned: false };
  }
}

export function sessionMatchesPassword(session, expectHash) {
  if (!session) return false;
  const expect = String(expectHash || "").toLowerCase();
  if (!expect) return false;
  return String(session.ph || "").toLowerCase() === expect;
}

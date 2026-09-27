/**
 * Non-secret site settings — droplet-only store (not in public git).
 * Same secrets directory pattern as Immowelt API credentials.
 *
 * Default path: /var/lib/eichmann/secrets/site-settings.json (mode 600, dir 700)
 * Override with EICHMANN_SITE_SETTINGS_FILE (tests / local).
 *
 * On save, also writes a public mirror to $SITE_ROOT/data/flyer-settings.json
 * so the Allmannsdorf flyer can read Immo-Nummer without admin auth.
 */
import fs from "node:fs";
import path from "node:path";

const DEFAULT_SECRETS_DIR = "/var/lib/eichmann/secrets";
const DEFAULT_FILE = path.join(DEFAULT_SECRETS_DIR, "site-settings.json");

export function siteSettingsPath() {
  return (
    process.env.EICHMANN_SITE_SETTINGS_FILE ||
    process.env.SITE_SETTINGS_FILE ||
    DEFAULT_FILE
  );
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

function readRaw() {
  const filePath = siteSettingsPath();
  if (!fs.existsSync(filePath)) return {};
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return {};
    return data;
  } catch {
    return {};
  }
}

function normalizeFlyerImmoNummer(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, "");
}

/**
 * @returns {{ flyer_immo_nummer: string|null, updated_at: string|null }}
 */
export function getSiteSettings() {
  const data = readRaw();
  const flyer_immo_nummer = normalizeFlyerImmoNummer(data.flyer_immo_nummer);
  return {
    flyer_immo_nummer: flyer_immo_nummer || null,
    updated_at: data.updated_at || null,
  };
}

export function getFlyerImmoNummer() {
  return getSiteSettings().flyer_immo_nummer;
}

/**
 * Persist flyer Immo-Nummer. Empty string clears the override (flyer keeps HTML default).
 * @param {string|null|undefined} flyer_immo_nummer
 * @param {{ siteRoot?: string }} [opts]
 */
export function saveFlyerImmoNummer(flyer_immo_nummer, opts = {}) {
  const filePath = siteSettingsPath();
  const prev = readRaw();
  const normalized = normalizeFlyerImmoNummer(flyer_immo_nummer);

  // Soft validation: digits/letters only, max 32 chars (object numbers)
  if (normalized && !/^[A-Za-z0-9._/-]{1,32}$/.test(normalized)) {
    const err = new Error(
      "Immo-Nummer (Flyer) ist ungültig. Bitte nur Ziffern/Buchstaben (max. 32 Zeichen)."
    );
    err.status = 400;
    err.code = "flyer_immo_nummer_invalid";
    throw err;
  }

  ensureSecretsDir(filePath);
  const payload = {
    ...prev,
    flyer_immo_nummer: normalized || null,
    updated_at: new Date().toISOString(),
  };
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
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

  const siteRoot =
    opts.siteRoot ||
    process.env.EICHMANN_SITE_ROOT ||
    (fs.existsSync("/var/www/immobilieneichmann.de")
      ? "/var/www/immobilieneichmann.de"
      : null);
  if (siteRoot) {
    writePublicFlyerSettings(siteRoot, payload.flyer_immo_nummer);
  }

  return getSiteSettings();
}

/**
 * Public mirror for flyer JS (safe to expose — not a secret).
 * @param {string} siteRoot
 * @param {string|null} [flyer_immo_nummer]
 */
export function writePublicFlyerSettings(siteRoot, flyer_immo_nummer) {
  if (!siteRoot) return null;
  const dataDir = path.join(siteRoot, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const out = path.join(dataDir, "flyer-settings.json");
  const value =
    flyer_immo_nummer === undefined
      ? getFlyerImmoNummer()
      : normalizeFlyerImmoNummer(flyer_immo_nummer) || null;
  const body = {
    flyer_immo_nummer: value,
    updated_at: new Date().toISOString(),
  };
  const tmp = `${out}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n", { mode: 0o644 });
  fs.renameSync(tmp, out);
  try {
    fs.chmodSync(out, 0o644);
  } catch {
    /* ignore */
  }
  return out;
}

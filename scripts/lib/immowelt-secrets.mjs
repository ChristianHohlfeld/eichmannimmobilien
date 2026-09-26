/**
 * Immowelt API credentials — droplet-only secrets.
 * Never commit values. Never return the full API key to the browser.
 *
 * Default path: /var/lib/eichmann/secrets/immowelt-api.json (mode 600, dir 700)
 * Override with EICHMANN_IMMOWELT_SECRETS_FILE (tests / local).
 */
import fs from "node:fs";
import path from "node:path";

const DEFAULT_SECRETS_DIR = "/var/lib/eichmann/secrets";
const DEFAULT_FILE = path.join(DEFAULT_SECRETS_DIR, "immowelt-api.json");

export function immoweltSecretsPath() {
  return (
    process.env.EICHMANN_IMMOWELT_SECRETS_FILE ||
    process.env.IMMOWELT_SECRETS_FILE ||
    DEFAULT_FILE
  );
}

export function maskApiKey(key) {
  const s = String(key || "").trim();
  if (!s) return null;
  if (s.length <= 4) return "••••";
  if (s.length <= 8) return `••••…${s.slice(-2)}`;
  return `••••…${s.slice(-4)}`;
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
  const filePath = immoweltSecretsPath();
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * @returns {{ kundennummer: string, api_key: string, updated_at: string|null } | null}
 */
export function readImmoweltCredentials() {
  const data = readRaw();
  if (!data) return null;
  const api_key = String(data.api_key || data.apiKey || "").trim();
  const kundennummer = String(data.kundennummer || data.customer_number || "").trim();
  if (!api_key) return null;
  return {
    kundennummer,
    api_key,
    updated_at: data.updated_at || null,
  };
}

export function hasImmoweltApiKey() {
  return Boolean(readImmoweltCredentials()?.api_key);
}

/**
 * Safe for Admin GET — never includes full api_key.
 */
export function getImmoweltCredentialsStatus() {
  const data = readRaw() || {};
  const api_key = String(data.api_key || data.apiKey || "").trim();
  const kundennummer = String(data.kundennummer || data.customer_number || "").trim();
  return {
    ok: true,
    has_key: Boolean(api_key),
    masked_key: maskApiKey(api_key),
    kundennummer: kundennummer || null,
    updated_at: data.updated_at || null,
  };
}

/**
 * Persist credentials. Empty api_key with keepExistingKey keeps prior key.
 * @param {{ kundennummer?: string, api_key?: string, keep_existing_key?: boolean }} input
 */
export function saveImmoweltCredentials(input = {}) {
  const filePath = immoweltSecretsPath();
  const prev = readRaw() || {};
  const prevKey = String(prev.api_key || prev.apiKey || "").trim();

  const kundennummer = String(input.kundennummer ?? prev.kundennummer ?? "")
    .trim()
    .replace(/\s+/g, "");
  let api_key = String(input.api_key ?? "").trim();
  const keep = input.keep_existing_key === true;

  if (!api_key && keep && prevKey) {
    api_key = prevKey;
  }

  if (!kundennummer) {
    const err = new Error("Bitte die Immowelt-Kundennummer eintragen.");
    err.status = 400;
    err.code = "kundennummer_required";
    throw err;
  }
  if (!api_key) {
    const err = new Error(
      prevKey
        ? "Bitte einen neuen API-Schlüssel eingeben oder den bestehenden behalten."
        : "Bitte den Immowelt-API-Schlüssel eintragen."
    );
    err.status = 400;
    err.code = "api_key_required";
    throw err;
  }
  if (api_key.length < 8) {
    const err = new Error("Der API-Schlüssel ist zu kurz. Bitte den vollständigen Schlüssel von Immowelt eintragen.");
    err.status = 400;
    err.code = "api_key_too_short";
    throw err;
  }

  ensureSecretsDir(filePath);
  const payload = {
    kundennummer,
    api_key,
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

  return getImmoweltCredentialsStatus();
}

/**
 * Admin password (SHA-256 hex of utf8) in EICHMANN_ADMIN_CONFIG.
 * No plaintext in logs. Session secret is separate and untouched.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MIN_PASSWORD_LENGTH = 8;

export function sha256Hex(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

export function isSha256Hex(value) {
  return /^[0-9a-f]{64}$/.test(String(value || "").toLowerCase());
}

/**
 * Validate change-password fields (everyday German errors).
 * @returns {{ ok: true, newHash: string } | { ok: false, status: number, error: string }}
 */
export function validatePasswordChange({ currentPassword, newPassword, newPasswordRepeat, expectHash }) {
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

/** Atomic write of password_sha256 only; preserves other config keys. */
export function savePasswordHash(configPath, newHash) {
  const hash = String(newHash || "").toLowerCase().trim();
  if (!isSha256Hex(hash)) {
    const err = new Error("Interner Fehler beim Speichern des Passworts.");
    err.status = 500;
    throw err;
  }
  const raw = fs.readFileSync(configPath, "utf8");
  const config = JSON.parse(raw);
  config.password_sha256 = hash;
  const dir = path.dirname(configPath);
  const tmp = path.join(dir, `.config.json.tmp-${process.pid}-${Date.now()}`);
  const body = JSON.stringify(config, null, 2) + "\n";
  fs.writeFileSync(tmp, body, { encoding: "utf8" });
  try {
    const st = fs.statSync(configPath);
    fs.chmodSync(tmp, st.mode & 0o777);
  } catch {
    /* keep default */
  }
  fs.renameSync(tmp, configPath);
  return hash;
}

export function sessionMatchesPassword(session, expectHash) {
  if (!session) return false;
  const expect = String(expectHash || "").toLowerCase();
  if (!expect) return false;
  return String(session.ph || "").toLowerCase() === expect;
}

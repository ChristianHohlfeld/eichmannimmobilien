/**
 * Admin sign-in: one password per person, reset by e-mail link.
 *
 * Store (server only, 0600): /var/lib/eichmann/secrets/admin-auth.json
 *   admin_emails     who may sign in
 *   users[email]     { password: "scrypt$…", updated_at }       – that person's own password
 *   password_sha256  shared password from before per-person passwords; applies only to a person
 *                    who has not set an own password yet (and after an emergency reset)
 *   reset[email]     { token_sha256, expires_at }               – one open reset link per person
 *
 * Reset links: random 32 bytes, only the SHA-256 of the token is stored, valid 30 minutes, usable
 * once. Sending is limited per person, per caller and overall with growing pauses, so the form
 * cannot be used to flood a mailbox – no matter who presses the button, or how often.
 *
 * Nothing here logs or returns a password, a token or a hash.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { adminAuthSecretsPath, loadAdminEmails, loadPasswordHash, sha256Hex, isSha256Hex, MIN_PASSWORD_LENGTH } from "./admin-password.mjs";

export const RESET_TTL_MS = 30 * 60_000;
const SCRYPT = { N: 16384, r: 8, p: 1, len: 32 };
const normalizeEmail = (e) => String(e || "").trim().toLowerCase();

function readAuth() {
  try {
    const data = JSON.parse(fs.readFileSync(adminAuthSecretsPath(), "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* ignore */
  }
}

function updateAuth(change) {
  const data = readAuth();
  change(data);
  data.updated_at = new Date().toISOString();
  writeJson(adminAuthSecretsPath(), data);
  return data;
}

/* ---------- passwords ---------- */

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.len, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password, stored) {
  const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(String(stored || ""));
  if (!m) return false;
  const expect = Buffer.from(m[5], "base64");
  let got;
  try {
    got = crypto.scryptSync(String(password), Buffer.from(m[4], "base64"), expect.length, { N: Number(m[1]), r: Number(m[2]), p: Number(m[3]) });
  } catch {
    return false;
  }
  return got.length === expect.length && crypto.timingSafeEqual(got, expect);
}

/** What currently proves this person's identity: the own password, else the shared one. */
function credentialOf(email, configPath) {
  const own = readAuth().users?.[normalizeEmail(email)]?.password;
  if (typeof own === "string" && own.startsWith("scrypt$")) return { kind: "own", value: own };
  if (readAuth().shared_off === true) return null;
  const shared = loadPasswordHash(configPath);
  return shared ? { kind: "shared", value: shared } : null;
}

/**
 * Retire the one password everybody shared. From then on a sign-in address only works with the person's
 * own password; whoever has none yet sets one through "Passwort vergessen?". Own passwords and open reset
 * links stay. Returns how many addresses already have an own password (no addresses).
 */
export function dropSharedPassword() {
  const data = updateAuth((d) => {
    // kept only to recognise the retired password and tell the person what to do – it opens nothing any more
    if (isSha256Hex(d.password_sha256)) d.retired_sha256 = d.password_sha256;
    d.password_sha256 = "";
    d.shared_off = true;
  });
  return { own_passwords: Object.values(data.users || {}).filter((u) => typeof u?.password === "string" && u.password.startsWith("scrypt$")).length };
}
/**
 * Did a person who has no own password yet just type the retired shared one? Then the sign-in page can say
 * plainly what to do ("Passwort vergessen?") instead of "wrong password". Never lets anyone in.
 */
export function isRetiredPassword(email, password, configPath) {
  const key = normalizeEmail(email);
  const data = readAuth();
  if (data.shared_off !== true || !isSha256Hex(data.retired_sha256) || !isAllowedEmail(key, configPath)) return false;
  if (typeof data.users?.[key]?.password === "string") return false;
  const a = Buffer.from(sha256Hex(String(password || "")));
  const b = Buffer.from(String(data.retired_sha256).toLowerCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export function sharedPasswordActive(configPath) {
  return readAuth().shared_off !== true && Boolean(loadPasswordHash(configPath));
}

export function isAllowedEmail(email, configPath) {
  const list = loadAdminEmails(configPath);
  return list.length === 0 ? Boolean(normalizeEmail(email)) : list.includes(normalizeEmail(email));
}

export function checkLogin(email, password, configPath) {
  if (!isAllowedEmail(email, configPath)) return false;
  const cred = credentialOf(email, configPath);
  if (!cred) return false;
  if (cred.kind === "own") return verifyPassword(password, cred.value);
  const a = Buffer.from(sha256Hex(password));
  const b = Buffer.from(cred.value);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Stored in the session and compared on every request: changes whenever this person's password
 * changes, so older sign-ins end. It is derived, never the hash itself.
 */
export function credentialFingerprint(email, configPath) {
  const cred = credentialOf(email, configPath);
  if (!cred || !isAllowedEmail(email, configPath)) return "";
  return sha256Hex(`eichmann-admin-session:${normalizeEmail(email)}:${cred.value}`).slice(0, 40);
}

export function validateNewPassword(newPassword, repeat) {
  const neu = String(newPassword || "");
  if (!neu || !String(repeat || "")) return "Bitte das neue Passwort zweimal eingeben.";
  if (neu.length < MIN_PASSWORD_LENGTH) return `Das neue Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen haben.`;
  if (neu.length > 200) return "Das neue Passwort ist zu lang.";
  if (neu !== String(repeat)) return "Die beiden Eingaben stimmen nicht überein.";
  return null;
}

export function setUserPassword(email, password) {
  const key = normalizeEmail(email);
  updateAuth((data) => {
    data.users = data.users && typeof data.users === "object" ? data.users : {};
    data.users[key] = { password: hashPassword(password), updated_at: new Date().toISOString() };
    if (data.reset) delete data.reset[key];
  });
}

/** Emergency reset from the server console: one password for everyone, own passwords and open links are dropped. */
export function resetEveryoneToShared(sha256) {
  const hash = String(sha256 || "").toLowerCase();
  if (!isSha256Hex(hash)) throw new Error("Interner Fehler beim Speichern des Passworts.");
  updateAuth((data) => {
    data.password_sha256 = hash;
    delete data.shared_off;
    delete data.retired_sha256;
    delete data.users;
    delete data.reset;
  });
}

/* ---------- reset links ---------- */

export function createResetToken(email, { now = Date.now(), ttlMs = RESET_TTL_MS } = {}) {
  const token = crypto.randomBytes(32).toString("base64url");
  updateAuth((data) => {
    data.reset = data.reset && typeof data.reset === "object" ? data.reset : {};
    data.reset[normalizeEmail(email)] = { token_sha256: sha256Hex(token), expires_at: new Date(now + ttlMs).toISOString() };
  });
  return token;
}

/** Whose link is this? Null when unknown, used or expired. Does not use it up. */
export function resetTokenOwner(token, { now = Date.now() } = {}) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{40,64}$/.test(token)) return null;
  const want = Buffer.from(sha256Hex(token));
  for (const [email, entry] of Object.entries(readAuth().reset || {})) {
    const have = Buffer.from(String(entry?.token_sha256 || ""));
    if (have.length === want.length && crypto.timingSafeEqual(have, want)) {
      return Date.parse(entry.expires_at) > now ? email : null;
    }
  }
  return null;
}

/** Set a new password with a reset link. The link is used up; a stale one changes nothing. */
export function resetPasswordWithToken(token, password, { now = Date.now(), configPath = "" } = {}) {
  const email = resetTokenOwner(token, { now });
  if (!email || !isAllowedEmail(email, configPath)) return null;
  setUserPassword(email, password); // also removes the link
  return email;
}

/* ---------- limits against flooding (growing pauses) ---------- */

const BASE_PAUSE_MS = 60_000; // after the 1st mail: 1 minute, then 2, 4, 8 … up to a day
const MAX_PAUSE_MS = 24 * 60 * 60_000;
const FORGET_AFTER_MS = 24 * 60 * 60_000; // a quiet day starts the count again
const GLOBAL_PER_HOUR = 8;

export function throttleFile() {
  return process.env.EICHMANN_ADMIN_RESET_THROTTLE_FILE || path.join(path.dirname(adminAuthSecretsPath()), "admin-reset-throttle.json");
}

function readThrottle() {
  try {
    const data = JSON.parse(fs.readFileSync(throttleFile(), "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

/** How long this key still has to wait (0 = may send now). */
export function pauseLeftMs(key, now = Date.now()) {
  const e = readThrottle()[key];
  return e && e.next_at > now ? e.next_at - now : 0;
}

/**
 * May a reset mail go out for this person, from this caller, right now? If yes, the next pause for
 * both is doubled. One decision for all three limits, so a refused attempt costs nothing.
 */
export function takeResetSlot({ email, ip }, now = Date.now()) {
  const state = readThrottle();
  const keys = [`mail:${normalizeEmail(email)}`, `ip:${String(ip || "unknown").slice(0, 64)}`];
  for (const k of Object.keys(state)) {
    if (k !== "global" && now - (state[k].last_at || 0) > FORGET_AFTER_MS && (state[k].next_at || 0) <= now) delete state[k];
  }
  const recent = (state.global?.sent || []).filter((t) => now - t < 60 * 60_000);
  if (recent.length >= GLOBAL_PER_HOUR) return { ok: false, reason: "global" };
  for (const k of keys) if (state[k] && state[k].next_at > now) return { ok: false, reason: k.split(":")[0], wait_ms: state[k].next_at - now };
  for (const k of keys) {
    const count = state[k]?.count || 0;
    state[k] = { count: count + 1, last_at: now, next_at: now + Math.min(MAX_PAUSE_MS, BASE_PAUSE_MS * 2 ** count) };
  }
  state.global = { sent: [...recent, now] };
  writeJson(throttleFile(), state);
  return { ok: true };
}

/** After a successful reset or sign-in the pause for that person starts from the beginning again. */
export function clearResetPause(email) {
  const state = readThrottle();
  if (!state[`mail:${normalizeEmail(email)}`]) return;
  delete state[`mail:${normalizeEmail(email)}`];
  writeJson(throttleFile(), state);
}

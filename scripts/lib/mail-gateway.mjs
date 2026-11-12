/**
 * Send the admin area's two system mails ("Passwort vergessen" and a test) through the form gateway that
 * already delivers the website's contact and exposé inquiries (forms.digitalisierungsplanung.de → Amazon SES).
 * No mail password lives on this server.
 *
 * How the gateway knows a request really comes from this server: every request is signed with an Ed25519
 * key that never leaves this machine (/var/lib/eichmann/secrets/mail-gateway-key.pem, 0600). The gateway
 * only holds the public half. A request carries no message text – only who (one of the gateway's fixed
 * recipients), which kind, and for "reset" the link. The gateway writes the mail itself and refuses any
 * recipient or link outside its own fixed rules, so even a stolen key could not send anything else.
 *
 * Signed text (must stay byte-identical with the gateway's check):
 *   dp-forms-admin-reset-v1 \n tenant \n kind \n to \n link \n minutes \n ts \n nonce
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const GATEWAY_TENANT = "immobilieneichmann";
export const GATEWAY_URL = "https://forms.digitalisierungsplanung.de/v1/immobilieneichmann/admin-reset";
const SIGN_PREFIX = "dp-forms-admin-reset-v1";

export function gatewayKeyFile() {
  return process.env.EICHMANN_MAIL_GATEWAY_KEY_FILE || path.join(process.env.EICHMANN_STATE_DIR || "/var/lib/eichmann", "secrets", "mail-gateway-key.pem");
}

/** https only; plain http solely to a gateway on this very machine (tests). */
export function parseGatewayUrl(value) {
  let u;
  try {
    u = new URL(String(value || GATEWAY_URL));
  } catch {
    throw new Error("Gateway-Adresse ungültig.");
  }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new Error("Gateway-Adresse ungültig: nur https.");
  if (u.username || u.password || u.search || u.hash) throw new Error("Gateway-Adresse ungültig.");
  return u.toString();
}

function loadKey(file = gatewayKeyFile()) {
  try {
    const key = crypto.createPrivateKey(fs.readFileSync(file, "utf8"));
    return key.asymmetricKeyType === "ed25519" ? key : null;
  } catch {
    return null;
  }
}

export function hasGatewayKey(file = gatewayKeyFile()) {
  return Boolean(loadKey(file));
}

/** Create the key once. Returns true if a new one was written; an existing key is never replaced. */
export function ensureGatewayKey(file = gatewayKeyFile()) {
  if (loadKey(file)) return false;
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return true;
}

/** The public half (SPKI, base64). Not a secret – this is what the gateway is given. */
export function gatewayPublicKey(file = gatewayKeyFile()) {
  const key = loadKey(file);
  return key ? crypto.createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64") : null;
}

export function signingText({ tenant = GATEWAY_TENANT, kind, to = "", link = "", minutes = 0, ts, nonce }) {
  return [SIGN_PREFIX, tenant, kind, to, link, String(minutes), String(ts), nonce].join("\n");
}

export function signedRequest({ kind, to = "", link = "", minutes = 0 }, { keyFile = gatewayKeyFile(), now = Date.now(), nonce = crypto.randomBytes(16).toString("hex") } = {}) {
  const key = loadKey(keyFile);
  if (!key) throw new Error("Schlüssel für den Mailversand fehlt.");
  const body = { v: 1, kind, to: String(to).trim().toLowerCase(), link: String(link), minutes: Number(minutes) || 0, ts: now, nonce };
  return { ...body, sig: crypto.sign(null, Buffer.from(signingText(body), "utf8"), key).toString("base64") };
}

/**
 * One request to the gateway. Resolves when the gateway has accepted it (for mails: handed over to the
 * mail service), rejects with a short reason that contains neither address nor link.
 */
export async function gatewayRequest(settings, payload, { fetchImpl = globalThis.fetch, timeoutMs = 20_000 } = {}) {
  const body = JSON.stringify(signedRequest(payload, { keyFile: settings.keyFile }));
  let res;
  try {
    res = await fetchImpl(settings.url, { method: "POST", headers: { "content-type": "application/json" }, body, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new Error(e?.name === "TimeoutError" ? "Gateway antwortet nicht" : "Gateway nicht erreichbar");
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* handled below */
  }
  if (res.status === 200 && data?.success === true) return { ok: true };
  const reason = { 403: "Gateway lehnt ab (Schlüssel, Empfänger oder Uhrzeit passen dort nicht)", 404: "Gateway kennt diesen Weg noch nicht", 429: "Gateway: zu viele Anfragen", 502: "Maildienst hat nicht angenommen" }[res.status];
  throw new Error(reason || `Gateway antwortet mit ${res.status}`);
}

export const gatewayPing = (settings, options) => gatewayRequest(settings, { kind: "ping" }, options);
export const gatewayResetMail = (settings, { to, link, minutes }, options) => gatewayRequest(settings, { kind: "reset", to, link, minutes }, options);
export const gatewayTestMail = (settings, { to }, options) => gatewayRequest(settings, { kind: "test", to }, options);

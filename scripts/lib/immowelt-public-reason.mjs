/**
 * Map Immowelt sync failure reasons to plain German for Admin / public UI.
 * Never expose Node/Playwright paths, stack traces, or install hints.
 */

const TECH_RE =
  /playwright|browsertype\.launch|ms-playwright|chromium_headless|executable doesn'?t exist|npx playwright|\/root\/\.cache|\/home\/|\/var\/lib\/|node_modules|ENOENT|EACCES|EPERM|spawn |Error:|TypeError|ReferenceError|at Object\.|at Module\.|at async |\.mjs:\d+|:\d+:\d+/i;

const NETWORK_RE =
  /datadome|net::|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket hang up|HTTP 403|HTTP 429|timeout/i;

const ENGLISH_SOFTFAIL_RE =
  /snapshot incomplete|Empty listings|keeping last|refusing to overwrite|last-known-good|soft-fail|hard-fail/i;

const DEFAULT_REJECTED =
  "Abruf fehlgeschlagen – technisches Problem, wird behoben. Last Known Good bleibt online.";
const DEFAULT_NETWORK =
  "Abruf fehlgeschlagen – Immowelt vorübergehend nicht erreichbar. Last Known Good bleibt online.";
const DEFAULT_UNSAFE =
  "Unsicherer Abruf verworfen. Last Known Good bleibt online.";
const DEFAULT_AWAITING =
  "Immowelt-Zugang noch nicht eingerichtet; letzter bekannter Stand bleibt.";
const DEFAULT_OPEN = "Kein bestätigter aktueller Immowelt-Stand.";

/**
 * @param {unknown} reason
 * @param {string} [state]
 * @returns {string}
 */
export function publicImmoweltSyncReason(reason, state = "rejected") {
  const raw = String(reason ?? "").trim();
  if (!raw) {
    if (state === "awaiting_api_key") return DEFAULT_AWAITING;
    if (state === "rejected") return DEFAULT_REJECTED;
    return DEFAULT_OPEN;
  }

  if (TECH_RE.test(raw) || looksLikeStackOrPath(raw)) {
    return DEFAULT_REJECTED;
  }
  if (NETWORK_RE.test(raw)) {
    return DEFAULT_NETWORK;
  }
  if (ENGLISH_SOFTFAIL_RE.test(raw)) {
    return DEFAULT_UNSAFE;
  }

  // Allow short, already-public German copy through.
  if (isSafePublicGerman(raw)) {
    return raw.length > 320 ? `${raw.slice(0, 317)}…` : raw;
  }

  return state === "awaiting_api_key" ? DEFAULT_AWAITING : DEFAULT_REJECTED;
}

function looksLikeStackOrPath(raw) {
  if (raw.includes("\n") && /at /.test(raw)) return true;
  if (
    /\/[a-z0-9._-]+\/[a-z0-9._/-]+/i.test(raw) &&
    (raw.length > 120 || /playwright|chromium|cache/i.test(raw))
  ) {
    return true;
  }
  if (/`[^`]+`/.test(raw) && /playwright|npx|chromium|\.mjs/i.test(raw)) return true;
  return false;
}

function isSafePublicGerman(raw) {
  if (raw.length > 400) return false;
  if (/[\n\r\t`]/.test(raw)) return false;
  if (/\/[a-z0-9._-]+\//i.test(raw)) return false;
  if (/[{}<>]|\$\{/.test(raw)) return false;
  if (/\b(Error|Exception|undefined|null is not|Cannot find)\b/.test(raw)) return false;
  return true;
}

export const IMMOWELT_PUBLIC_REASON_DEFAULTS = Object.freeze({
  rejected: DEFAULT_REJECTED,
  network: DEFAULT_NETWORK,
  unsafe: DEFAULT_UNSAFE,
  awaiting_api_key: DEFAULT_AWAITING,
  open: DEFAULT_OPEN,
});

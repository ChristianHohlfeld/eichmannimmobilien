/**
 * Status of the Immowelt → website sync. One small public JSON file, replaced atomically
 * after EVERY run (also when nothing changed, also when the run failed).
 *
 * States
 *   current               last run read the complete inventory; website shows exactly that
 *   pending_confirmation  a large disappearance / empty inventory waits for the second identical answer
 *   failed                last run failed; website keeps the last complete state (last-known-good)
 *   awaiting_api_key      no API key on the server
 *   migration_required    scraper-era rows must be mapped once (identity plan) before the first API publish
 *   held                  an operator paused publishing (after a rollback)
 * "stale" is never written by the job itself – a job that does not run cannot report it.
 * It is derived by every reader from last_success_at (see evaluateStatus), which is what the
 * external watchdog and the server watchdog do.
 */
import fs from "node:fs";
import path from "node:path";

export const STATUS_SCHEMA = "eichmann.immowelt-sync-status/v2";
export const OK_STATES = new Set(["current", "pending_confirmation"]);

export function readStatus(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function writeJsonAtomic(file, value, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(tmp, file);
}

/**
 * @param {string} file
 * @param {object} update  { state, now, error?, published?, change?, warnings?, runId?, trigger?, pending? }
 */
export function writeStatus(file, update, { staleAfterMinutes = 120 } = {}) {
  const prev = readStatus(file) || {};
  const ok = OK_STATES.has(update.state);
  const success = update.state === "current" || update.state === "pending_confirmation";
  const published = update.published || prev.published || null;
  const next = {
    schema: STATUS_SCHEMA,
    source: "immowelt",
    mode: "official_api",
    policy: "fail_closed_last_known_good",
    state: update.state,
    ok,
    last_attempt_at: update.now,
    // last time the COMPLETE inventory was read and validated (changed or not)
    last_success_at: success ? update.now : prev.last_success_at || null,
    // last time the public website changed because of Immowelt
    last_change_at: update.changed ? update.now : prev.last_change_at || null,
    consecutive_failures: ok ? 0 : (prev.consecutive_failures || 0) + 1,
    stale_after_minutes: staleAfterMinutes,
    published,
    pending: update.pending || null,
    // start of the current uninterrupted "waiting for confirmation" series, whatever the answers looked like
    pending_since: update.state === "pending_confirmation" ? prev.pending_since || update.now : null,
    last_change: update.change || prev.last_change || null,
    warnings: (update.warnings || []).slice(0, 25),
    error: ok ? null : { code: update.error?.code || update.state, message: String(update.error?.message || "").slice(0, 400), at: update.now },
    run_id: update.runId || null,
    trigger: update.trigger || null,
    // --- fields the admin UI already reads ---
    last_valid_at: success ? update.now : prev.last_valid_at || prev.last_success_at || null,
    last_valid_count: published?.count ?? prev.last_valid_count ?? null,
    reason: ok ? null : String(update.error?.message || "").slice(0, 400) || null,
  };
  writeJsonAtomic(file, next);
  return next;
}

/**
 * Reader-side verdict. Used by the watchdogs; pure, so it is unit-tested.
 * @returns {{ ok: boolean, level: "ok"|"warn"|"alarm", problems: string[], age_minutes: number|null }}
 */
export function evaluateStatus(status, { now = new Date(), staleAfterMinutes = null } = {}) {
  const problems = [];
  if (!status || typeof status !== "object") return { ok: false, level: "alarm", problems: ["Statusdatei fehlt oder ist unlesbar."], age_minutes: null };
  if (status.schema !== STATUS_SCHEMA) problems.push(`Statusdatei hat ein altes Format (${status.schema || "ohne Schema"}) – der neue Abgleich lief noch nie.`);
  const limit = staleAfterMinutes ?? status.stale_after_minutes ?? 120;
  const last = status.last_success_at ? Date.parse(status.last_success_at) : NaN;
  const age = Number.isFinite(last) ? Math.round((now.getTime() - last) / 60000) : null;
  if (age == null) problems.push("Es gab noch keinen erfolgreichen Abgleich.");
  else if (age > limit) problems.push(`Letzter erfolgreicher Abgleich vor ${age} Minuten (Grenze ${limit}).`);
  if (!OK_STATES.has(status.state)) problems.push(`Zustand ${status.state}${status.error?.message ? `: ${status.error.message}` : ""}`);
  const warn = [];
  const waiting = status.state === "pending_confirmation" && status.pending_since ? Math.round((now.getTime() - Date.parse(status.pending_since)) / 60000) : 0;
  if (waiting > 180) problems.push(`Bestätigung eines großen Wegfalls steht seit ${waiting} Minuten aus – Immowelt liefert keinen stabilen Bestand.`);
  if ((status.warnings || []).length) warn.push(`${status.warnings.length} Hinweis(e) im letzten Lauf.`);
  return { ok: problems.length === 0, level: problems.length ? "alarm" : warn.length ? "warn" : "ok", problems: [...problems, ...warn], age_minutes: age };
}

/**
 * Optional alarm sinks, configured in a server-only file (never in the repo):
 *   { "enabled": true,
 *     "healthcheck_url": "https://hc-ping.com/<uuid>",   // pinged on every OK run, "/fail" on failure
 *     "webhook_url": "https://…" }                        // POST on every state change and on each failure
 * Missing file or enabled:false → nothing is sent. A failing sink never fails the sync.
 */
export async function notifySinks(alarmFile, status, previous, { fetchImpl = globalThis.fetch, timeoutMs = 10_000, log = () => {} } = {}) {
  let cfg = null;
  try {
    cfg = JSON.parse(fs.readFileSync(alarmFile, "utf8"));
  } catch {
    return { sent: [] };
  }
  if (!cfg || cfg.enabled !== true) return { sent: [] };
  const sent = [];
  const post = async (name, url, init) => {
    try {
      const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      sent.push({ sink: name, ok: res.ok, status: res.status });
    } catch (err) {
      sent.push({ sink: name, ok: false, error: String(err?.name || "error") });
      log(`Alarm-Senke ${name} nicht erreichbar (${err?.name || "Fehler"}).`);
    }
  };
  const summary = { site: "immobilieneichmann.de", state: status.state, ok: status.ok, at: status.last_attempt_at, last_success_at: status.last_success_at, error: status.error, published: status.published };
  if (typeof cfg.healthcheck_url === "string" && /^https:\/\//.test(cfg.healthcheck_url)) {
    const base = cfg.healthcheck_url.replace(/\/+$/, "");
    await post("healthcheck", status.ok ? base : `${base}/fail`, { method: "POST", headers: { "content-type": "text/plain; charset=utf-8" }, body: status.ok ? "ok" : `${status.state}: ${status.error?.message || ""}`.slice(0, 900) });
  }
  const changed = !previous || previous.state !== status.state;
  if (typeof cfg.webhook_url === "string" && /^https:\/\//.test(cfg.webhook_url) && (changed || !status.ok)) {
    await post("webhook", cfg.webhook_url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(summary) });
  }
  return { sent };
}

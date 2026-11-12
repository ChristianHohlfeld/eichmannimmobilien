/**
 * Unified Admin – Immowelt status (read-only: Immowelt is the only source for those offers)
 * + Eigen CRUD + multi-image upload.
 * Auth: session cookie via /admin/api/
 * Changes to own listings require the Abnahme modal (confirm:true).
 */
const API = "/admin/api";

let config = null;
let immoweltListings = [];
let eigenListings = [];
let snapshotsList = [];
let doSnapshotsList = [];
let doSnapshotsMeta = null;
let activeTab = "immowelt";
let restoreTargetId = null;
/** @type {{ base: string, url: string }[]} */
let editorGallery = [];
let pendingFiles = [];
let sessionActive = false;
let refreshInFlight = null;
let refreshTimer = null;
const REFRESH_INTERVAL_MS = 45_000;

const $ = (id) => document.getElementById(id);

function toast(msg, type = "", opts = {}) {
  const el = $("toast");
  if (!el) return;
  const sticky = opts && opts.sticky === true;
  el.textContent = msg;
  el.className =
    "toast" +
    (type ? " " + type : "") +
    (sticky ? " sticky" : "");
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  if (!sticky) {
    toast._t = setTimeout(() => el.classList.add("hidden"), 4500);
  }
}

function clearStickyToast() {
  const el = $("toast");
  if (!el) return;
  clearTimeout(toast._t);
  if (el.classList.contains("sticky") || !el.classList.contains("hidden")) {
    el.classList.add("hidden");
    el.classList.remove("sticky");
  }
}

/** Durable status under Immowelt-Stand — stays until next Sync (not toast-only). */
const SYNC_LOADING_MSG =
  "Der Abgleich mit Immowelt läuft. Bitte warten – das dauert meist etwa eine Minute.";
const SYNC_LOADING_LONG_MSG =
  "Der Abgleich läuft noch. Es dauert diesmal länger als üblich – bitte weiter warten.";
const SYNC_DISCONNECT_MSG =
  "Die Verbindung wurde unterbrochen. Der Abgleich kann trotzdem geklappt haben. Bitte laden Sie diese Seite neu und schauen Sie auf die Meldung ganz oben.";
/** Client abort slightly after server/nginx 240s so we never spin forever on iPhone. */
const SYNC_CLIENT_TIMEOUT_MS = 250_000;
let syncLongWaitTimer = null;

let syncStepTimers = [];
function clearImmoweltSyncLongWait() {
  if (syncLongWaitTimer) {
    clearTimeout(syncLongWaitTimer);
    syncLongWaitTimer = null;
  }
  syncStepTimers.forEach(clearTimeout);
  syncStepTimers = [];
}

function fillSyncStatusNode(el, msg, kind) {
  if (!el) return;
  if (!msg) {
    el.textContent = "";
    el.className = el.id === "immowelt-sync-bar" ? "immowelt-sync-bar hidden" : "sync-outcome hidden";
    return;
  }
  const base = el.id === "immowelt-sync-bar" ? "immowelt-sync-bar" : "sync-outcome";
  el.className = base + (kind ? " " + kind : "");
  if (kind === "progress") {
    el.innerHTML =
      '<span class="sync-spinner" aria-hidden="true"></span>' +
      '<span class="sync-outcome-text"></span>';
    const text = el.querySelector(".sync-outcome-text");
    if (text) text.textContent = msg;
  } else {
    el.textContent = msg;
  }
}

/** One Sync status channel: header bar + Immowelt-Stand line. Never also sticky-toast (avoids duplicate covering Abmelden). */
function celebrate() {
  const icon = $("easy-status-icon");
  if (!icon) return;
  icon.classList.remove("pop");
  void icon.offsetWidth; // restart the animation
  icon.classList.add("pop");
}

function setImmoweltSyncOutcome(msg, kind = "") {
  if (kind === "ok") celebrate();
  // Always dismiss any leftover sticky toast — bar is the durable UI.
  clearStickyToast();
  fillSyncStatusNode($("immowelt-sync-bar"), msg, kind);
  fillSyncStatusNode($("immowelt-sync-outcome"), msg, kind);
}

function setImmoweltSyncBusy(busy) {
  const btn = $("btn-immowelt-sync");
  if (!btn) return;
  btn.disabled = !!busy;
  btn.setAttribute("aria-busy", busy ? "true" : "false");
  btn.classList.toggle("is-syncing", !!busy);
  if (busy) {
    btn.innerHTML =
      '<span class="btn-sync-spinner" aria-hidden="true"></span><span>Abgleich läuft …</span>';
  } else {
    btn.textContent = "Jetzt mit Immowelt abgleichen";
  }
}

function startImmoweltSyncLoading() {
  clearImmoweltSyncLongWait();
  setImmoweltSyncBusy(true);
  setImmoweltSyncOutcome(SYNC_LOADING_MSG, "progress");
  // What is happening, in plain steps (timing is typical, not measured – the result decides).
  const steps = [
    [6_000, "Schritt 1 von 3: Ihre Angebote werden bei Immowelt gelesen …"],
    [22_000, "Schritt 2 von 3: Texte, Preise und Fotos werden verglichen …"],
    [50_000, "Schritt 3 von 3: Die Website wird auf den neuen Stand gebracht …"],
  ];
  syncStepTimers = steps.map(([ms, msg]) => setTimeout(() => setImmoweltSyncOutcome(msg, "progress"), ms));
  // Soft hint only — keep loading state; never invent a fake fail while request is open.
  syncLongWaitTimer = setTimeout(() => {
    setImmoweltSyncOutcome(SYNC_LOADING_LONG_MSG, "progress");
  }, 150_000);
}

function isSyncDisconnectError(e) {
  if (!e) return false;
  if (e.network || e.disconnected || e.name === "AbortError") return true;
  const st = Number(e.status);
  if (st === 0 || st === 499 || st === 502 || st === 504) return true;
  return /unterbrochen|Leere Antwort|abgebrochen|Ungültige Server-Antwort|AbortError/i.test(
    String(e.message || e)
  );
}

/** After abort/499: GET light status and show real rejected / no-change / pending. */
async function resolveImmoweltSyncAfterDisconnect() {
  try {
    const st = await api("/status");
    const status = st.immowelt_sync || {};
    let preview = null;
    try {
      preview = await api("/publish/preview");
    } catch {
      /* ignore — status alone is enough for rejected */
    }
    if (preview?.has_changes || preview?.publish_pending) {
      return {
        kind: "changes",
        preview,
        message:
          preview.publish_pending?.message ||
          preview.message ||
          "Änderungen gefunden. Bitte prüfen und dann „Übernehmen“ oder „Abbrechen“ wählen.",
      };
    }
    if (["rejected", "awaiting_api_key", "failed", "migration_required", "held"].includes(status.state)) {
      return {
        kind: "rejected",
        message: publicImmoweltReason(status.reason, status.state),
      };
    }
    if (status.state === "current") {
      return {
        kind: "ok",
        message: "Fertig. Bei Immowelt hat sich nichts geändert – Ihre Website ist aktuell.",
      };
    }
  } catch {
    /* fall through */
  }
  return { kind: "unknown", message: SYNC_DISCONNECT_MSG };
}

async function postImmoweltSync() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SYNC_CLIENT_TIMEOUT_MS);
  try {
    return await api("/immowelt/sync", {
      method: "POST",
      body: JSON.stringify({}),
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e && (e.name === "AbortError" || ctrl.signal.aborted)) {
      const err = new Error(SYNC_DISCONNECT_MSG);
      err.status = 0;
      err.network = true;
      err.disconnected = true;
      throw err;
    }
    if (e && isSyncDisconnectError(e)) {
      const needsRewrite =
        !e.message ||
        /HTTP 499|Leere Antwort|unterbrochen\. Bitte erneut/i.test(e.message);
      if (needsRewrite) {
        const err = new Error(SYNC_DISCONNECT_MSG);
        err.status = e.status || 0;
        err.network = true;
        err.disconnected = true;
        err.data = e.data;
        throw err;
      }
      e.disconnected = true;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeEmail(v) {
  return String(v || "").trim().toLowerCase();
}

async function api(path, options = {}) {
  const opts = {
    credentials: "same-origin",
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.body && !(options.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...(options.headers || {}),
    },
  };
  // FormData: let browser set multipart boundary — strip Content-Type if set
  if (options.body instanceof FormData && opts.headers["Content-Type"]) {
    delete opts.headers["Content-Type"];
  }
  let res;
  try {
    res = await fetch(`${API}${path}`, opts);
  } catch (e) {
    const aborted = e && (e.name === "AbortError" || opts.signal?.aborted);
    const err = new Error(
      aborted || path.includes("/immowelt/sync")
        ? "Die Verbindung wurde unterbrochen. Der Abgleich kann trotzdem geklappt haben. Bitte laden Sie diese Seite neu und schauen Sie auf die Meldung ganz oben."
        : "Verbindung unterbrochen. Bitte erneut versuchen."
    );
    err.status = 0;
    err.network = true;
    err.disconnected = true;
    err.name = aborted ? "AbortError" : "NetworkError";
    throw err;
  }
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      const err = new Error(
        path.includes("/immowelt/sync")
          ? SYNC_DISCONNECT_MSG
          : "Ungültige Server-Antwort. Bitte erneut versuchen."
      );
      err.status = res.status;
      err.raw = text.slice(0, 200);
      err.disconnected = true;
      throw err;
    }
  }
  const gatewayFail = res.status === 499 || res.status === 502 || res.status === 504;
  if (!res.ok || gatewayFail) {
    let msg = (data && (data.error || data.message)) || "";
    if (!msg) {
      if (res.status === 499) {
        msg = "Die Verbindung wurde unterbrochen. Der Abgleich kann trotzdem geklappt haben. Bitte laden Sie diese Seite neu und schauen Sie auf die Meldung ganz oben.";
      } else if (res.status === 502 || res.status === 504) {
        msg = "Der Server hat nicht rechtzeitig geantwortet. Bitte erneut versuchen.";
      } else if (!text) {
        msg = path.includes("/immowelt/sync")
        ? "Die Verbindung wurde unterbrochen. Der Abgleich kann trotzdem geklappt haben. Bitte laden Sie diese Seite neu und schauen Sie auf die Meldung ganz oben."
        : "Leere Antwort vom Server. Bitte erneut versuchen.";
      } else {
        msg = `HTTP ${res.status}`;
      }
    }
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  if (data == null) {
    const err = new Error(
      path.includes("/immowelt/sync")
        ? "Die Verbindung wurde unterbrochen. Der Abgleich kann trotzdem geklappt haben. Bitte laden Sie diese Seite neu und schauen Sie auf die Meldung ganz oben."
        : "Leere Antwort vom Server. Bitte erneut versuchen."
    );
    err.status = res.status;
    err.disconnected = true;
    throw err;
  }
  return data;
}

function showGate(on) {
  $("view-reset")?.classList.add("hidden");
  $("view-gate").classList.toggle("hidden", !on);
  $("view-app").classList.toggle("hidden", on);
  $("app-header").classList.toggle("hidden", on);
  $("sot-banner")?.classList.toggle("hidden", on);
}

function setTab(name, refresh = true) {
  const allowed = new Set(["immowelt", "eigen", "sicherung"]);
  activeTab = allowed.has(name) ? name : "immowelt";
  document.querySelectorAll(".tab").forEach((btn) => {
    const on = btn.getAttribute("data-tab") === activeTab;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  });
  const imm = $("panel-immowelt");
  const eig = $("panel-eigen");
  const sic = $("panel-sicherung");
  if (imm) imm.classList.toggle("hidden", activeTab !== "immowelt");
  if (eig) eig.classList.toggle("hidden", activeTab !== "eigen");
  if (sic) sic.classList.toggle("hidden", activeTab !== "sicherung");
  if (location.hash.replace(/^#/, "") !== activeTab) {
    history.replaceState(null, "", `#${activeTab}`);
  }
  if (refresh) void refreshActiveTab();
}

function tabFromHash() {
  const h = (location.hash || "").replace(/^#/, "").toLowerCase();
  if (h === "eigen" || h === "sicherung") return h;
  return "immowelt";
}

function slugify(title, id) {
  const base = String(title || "objekt")
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const short = String(id || crypto.randomUUID()).replace(/-/g, "").slice(0, 8);
  return `${base || "objekt"}-${short}`;
}

function shortId(id) {
  return String(id || "").slice(0, 8);
}

function thumbUrl(item) {
  if (!item) return null;
  if (item.thumb) return item.thumb;
  if (item.url) return item.url;
  if (item.main_image_url) return item.main_image_url;
  const base = item.image_base || (item.gallery_bases && item.gallery_bases[0]);
  if (!base) return null;
  const b = String(base).replace(/^\/+/, "");
  const rel = b.includes("/") ? b : `assets/listings/${b}`;
  return `/${rel}.jpg`;
}

/* ---------- Abnahme modal (visual listing cards) ---------- */

function actionLabel(action) {
  const map = {
    hinzukommen: "Neu auf der Website",
    wegfallen: "Nicht mehr auf der Website",
    geändert: "Geändert",
    Sichtbarkeit: "Sichtbarkeit",
  };
  return map[action] || action;
}

function renderAbnahmeCard(item, kind) {
  const thumb = thumbUrl(item);
  const detail = item.detail ? `<span>${esc(item.detail)}</span>` : "";
  const price = item.price ? `<span>${esc(item.price)}</span>` : "";
  const media = thumb
    ? `<img class="abnahme-thumb" src="${esc(thumb)}" alt="" loading="lazy" width="72" height="54" />`
    : `<div class="abnahme-thumb-ph" aria-hidden="true">Kein Bild</div>`;
  return `<article class="abnahme-card kind-${esc(kind)}">
    ${media}
    <div class="abnahme-card-body">
      <strong title="${esc(item.title)}">${esc(item.title || "–")}</strong>
      <div class="abnahme-card-meta">
        <span class="badge">${esc(item.origin || "–")}</span>
        <span>${esc(item.location || "–")}</span>
        ${price}
        ${detail}
      </div>
    </div>
  </article>`;
}

function renderAbnahmeSections(changes) {
  const groups = {
    hinzukommen: [],
    wegfallen: [],
    geändert: [],
    Sichtbarkeit: [],
  };
  for (const c of changes || []) {
    const k = groups[c.action] ? c.action : "geändert";
    groups[k].push(c);
  }
  const parts = [];
  for (const [kind, items] of Object.entries(groups)) {
    if (!items.length) continue;
    parts.push(`<section class="abnahme-section" data-kind="${esc(kind)}">
      <h3>${esc(actionLabel(kind))} (${items.length})</h3>
      <div class="abnahme-cards">
        ${items.map((it) => renderAbnahmeCard(it, kind)).join("")}
      </div>
    </section>`);
  }
  if (!parts.length) {
    return `<p class="abnahme-empty">Es hat sich nichts geändert. Website trotzdem aktualisieren?</p>`;
  }
  return parts.join("");
}

/**
 * Abnahme: compact summary by default; full Ist/Neu cards behind „Details anzeigen“.
 * @param {{ changes?: object[], message?: string, empty_risk?: boolean, title?: string, lead?: string, ist?: object, neu?: object }} preview
 * @returns {Promise<boolean>}
 */
function countAbnahmeChanges(changes) {
  const c = { neu: 0, geändert: 0, entfernt: 0, sichtbarkeit: 0 };
  for (const x of changes || []) {
    if (x.action === "hinzukommen") c.neu += 1;
    else if (x.action === "wegfallen") c.entfernt += 1;
    else if (x.action === "Sichtbarkeit") c.sichtbarkeit += 1;
    else c.geändert += 1;
  }
  return c;
}

function renderAbnahmeSummaryHtml(preview) {
  const istN = Number(preview.ist?.count) || 0;
  const neuN = Number(preview.neu?.count) || 0;
  const c = countAbnahmeChanges(preview.changes);
  const sicht =
    c.sichtbarkeit > 0
      ? ` · <strong>Sichtbarkeit:</strong> ${c.sichtbarkeit}`
      : "";
  return `<div class="abnahme-summary" id="abnahme-summary">
    <p class="abnahme-summary-line"><strong>Jetzt online:</strong> ${istN} · <strong>Nach Übernahme:</strong> ${neuN}</p>
    <p class="abnahme-summary-line"><strong>Neu:</strong> ${c.neu} · <strong>Geändert:</strong> ${c.geändert} · <strong>Entfernt:</strong> ${c.entfernt}${sicht}</p>
  </div>`;
}

function renderIstNeuHtml(preview) {
  const ist = preview.ist || { label: "Bisher online", count: 0, listings: [] };
  const neu = preview.neu || { label: "Nach „Übernehmen“", count: 0, listings: [] };
  const col = (side, data) => {
    const cards = (data.listings || []).slice(0, 24).map((it) => renderAbnahmeCard(it, side)).join("");
    const more =
      (data.listings || []).length > 24
        ? `<p class="hint">… und ${(data.listings || []).length - 24} weitere</p>`
        : "";
    return `<section class="abnahme-side abnahme-side-${side}">
      <h3>${esc(data.label || side)} <span class="muted">(${Number(data.count) || 0})</span></h3>
      <div class="abnahme-cards">${cards || '<p class="abnahme-empty">Keine öffentlichen Inserate</p>'}${more}</div>
    </section>`;
  };
  return `<div class="abnahme-compare">${col("ist", ist)}${col("neu", neu)}</div>`;
}

function showAbnahme(preview) {
  return new Promise((resolve) => {
    const modal = $("abnahme-modal");
    const warn = $("abnahme-warning");
    $("abnahme-title").textContent = preview.title || "Änderungen übernehmen?";
    $("abnahme-lead").textContent =
      preview.lead ||
      "Kurz prüfen, ob die Zahlen stimmen. Mit „Übernehmen“ wird die Website geändert.";
    const detailsBody =
      renderIstNeuHtml(preview) + renderAbnahmeSections(preview.changes || []);
    $("abnahme-ist-neu").innerHTML =
      renderAbnahmeSummaryHtml(preview) +
      `<details class="abnahme-details-fold">
        <summary>Details anzeigen</summary>
        <div class="abnahme-details-body">${detailsBody}</div>
      </details>`;
    $("abnahme-sections").innerHTML = "";
    const confirmBtn = $("abnahme-confirm");
    if (confirmBtn) confirmBtn.textContent = "Übernehmen";
    if (preview.empty_risk) {
      warn.textContent =
        "Danach ist kein Inserat mehr auf der Website sichtbar. Bitte prüfen Sie das vorher.";
      warn.classList.remove("hidden");
    } else {
      warn.classList.add("hidden");
      warn.textContent = "";
    }
    modal.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    $("abnahme-confirm").focus();

    const cleanup = (ok) => {
      modal.classList.add("hidden");
      document.body.style.overflow = "";
      modal.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
      resolve(ok);
    };
    const onClick = (e) => {
      if (e.target.closest("[data-abnahme-cancel]")) cleanup(false);
      if (e.target.id === "abnahme-confirm") cleanup(true);
    };
    const onKey = (e) => {
      if (e.key === "Escape") cleanup(false);
    };
    modal.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
  });
}

/** Call mutating endpoint: first without confirm (preview), show modal, then confirm:true. */
async function confirmThenMutate(path, bodyBuilder) {
  const previewBody = bodyBuilder(false);
  const preview = await api(path, {
    method: "POST",
    body: JSON.stringify(previewBody),
  });
  if (preview.requires_confirm || preview.preview) {
    const ok = await showAbnahme({
      ...preview,
      title: preview.title || "Änderungen übernehmen?",
      lead: "Bisher online. Nach „Übernehmen“ wird die Änderung sichtbar. „Abbrechen“ lässt alles wie vorher.",
    });
    if (!ok) return { cancelled: true };
  }
  const confirmBody = bodyBuilder(true);
  if (preview.empty_risk) confirmBody.allow_empty = true;
  try {
    return await api(path, {
      method: "POST",
      body: JSON.stringify(confirmBody),
    });
  } catch (e) {
    if (e.status === 409 && e.data?.empty_risk) {
      const force = await showAbnahme({
        ...e.data,
        title: "Ohne öffentliche Inserate übernehmen?",
        lead: "Bitte prüfen Sie die Änderung. Wenn Sie abbrechen, bleibt alles wie vorher.",
      });
      if (!force) return { cancelled: true };
      return await api(path, {
        method: "POST",
        body: JSON.stringify({ ...confirmBody, allow_empty: true }),
      });
    }
    throw e;
  }
}

/* ---------- Auth / config ---------- */

async function loadConfig() {
  const res = await fetch("config.json", { cache: "no-store" });
  if (!res.ok) throw new Error("config.json fehlt");
  config = await res.json();
}

/** Convenience only: the address is kept on this device so it need not be typed again. */
const EMAIL_KEY = "eichmann_admin_email";
function rememberEmail(email) {
  try {
    localStorage.setItem(EMAIL_KEY, email);
  } catch {
    /* private mode etc. – then it is simply typed again */
  }
}
function recallEmail() {
  try {
    return localStorage.getItem(EMAIL_KEY) || "";
  } catch {
    return "";
  }
}

async function login(ev) {
  ev.preventDefault();
  const err = $("login-error");
  err.classList.add("hidden");
  $("login-ok")?.classList.add("hidden");
  try {
    const email = normalizeEmail($("email").value);
    const password = $("password").value;
    await api("/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    rememberEmail(email);
    $("password").value = "";
    sessionActive = true;
    showGate(false);
    setTab(tabFromHash(), false);
    startAutoRefresh();
    await reloadAll();
  } catch (e) {
    err.textContent = e.message || String(e);
    err.classList.remove("hidden");
  }
}

/* ---------- Passwort vergessen / neues Passwort über den Link aus der E-Mail ---------- */

/** The link in the mail carries its key after "#reset=" – that part never reaches a server log. */
function resetTokenFromUrl() {
  const m = /^#reset=([A-Za-z0-9_-]{40,64})$/.exec(location.hash || "");
  return m ? m[1] : null;
}

async function setupForgot() {
  let available = false;
  try {
    available = (await api("/auth/options")).reset_by_mail === true;
  } catch {
    /* then the plain hint stays */
  }
  $("forgot-line")?.classList.toggle("hidden", !available);
  $("forgot-unavailable")?.classList.toggle("hidden", available);
}

function openForgot() {
  const form = $("form-forgot");
  form.classList.remove("hidden");
  $("forgot-msg").classList.add("hidden");
  $("btn-forgot-send").disabled = false;
  $("forgot-email").value = normalizeEmail($("email").value) || recallEmail();
  $("forgot-email").focus();
}

async function onForgot(ev) {
  ev.preventDefault();
  const btn = $("btn-forgot-send");
  const msg = $("forgot-msg");
  const email = normalizeEmail($("forgot-email").value);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    msg.className = "err-box";
    msg.textContent = "Bitte geben Sie Ihre E-Mail-Adresse ein.";
    return;
  }
  btn.disabled = true;
  msg.className = "ok-box";
  try {
    const r = await api("/password/forgot", { method: "POST", body: JSON.stringify({ email, website: $("forgot-website").value }) });
    msg.textContent = `${r.message} Der Link gilt 30 Minuten. Kommt nichts an, können Sie es in ein paar Minuten noch einmal versuchen.`;
  } catch (e) {
    msg.className = "err-box";
    msg.textContent = e.message || "Das hat gerade nicht geklappt. Bitte versuchen Sie es gleich noch einmal.";
    btn.disabled = false;
  }
}

async function showReset(token) {
  $("view-gate").classList.add("hidden");
  $("view-app").classList.add("hidden");
  $("app-header").classList.add("hidden");
  $("view-reset").classList.remove("hidden");
  const stale = (text) => {
    $("form-reset").classList.add("hidden");
    $("reset-stale").classList.remove("hidden");
    $("reset-stale-text").textContent = text;
  };
  try {
    await api("/password/reset/check", { method: "POST", body: JSON.stringify({ token }) });
  } catch (e) {
    return stale(e.message || "Dieser Link ist abgelaufen oder wurde schon benutzt.");
  }
  $("reset-stale").classList.add("hidden");
  const form = $("form-reset");
  form.classList.remove("hidden");
  $("reset-new").focus();
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const err = $("reset-error");
    err.classList.add("hidden");
    $("btn-reset-save").disabled = true;
    try {
      const r = await api("/password/reset", {
        method: "POST",
        body: JSON.stringify({ token, new_password: $("reset-new").value, new_password_repeat: $("reset-repeat").value }),
      });
      form.reset();
      history.replaceState(null, "", location.pathname);
      showGate(true);
      const ok = $("login-ok");
      ok.textContent = r.message || "Ihr neues Passwort ist gespeichert. Bitte melden Sie sich jetzt damit an.";
      ok.classList.remove("hidden");
      $("password").focus();
    } catch (e) {
      if (e.status === 410) return stale(e.message);
      err.textContent = e.message || String(e);
      err.classList.remove("hidden");
    } finally {
      $("btn-reset-save").disabled = false;
    }
  };
}

async function logout() {
  sessionActive = false;
  stopAutoRefresh();
  try {
    await api("/logout", { method: "POST", body: "{}" });
  } catch {
    /* ignore */
  }
  showGate(true);
}

function openPasswordModal() {
  const modal = $("password-modal");
  if (!modal) return;
  const err = $("password-error");
  const ok = $("password-ok");
  if (err) {
    err.textContent = "";
    err.classList.add("hidden");
  }
  if (ok) {
    ok.textContent = "";
    ok.classList.add("hidden");
  }
  const form = $("form-password");
  if (form) form.reset();
  modal.classList.remove("hidden");
  const first = $("pw-current");
  if (first) setTimeout(() => first.focus(), 50);
}

function closePasswordModal() {
  const modal = $("password-modal");
  if (modal) modal.classList.add("hidden");
  const form = $("form-password");
  if (form) form.reset();
}

async function onChangePassword(ev) {
  ev.preventDefault();
  const err = $("password-error");
  const ok = $("password-ok");
  const saveBtn = $("btn-password-save");
  if (err) {
    err.textContent = "";
    err.classList.add("hidden");
  }
  if (ok) {
    ok.textContent = "";
    ok.classList.add("hidden");
  }
  const current = ($("pw-current") && $("pw-current").value) || "";
  const neu = ($("pw-new") && $("pw-new").value) || "";
  const wieder = ($("pw-repeat") && $("pw-repeat").value) || "";
  if (!current || !neu || !wieder) {
    if (err) {
      err.textContent = "Bitte alle drei Felder ausfüllen.";
      err.classList.remove("hidden");
    }
    return;
  }
  if (neu.length < 8) {
    if (err) {
      err.textContent = "Das neue Passwort muss mindestens 8 Zeichen haben.";
      err.classList.remove("hidden");
    }
    return;
  }
  if (neu !== wieder) {
    if (err) {
      err.textContent = "Neues Passwort und Wiederholung stimmen nicht überein.";
      err.classList.remove("hidden");
    }
    return;
  }
  if (saveBtn) saveBtn.disabled = true;
  try {
    const res = await api("/password", {
      method: "POST",
      body: JSON.stringify({
        current_password: current,
        new_password: neu,
        new_password_repeat: wieder,
      }),
    });
    if ($("pw-current")) $("pw-current").value = "";
    if ($("pw-new")) $("pw-new").value = "";
    if ($("pw-repeat")) $("pw-repeat").value = "";
    const msg =
      (res && res.message) ||
      "Passwort wurde geändert. Andere Anmeldungen sind abgelaufen.";
    if (ok) {
      ok.textContent = msg;
      ok.classList.remove("hidden");
    }
    toast(msg, "ok");
    setTimeout(() => closePasswordModal(), 1800);
  } catch (e) {
    if (err) {
      err.textContent = e.message || String(e);
      err.classList.remove("hidden");
    }
    toast(e.message || String(e), "err");
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

async function ensureSession() {
  try {
    const me = await api("/me");
    return me && me.authenticated;
  } catch {
    return false;
  }
}

/* ---------- Wächter & Sichtprüfung ---------- */
async function loadReviewMeta() {
  const el = $("review-meta");
  if (!el) return;
  try {
    const r = await api("/review/status");
    const m = r.meta;
    el.textContent = m
      ? `Letzte Sichtprüfung: ${new Date(m.updated_at).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })} · ${m.pages_after ?? "?"} Seiten · Datenvergleich: ${m.differences === 0 ? "keine Abweichung" : m.differences == null ? "–" : `${m.differences} Abweichung(en)`}`
      : "Noch keine Sichtprüfung auf dem Server.";
    if (!r.can_dispatch) el.textContent += " · Automatische Aktualisierung ist noch nicht eingerichtet.";
  } catch {
    el.textContent = "";
  }
}

async function onWatchdogRun() {
  const btn = $("btn-watchdog-run");
  const out = $("watchdog-result");
  btn.disabled = true;
  btn.textContent = "Prüft …";
  out.innerHTML = "";
  try {
    const r = await api("/watchdog/run", { method: "POST", body: JSON.stringify({}) });
    const lines = (r.watchdog?.lines || []).map((l) => `<div>${esc(l)}</div>`).join("");
    const badge = r.watchdog?.ok ? '<span class="badge ok">Wächter: in Ordnung</span>' : '<span class="badge miss">Wächter: Problem</span>';
    const review = r.review?.dispatched
      ? "Die Sichtprüfung wird jetzt neu erstellt (Aufnahmen aller Seiten, etwa 10–20 Minuten). Danach „Sichtprüfung öffnen“."
      : `Sichtprüfung nicht gestartet: ${esc(r.review?.reason || "unbekannt")}`;
    out.innerHTML = `<p>${badge}</p>${lines}<p>${review}</p>`;
  } catch (e) {
    out.textContent = e.message || "Wächter konnte nicht gestartet werden.";
  } finally {
    btn.disabled = false;
    btn.textContent = "Wächter jetzt starten";
    loadReviewMeta();
  }
}

/** Never show raw Node/Playwright stack traces in Immowelt-Stand. */
function publicImmoweltReason(reason, state) {
  const raw = String(reason || "").trim();
  const rejected =
    "Immowelt konnte nicht geladen werden. Die bisherige Website bleibt online.";
  const network =
    "Immowelt ist gerade nicht erreichbar. Die bisherige Website bleibt online.";
  const unsafe = "Die Immowelt-Daten waren unvollständig. Die bisherige Website bleibt online.";
  const awaiting = "Der Immowelt-Zugang fehlt noch. Die bisherige Website bleibt online.";
  const open = "Keine aktuellen Daten von Immowelt.";
  if (!raw) {
    if (state === "awaiting_api_key") return awaiting;
    if (state === "rejected") return rejected;
    return open;
  }
  if (
    /playwright|browsertype\.launch|ms-playwright|chromium|executable doesn|npx playwright|\/root\/|\.cache|node_modules|Error:|at Object\.|at async |\.mjs:\d+/i.test(
      raw
    ) ||
    (raw.includes("\n") && /at /.test(raw))
  ) {
    return rejected;
  }
  if (/datadome|net::|ECONN|ETIMEDOUT|timeout|HTTP 403|HTTP 429/i.test(raw)) return network;
  if (/snapshot incomplete|Empty listings|keeping last|last-known-good/i.test(raw)) return unsafe;
  if (/[\n\r\t`]|\/[a-z0-9._-]+\//i.test(raw) || raw.length > 400) return rejected;
  return raw;
}

/* ---------- Lists ---------- */

async function loadImmoweltCredentials() {
  const statusEl = $("iw-api-key-status");
  const kn = $("iw-kundennummer");
  const keyInput = $("iw-api-key");
  const replaceWrap = $("iw-replace-wrap");
  const replaceCb = $("iw-replace-key");
  if (!statusEl || !kn) return;
  try {
    const st = await api("/immowelt/credentials");
    kn.value = st.kundennummer || "";
    if (st.has_key) {
      statusEl.innerHTML = `<span class="badge ok">gesetzt</span> ${esc(st.masked_key || "••••")}`;
      if (replaceWrap) replaceWrap.classList.remove("hidden");
      if (keyInput) {
        keyInput.value = "";
        keyInput.placeholder = "Nur ausfüllen, um zu ersetzen";
        keyInput.disabled = !(replaceCb && replaceCb.checked);
      }
    } else {
      statusEl.innerHTML = `<span class="badge warn">fehlt</span> Bitte API-Schlüssel eintragen`;
      if (replaceWrap) replaceWrap.classList.add("hidden");
      if (keyInput) {
        keyInput.disabled = false;
        keyInput.placeholder = "API-Schlüssel eintragen";
      }
    }
  } catch (e) {
    statusEl.textContent = e.message || "Status konnte nicht geladen werden";
  }
}

async function onSaveImmoweltCredentials(ev) {
  ev.preventDefault();
  const msg = $("iw-credentials-msg");
  const btn = $("btn-iw-credentials-save");
  const kn = ($("iw-kundennummer")?.value || "").trim();
  const replaceCb = $("iw-replace-key");
  const replace_key = Boolean(replaceCb && replaceCb.checked);
  const api_key = ($("iw-api-key")?.value || "").trim();
  if (!kn) {
    if (msg) {
      msg.classList.add("err-box");
      msg.textContent = "Bitte die Kundennummer eintragen.";
    }
    return;
  }
  const statusBefore = await api("/immowelt/credentials").catch(() => ({ has_key: false }));
  if (!statusBefore.has_key && !api_key) {
    if (msg) {
      msg.classList.add("err-box");
      msg.textContent = "Bitte den API-Schlüssel eintragen.";
    }
    return;
  }
  if (statusBefore.has_key && replace_key && !api_key) {
    if (msg) {
      msg.classList.add("err-box");
      msg.textContent = "Bitte den neuen API-Schlüssel eintragen oder „Ersetzen“ abwählen.";
    }
    return;
  }
  if (msg) {
    msg.classList.remove("err-box");
    msg.textContent = "Speichere Zugang und starte Synchronisation …";
  }
  if (btn) btn.disabled = true;
  startImmoweltSyncLoading();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SYNC_CLIENT_TIMEOUT_MS);
  try {
    const res = await api("/immowelt/credentials", {
      method: "PUT",
      body: JSON.stringify({
        kundennummer: kn,
        api_key,
        replace_key,
        trigger_sync: true,
      }),
      signal: ctrl.signal,
    });
    if ($("iw-api-key")) $("iw-api-key").value = "";
    if (replaceCb) replaceCb.checked = false;
    await loadImmoweltCredentials();
    if (msg) msg.textContent = res.message || "Zugang gespeichert.";
    if (res.sync) {
      await applyImmoweltSyncSuccess(res.sync);
    } else {
      setImmoweltSyncOutcome(res.message || "Zugang gespeichert.", "ok");
      await loadImmoweltHealth();
    }
  } catch (e) {
    const errMsg = e.message || String(e);
    if (msg) {
      msg.classList.add("err-box");
      msg.textContent = errMsg;
    }
    setImmoweltSyncOutcome(errMsg, "err");
  } finally {
    clearTimeout(timer);
    clearImmoweltSyncLongWait();
    setImmoweltSyncBusy(false);
    if (btn) btn.disabled = false;
  }
}

async function loadImmoweltHealth() {
  const line = $("immowelt-health-line");
  const detail = $("immowelt-health-detail");
  if (!line || !detail) return;
  const fmt = (iso) => {
    if (!iso) return "unbekannt";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "unbekannt";
    return new Intl.DateTimeFormat("de-DE", {
      timeZone: "Europe/Berlin",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .format(d)
      .replace(",", "");
  };
  let status = {};
  try {
    const st = await api("/status");
    status = st.immowelt_sync || {};
  } catch {
    try {
      const res = await fetch("../data/immowelt-sync-status.json?t=" + Date.now(), {
        cache: "no-store",
      });
      if (res.ok) status = await res.json();
    } catch {
      /* ignore */
    }
  }
  try {
    const prev = await api("/publish/preview");
    updatePendingBanner(prev);
  } catch {
    updatePendingBanner(null);
  }
  renderEasyStatus(status);
  const valid = status.last_valid_at || null;
  if (status.state === "current") {
    line.innerHTML = `<span class="badge ok">OK</span> aktuelle Inserate von Immowelt ${esc(fmt(valid))}`;
    detail.textContent =
      "Die Inserate werden automatisch und vollständig von Immowelt übernommen. Änderungen bitte direkt bei Immowelt vornehmen.";
  } else if (status.state === "pending_confirmation") {
    line.innerHTML = `<span class="badge warn">Bestätigung läuft</span> zuletzt geprüft ${esc(fmt(valid))}`;
    detail.textContent =
      "Bei Immowelt fehlen ungewöhnlich viele Inserate. Die Website übernimmt das erst, wenn Immowelt es beim nächsten Abgleich genauso bestätigt.";
  } else if (status.state === "failed") {
    line.innerHTML = `<span class="badge miss">Website bleibt</span> letzter Abgleich fehlgeschlagen · zuletzt vollständig ${esc(fmt(valid))}`;
    detail.textContent = publicImmoweltReason(status.reason, "rejected");
  } else if (status.state === "held") {
    line.innerHTML = `<span class="badge warn">Angehalten</span> zuletzt vollständig ${esc(fmt(valid))}`;
    detail.textContent = publicImmoweltReason(status.reason, "held");
  } else if (status.state === "migration_required") {
    line.innerHTML = `<span class="badge warn">Umstellung offen</span> zuletzt geprüft ${esc(fmt(valid))}`;
    detail.textContent = publicImmoweltReason(status.reason, "migration_required");
  } else if (status.state === "awaiting_api_key") {
    line.innerHTML = `<span class="badge warn">Zugang fehlt</span> zuletzt geprüft ${esc(fmt(valid))}`;
    detail.textContent = publicImmoweltReason(status.reason, "awaiting_api_key");
  } else if (status.state === "rejected") {
    line.innerHTML = `<span class="badge miss">Website bleibt</span> Immowelt konnte nicht geladen werden · ${esc(fmt(valid))}`;
    detail.textContent = publicImmoweltReason(status.reason, "rejected");
  } else {
    line.innerHTML = `<span class="badge warn">Keine aktuellen Daten</span> zuletzt geprüft ${esc(fmt(valid))}`;
    detail.textContent = publicImmoweltReason(status.reason, status.state || "open");
  }
}

function updatePendingBanner(preview) {
  const banner = $("pending-banner");
  const text = $("pending-banner-text");
  if (!banner) return;
  const pending = preview?.publish_pending;
  const has = preview?.has_changes || (pending && pending.reason);
  if (!has) {
    banner.classList.add("hidden");
    return;
  }
  banner.classList.remove("hidden");
  if (text) {
    text.textContent = preview?.empty_risk
      ? "Wenn Sie übernehmen, verschwinden alle Inserate von der Website. Bitte prüfen."
      : "Eine Änderung wartet. Prüfen Sie sie. Mit „Übernehmen“ wird sie auf der Website sichtbar.";
  }
}

/** "heute, 09:39 Uhr" – how a person would say it. */
function friendlyTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const day = (x) => new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", year: "numeric" }).format(x);
  const time = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" }).format(d);
  const today = day(new Date());
  const yesterday = day(new Date(Date.now() - 86_400_000));
  const when = day(d) === today ? "heute" : day(d) === yesterday ? "gestern" : `am ${day(d).slice(0, 6)}`;
  return `${when}, ${time} Uhr`;
}

/**
 * The one thing the owner needs to know, in plain words: is everything fine, and do I have to do
 * anything? Technical detail stays in the "Technik" tab.
 */
function easyStatusOf(status, now = Date.now()) {
  const count = status?.published?.count;
  const offers = count == null ? "Ihre Angebote" : count === 1 ? "1 Angebot" : `${count} Angebote`;
  const last = friendlyTime(status?.last_success_at || status?.last_valid_at);
  const lastMs = Date.parse(status?.last_success_at || status?.last_valid_at || "");
  const overdue = Number.isFinite(lastMs) && now - lastMs > (status?.stale_after_minutes || 120) * 60_000;
  const helper = "Chris Hohlfeld";
  const stays = `Ihre Website bleibt online und zeigt weiter den Stand von ${last || "zuletzt"}.`;
  switch (status?.state) {
    case "current":
      if (overdue) {
        return { kind: "warn", icon: "!", title: "Der Abgleich ist überfällig", text: `Die Website hat Immowelt zuletzt ${last} abgefragt. ${stays}`, todo: `Drücken Sie unten „Jetzt mit Immowelt abgleichen“. Kommt die Meldung danach wieder: bitte ${helper} Bescheid geben.` };
      }
      return { kind: "ok", icon: "✓", title: "Alles in Ordnung", text: `Ihre Website zeigt ${offers} von Immowelt. Zuletzt abgeglichen: ${last || "gerade eben"}.`, todo: "Sie müssen nichts tun." };
    case "pending_confirmation":
      return { kind: "warn", icon: "!", title: "Die Website wartet zur Sicherheit kurz ab", text: "Bei Immowelt fehlen plötzlich viele Angebote. Damit nichts versehentlich verschwindet, übernimmt die Website das erst beim nächsten Abgleich in etwa 30 Minuten.", todo: "Haben Sie die Angebote absichtlich entfernt? Dann müssen Sie nichts tun. Wenn nicht: bitte bei Immowelt nachsehen." };
    case "failed":
    case "rejected":
      return { kind: "err", icon: "!", title: "Der Abgleich hat gerade nicht geklappt", text: `Die Website konnte Immowelt nicht vollständig lesen. ${stays}`, todo: `Meist erledigt sich das beim nächsten Abgleich von selbst. Steht diese Meldung morgen noch hier: bitte ${helper} Bescheid geben.` };
    case "held":
      return { kind: "warn", icon: "!", title: "Der Abgleich ist vorübergehend angehalten", text: `Der automatische Abgleich wurde bewusst gestoppt. ${stays}`, todo: `Sie müssen nichts tun. ${helper} schaltet ihn wieder ein.` };
    case "awaiting_api_key":
    case "migration_required":
      return { kind: "warn", icon: "!", title: "Die Einrichtung ist noch nicht abgeschlossen", text: `Der Abgleich mit Immowelt ist noch nicht fertig eingerichtet. ${stays}`, todo: `Bitte ${helper} Bescheid geben.` };
    default:
      return { kind: "warn", icon: "!", title: "Der Stand ist gerade nicht bekannt", text: "Die Website konnte ihren eigenen Stand nicht abrufen.", todo: `Laden Sie diese Seite neu. Bleibt die Meldung: bitte ${helper} Bescheid geben.` };
  }
}

function greeting(now = new Date()) {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", hour: "2-digit", hour12: false }).formatToParts(now).find((p) => p.type === "hour")?.value);
  const hello = hour >= 5 && hour < 11 ? "Guten Morgen" : hour >= 11 && hour < 18 ? "Guten Tag" : "Guten Abend";
  const date = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", weekday: "long", day: "numeric", month: "long" }).format(now);
  return `${hello}! Heute ist ${date}.`;
}

function renderEasyStatus(status) {
  const box = $("easy-status");
  if (!box) return;
  const hello = $("easy-hello");
  if (hello) hello.textContent = greeting();
  const v = easyStatusOf(status);
  box.className = `easy-status is-${v.kind}`;
  $("easy-status-icon").textContent = v.icon;
  $("easy-status-title").textContent = v.title;
  $("easy-status-text").textContent = v.text;
  $("easy-status-todo").innerHTML = `<strong>Was muss ich tun?</strong> ${esc(v.todo)}`;
}

function renderImmowelt() {
  const box = $("immowelt-cards");
  // Immowelt ist die einzige Quelle: Sichtbarkeit, Texte und Bilder werden dort gepflegt und
  // automatisch übernommen – hier gibt es dafür bewusst keinen Schalter.
  const online = immoweltListings.filter((L) => L.active !== false && L.site_hidden !== true);
  $("immowelt-count").textContent = `(${online.length})`;
  if (!online.length) {
    box.innerHTML = `<p class="muted">Im Moment steht kein Angebot von Immowelt auf der Website.</p>`;
    return;
  }
  box.innerHTML = online
    .map((L) => {
      const local = L.local_url ? `../${L.local_url}` : null;
      const ref = String(L.reference_number || L.facts?.Referenznummer || "").trim().toUpperCase();
      const title = String(L.title || "Angebot");
      const thumb = thumbUrl(L);
      const facts = [L.rooms, L.living_area, L.location].filter(Boolean).join(" · ");
      return `<article class="offer-card">
        ${thumb ? `<img src="${esc(thumb)}" alt="" loading="lazy" />` : `<div class="offer-card-noimg" aria-hidden="true"></div>`}
        <div class="offer-card-body">
          <strong>${ref && !title.toUpperCase().startsWith(ref) ? `${esc(ref)} · ` : ""}${esc(title)}</strong>
          <div class="offer-card-price">${esc(L.price || "–")}</div>
          <div class="muted">${esc(facts)}</div>
          ${local ? `<a class="btn btn-outline btn-sm" href="${esc(local)}" target="_blank" rel="noopener">Auf der Website ansehen</a>` : ""}
        </div>
      </article>`;
    })
    .join("");
}

function renderEigen() {
  const box = $("eigen-cards");
  $("eigen-count").textContent = `(${eigenListings.length})`;
  if (!eigenListings.length) {
    box.innerHTML = `<p class="muted">Sie haben keine eigenen Angebote angelegt. Das ist in Ordnung – Ihre Immowelt-Angebote stehen unter „Start“.</p>`;
    return;
  }
  box.innerHTML = eigenListings
    .map((L) => {
      const local = L.local_url ? `../${L.local_url}` : "#";
      const hidden = L.site_hidden === true;
      const inactive = L.active === false;
      const thumb = thumbUrl(L);
      const facts = [L.rooms, L.living_area, L.location].filter(Boolean).join(" · ");
      const state = hidden || inactive
        ? '<span class="badge warn">nicht auf der Website</span>'
        : '<span class="badge ok">auf der Website</span>';
      return `<article class="offer-card${hidden || inactive ? " is-hidden" : ""}">
        ${thumb ? `<img src="${esc(thumb)}" alt="" loading="lazy" />` : `<div class="offer-card-noimg" aria-hidden="true"></div>`}
        <div class="offer-card-body">
          <strong>${esc(L.title || "Angebot")}</strong>
          <div class="offer-card-price">${esc(L.price || "–")}</div>
          <div class="muted">${esc(facts)}</div>
          <div>${state}</div>
          <div class="offer-card-actions">
            <button type="button" class="btn btn-primary btn-sm" data-edit="${esc(L.id)}">Bearbeiten</button>
            <button type="button" class="btn btn-outline btn-sm" data-toggle-hidden="${esc(L.id)}">${hidden ? "Wieder zeigen" : "Verstecken"}</button>
            ${L.local_url && !hidden && !inactive ? `<a class="btn btn-outline btn-sm" href="${esc(local)}" target="_blank" rel="noopener">Ansehen</a>` : ""}
            <button type="button" class="btn btn-outline btn-sm" data-delete="${esc(L.id)}" style="color:var(--err)">Löschen</button>
          </div>
        </div>
      </article>`;
    })
    .join("");
  box.querySelectorAll("[data-toggle-hidden]").forEach((btn) => {
    btn.addEventListener("click", () => toggleVisibility(btn.getAttribute("data-toggle-hidden")));
  });
  box.querySelectorAll("[data-edit]").forEach((btn) => {
    btn.addEventListener("click", () => openEditor(btn.getAttribute("data-edit")));
  });
  box.querySelectorAll("[data-delete]").forEach((btn) => {
    btn.addEventListener("click", () => deleteEigenListing(btn.getAttribute("data-delete")));
  });
}

async function reloadImmowelt() {
  const data = await api("/listings?origin=immowelt");
  immoweltListings = data.listings || [];
  renderImmowelt();
  await loadImmoweltHealth();
  await loadImmoweltCredentials();
}

async function reloadEigen() {
  const data = await api("/listings?origin=eigen");
  eigenListings = data.listings || [];
  renderEigen();
}

async function reloadAll() {
  const jobs = [reloadImmowelt(), reloadEigen()];
  if (activeTab === "sicherung" || $("panel-sicherung")) {
    jobs.push(reloadSicherung());
  }
  await Promise.all(jobs);
}

function adminViewVisible() {
  const app = $("view-app");
  return sessionActive && !document.hidden && app && !app.classList.contains("hidden");
}

async function refreshActiveTab() {
  if (!adminViewVisible()) return;
  if (refreshInFlight) return refreshInFlight;
  const loader =
    activeTab === "eigen"
      ? reloadEigen()
      : activeTab === "sicherung"
        ? reloadSicherung()
        : reloadImmowelt();
  refreshInFlight = loader
    .catch((e) => toast(e.message || String(e), "err"))
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

async function refreshAllVisible() {
  if (!adminViewVisible()) return;
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = reloadAll()
    .catch((e) => toast(e.message || String(e), "err"))
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  refreshTimer = setInterval(() => {
    if (adminViewVisible()) void refreshAllVisible();
  }, REFRESH_INTERVAL_MS);
}

async function toggleVisibility(id) {
  const L = immoweltListings.find((x) => x.id === id) || eigenListings.find((x) => x.id === id);
  if (!L) return;
  const nextHidden = L.site_hidden !== true;
  try {
    const res = await confirmThenMutate("/visibility", (confirm) => ({
      id,
      site_hidden: nextHidden,
      confirm,
    }));
    if (res.cancelled) {
      toast("Abgebrochen. Alles bleibt wie vorher.", "");
      return;
    }
    toast(nextHidden ? "Das Angebot ist jetzt versteckt" : "Das Angebot ist wieder auf der Website", "ok");
    await reloadAll();
  } catch (e) {
    toast(e.message || String(e), "err");
  }
}

/* ---------- Gallery editor ---------- */

function syncGalleryFromListing(L) {
  const bases = Array.isArray(L?.gallery_bases) ? L.gallery_bases : [];
  const images = Array.isArray(L?.images) ? L.images : [];
  editorGallery = bases.map((base, i) => ({
    base,
    url: images[i] || thumbUrl({ image_base: base }) || "",
  }));
  if (!editorGallery.length && L?.main_image_url) {
    editorGallery = [{ base: null, url: L.main_image_url }];
  }
  pendingFiles = [];
  const fileInput = $("f-images");
  if (fileInput) fileInput.value = "";
  const btn = $("btn-upload-images");
  if (btn) btn.disabled = true;
  renderGalleryThumbs();
}

function renderGalleryThumbs() {
  const wrap = $("gallery-thumbs");
  if (!wrap) return;
  if (!editorGallery.length) {
    wrap.innerHTML = `<p class="hint" style="margin:0">Noch keine Bilder. Wählen Sie Fotos aus und laden Sie sie hoch.</p>`;
    return;
  }
  wrap.innerHTML = editorGallery
    .map((g, i) => {
      const src = g.url || thumbUrl({ image_base: g.base }) || "";
      return `<div class="gallery-thumb${i === 0 ? " is-main" : ""}" data-idx="${i}">
        ${src ? `<img src="${esc(src)}" alt="Foto ${i + 1}" width="96" height="72" loading="lazy" />` : `<div class="abnahme-thumb-ph">?</div>`}
        <div class="thumb-meta"><span>${i === 0 ? "Haupt" : i + 1}</span></div>
        <div class="thumb-actions">
          <button type="button" class="btn btn-outline btn-sm" data-gal-up="${i}" ${i === 0 ? "disabled" : ""} title="Nach vorn">↑</button>
          <button type="button" class="btn btn-outline btn-sm" data-gal-down="${i}" ${i === editorGallery.length - 1 ? "disabled" : ""} title="Nach hinten">↓</button>
          <button type="button" class="btn btn-outline btn-sm" data-gal-del="${i}" title="Entfernen">×</button>
        </div>
      </div>`;
    })
    .join("");
  wrap.querySelectorAll("[data-gal-up]").forEach((btn) => {
    btn.addEventListener("click", () => moveGallery(Number(btn.getAttribute("data-gal-up")), -1));
  });
  wrap.querySelectorAll("[data-gal-down]").forEach((btn) => {
    btn.addEventListener("click", () => moveGallery(Number(btn.getAttribute("data-gal-down")), 1));
  });
  wrap.querySelectorAll("[data-gal-del]").forEach((btn) => {
    btn.addEventListener("click", () => deleteGalleryAt(Number(btn.getAttribute("data-gal-del"))));
  });
}

async function moveGallery(idx, delta) {
  const j = idx + delta;
  if (j < 0 || j >= editorGallery.length) return;
  const tmp = editorGallery[idx];
  editorGallery[idx] = editorGallery[j];
  editorGallery[j] = tmp;
  renderGalleryThumbs();
  const id = $("f-id").value;
  const bases = editorGallery.map((g) => g.base).filter(Boolean);
  if (id && bases.length === editorGallery.length) {
    try {
      const res = await api("/eigen/images/reorder", {
        method: "POST",
        body: JSON.stringify({ id, gallery_bases: bases }),
      });
      if (res.listing) applySavedListing(res.listing);
    } catch (e) {
      toast(e.message || String(e), "err");
    }
  }
}

async function deleteGalleryAt(idx) {
  const item = editorGallery[idx];
  if (!item) return;
  if (!confirm("Dieses Bild entfernen?")) return;
  const id = $("f-id").value;
  if (id && item.base) {
    try {
      const res = await api("/eigen/images/delete", {
        method: "POST",
        body: JSON.stringify({ id, base: item.base }),
      });
      if (res.listing) {
        applySavedListing(res.listing);
        syncGalleryFromListing(res.listing);
        toast("Bild entfernt. Die Website ändert sich erst nach „Übernehmen“.", "ok");
        return;
      }
    } catch (e) {
      toast(e.message || String(e), "err");
      return;
    }
  }
  editorGallery.splice(idx, 1);
  renderGalleryThumbs();
}

function onFilesChosen() {
  const input = $("f-images");
  pendingFiles = input?.files ? Array.from(input.files) : [];
  const btn = $("btn-upload-images");
  if (btn) btn.disabled = !pendingFiles.length;
  const msg = $("gallery-msg");
  if (msg) {
    msg.textContent = pendingFiles.length
      ? `${pendingFiles.length} Datei(en) bereit zum Hochladen`
      : "";
  }
}

async function uploadPendingImages() {
  const id = $("f-id").value || crypto.randomUUID();
  $("f-id").value = id;
  if (!pendingFiles.length) {
    toast("Keine Dateien gewählt", "err");
    return;
  }
  const msg = $("gallery-msg");
  if (msg) msg.textContent = "Lade hoch …";
  const fd = new FormData();
  fd.append("id", id);
  const title = $("f-title").value.trim();
  if (title) fd.append("title", title);
  const slug = $("f-slug").value.trim();
  if (slug) fd.append("slug", slug);
  for (const f of pendingFiles) fd.append("images", f, f.name);
  try {
    const res = await api("/eigen/images", { method: "POST", body: fd });
    if (res.listing) {
      applySavedListing(res.listing);
      syncGalleryFromListing(res.listing);
    }
    pendingFiles = [];
    const input = $("f-images");
    if (input) input.value = "";
    const btn = $("btn-upload-images");
    if (btn) btn.disabled = true;
    if (msg) msg.textContent = "Bilder hochgeladen. Mit „Übernehmen“ erscheinen sie auf der Website.";
    toast("Bilder hochgeladen. Die Website ändert sich erst nach „Übernehmen“.", "ok");
  } catch (e) {
    if (msg) msg.textContent = e.message || String(e);
    toast(e.message || String(e), "err");
  }
}

function applySavedListing(saved) {
  const idx = eigenListings.findIndex((x) => x.id === saved.id);
  if (idx >= 0) eigenListings[idx] = saved;
  else eigenListings.unshift(saved);
  renderEigen();
}

/* ---------- Eigen editor ---------- */

function openEditor(id) {
  const L = id ? eigenListings.find((x) => x.id === id) : null;
  $("card-editor").classList.remove("hidden");
  $("editor-heading").textContent = L ? "Angebot bearbeiten" : "Neues Angebot";
  $("btn-delete").style.display = L ? "" : "none";
  $("f-id").value = L?.id || crypto.randomUUID();
  $("f-title").value = L?.title || "";
  $("f-slug").value = L?.slug || "";
  $("f-price").value = L?.price || "";
  $("f-status").value = L?.status || "Kauf";
  $("f-rooms").value = L?.rooms || "";
  $("f-living").value = L?.living_area || "";
  $("f-location").value = L?.location || "";
  $("f-type").value = L?.type || "";
  $("f-short").value = L?.short_description || "";
  $("f-description").value = L?.description || "";
  $("f-image").value = L?.main_image_url || "";
  $("f-active").checked = L?.active !== false;
  $("f-site-hidden").checked = L?.site_hidden === true;
  $("form-msg").textContent = "";
  syncGalleryFromListing(L);
  $("card-editor").scrollIntoView({ behavior: "smooth", block: "start" });
}

function closeEditor() {
  $("card-editor").classList.add("hidden");
  $("form-eigen").reset();
  $("f-status").value = "Kauf";
  $("f-active").checked = true;
  $("btn-delete").style.display = "none";
  editorGallery = [];
  pendingFiles = [];
  renderGalleryThumbs();
}

function buildListing() {
  const id = $("f-id").value || crypto.randomUUID();
  const title = $("f-title").value.trim();
  if (!title) throw new Error("Titel fehlt");
  const slug = ($("f-slug").value.trim() || slugify(title, id)).replace(/^\/+|\/+$/g, "");
  const urlFallback = $("f-image").value.trim() || null;
  const bases = editorGallery.map((g) => g.base).filter(Boolean);
  const images = editorGallery.map((g) => g.url).filter(Boolean);
  let main = images[0] || urlFallback;
  let gallery_bases = bases;
  let image_base = bases[0] || null;
  if (!gallery_bases.length && urlFallback) {
    main = urlFallback;
    gallery_bases = [];
    image_base = null;
  }
  return {
    id,
    slug,
    local_url: `objekt/${slug}.html`,
    title,
    price: $("f-price").value.trim() || null,
    status: $("f-status").value.trim() || "Kauf",
    location: $("f-location").value.trim() || null,
    rooms: $("f-rooms").value.trim() || null,
    living_area: $("f-living").value.trim() || null,
    type: $("f-type").value.trim() || null,
    short_description: $("f-short").value.trim() || null,
    description: $("f-description").value.trim() || null,
    main_image_url: main,
    images: images.length ? images : main ? [main] : [],
    gallery_bases: bases,
    image_base,
    active: $("f-active").checked,
    detail_page: true,
    site_hidden: $("f-site-hidden").checked,
    origin: "eigen",
    source: "eigen",
    sync_policy: "independent",
  };
}

async function onSubmit(ev) {
  ev.preventDefault();
  const msg = $("form-msg");
  msg.textContent = "Änderungen werden geprüft …";
  try {
    const listing = buildListing();
    const res = await confirmThenMutate("/eigen", (confirm) => ({ listing, confirm }));
    if (res.cancelled) {
      msg.textContent = "Abgebrochen. Die Website bleibt unverändert.";
      toast("Abgebrochen", "");
      return;
    }
    const saved = res.listing || listing;
    applySavedListing(saved);
    syncGalleryFromListing(saved);
    msg.textContent = "Gespeichert. Die Website wurde geändert.";
    toast("Angebot gespeichert", "ok");
    $("f-id").value = saved.id;
    $("btn-delete").style.display = "";
    await reloadAll();
  } catch (e) {
    msg.textContent = e.message || String(e);
    toast(e.message || String(e), "err");
  }
}

/** Eigen delete only — Immowelt never gets this. Always via Abnahme (confirmThenMutate). */
async function deleteEigenListing(id) {
  if (!id) return;
  const editorOpen = !$("card-editor").classList.contains("hidden") && $("f-id").value === id;
  if (editorOpen) $("form-msg").textContent = "Löschung wird geprüft …";
  try {
    const res = await confirmThenMutate("/eigen/delete", (confirm) => ({ id, confirm }));
    if (res.cancelled) {
      if (editorOpen) $("form-msg").textContent = "Löschen abgebrochen. Die Website bleibt unverändert.";
      toast("Löschen abgebrochen. Die Website bleibt unverändert.", "");
      return;
    }
    eigenListings = eigenListings.filter((x) => x.id !== id);
    renderEigen();
    if (editorOpen) closeEditor();
    toast("Angebot gelöscht", "ok");
    await reloadAll();
  } catch (e) {
    if (editorOpen) $("form-msg").textContent = e.message || String(e);
    toast(e.message || String(e), "err");
  }
}

async function onDelete() {
  await deleteEigenListing($("f-id").value);
}

/** Immowelt Sync: never silent — Abnahme modal OR durable Immowelt-Stand status. */
async function applyImmoweltSyncSuccess(syncRes) {
  const syncMeta = syncRes.sync || {};
  const failed =
    syncRes.ok === false ||
    syncMeta.failed === true ||
    syncMeta.soft_fail === true ||
    syncMeta.status_state === "rejected" ||
    syncMeta.status_state === "awaiting_api_key";
  if (failed) {
    const msg = publicImmoweltReason(
      syncMeta.public_error || syncRes.message,
      syncMeta.status_state || "rejected"
    );
    await reloadAll();
    setImmoweltSyncOutcome(msg, "err");
    return;
  }
  if (!syncRes.has_changes) {
    const msg =
      syncRes.message ||
      "Fertig. Bei Immowelt hat sich nichts geändert – Ihre Website ist aktuell.";
    await reloadAll();
    setImmoweltSyncOutcome(msg, "ok");
    return;
  }
  setImmoweltSyncOutcome(
    "Änderungen gefunden. Bitte prüfen und dann „Übernehmen“ oder „Abbrechen“ wählen.",
    "warn"
  );
  const ok = await showAbnahme({
    ...syncRes,
    title: "Immowelt-Änderungen übernehmen?",
    lead:
      "Bisher online. Nach „Übernehmen“ wird die Änderung sichtbar. Eigene Inserate bleiben erhalten.",
  });
  if (!ok) {
    await reloadAll();
    setImmoweltSyncOutcome("Abgebrochen. Alles bleibt wie vorher.", "ok");
    return;
  }
  await api("/publish", {
    method: "POST",
    body: JSON.stringify({
      confirm: true,
      allow_empty: syncRes.empty_risk === true,
    }),
  });
  await reloadAll();
  setImmoweltSyncOutcome("Fertig. Ihre Website zeigt jetzt den neuen Stand von Immowelt.", "ok");
}

async function onImmoweltSync() {
  startImmoweltSyncLoading();
  try {
    const syncRes = await postImmoweltSync();
    await applyImmoweltSyncSuccess(syncRes);
  } catch (e) {
    // Never stay on loading after abort/499/empty — button must unlock.
    clearImmoweltSyncLongWait();
    setImmoweltSyncBusy(false);
    if (isSyncDisconnectError(e)) {
      const resolved = await resolveImmoweltSyncAfterDisconnect();
      try {
        await reloadAll();
      } catch {
        /* ignore */
      }
      if (resolved.kind === "changes" && resolved.preview) {
        setImmoweltSyncOutcome(resolved.message, "warn");
        try {
          await applyImmoweltSyncSuccess({
            ...resolved.preview,
            ok: true,
            has_changes: true,
            sync: { failed: false },
          });
        } catch (inner) {
          setImmoweltSyncOutcome(
            publicImmoweltReason(inner.message || String(inner), "rejected"),
            "err"
          );
        }
        return;
      }
      if (resolved.kind === "rejected") {
        setImmoweltSyncOutcome(resolved.message, "err");
        return;
      }
      if (resolved.kind === "ok") {
        setImmoweltSyncOutcome(resolved.message, "ok");
        return;
      }
      setImmoweltSyncOutcome(SYNC_DISCONNECT_MSG, "err");
      return;
    }
    const msg = publicImmoweltReason(e.message || String(e), "rejected");
    setImmoweltSyncOutcome(msg, "err");
  } finally {
    clearImmoweltSyncLongWait();
    setImmoweltSyncBusy(false);
  }
}

/** Pending Übernahme (e.g. after sync without confirm) — same Abnahme gate. */
async function onReviewPending() {
  try {
    const preview = await api("/publish/preview");
    if (!preview.has_changes && !preview.publish_pending) {
      toast("Keine Änderungen offen", "ok");
      return;
    }
    const ok = await showAbnahme({
      ...preview,
      title: "Änderungen übernehmen?",
      lead: "Vergleichen Sie die bisherige Website mit der neuen Version. Mit „Übernehmen“ wird die Änderung sichtbar.",
    });
    if (!ok) {
      toast("Abgebrochen. Alles bleibt wie vorher.", "");
      return;
    }
    await api("/publish", {
      method: "POST",
      body: JSON.stringify({
        confirm: true,
        allow_empty: preview.empty_risk === true,
      }),
    });
    toast("Änderungen übernommen", "ok");
    await reloadAll();
  } catch (e) {
    toast(e.message || String(e), "err");
  }
}


function formatSnapTime(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString("de-DE", {
      timeZone: "Europe/Berlin",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return String(iso);
  }
}

async function reloadSicherung() {
  const data = await api("/snapshots");
  snapshotsList = data.snapshots || [];
  const meta = $("sicherung-meta");
  if (meta) {
    meta.textContent =
      "Es werden die " +
      (data.retention || 14) +
      " neuesten Stände behalten. Aktuell: " +
      snapshotsList.length +
      ".";
  }
  renderSicherung();
  await reloadDoSicherung();
}

function renderSicherung() {
  const tb = $("sicherung-tbody");
  if (!tb) return;
  if (!snapshotsList.length) {
    tb.innerHTML =
      '<tr><td colspan="5" class="muted">Noch keine Sicherung vorhanden. Klicken Sie auf „Sicherung erstellen“.</td></tr>';
    return;
  }
  tb.innerHTML = snapshotsList
    .map((s) => {
      const commit = s.deploy_commit ? esc(s.deploy_commit) : "—";
      return (
        "<tr>" +
        "<td><code>" +
        esc(s.id) +
        "</code></td>" +
        "<td>" +
        esc(formatSnapTime(s.created_at)) +
        "</td>" +
        "<td>" +
        esc(s.total_human || "—") +
        "</td>" +
        "<td><code>" +
        commit +
        "</code></td>" +
        '<td class="row-actions">' +
        '<button type="button" class="btn btn-outline btn-sm" data-download-id="' +
        esc(s.id) +
        '">Download</button> ' +
        '<button type="button" class="btn btn-outline btn-sm" data-restore-id="' +
        esc(s.id) +
        '">Zurückspielen</button>' +
        "</td>" +
        "</tr>"
      );
    })
    .join("");
  tb.querySelectorAll("[data-download-id]").forEach((btn) => {
    btn.addEventListener("click", () => downloadSnapshot(btn.getAttribute("data-download-id")));
  });
  tb.querySelectorAll("[data-restore-id]").forEach((btn) => {
    btn.addEventListener("click", () => openRestoreModal(btn.getAttribute("data-restore-id")));
  });
}

function downloadSnapshot(id) {
  if (!id) return;
  // Same-origin navigation keeps the session cookie; avoids JSON parse of binary.
  const a = document.createElement("a");
  a.href = API + "/snapshots/" + encodeURIComponent(id) + "/download";
  a.download = "eichmann-sicherung-" + id + ".tar.gz";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast("Download gestartet: " + id, "ok");
}

function formatDoBytes(gb) {
  if (gb == null || gb === "") return "—";
  const n = Number(gb);
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(2) + " GB";
}

function renderDoSicherung() {
  const tb = $("do-sicherung-tbody");
  const meta = $("do-sicherung-meta");
  const errEl = $("do-sicherung-error");
  const stepsEl = $("do-restore-steps");
  if (errEl) {
    errEl.textContent = "";
    errEl.classList.add("hidden");
  }
  if (!tb) return;

  if (doSnapshotsMeta && doSnapshotsMeta.error) {
    if (errEl) {
      errEl.textContent = doSnapshotsMeta.error;
      errEl.classList.remove("hidden");
    }
    if (meta) meta.textContent = "";
    tb.innerHTML =
      '<tr><td colspan="6" class="muted">Keine Server-Snapshots geladen.</td></tr>';
    if (stepsEl) stepsEl.innerHTML = "";
    return;
  }

  const droplet = doSnapshotsMeta && doSnapshotsMeta.droplet;
  if (meta) {
    meta.textContent = droplet
      ? "Droplet „" +
        (droplet.name || "—") +
        "“ · ID " +
        (droplet.id || "—") +
        " · " +
        doSnapshotsList.length +
        " Snapshot(s). Wiederherstellen nur über die DigitalOcean-Website (Links in der Tabelle)."
      : "";
  }

  const steps = (doSnapshotsMeta && doSnapshotsMeta.restore_steps_de) || [];
  if (stepsEl) {
    stepsEl.innerHTML = steps.map((s) => "<li>" + esc(s) + "</li>").join("");
  }

  if (!doSnapshotsList.length) {
    tb.innerHTML =
      '<tr><td colspan="6" class="muted">Noch kein Server-Snapshot vorhanden.</td></tr>';
    return;
  }

  tb.innerHTML = doSnapshotsList
    .map((s) => {
      const rebuild =
        s.console_rebuild_url ||
        (doSnapshotsMeta && doSnapshotsMeta.console_rebuild_url) ||
        "https://cloud.digitalocean.com/droplets";
      const images =
        s.console_images_url ||
        "https://cloud.digitalocean.com/images?i=" + encodeURIComponent(String(s.id));
      return (
        "<tr>" +
        "<td><code>" +
        esc(s.name || "—") +
        "</code></td>" +
        "<td><code>" +
        esc(String(s.id || "")) +
        "</code></td>" +
        "<td>" +
        esc(formatSnapTime(s.created_at)) +
        "</td>" +
        "<td>" +
        esc(formatDoBytes(s.size_gigabytes)) +
        (s.min_disk_size != null ? " <span class=\"muted\">(min. " + esc(String(s.min_disk_size)) + " GB)</span>" : "") +
        "</td>" +
        "<td>" +
        esc(s.status || "—") +
        "</td>" +
        '<td class="row-actions">' +
        '<a class="btn btn-outline btn-sm" href="' +
        esc(rebuild) +
        '" target="_blank" rel="noopener noreferrer" title="Öffnet DigitalOcean: Einstellungen → Rebuild">In DO-Konsole wiederherstellen</a> ' +
        '<a class="btn btn-outline btn-sm" href="' +
        esc(images) +
        '" target="_blank" rel="noopener noreferrer">Snapshot in DO</a>' +
        "</td>" +
        "</tr>"
      );
    })
    .join("");
}

async function reloadDoSicherung() {
  const tb = $("do-sicherung-tbody");
  try {
    const data = await api("/do-snapshots");
    doSnapshotsList = data.snapshots || [];
    doSnapshotsMeta = data;
    renderDoSicherung();
  } catch (e) {
    doSnapshotsList = [];
    doSnapshotsMeta = {
      error: e.message || String(e),
      code: e.code || e.data?.code,
    };
    renderDoSicherung();
  }
}

async function onCreateSnapshot() {
  const btn = $("btn-snapshot-create");
  if (btn) btn.disabled = true;
  try {
    toast("Sicherung wird erstellt …", "");
    const res = await api("/snapshots", {
      method: "POST",
      body: JSON.stringify({ reason: "manual" }),
    });
    toast(
      "Sicherung „" + (res.snapshot?.id || "") + "“ erstellt (" + (res.snapshot?.total_human || "") + ")",
      "ok"
    );
    await reloadSicherung();
  } catch (e) {
    toast(e.message || String(e), "err");
  } finally {
    if (btn) btn.disabled = false;
  }
}

function closeRestoreModal() {
  const modal = $("restore-modal");
  if (modal) modal.classList.add("hidden");
  restoreTargetId = null;
  const phrase = $("restore-phrase");
  if (phrase) phrase.value = "";
  const err = $("restore-error");
  if (err) {
    err.textContent = "";
    err.classList.add("hidden");
  }
  const conf = $("restore-confirm");
  if (conf) conf.disabled = true;
}

async function openRestoreModal(id) {
  restoreTargetId = id;
  const modal = $("restore-modal");
  const box = $("restore-overwrite");
  const phrase = $("restore-phrase");
  const err = $("restore-error");
  const conf = $("restore-confirm");
  if (err) {
    err.textContent = "";
    err.classList.add("hidden");
  }
  if (phrase) phrase.value = "";
  if (conf) conf.disabled = true;
  if (box) box.innerHTML = "<p class=\"muted\">Lade …</p>";
  if (modal) modal.classList.remove("hidden");
  try {
    const preview = await api("/snapshots/" + encodeURIComponent(id) + "/preview");
    if (box) {
      const items = preview.overwrite || [];
      box.innerHTML =
        "<p><strong>Stand:</strong> <code>" +
        esc(preview.id) +
        "</code> · " +
        esc(formatSnapTime(preview.created_at)) +
        (preview.deploy_commit ? " · Version <code>" + esc(preview.deploy_commit) + "</code>" : "") +
        "</p>" +
        "<p class=\"hint\">Folgendes wird überschrieben:</p>" +
        "<ul class=\"restore-list\">" +
        items
          .map(
            (it) =>
              "<li><strong>" +
              esc(it.label) +
              "</strong>" +
              (it.detail ? " – " + esc(it.detail) : "") +
              "</li>"
          )
          .join("") +
        "</ul>";
    }
  } catch (e) {
    if (box) box.innerHTML = "";
    if (err) {
      err.textContent = e.message || String(e);
      err.classList.remove("hidden");
    }
  }
}

function normalizeRestorePhrase(value) {
  return String(value || "").trim().toUpperCase();
}

function onRestorePhraseInput() {
  const phrase = $("restore-phrase");
  const conf = $("restore-confirm");
  if (!phrase || !conf) return;
  conf.disabled = normalizeRestorePhrase(phrase.value) !== "RESTAURIEREN";
}

async function onConfirmRestore() {
  if (!restoreTargetId) return;
  const phrase = $("restore-phrase");
  const err = $("restore-error");
  const conf = $("restore-confirm");
  const typed = normalizeRestorePhrase(phrase && phrase.value);
  if (typed !== "RESTAURIEREN") {
    if (err) {
      err.textContent = "Bitte RESTAURIEREN eingeben (Groß-/Kleinschreibung egal).";
      err.classList.remove("hidden");
    }
    return;
  }
  if (conf) conf.disabled = true;
  try {
    toast("Sicherung wird zurückgespielt …", "");
    await api("/snapshots/restore", {
      method: "POST",
      body: JSON.stringify({
        id: restoreTargetId,
        confirm_phrase: typed,
      }),
    });
    closeRestoreModal();
    toast("Sicherung zurückgespielt. Seite wird neu geladen …", "ok");
    setTimeout(() => {
      location.reload();
    }, 1500);
  } catch (e) {
    if (err) {
      err.textContent = e.message || String(e);
      err.classList.remove("hidden");
    }
    toast(e.message || String(e), "err");
    if (conf) conf.disabled = false;
  }
}

function bind() {
  $("form-login").addEventListener("submit", login);
  const remembered = recallEmail();
  if (remembered && $("email")) {
    $("email").value = remembered;
    $("email").removeAttribute("autofocus");
    setTimeout(() => $("password")?.focus(), 50);
  }
  const showPw = $("password-show");
  if (showPw) showPw.addEventListener("change", () => ($("password").type = showPw.checked ? "text" : "password"));
  $("btn-forgot")?.addEventListener("click", openForgot);
  $("btn-forgot-cancel")?.addEventListener("click", () => $("form-forgot").classList.add("hidden"));
  $("form-forgot")?.addEventListener("submit", onForgot);
  $("btn-reset-again")?.addEventListener("click", () => {
    history.replaceState(null, "", location.pathname);
    showGate(true);
    openForgot();
  });
  $("reset-show")?.addEventListener("change", (ev) => {
    for (const id of ["reset-new", "reset-repeat"]) $(id).type = ev.target.checked ? "text" : "password";
  });
  $("btn-logout").addEventListener("click", logout);
  const pwBtn = $("btn-password");
  if (pwBtn) pwBtn.addEventListener("click", openPasswordModal);
  const pwForm = $("form-password");
  if (pwForm) pwForm.addEventListener("submit", onChangePassword);
  document.querySelectorAll("[data-password-cancel]").forEach((el) => {
    el.addEventListener("click", closePasswordModal);
  });
  const syncBtn = $("btn-immowelt-sync");
  if (syncBtn) syncBtn.addEventListener("click", onImmoweltSync);
  const wdBtn = $("btn-watchdog-run");
  if (wdBtn) wdBtn.addEventListener("click", onWatchdogRun);
  loadReviewMeta();
  const credForm = $("form-immowelt-credentials");
  if (credForm) credForm.addEventListener("submit", onSaveImmoweltCredentials);
  const replaceCb = $("iw-replace-key");
  if (replaceCb) {
    replaceCb.addEventListener("change", () => {
      const keyInput = $("iw-api-key");
      if (keyInput) keyInput.disabled = !replaceCb.checked;
    });
  }
  $("btn-new-eigen").addEventListener("click", () => openEditor(null));
  $("btn-cancel").addEventListener("click", closeEditor);
  $("btn-delete").addEventListener("click", onDelete);
  $("form-eigen").addEventListener("submit", onSubmit);
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => setTab(btn.getAttribute("data-tab")));
  });
  window.addEventListener("hashchange", () => setTab(tabFromHash()));
  const refreshOnReturn = () => {
    if (adminViewVisible()) void refreshAllVisible();
  };
  document.addEventListener("visibilitychange", refreshOnReturn);
  window.addEventListener("focus", refreshOnReturn);

  const fileInput = $("f-images");
  if (fileInput) fileInput.addEventListener("change", onFilesChosen);
  const uploadBtn = $("btn-upload-images");
  if (uploadBtn) uploadBtn.addEventListener("click", uploadPendingImages);
  const reviewBtn = $("btn-review-pending");
  if (reviewBtn) reviewBtn.addEventListener("click", onReviewPending);

  const snapBtn = $("btn-snapshot-create");
  if (snapBtn) snapBtn.addEventListener("click", onCreateSnapshot);
  const restorePhrase = $("restore-phrase");
  if (restorePhrase) restorePhrase.addEventListener("input", onRestorePhraseInput);
  const restoreConfirm = $("restore-confirm");
  if (restoreConfirm) restoreConfirm.addEventListener("click", onConfirmRestore);
  document.querySelectorAll("[data-restore-cancel]").forEach((el) => {
    el.addEventListener("click", closeRestoreModal);
  });
}

async function boot() {
  bind();
  try {
    await loadConfig();
  } catch (e) {
    document.body.innerHTML = `<p class="err-box" style="margin:2rem">Admin-Konfiguration fehlt: ${esc(e.message)}</p>`;
    return;
  }
  void setupForgot();
  const resetToken = resetTokenFromUrl();
  if (resetToken) {
    await showReset(resetToken);
    return;
  }
  if (await ensureSession()) {
    sessionActive = true;
    showGate(false);
    setTab(tabFromHash(), false);
    startAutoRefresh();
    try {
      await reloadAll();
    } catch (e) {
      toast(e.message || String(e), "err");
    }
  } else {
    showGate(true);
  }
}

boot().catch((e) => {
  console.error(e);
  const err = $("login-error");
  if (err) {
    err.textContent = e.message || String(e);
    err.classList.remove("hidden");
  }
});

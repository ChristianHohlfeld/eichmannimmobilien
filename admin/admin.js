/**
 * Unified Admin – Immowelt visibility + Eigen CRUD + multi-image upload.
 * Auth: session cookie via /admin/api/
 * Public site changes require Abnahme modal (confirm:true).
 */
const API = "/admin/api";

let config = null;
let immoweltListings = [];
let eigenListings = [];
let activeTab = "immowelt";
/** @type {{ base: string, url: string }[]} */
let editorGallery = [];
let pendingFiles = [];
let sessionActive = false;
let refreshInFlight = null;
let refreshTimer = null;
const REFRESH_INTERVAL_MS = 45_000;

const $ = (id) => document.getElementById(id);

function toast(msg, type = "") {
  const el = $("toast");
  if (!el) return;
  el.textContent = msg;
  el.className = "toast" + (type ? " " + type : "");
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 4500);
}

/** Durable status under Immowelt-Stand — stays until next Sync (not toast-only). */
const SYNC_LOADING_MSG =
  "Immowelt-Sync läuft… Bitte warten. Das kann ein paar Minuten dauern.";
const SYNC_LOADING_LONG_MSG =
  "Immowelt-Sync läuft noch… Dauert länger als üblich — bitte weiter warten.";
let syncLongWaitTimer = null;

function clearImmoweltSyncLongWait() {
  if (syncLongWaitTimer) {
    clearTimeout(syncLongWaitTimer);
    syncLongWaitTimer = null;
  }
}

function setImmoweltSyncOutcome(msg, kind = "") {
  const el = $("immowelt-sync-outcome");
  if (!el) return;
  if (!msg) {
    el.textContent = "";
    el.className = "sync-outcome hidden";
    return;
  }
  el.className = "sync-outcome" + (kind ? " " + kind : "");
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

function setImmoweltSyncBusy(busy) {
  const btn = $("btn-immowelt-sync");
  if (!btn) return;
  btn.disabled = !!busy;
  btn.setAttribute("aria-busy", busy ? "true" : "false");
  btn.textContent = busy ? "Läuft …" : "Immowelt Sync";
}

function startImmoweltSyncLoading() {
  clearImmoweltSyncLongWait();
  setImmoweltSyncBusy(true);
  setImmoweltSyncOutcome(SYNC_LOADING_MSG, "progress");
  // Soft hint only — keep loading state; never invent a fake fail while request is open.
  syncLongWaitTimer = setTimeout(() => {
    setImmoweltSyncOutcome(SYNC_LOADING_LONG_MSG, "progress");
  }, 150_000);
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
  } catch {
    const err = new Error("Verbindung unterbrochen. Bitte erneut versuchen.");
    err.status = 0;
    err.network = true;
    throw err;
  }
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      const err = new Error("Ungültige Server-Antwort. Bitte erneut versuchen.");
      err.status = res.status;
      err.raw = text.slice(0, 200);
      throw err;
    }
  }
  const gatewayFail = res.status === 499 || res.status === 502 || res.status === 504;
  if (!res.ok || gatewayFail) {
    let msg = (data && (data.error || data.message)) || "";
    if (!msg) {
      if (res.status === 499) {
        msg = "Die Anfrage wurde abgebrochen (Zeitüberschreitung). Bitte erneut versuchen.";
      } else if (res.status === 502 || res.status === 504) {
        msg = "Der Server hat nicht rechtzeitig geantwortet. Bitte erneut versuchen.";
      } else if (!text) {
        msg = "Leere Antwort vom Server. Bitte erneut versuchen.";
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
    const err = new Error("Leere Antwort vom Server. Bitte erneut versuchen.");
    err.status = res.status;
    throw err;
  }
  return data;
}

function showGate(on) {
  $("view-gate").classList.toggle("hidden", !on);
  $("view-app").classList.toggle("hidden", on);
  $("app-header").classList.toggle("hidden", on);
  $("sot-banner").classList.toggle("hidden", on);
}

function setTab(name, refresh = true) {
  activeTab = name === "eigen" ? "eigen" : "immowelt";
  document.querySelectorAll(".tab").forEach((btn) => {
    const on = btn.getAttribute("data-tab") === activeTab;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  });
  $("panel-immowelt").classList.toggle("hidden", activeTab !== "immowelt");
  $("panel-eigen").classList.toggle("hidden", activeTab !== "eigen");
  if (location.hash.replace(/^#/, "") !== activeTab) {
    history.replaceState(null, "", `#${activeTab}`);
  }
  if (refresh) void refreshActiveTab();
}

function tabFromHash() {
  const h = (location.hash || "").replace(/^#/, "").toLowerCase();
  return h === "eigen" ? "eigen" : "immowelt";
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
 * Show Abnahme modal with visual listing cards.
 * @param {{ changes?: object[], message?: string, empty_risk?: boolean, title?: string, lead?: string }} preview
 * @returns {Promise<boolean>}
 */
function renderIstNeu(preview) {
  const wrap = $("abnahme-ist-neu");
  if (!wrap) return;
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
  wrap.innerHTML = `<div class="abnahme-compare">${col("ist", ist)}${col("neu", neu)}</div>`;
}

function showAbnahme(preview) {
  return new Promise((resolve) => {
    const modal = $("abnahme-modal");
    const warn = $("abnahme-warning");
    $("abnahme-title").textContent = preview.title || "Änderungen übernehmen?";
    $("abnahme-lead").textContent =
      preview.lead ||
      "Vergleichen Sie die bisherige Website mit der neuen Version. Mit „Übernehmen“ wird die Änderung sichtbar.";
    renderIstNeu(preview);
    $("abnahme-sections").innerHTML = renderAbnahmeSections(preview.changes || []);
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

async function login(ev) {
  ev.preventDefault();
  const err = $("login-error");
  err.classList.add("hidden");
  try {
    const email = normalizeEmail($("email").value);
    const password = $("password").value;
    const allowed = (config.admin_emails || []).map(normalizeEmail);
    if (allowed.length && !allowed.includes(email)) {
      throw new Error("E-Mail nicht freigeschaltet");
    }
    await api("/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
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

async function ensureSession() {
  try {
    const me = await api("/me");
    return me && me.authenticated;
  } catch {
    return false;
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
  const valid = status.last_valid_at || null;
  if (status.state === "current") {
    line.innerHTML = `<span class="badge ok">OK</span> aktuelle Inserate von Immowelt ${esc(fmt(valid))}`;
    detail.textContent =
      "Die Inserate kommen aus Immowelt. Hier wählen Sie nur, ob sie auf unserer Website sichtbar sind.";
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

function renderImmowelt() {
  const tbody = $("immowelt-tbody");
  $("immowelt-count").textContent = `(${immoweltListings.length})`;
  if (!immoweltListings.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted">Keine Immowelt-Objekte vorhanden.</td></tr>`;
    return;
  }
  tbody.innerHTML = immoweltListings
    .map((L) => {
      const local = L.local_url ? `../${L.local_url}` : "#";
      const ref = String(L.reference_number || L.facts?.Referenznummer || "")
        .trim()
        .toUpperCase();
      const visibilityBadge =
        L.site_hidden === true
          ? ' <span class="badge warn">ausgeblendet</span>'
          : ' <span class="badge ok">öffentlich</span>';
      const toggleLabel = L.site_hidden === true ? "Einblenden" : "Ausblenden";
      const toggleClass = L.site_hidden === true ? "btn-primary" : "btn-outline";
      return `<tr>
        <td>
          <strong>${ref ? `<span class="badge">${esc(ref)}</span> ` : ""}${esc(L.title || "–")}</strong>
          <div><span class="badge">Immowelt</span>${visibilityBadge}</div>
        </td>
        <td>${esc(L.location || "–")}</td>
        <td>${esc(L.price || "–")}</td>
        <td><span class="badge">${esc(L.status || "–")}</span></td>
        <td>
          <button type="button" class="btn ${toggleClass} btn-sm" data-toggle-hidden="${esc(L.id)}" title="${toggleLabel} auf der Website">${toggleLabel}</button>
          ${
            L.site_hidden === true
              ? ""
              : `<a class="btn btn-outline btn-sm" href="${esc(local)}" target="_blank" rel="noopener">Seite</a>`
          }
        </td>
      </tr>`;
    })
    .join("");
  tbody.querySelectorAll("[data-toggle-hidden]").forEach((btn) => {
    btn.addEventListener("click", () =>
      toggleVisibility(btn.getAttribute("data-toggle-hidden"))
    );
  });
}

function renderEigen() {
  const tbody = $("eigen-tbody");
  $("eigen-count").textContent = `(${eigenListings.length})`;
  if (!eigenListings.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted">Keine Eigen-Inserate vorhanden.</td></tr>`;
    return;
  }
  tbody.innerHTML = eigenListings
    .map((L) => {
      const local = L.local_url ? `../${L.local_url}` : "#";
      const nImg = (L.gallery_bases || L.images || []).length;
      const visibilityBadge =
        L.site_hidden === true
          ? ' <span class="badge warn">ausgeblendet</span>'
          : ' <span class="badge ok">öffentlich</span>';
      const toggleLabel = L.site_hidden === true ? "Einblenden" : "Ausblenden";
      const toggleClass = L.site_hidden === true ? "btn-primary" : "btn-outline";
      return `<tr>
        <td>
          <strong>${esc(L.title || "–")}</strong>
          <div><span class="badge ok">nur bei uns</span>${visibilityBadge}
          ${L.active === false ? ' <span class="badge warn">inaktiv</span>' : ""}
          ${nImg ? ` <span class="badge">${nImg} Fotos</span>` : ""}</div>
        </td>
        <td>${esc(L.location || "–")}</td>
        <td>${esc(L.price || "–")}</td>
        <td>${esc(L.status || "–")}</td>
        <td>
          <button type="button" class="btn ${toggleClass} btn-sm" data-toggle-hidden="${esc(L.id)}" title="${toggleLabel} auf der Website">${toggleLabel}</button>
          <button type="button" class="btn btn-outline btn-sm" data-edit="${esc(L.id)}">Bearbeiten</button>
          <button type="button" class="btn btn-outline btn-sm" data-delete="${esc(L.id)}" style="color:var(--err)" title="Eigen-Inserat löschen">Löschen</button>
          ${
            L.local_url && L.site_hidden !== true && L.active !== false
              ? `<a class="btn btn-outline btn-sm" href="${esc(local)}" target="_blank" rel="noopener">Seite</a>`
              : ""
          }
        </td>
      </tr>`;
    })
    .join("");
  tbody.querySelectorAll("[data-toggle-hidden]").forEach((btn) => {
    btn.addEventListener("click", () =>
      toggleVisibility(btn.getAttribute("data-toggle-hidden"))
    );
  });
  tbody.querySelectorAll("[data-edit]").forEach((btn) => {
    btn.addEventListener("click", () => openEditor(btn.getAttribute("data-edit")));
  });
  tbody.querySelectorAll("[data-delete]").forEach((btn) => {
    btn.addEventListener("click", () => deleteEigenListing(btn.getAttribute("data-delete")));
  });
}

async function reloadImmowelt() {
  const data = await api("/listings?origin=immowelt");
  immoweltListings = data.listings || [];
  renderImmowelt();
  await loadImmoweltHealth();
}

async function reloadEigen() {
  const data = await api("/listings?origin=eigen");
  eigenListings = data.listings || [];
  renderEigen();
}

async function reloadAll() {
  await Promise.all([reloadImmowelt(), reloadEigen()]);
}

function adminViewVisible() {
  const app = $("view-app");
  return sessionActive && !document.hidden && app && !app.classList.contains("hidden");
}

async function refreshActiveTab() {
  if (!adminViewVisible()) return;
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (activeTab === "eigen" ? reloadEigen() : reloadImmowelt())
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
    toast(nextHidden ? "Auf der Website ausgeblendet" : "Auf der Website eingeblendet", "ok");
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
  $("editor-heading").textContent = L ? "Eigen-Inserat bearbeiten" : "Neues Eigen-Inserat";
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
    toast("Eigen-Inserat übernommen", "ok");
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
    toast("Eigen-Inserat gelöscht", "ok");
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
async function onImmoweltSync() {
  startImmoweltSyncLoading();
  toast("Immowelt-Sync läuft…");
  try {
    const syncRes = await api("/immowelt/sync", {
      method: "POST",
      body: JSON.stringify({}),
    });
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
        "Keine Änderungen. Die Website bleibt wie sie ist.";
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
    setImmoweltSyncOutcome("Übernommen. Die Website ist aktualisiert.", "ok");
  } catch (e) {
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

function bind() {
  $("form-login").addEventListener("submit", login);
  $("btn-logout").addEventListener("click", logout);
  const syncBtn = $("btn-immowelt-sync");
  if (syncBtn) syncBtn.addEventListener("click", onImmoweltSync);
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
}

async function boot() {
  bind();
  try {
    await loadConfig();
  } catch (e) {
    document.body.innerHTML = `<p class="err-box" style="margin:2rem">Admin-Konfiguration fehlt: ${esc(e.message)}</p>`;
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

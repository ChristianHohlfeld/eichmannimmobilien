/**
 * Unified Admin – Immowelt visibility + Eigen CRUD.
 * Auth: email + password → HttpOnly session cookie via /admin/api/
 * No GitHub PAT. Immowelt account is never written.
 */
const API = "/admin/api";

let config = null;
let immoweltListings = [];
let eigenListings = [];
let activeTab = "immowelt";

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
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  };
  const res = await fetch(`${API}${path}`, opts);
  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { ok: false, error: text.slice(0, 200) };
    }
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
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

function setTab(name) {
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
    // Client-side gate mirrors server (UX only); real auth is cookie from API
    const allowed = (config.admin_emails || []).map(normalizeEmail);
    if (allowed.length && !allowed.includes(email)) {
      throw new Error("E-Mail nicht freigeschaltet");
    }
    await api("/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    $("password").value = "";
    showGate(false);
    setTab(tabFromHash());
    await reloadAll();
  } catch (e) {
    err.textContent = e.message || String(e);
    err.classList.remove("hidden");
  }
}

async function logout() {
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
  const valid = status.last_valid_at || null;
  if (status.state === "current") {
    line.innerHTML = `<span class="badge ok">OK</span> offizieller Immowelt-API-Stand ${esc(fmt(valid))}`;
    detail.textContent =
      "Immowelt ist fachliche Quelle; nur validierte Snapshots werden übernommen. Hier nur Sichtbarkeit.";
  } else if (status.state === "awaiting_api_key") {
    line.innerHTML = `<span class="badge warn">API-Key fehlt</span> letzter gültiger Stand ${esc(fmt(valid))}`;
    detail.textContent = status.reason || "Offizielle Immowelt-API vorbereitet; Key fehlt noch.";
  } else if (status.state === "rejected") {
    line.innerHTML = `<span class="badge miss">LKG aktiv</span> Abruf verworfen · ${esc(fmt(valid))}`;
    detail.textContent = status.reason || "Unsicherer Abruf verworfen. Last Known Good bleibt online.";
  } else {
    line.innerHTML = `<span class="badge warn">Status offen</span> letzter Stand ${esc(fmt(valid))}`;
    detail.textContent = status.reason || "Kein bestätigter aktueller Immowelt-API-Snapshot.";
  }
}

function renderImmowelt() {
  const tbody = $("immowelt-tbody");
  $("immowelt-count").textContent = `(${immoweltListings.length})`;
  if (!immoweltListings.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted">Keine Immowelt-Objekte im Spiegel.</td></tr>`;
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
          <div class="mono muted">${esc(shortId(L.id))}</div>
        </td>
        <td>${esc(L.location || "–")}</td>
        <td>${esc(L.price || "–")}</td>
        <td><span class="badge">${esc(L.status || "–")}</span></td>
        <td>
          <button type="button" class="btn ${toggleClass} btn-sm" data-toggle-hidden="${esc(L.id)}">${toggleLabel}</button>
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
      toggleVisibility(btn.getAttribute("data-toggle-hidden"), "immowelt")
    );
  });
}

function renderEigen() {
  const tbody = $("eigen-tbody");
  $("eigen-count").textContent = `(${eigenListings.length})`;
  if (!eigenListings.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted">Keine Eigen-Inserate. Lege eines an.</td></tr>`;
    return;
  }
  tbody.innerHTML = eigenListings
    .map((L) => {
      const local = L.local_url ? `../${L.local_url}` : "#";
      return `<tr>
        <td>
          <strong>${esc(L.title || "–")}</strong>
          <div><span class="badge ok">nur bei uns</span>
          ${L.site_hidden ? ' <span class="badge warn">ausgeblendet</span>' : ""}
          ${L.active === false ? ' <span class="badge warn">inaktiv</span>' : ""}</div>
          <div class="mono muted">${esc(L.id)}</div>
        </td>
        <td>${esc(L.location || "–")}</td>
        <td>${esc(L.price || "–")}</td>
        <td>${esc(L.status || "–")}</td>
        <td>
          <button type="button" class="btn btn-outline btn-sm" data-edit="${esc(L.id)}">Bearbeiten</button>
          ${
            L.local_url && L.site_hidden !== true && L.active !== false
              ? `<a class="btn btn-outline btn-sm" href="${esc(local)}" target="_blank" rel="noopener">Seite</a>`
              : ""
          }
        </td>
      </tr>`;
    })
    .join("");
  tbody.querySelectorAll("[data-edit]").forEach((btn) => {
    btn.addEventListener("click", () => openEditor(btn.getAttribute("data-edit")));
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

async function toggleVisibility(id) {
  const L = immoweltListings.find((x) => x.id === id) || eigenListings.find((x) => x.id === id);
  if (!L) return;
  const nextHidden = L.site_hidden !== true;
  try {
    await api("/visibility", {
      method: "POST",
      body: JSON.stringify({ id, site_hidden: nextHidden }),
    });
    L.site_hidden = nextHidden;
    toast(nextHidden ? "Auf Website ausgeblendet" : "Wieder eingeblendet", "ok");
    renderImmowelt();
    renderEigen();
  } catch (e) {
    toast(e.message || String(e), "err");
  }
}

function openEditor(id) {
  const L = id ? eigenListings.find((x) => x.id === id) : null;
  $("card-editor").classList.remove("hidden");
  $("editor-heading").textContent = L ? "Eigen-Inserat bearbeiten" : "Neues Eigen-Inserat";
  $("btn-delete").style.display = L ? "" : "none";
  $("f-id").value = L?.id || "";
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
}

function closeEditor() {
  $("card-editor").classList.add("hidden");
  $("form-eigen").reset();
  $("f-status").value = "Kauf";
  $("f-active").checked = true;
  $("btn-delete").style.display = "none";
}

function buildListing() {
  const id = $("f-id").value || crypto.randomUUID();
  const title = $("f-title").value.trim();
  if (!title) throw new Error("Titel fehlt");
  const slug = ($("f-slug").value.trim() || slugify(title, id)).replace(/^\/+|\/+$/g, "");
  const image = $("f-image").value.trim() || null;
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
    main_image_url: image,
    images: image ? [image] : [],
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
  msg.textContent = "Speichere …";
  try {
    const listing = buildListing();
    const res = await api("/eigen", {
      method: "POST",
      body: JSON.stringify({ listing }),
    });
    const saved = res.listing || listing;
    const idx = eigenListings.findIndex((x) => x.id === saved.id);
    if (idx >= 0) eigenListings[idx] = saved;
    else eigenListings.unshift(saved);
    renderEigen();
    msg.textContent = "Gespeichert und publiziert.";
    toast("Eigen-Inserat gespeichert", "ok");
    $("f-id").value = saved.id;
    $("btn-delete").style.display = "";
  } catch (e) {
    msg.textContent = e.message || String(e);
    toast(e.message || String(e), "err");
  }
}

async function onDelete() {
  const id = $("f-id").value;
  if (!id) return;
  if (!confirm("Eigen-Inserat wirklich löschen?")) return;
  $("form-msg").textContent = "Lösche …";
  try {
    await api("/eigen/delete", {
      method: "POST",
      body: JSON.stringify({ id }),
    });
    eigenListings = eigenListings.filter((x) => x.id !== id);
    renderEigen();
    closeEditor();
    toast("Eigen-Inserat gelöscht", "ok");
  } catch (e) {
    $("form-msg").textContent = e.message || String(e);
    toast(e.message || String(e), "err");
  }
}

async function onPublish() {
  try {
    toast("Publiziere …");
    await api("/publish", { method: "POST", body: "{}" });
    toast("Site aus SQLite publiziert", "ok");
    await reloadAll();
  } catch (e) {
    toast(e.message || String(e), "err");
  }
}

function bind() {
  $("form-login").addEventListener("submit", login);
  $("btn-logout").addEventListener("click", logout);
  $("btn-publish").addEventListener("click", onPublish);
  $("btn-reload-immowelt").addEventListener("click", () =>
    reloadImmowelt()
      .then(() => toast("Immowelt-Liste aktualisiert", "ok"))
      .catch((e) => toast(e.message || String(e), "err"))
  );
  $("btn-reload-eigen").addEventListener("click", () =>
    reloadEigen()
      .then(() => toast("Eigen-Liste aktualisiert", "ok"))
      .catch((e) => toast(e.message || String(e), "err"))
  );
  $("btn-new-eigen").addEventListener("click", () => openEditor(null));
  $("btn-cancel").addEventListener("click", closeEditor);
  $("btn-delete").addEventListener("click", onDelete);
  $("form-eigen").addEventListener("submit", onSubmit);
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => setTab(btn.getAttribute("data-tab")));
  });
  window.addEventListener("hashchange", () => setTab(tabFromHash()));
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
    showGate(false);
    setTab(tabFromHash());
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

/**
 * Eigen-Inserate Admin
 * Auth: password_plus_session_pat (shared with Immowelt admin).
 * Writes: repository_dispatch admin_eigen_save → SSH → SQLite SoT on droplet.
 * Immowelt account is never written.
 */
const STORAGE_AUTH = "ei_admin_auth";
const STORAGE_PAT = "ei_admin_github_pat";

let config = null;
let listings = [];

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

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
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

function isAuthed() {
  return sessionStorage.getItem(STORAGE_AUTH) === "1" && Boolean(sessionStorage.getItem(STORAGE_PAT));
}

function getPat() {
  return sessionStorage.getItem(STORAGE_PAT) || "";
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

async function loadConfig() {
  const res = await fetch("../config.json", { cache: "no-store" });
  if (!res.ok) throw new Error("config.json fehlt");
  config = await res.json();
}

function repoApi(path) {
  const [owner, repo] = String(config.repo).split("/");
  return `https://api.github.com/repos/${owner}/${repo}${path}`;
}

async function gh(path, options = {}) {
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${getPat()}`,
    "X-GitHub-Api-Version": "2022-11-28",
    ...(options.headers || {}),
  };
  const res = await fetch(repoApi(path), { ...options, headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub ${res.status}: ${body.slice(0, 280)}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function showApp(on) {
  $("view-gate").classList.toggle("hidden", on);
  $("view-list").classList.toggle("hidden", !on);
  $("app-header").classList.toggle("hidden", !on);
  $("sot-banner").classList.toggle("hidden", !on);
}

async function login(ev) {
  ev.preventDefault();
  const err = $("login-error");
  err.classList.add("hidden");
  try {
    const email = normalizeEmail($("email").value);
    const password = $("password").value;
    const pat = $("pat-login").value.trim();
    const allowed = (config.admin_emails || []).map(normalizeEmail);
    if (allowed.length && !allowed.includes(email)) throw new Error("E-Mail nicht freigeschaltet");
    const hash = await sha256Hex(password);
    if (hash !== String(config.password_sha256 || "").toLowerCase()) throw new Error("Passwort falsch");
    if (!pat) throw new Error("GitHub-PAT fehlt");
    sessionStorage.setItem(STORAGE_AUTH, "1");
    sessionStorage.setItem(STORAGE_PAT, pat);
    showApp(true);
    await reload();
  } catch (e) {
    err.textContent = e.message || String(e);
    err.classList.remove("hidden");
  }
}

function logout() {
  sessionStorage.removeItem(STORAGE_AUTH);
  sessionStorage.removeItem(STORAGE_PAT);
  showApp(false);
}

async function reload() {
  const path = config.listings_path || "data/listings.json";
  const res = await fetch(`../../${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error("listings.json nicht ladbar");
  const doc = await res.json();
  listings = (doc.listings || []).filter((L) => {
    const o = String(L.origin || L.source || "").toLowerCase();
    return o === "eigen" || o === "local";
  });
  $("list-count").textContent = `(${listings.length})`;
  renderTable();
}

function renderTable() {
  const tbody = $("listings-tbody");
  if (!listings.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted">Keine Eigen-Inserate. Lege eines an.</td></tr>`;
    return;
  }
  tbody.innerHTML = listings
    .map((L) => {
      const local = L.local_url ? `../../${L.local_url}` : "#";
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

function openEditor(id) {
  const L = id ? listings.find((x) => x.id === id) : null;
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

async function dispatchSave(listing, action) {
  await gh("/dispatches", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event_type: "admin_eigen_save",
      client_payload: {
        action,
        listing,
        message:
          action === "delete"
            ? `Eigen: delete ${listing.id}`
            : `Eigen: upsert ${listing.slug || listing.id}`,
      },
    }),
  });
}

async function onSubmit(ev) {
  ev.preventDefault();
  const msg = $("form-msg");
  msg.textContent = "Speichere …";
  try {
    const listing = buildListing();
    await dispatchSave(listing, "upsert");
    const idx = listings.findIndex((x) => x.id === listing.id);
    if (idx >= 0) listings[idx] = listing;
    else listings.unshift(listing);
    $("list-count").textContent = `(${listings.length})`;
    renderTable();
    msg.textContent = "Gespeichert. Droplet-Publish läuft (ca. 1–2 Min). Danach „Neu laden“.";
    toast("Eigen-Inserat gespeichert", "ok");
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
    await dispatchSave({ id }, "delete");
    listings = listings.filter((x) => x.id !== id);
    $("list-count").textContent = `(${listings.length})`;
    renderTable();
    closeEditor();
    toast("Eigen-Inserat gelöscht", "ok");
  } catch (e) {
    $("form-msg").textContent = e.message || String(e);
    toast(e.message || String(e), "err");
  }
}

async function boot() {
  await loadConfig();
  $("form-login").addEventListener("submit", login);
  $("btn-logout").addEventListener("click", logout);
  $("btn-new").addEventListener("click", () => openEditor(null));
  $("btn-cancel").addEventListener("click", closeEditor);
  $("btn-delete").addEventListener("click", onDelete);
  $("btn-reload").addEventListener("click", () =>
    reload().catch((e) => toast(e.message || String(e), "err"))
  );
  $("form-eigen").addEventListener("submit", onSubmit);
  if (isAuthed()) {
    showApp(true);
    await reload();
  }
}

boot().catch((e) => {
  const err = $("login-error");
  if (err) {
    err.textContent = e.message || String(e);
    err.classList.remove("hidden");
  }
  console.error(e);
});

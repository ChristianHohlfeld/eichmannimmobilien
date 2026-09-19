/**
 * Exposé Admin – password gate only for Helmut.
 * GitHub write token is sealed in config.json (AES-GCM), unlocked after login.
 * Immowelt account is NEVER edited – sync only imports/reads.
 */

const STORAGE_AUTH = "ei_admin_auth";
const STORAGE_PAT = "ei_admin_github_pat"; // session only after unlock / optional override

const EDITABLE_FIELDS = [
  "title",
  "short_description",
  "description",
  "price",
  "rooms",
  "living_area",
  "location",
  "status",
];

let config = null;
let listingsData = null;
let listingsSha = null;
let currentId = null;
let sessionPassword = null; // kept in memory for re-seal tools only; not persisted

const $ = (id) => document.getElementById(id);

function toast(msg, type = "") {
  const el = $("toast");
  el.textContent = msg;
  el.className = "toast" + (type ? " " + type : "");
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 4500);
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes) {
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

/** Unlock github_token_sealed from config using the admin password. */
async function unsealToken(password) {
  const sealedB64 = config.github_token_sealed;
  if (!sealedB64) throw new Error("Kein versiegelter Token in config.json");
  const buf = b64ToBytes(sealedB64);
  const version = buf[0];
  if (version !== 1) throw new Error("Unbekanntes Token-Format");
  const salt = buf.slice(1, 17);
  const iv = buf.slice(17, 29);
  const tag = buf.slice(29, 45);
  const data = buf.slice(45);
  const iterations = (config.kdf && config.kdf.iterations) || 120000;
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
  const cipher = new Uint8Array(data.length + tag.length);
  cipher.set(data, 0);
  cipher.set(tag, data.length);
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error("Token konnte nicht entsiegelt werden (Passwort/Config).");
  }
}

function showView(name) {
  ["gate", "setup", "list", "detail"].forEach((v) => {
    const el = $(`view-${v}`);
    if (el) el.classList.toggle("hidden", v !== name);
  });
  $("app-header").classList.toggle("hidden", name === "gate");
}

function isAuthed() {
  return sessionStorage.getItem(STORAGE_AUTH) === "1";
}

function getPat() {
  return sessionStorage.getItem(STORAGE_PAT) || "";
}

function setPatSession(token) {
  if (token) sessionStorage.setItem(STORAGE_PAT, token);
  else sessionStorage.removeItem(STORAGE_PAT);
}

function repoApi(path) {
  const [owner, repo] = config.repo.split("/");
  return `https://api.github.com/repos/${owner}/${repo}${path}`;
}

async function ghFetch(path, options = {}) {
  const pat = getPat();
  if (!pat) throw new Error("Kein Schreib-Token freigeschaltet – bitte neu einloggen.");
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${pat}`,
    "X-GitHub-Api-Version": "2022-11-28",
    ...(options.headers || {}),
  };
  const res = await fetch(repoApi(path), { ...options, headers });
  if (!res.ok) {
    let detail = "";
    try {
      const j = await res.json();
      detail = j.message || JSON.stringify(j);
    } catch {
      detail = await res.text();
    }
    throw new Error(`GitHub API ${res.status}: ${detail}`);
  }
  if (res.status === 204) return null;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res.text();
}

async function loadConfig() {
  const res = await fetch("config.json", { cache: "no-store" });
  if (!res.ok) throw new Error("config.json nicht ladbar");
  config = await res.json();
}

async function loadListingsLocal() {
  const res = await fetch("../data/listings.json", { cache: "no-store" });
  if (!res.ok) throw new Error("listings.json nicht ladbar");
  listingsData = await res.json();
  listingsSha = null;
}

async function loadListingsFromGithub() {
  const path = config.listings_path || "data/listings.json";
  const meta = await ghFetch(`/contents/${path}?ref=${encodeURIComponent(config.branch || "main")}`);
  listingsSha = meta.sha;
  const raw = decodeURIComponent(escape(atob(meta.content.replace(/\n/g, ""))));
  listingsData = JSON.parse(raw);
}

async function ensureListings() {
  if (getPat()) {
    try {
      await loadListingsFromGithub();
      return;
    } catch (e) {
      console.warn("GitHub load failed, fallback local:", e);
      toast("GitHub-Laden fehlgeschlagen – lokale Datei. " + e.message, "error");
    }
  }
  await loadListingsLocal();
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shortId(id) {
  return String(id || "").slice(0, 8);
}

function findListing(id) {
  return (listingsData?.listings || []).find((L) => L.id === id) || null;
}

function renderList() {
  const tbody = $("listings-tbody");
  const list = listingsData?.listings || [];
  $("list-count").textContent = `(${list.length})`;
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted">Keine Objekte</td></tr>`;
    return;
  }
  tbody.innerHTML = list
    .map((L) => {
      const hasDesc = !!(L.description && String(L.description).trim());
      const hasManual =
        L.manual_overrides &&
        Object.keys(L.manual_overrides).some((k) => k !== "updated_at" && L.manual_overrides[k] === true);
      const local = L.local_url ? `../${L.local_url}` : "#";
      return `<tr>
        <td>
          <strong>${esc(L.title || "–")}</strong>
          ${hasManual ? '<div><span class="badge manual">manuell</span></div>' : ""}
          <div class="mono muted">${esc(shortId(L.id))}</div>
        </td>
        <td>${esc(L.location || "–")}</td>
        <td>${esc(L.price || "–")}</td>
        <td><span class="badge">${esc(L.status || "–")}</span></td>
        <td>${hasDesc ? '<span class="badge ok">ja</span>' : '<span class="badge miss">fehlt</span>'}</td>
        <td>
          <button type="button" class="btn btn-primary btn-sm" data-edit="${esc(L.id)}">Bearbeiten</button>
          <a class="btn btn-outline btn-sm" href="${esc(local)}" target="_blank" rel="noopener">Link</a>
        </td>
      </tr>`;
    })
    .join("");

  tbody.querySelectorAll("[data-edit]").forEach((btn) => {
    btn.addEventListener("click", () => openDetail(btn.getAttribute("data-edit")));
  });
}

function resolveAssetUrl(baseOrPath) {
  if (!baseOrPath) return null;
  const s = String(baseOrPath);
  if (s.startsWith("http") || s.startsWith("data:") || s.startsWith("blob:")) return s;
  if (s.startsWith("../") || s.startsWith("/")) return s;
  if (s.startsWith("assets/")) {
    if (/\.(jpg|jpeg|png|webp)$/i.test(s)) return `../${s}`;
    return `../${s}.webp`;
  }
  // short gallery base e.g. 01-c6b1d820
  if (!s.includes("/")) return `../assets/listings/${s}.webp`;
  if (/\.(jpg|jpeg|png|webp)$/i.test(s)) return `../${s}`;
  return `../${s}.webp`;
}

function openDetail(id) {
  const L = findListing(id);
  if (!L) {
    toast("Objekt nicht gefunden", "error");
    return;
  }
  currentId = id;
  $("edit-id").value = id;
  $("edit-title").value = L.title || "";
  $("edit-price").value = L.price || "";
  $("edit-status").value = L.status || "";
  $("edit-rooms").value = L.rooms || "";
  $("edit-living").value = L.living_area || "";
  $("edit-location").value = L.location || "";
  $("edit-short").value = L.short_description || "";
  $("edit-desc").value = L.description || "";
  $("detail-title").textContent = L.title || "Objekt";
  const link = $("link-local");
  if (L.local_url) {
    link.href = `../${L.local_url}`;
    link.classList.remove("hidden");
  } else {
    link.classList.add("hidden");
  }
  $("save-msg").textContent = "";
  renderPhotos(L);
  showView("detail");
}

function photoEntries(L) {
  const entries = [];
  const images = Array.isArray(L.images) ? L.images : [];
  const bases = Array.isArray(L.gallery_bases) ? L.gallery_bases : [];

  if (images.length) {
    images.forEach((src, i) => {
      entries.push({
        key: `img-${i}`,
        display: resolveAssetUrl(src),
        label: src,
        remove: () => {
          L.images = L.images.filter((_, j) => j !== i);
        },
      });
    });
    return entries;
  }

  // Prefer gallery_bases / image_base (canonical local assets)
  const baseList = bases.length ? bases : L.image_base ? [L.image_base] : [];
  baseList.forEach((b, i) => {
    entries.push({
      key: `base-${i}`,
      display: resolveAssetUrl(b),
      label: b,
      remove: () => {
        if (Array.isArray(L.gallery_bases)) {
          L.gallery_bases = L.gallery_bases.filter((_, j) => j !== i);
        }
        if (L.image_base === b) L.image_base = (L.gallery_bases && L.gallery_bases[0]) || null;
      },
    });
  });

  if (!entries.length && L.main_image_url) {
    entries.push({
      key: "main",
      display: resolveAssetUrl(L.main_image_url),
      label: L.main_image_url,
      remove: () => {
        L.main_image_url = null;
      },
    });
  }
  return entries;
}

function renderPhotos(L) {
  const grid = $("photo-grid");
  const items = photoEntries(L);
  if (!items.length) {
    grid.innerHTML = `<p class="muted">Keine Fotos – Sync oder Upload.</p>`;
    return;
  }
  grid.innerHTML = items
    .map(
      (it, idx) => `<div class="photo-card">
        <img src="${esc(it.display)}" alt="" loading="lazy"
          onerror="this.onerror=null;this.src=this.src.replace('.webp','.jpg')" />
        <button type="button" class="btn btn-danger btn-sm remove" data-rm-idx="${idx}">Entfernen</button>
        <div class="meta">${esc(String(it.label || "").slice(0, 64))}</div>
      </div>`
    )
    .join("");

  grid.querySelectorAll("[data-rm-idx]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const idx = Number(btn.getAttribute("data-rm-idx"));
      if (!confirm("Foto aus der Liste entfernen? (Datei bleibt im Repo, falls ungenutzt)")) return;
      const fresh = photoEntries(L);
      if (!fresh[idx]) return;
      fresh[idx].remove();
      markOverrides(L, ["images", "gallery_bases", "image_base", "main_image_url"]);
      try {
        await persistListings(`Admin: Foto entfernt bei ${shortId(L.id)}`);
        renderPhotos(L);
        toast("Foto entfernt und gespeichert", "ok");
      } catch (e) {
        toast(e.message, "error");
      }
    });
  });
}

function markOverrides(L, fields) {
  const mo = { ...(L.manual_overrides || {}) };
  for (const f of fields) {
    if (f) mo[f] = true;
  }
  mo.updated_at = new Date().toISOString();
  L.manual_overrides = mo;
}

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

async function persistListings(message) {
  if (!getPat()) throw new Error("Schreib-Token fehlt – bitte neu einloggen.");
  const path = config.listings_path || "data/listings.json";
  if (!listingsSha) {
    const meta = await ghFetch(`/contents/${path}?ref=${encodeURIComponent(config.branch || "main")}`);
    listingsSha = meta.sha;
  }
  listingsData.listing_count = (listingsData.listings || []).length;
  const body = {
    message,
    content: utf8ToBase64(JSON.stringify(listingsData, null, 2) + "\n"),
    sha: listingsSha,
    branch: config.branch || "main",
  };
  let result;
  try {
    result = await ghFetch(`/contents/${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    // Fallback: repository_dispatch → admin-save.yml (GITHUB_TOKEN schreibt)
    console.warn("Contents API failed, trying admin-save dispatch:", e);
    await dispatchAdminSave(message);
    // re-fetch sha/content
    await loadListingsFromGithub();
    return null;
  }
  listingsSha = result.content?.sha || listingsSha;
  return result;
}

async function dispatchAdminSave(message) {
  const listingsPath = config.listings_path || "data/listings.json";
  await ghFetch(`/dispatches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event_type: "admin_save_listings",
      client_payload: {
        message: message || "Admin: listings.json aktualisiert",
        listings_json: JSON.stringify(listingsData),
        path: listingsPath,
        trigger_render: true,
      },
    }),
  });
  toast("Speichern über Admin-Action gestartet …", "ok");
}

async function saveEdit(ev) {
  ev.preventDefault();
  const L = findListing($("edit-id").value);
  if (!L) return;
  const btn = $("btn-save");
  btn.disabled = true;
  $("save-msg").textContent = "Speichere …";

  const next = {
    title: $("edit-title").value.trim(),
    price: $("edit-price").value.trim() || null,
    status: $("edit-status").value.trim() || "Kauf",
    rooms: $("edit-rooms").value.trim() || null,
    living_area: $("edit-living").value.trim() || null,
    location: $("edit-location").value.trim() || null,
    short_description: $("edit-short").value.trim() || null,
    description: $("edit-desc").value.trim() || null,
  };

  const changed = [];
  for (const f of EDITABLE_FIELDS) {
    const before = L[f] ?? null;
    const after = next[f] ?? null;
    if (String(before ?? "") !== String(after ?? "")) {
      L[f] = after;
      changed.push(f);
    }
  }

  if (!changed.length) {
    $("save-msg").textContent = "Keine Änderungen.";
    btn.disabled = false;
    return;
  }

  markOverrides(L, changed);

  try {
    await persistListings(`Admin: ${shortId(L.id)} – ${changed.join(", ")} aktualisiert`);
    $("save-msg").textContent = "Gespeichert in data/listings.json.";
    $("detail-title").textContent = L.title || "Objekt";
    toast("Gespeichert", "ok");

    if ($("save-and-render").checked) {
      try {
        await triggerWorkflow(true);
        $("save-msg").textContent +=
          " Render-Workflow gestartet – öffentliche Seiten aktualisieren nach dem Action-Lauf.";
      } catch (e) {
        $("save-msg").textContent += " Speichern ok, Render-Trigger: " + e.message;
      }
    }
  } catch (e) {
    $("save-msg").textContent = e.message;
    toast(e.message, "error");
  } finally {
    btn.disabled = false;
  }
}

async function triggerWorkflow(forceFromJson) {
  const file = config.workflow_file || "sync-immowelt.yml";
  await ghFetch(`/actions/workflows/${file}/dispatches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ref: config.branch || "main",
      inputs: { force_from_json: forceFromJson ? "true" : "false" },
    }),
  });
  toast(
    forceFromJson
      ? "Render-Workflow gestartet (nur HTML aus JSON)."
      : "Voll-Sync gestartet (Immowelt nur lesen/importieren).",
    "ok"
  );
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function uploadPhoto(file) {
  const L = findListing(currentId);
  if (!L) return;
  if (!getPat()) throw new Error("Schreib-Token fehlt – bitte neu einloggen.");
  if (file.size > 4.5 * 1024 * 1024) {
    throw new Error("Bild zu groß (max. ca. 4,5 MB)");
  }

  const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/jpeg/, "jpg");
  const safeExt = ["jpg", "png", "webp"].includes(ext) ? ext : "jpg";
  const prefix = config.assets_prefix || "assets/listings";
  const stem = `admin-${shortId(L.id)}-${Date.now()}`;
  const fname = `${stem}.${safeExt}`;
  const path = `${prefix}/${fname}`;
  const content = await fileToBase64(file);

  toast("Lade hoch …");
  await ghFetch(`/contents/${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `Admin: Foto ${fname} für ${shortId(L.id)}`,
      content,
      branch: config.branch || "main",
    }),
  });

  // Mirror jpg as gallery base name (renderer uses assets/listings/{base}.webp|.jpg)
  // For non-jpg uploads, still store stem; renderer may 404 webp until render copies – keep jpg path in images.
  L.images = Array.isArray(L.images) ? L.images.slice() : [];
  L.images.push(`${prefix}/${fname}`);
  L.gallery_bases = Array.isArray(L.gallery_bases) ? L.gallery_bases.slice() : [];
  L.gallery_bases.push(stem);
  if (!L.main_image_url) L.main_image_url = `${prefix}/${fname}`;
  if (!L.image_base) L.image_base = stem;

  markOverrides(L, ["images", "gallery_bases", "main_image_url", "image_base"]);
  await persistListings(`Admin: Foto-Liste aktualisiert ${shortId(L.id)}`);
  renderPhotos(L);
  toast("Foto hochgeladen und Liste gespeichert", "ok");
}

async function enterApp() {
  showView("list");
  try {
    await ensureListings();
    renderList();
  } catch (e) {
    toast(e.message, "error");
    $("listings-tbody").innerHTML = `<tr><td colspan="6"><div class="err-box">${esc(e.message)}</div></td></tr>`;
  }
}

function normalizeEmail(e) {
  return String(e || "").trim().toLowerCase();
}

function emailAllowed(email) {
  const list = (config.admin_emails || []).map(normalizeEmail).filter(Boolean);
  if (!list.length) return true; // legacy: password only
  return list.includes(normalizeEmail(email));
}

async function handleLogin(password, email) {
  if (!emailAllowed(email)) {
    throw new Error("Diese E-Mail hat keinen Admin-Zugang.");
  }
  const hash = await sha256Hex(password);
  if (hash !== (config.password_sha256 || "").toLowerCase()) {
    throw new Error("Falsches Passwort.");
  }
  const token = await unsealToken(password);
  setPatSession(token);
  sessionPassword = password;
  sessionEmail = normalizeEmail(email);
  sessionStorage.setItem(STORAGE_AUTH, "1");
}

function bind() {
  $("form-login").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("login-error");
    err.classList.add("hidden");
    try {
      await handleLogin($("password").value, $("email").value);
      $("password").value = "";
      await enterApp();
    } catch (ex) {
      err.textContent = ex.message || "Login fehlgeschlagen";
      err.classList.remove("hidden");
    }
  });

  // Optional: override / rotate token (advanced) – not required for Helmut
  const formPat = $("form-pat");
  if (formPat) {
    formPat.addEventListener("submit", async (e) => {
      e.preventDefault();
      const v = $("pat").value.trim();
      if (!v) {
        $("pat-msg").textContent = "Leer – abgebrochen.";
        return;
      }
      setPatSession(v);
      $("pat").value = "";
      $("pat-msg").textContent =
        "Token nur in dieser Sitzung aktiv. Für Dauerhaft: coder muss neu versiegeln.";
      toast("Sitzungs-Token gesetzt", "ok");
      await enterApp();
    });
  }
  const clearPat = $("btn-clear-pat");
  if (clearPat) {
    clearPat.addEventListener("click", () => {
      setPatSession("");
      $("pat-msg").textContent = "Sitzungs-Token gelöscht. Bitte neu einloggen.";
    });
  }
  const skip = $("link-skip-setup");
  if (skip) {
    skip.addEventListener("click", (e) => {
      e.preventDefault();
      enterApp();
    });
  }

  $("btn-logout").addEventListener("click", () => {
    sessionStorage.removeItem(STORAGE_AUTH);
    setPatSession("");
    sessionPassword = null;
    showView("gate");
  });

  $("btn-settings").addEventListener("click", () => showView("setup"));
  $("btn-back").addEventListener("click", () => {
    showView("list");
    renderList();
  });
  $("btn-reload").addEventListener("click", async () => {
    try {
      await ensureListings();
      renderList();
      toast("Liste aktualisiert", "ok");
    } catch (e) {
      toast(e.message, "error");
    }
  });

  $("form-edit").addEventListener("submit", saveEdit);

  const syncFull = async () => {
    try {
      await triggerWorkflow(false);
    } catch (e) {
      toast(e.message, "error");
    }
  };
  const syncRender = async () => {
    try {
      await triggerWorkflow(true);
    } catch (e) {
      toast(e.message, "error");
    }
  };
  $("btn-sync-full").addEventListener("click", syncFull);
  $("btn-sync-full-2").addEventListener("click", syncFull);
  $("btn-sync-render").addEventListener("click", syncRender);
  $("btn-sync-render-2").addEventListener("click", syncRender);

  $("photo-input").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      await uploadPhoto(file);
    } catch (err) {
      toast(err.message, "error");
    }
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
  // Re-auth each browser session: sealed token must be unlocked with password
  if (isAuthed() && getPat()) {
    await enterApp();
  } else {
    sessionStorage.removeItem(STORAGE_AUTH);
    setPatSession("");
    showView("gate");
  }
}

boot();

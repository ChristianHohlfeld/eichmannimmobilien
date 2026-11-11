/**
 * Visual verification – the parts that need no browser (so they run in the unit tests):
 *   discoverPages()     the COMPLETE page inventory of a site (sitemap ∪ every internally linked page)
 *   referenceCardHtml() neutral rendering of one offer exactly as the Immowelt API delivers it
 *   buildReviewHtml()   the review page: per page three pictures side by side
 *                       before (dt-1) · after (dt) · Immowelt (dt)
 */
import { createHash } from "node:crypto";

export const VIEWPORTS = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false },
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};
/** Canonical production origins: absolute links to them count as internal when another base is checked. */
const SITE_ORIGINS = ["https://immobilieneichmann.de", "https://www.immobilieneichmann.de", "http://immobilieneichmann.de"];
/** Not pages: tools, data, binaries. */
const SKIP_PREFIXES = ["/admin", "/mcp", "/media/", "/assets/", "/css/", "/js/", "/data/", "/ai/", "/.well-known/", "/chatgpt-plugin/", "/mcp-static/"];

export const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** "/" → "home", "/objekt/wohnung-x.html" → "objekt_wohnung-x", "/en/" → "en" */
export function pageKey(p) {
  const clean = String(p).replace(/^\/+|\/+$/g, "").replace(/\.html$/, "");
  return clean ? clean.replace(/[^a-z0-9-]+/gi, "_") : "home";
}

/** Site path of a link ("/x.html", "/", "/en/") or null when it is not a page of this site. */
export function normalizePagePath(href, fromUrl, base) {
  const raw = String(href || "").trim();
  if (!raw || /^(#|mailto:|tel:|javascript:|data:|whatsapp:|sms:)/i.test(raw)) return null;
  let url;
  try {
    url = new URL(raw, fromUrl);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  const baseUrl = new URL(base);
  const baseOrigin = baseUrl.origin;
  const basePath = baseUrl.pathname.replace(/\/+$/, ""); // a copy of the site served below a sub-path
  if (url.origin !== baseOrigin && !SITE_ORIGINS.includes(url.origin)) return null;
  let p = decodeURI(url.pathname).replace(/\/{2,}/g, "/");
  if (basePath && url.origin === baseOrigin && (p === basePath || p.startsWith(`${basePath}/`))) p = p.slice(basePath.length) || "/";
  if (SKIP_PREFIXES.some((x) => p === x || p.startsWith(x.endsWith("/") ? x : `${x}/`) || p === x.replace(/\/$/, ""))) return null;
  if (/\/index\.html$/.test(p)) p = p.replace(/index\.html$/, "");
  if (p.endsWith("/") || /\.html$/.test(p)) return p || "/";
  if (/\.[a-z0-9]{2,5}$/i.test(p)) return null; // pdf, jpg, xml, txt, json …
  return `${p}.html`; // nginx redirects extensionless URLs to the .html page
}

/**
 * Complete page inventory: every URL of sitemap.xml plus every page reachable through internal
 * links from the German and English home pages (breadth first). Pages are read with plain HTTP.
 * @returns {Promise<{ pages: { path: string, status: number, html_sha256: string|null, source: string[] }[], truncated: boolean }>}
 */
export async function discoverPages(base, { maxPages = 400, fetchImpl = globalThis.fetch, extra = [], timeoutMs = 20_000 } = {}) {
  const root = String(base).replace(/\/+$/, "");
  const found = new Map(); // path → { sources:Set }
  const queue = [];
  const add = (p, source) => {
    if (!p) return;
    if (!found.has(p)) {
      found.set(p, { source: new Set() });
      queue.push(p);
    }
    found.get(p).source.add(source);
  };
  const get = async (url) => {
    try {
      const res = await fetchImpl(url, { headers: { "User-Agent": "eichmann-verify/1", "Cache-Control": "no-cache" }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
      const type = res.headers.get("content-type") || "";
      return { status: res.status, text: /html|xml/.test(type) || !type ? await res.text() : "", type };
    } catch {
      return { status: 0, text: "", type: "" };
    }
  };

  add("/", "start");
  const sm = await get(`${root}/sitemap.xml`);
  for (const m of sm.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) add(normalizePagePath(m[1], `${root}/`, root), "sitemap");
  add("/en/", "start");
  for (const p of extra) add(normalizePagePath(p, `${root}/`, root), "extra");

  const pages = [];
  let truncated = false;
  while (queue.length) {
    if (pages.length >= maxPages) {
      truncated = true;
      break;
    }
    const p = queue.shift();
    const res = await get(`${root}${encodeURI(p)}`);
    const isHtml = res.status === 200 && /<html[\s>]/i.test(res.text);
    // a start URL that does not exist (e.g. no English section) is not a finding
    if (!isHtml && [...found.get(p).source].every((s) => s === "start") && p !== "/") continue;
    pages.push({ path: p, status: res.status, html_sha256: isHtml ? sha256(res.text) : null, source: [...found.get(p).source].sort() });
    if (!isHtml) continue;
    for (const m of res.text.matchAll(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
      add(normalizePagePath((m[1] ?? m[2] ?? "").replace(/&amp;/g, "&"), `${root}${p}`, root), "link");
    }
  }
  pages.sort((a, b) => (a.path === "/" ? -1 : b.path === "/" ? 1 : a.path.localeCompare(b.path)));
  return { pages, truncated };
}

const CARD_CSS = `*{box-sizing:border-box}body{font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;margin:0;padding:20px;color:#111;background:#fff}
h1{font-size:22px;margin:6px 0 4px}h2{font-size:16px;margin:22px 0 8px;border-bottom:1px solid #bbb;padding-bottom:4px}
.src{background:#0b3d91;color:#fff;padding:6px 10px;font-size:13px;margin:-20px -20px 14px}
.key{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:14px;color:#333}.key b{color:#000}
.price{font-size:20px;font-weight:700;margin:8px 0}
table{border-collapse:collapse;width:100%;font-size:14px}td{border-top:1px solid #ddd;padding:4px 8px 4px 0;vertical-align:top}td:first-child{color:#555;width:42%}
.txt p{margin:0 0 10px}.txt ul,.txt ol{margin:0 0 10px 20px;padding:0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px}
figure{margin:0;border:1px solid #bbb;background:#f4f4f4}figure img{display:block;width:100%;height:150px;object-fit:contain;background:#fff}
figcaption{font-size:12px;padding:3px 6px;color:#333}.none{color:#777;font-style:italic}`;

function pictureGrid(pictures) {
  if (!pictures.length) return '<p class="none">keine Bilder</p>';
  return `<div class="grid">${pictures.map((p, i) => `<figure><img src="${esc(p.url)}" alt=""><figcaption>${i + 1} · ${esc(p.label || "Bild")}</figcaption></figure>`).join("")}</div>`;
}

/**
 * One offer exactly as the Immowelt API delivers it (normalized snapshot listing), in a neutral
 * layout that has nothing to do with the website's templates.
 */
export function referenceCardHtml(L, { fetchedAt = null } = {}) {
  const art = L.marketing === "miete" ? "Miete" : "Kauf";
  const pics = (L.media || []).map((m) => ({ url: m.xxl_url || m.url || m.source_url, label: m.role === "floorplan" ? "Grundriss" : "Foto" }));
  const facts = (L.fact_rows || []).filter((r) => r.label && r.value != null);
  const sections = (L.sections || []).filter((s) => s.html || s.text);
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Immowelt-API ${esc(L.immowelt_online_id)}</title><style>${CARD_CSS}</style></head><body>
<div class="src">Immowelt · offizielle API · Referenzdarstellung (kein Website-Layout)${fetchedAt ? ` · gelesen ${esc(fetchedAt)}` : ""}</div>
<div class="key"><span>Online-ID <b>${esc(L.immowelt_online_id)}</b></span><span>Objekt-ID <b>${esc(L.immowelt_estate_id)}</b></span><span>Position <b>${Number(L.position) + 1}</b></span><span>Art <b>${art}</b></span></div>
<h1>${esc(L.title)}</h1>
<div class="key"><span>${esc(L.location || "")}</span></div>
<div class="price">${esc(L.price || "")}</div>
<h2>Fakten (${facts.length})</h2>
<table>${facts.map((r) => `<tr><td>${esc(r.label)}</td><td>${esc(r.value)}</td></tr>`).join("")}</table>
${sections.map((s) => `<h2>${esc(s.title)} (${(s.text || "").length} Zeichen)</h2><div class="txt">${s.html || `<p>${esc(s.text)}</p>`}</div>`).join("\n")}
<h2>Bilder in API-Reihenfolge (${pics.filter((p) => p.label === "Foto").length} Fotos, ${pics.filter((p) => p.label === "Grundriss").length} Grundrisse)</h2>
${pictureGrid(pics)}
</body></html>`;
}

/* ------------------------------------------------------------------ review page */

const fmtTime = (iso) => {
  if (!iso) return "–";
  try {
    return new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", dateStyle: "short", timeStyle: "short" }).format(new Date(iso));
  } catch {
    return String(iso);
  }
};

function indexManifest(manifest) {
  const by = new Map(); // path (or online id) → { shots: { desktop, mobile }, … }
  for (const s of manifest?.pages || []) {
    const key = s.key || s.path;
    if (!by.has(key)) by.set(key, { key, path: s.path, shots: {} });
    const e = by.get(key);
    e.shots[s.viewport] = s;
    for (const f of ["title", "http_status", "html_sha256", "listing", "online_id", "url", "blocked"]) if (s[f] != null && e[f] == null) e[f] = s[f];
  }
  return by;
}

/**
 * @param {{ before?: object|null, after?: object|null, immowelt?: object|null, immoweltApi?: object|null,
 *           report?: object|null, prefix?: Record<string,string> }} input
 *   manifests as written by capture-screens.mjs; report = inventory-report.mjs --json;
 *   prefix = relative path from the review page to each label's directory
 * Pages are paired by their address. An offer whose address changed shows up as one removed and
 * one new page – exactly what happened to the URL.
 */
export function buildReviewHtml({ before = null, after = null, immowelt = null, immoweltApi = null, report = null, prefix = {} }) {
  const B = indexManifest(before);
  const A = indexManifest(after);
  const IW = indexManifest(immowelt);
  const API = indexManifest(immoweltApi);
  const pre = { before: "../screens/before/", after: "../screens/after/", immowelt: "../screens/immowelt/", immoweltApi: "../screens/immowelt-api/", ...prefix };
  const reportBy = new Map((report?.offers || []).map((o) => [o.online_id, o]));

  const imgs = (shot, dir) => {
    if (!shot) return '<div class="missing">nicht vorhanden</div>';
    if (shot.blocked) return `<div class="missing">nicht aufgenommen: ${esc(shot.blocked)}</div>`;
    const files = shot.files || (shot.file ? [shot.file] : []);
    if (!files.length) return '<div class="missing">keine Aufnahme</div>';
    return `<a class="shot" href="${esc(dir + files[0])}" target="_blank" rel="noopener">${files.map((f) => `<img loading="lazy" src="${esc(dir + f)}" alt="">`).join("")}</a>${files.length > 1 ? `<div class="parts">${files.map((f, i) => `<a href="${esc(dir + f)}" target="_blank" rel="noopener">Teil ${i + 1}</a>`).join(" · ")}</div>` : ""}`;
  };
  const cell = (entry, vp, dir, caption) => `<div class="col"><div class="cap">${caption}</div>${imgs(entry?.shots?.[vp], dir)}</div>`;
  const state = (b, a, vp) => {
    const x = b?.shots?.[vp];
    const y = a?.shots?.[vp];
    if (!x && !y) return "leer";
    if (!x) return "neu";
    if (!y) return "entfällt";
    if (x.sha256 && x.sha256 === y.sha256) return "pixelgleich";
    if (b.html_sha256 && b.html_sha256 === a.html_sha256) return "HTML gleich";
    return "geändert";
  };
  const chip = (s) => `<span class="chip ${esc(s.replace(/\s+/g, "-"))}">${esc(s)}</span>`;
  const triptych = (b, a, third, vp, thirdCaption) => `<div class="tri vp-${vp}">
${cell(b, vp, pre.before, `Vorher (dt‑1) · ${esc(fmtTime(before?.captured_at))}`)}
${cell(a, vp, pre.after, `Nachher (dt) · ${esc(fmtTime(after?.captured_at))}`)}
${third}
</div>`;
  const immoweltCell = (onlineId, vp) => {
    const real = IW.get(onlineId);
    const api = API.get(onlineId);
    const realOk = real?.shots?.[vp] && !real.shots[vp].blocked;
    if (realOk) return cell(real, vp, pre.immowelt, `Immowelt (dt) · öffentliche Seite · ${esc(fmtTime(immowelt?.captured_at))}`);
    if (api?.shots?.[vp]) return cell(api, vp, pre.immoweltApi, `Immowelt (dt) · API-Referenz · ${esc(fmtTime(immoweltApi?.captured_at))}${real?.shots?.[vp]?.blocked ? " · öffentliche Seite nicht aufgenommen" : ""}`);
    if (real) return cell(real, vp, pre.immowelt, "Immowelt (dt) · öffentliche Seite");
    return `<div class="col"><div class="cap">Immowelt (dt)</div><div class="missing">noch keine Immowelt-Aufnahme für ${esc(onlineId)}<br><small>capture-screens.mjs --label immowelt (lokal) bzw. --label immowelt-api</small></div></div>`;
  };
  const noCounterpart = (text) => `<div class="col"><div class="cap">Immowelt (dt)</div><div class="missing na">${esc(text)}</div></div>`;

  const offerBlocks = [];
  const removedBlocks = [];
  const eigenBlocks = [];
  const pageBlocks = [];
  const usedBefore = new Set();
  const counts = { pixelgleich: 0, "HTML gleich": 0, geändert: 0, neu: 0, entfällt: 0 };
  const isListingPath = (p) => /^\/(objekt|en\/property)\//.test(p);

  // --- after side: offers (Immowelt), own listings, other pages ---
  const afterEntries = [...A.values()];
  const offerOrder = (e) => reportBy.get(e.listing?.online_id)?.position ?? 999;
  for (const a of afterEntries.filter((e) => e.listing?.online_id && !/^\/en\//.test(e.path)).sort((x, y) => offerOrder(x) - offerOrder(y) || x.path.localeCompare(y.path))) {
    const id = a.listing.online_id;
    const b = B.get(a.path) || null;
    if (b) usedBefore.add(b.key);
    const r = reportBy.get(id);
    const st = state(b, a, "desktop");
    counts[st] = (counts[st] || 0) + 1;
    const urlNote = b ? "Adresse unverändert" : "neue Adresse – unter dieser URL gab es vorher keine Seite";
    const facts = [
      `Online-ID <b>${esc(id)}</b>`,
      a.listing.marketing ? `Art <b>${a.listing.marketing === "miete" ? "Miete" : "Kauf"}</b>` : "",
      r ? `Preis <b>${esc(r.price)}</b>` : a.listing.hero ? `<b>${esc(a.listing.hero)}</b>` : "",
      r?.living_area_m2 != null ? `Fläche <b>${esc(r.living_area_m2)} m²</b>` : "",
      r?.rooms != null ? `Zimmer <b>${esc(r.rooms)}</b>` : "",
      `Fotos <b>${r?.photos_api ?? "?"}</b> API / <b>${a.listing.gallery_count ?? "?"}</b> Seite`,
      `Grundrisse <b>${r?.floorplans_api ?? "?"}</b> API / <b>${a.listing.floorplan_count ?? "?"}</b> Seite`,
    ].filter(Boolean).join(" · ");
    const verdict = r ? (r.equal ? '<span class="chip ok">Datenvergleich ✓</span>' : `<span class="chip bad">Datenvergleich ✗ ${r.differences.length}</span>`) : "";
    offerBlocks.push(`<section class="item offer st-${esc(st.replace(/\s+/g, "-"))}" data-kind="offer">
<h3>${esc(a.listing.h1 || a.title || a.path)}</h3>
<p class="meta">${facts}</p>
<p class="meta"><a href="${esc(a.url || "")}" target="_blank" rel="noopener">${esc(a.path)}</a> · ${esc(urlNote)} · <a href="https://www.immowelt.de/expose/${esc(id)}" target="_blank" rel="noopener">immowelt.de/expose/${esc(id)}</a> ${chip(st)} ${verdict}</p>
${r && !r.equal ? `<ul class="diffs">${r.differences.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>` : ""}
${triptych(b, a, immoweltCell(id, "desktop"), "desktop")}
${triptych(b, a, immoweltCell(id, "mobile"), "mobile")}
</section>`);
  }
  // the English version of an offer page has the same file name as the German one
  const slugOf = (p) => p.replace(/^.*\//, "");
  const onlineBySlug = new Map(afterEntries.filter((e) => e.listing?.online_id).map((e) => [slugOf(e.path), e.listing.online_id]));
  for (const a of afterEntries.filter((e) => !e.listing?.online_id || /^\/en\//.test(e.path))) {
    const b = B.get(a.path) || null;
    if (b) usedBefore.add(b.key);
    const st = state(b, a, "desktop");
    counts[st] = (counts[st] || 0) + 1;
    const listing = isListingPath(a.path);
    const oid = a.listing?.online_id || (listing ? onlineBySlug.get(slugOf(a.path)) : null) || null;
    const none = listing ? "Angebotsseite ohne Immowelt-Kennung (eigenes Inserat oder Stand vor der Umstellung)" : "kein Immowelt-Gegenstück (keine Angebotsseite)";
    const third = oid ? immoweltCell(oid, "desktop") : noCounterpart(none);
    const thirdMobile = oid ? immoweltCell(oid, "mobile") : noCounterpart(none);
    const block = `<section class="item page st-${esc(st.replace(/\s+/g, "-"))}" data-kind="${listing ? "listing" : "page"}">
<h3>${esc(a.path)} <small>${esc(a.title || "")}</small></h3>
<p class="meta">HTTP ${esc(b?.http_status ?? "–")} → ${esc(a.http_status ?? "–")} ${chip(st)}${oid ? ` · Online-ID <b>${esc(oid)}</b> (englische Fassung)` : ""}</p>
${triptych(b, a, third, "desktop")}
${triptych(b, a, thirdMobile, "mobile")}
</section>`;
    (listing && !oid ? eigenBlocks : pageBlocks).push({ st, path: a.path, block });
  }
  // --- before only: pages that no longer exist ---
  for (const b of [...B.values()].filter((e) => !usedBefore.has(e.key) && !A.has(e.path))) {
    counts.entfällt += 1;
    removedBlocks.push(`<section class="item removed st-entfällt" data-kind="${isListingPath(b.path) ? "listing" : "page"}">
<h3>${esc(b.path)} <small>${esc(b.listing?.h1 || b.title || "")}</small></h3>
<p class="meta">vorher HTTP ${esc(b.http_status ?? "–")} · nachher nicht mehr vorhanden ${chip("entfällt")}${isListingPath(b.path) ? " · nicht (mehr) im Immowelt-Bestand bzw. ohne belegte Zuordnung" : ""}</p>
${triptych(b, null, noCounterpart("–"), "desktop")}
${triptych(b, null, noCounterpart("–"), "mobile")}
</section>`);
  }
  const rank = { geändert: 0, neu: 1, "HTML gleich": 2, pixelgleich: 3 };
  const sorted = (list) => list.sort((x, y) => (rank[x.st] ?? 9) - (rank[y.st] ?? 9) || x.path.localeCompare(y.path)).map((x) => x.block);
  const blocked = [...IW.values()].filter((e) => Object.values(e.shots).some((s) => s.blocked)).length;

  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sichtprüfung Immowelt → Website</title>
<style>
*{box-sizing:border-box}body{font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;margin:0;color:#111;background:#f3f3f1}
header{position:sticky;top:0;z-index:5;background:#fff;border-bottom:1px solid #bbb;padding:10px 16px}
h1{font-size:18px;margin:0 0 4px}h2{font-size:17px;margin:26px 16px 8px}h3{font-size:15px;margin:0 0 4px}h3 small{font-weight:400;color:#555}
.sum{display:flex;flex-wrap:wrap;gap:4px 18px;color:#333;font-size:13px}
.bar{margin-top:8px;display:flex;flex-wrap:wrap;gap:6px}
.bar button{font:inherit;padding:4px 10px;border:1px solid #888;background:#fff;border-radius:4px;cursor:pointer}.bar button.on{background:#111;color:#fff}
.item{background:#fff;border:1px solid #c8c8c8;border-radius:6px;margin:10px 16px;padding:12px}
.meta{margin:2px 0 8px;color:#333}.meta a{color:#0b3d91}
.tri{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;align-items:start}
.col{min-width:0}.cap{font-size:12px;font-weight:600;background:#eee;border:1px solid #ccc;border-bottom:0;padding:4px 6px}
.shot{display:block;border:1px solid #999;background:#fafafa;line-height:0}.shot img{display:block;width:100%;height:auto}
.parts{font-size:12px;margin-top:2px}.missing{border:1px dashed #999;padding:26px 10px;text-align:center;color:#666;background:#fafafa}.missing.na{color:#999}
.chip{display:inline-block;font-size:12px;padding:1px 7px;border-radius:10px;border:1px solid #999;background:#f4f4f4;margin-left:4px}
.chip.geändert,.chip.bad{background:#ffe9c2;border-color:#c77d00}.chip.neu{background:#d9f0ff;border-color:#2a7ab8}.chip.entfällt{background:#ffd9d6;border-color:#b3261e}.chip.pixelgleich,.chip.ok{background:#dcf5dc;border-color:#2e7d32}
.diffs{margin:4px 0 8px 18px;padding:0;color:#8a4b00}
body.vp-desktop .tri.vp-mobile,body.vp-mobile .tri.vp-desktop{display:none}
body.vp-mobile .tri{max-width:1100px}
body.only-changed .item.st-pixelgleich,body.only-changed .item.st-HTML-gleich{display:none}
body.kind-offer .item:not([data-kind=offer]){display:none}body.kind-page .item[data-kind=offer]{display:none}
footer{margin:24px 16px;color:#555;font-size:12px}
</style></head>
<body class="vp-desktop">
<header>
<h1>Sichtprüfung Immowelt → Website · ${esc(after?.base || before?.base || "")}</h1>
<div class="sum">
<span><b>Vorher (dt‑1)</b> ${esc(fmtTime(before?.captured_at))} · Release ${esc(before?.release_id || "ohne Kennung (altes Layout)")} · ${B.size} Seiten</span>
<span><b>Nachher (dt)</b> ${esc(fmtTime(after?.captured_at))} · Release ${esc(after?.release_id || "–")} · ${A.size} Seiten</span>
<span><b>Immowelt (dt)</b> ${immowelt ? `öffentliche Seiten ${esc(fmtTime(immowelt.captured_at))}${blocked ? ` (${blocked} nicht aufgenommen)` : ""}` : "öffentliche Seiten: keine Aufnahme"} · ${immoweltApi ? `API-Referenz ${esc(fmtTime(immoweltApi.captured_at))}` : "API-Referenz: keine Aufnahme"}</span>
<span>${Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(" · ")}</span>
${report ? `<span>Datenvergleich: ${report.differences?.length ? `<b>${report.differences.length} Abweichung(en)</b>` : "<b>keine Abweichungen</b>"} (${esc(report.compared || "")})</span>` : ""}
</div>
<div class="bar">
<button data-vp="desktop" class="on">Desktop 1440×900</button><button data-vp="mobile">Mobil 390×844</button>
<button data-kind="">alle</button><button data-kind="offer">nur Angebote</button><button data-kind="page">nur übrige Seiten</button>
<button data-toggle="only-changed">Unverändertes ausblenden</button>
</div>
</header>
<h2>Immowelt-Angebote (${offerBlocks.length}) – Vorher · Nachher · Immowelt</h2>
${offerBlocks.join("\n") || '<p class="item">Im Nachher-Stand ist kein Angebot mit Immowelt-Kennung enthalten (Aufnahme vor der Umstellung?).</p>'}
${removedBlocks.length ? `<h2>Entfallene Seiten (${removedBlocks.length})</h2>\n${removedBlocks.join("\n")}` : ""}
${eigenBlocks.length ? `<h2>Angebotsseiten ohne Immowelt-Kennung (${eigenBlocks.length})</h2>\n${sorted(eigenBlocks).join("\n")}` : ""}
<h2>Übrige Seiten (${pageBlocks.length}) – kompletter Seitenbestand</h2>
${sorted(pageBlocks).join("\n")}
<footer>Aufnahmen: ganze Seite, identische Viewports (Desktop 1440×900, Mobil 390×844 @2x), Cookie-Hinweis ausgeblendet, Animationen aus. „pixelgleich“ = Bilddateien identisch; „HTML gleich“ = Quelltext identisch, Abweichung nur in der Darstellung. Die Spalte „Immowelt“ zeigt die öffentliche Immowelt-Seite, sofern sie aufgenommen werden konnte, sonst die Referenzdarstellung der API-Daten.</footer>
<script>
for (const b of document.querySelectorAll(".bar button")) b.addEventListener("click", () => {
  if (b.dataset.vp) { document.body.classList.remove("vp-desktop", "vp-mobile"); document.body.classList.add("vp-" + b.dataset.vp); for (const o of document.querySelectorAll("[data-vp]")) o.classList.toggle("on", o === b); }
  else if (b.dataset.kind !== undefined) { document.body.classList.remove("kind-offer", "kind-page"); if (b.dataset.kind) document.body.classList.add("kind-" + b.dataset.kind); for (const o of document.querySelectorAll("[data-kind]")) if (o.tagName === "BUTTON") o.classList.toggle("on", o === b); }
  else if (b.dataset.toggle) b.classList.toggle("on", document.body.classList.toggle(b.dataset.toggle));
});
</script>
</body></html>
`;
}

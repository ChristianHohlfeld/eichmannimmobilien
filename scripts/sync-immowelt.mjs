#!/usr/bin/env node
/**
 * Immowelt → immobilieneichmann.de listings sync (Single Source of Truth).
 *
 * Canonical store: data/listings.json (keyed by expose UUID)
 * Regenerates:
 *   - listing cards in index.html + projekte.html (+ partials/listings-grid.html)
 *   - local Exposé pages under objekt/{slug}.html
 *   - sitemap.xml (static + dynamic objekt entries)
 * Downloads images to assets/listings/ (main + gallery + floor plans)
 *
 * Usage:
 *   node scripts/sync-immowelt.mjs
 *   node scripts/sync-immowelt.mjs --from-json /path/to/listings.json
 *   node scripts/sync-immowelt.mjs --render-only
 *   node scripts/sync-immowelt.mjs --dry-run
 *   node scripts/sync-immowelt.mjs --skip-enrich
 *
 * Soft-fail: if live scrape fails (DataDome / network), keep last good JSON
 * and exit 0 so CI does not wipe the site.
 */

import { readFile, writeFile, mkdir, readdir, unlink, copyFile, access, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const PROFILE_URL =
  process.env.IMMOWELT_PROFILE_URL ||
  "https://www.immowelt.de/profil/3b18336c6a2e401da38e9cc20268270d";

const SITE_ORIGIN = "https://immobilieneichmann.de";
const DATA_PATH = path.join(ROOT, "data", "listings.json");
const IMAGES_DIR = path.join(ROOT, "assets", "listings");
const OBJEKT_DIR = path.join(ROOT, "objekt");
const PARTIAL_PATH = path.join(ROOT, "partials", "listings-grid.html");
const SITEMAP_PATH = path.join(ROOT, "sitemap.xml");

const MARKER_START = "<!-- IMMWELT-LISTINGS:START -->";
const MARKER_END = "<!-- IMMWELT-LISTINGS:END -->";
const COUNT_START = "<!-- IMMWELT-COUNT:START -->";
const COUNT_END = "<!-- IMMWELT-COUNT:END -->";
const SITEMAP_OBJEKT_START = "<!-- IMMWELT-OBJEKT:START -->";
const SITEMAP_OBJEKT_END = "<!-- IMMWELT-OBJEKT:END -->";

const STATIC_SITEMAP_PATHS = [
  { loc: "/", priority: "1.0", changefreq: "weekly" },
  { loc: "/leistungen.html", priority: "0.8", changefreq: "weekly" },
  { loc: "/projekte.html", priority: "0.8", changefreq: "weekly" },
  { loc: "/kontakt.html", priority: "0.8", changefreq: "weekly" },
  { loc: "/impressum.html", priority: "0.5", changefreq: "yearly" },
  { loc: "/datenschutz.html", priority: "0.5", changefreq: "yearly" },
  { loc: "/widerrufsbelehrung.html", priority: "0.4", changefreq: "yearly" },
  { loc: "/vertrag-widerrufen.html", priority: "0.4", changefreq: "yearly" },
  { loc: "/immobilienmakler-konstanz.html", priority: "0.8", changefreq: "weekly" },
  { loc: "/wohnung-kaufen-konstanz.html", priority: "0.8", changefreq: "weekly" },
  { loc: "/haus-verkaufen-konstanz.html", priority: "0.8", changefreq: "weekly" },
  { loc: "/konstanz.html", priority: "0.8", changefreq: "weekly" },
  { loc: "/wollmatingen.html", priority: "0.8", changefreq: "weekly" },
  { loc: "/allmannsdorf.html", priority: "0.8", changefreq: "weekly" },
  { loc: "/ratgeber.html", priority: "0.8", changefreq: "weekly" },
  { loc: "/immobilienbewertung-konstanz.html", priority: "0.8", changefreq: "monthly" },
];

const args = new Set(process.argv.slice(2));
const fromJsonArg = (() => {
  const i = process.argv.indexOf("--from-json");
  return i >= 0 ? process.argv[i + 1] : null;
})();
const renderOnly = args.has("--render-only");
const enrichOnly = args.has("--enrich-only");
const dryRun = args.has("--dry-run");
const forceScrape = args.has("--force-scrape");
const skipEnrich = args.has("--skip-enrich");

// Public syndication mirror for the same Immowelt offers. Immowelt blocks
// GitHub-hosted runners with DataDome; Sparkassen-Immobilien publishes the
// identical SIP offers and their full galleries without that datacenter block.
// Key = canonical Immowelt expose UUID, value = matching syndicated expose URL.
const SPARKASSE_EXPOSE_BY_IMMOWELT_ID = Object.freeze({
  "c6b1d820-4e82-416d-95ad-22472a129955": "https://immobilien.sparkasse.de/expose/FID-F13-699-009.html",
  "32a8908e-c8e0-4944-b44f-f203ccdaa8a9": "https://immobilien.sparkasse.de/expose/FID-F13-646-975.html",
  "4fed09f2-bcef-4e96-ba56-810037b569c0": "https://immobilien.sparkasse.de/expose/FID-F13-646-974.html",
  "d6860062-651b-4f72-a26e-b3719e525241": "https://immobilien.sparkasse.de/expose/FID-F13-646-966.html",
  "e7e58fe2-a93f-44f2-bc73-dabd3c7208b3": "https://immobilien.sparkasse.de/expose/FID-F13-646-976.html",
  "aebb3257-3317-4452-bc9c-a5dbc5ed3838": "https://immobilien.sparkasse.de/expose/FID-F13-646-972.html",
  "86a7d4f6-0118-45fa-addc-ef5fe9edf21d": "https://immobilien.sparkasse.de/expose/FID-F13-646-973.html",
  "7bff84e7-8370-471d-b359-5319c8df10ef": "https://immobilien.sparkasse.de/expose/FID-F13-646-970.html",
  "6fd6062e-32f4-4f02-af80-d854bd090279": "https://immobilien.sparkasse.de/expose/FID-F13-646-967.html",
  "484fee8a-e3f0-4f06-8d26-d740c290b320": "https://immobilien.sparkasse.de/expose/FID-F13-646-969.html",
  "4ac199b6-606e-470b-bb7e-d8646d47ea80": "https://immobilien.sparkasse.de/expose/FID-F13-646-977.html",
  "bb241b38-d292-4047-98fd-4352b841bc5a": "https://immobilien.sparkasse.de/expose/FID-F13-646-968.html",
  "ff414db8-7e3d-4a01-99f8-029fe15a4d55": "https://immobilien.sparkasse.de/expose/FID-F13-646-971.html",
});

const PROJECT_REFERENCE_BY_IMMOWELT_ID = Object.freeze({
  "4fed09f2-bcef-4e96-ba56-810037b569c0": "A5",
  "aebb3257-3317-4452-bc9c-a5dbc5ed3838": "B3",
  "484fee8a-e3f0-4f06-8d26-d740c290b320": "A12",
  "4ac199b6-606e-470b-bb7e-d8646d47ea80": "A9",
  "bb241b38-d292-4047-98fd-4352b841bc5a": "A3",
  "ff414db8-7e3d-4a01-99f8-029fe15a4d55": "A2"
});

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function exposeIdFromUrl(url) {
  if (!url) return null;
  const m = String(url).match(/\/expose\/([a-f0-9-]{36})/i);
  return m ? m[1].toLowerCase() : null;
}

function shortId(id) {
  return id.slice(0, 8);
}

function imageBase(index, id) {
  return `${String(index + 1).padStart(2, "0")}-${shortId(id)}`;
}

function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 60);
}

function makeSlug(listing) {
  if (listing.slug && /^[a-z0-9-]+$/.test(listing.slug)) return listing.slug;
  const typePart = slugify(listing.type || listing.title || "objekt") || "objekt";
  const loc = String(listing.location || "");
  const locHint =
    slugify(
      (loc.match(/([A-Za-zÄÖÜäöüß-]+),\s*Konstanz/i) ||
        loc.match(/Konstanz/i) ||
        loc.match(/([A-Za-zÄÖÜäöüß-]{3,})/))?.[1] || "konstanz"
    ) || "konstanz";
  return `${typePart}-${locHint}-${shortId(listing.id)}`;
}

function localExposePath(listing) {
  return `objekt/${listing.slug}.html`;
}


/** Fields Helmut can lock via Admin (manual_overrides[field] === true). */
const MANUAL_OVERRIDE_FIELDS = [
  "title",
  "price",
  "location",
  "rooms",
  "living_area",
  "plot_area",
  "type",
  "status",
  "short_description",
  "description",
  "source_title",
  "reference_number",
  "location_description",
  "amenities",
  "additional_information",
  "images",
  "gallery_bases",
  "floor_plans",
  "floor_plan_bases",
  "facts",
  "main_image_url",
  "image_base",
];

function isManuallyOverridden(prev, field) {
  const mo = prev && prev.manual_overrides;
  return !!(mo && mo[field] === true);
}

/**
 * Re-apply fields Helmut locked in Admin so Immowelt scrape/enrich cannot overwrite them.
 * Always preserves the manual_overrides object itself.
 */
function applyManualOverrides(listing, prev) {
  if (!prev) return listing;
  const mo = prev.manual_overrides;
  if (!mo || typeof mo !== "object") return listing;

  for (const field of MANUAL_OVERRIDE_FIELDS) {
    if (mo[field] === true && Object.prototype.hasOwnProperty.call(prev, field)) {
      listing[field] = prev[field];
    }
  }
  // If images locked, keep related gallery paths too even if not explicitly flagged
  if (mo.images === true) {
    if (Array.isArray(prev.images)) listing.images = prev.images;
    if (Array.isArray(prev.gallery_bases)) listing.gallery_bases = prev.gallery_bases;
    if (prev.image_base) listing.image_base = prev.image_base;
    if (prev.main_image_url) listing.main_image_url = prev.main_image_url;
  }
  if (mo.description === true && prev.description != null) {
    listing.description = prev.description;
  }
  if (mo.short_description === true && prev.short_description != null) {
    listing.short_description = prev.short_description;
  }

  listing.manual_overrides = { ...mo };
  return listing;
}

function badgeFor(listing) {
  const blob = `${listing.title || ""} ${listing.short_description || ""}`.toLowerCase();
  if (blob.includes("provisionsfrei")) {
    return { text: "Provisionsfrei", className: "listing-badge accent" };
  }
  if (blob.includes("erstbezug")) {
    return { text: "Erstbezug", className: "listing-badge" };
  }
  const t = (listing.type || "Objekt").trim();
  return { text: t, className: "listing-badge" };
}

function normalizeListing(raw, index, prev = null) {
  const id =
    raw.id ||
    exposeIdFromUrl(raw.expose_url) ||
    exposeIdFromUrl(raw.url) ||
    (prev && prev.id) ||
    null;
  if (!id) return null;

  const expose_url =
    raw.expose_url ||
    raw.url ||
    (prev && prev.expose_url) ||
    `https://www.immowelt.de/expose/${id}`;

  const base = {
    id,
    title: (raw.title || (prev && prev.title) || "Immobilie").trim(),
    price: (raw.price || (prev && prev.price) || "").trim() || null,
    location: (raw.location || (prev && prev.location) || "").trim() || null,
    rooms: (raw.rooms || (prev && prev.rooms) || "").trim() || null,
    living_area: (raw.living_area || raw.livingArea || (prev && prev.living_area) || "").trim() || null,
    plot_area: raw.plot_area ?? raw.plotArea ?? (prev && prev.plot_area) ?? null,
    type: (raw.type || (prev && prev.type) || "").trim() || null,
    status: (raw.status || (prev && prev.status) || "Kauf").trim() || "Kauf",
    short_description:
      (raw.short_description || raw.shortDescription || (prev && prev.short_description) || "").trim() ||
      null,
    expose_url,
    main_image_url:
      raw.main_image_url || raw.mainImageUrl || raw.image || (prev && prev.main_image_url) || null,
    image_base: raw.image_base || (prev && prev.image_base) || imageBase(index, id),
    // Enriched fields (prefer incoming, else keep previous)
    description:
      (raw.description || (prev && prev.description) || "").trim() || null,
    source_title:
      (raw.source_title || (prev && prev.source_title) || "").trim() || null,
    reference_number:
      (raw.reference_number || (prev && prev.reference_number) || "").trim() || null,
    location_description:
      (raw.location_description || (prev && prev.location_description) || "").trim() || null,
    amenities: Array.isArray(raw.amenities)
      ? raw.amenities.filter(Boolean)
      : prev && Array.isArray(prev.amenities)
        ? prev.amenities
        : [],
    additional_information:
      (raw.additional_information || (prev && prev.additional_information) || "").trim() || null,
    images: Array.isArray(raw.images)
      ? raw.images.filter(Boolean)
      : prev && Array.isArray(prev.images)
        ? prev.images
        : [],
    floor_plans: Array.isArray(raw.floor_plans)
      ? raw.floor_plans.filter(Boolean)
      : prev && Array.isArray(prev.floor_plans)
        ? prev.floor_plans
        : [],
    gallery_bases: Array.isArray(raw.gallery_bases)
      ? raw.gallery_bases
      : prev && Array.isArray(prev.gallery_bases)
        ? prev.gallery_bases
        : [],
    floor_plan_bases: Array.isArray(raw.floor_plan_bases)
      ? raw.floor_plan_bases
      : prev && Array.isArray(prev.floor_plan_bases)
        ? prev.floor_plan_bases
        : [],
    facts:
      raw.facts && typeof raw.facts === "object"
        ? raw.facts
        : prev && prev.facts
          ? prev.facts
          : null,
    enriched_at: raw.enriched_at || (prev && prev.enriched_at) || null,
  };

  base.slug = makeSlug({ ...base, slug: raw.slug || (prev && prev.slug) });
  base.local_url = localExposePath(base);
  base.source = raw.source || (prev && prev.source) || "immowelt";
  base.immowelt_id =
    raw.immowelt_id ||
    (prev && prev.immowelt_id) ||
    (looksLikeImmoweltId(id) ? id : null);
  base.sync_policy = raw.sync_policy || (prev && prev.sync_policy) || "independent";
  base.missing_on_immowelt =
    raw.missing_on_immowelt === true ||
    (prev && prev.missing_on_immowelt === true) ||
    false;
  // Preserve Admin locks: Immowelt must not overwrite Helmut's manual fields
  applyManualOverrides(base, prev);
  applyLocalAuthoritative(base, prev);
  // Prefer previous slug/local_url when title was manually overridden (stable URLs)
  if (prev && ((isManuallyOverridden(prev, "title") && prev.slug) || (prev.source === "local" && prev.slug))) {
    base.slug = prev.slug;
    base.local_url = prev.local_url || localExposePath(base);
  }
  return base;
}

function renderCard(listing) {
  const badge = badgeFor(listing);
  const base = listing.image_base;
  const alt = `${listing.title} – Immobilien Eichmann Konstanz`;
  const meta = [
    listing.rooms ? `<span>${escapeHtml(listing.rooms)}</span>` : "",
    listing.living_area ? `<span>${escapeHtml(listing.living_area)}</span>` : "",
    listing.plot_area
      ? `<span>${escapeHtml(
          /grundstück/i.test(listing.plot_area)
            ? listing.plot_area
            : `${listing.plot_area} Grundstück`
        )}</span>`
      : "",
  ]
    .filter(Boolean)
    .join("\n              ");

  const href = listing.local_url || localExposePath(listing);
  const aria = `${listing.title} – Exposé öffnen`;
  return `        <a class="listing-card" href="${escapeHtml(href)}" aria-label="${escapeHtml(aria)}">
          <div class="listing-photo">
            <picture>
              <source srcset="assets/listings/${escapeHtml(base)}.webp" type="image/webp">
              <img src="assets/listings/${escapeHtml(base)}.jpg" alt="${escapeHtml(alt)}" loading="lazy" width="800" height="600" decoding="async">
            </picture>
            <span class="${badge.className}">${escapeHtml(badge.text)}</span>
          </div>
          <div class="listing-body">
            <p class="listing-price">${escapeHtml(listing.price || "")}</p>
            <h3 class="listing-title">${escapeHtml(listing.title)}</h3>
            <p class="listing-loc">${escapeHtml(listing.location || "")}</p>
            <div class="listing-meta">
              ${meta}
            </div>
            <p class="listing-desc">${escapeHtml(listing.short_description || "")}</p>
            <div class="listing-actions">
              <span class="btn btn-primary btn-sm">Exposé ansehen</span>
            </div>
          </div>
        </a>`;
}

function renderGrid(listings) {
  const cards = listings.map(renderCard).join("\n\n");
  return `${MARKER_START}\n${cards}\n${MARKER_END}`;
}

function countTextIndex(n) {
  return `${COUNT_START}${n} Kaufobjekte in und um Konstanz – Fotos und Eckdaten, Details im Exposé.${COUNT_END}`;
}

function countTextProjekte(n) {
  return `${COUNT_START}${n} Objekte – Details im Exposé.${COUNT_END}`;
}

function patchBetween(html, start, end, replacement) {
  const i = html.indexOf(start);
  const j = html.indexOf(end);
  if (i === -1 || j === -1 || j < i) {
    throw new Error(`Markers not found: ${start} … ${end}`);
  }
  return html.slice(0, i) + replacement + html.slice(j + end.length);
}

function ensureMarkers(html, gridOpenHint = 'class="listings-grid"') {
  if (html.includes(MARKER_START) && html.includes(MARKER_END)) return html;

  const gridIdx = html.indexOf(gridOpenHint);
  if (gridIdx === -1) throw new Error("listings-grid not found");

  const openEnd = html.indexOf(">", gridIdx) + 1;
  const after = html.slice(openEnd);
  let closeRel = after.search(/\n\s*<\/div>\s*\n\s*<p class="immowelt-note"/);
  if (closeRel === -1) {
    closeRel = after.search(/<\/div>\s*<p class="immowelt-note"/);
  }
  if (closeRel === -1) {
    closeRel = after.search(/<\/a>\s*<\/div>/);
    if (closeRel !== -1) {
      const abs = openEnd + closeRel;
      const aEnd = html.indexOf("</a>", abs) + 4;
      const inner = html.slice(openEnd, aEnd).trim();
      return (
        html.slice(0, openEnd) +
        `\n${MARKER_START}\n${inner}\n${MARKER_END}\n` +
        html.slice(aEnd)
      );
    }
    throw new Error("Could not locate end of listings-grid");
  }
  const absClose = openEnd + closeRel;
  const inner = html.slice(openEnd, absClose).trim();
  return (
    html.slice(0, openEnd) +
    `\n${MARKER_START}\n${inner}\n${MARKER_END}\n        ` +
    html.slice(absClose)
  );
}

function ensureCountMarkers(html, page) {
  if (html.includes(COUNT_START) && html.includes(COUNT_END)) return html;
  if (page === "index") {
    return html.replace(
      /(\d+)\s+Kaufobjekte in und um Konstanz – Fotos und Eckdaten(?:, Exposé auf Immowelt|\, Details im Exposé)\./,
      (_, n) => countTextIndex(n)
    );
  }
  return html.replace(
    /(\d+)\s+Objekte – Details im Exposé\./,
    (_, n) => countTextProjekte(n)
  );
}

function assetPrefix(fromObjekt) {
  return fromObjekt ? "../" : "";
}

function pictureTag(base, alt, { prefix = "", loading = "lazy", className = "" } = {}) {
  const cls = className ? ` class="${className}"` : "";
  return `<picture>
              <source srcset="${prefix}assets/listings/${escapeHtml(base)}.webp" type="image/webp">
              <img src="${prefix}assets/listings/${escapeHtml(base)}.jpg" alt="${escapeHtml(alt)}" loading="${loading}" width="800" height="600" decoding="async"${cls}>
            </picture>`;
}

function renderExposeHtml(listing) {
  const p = "../";
  const badge = badgeFor(listing);
  const title = listing.title || "Immobilie";
  const pageTitle = `${title} | Exposé – Immobilien Eichmann Konstanz`;
  const descBits = [
    listing.price,
    listing.rooms,
    listing.living_area,
    listing.location,
  ]
    .filter(Boolean)
    .join(" · ");
  const metaDesc = (
    listing.short_description ||
    listing.description ||
    `${title} in ${listing.location || "Konstanz"} – ${descBits}. Exposé anfragen bei Immobilien Eichmann.`
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);

  const canonical = `${SITE_ORIGIN}/${listing.local_url}`;
  const ogImage = listing.image_base
    ? `${SITE_ORIGIN}/assets/listings/${listing.image_base}.jpg`
    : `${SITE_ORIGIN}/assets/share-card-plain-v2.jpg`;

  const factRows = [
    listing.price ? ["Kaufpreis", listing.price] : null,
    listing.rooms ? ["Zimmer", listing.rooms] : null,
    listing.living_area ? ["Wohnfläche", listing.living_area] : null,
    listing.plot_area
      ? [
          "Grundstück",
          /grundstück/i.test(listing.plot_area)
            ? listing.plot_area
            : `${listing.plot_area}`,
        ]
      : null,
    listing.type ? ["Objektart", listing.type] : null,
    listing.status ? ["Vermarktung", listing.status] : null,
    listing.location ? ["Lage", listing.location] : null,
  ].filter(Boolean);

  if (listing.facts && typeof listing.facts === "object") {
    for (const [k, v] of Object.entries(listing.facts)) {
      if (v) factRows.push([k, String(v)]);
    }
  }

  const factsHtml = factRows
    .map(
      ([k, v]) =>
        `<li><span class="expose-fact-label">${escapeHtml(k)}</span><span class="expose-fact-value">${escapeHtml(v)}</span></li>`
    )
    .join("\n            ");

  const galleryBases = [
    listing.image_base,
    ...(listing.gallery_bases || []).filter((b) => b && b !== listing.image_base),
  ].filter(Boolean);

  const galleryHtml =
    galleryBases.length > 0
      ? galleryBases
          .map((b, i) => {
            const alt = `${title} – Foto ${i + 1}`;
            return `<figure class="expose-gallery-item" data-gallery-index="${i}">
              ${pictureTag(b, alt, { prefix: p, loading: i === 0 ? "eager" : "lazy" })}
            </figure>`;
          })
          .join("\n          ")
      : `<figure class="expose-gallery-item"><div class="expose-gallery-placeholder">Kein Foto verfügbar</div></figure>`;

  const thumbsHtml =
    galleryBases.length > 1
      ? `<div class="expose-thumbs" role="list">
          ${galleryBases
            .map(
              (b, i) =>
                `<button type="button" class="expose-thumb${i === 0 ? " is-active" : ""}" data-thumb-index="${i}" aria-label="Foto ${i + 1}">
              ${pictureTag(b, `${title} – Vorschaubild ${i + 1}`, { prefix: p })}
            </button>`
            )
            .join("\n          ")}
        </div>`
      : "";

  const floorBases = listing.floor_plan_bases || [];
  const floorHtml =
    floorBases.length > 0
      ? `<section class="expose-section" id="grundriss">
        <h2>Grundriss</h2>
        <div class="expose-floorplans">
          ${floorBases
            .map(
              (b, i) =>
                `<figure class="expose-floorplan">
              ${pictureTag(b, `${title} – Grundriss ${i + 1}`, { prefix: p, className: "expose-floorplan-img" })}
            </figure>`
            )
            .join("\n          ")}
        </div>
      </section>`
      : "";

  const proseHtml = (value) => String(value || "")
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, "<br>")}</p>`)
    .join("\n          ");

  const descriptionHtml = proseHtml(listing.description);
  const descriptionSection = descriptionHtml
    ? `<section class="expose-section">
            <h2>Objektbeschreibung</h2>
            <div class="expose-description prose">
          ${descriptionHtml}
            </div>
          </section>`
    : "";
  const locationSection = listing.location_description
    ? `<section class="expose-section">
            <h2>Lage</h2>
            <div class="expose-description prose">${proseHtml(listing.location_description)}</div>
          </section>`
    : "";
  const amenitiesSection = Array.isArray(listing.amenities) && listing.amenities.length
    ? `<section class="expose-section">
            <h2>Ausstattung</h2>
            <ul class="expose-amenities">
              ${listing.amenities.map((item) => `<li>${escapeHtml(item)}</li>`).join("\n              ")}
            </ul>
          </section>`
    : "";
  const additionalSection = listing.additional_information
    ? `<section class="expose-section">
            <h2>Weitere Informationen</h2>
            <div class="expose-description prose">${proseHtml(listing.additional_information)}</div>
          </section>`
    : "";

  const anfrageSubject = `Exposé-Anfrage: ${title}`;
  const prefillMsg = `Guten Tag,\\nich interessiere mich für: ${title}${listing.location ? ` (${listing.location})` : ""}.\\nBitte senden Sie mir das Exposé / weitere Informationen.\\n\\nMit freundlichen Grüßen`;

  const schema = {
    "@context": "https://schema.org",
    "@type": "RealEstateListing",
    name: title,
    description: metaDesc,
    url: canonical,
    image: ogImage,
    offers: listing.price
      ? {
          "@type": "Offer",
          priceCurrency: "EUR",
          price: String(listing.price).replace(/[^\d]/g, "") || undefined,
          availability: "https://schema.org/InStock",
        }
      : undefined,
    address: listing.location
      ? { "@type": "PostalAddress", addressLocality: "Konstanz", streetAddress: listing.location }
      : undefined,
    broker: {
      "@type": "RealEstateAgent",
      name: "Immobilien Eichmann",
      email: "info@immobilien-eichmann.com",
      telephone: "+491705225568",
      url: SITE_ORIGIN + "/",
    },
  };

  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(pageTitle)}</title>
  <meta name="description" content="${escapeHtml(metaDesc)}">
  <meta name="robots" content="index,follow">
  <link rel="canonical" href="${escapeHtml(canonical)}">
  <meta property="og:type" content="website">
  <meta property="og:locale" content="de_DE">
  <meta property="og:site_name" content="Immobilien Eichmann">
  <meta property="og:title" content="${escapeHtml(pageTitle)}">
  <meta property="og:description" content="${escapeHtml(metaDesc)}">
  <meta property="og:url" content="${escapeHtml(canonical)}">
  <meta property="og:image" content="${escapeHtml(ogImage)}">
  <meta property="og:image:alt" content="${escapeHtml(title)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(pageTitle)}">
  <meta name="twitter:description" content="${escapeHtml(metaDesc)}">
  <meta name="twitter:image" content="${escapeHtml(ogImage)}">
  <link rel="icon" href="${p}assets/logo.svg?v=noclip-v1" type="image/svg+xml">
  <link rel="icon" href="${p}assets/logo.png" type="image/png" sizes="any">
  <link rel="apple-touch-icon" href="${p}assets/apple-touch-icon.png">
<link rel="stylesheet" href="${p}css/styles.css?v=sticky-neutral-v2">
  <script type="application/ld+json">
${JSON.stringify(schema, null, 2)}
  </script>
</head>
<body>
  <header class="site-header">
    <div class="container header-inner">
      <a class="logo" href="${p}index.html" aria-label="Immobilien Eichmann – Startseite">
        <img class="logo-svg" src="${p}assets/logo-header.svg?v=header-safe-v1" alt="Immobilien Eichmann" width="320" height="56" decoding="async">
        <span class="logo-text">
          <span class="logo-mark">Immobilien Eichmann</span>
          <span class="logo-sub">Verkauf · Vermittlung · Projektentwicklung</span>
        </span>
      </a>
      <button class="menu-toggle" type="button" aria-label="Menü öffnen" aria-expanded="false">☰</button>
      <nav class="nav" aria-label="Hauptnavigation">
        <a href="${p}index.html">Start</a>
        <a href="${p}index.html#angebote">Angebote</a>
        <a href="${p}haus-verkaufen-konstanz.html">Verkauf</a>
        <a href="${p}leistungen.html">Leistungen</a>
        <a href="${p}immobilienbewertung-konstanz.html">Bewertung</a>
        <a href="${p}projekte.html">Projekte</a>
        <a href="${p}ratgeber.html">Ratgeber</a>
        <a href="${p}kontakt.html" class="nav-cta">Kontakt</a>
      </nav>
    </div>
  </header>

  <main>
    <section class="page-hero expose-hero">
      <div class="container">
        <p class="eyebrow"><a href="${p}index.html#angebote">← Alle Angebote</a></p>
        <h1>${escapeHtml(title)}</h1>
        <p>${listing.reference_number ? `<strong>${escapeHtml(listing.reference_number)}</strong> · ` : ""}${escapeHtml(listing.location || "Konstanz")}${listing.price ? ` · <strong>${escapeHtml(listing.price)}</strong>` : ""}</p>
        <span class="${badge.className}" style="position:static;display:inline-block;margin-top:0.5rem">${escapeHtml(badge.text)}</span>
      </div>
    </section>

    <section class="section">
      <div class="container expose-layout">
        <div class="expose-main">
          <div class="expose-gallery" id="expose-gallery" data-gallery-count="${galleryBases.length}">
            <div class="expose-gallery-stage">
              ${galleryHtml}
            </div>
            ${thumbsHtml}
          </div>

          <section class="expose-section">
            <h2>Eckdaten</h2>
            <ul class="expose-facts">
            ${factsHtml}
            </ul>
          </section>

          ${descriptionSection}
          ${locationSection}
          ${amenitiesSection}
          ${additionalSection}

          ${floorHtml}
        </div>

        <aside class="expose-aside">
          <div class="content-card expose-cta-card" id="anfragen">
            <h2 style="margin-top:0;color:var(--ink)">Exposé anfragen</h2>
            <form id="contact-form" class="expose-form" action="https://forms.digitalisierungsplanung.de/v1/immobilieneichmann/expose" method="POST"
              data-expose-title="${escapeHtml(title)}"
              data-expose-slug="${escapeHtml(listing.slug)}">
              <input type="hidden" name="anliegen" value="Exposé-Anfrage">
              <input type="hidden" name="objekt" value="${escapeHtml(title)}">
              <input type="hidden" name="objekt_url" value="${escapeHtml(canonical)}">
              <input type="checkbox" name="botcheck" class="hp-field" tabindex="-1" autocomplete="off" aria-hidden="true">

              <div class="form-group">
                <label for="anrede">Anrede *</label>
                <select id="anrede" name="anrede" required autocomplete="honorific-prefix">
                  <option value="">Bitte wählen</option>
                  <option value="Herr">Herr</option>
                  <option value="Frau">Frau</option>
                  <option value="Familie">Familie</option>
                </select>
              </div>
              <div class="form-group">
                <label for="vorname">Vorname *</label>
                <input type="text" id="vorname" name="vorname" required autocomplete="given-name" placeholder="Ihr Vorname">
              </div>
              <div class="form-group">
                <label for="name">Name *</label>
                <input type="text" id="name" name="name" required autocomplete="family-name" placeholder="Ihr Name">
              </div>
              <div class="form-group">
                <label for="strasse">Straße und Hausnummer *</label>
                <input type="text" id="strasse" name="strasse" required autocomplete="street-address" placeholder="Ihre Straße und Hausnummer">
              </div>
              <div class="form-row expose-address-row">
                <div class="form-group">
                  <label for="plz">PLZ *</label>
                  <input type="text" id="plz" name="plz" required autocomplete="postal-code" inputmode="numeric" placeholder="Ihre PLZ">
                </div>
                <div class="form-group">
                  <label for="ort">Ort *</label>
                  <input type="text" id="ort" name="ort" required autocomplete="address-level2" placeholder="Ihr Ort">
                </div>
              </div>
              <div class="form-group">
                <label for="phone">Telefonnummer</label>
                <input type="tel" id="phone" name="phone" autocomplete="tel" placeholder="Ihre Telefonnummer">
              </div>
              <div class="form-group">
                <label for="email">E-Mail-Adresse *</label>
                <input type="email" id="email" name="email" required autocomplete="email" placeholder="Ihre E-Mail-Adresse">
              </div>
              <p class="form-note legal-request-note">Informationen zur Verarbeitung Ihrer Angaben finden Sie in der <a href="${p}datenschutz.html">Datenschutzerklärung</a>. Durch das Absenden kommt kein Maklervertrag zustande.</p>
              <button type="submit" class="btn btn-accent" id="contact-submit">Exposé anfragen</button>
              <div id="form-success" class="form-success" role="status" hidden>
                Vielen Dank – Ihre Anfrage wurde übermittelt. Wir melden uns zeitnah.
              </div>
              <div id="form-error" class="form-error" role="alert" hidden>
                Versand über das Formular ist gerade nicht möglich.
                <button type="button" class="linkish" id="mailto-fallback">Stattdessen E-Mail-Programm öffnen</button>
                oder schreiben Sie an
                <a href="mailto:info@immobilien-eichmann.com">info@immobilien-eichmann.com</a>.
              </div>
            </form>
            <div class="expose-secondary-actions">
              <a class="btn btn-outline btn-sm" href="tel:+491705225568">Anrufen 0170 5225568</a>
              <a class="btn btn-outline btn-sm" href="${p}kontakt.html?objekt=${encodeURIComponent(listing.slug)}#contact-form">Zum Kontaktformular</a>
              <a class="btn btn-outline btn-sm" href="${escapeHtml(listing.expose_url)}" target="_blank" rel="noopener noreferrer">Exposé auf Immowelt</a>
            </div>
            <p class="expose-disclaimer">Angaben ohne Gewähr. Maßgeblich sind die aktuellen Unterlagen und das Immowelt-Exposé.</p>
          </div>
        </aside>
      </div>
    </section>
  </main>

  <footer class="site-footer">
    <div class="container">
      <div class="footer-grid footer-grid-seo">
        <div class="footer-brand">
          <p class="footer-name">Immobilien Eichmann</p>
          <p>Helmut Eichmann<br>Jacob-Burckhardt-Str. 40<br>78464 Konstanz</p>
          <p><a href="tel:+491705225568">0170 5225568</a><br>
          <a href="tel:+4975319228848">07531 9228848</a><br>
          <a href="mailto:info@immobilien-eichmann.com">info@immobilien-eichmann.com</a></p>
          <p class="footer-hours">Termine nach Vereinbarung</p>
        </div>
        <div class="footer-col">
          <h4>Immobilien Konstanz</h4>
          <a href="${p}immobilienmakler-konstanz.html">Immobilienmakler Konstanz</a>
          <a href="${p}wohnung-kaufen-konstanz.html">Wohnung kaufen Konstanz</a>
          <a href="${p}haus-verkaufen-konstanz.html">Haus verkaufen Konstanz</a>
          <a href="${p}immobilienbewertung-konstanz.html">Immobilienbewertung Konstanz</a>
          <a href="${p}index.html#angebote">Aktuelle Kaufangebote</a>
        </div>
        <div class="footer-col">
          <h4>Stadtteile &amp; Region</h4>
          <a href="${p}wollmatingen.html">Immobilien Wollmatingen</a>
          <a href="${p}allmannsdorf.html">Neubau Allmannsdorf</a>
          <a href="${p}projekte.html">Projekte &amp; Angebote</a>
          <a href="https://www.immowelt.de/profil/3b18336c6a2e401da38e9cc20268270d" target="_blank" rel="noopener noreferrer">Immowelt-Profil</a>
        </div>
        <div class="footer-col">
          <h4>Service</h4>
          <a href="${p}leistungen.html">Leistungen</a>
          <a href="${p}kontakt.html">Kontakt &amp; Termin</a>
          <a href="${p}ratgeber.html">Ratgeber</a>
          <a href="${p}impressum.html">Impressum</a>
          <a href="${p}datenschutz.html">Datenschutz</a>
          <a href="${p}widerrufsbelehrung.html">Widerrufsbelehrung</a>
          <a href="${p}vertrag-widerrufen.html">Vertrag widerrufen</a>
        </div>
      </div>
      <div class="footer-widerruf">
        <a class="btn btn-footer-widerruf" href="${p}vertrag-widerrufen.html">Vertrag widerrufen</a>
        <p class="footer-widerruf-hint">Maklervertrag in Textform widerrufen</p>
      </div>
      <div class="footer-bottom">
        <span>© <span id="y">2026</span> Immobilien Eichmann · Helmut Eichmann · Einzelunternehmen</span>
        <span>immobilieneichmann.de</span>
      </div>
    </div>
  </footer>

  <nav class="sticky-bar" aria-label="Schnellaktionen">
    <a href="#anfragen" class="sticky-item sticky-accent">
      <span class="sticky-ico" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 7 9-7"/></svg></span>
      <span>Exposé anfragen</span>
    </a>
    <a href="tel:+491705225568" class="sticky-item">
      <span class="sticky-ico" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 1.27 4.27 2 2 0 0 1 3.25 2h3a2 2 0 0 1 2 1.72c.12.86.32 1.7.59 2.5a2 2 0 0 1-.45 2.11L7.09 9.91a16 16 0 0 0 6 6l1.58-1.3a2 2 0 0 1 2.11-.45c.8.27 1.64.47 2.5.59A2 2 0 0 1 22 16.92z"/></svg></span>
      <span>Anrufen</span>
    </a>
    <a href="${p}index.html#angebote" class="sticky-item">
      <span class="sticky-ico" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1v-9.5Z"/></svg></span>
      <span>Angebote</span>
    </a>
  </nav>

  <script>window.__eichmannJsBase="${p}js/";</script>
  <script src="${p}js/cookie-consent.js?v=abs-datenschutz-v2" defer></script>
  <script src="${p}js/main.js?v=form-guard-v2" defer></script>
</body>
</html>
`;
}

async function loadJson(filePath) {
  const raw = JSON.parse(await readFile(filePath, "utf8"));
  const list = Array.isArray(raw) ? raw : raw.listings || [];
  const listings = list
    .map((item, i) => normalizeListing(item, i))
    .filter(Boolean);

  const seen = new Set();
  const unique = [];
  for (const L of listings) {
    if (seen.has(L.id)) continue;
    seen.add(L.id);
    unique.push(L);
  }
  unique.forEach((L, i) => {
    L.image_base = imageBase(i, L.id);
    L.slug = makeSlug(L);
    L.local_url = localExposePath(L);
  });

  return {
    source: raw.source || PROFILE_URL,
    scraped_at: raw.scraped_at || new Date().toISOString(),
    listing_count: unique.length,
    listings: unique,
  };
}

async function fileExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function downloadTo(url, dest) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; EichmannImmobilienBot/1.0; +https://immobilieneichmann.de)",
      Accept: "image/*,*/*",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Image download ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
  return buf;
}

async function convertImages(srcPath, base, { fit = "cover", width = 800, height = 600 } = {}) {
  let sharp;
  try {
    sharp = (await import("sharp")).default;
  } catch {
    console.warn("sharp not installed – copying source as .jpg only");
    const jpg = path.join(IMAGES_DIR, `${base}.jpg`);
    if (srcPath !== jpg) await copyFile(srcPath, jpg);
    return;
  }

  const jpg = path.join(IMAGES_DIR, `${base}.jpg`);
  const webp = path.join(IMAGES_DIR, `${base}.webp`);

  const pipelineImg = sharp(srcPath).rotate().resize({
    width,
    height,
    fit,
    withoutEnlargement: false,
  });

  await pipelineImg.clone().jpeg({ quality: 82, mozjpeg: true }).toFile(jpg);
  await pipelineImg.clone().webp({ quality: 78 }).toFile(webp);
}

function collectKeepImageBases(listings) {
  const keep = new Set();
  for (const L of listings) {
    if (L.image_base) keep.add(L.image_base);
    for (const b of L.gallery_bases || []) keep.add(b);
    for (const b of L.floor_plan_bases || []) keep.add(b);
  }
  return keep;
}

async function syncOneImage(url, base, opts = {}) {
  if (!url) return false;
  const jpgPath = path.join(IMAGES_DIR, `${base}.jpg`);
  const webpPath = path.join(IMAGES_DIR, `${base}.webp`);
  if ((await fileExists(jpgPath)) && (await fileExists(webpPath))) return true;

  const tmpExt = (url.split("?")[0].match(/\.(jpe?g|png|webp)$/i) || [, "jpg"])[1].toLowerCase();
  const tmp = path.join(IMAGES_DIR, `._tmp-${base}.${tmpExt}`);
  try {
    await downloadTo(url, tmp);
    await convertImages(tmp, base, opts);
    await unlink(tmp).catch(() => {});
    return true;
  } catch (e) {
    console.warn(`Image sync failed for ${base}:`, e.message);
    await unlink(tmp).catch(() => {});
    return false;
  }
}

function remoteMediaKey(rawUrl) {
  try {
    const u = new URL(String(rawUrl || ""));
    return path.basename(u.pathname).toLowerCase();
  } catch {
    return String(rawUrl || "").split("?")[0].toLowerCase();
  }
}

async function syncImages(data, { skipDownload = false } = {}) {
  await mkdir(IMAGES_DIR, { recursive: true });
  const keepBases = collectKeepImageBases(data.listings);

  for (let i = 0; i < data.listings.length; i++) {
    const L = data.listings[i];
    console.log(`Images ${i + 1}/${data.listings.length}: ${L.image_base}`);

    if (!skipDownload) {
      await syncOneImage(L.main_image_url, L.image_base);
    } else {
      const jpgPath = path.join(IMAGES_DIR, `${L.image_base}.jpg`);
      const webpPath = path.join(IMAGES_DIR, `${L.image_base}.webp`);
      if ((await fileExists(jpgPath)) && !(await fileExists(webpPath))) {
        try {
          await convertImages(jpgPath, L.image_base);
        } catch (e) {
          console.warn(`webp convert failed for ${L.image_base}:`, e.message);
        }
      }
    }

    // Gallery extras (skip index 0 if same as main)
    const remoteGallery = (L.images || []).filter(Boolean);
    const galleryBases = [];
    for (let g = 0; g < remoteGallery.length; g++) {
      const url = remoteGallery[g];
      // Skip the same media asset even when Immowelt and its syndication
      // partner use different CDN hostnames for the identical UUID.
      const mainKey = remoteMediaKey(L.main_image_url);
      if (remoteMediaKey(url) === mainKey && g === 0) {
        galleryBases.push(L.image_base);
        continue;
      }
      if (remoteMediaKey(url) === mainKey) continue;
      const gBase = `${L.image_base}-g${String(g + 1).padStart(2, "0")}`;
      if (!skipDownload) await syncOneImage(url, gBase);
      if (await fileExists(path.join(IMAGES_DIR, `${gBase}.jpg`))) {
        galleryBases.push(gBase);
      }
    }
    // Ensure main is first in gallery_bases for page rendering
    L.gallery_bases = [
      L.image_base,
      ...galleryBases.filter((b) => b !== L.image_base),
    ];

    const floorBases = [];
    const floors = L.floor_plans || [];
    for (let f = 0; f < floors.length; f++) {
      const item = floors[f];
      const url = typeof item === "string" ? item : item && item.url;
      if (!url) continue;
      const fBase = `${L.image_base}-fp${String(f + 1).padStart(2, "0")}`;
      if (!skipDownload) {
        await syncOneImage(url, fBase, { fit: "inside", width: 1200, height: 1200 });
      }
      if (await fileExists(path.join(IMAGES_DIR, `${fBase}.jpg`))) {
        floorBases.push(fBase);
      }
    }
    L.floor_plan_bases = floorBases;
  }

  await cleanupOrphanImages(data);
}

/** Managed image stems: Immowelt NN-xxxxxxxx(+gallery) or Admin admin-xxxxxxxx-ts */
const MANAGED_IMAGE_STEM_RE =
  /^(?:\d{2}-[a-f0-9]{8}(?:-g\d{2}|-fp\d{2})?|admin-[a-f0-9]{8}-\d+)(?:\.[a-z]+)?$/i;

async function cleanupOrphanImages(data) {
  await mkdir(IMAGES_DIR, { recursive: true });
  const keepFinal = collectKeepImageBases(data.listings);
  for (const L of data.listings) {
    for (const img of L.images || []) {
      const base = path.basename(String(img)).replace(/\.(jpe?g|png|webp)$/i, "");
      if (base) keepFinal.add(base);
    }
  }
  const files = await readdir(IMAGES_DIR).catch(() => []);
  const imgRe = /^(.*)\.(jpe?g|png|webp)$/i;
  for (const f of files) {
    if (f.startsWith("._tmp-")) {
      if (!dryRun) await unlink(path.join(IMAGES_DIR, f)).catch(() => {});
      continue;
    }
    const m = f.match(imgRe);
    if (!m) continue;
    const stem = m[1];
    if (!MANAGED_IMAGE_STEM_RE.test(stem)) continue;
    if (!keepFinal.has(stem)) {
      console.log(`Removing orphan image ${f}`);
      if (!dryRun) await unlink(path.join(IMAGES_DIR, f));
    }
  }
}

function serializeListing(L) {
  const out = {
    id: L.id,
    slug: L.slug,
    local_url: L.local_url,
    title: L.title,
    price: L.price,
    location: L.location,
    rooms: L.rooms,
    living_area: L.living_area,
    plot_area: L.plot_area,
    type: L.type,
    status: L.status,
    short_description: L.short_description,
    description: L.description || null,
    source_title: L.source_title || null,
    reference_number: L.reference_number || null,
    location_description: L.location_description || null,
    amenities: L.amenities || [],
    additional_information: L.additional_information || null,
    facts: L.facts || null,
    expose_url: L.expose_url || null,
    main_image_url: L.main_image_url,
    images: L.images || [],
    floor_plans: L.floor_plans || [],
    image_base: L.image_base,
    gallery_bases: L.gallery_bases || [],
    floor_plan_bases: L.floor_plan_bases || [],
    enriched_at: L.enriched_at || null,
    // SoT metadata (local Admin owns the record; Immowelt is optional inbound)
    source: L.source || (L.immowelt_id || looksLikeImmoweltId(L.id) ? "immowelt" : "local"),
    immowelt_id: L.immowelt_id || (looksLikeImmoweltId(L.id) ? L.id : null),
    sync_policy: L.sync_policy || "independent",
    missing_on_immowelt: L.missing_on_immowelt === true,
  };
  if (L.manual_overrides && typeof L.manual_overrides === "object") {
    out.manual_overrides = { ...L.manual_overrides };
  }
  return out;
}

function looksLikeImmoweltId(id) {
  return typeof id === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);
}

function listingImmoweltKey(L) {
  if (!L) return null;
  if (L.immowelt_id) return String(L.immowelt_id).toLowerCase();
  const fromUrl = exposeIdFromUrl(L.expose_url);
  if (fromUrl) return fromUrl.toLowerCase();
  if (looksLikeImmoweltId(L.id) && L.source !== "local") return String(L.id).toLowerCase();
  return null;
}

function hasAnyManualOverrides(prev) {
  const mo = prev && prev.manual_overrides;
  if (!mo || typeof mo !== "object") return false;
  return Object.keys(mo).some((k) => k !== "updated_at" && mo[k] === true);
}

/**
 * When source is local (or Admin locked fields), Immowelt inbound must not clobber SoT.
 * Empty local fields may still be filled from Immowelt (inbound merge only).
 */
function applyLocalAuthoritative(listing, prev) {
  if (!prev) return listing;
  const localSoT = prev.source === "local" || hasAnyManualOverrides(prev);
  if (!localSoT) return listing;

  for (const field of MANUAL_OVERRIDE_FIELDS) {
    const v = prev[field];
    const empty =
      v == null ||
      v === "" ||
      (Array.isArray(v) && v.length === 0);
    if (!empty) listing[field] = v;
  }
  if (prev.slug) {
    listing.slug = prev.slug;
    listing.local_url = prev.local_url || localExposePath(prev);
  }
  listing.source = prev.source || listing.source;
  listing.sync_policy = prev.sync_policy || listing.sync_policy || "independent";
  listing.immowelt_id = prev.immowelt_id || listing.immowelt_id || null;
  if (prev.manual_overrides) listing.manual_overrides = { ...prev.manual_overrides };
  return listing;
}

async function writeCanonical(data) {
  await mkdir(path.dirname(DATA_PATH), { recursive: true });
  const out = {
    // Single Source of Truth = this file + Admin. Immowelt is optional inbound only.
    sot: "local",
    source: data.source || PROFILE_URL,
    immowelt_profile: data.immowelt_profile || PROFILE_URL,
    scraped_at: data.scraped_at,
    listing_count: data.listings.length,
    listings: data.listings.map(serializeListing),
  };
  const json = JSON.stringify(out, null, 2) + "\n";
  if (!dryRun) await writeFile(DATA_PATH, json, "utf8");
  return out;
}

async function renderExposePages(data) {
  await mkdir(OBJEKT_DIR, { recursive: true });
  const keepSlugs = new Set(data.listings.map((L) => L.slug));

  for (const L of data.listings) {
    const html = renderExposeHtml(L);
    const fp = path.join(OBJEKT_DIR, `${L.slug}.html`);
    if (!dryRun) await writeFile(fp, html, "utf8");
    console.log(`Wrote ${L.local_url}`);
  }

  // Delete orphan HTML
  const existing = await readdir(OBJEKT_DIR).catch(() => []);
  for (const f of existing) {
    if (!f.endsWith(".html")) continue;
    const slug = f.replace(/\.html$/, "");
    if (!keepSlugs.has(slug)) {
      console.log(`Removing orphan exposé ${f}`);
      if (!dryRun) await unlink(path.join(OBJEKT_DIR, f));
    }
  }
}

function todayStamp() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Berlin" });
}

async function updateSitemap(data) {
  const lastmod = todayStamp();
  const staticUrls = STATIC_SITEMAP_PATHS.map((u) => {
    const loc = u.loc === "/" ? `${SITE_ORIGIN}/` : `${SITE_ORIGIN}${u.loc}`;
    return `  <url><loc>${loc}</loc><lastmod>${lastmod}</lastmod><changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`;
  }).join("\n");

  const objektUrls = data.listings
    .map((L) => {
      const loc = `${SITE_ORIGIN}/${L.local_url}`;
      return `  <url><loc>${loc}</loc><lastmod>${lastmod}</lastmod><changefreq>weekly</changefreq><priority>0.7</priority></url>`;
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${staticUrls}
${SITEMAP_OBJEKT_START}
${objektUrls}
${SITEMAP_OBJEKT_END}
</urlset>
`;
  if (!dryRun) await writeFile(SITEMAP_PATH, xml, "utf8");
  console.log(`Updated sitemap.xml (${data.listings.length} objekt URLs)`);
}

async function renderIntoPages(data) {
  const grid = renderGrid(data.listings);
  const n = data.listings.length;

  if (!dryRun) {
    await mkdir(path.dirname(PARTIAL_PATH), { recursive: true });
    await writeFile(PARTIAL_PATH, grid + "\n", "utf8");
  }

  for (const [file, countFn] of [
    ["index.html", countTextIndex],
    ["projekte.html", countTextProjekte],
  ]) {
    const fp = path.join(ROOT, file);
    let html = await readFile(fp, "utf8");
    const page = file.startsWith("index") ? "index" : "projekte";
    html = ensureMarkers(html);
    html = ensureCountMarkers(html, page);
    html = patchBetween(html, MARKER_START, MARKER_END, grid);
    html = patchBetween(html, COUNT_START, COUNT_END, countFn(n));
    const stand = new Date().toLocaleString("de-DE", {
      month: "long",
      year: "numeric",
      timeZone: "Europe/Berlin",
    });
    html = html.replace(
      /Stand:\s*[A-Za-zäöüÄÖÜß]+\s+\d{4}\./,
      `Stand: ${stand}.`
    );
    if (!dryRun) await writeFile(fp, html, "utf8");
    console.log(`Updated ${file} (${n} listings)`);
  }

  await renderExposePages(data);
  await updateSitemap(data);
}

/**
 * Merge Immowelt scrape (inbound only) into local SoT.
 * - New Immowelt IDs → insert candidates
 * - Existing → update unlocked fields; never clobber manual_overrides / source:local
 * - Missing on Immowelt → do NOT delete by default (flag missing_on_immowelt)
 *   Only sync_policy:"mirror" + immowelt_id may auto-remove
 * Immowelt account is NEVER written to.
 */
function mergeListings(scrapedList, previousData) {
  const prevList = previousData?.listings || [];
  const prevById = new Map(prevList.map((L) => [L.id, L]));
  const prevByImmowelt = new Map();
  for (const L of prevList) {
    const key = listingImmoweltKey(L);
    if (key) prevByImmowelt.set(key, L);
  }

  const scrapedKeys = new Set();
  const merged = [];
  const matchedPrevIds = new Set();

  scrapedList.forEach((raw, i) => {
    const id =
      raw.id ||
      exposeIdFromUrl(raw.expose_url) ||
      exposeIdFromUrl(raw.url);
    if (!id) return;
    const key = String(id).toLowerCase();
    scrapedKeys.add(key);
    const prev = prevByImmowelt.get(key) || prevById.get(id) || null;
    const L = normalizeListing(raw, i, prev);
    if (!L) return;

    L.immowelt_id = (prev && prev.immowelt_id) || id;
    L.source = (prev && prev.source) || "immowelt";
    L.sync_policy = (prev && prev.sync_policy) || "independent";
    L.missing_on_immowelt = false;

    applyManualOverrides(L, prev);
    applyLocalAuthoritative(L, prev);

    merged.push(L);
    if (prev) matchedPrevIds.add(prev.id);
  });

  let flagged = 0;
  let mirrorRemoved = 0;
  for (const prev of prevList) {
    if (matchedPrevIds.has(prev.id)) continue;

    const key = listingImmoweltKey(prev);
    const policy = prev.sync_policy || "independent";

    // Local-only (no Immowelt link): always keep
    if (!key) {
      merged.push({ ...prev, source: prev.source || "local", sync_policy: policy });
      continue;
    }

    // Linked to Immowelt but absent from scrape
    if (policy === "mirror") {
      mirrorRemoved += 1;
      console.log(
        `Mirror-delete ${shortId(prev.id)} (sync_policy=mirror, missing on Immowelt)`
      );
      continue;
    }

    flagged += 1;
    merged.push({
      ...prev,
      source: prev.source || "immowelt",
      sync_policy: policy,
      immowelt_id: prev.immowelt_id || key,
      missing_on_immowelt: true,
    });
  }

  const added = merged.filter((L) => !prevById.has(L.id));
  const updated = merged.filter((L) => prevById.has(L.id) && matchedPrevIds.has(L.id));
  console.log(
    `Sync diff (SoT): +${added.length} added, ~${updated.length} updated, ` +
      `${flagged} flagged missing_on_immowelt, ${mirrorRemoved} mirror-removed → ${merged.length} total`
  );

  merged.forEach((L, i) => {
    const prev = prevById.get(L.id) || null;
    if (
      !isManuallyOverridden(prev, "image_base") &&
      !isManuallyOverridden(prev, "images") &&
      L.source !== "local"
    ) {
      // Keep stable image_base when already set
      if (!L.image_base) L.image_base = imageBase(i, L.id);
    }
    if (!(prev && ((isManuallyOverridden(prev, "title") && prev.slug) || (prev.source === "local" && prev.slug)))) {
      if (!L.slug) {
        L.slug = makeSlug(L);
        L.local_url = localExposePath(L);
      }
    } else if (prev && prev.slug) {
      L.slug = prev.slug;
      L.local_url = prev.local_url || localExposePath(prev);
    }
    applyManualOverrides(L, prev);
    applyLocalAuthoritative(L, prev);
  });

  return merged;
}

/**
 * Enrich a single listing from Immowelt expose detail page (read-only).
 */
async function enrichFromExposePage(page, listing) {
  const url = listing.expose_url;
  const mobileUrl = url + (url.includes("?") ? "&app=1" : "?app=1");
  console.log(`Enrich ${shortId(listing.id)}: ${mobileUrl}`);
  const resp = await page.goto(mobileUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  if (!resp || resp.status() >= 400) {
    throw new Error(`Exposé HTTP ${resp && resp.status()}`);
  }
  await page.waitForTimeout(2500);

  const blocked = await page.evaluate(() => {
    const t = document.body?.innerText || "";
    return /datadome|captcha|access denied|bitte aktivieren sie javascript/i.test(t);
  });
  if (blocked) throw new Error("DataDome/captcha on expose page");

  // Scroll for lazy images
  for (let s = 0; s < 4; s++) {
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(500);
  }

  const detail = await page.evaluate(() => {
    const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();

    // Description: common Immowelt sections
    let description = null;
    const candidates = [
      ...document.querySelectorAll(
        '[data-testid*="description"], [class*="description"], [class*="Description"], section, article'
      ),
    ];
    for (const el of candidates) {
      const t = (el.innerText || "").trim();
      if (t.length > 180 && t.length < 12000 && /Zimmer|Wohnfläche|Lage|Ausstattung|Objekt/i.test(t)) {
        if (!description || t.length > description.length) description = t;
      }
    }
    // Fallback: largest paragraph block
    if (!description) {
      const paragraphs = [...document.querySelectorAll("p")]
        .map((p) => (p.innerText || "").trim())
        .filter((t) => t.length > 80);
      if (paragraphs.length) description = paragraphs.slice(0, 12).join("\n\n");
    }

    const imgEls = [...document.querySelectorAll("img")];
    const images = [];
    const floor_plans = [];
    const seen = new Set();

    function normalizeMediaUrl(raw) {
      let src = String(raw || "")
        .replace(/\\u0026/gi, "&")
        .replace(/\\u003d/gi, "=")
        .replace(/\\\//g, "/")
        .replace(/&amp;/g, "&")
        .trim();
      if (!/^https:\/\/mms\.immowelt\.de\//i.test(src)) return "";
      src = src
        .replace(/([?&])w=\d+/gi, "$1w=1600")
        .replace(/([?&])h=\d+/gi, "$1h=1200");
      return src;
    }

    function addMedia(raw, context = "") {
      const src = normalizeMediaUrl(raw);
      if (!src) return;
      const key = src.split("?")[0].toLowerCase();
      if (seen.has(key)) return;

      const ctx = String(context || "").toLowerCase();
      // Provider/logo/badge media is also served by mms.immowelt.de but must
      // never enter a property gallery.
      if (/companylogo|logourl|badgeimage|agencylogo|intermediary.{0,40}logo/.test(ctx)) return;

      seen.add(key);
      if (/grundriss|floor[ _-]?plan|floorplan|floor_plan|grundrissplan/.test(ctx)) {
        floor_plans.push(src);
      } else {
        images.push(src);
      }
    }

    // 1) Media that Immowelt has materialised into the DOM.
    for (const img of imgEls) {
      const context = `${img.alt || ""} ${img.title || ""} ${img.getAttribute("aria-label") || ""} ${img.closest("figure,li,div")?.innerText || ""}`;
      for (const raw of [
        img.currentSrc,
        img.src,
        img.getAttribute("data-src"),
        img.getAttribute("data-lazy")
      ]) addMedia(raw, context);

      for (const srcset of [img.srcset, img.getAttribute("data-srcset")]) {
        if (!srcset) continue;
        for (const candidate of srcset.split(",")) addMedia(candidate.trim().split(/\s+/)[0], context);
      }
    }
    for (const source of document.querySelectorAll("source[srcset]")) {
      for (const candidate of String(source.srcset || "").split(",")) {
        addMedia(candidate.trim().split(/\s+/)[0], source.closest("picture,figure")?.innerText || "");
      }
    }

    // 2) Immowelt's mobile SSR embeds the complete media collection in JSON
    // (__UFRN_* / lifecycle data). Carousel DOM only contains the currently
    // visible slide, so scan the embedded payload as the authoritative fallback.
    const embedded = [
      document.documentElement?.innerHTML || "",
      ...[...document.scripts].map((node) => node.textContent || "")
    ].join("\n")
      .replace(/\\u0026/gi, "&")
      .replace(/\\u003d/gi, "=")
      .replace(/\\\//g, "/");

    const mediaRe = /https:\/\/mms\.immowelt\.de\/[A-Za-z0-9_./%-]+(?:\?[A-Za-z0-9_=&.%+-]*)?/gi;
    let match;
    while ((match = mediaRe.exec(embedded))) {
      const from = Math.max(0, match.index - 260);
      const to = Math.min(embedded.length, match.index + match[0].length + 260);
      addMedia(match[0], embedded.slice(from, to));
    }

    const facts = {};
    const factPatterns = [
      [/Energieeffizienzklasse\s*([A-G]\+?)/i, "Energieeffizienzklasse"],
      [/Baujahr\s*(\d{4})/i, "Baujahr"],
      [/(\d+\.\s*Geschoss|Erdgeschoss|Dachgeschoss)/i, "Geschoss"],
      [/Heizungsart[:\s]+([^|,\n]{3,40})/i, "Heizung"],
    ];
    for (const [re, label] of factPatterns) {
      const m = text.match(re);
      if (m) facts[label] = m[1].trim();
    }

    return { description, images, floor_plans, facts, raw_len: text.length };
  });

  const mo = listing.manual_overrides || {};
  if (detail.description && mo.description !== true) {
    listing.description = detail.description.slice(0, 15000);
  }
  if (detail.images?.length && mo.images !== true) {
    listing.images = detail.images.slice(0, 80);
    if (!listing.main_image_url) listing.main_image_url = detail.images[0];
  }
  if (detail.floor_plans?.length && mo.floor_plans !== true) {
    listing.floor_plans = detail.floor_plans.slice(0, 8);
  }
  if (detail.facts && Object.keys(detail.facts).length && mo.facts !== true) {
    listing.facts = { ...(listing.facts || {}), ...detail.facts };
  }
  listing.enriched_at = new Date().toISOString();
  return listing;
}

async function enrichGalleryFromSparkasse(page, listing) {
  const mirrorUrl = SPARKASSE_EXPOSE_BY_IMMOWELT_ID[String(listing.id || "").toLowerCase()];
  if (!mirrorUrl) throw new Error("No Sparkasse mirror mapping");

  console.log(`Gallery mirror ${shortId(listing.id)}: ${mirrorUrl}`);
  const resp = await page.goto(mirrorUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  if (!resp || resp.status() >= 400) {
    throw new Error(`Sparkasse HTTP ${resp && resp.status()}`);
  }
  await page.waitForTimeout(800);

  const media = await page.evaluate(() => {
    const urls = [];
    const seen = new Set();

    function add(raw) {
      let value = String(raw || "").replace(/&amp;/g, "&").trim();
      if (!/^https:\/\/cdnihddipa\.cloudimg\.io\//i.test(value)) return;
      try {
        const u = new URL(value);
        const key = u.pathname.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        // Keep the CDN's original image (not WebP transcoding) at a useful
        // source resolution; our own Sharp pipeline creates final local files.
        u.searchParams.set("webp", "false");
        u.searchParams.set("width", "1920");
        urls.push(u.toString());
      } catch {}
    }

    // The syndicated gallery is server-rendered. Every gallery image has an
    // object-specific alt text ("... Konstanz ... kaufen/mieten"). Provider
    // logos use different alt text and are deliberately excluded here.
    for (const img of document.querySelectorAll("img")) {
      const alt = String(img.alt || "");
      if (!/Konstanz/i.test(alt) || !/(kaufen|mieten)/i.test(alt)) continue;
      add(img.currentSrc);
      add(img.src);
      for (const srcset of [img.srcset, img.getAttribute("data-srcset")]) {
        if (!srcset) continue;
        for (const candidate of String(srcset).split(",")) {
          add(candidate.trim().split(/\s+/)[0]);
        }
      }
      const link = img.closest("a[href]");
      if (link) add(link.href);
    }

    // Some variants keep full-size gallery targets only on anchors.
    for (const link of document.querySelectorAll('a[href*="cdnihddipa.cloudimg.io"]')) {
      const img = link.querySelector("img");
      const alt = String(img?.alt || link.getAttribute("aria-label") || "");
      if (/Konstanz/i.test(alt) && /(kaufen|mieten)/i.test(alt)) add(link.href);
    }
    const lines = String(document.body?.innerText || "")
      .split(/\n+/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);

    function section(name, nextNames) {
      const start = lines.findIndex((line) => line === name);
      if (start < 0) return [];
      let end = lines.length;
      for (const next of nextNames) {
        const at = lines.findIndex((line, idx) => idx > start && line === next);
        if (at >= 0 && at < end) end = at;
      }
      return lines.slice(start + 1, end);
    }
    function longestUseful(items, strip = "") {
      const cleaned = items
        .filter((line) => !/^(Mehr anzeigen|Auf Karte anzeigen|Loading \(MapContainer\)|Vollständige Adresse beim Anbieter)$/i.test(line))
        .map((line) => strip && line.startsWith(strip) ? line.slice(strip.length).trim() : line)
        .filter((line) => line.length > 20);
      return cleaned.sort((a,b) => b.length - a.length)[0] || "";
    }
    function dedupe(items) {
      return [...new Set(items.map((x) => String(x || "").trim()).filter(Boolean))];
    }
    function valueAfter(label, pools) {
      for (const pool of pools) {
        const idx = pool.findIndex((line) => line === label);
        if (idx >= 0) {
          for (let j = idx + 1; j < Math.min(pool.length, idx + 4); j++) {
            const value = pool[j];
            if (value && value !== "Keine Angabe" && value !== label && !/^(Mehr anzeigen)$/i.test(value)) return value;
          }
        }
      }
      return "";
    }

    const prices = section("Preise und Kosten", ["Finanzierung","Lage","Objektbeschreibung"]);
    const location = section("Lage", ["Objektbeschreibung","Ausstattung","Objektdaten"]);
    const description = section("Objektbeschreibung", ["Ausstattung","Objektdaten","Zustand und Energieausweis"]);
    const equipment = section("Ausstattung", ["Objektdaten","Zustand und Energieausweis","Weitere Informationen"]);
    const objectData = section("Objektdaten", ["Zustand und Energieausweis","Weitere Informationen","Anbieterinformationen"]);
    const energy = section("Zustand und Energieausweis", ["Weitere Informationen","Anbieterinformationen"]);
    const more = section("Weitere Informationen", ["Anbieterinformationen"]);

    const factLabels = [
      "Kaufpreis","Käuferprovision","Nettokaltmiete","Tiefgaragen Stellplatz (Kaufpreis)",
      "PLZ","Ort","Wohnfläche","Grundstücksfläche","Anzahl Zimmer","Anzahl Balkone","Anzahl Terrassen",
      "Parkplatztyp","Anzahl Tiefgaragen Stellplätze","Zustand","Boden","Energieausweistyp",
      "Energiestandard","Effizienzklasse","Ausstellungsdatum des Energieausweises",
      "Energieausweis gültig bis","Gebäudeart","Heizung","Befeuerung","Endenergiebedarf"
    ];
    const facts = {};
    for (const label of factLabels) {
      const value = valueAfter(label, [prices, objectData, energy]);
      if (value) facts[label] = value;
    }

    const sourceTitle = String(document.querySelector("h1")?.innerText || "").replace(/\s+/g, " ").trim();
    const titleRef = sourceTitle.match(/\b([AB]\d{1,2})\b/i)?.[1]?.toUpperCase() || "";
    return {
      urls,
      sourceTitle,
      titleRef,
      description: longestUseful(description, "Objektbeschreibung"),
      locationDescription: longestUseful(location),
      amenities: dedupe(equipment.filter((line) => line.length >= 2 && line.length <= 100 && !/Mehr anzeigen/i.test(line))),
      additionalInformation: longestUseful(more),
      facts
    };
  });

  const mediaUrls = Array.isArray(media?.urls) ? media.urls : [];
  if (mediaUrls.length < 2) {
    throw new Error(`Sparkasse gallery incomplete (${mediaUrls.length} image)`);
  }

  const mo = listing.manual_overrides || {};
  if (mo.images !== true) {
    listing.images = mediaUrls.slice(0, 80);
    if (!listing.main_image_url) listing.main_image_url = listing.images[0];
  }
  if (media.sourceTitle && mo.source_title !== true) listing.source_title = media.sourceTitle;
  if (media.sourceTitle && mo.title !== true) listing.title = media.sourceTitle;
  if (mo.reference_number !== true) {
    listing.reference_number =
      PROJECT_REFERENCE_BY_IMMOWELT_ID[String(listing.id || "").toLowerCase()] ||
      media.titleRef ||
      listing.reference_number ||
      null;
  }
  if (media.description && mo.description !== true) listing.description = media.description.slice(0, 2200);
  if (media.locationDescription && mo.location_description !== true) listing.location_description = media.locationDescription.slice(0, 1800);
  if (Array.isArray(media.amenities) && media.amenities.length && mo.amenities !== true) listing.amenities = media.amenities.slice(0, 40);
  if (media.additionalInformation && mo.additional_information !== true) listing.additional_information = media.additionalInformation.slice(0, 1800);
  if (media.facts && Object.keys(media.facts).length && mo.facts !== true) {
    listing.facts = { ...(listing.facts || {}), ...media.facts };
  }
  if (listing.reference_number && listing.facts && mo.facts !== true) {
    listing.facts = { Referenznummer: listing.reference_number, ...listing.facts };
  }
  listing.enriched_at = new Date().toISOString();
  console.log(`Gallery mirror ${shortId(listing.id)}: ${listing.images.length} images · details ${listing.description ? "yes" : "no"} · ref ${listing.reference_number || "-"}`);
  return listing;
}

async function enrichListings(listings) {
  if (skipEnrich) {
    console.log("Skipping expose enrichment (--skip-enrich)");
    return listings;
  }

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
      locale: "de-DE",
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    await context.addCookies([{
      name: "aviv_client",
      value: "ios",
      domain: ".immowelt.de",
      path: "/",
      secure: true
    }]);
    const page = await context.newPage();
    page.setDefaultTimeout(60000);

    for (let i = 0; i < listings.length; i++) {
      const L = listings[i];
      const mo = L.manual_overrides || {};
      // Admin locked both text & photos – nothing useful to pull from Immowelt
      if (mo.description === true && mo.images === true) {
        console.log(`Enrich skip (manual_overrides): ${shortId(L.id)}`);
        continue;
      }
      // Skip recent enrichment unless forced (save scrape budget)
      if (L.enriched_at && L.description && (L.images || []).length > 1) {
        const age = Date.now() - Date.parse(L.enriched_at);
        if (age < 24 * 60 * 60 * 1000 && !forceScrape) {
          console.log(`Enrich skip (fresh): ${shortId(L.id)}`);
          continue;
        }
      }
      try {
        const mirrorUrl = SPARKASSE_EXPOSE_BY_IMMOWELT_ID[String(L.id || "").toLowerCase()];
        if (mirrorUrl && mo.images !== true) {
          await enrichGalleryFromSparkasse(page, L);
        } else {
          await enrichFromExposePage(page, L);
        }
        await page.waitForTimeout(250);
      } catch (mirrorErr) {
        console.warn(`Gallery mirror failed for ${shortId(L.id)}:`, mirrorErr.message || mirrorErr);
        try {
          await enrichFromExposePage(page, L);
        } catch (err) {
          console.warn(`Enrich failed for ${shortId(L.id)}:`, err.message || err);
        }
      }
    }
  } finally {
    await browser.close();
  }
  return listings;
}

/**
 * Live scrape via Playwright. Immowelt often fronts DataDome –
 * failures are expected; caller soft-fails.
 */
async function scrapeImmowelt() {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      locale: "de-DE",
      viewport: { width: 1365, height: 900 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(60000);

    console.log(`Scraping ${PROFILE_URL}`);
    const resp = await page.goto(PROFILE_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    if (!resp || resp.status() >= 400) {
      throw new Error(`Profile HTTP ${resp && resp.status()}`);
    }

    await page.waitForTimeout(3000);
    const blocked = await page.evaluate(() => {
      const t = document.body?.innerText || "";
      return /datadome|captcha|access denied|bitte aktivieren sie javascript/i.test(
        t
      );
    });
    if (blocked) {
      throw new Error("Immowelt bot protection (DataDome/captcha) blocked scrape");
    }

    for (let s = 0; s < 6; s++) {
      await page.mouse.wheel(0, 1200);
      await page.waitForTimeout(800);
    }

    await page.waitForSelector('a[href*="/expose/"]', { timeout: 20000 }).catch(() => {});

    const raw = await page.evaluate(() => {
      const out = [];
      const seen = new Set();
      const anchors = [...document.querySelectorAll('a[href*="/expose/"]')];
      for (const a of anchors) {
        const href = a.href || a.getAttribute("href") || "";
        const m = href.match(/\/expose\/([a-f0-9-]{36})/i);
        if (!m) continue;
        const id = m[1].toLowerCase();
        if (seen.has(id)) continue;
        seen.add(id);

        let node = a;
        let best = a;
        for (let i = 0; i < 10 && node; i++) {
          const txt = node.innerText || "";
          if (/\d[\d.\s]*€/.test(txt) && txt.length < 1200) best = node;
          node = node.parentElement;
        }
        const text = (best.innerText || "").replace(/\s+/g, " ").trim();
        const img =
          best.querySelector("img")?.src ||
          best.querySelector("img")?.getAttribute("data-src") ||
          null;

        const priceM = text.match(/(\d{1,3}(?:\.\d{3})*(?:,\d+)?\s*€)/);
        const roomsM = text.match(/(\d+(?:,\d+)?\s*Zimmer)/i);
        const areaM = text.match(/(\d+(?:,\d+)?\s*m²)/);
        const plotM = text.match(/(\d+(?:\.\d{3})*(?:,\d+)?\s*m²\s*Grundstück)/i);

        let title = null;
        const parts = text.split("|").map((p) => p.trim());
        if (parts.length >= 2) title = parts[1];
        if (!title) {
          const lines = (best.innerText || "")
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);
          title =
            lines.find((l) =>
              /zum Kauf|Miete|Wohnung|Haus|Penthouse|Maisonette/i.test(l)
            ) ||
            lines[1] ||
            "Immobilie";
        }

        const locM = text.match(/([^|]*\(\d{5}\))/);
        const location = locM ? locM[1].trim() : null;

        let type = null;
        for (const t of [
          "Mehrfamilienhaus",
          "Einfamilienhaus",
          "Doppelhaushälfte",
          "Reihenhaus",
          "Maisonette",
          "Penthouse",
          "Wohnung",
          "Grundstück",
          "Gewerbe",
        ]) {
          if (new RegExp(t, "i").test(title) || new RegExp(t, "i").test(text)) {
            type = t;
            break;
          }
        }

        const shortBits = [];
        if (/provisionsfrei/i.test(text)) shortBits.push("provisionsfrei");
        if (/Erstbezug/i.test(text)) shortBits.push("Erstbezug");
        if (/Kapitalanlage/i.test(text)) shortBits.push("als Kapitalanlage geeignet");
        const floorM = text.match(/(\d+\.\s*Geschoss|Geschoss\s*\d+\/\d+)/i);
        if (floorM) shortBits.push(floorM[1]);
        if (/frei ab sofort/i.test(text)) shortBits.push("frei ab sofort");

        out.push({
          id,
          title,
          price: priceM ? priceM[1].replace(/\s+/g, " ") : null,
          location,
          rooms: roomsM ? roomsM[1] : null,
          living_area: areaM ? areaM[1] : null,
          plot_area: plotM ? plotM[1] : null,
          type,
          status: /Miete/i.test(title) ? "Miete" : "Kauf",
          short_description: shortBits.join("; ") || null,
          expose_url: `https://www.immowelt.de/expose/${id}`,
          main_image_url: img,
          raw_card_text: text,
        });
      }
      return out;
    });

    if (!raw.length) {
      throw new Error("No expose links found on profile page");
    }

    console.log(`Scraped ${raw.length} listings from profile`);
    return {
      source: PROFILE_URL,
      scraped_at: new Date().toISOString(),
      listings: raw,
    };
  } finally {
    await browser.close();
  }
}

async function main() {
  console.log("Immowelt sync – root:", ROOT);

  let previous = null;
  if (await fileExists(DATA_PATH)) {
    try {
      previous = await loadJson(DATA_PATH);
    } catch (e) {
      console.warn("Could not load previous listings.json:", e.message);
    }
  }

  let data;

  if (renderOnly) {
    if (!previous) {
      console.error("No data/listings.json – cannot --render-only");
      process.exit(1);
    }
    data = previous;
    // Persist normalized slug/local_url/gallery + SoT fields
    await writeCanonical(data);
    await renderIntoPages(data);
    // Drop orphan objekt/*.html (via renderExposePages) and unused managed images
    await cleanupOrphanImages(data);
    console.log("Render-only done (SoT JSON → HTML/grids/sitemap + orphan cleanup).");
    return;
  }

  if (enrichOnly) {
    if (!previous) {
      console.error("No data/listings.json – cannot --enrich-only");
      process.exit(1);
    }
    data = previous;
    data.scraped_at = new Date().toISOString();
    data.listings = await enrichListings(data.listings);
  } else if (fromJsonArg) {
    const src = path.resolve(fromJsonArg);
    console.log("Seeding from", src);
    const seeded = await loadJson(src);
    data = {
      source: seeded.source || PROFILE_URL,
      scraped_at: seeded.scraped_at || new Date().toISOString(),
      listings: mergeListings(seeded.listings, previous),
    };
  } else {
    try {
      const scraped = await scrapeImmowelt();
      data = {
        source: scraped.source,
        scraped_at: scraped.scraped_at,
        listings: mergeListings(scraped.listings, previous),
      };
      // Enrich from detail pages (separate browser session)
      try {
        data.listings = await enrichListings(data.listings);
      } catch (enrichErr) {
        console.warn("Enrichment pass failed (keeping card-level data):", enrichErr.message || enrichErr);
      }
    } catch (err) {
      console.error("Scrape failed (soft-fail):", err.message || err);
      if (previous) {
        console.error("Keeping last good data/listings.json – site unchanged.");
        process.exit(0);
      }
      console.error("No previous JSON available. Exiting without changes.");
      process.exit(0);
    }
  }

  if (!data.listings.length) {
    console.error("Empty listings – refusing to wipe site (soft-fail).");
    process.exit(0);
  }

  data.listings.forEach((L, i) => {
    L.image_base = imageBase(i, L.id);
    L.slug = makeSlug(L);
    L.local_url = localExposePath(L);
  });
  data.listing_count = data.listings.length;

  if (dryRun) {
    console.log(JSON.stringify({ ...data, listings: data.listings.map(serializeListing) }, null, 2));
    console.log("Dry-run: no files written.");
    return;
  }

  await writeCanonical(data);
  await syncImages(data, { skipDownload: false });
  // Re-write canonical after gallery_bases / floor_plan_bases assigned
  await writeCanonical(data);
  await renderIntoPages(data);

  console.log(`Done. ${data.listing_count} listings → JSON + cards + objekt/*.html + sitemap.`);
}

main().catch((err) => {
  console.error(err);
  const hard = process.env.IMMOWELT_HARD_FAIL === "1" || forceScrape;
  process.exit(hard ? 1 : 0);
});

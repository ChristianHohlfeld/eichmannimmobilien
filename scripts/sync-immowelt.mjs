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
 * Fail-closed: prefer official Immowelt SOAP API when API key is present
 * (/var/lib/eichmann/secrets/immowelt-api.json). Without key → awaiting_api_key
 * (no scrape success pretend). Scrape only with --force-scrape emergency.
 * On failure keep last good JSON and exit non-zero (admin-api sync.failed).
 */

import { readFile, writeFile, mkdir, readdir, unlink, copyFile, access, rm, rename, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateIncomingSnapshot, validateNoDestructiveOverwrite } from "./lib/listing-safety.mjs";
import { scrapeEichmannFromImmoweltSearch } from "./lib/immowelt-public-search.mjs";
import { reconcileMissingImmoweltOffers } from "./lib/immowelt-reconcile.mjs";
import { publicImmoweltSyncReason } from "./lib/immowelt-public-reason.mjs";
import { hasImmoweltApiKey, readImmoweltCredentials } from "./lib/immowelt-secrets.mjs";
import { fetchOfficialImmoweltListings } from "./lib/immowelt-official-api.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.EICHMANN_SITE_ROOT
  ? path.resolve(process.env.EICHMANN_SITE_ROOT)
  : path.resolve(__dirname, "..");

const PROFILE_URL =
  process.env.IMMOWELT_PROFILE_URL ||
  "https://www.immowelt.de/profil/3b18336c6a2e401da38e9cc20268270d";

const SITE_ORIGIN = "https://immobilieneichmann.de";
const DATA_PATH = path.join(ROOT, "data", "listings.json");
const SYNC_STATUS_PATH = path.join(ROOT, "data", "immowelt-sync-status.json");
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

const PROJECT_DISPLAY_TITLE_BY_IMMOWELT_ID = Object.freeze({
  "4fed09f2-bcef-4e96-ba56-810037b569c0": "Wohnung A5 · 3 Zimmer · Neubau Sunside Living",
  "aebb3257-3317-4452-bc9c-a5dbc5ed3838": "Wohnung B3 · 4 Zimmer · Neubau Sunside Living",
  "484fee8a-e3f0-4f06-8d26-d740c290b320": "Wohnung A12 · 4 Zimmer · Neubau Sunside Living",
  "4ac199b6-606e-470b-bb7e-d8646d47ea80": "Wohnung A9 · 4 Zimmer · Neubau Sunside Living",
  "bb241b38-d292-4047-98fd-4352b841bc5a": "Wohnung A3 · 2 Zimmer · Neubau Sunside Living",
  "ff414db8-7e3d-4a01-99f8-029fe15a4d55": "Wohnung A2 · 2 Zimmer · Neubau Sunside Living"
});

const PROJECT_LOCATION_BY_IMMOWELT_ID = Object.freeze({
  "4fed09f2-bcef-4e96-ba56-810037b569c0": "Wollmatingen, Konstanz (78467)",
  "aebb3257-3317-4452-bc9c-a5dbc5ed3838": "Wollmatingen, Konstanz (78467)",
  "484fee8a-e3f0-4f06-8d26-d740c290b320": "Wollmatingen, Konstanz (78467)",
  "4ac199b6-606e-470b-bb7e-d8646d47ea80": "Wollmatingen, Konstanz (78467)",
  "bb241b38-d292-4047-98fd-4352b841bc5a": "Wollmatingen, Konstanz (78467)",
  "ff414db8-7e3d-4a01-99f8-029fe15a4d55": "Wollmatingen, Konstanz (78467)"
});

const PROJECT_TYPE_BY_IMMOWELT_ID = Object.freeze({
  "bb241b38-d292-4047-98fd-4352b841bc5a": "Wohnung",
  "ff414db8-7e3d-4a01-99f8-029fe15a4d55": "Wohnung"
});

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function flattenListingProse(value) {
  return String(value || "")
    .replace(/\r/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([.!?])(?=[A-ZÄÖÜ])/g, "$1 ")
    .replace(/A\+(?=[A-Za-zÄÖÜäöüß])/g, "A+ ")
    .trim();
}

function repeatedListingStartIndex(value) {
  const text = flattenListingProse(value);

  if (text.length >= 120) {
    const probe = text.slice(0, Math.min(96, Math.floor(text.length / 2))).trim();
    if (probe.length >= 60) {
      const second = text.indexOf(probe, probe.length);
      if (second >= 70 && text.length - second >= second * 0.65) return second;
    }
  }

  const tokens = [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({
    word: m[0].toLowerCase(),
    index: m.index,
  }));
  if (tokens.length < 18) return -1;

  const n = Math.min(12, Math.max(8, Math.floor(tokens.length / 15)));
  for (let j = n; j <= tokens.length - n; j++) {
    if (tokens[j].index < 70) continue;
    let same = true;
    for (let k = 0; k < n; k++) {
      if (tokens[k].word !== tokens[j + k].word) {
        same = false;
        break;
      }
    }
    if (!same) continue;
    if ((tokens.length - j) >= j * 0.7) return tokens[j].index;
  }
  return -1;
}

function dedupeRepeatedListingText(value) {
  let text = flattenListingProse(value);
  if (!text) return "";

  for (let pass = 0; pass < 4; pass++) {
    let changed = false;

    for (const match of text.matchAll(/…/g)) {
      const before = text.slice(0, match.index).trim();
      const after = text.slice(match.index + 1).trim();
      const beforeWords = (before.match(/[\p{L}\p{N}]+/gu) || [])
        .slice(0, 10)
        .map((word) => word.toLowerCase());
      const afterWords = (after.match(/[\p{L}\p{N}]+/gu) || [])
        .slice(0, 10)
        .map((word) => word.toLowerCase());

      let common = 0;
      for (let i = 0; i < Math.min(beforeWords.length, afterWords.length); i++) {
        if (beforeWords[i] === afterWords[i]) common++;
        else break;
      }

      if (common >= 7 && after.length >= before.length * 0.8) {
        text = after;
        changed = true;
        break;
      }
    }

    if (changed) continue;

    const repeatedAt = repeatedListingStartIndex(text);
    if (repeatedAt > 0) {
      text = text.slice(repeatedAt).trim();
      changed = true;
    }

    if (!changed) break;
  }

  return text;
}

const LISTING_PROSE_HEADINGS = [
  "Besichtigungstermine",
  "Raumaufteilung",
  "Stichworte",
  "Sonstiges",
  "Wichtige Eckdaten",
  "Wohnkomfort & Ausstattung",
];

function paragraphizeListingText(value, stripHeading = "") {
  const original = String(value || "").replace(/\r/g, "").trim();
  if (
    /\n/.test(original) &&
    repeatedListingStartIndex(original) < 0
  ) {
    let preserved = original;
    if (stripHeading) {
      preserved = preserved.replace(
        new RegExp("^" + escapeRegExp(stripHeading) + "\\s*", "i"),
        ""
      );
    }
    return preserved
      .replace(/[ \t]+/g, " ")
      .replace(/[ \t]*\n[ \t]*/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  let text = dedupeRepeatedListingText(value);
  if (!text) return "";

  if (stripHeading) {
    text = text.replace(new RegExp("^" + escapeRegExp(stripHeading) + "\\s*", "i"), "");
  }

  for (const heading of LISTING_PROSE_HEADINGS) {
    const safe = escapeRegExp(heading);
    text = text
      .replace(
        new RegExp("(^|[.!?]\\s+)" + safe + ":?\\s*", "g"),
        (_, prefix) => `${prefix}\n\n${heading}:\n`
      )
      .replace(
        new RegExp(safe + "(?=[A-ZÄÖÜ])", "g"),
        `\n\n${heading}:\n`
      )
      .replace(
        new RegExp("([a-zäöüß0-9])" + safe + ":\\s*", "g"),
        (_, prefix) => `${prefix}\n\n${heading}:\n`
      );
  }

  text = text
    .replace(
      /([a-zäöüß0-9²])(?=(?:Baujahr|Sanierung|Heizung|Wohnfläche|Bezugsfrei|TV|Zustand|Heizungsart):)/g,
      "$1\n"
    )
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const paragraphs = [];

  for (const block of text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean)) {
    if (block.includes("\n")) {
      paragraphs.push(block.replace(/\n{2,}/g, "\n").trim());
      continue;
    }

    const sentences = block
      .split(/(?<=[.!?])\s+(?=[A-ZÄÖÜ0-9])/u)
      .map((sentence) => sentence.trim())
      .filter(Boolean);

    if (sentences.length <= 1) {
      paragraphs.push(block);
      continue;
    }

    let chunk = "";
    let count = 0;

    for (const sentence of sentences) {
      const next = chunk ? `${chunk} ${sentence}` : sentence;
      if (chunk && (count >= 3 || next.length > 430)) {
        paragraphs.push(chunk);
        chunk = sentence;
        count = 1;
      } else {
        chunk = next;
        count++;
      }
    }

    if (chunk) paragraphs.push(chunk);
  }

  return paragraphs.join("\n\n");
}

function cleanListingLocationText(value) {
  const cleaned = String(value || "")
    .replace(
      /^Straße nicht freigegeben[\s\S]*?(?:OpenStreetMap contributors)\s*/i,
      ""
    )
    .replace(/^Vollständige Adresse beim Anbieter\s*/i, "")
    .replace(/^Auf Karte anzeigen\s*/i, "")
    .trim();

  return paragraphizeListingText(cleaned, "Lage");
}

function fingerprintHash(value) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function contentFingerprint(value) {
  const words = (
    flattenListingProse(value).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []
  ).filter(Boolean);

  if (words.length < 3) return [];

  const hashes = new Set();
  for (let i = 0; i <= words.length - 3; i++) {
    hashes.add(fingerprintHash(words.slice(i, i + 3).join(" ")));
  }

  return [...hashes].sort().slice(0, 64);
}

function normalizeContactPhoneDisplay(value) {
  return String(value || "")
    .replace(/\b0170\s+522\s+55\s+68\b/g, "+49 170 522 55 68")
    .replace(/\b0170\s+522\s+5568\b/g, "+49 170 522 5568")
    .replace(/\b0170\s+5225568\b/g, "+49 170 522 5568")
    .replace(/\b07531\s+9228848\b/g, "+49 7531 9228848");
}

function normalizeListingTextFields(listing) {
  if (!listing || typeof listing !== "object") return listing;

  const sourceDescription = String(listing.description || "");
  if (
    sourceDescription &&
    (!Array.isArray(listing.source_description_fingerprint) ||
      !listing.source_description_fingerprint.length)
  ) {
    listing.source_description_fingerprint = contentFingerprint(sourceDescription);
  }

  if (listing.description) {
    listing.description =
      paragraphizeListingText(listing.description, "Objektbeschreibung") || null;
  }
  if (listing.location_description) {
    listing.location_description =
      cleanListingLocationText(listing.location_description) || null;
  }
  if (listing.additional_information) {
    listing.additional_information =
      paragraphizeListingText(listing.additional_information, "Weitere Informationen") || null;
  }

  return listing;
}

function exposeIdFromUrl(url) {
  if (!url) return null;
  const m = String(url).match(/\/expose\/([a-f0-9-]{36})/i);
  return m ? m[1].toLowerCase() : null;
}


/** Soft-shorten for meta/OG: never cut mid-word or mid-sentence. */
function softShorten(text, maxLen = 155) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (t.length <= maxLen) return t;
  const window = t.slice(0, maxLen + 1);
  const sentenceEnds = [". ", "! ", "? ", ".\n", "!\n", "?\n"];
  let bestSentence = -1;
  for (const end of sentenceEnds) {
    const idx = window.lastIndexOf(end);
    if (idx > bestSentence) bestSentence = idx;
  }
  if (bestSentence >= Math.floor(maxLen * 0.45)) {
    return window.slice(0, bestSentence + 1).trim();
  }
  const sp = window.lastIndexOf(" ");
  if (sp >= Math.floor(maxLen * 0.55)) {
    return window.slice(0, sp).replace(/[,\s;:–—\-]+$/u, "").trim() + "…";
  }
  return t.slice(0, maxLen).replace(/\s+\S*$/, "").trim() + "…";
}

function parseNumberOfRooms(rooms) {
  const s = String(rooms || "");
  const half = s.match(/(\d+)\s*(?:1\s*\/\s*2|½)/);
  if (half) return Number(half[1]) + 0.5;
  const m = s.match(/(\d+(?:[.,]\d+)?)/);
  return m ? Number(m[1].replace(",", ".")) : undefined;
}

function parseFloorSize(area) {
  const s = String(area || "");
  const m = s.match(/(\d+(?:[.,]\d+)?)/);
  if (!m) return undefined;
  return {
    "@type": "QuantitativeValue",
    value: Number(m[1].replace(",", ".")),
    unitCode: "MTK",
  };
}

function postalAddressFromListing(listing) {
  const facts = listing.facts && typeof listing.facts === "object" ? listing.facts : {};
  const loc = String(listing.location || "");
  const plz =
    (String(facts.PLZ || "").match(/\d{5}/) || [])[0] ||
    (loc.match(/\((\d{5})\)/) || [])[1] ||
    (loc.match(/\b(\d{5})\b/) || [])[1] ||
    undefined;
  const ort = String(facts.Ort || "").trim() || (/\bKonstanz\b/i.test(loc) ? "Konstanz" : "") || "Konstanz";
  const addr = {
    "@type": "PostalAddress",
    addressLocality: ort,
    addressCountry: "DE",
  };
  if (plz) addr.postalCode = plz;
  const district = loc.split(",")[0]?.trim();
  if (district && district.length < 48 && !new RegExp(`^${ort}$`, "i").test(district)) {
    // District / Stadtteil – keep as streetAddress stand-in (no exact street from Immowelt)
    addr.streetAddress = district;
  }
  return addr;
}

const OG_SHARE_WIDTH = 1200;
const OG_SHARE_HEIGHT = 630;

function shareOgBase(imageBase) {
  if (!imageBase) return null;
  if (/-og$/i.test(imageBase)) return imageBase;
  return `${imageBase}-og`;
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
  "active",
  "detail_page",
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

function redactPrivateAddressText(value) {
  if (value == null) return value;
  return String(value)
    .replace(/das\s+an\s+der\s+Kindlebild(?:straße|strasse)\s*13\s+liegt/gi, "das in Konstanz-Wollmatingen liegt")
    .replace(/Jacob-Burckhardt-(?:Straße|Strasse|Str\.)\s*40/gi, "Konstanz-Königsbau")
    .replace(/Kindlebild(?:straße|strasse)(?:\s*13)?/gi, "Konstanz-Wollmatingen")
    .replace(/Radolfzeller\s+(?:Straße|Strasse)(?:\s*91)?/gi, "Konstanz-Wollmatingen")
    .replace(/Allensteiner\s+(?:Straße|Strasse)(?:\s*\d+[a-z]?)?/gi, "Konstanz-Wollmatingen")
    .replace(/\b[A-ZÄÖÜ][A-Za-zÄÖÜäöüß.-]*(?:[- ][A-ZÄÖÜ][A-Za-zÄÖÜäöüß.-]*)*\s+(?:Straße|Strasse|Str\.|Weg|Platz|Allee)\s*\d+[a-z]?\b/g, "Konstanz")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function publicLocation(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  if (/Königsbau|Jacob-Burckhardt/i.test(text)) return "Königsbau, Konstanz (78464)";
  if (/Wollmatingen|Kindlebild|Radolfzeller|Allensteiner/i.test(text)) return "Wollmatingen, Konstanz (78467)";
  if (/Petershausen/i.test(text)) return "Petershausen, Konstanz (78467)";
  if (/Fürstenberg/i.test(text)) return "Fürstenberg, Konstanz (78467)";
  const postcode = text.match(/\b(7846\d)\b/);
  if (/Konstanz/i.test(text) && postcode) return `Konstanz (${postcode[1]})`;
  if (/Konstanz/i.test(text)) return "Konstanz";
  return redactPrivateAddressText(text);
}

function sanitizeListingForPublic(listing) {
  listing.location = publicLocation(listing.location);
  for (const field of [
    "title",
    "source_title",
    "short_description",
    "description",
    "location_description",
    "additional_information"
  ]) {
    if (listing[field] != null) listing[field] = redactPrivateAddressText(listing[field]);
  }
  if (Array.isArray(listing.amenities)) {
    listing.amenities = listing.amenities.map(redactPrivateAddressText).filter(Boolean);
  }
  if (listing.facts && typeof listing.facts === "object") {
    listing.facts = Object.fromEntries(
      Object.entries(listing.facts).map(([key, value]) => [key, redactPrivateAddressText(value)])
    );
  }
  return listing;
}

function isPublicListing(listing) {
  return Boolean(listing) && listing.active !== false && listing.site_hidden !== true;
}

function hasPublicDetail(listing) {
  return isPublicListing(listing) && listing.detail_page !== false;
}

function badgeFor(listing) {
  const origin = String(listing?.origin || listing?.source || "").toLowerCase();
  if (origin === "eigen" || origin === "local") {
    return { text: "nur bei uns", className: "listing-badge eigen" };
  }
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

function normalizeListing(raw, index) {
  const id =
    raw.id ||
    exposeIdFromUrl(raw.expose_url) ||
    exposeIdFromUrl(raw.url) ||
    null;
  if (!id) return null;

  const expose_url =
    raw.expose_url ||
    raw.url ||
    `https://www.immowelt.de/expose/${id}`;

  const text = (value) => String(value || "").trim() || null;
  const base = {
    id,
    title: text(raw.title) || "Immobilie",
    price: text(raw.price),
    location: text(raw.location),
    rooms: text(raw.rooms),
    living_area: text(raw.living_area || raw.livingArea),
    plot_area: raw.plot_area ?? raw.plotArea ?? null,
    type: text(raw.type),
    status: text(raw.status) || "Kauf",
    short_description: text(raw.short_description || raw.shortDescription),
    expose_url,
    main_image_url: raw.main_image_url || raw.mainImageUrl || raw.image || null,
    image_base: raw.image_base || imageBase(index, id),
    description: text(raw.description),
    source_description_fingerprint: Array.isArray(raw.source_description_fingerprint)
      ? raw.source_description_fingerprint
      : [],
    source_title: text(raw.source_title),
    reference_number: text(raw.reference_number),
    location_description: text(raw.location_description),
    amenities: Array.isArray(raw.amenities) ? raw.amenities.filter(Boolean) : [],
    additional_information: text(raw.additional_information),
    images: Array.isArray(raw.images) ? raw.images.filter(Boolean) : [],
    floor_plans: Array.isArray(raw.floor_plans) ? raw.floor_plans.filter(Boolean) : [],
    gallery_bases: Array.isArray(raw.gallery_bases) ? raw.gallery_bases : [],
    floor_plan_bases: Array.isArray(raw.floor_plan_bases) ? raw.floor_plan_bases : [],
    facts: raw.facts && typeof raw.facts === "object" ? raw.facts : null,
    enriched_at: raw.enriched_at || null,
    active: true,
    detail_page: true,
    site_hidden: false,
  };

  if (!base.main_image_url && !base.images.length && !base.gallery_bases.length) {
    base.image_base = null;
  }

  base.slug = makeSlug({ ...base, slug: raw.slug || null });
  base.local_url = localExposePath(base);
  base.source = "immowelt";
  base.immowelt_id = id;
  base.sync_policy = "mirror";
  base.missing_on_immowelt = false;
  return base;
}

function listingReference(listing) {
  return String(
    listing?.reference_number ||
    listing?.facts?.Referenznummer ||
    ""
  ).trim().toUpperCase();
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function listingDisplayTitle(listing) {
  const raw = String(listing?.title || "Immobilie").replace(/\s+/g, " ").trim();
  const ref = listingReference(listing);
  if (!ref) return raw;

  const safe = escapeRegExp(ref);
  let title = raw
    .replace(new RegExp("^Wohnung\\s+" + safe + "\\s*(?:[·:/-]\\s*)?", "i"), "")
    .replace(new RegExp("\\b" + safe + "\\b\\s*(?:/\\s*Haus\\s+[A-Z])?", "i"), "")
    .replace(/^[-–—·:/\s]+|[-–—·:/\s]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  return title || raw;
}

function renderCard(listing) {
  const badge = badgeFor(listing);
  const base = listing.image_base;
  const ref = listingReference(listing);
  const displayTitle = listingDisplayTitle(listing);
  const accessibleTitle = ref ? ref + " · " + displayTitle : displayTitle;
  const alt = `${accessibleTitle} – Immobilien Eichmann Konstanz`;
  const meta = [
    listing.rooms ? `<span>${escapeHtml(listing.rooms)}</span>` : "",
    listing.living_area ? `<span>${escapeHtml(listing.living_area)}</span>` : "",
    listing.plot_area
      ? `<span>${escapeHtml(/grundstück/i.test(listing.plot_area) ? listing.plot_area : `${listing.plot_area} Grundstück`)}</span>`
      : "",
  ].filter(Boolean).join("\n              ");

  const detailed = hasPublicDetail(listing);
  const href = listing.local_url || localExposePath(listing);
  const rel = assetRelPath(base);
  const media = rel
    ? `<picture>
              <source srcset="${escapeHtml(rel)}.webp" type="image/webp">
              <img src="${escapeHtml(rel)}.jpg" alt="${escapeHtml(alt)}" loading="lazy" width="800" height="600" decoding="async">
            </picture>`
    : `<div class="listing-photo-placeholder" aria-hidden="true"><span>Immobilien Eichmann</span></div>`;

  const body = `<div class="listing-photo">
            ${media}
            <span class="${badge.className}">${escapeHtml(badge.text)}</span>
          </div>
          <div class="listing-body">
            <div class="listing-heading">
              ${ref ? `<span class="listing-reference" aria-label="Objektnummer ${escapeHtml(ref)}">${escapeHtml(ref)}</span>` : ""}
              <h3 class="listing-title">${escapeHtml(displayTitle)}</h3>
            </div>
            <p class="listing-loc">${escapeHtml(publicLocation(listing.location) || "")}</p>
            <p class="listing-price">${escapeHtml(listing.price || "")}</p>
            <div class="listing-meta">
              ${meta}
            </div>
            <p class="listing-desc">${escapeHtml(normalizeContactPhoneDisplay(listing.short_description || ""))}</p>
            <div class="listing-actions">
              ${detailed
                ? '<span class="btn btn-primary btn-sm">Exposé ansehen</span>'
                : '<a class="btn btn-primary btn-sm" href="kontakt.html">Details anfragen</a>'}
            </div>
          </div>`;

  if (!detailed) {
    return `        <article class="listing-card listing-card-static" aria-label="${escapeHtml(accessibleTitle)} – Details auf Anfrage">
          ${body}
        </article>`;
  }
  return `        <a class="listing-card" href="${escapeHtml(href)}" aria-label="${escapeHtml(accessibleTitle)} – Exposé öffnen">
          ${body}
        </a>`;
}

function renderGrid(listings) {
  const cards = listings.filter(isPublicListing).map(renderCard).join("\n\n");
  return `${MARKER_START}\n${cards}\n${MARKER_END}`;
}

function countTextIndex(n) {
  return `${COUNT_START}${n} Kaufobjekte in und um Konstanz – Fotos und Eckdaten, Details zum Objekt.${COUNT_END}`;
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

/** Resolve gallery stem: Immowelt "01-abcd1234" → assets/listings/…; Eigen "media/eigen/id/01" → as-is. */
function assetRelPath(base) {
  const b = String(base || "").replace(/^\/+/, "").replace(/\\/g, "/");
  if (!b) return null;
  if (b.includes("/")) return b;
  return `assets/listings/${b}`;
}

function pictureTag(base, alt, { prefix = "", loading = "lazy", className = "" } = {}) {
  const rel = assetRelPath(base);
  if (!rel) return "";
  const cls = className ? ` class="${className}"` : "";
  return `<picture>
              <source srcset="${prefix}${escapeHtml(rel)}.webp" type="image/webp">
              <img src="${prefix}${escapeHtml(rel)}.jpg" alt="${escapeHtml(alt)}" loading="${loading}" width="800" height="600" decoding="async"${cls}>
            </picture>`;
}

function renderExposeHtml(listing, ogShare = null) {
  const p = "../";
  const badge = badgeFor(listing);
  const ref = listingReference(listing);
  const title = listingDisplayTitle(listing);
  const fullTitle = ref ? ref + " · " + title : title;
  const pageTitle = `${fullTitle} | Exposé – Immobilien Eichmann Konstanz`;
  const descBits = [
    listing.price,
    listing.rooms,
    listing.living_area,
    listing.location,
  ]
    .filter(Boolean)
    .join(" · ");
  const metaDesc = softShorten(
    normalizeContactPhoneDisplay(
      listing.description ||
      listing.short_description ||
      `${title} in ${listing.location || "Konstanz"} – ${descBits}. Exposé anfragen bei Immobilien Eichmann.`
    ),
    155
  );

  const canonical = `${SITE_ORIGIN}/${listing.local_url}`;
  const ogImage = ogShare?.url
    || (assetRelPath(listing.image_base) ? `${SITE_ORIGIN}/${assetRelPath(listing.image_base)}.jpg` : null)
    || `${SITE_ORIGIN}/assets/share-card-plain-v2.jpg`;
  const ogWidth = ogShare?.width || (ogShare?.url ? OG_SHARE_WIDTH : 1200);
  const ogHeight = ogShare?.height || (ogShare?.url ? OG_SHARE_HEIGHT : 630);
  // Fallback share-card is known 1200×630; tiny main thumbs must not claim those dims.
  const ogDimsKnown = Boolean(ogShare?.url) || ogImage.endsWith("/assets/share-card-plain-v2.jpg");

  const factRows = [
    ref ? ["Objektnummer", ref] : null,
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
    const represented = new Set([
      listing.price ? "Kaufpreis" : "",
      listing.rooms ? "Anzahl Zimmer" : "",
      listing.living_area ? "Wohnfläche" : "",
      listing.plot_area ? "Grundstücksfläche" : "",
      listing.location ? "PLZ" : "",
      listing.location ? "Ort" : "",
      ref ? "Referenznummer" : ""
    ].filter(Boolean));
    const labelMap = {
      "Anzahl Balkone": "Balkone",
      "Anzahl Terrassen": "Terrassen",
      "Anzahl Tiefgaragen Stellplätze": "Tiefgaragenstellplätze"
    };
    for (const [k, v] of Object.entries(listing.facts)) {
      if (v && !represented.has(k)) factRows.push([labelMap[k] || k, String(v)]);
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
    .map((para) => `<p>${escapeHtml(normalizeContactPhoneDisplay(para)).replace(/\n/g, "<br>")}</p>`)
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

  const galleryImageUrls = [
    listing.image_base,
    ...(listing.gallery_bases || []).filter((b) => b && b !== listing.image_base),
  ]
    .filter(Boolean)
    .map((b) => assetRelPath(b))
    .filter(Boolean)
    .slice(0, 12)
    .map((rel) => `${SITE_ORIGIN}/${rel}.jpg`);
  if (ogShare?.url && !galleryImageUrls.includes(ogShare.url)) {
    galleryImageUrls.unshift(ogShare.url);
  } else if (!galleryImageUrls.length && ogImage) {
    galleryImageUrls.push(ogImage);
  }
  if (galleryImageUrls.length > 12) galleryImageUrls.length = 12;

  const roomsNum = parseNumberOfRooms(listing.rooms);
  const floorSize = parseFloorSize(listing.living_area);
  const address = postalAddressFromListing(listing);

  const schema = {
    "@context": "https://schema.org",
    "@type": "RealEstateListing",
    name: title,
    description: metaDesc,
    url: canonical,
    image: galleryImageUrls.length ? galleryImageUrls : ogImage,
    offers: listing.price
      ? {
          "@type": "Offer",
          priceCurrency: "EUR",
          price: String(listing.price).replace(/[^\d]/g, "") || undefined,
          availability: "https://schema.org/InStock",
        }
      : undefined,
    address,
    numberOfRooms: roomsNum,
    floorSize: floorSize || undefined,
    broker: {
      "@type": "RealEstateAgent",
      name: "Immobilien Eichmann",
      email: "info@immobilien-eichmann.com",
      telephone: "+491705225568",
      url: SITE_ORIGIN + "/",
    },
  };

  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "Home",
        item: SITE_ORIGIN + "/",
      },
      {
        "@type": "ListItem",
        position: 2,
        name: "Angebote",
        item: SITE_ORIGIN + "/index.html#angebote",
      },
      {
        "@type": "ListItem",
        position: 3,
        name: title,
        item: canonical,
      },
    ],
  };

  const waShareHref = `https://wa.me/?text=${encodeURIComponent(`${title} ${canonical}`)}`;

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
  ${ogDimsKnown ? `<meta property="og:image:width" content="${ogWidth}">
  <meta property="og:image:height" content="${ogHeight}">` : ""}
  <meta property="og:image:alt" content="${escapeHtml(title)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(pageTitle)}">
  <meta name="twitter:description" content="${escapeHtml(metaDesc)}">
  <meta name="twitter:image" content="${escapeHtml(ogImage)}">
  <link rel="icon" href="${p}assets/logo.svg?v=noclip-v1" type="image/svg+xml">
  <link rel="icon" href="${p}assets/logo.png" type="image/png" sizes="any">
  <link rel="apple-touch-icon" href="${p}assets/apple-touch-icon.png">
<link rel="stylesheet" href="${p}css/styles.css?v=expose-mobile-overflow-v1">
  <script type="application/ld+json">
${JSON.stringify(schema, null, 2)}
  </script>
  <script type="application/ld+json">
${JSON.stringify(breadcrumbSchema, null, 2)}
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
        <h1 class="expose-title">${ref ? `<span class="expose-reference">${escapeHtml(ref)}</span>` : ""}<span>${escapeHtml(title)}</span></h1>
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
              <a class="btn btn-outline btn-sm" href="tel:+491705225568">Anrufen +49 170 522 5568</a>
              <a class="btn btn-outline btn-sm" href="${p}kontakt.html?objekt=${encodeURIComponent(listing.slug)}#contact-form">Zum Kontaktformular</a>
              <a class="btn btn-outline btn-sm" href="${escapeHtml(waShareHref)}" target="_blank" rel="noopener noreferrer">Per WhatsApp teilen</a>
              <a class="btn btn-outline btn-sm" href="${escapeHtml(listing.expose_url)}" target="_blank" rel="noopener noreferrer">Exposé auf Immowelt</a>
            </div>
            <p class="expose-disclaimer">Angaben ohne Gewähr. Maßgeblich sind die aktuellen Unterlagen und das Immowelt-Exposé.</p>
            <p class="immowelt-attribution"><a href="https://www.immowelt.de/" target="_blank" rel="noopener noreferrer">Immobilien-Daten bereitgestellt von immowelt.de</a></p>
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
          <p><a href="tel:+491705225568">+49 170 522 5568</a><br>
          <a href="tel:+4975319228848">+49 7531 9228848</a><br>
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
    .map((item, i) => {
      const listing = normalizeListing(item, i);
      if (!listing) return null;

      // Reading the persisted mirror must be lossless. Fresh Immowelt scrapes
      // mark every currently present profile offer active; render-only must not
      // silently reactivate records that the stored snapshot marks inactive.
      if (typeof item.active === "boolean") listing.active = item.active;
      if (typeof item.detail_page === "boolean") listing.detail_page = item.detail_page;
      listing.site_hidden = item.site_hidden === true;
      return listing;
    })
    .filter(Boolean);

  const seen = new Set();
  const unique = [];
  for (const L of listings) {
    if (seen.has(L.id)) continue;
    seen.add(L.id);
    unique.push(L);
  }
  unique.forEach((L, i) => {
    if (!(L.detail_page === false && !L.main_image_url && !(L.images || []).length)) {
      L.image_base = L.image_base || imageBase(i, L.id);
    } else {
      L.image_base = null;
    }
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
    if (L.image_base) {
      keep.add(L.image_base);
      keep.add(shareOgBase(L.image_base));
    }
    for (const b of L.gallery_bases || []) {
      keep.add(b);
      keep.add(shareOgBase(b));
    }
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


async function localListingImagePath(base) {
  const rel = assetRelPath(base);
  if (!rel) return null;
  const jpg = path.join(ROOT, `${rel}.jpg`);
  if (await fileExists(jpg)) return jpg;
  const webp = path.join(ROOT, `${rel}.webp`);
  if (await fileExists(webp)) return webp;
  return null;
}

async function pickLargestLocalSource(listing) {
  const seen = new Set();
  const candidates = [];
  for (const b of [...(listing.gallery_bases || []), listing.image_base]) {
    if (!b || seen.has(b)) continue;
    seen.add(b);
    candidates.push(b);
  }
  let sharp;
  try {
    sharp = (await import("sharp")).default;
  } catch {
    // Fall back to first existing file without measuring
    for (const b of candidates) {
      const p = await localListingImagePath(b);
      if (p) return p;
    }
    return null;
  }
  let bestPath = null;
  let bestArea = -1;
  for (const b of candidates) {
    const p = await localListingImagePath(b);
    if (!p) continue;
    try {
      const meta = await sharp(p).metadata();
      const area = (meta.width || 0) * (meta.height || 0);
      if (area > bestArea) {
        bestArea = area;
        bestPath = p;
      }
    } catch {
      if (!bestPath) bestPath = p;
    }
  }
  return bestPath;
}

/**
 * Ensure a 1200×630 share crop exists for WhatsApp/FB/Twitter previews.
 * Prefer largest local gallery asset (≥ gallery 800×600) over tiny main thumbs.
 */
async function ensureShareOgImage(listing) {
  if (!listing?.image_base) return null;
  const ogBase = shareOgBase(listing.image_base);
  const rel = assetRelPath(ogBase);
  if (!rel) return null;
  const outJpg = path.join(ROOT, `${rel}.jpg`);
  const outWebp = path.join(ROOT, `${rel}.webp`);

  let sharp;
  try {
    sharp = (await import("sharp")).default;
  } catch {
    console.warn("sharp not installed – cannot build share OG crop");
    return null;
  }

  let needsWrite = true;
  if (await fileExists(outJpg)) {
    try {
      const meta = await sharp(outJpg).metadata();
      if (meta.width === OG_SHARE_WIDTH && meta.height === OG_SHARE_HEIGHT) {
        needsWrite = false;
      }
    } catch {
      needsWrite = true;
    }
  }

  if (needsWrite) {
    const src = await pickLargestLocalSource(listing);
    if (!src) return null;
    await mkdir(path.dirname(outJpg), { recursive: true });
    const pipeline = sharp(src).rotate().resize({
      width: OG_SHARE_WIDTH,
      height: OG_SHARE_HEIGHT,
      fit: "cover",
      position: "centre",
      withoutEnlargement: false,
    });
    await pipeline.clone().jpeg({ quality: 85, mozjpeg: true }).toFile(outJpg);
    await pipeline.clone().webp({ quality: 80 }).toFile(outWebp);
    console.log(`Share OG ${ogBase} (${OG_SHARE_WIDTH}×${OG_SHARE_HEIGHT}) from ${path.basename(src)}`);
  }

  return {
    base: ogBase,
    url: `${SITE_ORIGIN}/${rel}.jpg`,
    width: OG_SHARE_WIDTH,
    height: OG_SHARE_HEIGHT,
  };
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
    console.log(`Images ${i + 1}/${data.listings.length}: ${L.image_base || "-"}`);
    if (L.active === false) continue;
    if (L.detail_page === false && !L.main_image_url) {
      L.image_base = null;
      L.gallery_bases = [];
      L.floor_plan_bases = [];
      continue;
    }

    // Path-style Eigen bases (media/eigen/…) are local uploads — never fetch as Immowelt CDN URLs
    const isLocalPathBase = String(L.image_base || "").includes("/");
    if (isLocalPathBase) {
      const bases = [
        L.image_base,
        ...(L.gallery_bases || []).filter((b) => b && b !== L.image_base),
      ].filter(Boolean);
      L.gallery_bases = bases;
      continue;
    }

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
  /^(?:\d{2}-[a-f0-9]{8}(?:-g\d{2}|-fp\d{2}|-og)?|admin-[a-f0-9]{8}-\d+(?:-og)?)(?:\.[a-z]+)?$/i;

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
    source_description_fingerprint: L.source_description_fingerprint || [],
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
    active: L.active !== false,
    detail_page: L.detail_page !== false,
    site_hidden: L.site_hidden === true,
    // SoT metadata: Immowelt owns listing content and publication state.
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

function semanticListingSnapshot(listings) {
  return (listings || []).map((item) => {
    const out = serializeListing(item);
    // Enrichment bookkeeping is not an object-data change.
    delete out.enriched_at;
    return out;
  }).sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function semanticListingsChanged(previousData, nextListings) {
  if (!Array.isArray(previousData?.listings)) return true;
  return JSON.stringify(semanticListingSnapshot(previousData.listings)) !==
    JSON.stringify(semanticListingSnapshot(nextListings));
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

async function atomicWriteJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(tmp, filePath);
}

async function writeSyncStatus({ state, previous = null, data = null, reason = null, assessment = null, mode = null }) {
  const previousActive = Array.isArray(previous?.listings)
    ? previous.listings.filter((item) => item && item.active !== false).length
    : Number(previous?.active_listing_count || 0);
  const currentActive = Array.isArray(data?.listings)
    ? data.listings.filter((item) => item && item.active !== false).length
    : null;
  const payload = {
    source: "immowelt",
    mode: mode || (state === "awaiting_api_key" ? "official_api" : null),
    state,
    // The newest real check time comes from GitHub Actions. Keep this file stable
    // so unchanged 15-minute checks do not create artificial repository commits.
    last_valid_at: state === "current"
      ? (data?.scraped_at || previous?.scraped_at || null)
      : (previous?.scraped_at || null),
    last_valid_count: state === "current" ? currentActive : previousActive,
    attempted_count: assessment?.count ?? null,
    overlap_count: assessment?.overlap_count ?? null,
    overlap_ratio: assessment?.overlap_ratio ?? null,
    reason: reason ? publicImmoweltSyncReason(reason, state).slice(0, 500) : null,
    policy: "fail_closed_last_known_good",
  };
  if (!payload.mode) delete payload.mode;
  if (!dryRun) await atomicWriteJson(SYNC_STATUS_PATH, payload);
  return payload;
}

async function writeCanonical(data) {
  await mkdir(path.dirname(DATA_PATH), { recursive: true });
  data.listings = data.listings.map(normalizeListingTextFields).map(sanitizeListingForPublic);
  const out = {
    // Single Source of Truth = Immowelt. This file is a generated local mirror for rendering.
    sot: process.env.EICHMANN_SOT || "sqlite",
    source: data.source || PROFILE_URL,
    immowelt_profile: data.immowelt_profile || PROFILE_URL,
    scraped_at: data.scraped_at,
    listing_count: data.listings.length,
    active_listing_count: data.listings.filter(isPublicListing).length,
    listings: data.listings.map(serializeListing),
  };
  if (!dryRun) await atomicWriteJson(DATA_PATH, out);
  return out;
}

async function renderExposePages(data) {
  await mkdir(OBJEKT_DIR, { recursive: true });
  const detailed = data.listings.filter(hasPublicDetail);
  const keepSlugs = new Set(detailed.map((L) => L.slug));

  for (const L of detailed) {
    const ogShare = dryRun ? null : await ensureShareOgImage(L);
    const html = renderExposeHtml(L, ogShare);
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

/** W3C lastmod in Europe/Berlin (date or datetime). Prefer real publish/mtime over stale scraped_at. */
function sitemapLastmod(sourceDate = null, { withTime = true } = {}) {
  const parsed = sourceDate ? new Date(sourceDate) : null;
  const date = parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date();
  const datePart = date.toLocaleDateString("en-CA", { timeZone: "Europe/Berlin" });
  if (!withTime) return datePart;
  const timePart = date.toLocaleTimeString("en-GB", {
    timeZone: "Europe/Berlin",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const offsetPart = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Berlin",
    timeZoneName: "longOffset",
  })
    .formatToParts(date)
    .find((p) => p.type === "timeZoneName")?.value;
  // "GMT+02:00" / "GMT+2" → "+02:00"
  let offset = "+02:00";
  const m = String(offsetPart || "").match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);
  if (m) {
    offset = `${m[1]}${String(m[2]).padStart(2, "0")}:${String(m[3] || "00").padStart(2, "0")}`;
  }
  return `${datePart}T${timePart}${offset}`;
}

/** @deprecated use sitemapLastmod — kept for any callers expecting YYYY-MM-DD */
function todayStamp(sourceDate = null) {
  return sitemapLastmod(sourceDate, { withTime: false });
}

async function fileLastmodOr(filePath, fallbackDate) {
  try {
    const st = await stat(filePath);
    return sitemapLastmod(st.mtime);
  } catch {
    return sitemapLastmod(fallbackDate);
  }
}

async function updateSitemap(data) {
  // Publish/render moment — never reuse a frozen scraped_at (e.g. 2026-09-20).
  const publishAt = new Date();
  const publishLastmod = sitemapLastmod(publishAt);

  const staticLines = [];
  for (const u of STATIC_SITEMAP_PATHS) {
    const loc = u.loc === "/" ? `${SITE_ORIGIN}/` : `${SITE_ORIGIN}${u.loc}`;
    const rel = u.loc === "/" ? "index.html" : u.loc.replace(/^\//, "");
    const lastmod = await fileLastmodOr(path.join(ROOT, rel), publishAt);
    staticLines.push(
      `  <url><loc>${loc}</loc><lastmod>${lastmod}</lastmod><changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`
    );
  }
  const staticUrls = staticLines.join("\n");

  const objektLines = [];
  for (const L of data.listings.filter(hasPublicDetail)) {
    const loc = `${SITE_ORIGIN}/${L.local_url}`;
    // Exposé HTML is written in this publish pass → prefer file mtime, else publish time.
    const lastmod = await fileLastmodOr(path.join(ROOT, L.local_url), publishAt);
    objektLines.push(
      `  <url><loc>${loc}</loc><lastmod>${lastmod}</lastmod><changefreq>weekly</changefreq><priority>0.7</priority></url>`
    );
  }
  const objektUrls = objektLines.join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${staticUrls}
${SITEMAP_OBJEKT_START}
${objektUrls}
${SITEMAP_OBJEKT_END}
</urlset>
`;
  if (!dryRun) await writeFile(SITEMAP_PATH, xml, "utf8");
  console.log(
    `Updated sitemap.xml (${data.listings.filter(hasPublicDetail).length} objekt URLs, publish lastmod ${publishLastmod})`
  );
}

async function renderIntoPages(data) {
  const publicListings = data.listings.filter(isPublicListing);
  const grid = renderGrid(publicListings);
  const n = publicListings.length;

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
function mergeListings(scrapedList, previousData, { confirmedInactiveIds = [] } = {}) {
  const prevListAll = Array.isArray(previousData?.listings) ? previousData.listings : [];
  // Immowelt merge must ignore eigen/local SoT rows (they live in SQLite origin=eigen).
  const prevList = prevListAll.filter((item) => {
    const origin = String(item?.origin || item?.source || "immowelt").toLowerCase();
    return origin !== "eigen" && origin !== "local";
  });
  const prevById = new Map(prevList.map((item) => [String(item.immowelt_id || item.id || "").toLowerCase(), item]));
  const inactive = new Set((confirmedInactiveIds || []).map((id) => String(id).toLowerCase()));
  const seen = new Set();
  const merged = [];

  scrapedList.forEach((raw, index) => {
    const id = String(raw.id || exposeIdFromUrl(raw.expose_url) || exposeIdFromUrl(raw.url) || "").toLowerCase();
    if (!id) return;
    const prev = prevById.get(id) || null;
    const listing = normalizeListing(raw, index, prev);
    if (!listing) return;
    listing.active = true;
    listing.detail_page = true;
    listing.site_hidden = prev?.site_hidden === true;
    listing.source = "immowelt";
    listing.origin = "immowelt";
    listing.immowelt_id = id;
    listing.sync_policy = "mirror";
    listing.missing_on_immowelt = false;
    delete listing.manual_overrides;
    seen.add(id);
    merged.push(listing);
  });

  for (const prev of prevList) {
    const id = String(prev.immowelt_id || prev.id || "").toLowerCase();
    if (!id || seen.has(id)) continue;
    const kept = normalizeListing(prev, merged.length, prev);
    if (!kept) continue;
    kept.source = "immowelt";
    kept.origin = "immowelt";
    kept.immowelt_id = id;
    kept.sync_policy = "mirror";
    kept.site_hidden = prev.site_hidden === true;
    kept.detail_page = prev.detail_page !== false;
    if (inactive.has(id)) {
      kept.active = false;
      kept.missing_on_immowelt = true;
    } else {
      // Already-inactive history is retained. An active object can reach here only
      // if the reconciliation gate has explicitly resolved it; otherwise the run fails.
      kept.active = prev.active !== false;
      kept.missing_on_immowelt = prev.missing_on_immowelt === true;
    }
    delete kept.manual_overrides;
    merged.push(kept);
  }

  console.log(`Immowelt authority: ${scrapedList.length} current offers; ${inactive.size} confirmed inactive; ${merged.length} records retained.`);
  return merged;
}

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
      [/Referenz(?:nummer|nr\.?)[\s:#-]*([A-Z0-9][A-Z0-9._/-]{0,31})/i, "Referenznummer"],
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
    listing.source_description_fingerprint = contentFingerprint(detail.description);
    listing.description = paragraphizeListingText(detail.description, "Objektbeschreibung").slice(0, 15000);
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
  if (detail.facts?.Referenznummer && mo.reference_number !== true) {
    listing.reference_number = String(detail.facts.Referenznummer).trim().toUpperCase();
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

  // The syndicated detail page collapses long description/location blocks.
  // Expand every visible "Mehr anzeigen" control before reading text so our
  // local exposé never persists teaser text ending in an ellipsis.
  const expanders = page.locator('button:has-text("Mehr anzeigen"), a:has-text("Mehr anzeigen")');
  const expanderCount = await expanders.count().catch(() => 0);
  for (let i = 0; i < expanderCount; i++) {
    const control = expanders.nth(i);
    if (await control.isVisible().catch(() => false)) {
      await control.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(80);
    }
  }

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
    const lines = String(document.body?.textContent || document.body?.innerText || "")
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
    function cleanProse(value) {
      return String(value || "")
        .replace(/\s+/g, " ")
        .replace(/\s+([,.;:!?])/g, "$1")
        .replace(/([.!?])(?=[A-ZÄÖÜ])/g, "$1 ")
        .replace(/A\+(?=[A-Za-zÄÖÜäöüß])/g, "A+ ")
        .trim();
    }
    function dedupeRepeatedProse(value) {
      let text = cleanProse(value);
      if (!text) return "";
      const ellipsis = text.indexOf("…");
      if (ellipsis > 50) {
        const teaser = text.slice(0, ellipsis).trim();
        const rest = text.slice(ellipsis + 1).trim();
        const probe = teaser.slice(0, Math.min(90, teaser.length));
        if (probe.length >= 40 && rest.startsWith(probe)) text = rest;
      }
      const probe = text.slice(0, Math.min(100, text.length));
      if (probe.length >= 50) {
        const second = text.indexOf(probe, probe.length);
        if (second > 0 && text.length - second >= second * 0.75) text = text.slice(second).trim();
      }
      return text;
    }
    function cleanLocationProse(value) {
      return dedupeRepeatedProse(value)
        .replace(/^Straße nicht freigegeben.*?(?:OpenStreetMap contributors)\s*/i, "")
        .replace(/^Vollständige Adresse beim Anbieter\s*/i, "")
        .trim();
    }
    function longestUseful(items, strip = "") {
      const cleaned = items
        .filter((line) => !/^(Mehr anzeigen|Auf Karte anzeigen|Loading \(MapContainer\)|Vollständige Adresse beim Anbieter)$/i.test(line))
        .map((line) => strip && line.startsWith(strip) ? line.slice(strip.length).trim() : line)
        .map(dedupeRepeatedProse)
        .filter((line) => line.length > 20);
      return cleaned.sort((a,b) => b.length - a.length)[0] || "";
    }
    function dedupe(items) {
      return [...new Set(items.map((x) => String(x || "").trim()).filter(Boolean))];
    }
    const knownFactLabels = new Set([
      "Kaufpreis","Käuferprovision","Nettokaltmiete","Tiefgaragen Stellplatz (Kaufpreis)","Garagen Stellplatz (Kaufpreis)",
      "Garagen Stellplatz (Kaufpreis)","Referenznummer","PLZ","Ort","Wohnfläche","Grundstücksfläche",
      "Anzahl Zimmer","Anzahl Balkone","Anzahl Terrassen","Parkplatztyp",
      "Anzahl Tiefgaragen Stellplätze","Zustand","Boden","Energieausweistyp",
      "Energiestandard","Effizienzklasse","Ausstellungsdatum des Energieausweises",
      "Energieausweis gültig bis","Gebäudeart","Heizung","Befeuerung","Endenergiebedarf"
    ]);
    function valueAfter(label, pools) {
      for (const pool of pools) {
        const idx = pool.findIndex((line) => line === label);
        if (idx < 0) continue;
        for (let j = idx + 1; j < Math.min(pool.length, idx + 4); j++) {
          const value = pool[j];
          if (knownFactLabels.has(value)) break;
          if (value && value !== "Keine Angabe" && value !== label && !/^(Mehr anzeigen)$/i.test(value)) return value;
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

    // Hidden expanded prose is present in the server-rendered DOM even when
    // the visual component initially shows a teaser. Extract the DOM range
    // between section headings and prefer a non-ellipsis descendant.
    function fullSectionText(name) {
      const headings = [...document.querySelectorAll("h2,h3")];
      const start = headings.find((el) => cleanProse(el.textContent) === name);
      if (!start) return "";
      const startIndex = headings.indexOf(start);
      const end = headings.slice(startIndex + 1).find((el) => /^H2$/i.test(el.tagName)) || null;
      try {
        const range = document.createRange();
        range.setStartAfter(start);
        if (end) range.setEndBefore(end);
        else range.setEndAfter(document.body.lastChild || document.body);
        const fragment = range.cloneContents();
        const candidates = [
          fragment.textContent || "",
          ...[...fragment.querySelectorAll("p,div,span")].map((el) => el.textContent || "")
        ]
          .map((value) => cleanProse(value).replace(/\s*Mehr anzeigen\s*$/i, "").trim())
          .filter((value) => value.length > 40)
          .filter((value, idx, arr) => arr.indexOf(value) === idx);
        const complete = candidates.filter((value) => !/…\s*$/.test(value));
        const pool = complete.length ? complete : candidates;
        return pool.sort((a,b) => b.length - a.length)[0] || "";
      } catch {
        return "";
      }
    }

    const fullDescription = fullSectionText("Objektbeschreibung");
    const fullLocation = fullSectionText("Lage");
    const fullMore = fullSectionText("Weitere Informationen");

    const factLabels = [
      "Kaufpreis","Käuferprovision","Nettokaltmiete","Tiefgaragen Stellplatz (Kaufpreis)",
      "Referenznummer","PLZ","Ort","Wohnfläche","Grundstücksfläche","Anzahl Zimmer","Anzahl Balkone","Anzahl Terrassen",
      "Parkplatztyp","Anzahl Tiefgaragen Stellplätze","Zustand","Boden","Energieausweistyp",
      "Energiestandard","Effizienzklasse","Ausstellungsdatum des Energieausweises",
      "Energieausweis gültig bis","Gebäudeart","Heizung","Befeuerung","Endenergiebedarf"
    ];
    const facts = {};
    for (const label of factLabels) {
      const value = valueAfter(label, [prices, objectData, energy]);
      if (value) facts[label] = value;
    }

    const sourceTitle = cleanProse(document.querySelector("h1")?.innerText || "");
    const titleRef = sourceTitle.match(/\b([AB]\d{1,2})\b/i)?.[1]?.toUpperCase() || "";
    return {
      urls,
      sourceTitle,
      titleRef,
      description: dedupeRepeatedProse(fullDescription || longestUseful(description, "Objektbeschreibung")),
      locationDescription: cleanLocationProse(fullLocation || longestUseful(location)),
      amenities: dedupe(equipment.filter((line) => line.length >= 2 && line.length <= 100 && !/Mehr anzeigen/i.test(line))),
      additionalInformation: dedupeRepeatedProse(fullMore || longestUseful(more)),
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
  const listingKey = String(listing.id || "").toLowerCase();
  if (media.sourceTitle && mo.source_title !== true) listing.source_title = media.sourceTitle;
  if (mo.title !== true) {
    listing.title = PROJECT_DISPLAY_TITLE_BY_IMMOWELT_ID[listingKey] || media.sourceTitle || listing.title;
  }
  if (mo.location !== true && PROJECT_LOCATION_BY_IMMOWELT_ID[listingKey]) {
    listing.location = PROJECT_LOCATION_BY_IMMOWELT_ID[listingKey];
  }
  if (mo.reference_number !== true) {
    listing.reference_number =
      media.facts?.Referenznummer ||
      media.titleRef ||
      PROJECT_REFERENCE_BY_IMMOWELT_ID[listingKey] ||
      listing.reference_number ||
      null;
  }
  if (mo.price !== true && media.facts?.Kaufpreis) listing.price = media.facts.Kaufpreis;
  if (mo.rooms !== true && media.facts?.["Anzahl Zimmer"]) listing.rooms = `${media.facts["Anzahl Zimmer"]} Zimmer`;
  if (mo.living_area !== true && media.facts?.Wohnfläche) listing.living_area = media.facts.Wohnfläche;
  if (mo.plot_area !== true && media.facts?.Grundstücksfläche) listing.plot_area = media.facts.Grundstücksfläche;
  if (mo.type !== true && PROJECT_TYPE_BY_IMMOWELT_ID[listingKey]) listing.type = PROJECT_TYPE_BY_IMMOWELT_ID[listingKey];
  if (media.description && mo.description !== true) {
    listing.source_description_fingerprint = contentFingerprint(media.description);
    listing.description = paragraphizeListingText(media.description, "Objektbeschreibung").slice(0, 15000);
  }
  if (media.locationDescription && mo.location_description !== true) {
    listing.location_description = cleanListingLocationText(media.locationDescription).slice(0, 10000);
  }
  if (Array.isArray(media.amenities) && media.amenities.length && mo.amenities !== true) {
    listing.amenities = media.amenities.slice(0, 40);
  }
  if (media.additionalInformation && mo.additional_information !== true) {
    listing.additional_information = paragraphizeListingText(media.additionalInformation, "Weitere Informationen").slice(0, 10000);
  }
  if (media.facts && Object.keys(media.facts).length && mo.facts !== true) {
    // Mirror data is authoritative for the currently published detail page.
    // Replace provider-derived facts instead of merging stale keys from older
    // parser versions (e.g. a missing Nettokaltmiete swallowing the next label).
    listing.facts = { ...media.facts };
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
      if (L.active === false || L.detail_page === false) {
        console.log(`Enrich skip (not publicly detailed): ${shortId(L.id)}`);
        continue;
      }
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
async function probeCurrentImmoweltOffer(page, id) {
  const url = `https://www.immowelt.de/expose/${id}?app=1`;
  try {
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    const status = resp?.status() || 0;
    if (status === 404 || status === 410) return { state: "inactive", reason: `HTTP ${status}` };
    if (!resp || status >= 400) return { state: "unknown", reason: `HTTP ${status || "none"}` };
    await page.waitForTimeout(800);
    const text = await page.evaluate(() => String(document.body?.innerText || "").replace(/\s+/g, " ").trim());
    if (/datadome|captcha|access denied|bitte aktivieren sie javascript/i.test(text)) {
      return { state: "unknown", reason: "source protection page" };
    }
    if (/anzeige.{0,50}(?:nicht mehr|deaktiviert|gelöscht)|objekt.{0,50}(?:nicht mehr verfügbar|nicht verfügbar)|angebot.{0,50}(?:nicht mehr verfügbar|beendet)/i.test(text)) {
      return { state: "inactive", reason: "Immowelt marks offer unavailable" };
    }
    if (!/Immobilien\s+Eichmann/i.test(text)) {
      return { state: "unknown", reason: "provider identity not verifiable" };
    }
    return { state: "active", reason: "active Immowelt expose" };
  } catch (err) {
    return { state: "unknown", reason: err?.message || String(err) };
  }
}

async function scrapeImmowelt(previousData = null) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  try {
    // Use the same Immowelt app/mobile context that already works for
    // expose reads. The desktop profile route is blocked by DataDome on
    // GitHub-hosted runners (HTTP 403), while the app surface is intended
    // for programmatic/mobile clients and serves the same Immowelt data.
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
      secure: true,
    }]);
    const page = await context.newPage();
    page.setDefaultTimeout(60000);

    const withAppSurface = (url) =>
      url + (url.includes("?") ? "&app=1" : "?app=1");
    const profileCandidates = [...new Set([
      withAppSurface(PROFILE_URL),
      PROFILE_URL,
      withAppSurface(PROFILE_URL.replace("www.immowelt.de", "www.immowelt.at")),
      PROFILE_URL.replace("www.immowelt.de", "www.immowelt.at"),
    ])];
    let loadedProfile = null;
    const profileErrors = [];

    for (const candidate of profileCandidates) {
      console.log(`Scraping ${candidate}`);
      try {
        const resp = await page.goto(candidate, {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });
        if (!resp || resp.status() >= 400) {
          profileErrors.push(`${candidate}: HTTP ${resp && resp.status()}`);
          continue;
        }

        await page.waitForTimeout(1800);
        const blocked = await page.evaluate(() => {
          const t = document.body?.innerText || "";
          return /datadome|captcha|access denied|bitte aktivieren sie javascript/i.test(t);
        });
        if (blocked) {
          profileErrors.push(`${candidate}: bot protection`);
          continue;
        }

        await page.waitForSelector('a[href*="/expose/"]', { timeout: 15000 }).catch(() => {});
        const exposeCount = await page.locator('a[href*="/expose/"]').count().catch(() => 0);
        if (!exposeCount) {
          profileErrors.push(`${candidate}: no expose links`);
          continue;
        }

        loadedProfile = candidate;
        break;
      } catch (err) {
        profileErrors.push(`${candidate}: ${err.message || err}`);
      }
    }

    if (!loadedProfile) {
      console.warn(`Immowelt profile unavailable: ${profileErrors.join(" | ")}`);
      const fallback = await scrapeEichmannFromImmoweltSearch(page);
      fallback.confirmed_inactive_ids = await reconcileMissingImmoweltOffers(
        fallback.listings,
        previousData,
        async (id) => {
          const result = await probeCurrentImmoweltOffer(page, id);
          console.log(`Missing-offer check ${id.slice(0, 8)}: ${result.state} · ${result.reason}`);
          return result;
        }
      );
      return fallback;
    }

    const extractCurrentPage = async () => page.evaluate(() => {
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

        const referenceM = text.match(/Referenz(?:nummer|nr\.?)[\s:#-]*([A-Z0-9][A-Z0-9._/-]{0,31})/i);
        const titleReferenceM = title.match(/\b([AB]\d{1,3})\b/i);
        const reference_number = (referenceM?.[1] || titleReferenceM?.[1] || "").toUpperCase() || null;

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
          reference_number,
          short_description: shortBits.join("; ") || null,
          expose_url: `https://www.immowelt.de/expose/${id}`,
          main_image_url: img,
          raw_card_text: text,
        });
      }
      return out;
    });

    const expectedCount = await page.evaluate(() => {
      const t = document.body?.innerText || "";
      const m = t.match(/Immobilien\s+zum\s+Verkauf\s*\((\d+)\)/i);
      return m ? Number(m[1]) : null;
    });
    if (!Number.isInteger(expectedCount) || expectedCount <= 0) {
      throw new Error("Immowelt profile count unavailable – refusing to replace last-known-good");
    }

    const byId = new Map();
    const collectCurrentPage = async () => {
      for (const item of await extractCurrentPage()) {
        if (item?.id) byId.set(item.id, item);
      }
    };

    const settleAndCollect = async () => {
      await page.waitForTimeout(700);
      for (let i = 0; i < 3; i++) {
        await page.mouse.wheel(0, 900);
        await page.waitForTimeout(180);
      }
      await collectCurrentPage();
    };

    await settleAndCollect();

    // Immowelt profile currently paginates offers. Traverse visible page-number
    // controls and dedupe by canonical expose UUID.
    for (let pageNumber = 2; pageNumber <= 20; pageNumber++) {
      if (expectedCount && byId.size >= expectedCount) break;
      const control = page
        .locator("main button, main a")
        .filter({ hasText: new RegExp(`^\\s*${pageNumber}\\s*$`) })
        .first();
      if (!(await control.count().catch(() => 0))) break;
      if (!(await control.isVisible().catch(() => false))) break;

      const before = page.url();
      await control.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(500);
      if (page.url() === before) {
        await page.waitForTimeout(500);
      }
      await settleAndCollect();
    }

    const raw = [...byId.values()];
    if (!raw.length) {
      throw new Error("No expose links found on profile page");
    }
    if (raw.length !== expectedCount) {
      throw new Error(`Profile count mismatch: expected ${expectedCount}, scraped ${raw.length}`);
    }

    const confirmed_inactive_ids = await reconcileMissingImmoweltOffers(
      raw,
      previousData,
      async (id) => {
        const result = await probeCurrentImmoweltOffer(page, id);
        console.log(`Missing-offer check ${id.slice(0, 8)}: ${result.state} · ${result.reason}`);
        return result;
      }
    );
    console.log(`Scraped ${raw.length} listings from profile (${loadedProfile}); confirmed inactive ${confirmed_inactive_ids.length}.`);
    return {
      source: loadedProfile,
      discovery: "immowelt_profile",
      scraped_at: new Date().toISOString(),
      listings: raw,
      confirmed_inactive_ids,
    };
  } finally {
    await browser.close();
  }
}


/**
 * Publish path used by SQLite SoT: write listings.json export + render HTML/partials/sitemap.
 * Does not scrape Immowelt. Safe to call with a document that includes origin=eigen rows.
 */
export async function publishListingsDocument(doc, { siteRoot = ROOT, knownSlugs = null } = {}) {
  if (siteRoot && siteRoot !== ROOT) {
    console.warn(`publishListingsDocument: siteRoot=${siteRoot} (module ROOT=${ROOT}). Prefer EICHMANN_SITE_ROOT before import.`);
  }
  const data = {
    source: doc.source || PROFILE_URL,
    immowelt_profile: doc.immowelt_profile || doc.source || PROFILE_URL,
    scraped_at: doc.scraped_at || doc.exported_at || new Date().toISOString(),
    listings: Array.isArray(doc.listings) ? doc.listings.map((L) => ({ ...L })) : [],
  };
  data.listings.forEach((L, i) => {
    if (!L.origin) {
      const src = String(L.source || "").toLowerCase();
      L.origin = src === "eigen" || src === "local" ? "eigen" : "immowelt";
    }
    const hasMedia =
      L.image_base ||
      L.main_image_url ||
      (Array.isArray(L.images) && L.images.length) ||
      (Array.isArray(L.gallery_bases) && L.gallery_bases.length);
    if (L.detail_page === false && !hasMedia) {
      L.image_base = null;
    } else if (L.origin === "eigen" || L.origin === "local") {
      // Eigen: only keep explicit local gallery bases (media/eigen/…); never invent Immowelt stems
      if (!L.image_base && Array.isArray(L.gallery_bases) && L.gallery_bases.length) {
        L.image_base = L.gallery_bases[0];
      }
      if (!hasMedia) L.image_base = null;
    } else if (!(L.detail_page === false && !hasMedia)) {
      L.image_base = L.image_base || imageBase(i, L.id);
    }
    L.slug = makeSlug(L);
    L.local_url = localExposePath(L);
  });
  data.listing_count = data.listings.length;

  // Export artifact (not SoT)
  process.env.EICHMANN_SOT = "sqlite";
  await writeCanonical(data);
  await renderIntoPages(data);
  await cleanupOrphanImages(data);
  if (knownSlugs) {
    console.log(`Known slugs from DB: ${knownSlugs.length}`);
  }
  return data;
}

async function persistImmoweltToSqlite(immoweltListings, meta = {}) {
  const { openDb, upsertImmoweltBatch, exportListingsDocument, setMeta, countByOrigin, ORIGIN_EIGEN } = await import("./lib/db.mjs");
  const db = openDb();
  // Hard rule: Immowelt Sync never writes/deletes/hides origin=eigen
  const onlyImmowelt = (immoweltListings || []).filter((L) => {
    const o = String(L?.origin || L?.source || "immowelt").toLowerCase();
    return o !== "eigen" && o !== "local" && o !== ORIGIN_EIGEN;
  });
  if (onlyImmowelt.length !== (immoweltListings || []).length) {
    console.warn(
      `persistImmoweltToSqlite: stripped ${(immoweltListings || []).length - onlyImmowelt.length} non-Immowelt row(s) before upsert`
    );
  }
  const keepIds = onlyImmowelt
    .filter((L) => L.active !== false && L.missing_on_immowelt !== true)
    .map((L) => L.immowelt_id || L.id);
  const results = upsertImmoweltBatch(db, onlyImmowelt, {
    deactivateMissing: true,
    keepImmoweltIds: keepIds,
  });
  if (meta.scraped_at) setMeta(db, "immowelt_scraped_at", meta.scraped_at);
  if (meta.source || meta.immowelt_profile) {
    setMeta(db, "immowelt_profile", meta.immowelt_profile || meta.source);
  }
  const counts = countByOrigin(db);
  const doc = exportListingsDocument(db, {
    profileUrl: meta.immowelt_profile || meta.source,
    scrapedAt: meta.scraped_at,
  });
  db.close();
  console.log(
    `SQLite Immowelt upsert: ${results.length} ops; counts immowelt=${counts.immowelt} eigen=${counts.eigen}`
  );
  return doc;
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
    // Prefer SQLite SoT when present; fall back to listings.json mirror.
    try {
      const { openDb, exportListingsDocument, allSlugs } = await import("./lib/db.mjs");
      const db = openDb();
      const doc = exportListingsDocument(db);
      const slugs = allSlugs(db);
      db.close();
      if (doc.listings?.length) {
        await publishListingsDocument(doc, { knownSlugs: slugs });
        console.log("Render-only done (SQLite SoT → JSON export + HTML).");
        return;
      }
    } catch (e) {
      console.warn("SQLite render-only unavailable, falling back to JSON:", e.message || e);
    }
    if (!previous) {
      console.error("No data/listings.json – cannot --render-only");
      process.exit(1);
    }
    data = previous;
    process.env.EICHMANN_SOT = process.env.EICHMANN_SOT || "sqlite";
    await writeCanonical(data);
    await renderIntoPages(data);
    await cleanupOrphanImages(data);
    console.log("Render-only done (JSON mirror → HTML/grids/sitemap + orphan cleanup).");
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
    const creds = readImmoweltCredentials();
    const useOfficial = Boolean(creds?.api_key);
    // When an API key is present, NEVER scrape (DataDome). Official SOAP only.
    // Without a key: fail closed with awaiting_api_key unless --force-scrape (emergency).
    if (!useOfficial && !forceScrape) {
      const reason =
        "Immowelt-Zugang fehlt. Bitte Kundennummer und API-Schlüssel im Admin unter Immowelt eintragen. Der letzte bekannte Stand bleibt online.";
      console.error(reason);
      await writeSyncStatus({
        state: "awaiting_api_key",
        mode: "official_api",
        previous,
        reason,
      });
      process.exit(1);
    }

    try {
      let scraped;
      let syncMode;
      if (useOfficial) {
        console.log("Immowelt sync mode: official_api (SOAP)");
        scraped = await fetchOfficialImmoweltListings(creds.api_key, previous);
        syncMode = "official_api";
      } else {
        console.log("Immowelt sync mode: scrape (--force-scrape, no API key)");
        scraped = await scrapeImmowelt(previous);
        syncMode = "scrape";
      }
      const assessment = validateIncomingSnapshot(scraped.listings, previous);
      console.log(`Immowelt snapshot accepted: ${assessment.count} complete offers (${syncMode}).`);
      data = {
        source: scraped.source,
        scraped_at: scraped.scraped_at,
        listings: mergeListings(scraped.listings, previous, { confirmedInactiveIds: scraped.confirmed_inactive_ids || [] }),
      };
      // Playwright enrich only for scrape path; official API already pulled exposés.
      if (syncMode === "scrape") {
        try {
          data.listings = await enrichListings(data.listings);
        } catch (enrichErr) {
          console.warn("Enrichment pass failed:", enrichErr.message || enrichErr);
        }
      }

      // All-or-nothing: never publish a partially read Immowelt snapshot.
      const incomplete = data.listings.filter((item) =>
        item.active !== false && (
          String(item.description || "").trim().length < 80 ||
          !Array.isArray(item.images) ||
          item.images.length < 2
        )
      );
      if (incomplete.length) {
        throw new Error(
          `Immowelt snapshot incomplete for ${incomplete.map((item) => shortId(item.id)).join(", ")} – keeping last-known-good`
        );
      }

      const safe = validateNoDestructiveOverwrite(data.listings, previous);
      console.log(`Final LKG guard: ${safe.checked} existing records checked; no destructive/inconsistent overwrite.`);
      data._snapshot_assessment = assessment;
      data._sync_mode = syncMode;
    } catch (err) {
      const hard = process.env.IMMOWELT_HARD_FAIL === "1" || forceScrape;
      const syncMode = hasImmoweltApiKey() ? "official_api" : (forceScrape ? "scrape" : "official_api");
      console.error(`Immowelt sync failed (${hard ? "hard-fail" : "fail-closed"}, mode=${syncMode}):`, err.message || err);
      if (previous) {
        console.error("Keeping last good data/listings.json – site unchanged.");
        await writeSyncStatus({
          state: "rejected",
          mode: syncMode,
          previous,
          reason: err.message || err,
        });
        if (hard) throw err;
        process.exit(1);
      }
      console.error("No previous JSON available. Exiting without changes.");
      await writeSyncStatus({
        state: "rejected",
        mode: syncMode,
        previous: null,
        reason: err.message || err,
      });
      if (hard) throw err;
      process.exit(1);
    }
  }

  if (!data.listings.length) {
    const err = new Error("Empty listings – refusing to overwrite last-known-good.");
    await writeSyncStatus({ state: "rejected", previous, reason: err.message });
    throw err;
  }

  data.listings.forEach((L, i) => {
    if (!(L.detail_page === false && !L.main_image_url && !(L.images || []).length)) {
      L.image_base = L.image_base || imageBase(i, L.id);
    } else {
      L.image_base = null;
    }
    L.slug = makeSlug(L);
    L.local_url = localExposePath(L);
  });
  data.listing_count = data.listings.length;
  data._semantic_changed = semanticListingsChanged(previous, data.listings);
  if (!data._semantic_changed && previous?.scraped_at) {
    data.scraped_at = previous.scraped_at;
    console.log("Immowelt check OK; no object-data change. Keeping last canonical data timestamp.");
  }

  if (dryRun) {
    console.log(JSON.stringify({ ...data, listings: data.listings.map(serializeListing) }, null, 2));
    console.log("Dry-run: no files written.");
    return;
  }

  // Immowelt-only SQLite upsert (never touches origin=eigen), then publish full union.
  if (data._semantic_changed !== false) {
    await syncImages(data, { skipDownload: false });
  } else {
    console.log("Validated Immowelt snapshot is semantically unchanged; still refreshing SQLite + publish.");
  }
  const doc = await persistImmoweltToSqlite(data.listings, {
    scraped_at: data.scraped_at,
    source: data.source,
    immowelt_profile: data.immowelt_profile || data.source,
  });
  // Live HTML/JSON publish requires Chris Abnahme in /admin (confirm modal).
  // Sync may update SQLite; public site stays until "Neu publizieren" / Freigabe.
  const { openDb, setMeta } = await import("./lib/db.mjs");
  const dbMeta = openDb();
  try {
    setMeta(
      dbMeta,
      "publish_pending",
      JSON.stringify({
        reason: "immowelt_sync",
        at: new Date().toISOString(),
        listing_count: doc.listing_count,
        active_listing_count: doc.active_listing_count,
        message: "Immowelt-Sync in SQLite übernommen – öffentliche Website wartet auf Freigabe.",
      })
    );
  } finally {
    dbMeta.close();
  }
  if (process.env.EICHMANN_AUTO_PUBLISH === "1") {
    await publishListingsDocument(doc);
    console.log(`AUTO_PUBLISH: ${doc.listing_count} records published to site.`);
  } else {
    console.log(
      `Accepted Immowelt sync into SQLite SoT: ${doc.listing_count} records. Live publish deferred (Abnahme in /admin).`
    );
  }
  await writeSyncStatus({
    state: "current",
    mode: data._sync_mode || (hasImmoweltApiKey() ? "official_api" : "scrape"),
    previous,
    data,
    assessment: data._snapshot_assessment || null,
  });
  delete data._snapshot_assessment;
  delete data._semantic_changed;
  delete data._sync_mode;

  console.log(`Done. ${data.listing_count} Immowelt records validated.`);
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    // Always non-zero: rejected/empty/LKG guards already wrote status; admin-api
    // maps exit_code!==0 → sync.failed:true (never pretend "no changes").
    process.exit(1);
  });
}

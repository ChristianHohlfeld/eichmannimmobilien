#!/usr/bin/env node
/**
 * RENDERER for immobilieneichmann.de: listing cards, exposé pages, topic links, sitemap,
 * AI index, English property pages – from the SQLite database (or, without one, from the
 * data/listings.json export in the working tree).
 *
 *   node scripts/sync-immowelt.mjs --export-only   database → data/listings.json + Objekt-Register
 *   node scripts/sync-immowelt.mjs --render-only   the above + every generated page
 *   node scripts/sync-immowelt.mjs                 hands over to scripts/immowelt-sync.mjs (official API)
 *
 * Fetching Immowelt is NOT done here. The Playwright scraper, the Sparkassen mirror, the manual
 * overrides and the per-offer title/location tables that used to live in this file are gone:
 * offers in API form (immowelt_api === true) are rendered exactly as Immowelt delivers them –
 * no title or text overrides, no sentence removal, no spelling fixes, no address redaction.
 * The older display rules below (paragraph heuristics, redaction, text fixes) only still apply
 * to scraper-era rows until the one-time identity migration has retired them, and to own listings.
 */

import { readFile, writeFile, mkdir, readdir, unlink, access, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeAiDiscoveryArtifacts } from "./lib/ai-discovery.mjs";
import { publishProjects } from "./lib/projects.mjs";
import { publishSunsidePage } from "./lib/sunside-page.mjs";
import { stripProjectStatus } from "./lib/listing-text.mjs";
import { publishEnListings, enPath, hreflangHead } from "./lib/listing-en.mjs";
import { loadSot, sitemapStatic, hreflangPairs, dataAsOfLabel, applyListingLayer, syncListingsLayer } from "./lib/sot.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.EICHMANN_SITE_ROOT
  ? path.resolve(process.env.EICHMANN_SITE_ROOT)
  : path.resolve(__dirname, "..");

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

const STATIC_SITEMAP_PATHS = sitemapStatic(loadSot(ROOT)); // SSOT: data/sot/pages.json
// Sitemap = HTML pages only (llms.txt/agents.txt/JSON are referenced from robots.txt/llms.txt instead).

const args = new Set(process.argv.slice(2));
const renderOnly = args.has("--render-only");
const exportOnly = args.has("--export-only");
/** Release builds read the given database and nothing else (no JSON mirror, no fallbacks). */
const RELEASE_BUILD = process.env.EICHMANN_RELEASE_BUILD === "1";
/** Offer delivered by the official API: Immowelt is the only authority for its content. */
const isApi = (L) => L?.immowelt_api === true;
const isRent = (L) => L?.marketing === "miete" || (!L?.marketing && /miete/i.test(String(L?.status || "")));
const dryRun = args.has("--dry-run");

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

/* Escaped prose → known office numbers become click-to-call links (never other numbers). */
function linkifyContactPhones(html) {
  return String(html || "")
    .replace(/(?<![\d+])(?:\+49|0049|0)\s?170[\s\/-]?522[\s-]?55\s?68(?!\d)/g, (m) => `<a href="tel:+491705225568">${m}</a>`)
    .replace(/(?<![\d+])(?:\+49|0049|0)\s?7531[\s\/-]?9228848(?!\d)/g, (m) => `<a href="tel:+4975319228848">${m}</a>`);
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
  if (isApi(listing)) {
    // Street only when the address mode publishes it; otherwise the district if Immowelt delivered one.
    if (listing.street) addr.streetAddress = listing.street;
    else if (listing.district) addr.streetAddress = listing.district;
    return addr;
  }
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
  if (isApi(listing)) return raw; // Immowelt's headline, unchanged
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

/** "A3 · <Titel>" – aber nicht doppelt, wenn der Immowelt-Titel schon mit der Referenz beginnt. */
function withReference(ref, title) {
  if (!ref) return title;
  const t = String(title || "");
  const r = String(ref);
  if (t.toLowerCase().startsWith(r.toLowerCase()) && !/[0-9a-zäöüß]/i.test(t.charAt(r.length))) return t;
  return r + " · " + t;
}

function renderCard(listing) {
  const badge = badgeFor(listing);
  const base = listing.image_base;
  const ref = listingReference(listing);
  const displayTitle = listingDisplayTitle(listing);
  const accessibleTitle = withReference(ref, displayTitle);
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
            <p class="listing-loc">${escapeHtml((isApi(listing) ? listing.location : publicLocation(listing.location)) || "")}</p>
            <p class="listing-price">${escapeHtml(listing.price || "")}</p>
            <div class="listing-meta">
              ${meta}
            </div>
            <p class="listing-desc">${escapeHtml(isApi(listing) ? listing.short_description || "" : normalizeContactPhoneDisplay(listing.short_description || ""))}</p>
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
  return `        <a class="listing-card" href="${escapeHtml(href)}">
          ${body}
        </a>`;
}

function renderGrid(listings) {
  const pub = listings.filter(isPublicListing);
  // A really empty inventory is a valid state on Immowelt – say so instead of showing an empty box.
  const cards = pub.length
    ? pub.map(renderCard).join("\n\n")
    : `        <p class="listings-empty">Aktuell sind keine Angebote veröffentlicht. Sprechen Sie uns gern direkt an: <a href="tel:+491705225568">+49 170 522 5568</a>.</p>`;
  return `${MARKER_START}\n${cards}\n${MARKER_END}`;
}

/** "11 Kaufobjekte" / "1 Mietobjekt" / "10 Angebote (9 Kauf, 1 Miete)" – counted from the offers themselves. */
function offerCountPhrase(list) {
  const n = list.length;
  const rent = list.filter(isRent).length;
  if (!n) return "Aktuell keine Angebote";
  if (!rent) return `${n} ${n === 1 ? "Kaufobjekt" : "Kaufobjekte"}`;
  if (rent === n) return `${n} ${n === 1 ? "Mietobjekt" : "Mietobjekte"}`;
  return `${n} Angebote (${n - rent} Kauf, ${rent} Miete)`;
}

function countTextIndex(list) {
  return `${COUNT_START}${offerCountPhrase(list)} in und um Konstanz${list.length ? " – Fotos und Eckdaten, Details zum Objekt" : ""}.${COUNT_END}`;
}

function countTextProjekte(list) {
  const n = list.length;
  return `${COUNT_START}${n ? `${n} ${n === 1 ? "Objekt" : "Objekte"} – Details im Exposé` : "Aktuell keine Angebote"}.${COUNT_END}`;
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

/** Resolve gallery stem: Immowelt "01-abcd1234" → assets/listings/…; Eigen "media/eigen/id/01" → as-is. */
function assetRelPath(base) {
  const b = String(base || "").replace(/^\/+/, "").replace(/\\/g, "/");
  if (!b) return null;
  if (b.includes("/")) return b;
  return `assets/listings/${b}`;
}

function pictureTag(base, alt, { prefix = "", loading = "lazy", className = "", fetchPriority = "" } = {}) {
  const rel = assetRelPath(base);
  if (!rel) return "";
  const cls = className ? ` class="${className}"` : "";
  const fp = fetchPriority ? ` fetchpriority="${fetchPriority}"` : "";
  return `<picture>
              <source srcset="${prefix}${escapeHtml(rel)}.webp" type="image/webp">
              <img src="${prefix}${escapeHtml(rel)}.jpg" alt="${escapeHtml(alt)}" loading="${loading}"${fp} width="800" height="600" decoding="async"${cls}>
            </picture>`;
}

function listingDistrict(listing) {
  if (isApi(listing)) return String(listing.district || listing.city || "").trim(); // structured API fields, nothing parsed from display text
  return String(listing?.location || "").split(",")[0].replace(/\s*\(\d{5}\)\s*$/, "").trim();
}
/** Commission as stated in the offer data (API: any fact whose label names Provision/Courtage). */
function commissionFact(listing) {
  if (isApi(listing)) {
    const row = (listing.fact_rows || []).find((r) => /provision|courtage/i.test(String(r.label || "")));
    return row ? String(row.value || "").trim() : "";
  }
  return String(listing?.facts?.["Käuferprovision"] || "").trim();
}
function isProvisionsfrei(listing) {
  return /provisionsfrei/i.test(commissionFact(listing)) || /provisionsfrei/i.test(String(listing?.title || ""));
}
/** Meta description aus strukturierten Feldern (statt abgeschnittenem Exposé-Rohtext). */
function exposeMetaDescription(listing) {
  const ref = listingReference(listing);
  const kind = String(listing?.type || "Immobilie").trim();
  const district = listingDistrict(listing);
  const where = district && !/^konstanz$/i.test(district) ? `Konstanz-${district}` : "Konstanz";
  const facts = [listing?.rooms, listing?.living_area].filter(Boolean).join(", ");
  const price = listing?.price ? String(listing.price).trim() : "";
  let out = `${kind}${ref ? " " + ref : ""} in ${where}${facts ? ": " + facts : ""}${price ? ", " + price : ""}${isProvisionsfrei(listing) ? ", provisionsfrei" : ""}.`;
  out += " Exposé und Besichtigung: +49 170 522 5568 – Immobilien Eichmann.";
  if (out.length > 160) out = out.replace(" – Immobilien Eichmann.", ".");
  if (out.length > 160) out = out.replace(" Exposé und Besichtigung: +49 170 522 5568.", "");
  // Content comes from Immowelt and can be any length: a long value must never fail the build.
  return out.length > 160 ? softShorten(out, 160) : out;
}

/** Listings im selben Neubau (gleicher Lagetext) – für „Weitere Wohnungen in diesem Neubau“. */
function siblingKey(listing) {
  const loc = String(listing?.location_description || "").replace(/\s+/g, " ").trim();
  return loc.length >= 80 ? loc.slice(0, 160) : "";
}
let __siblingIndex = null;
let __publicListings = [];
/** Claude R4 #13: drei weitere Objekte nach Preisnähe (für Objekte ohne Geschwister im selben Neubau). */
function nearbyByPrice(listing, n = 3) {
  const eur = (L) => Number(String(L.price_eur ?? L.price ?? "").replace(/[^\d]/g, "")) || null;
  const me = eur(listing);
  if (!me) return [];
  return __publicListings
    .filter((L) => L.slug !== listing.slug && eur(L))
    .sort((a, b) => Math.abs(eur(a) - me) - Math.abs(eur(b) - me))
    .slice(0, n);
}
function setSiblingIndex(listings) {
  __siblingIndex = new Map();
  __publicListings = (listings || []).filter((L) => hasPublicDetail(L));
  for (const L of listings || []) {
    if (!hasPublicDetail(L)) continue;
    const k = siblingKey(L);
    if (!k) continue;
    if (!__siblingIndex.has(k)) __siblingIndex.set(k, []);
    __siblingIndex.get(k).push(L);
  }
}
function siblingListings(listing) {
  const k = siblingKey(listing);
  if (!k || !__siblingIndex) return [];
  return (__siblingIndex.get(k) || []).filter((L) => L.slug !== listing.slug);
}

/** "dd.mm.yyyy" of the real data state: verified_at (mirror check) or scraped_at (last change). */
/** Hero-Zeile der Objektseite: nur vorhandene Felder, Trenner nur zwischen Werten, € nie allein umbrechen. */
function nbspEuro(v) {
  return escapeHtml(String(v || "").trim()).replace(/\s+€/g, "&nbsp;€");
}
function heroFactsHtml(listing) {
  const parts = [];
  if (String(listing.reference_number || "").trim()) parts.push(`<strong>${escapeHtml(String(listing.reference_number).trim())}</strong>`);
  const loc = String(listing.location || "").trim() || "Konstanz";
  parts.push(escapeHtml(loc));
  if (String(listing.price || "").trim()) parts.push(`<strong class="nowrap">${nbspEuro(listing.price)}</strong>`);
  return parts.join(" · ");
}
/** Datenstand + Käuferprovision – letztere nur so, wie sie in den Objektdaten steht. */
function heroMetaHtml(listing) {
  const parts = [`<span class="nowrap">Stand: ${escapeHtml(dataAsOfLabel(loadSot(ROOT), "de"))}</span>`];
  if (isRent(listing)) return parts.join(" · "); // Mietangebot: keine Käuferprovision
  const prov = commissionFact(listing);
  parts.push(`<span class="nowrap">Käuferprovision: ${escapeHtml(prov || "auf Anfrage")}</span>`); // Claude R4 #4: nie leer, keine erfundene Quote
  return parts.join(" · ");
}

/* Datenstand = Tag des letzten vollständigen, validierten Immowelt-Abgleichs (scripts/immowelt-sync.mjs).
   Schlägt der Abgleich fehl, bleibt das Datum stehen – die Seite behauptet nie einen frischeren Stand, als sie hat. */
let STAND_NOTE = " (mit den öffentlichen Exposés abgeglichen)";
/** With the API sync the date is the last complete, validated read of the Immowelt account. */
function setStandNote(data) {
  if (data?.immowelt_checked_date) STAND_NOTE = " (automatisch mit Immowelt abgeglichen)";
}
function dataStandLabel(data) {
  // SSOT: ältestes Prüfdatum der aktiven Objekte (data/sot/listings.json)
  return dataAsOfLabel(loadSot(ROOT), "de");
}

/* Themen-/Stadtteilseiten verlinken passende Objektseiten (Marker-Block, beim Render erneuert). */
/** Where an offer is: location fields first; the location text only when the API gave no district. */
function placeHaystack(L) {
  return [L.location, L.district, L.title, isApi(L) && !L.district ? L.location_description : ""].map((v) => String(v || "")).join(" ");
}
const TOPIC_OBJEKT_PAGES = [
  {
    file: "wollmatingen.html",
    heading: "Aktuelle Kaufangebote in Wollmatingen",
    filter: (L) => /wollmatingen/i.test(placeHaystack(L)),
  },
  {
    file: "petershausen.html",
    heading: "Aktuelle Kaufangebote in Petershausen",
    filter: (L) => /petershausen/i.test(placeHaystack(L)),
  },
  {
    file: "mehrfamilienhaus-konstanz.html",
    heading: "Aktuelle Mehrfamilienhäuser in Konstanz",
    filter: (L) => /mehrfamilien|dreifamilien/i.test(String(L.type || "") + " " + String(L.title || "")),
  },
  {
    file: "wohnung-kaufen-konstanz.html",
    heading: "Aktuelle Wohnungen zum Kauf in Konstanz",
    filter: (L) => /wohnung|penthouse|maisonette/i.test(String(L.type || "") + " " + String(L.title || "")),
  },
];
const TOPIC_START = "<!-- OBJEKT-LINKS:START -->";
const TOPIC_END = "<!-- OBJEKT-LINKS:END -->";
async function renderTopicObjektLinks(data) {
  // All four blocks are headed "Kaufangebote"/"zum Kauf": rentals never appear in them.
  const pub = (data.listings || []).filter(hasPublicDetail).filter((L) => !isRent(L));
  const stand = dataStandLabel(data);
  for (const t of TOPIC_OBJEKT_PAGES) {
    const fp = path.join(ROOT, t.file);
    let html;
    try { html = await readFile(fp, "utf8"); } catch { continue; }
    const rows = pub.filter(t.filter);
    const block = rows.length
      ? `${TOPIC_START}
    <section class="section" id="objekte">
      <div class="container">
        <div class="section-head">
          <div>
            <h2>${escapeHtml(t.heading)}</h2>
            <p>${rows.length} ${rows.length === 1 ? "Objekt" : "Objekte"} · Stand der Angebote: ${stand}${STAND_NOTE}. <a href="/#angebote">Alle Angebote</a></p>
          </div>
        </div>
        <div class="listings-grid">
${rows.map(renderCard).join("\n")}
        </div>
      </div>
    </section>
    ${TOPIC_END}`
      : `${TOPIC_START}${TOPIC_END}`;
    if (html.includes(TOPIC_START)) {
      html = html.replace(new RegExp(escapeRegExp(TOPIC_START) + "[\\s\\S]*?" + escapeRegExp(TOPIC_END)), block);
    } else {
      // after the first content section following the page hero
      const heroEnd = html.indexOf("</section>", html.indexOf('<section class="page-hero"'));
      const nextEnd = html.indexOf("</section>", heroEnd + 10);
      if (heroEnd < 0 || nextEnd < 0) continue;
      const at = nextEnd + "</section>".length;
      html = html.slice(0, at) + "\n\n    " + block + html.slice(at);
    }
    if (!dryRun) await writeFile(fp, html, "utf8");
    console.log(`Updated ${t.file} (${rows.length} objekt links)`);
  }
}

/** Claude R4 #18: „A2: 2-Zimmer-Wohnung Konstanz-Wollmatingen | Eichmann“ – Typwort aus dem Immowelt-Titel. */
function shortPageTitle(listing, ref) {
  const src = String(listing.title || "") + " " + String(listing.type || "");
  const typ = /dreifamil/i.test(src) ? "Dreifamilienhaus" : /maisonette/i.test(src) ? "Maisonette" : /penthouse/i.test(String(listing.title || "")) ? "Penthouse" : /haus/i.test(String(listing.type || "")) ? "Haus" : "Wohnung";
  const rooms = String(listing.rooms || "").match(/[\d,]+/)?.[0];
  const district = isApi(listing) ? listingDistrict(listing) : (String(listing.location || "").split(",")[0] || "").trim();
  const city = isApi(listing) ? String(listing.city || "Konstanz") : "Konstanz";
  const place = district && district !== city ? `${city}-${district}` : city;
  const core = typ === "Dreifamilienhaus" || !rooms ? typ : `${rooms}-Zimmer-${typ}`;
  let t = `${ref ? ref + ": " : ""}${core} ${place} | Eichmann`;
  if (t.length > 60) t = `${ref ? ref + ": " : ""}${core} ${place}`;
  if (t.length > 60) t = `${ref ? ref + ": " : ""}${core} Konstanz`;
  if (t.length > 60) t = `${core} Konstanz`; // very long reference numbers from Immowelt
  return t.length > 60 ? softShorten(t, 60) : t;
}

/** schema.org Offer: purchase price, monthly rent, or no price at all when Immowelt says "auf Anfrage". */
function offerSchema(listing) {
  if (isApi(listing)) {
    if (listing.price_on_request || !(listing.price_eur > 0)) return undefined;
    const price = String(listing.price_eur);
    if (isRent(listing)) {
      return {
        "@type": "Offer",
        priceCurrency: "EUR",
        price,
        businessFunction: "http://purl.org/goodrelations/v1#LeaseOut",
        priceSpecification: { "@type": "UnitPriceSpecification", price, priceCurrency: "EUR", unitCode: "MON", name: listing.price_label || "Miete" },
      };
    }
    return { "@type": "Offer", priceCurrency: "EUR", price, businessFunction: "http://purl.org/goodrelations/v1#Sell" };
  }
  return listing.price
    ? {
        "@type": "Offer",
        priceCurrency: "EUR",
        price: String(listing.price).replace(/[^\d]/g, "") || undefined,
      }
    : undefined;
}

function renderExposeHtml(listing, ogShare = null) {
  const p = "../";
  const badge = badgeFor(listing);
  const ref = listingReference(listing);
  const title = listingDisplayTitle(listing);
  const fullTitle = withReference(ref, title);
  const pageTitle = shortPageTitle(listing, ref); // Claude R4 #18: ≤ 60 Zeichen
  const metaDesc = exposeMetaDescription(listing);

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

  if (isApi(listing)) {
    // Immowelt's own rows, in Immowelt's order and wording (label → value); nothing hidden, nothing relabelled.
    factRows.length = 0;
    for (const r of listing.fact_rows || []) factRows.push([r.label, r.value]);
  } else if (listing.facts && typeof listing.facts === "object") {
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
    const isKauf = /kauf/i.test(String(listing.status || "")) || Boolean(listing.price);
    for (const [k, v] of Object.entries(listing.facts)) {
      if (!v || represented.has(k)) continue;
      // Mietfelder auf Kaufobjekten bzw. Mietfelder ohne Betrag (Immowelt liefert dort teils Labels) nicht anzeigen
      if (/miete|nebenkosten|kaution/i.test(k) && (isKauf || !/\d/.test(String(v)))) continue;
      factRows.push([labelMap[k] || k, String(v)]);
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
              ${pictureTag(b, alt, { prefix: p, loading: i === 0 ? "eager" : "lazy", fetchPriority: i === 0 ? "high" : "" })}
            </figure>`;
          })
          .join("\n          ")
      : `<figure class="expose-gallery-item"><div class="expose-gallery-placeholder">Kein Foto verfügbar</div></figure>`;

  const thumbsHtml =
    galleryBases.length > 1
      ? `<div class="expose-thumbs">
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

  // Dokumente, die dem Inserat auf Immowelt beigefügt sind (unverändert übernommen)
  const docs = (listing.documents || []).filter((d) => d.file);
  const mb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const docsHtml = docs.length
    ? `<section class="expose-section" id="dokumente">
        <h2>Dokumente</h2>
        <ul class="check-list">
          ${docs.map((d, i) => `<li><a href="${p}${escapeHtml(d.file)}" target="_blank" rel="noopener">Dokument ${i + 1} (${d.kind === "pdf" ? "PDF" : "Bild"}${d.bytes ? `, ${mb(d.bytes)}` : ""})</a></li>`).join("\n          ")}
        </ul>
      </section>`
    : "";

  // Zitierter Exposé-Wortlaut (Importer): eingefasst, damit check-output ihn nicht als eigenen Text wertet.
  const proseHtml = (value) => {
    const inner = stripProjectStatus(value)
      .split(/\n{2,}/)
      .map((para) => para.trim())
      .filter(Boolean)
      .map((para) => `<p>${linkifyContactPhones(escapeHtml(normalizeContactPhoneDisplay(para))).replace(/\n/g, "<br>")}</p>`)
      .join("\n          ");
    const linked = inner.replace("Die Grundrisse finden Sie in der Bildergalerie.", 'Die Grundrisse finden Sie in der <a href="#expose-gallery">Bildergalerie</a>.');
    return linked ? `<!-- SOURCE-TEXT:START -->${linked}<!-- SOURCE-TEXT:END -->` : "";
  };

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

  // API form: every text block Immowelt delivered, under Immowelt's own heading, markup rebuilt from an allowlist.
  const apiSections = isApi(listing)
    ? (listing.sections || [])
        .filter((sec) => sec.html)
        .map(
          (sec) => `<section class="expose-section" data-section="${escapeHtml(sec.id || "")}">
            <h2>${escapeHtml(sec.title)}</h2>
            <div class="expose-description prose"><!-- SOURCE-TEXT:START -->${sec.html}<!-- SOURCE-TEXT:END --></div>
          </section>`
        )
        .join("\n          ")
    : null;

  const siblings = siblingListings(listing);
  const siblingsSection = siblings.length
    ? `<section class="expose-section expose-siblings" id="weitere-wohnungen">
            <h2>Weitere Wohnungen in diesem Neubau</h2>
            <ul class="expose-sibling-list">
              ${siblings
                .map((L) => {
                  const r = listingReference(L);
                  const t = listingDisplayTitle(L);
                  const bits = [L.living_area, L.price].filter(Boolean).join(" · ");
                  return `<li><a href="${p}${escapeHtml(L.local_url)}">${escapeHtml(withReference(r, t))}</a>${bits ? ` <span>${escapeHtml(bits)}</span>` : ""}</li>`;
                })
                .join("\n              ")}
            </ul>
          </section>`
    : (() => {
        const near = nearbyByPrice(listing);
        if (!near.length) return "";
        return `<section class="expose-section expose-siblings" id="weitere-angebote">
            <h2>Weitere Angebote</h2>
            <ul class="expose-sibling-list">
              ${near
                .map((L) => {
                  const r = listingReference(L);
                  const t = listingDisplayTitle(L);
                  const bits = [L.living_area, L.price].filter(Boolean).join(" · ");
                  return `<li><a href="${p}${escapeHtml(L.local_url)}">${escapeHtml(withReference(r, t))}</a>${bits ? ` <span>${escapeHtml(bits)}</span>` : ""}</li>`;
                })
                .join("\n              ")}
            </ul>
          </section>`;
      })();
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
    offers: offerSchema(listing),
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
        item: SITE_ORIGIN + "/#angebote",
      },
      {
        "@type": "ListItem",
        position: 3,
        name: title,
        item: canonical,
      },
    ],
  };

  /* WhatsApp an Helmut, vorbefüllt mit dem Objekt (Titel + Link) */
  const waHelmutHref = `https://wa.me/491705225568?text=${encodeURIComponent(`Guten Tag Herr Eichmann, ich interessiere mich für das Objekt „${title}“: ${canonical}`)}`;

  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(pageTitle)}</title>
  <meta name="description" content="${escapeHtml(metaDesc)}">
  <meta name="robots" content="index,follow">
  <link rel="canonical" href="${escapeHtml(canonical)}">
${hreflangHead(canonical, `${SITE_ORIGIN}${enPath(listing.slug)}`)}
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
<link rel="stylesheet" href="${p}css/styles.css?v=claude-final">
  <script type="application/ld+json">
${JSON.stringify(schema, null, 2).replace(/</g, "\\u003c").replace(/&/g, "\\u0026")}
  </script>
  <script type="application/ld+json">
${JSON.stringify(breadcrumbSchema, null, 2).replace(/</g, "\\u003c").replace(/&/g, "\\u0026")}
  </script>
</head>
<body>
  <header class="site-header">
    <div class="container header-inner">
      <a class="logo" href="/" aria-label="Immobilien Eichmann – Startseite">
        <img class="logo-svg" src="${p}assets/logo-header.svg?v=header-safe-v1" alt="Immobilien Eichmann" width="320" height="56" decoding="async">
        <span class="logo-text">
          <span class="logo-mark">Immobilien Eichmann</span>
          <span class="logo-sub">Verkauf · Vermittlung · Projektentwicklung</span>
        </span>
      </a>
      <button class="menu-toggle" type="button" aria-label="Menü öffnen" aria-expanded="false">☰</button>
      <nav class="nav" aria-label="Hauptnavigation">
        <a href="/">Start</a>
        <a href="/#angebote">Angebote</a>
        <a href="${p}haus-verkaufen-konstanz.html">Verkauf</a>
        <a href="${p}leistungen.html">Leistungen</a>
        <a href="${p}immobilienbewertung-konstanz.html">Bewertung</a>
        <a href="${p}projekte.html">Projekte</a>
        <a href="${p}kontakt.html">Kontakt</a>
        <a href="tel:+491705225568" class="nav-cta btn-call" data-location="header_number">Anrufen<span class="nav-cta-num"> 0170 522 5568</span></a>
      </nav>
    </div>
  </header>

  <main data-listing-id="${escapeHtml(listing.id)}"${isApi(listing) ? ` data-online-id="${escapeHtml(listing.immowelt_online_id)}" data-content-hash="${escapeHtml(listing.content_hash || "")}" data-marketing="${escapeHtml(listing.marketing)}"` : ""}>
    <section class="page-hero expose-hero">
      <div class="container">
        <p class="eyebrow"><a href="/#angebote">← Alle Angebote</a></p>
        <h1 class="expose-title">${ref ? `<span class="expose-reference">${escapeHtml(ref)}</span><span class="sr-only"> · </span>` : ""}<span>${escapeHtml(title)}</span></h1>
        <p class="expose-hero-facts">${heroFactsHtml(listing)}</p>
        <p class="expose-hero-meta">${heroMetaHtml(listing)}</p>
        <p class="expose-hero-actions"><a class="btn btn-accent expose-jump" href="#anfragen" data-location="expose_jump">Exposé anfragen</a> <a class="btn btn-outline btn-call" href="tel:+491705225568" data-location="hero_number">Jetzt anrufen <span class="nowrap">0170 522 5568</span></a></p>
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

          ${apiSections ?? [descriptionSection, locationSection, amenitiesSection, additionalSection].join("\n          ")}

          ${floorHtml}
          ${docsHtml}
          ${siblingsSection}
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
                <label for="name">Name *</label>
                <input type="text" id="name" name="name" required autocomplete="name" placeholder="Ihr Name">
              </div>
              <div class="form-group">
                <label for="phone">Telefon *</label>
                <input type="tel" id="phone" name="phone" required autocomplete="tel" inputmode="tel" placeholder="Für den Rückruf">
              </div>
              <details class="form-more">
                <summary>Mehr Angaben (optional)</summary>
                <div class="form-group">
                  <label for="email">E-Mail-Adresse</label>
                  <input type="email" id="email" name="email" autocomplete="email" placeholder="Für das Exposé per E-Mail">
                </div>
                <div class="form-group">
                  <label for="anrede">Anrede</label>
                  <select id="anrede" name="anrede" autocomplete="honorific-prefix">
                    <option value="">Bitte wählen</option>
                    <option value="Herr">Herr</option>
                    <option value="Frau">Frau</option>
                    <option value="Familie">Familie</option>
                  </select>
                </div>
                <div class="form-group">
                  <label for="vorname">Vorname</label>
                  <input type="text" id="vorname" name="vorname" autocomplete="given-name">
                </div>
                <div class="form-group">
                  <label for="strasse">Straße und Hausnummer</label>
                  <input type="text" id="strasse" name="strasse" autocomplete="street-address">
                </div>
                <div class="form-row expose-address-row">
                  <div class="form-group">
                    <label for="plz">PLZ</label>
                    <input type="text" id="plz" name="plz" autocomplete="postal-code" inputmode="numeric">
                  </div>
                  <div class="form-group">
                    <label for="ort">Ort</label>
                    <input type="text" id="ort" name="ort" autocomplete="address-level2">
                  </div>
                </div>
              </details>
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
              <a class="btn btn-outline btn-sm expose-wa" href="${escapeHtml(waHelmutHref)}" target="_blank" rel="noopener noreferrer">WhatsApp zu diesem Objekt</a>
            </div>
            <p class="expose-textlinks"><a href="${escapeHtml(listing.expose_url)}" target="_blank" rel="noopener noreferrer">Exposé auf Immowelt ansehen</a></p>
            <p class="expose-disclaimer">Angaben ohne Gewähr. Maßgeblich sind die aktuellen Unterlagen und das Immowelt-Exposé.</p>
            <p class="immowelt-attribution"><a href="https://www.immowelt.de/" target="_blank" rel="noopener noreferrer">Immobilien-Daten bereitgestellt von immowelt.de</a></p>
          </div>
          <div class="content-card helmut-card" id="ansprechpartner">
            <h2>Ihr Ansprechpartner</h2>
            <p class="helmut-name"><strong>Helmut Eichmann</strong><br>Immobilien Eichmann, Konstanz</p>
            <ul class="helmut-contact">
              <li>Mobil &amp; WhatsApp: <a href="tel:+491705225568">+49 170 522 5568</a></li>
              <li>Festnetz: <a href="tel:+4975319228848">+49 7531 9228848</a></li>
              <li>E-Mail: <a href="mailto:info@immobilien-eichmann.com">info@immobilien-eichmann.com</a></li>
              <li>Termine nach Vereinbarung</li>
            </ul>
          </div>
          <a class="content-card allmannsdorf-teaser" href="${p}allmannsdorf.html">
            <span class="eyebrow">Neubau · Provisionsfrei</span>
            <strong>Neubau Allmannsdorf – jetzt provisionsfrei vormerken</strong>
            <span class="allmannsdorf-teaser-link">Zum Projekt →</span>
          </a>
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
          <h2 class="footer-heading">Immobilien Konstanz</h2>
          <a href="${p}immobilienmakler-konstanz.html">Immobilienmakler Konstanz</a>
          <a href="${p}wohnung-kaufen-konstanz.html">Wohnung kaufen Konstanz</a>
          <a href="${p}haus-verkaufen-konstanz.html">Haus verkaufen Konstanz</a>
          <a href="${p}wohnung-verkaufen-konstanz.html">Wohnung verkaufen Konstanz</a>
          <a href="${p}immobilienbewertung-konstanz.html">Immobilienbewertung Konstanz</a>
          <a href="/#angebote">Aktuelle Kaufangebote</a>
        </div>
        <div class="footer-col">
          <h2 class="footer-heading">Stadtteile &amp; Region</h2>
          <a href="${p}wollmatingen.html">Immobilien Wollmatingen</a>
          <a href="${p}petershausen.html">Immobilien Petershausen</a>
          <a href="${p}allmannsdorf.html">Neubau Allmannsdorf</a>
          <a href="${p}projekte.html">Projekte &amp; Angebote</a>
          <a href="https://www.immowelt.de/profil/3b18336c6a2e401da38e9cc20268270d" target="_blank" rel="noopener noreferrer">Immowelt-Profil</a>
        </div>
        <div class="footer-col">
          <h2 class="footer-heading">Service</h2>
          <a href="${p}leistungen.html">Leistungen</a>
          <a href="${p}kontakt.html">Kontakt &amp; Termin</a>
          <a href="${p}ratgeber.html">Ratgeber</a>
          <a href="${p}impressum.html">Impressum</a>
          <a href="${p}datenschutz.html">Datenschutz</a>
          <a href="${p}widerrufsbelehrung.html">Widerrufsbelehrung</a>
          <a href="${p}vertrag-widerrufen.html">Widerrufsformular</a>
        </div>
      </div>
      <div class="footer-widerruf">
        <a class="btn btn-footer-widerruf" href="${p}vertrag-widerrufen.html">Widerrufsformular</a>
        <p class="footer-widerruf-hint">Maklervertrag in Textform widerrufen</p>
      </div>
      <div class="footer-bottom">
        <span>© <span id="y">2026</span> Immobilien Eichmann · Helmut Eichmann · Einzelunternehmen</span>
        <span>immobilieneichmann.de</span>
      </div>
    </div>
  </footer>

  <nav class="sticky-bar" aria-label="Schnellkontakt">
    <a href="tel:+491705225568" class="sticky-item sticky-accent">
      <span class="sticky-ico" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 1.27 4.27 2 2 0 0 1 3.25 2h3a2 2 0 0 1 2 1.72c.12.86.32 1.7.59 2.5a2 2 0 0 1-.45 2.11L7.09 9.91a16 16 0 0 0 6 6l1.58-1.3a2 2 0 0 1 2.11-.45c.8.27 1.64.47 2.5.59A2 2 0 0 1 22 16.92z"/></svg></span>
      <span>Anrufen</span>
    </a>
    <a href="${escapeHtml(waHelmutHref)}" class="sticky-item sticky-item--wa" target="_blank" rel="noopener noreferrer">
      <span class="sticky-ico sticky-ico--fill" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.435 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg></span>
      <span>WhatsApp</span>
    </a>
  </nav>

  <aside class="floating-wa-region" aria-label="WhatsApp">
  <a class="floating-wa" href="${escapeHtml(waHelmutHref)}" target="_blank" rel="noopener noreferrer" aria-label="WhatsApp: Objekt oder Beratung anfragen" title="WhatsApp: Objekt oder Beratung anfragen">
    <span class="floating-wa__icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="28" height="28"><path fill="currentColor" d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.435 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg></span>
  </a>
  </aside>

  <script>window.__eichmannJsBase="${p}js/";</script>
  <script src="${p}js/cookie-consent.js?v=claude-final" defer></script>
  <script src="${p}js/main.js?v=lead-attr-v1" defer></script>
</body>
</html>
`;
}

async function loadJson(filePath) {
  const raw = JSON.parse(await readFile(filePath, "utf8"));
  const list = Array.isArray(raw) ? raw : raw.listings || [];
  const listings = list
    .map((item, i) => {
      if (isApi(item)) return { ...item }; // already canonical; never re-derived from a whitelist
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
    if (isApi(L)) return;
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
    immowelt_checked_date: raw.immowelt_checked_date || null,
    immowelt_fingerprint: raw.immowelt_fingerprint || null,
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

/** Managed image stems: Immowelt NN-xxxxxxxx(+gallery) or Admin admin-xxxxxxxx-ts */
const MANAGED_IMAGE_STEM_RE =
  /^(?:\d{2}-[a-f0-9]{8}(?:-g\d{2}|-fp\d{2}|-og)?|admin-[a-f0-9]{8}-\d+(?:-og)?)(?:\.[a-z]+)?$/i;

async function cleanupOrphanImages(data) {
  await mkdir(IMAGES_DIR, { recursive: true });
  // A release serves only what is public: pictures of offers that are offline (retired on Immowelt,
  // hidden) are not carried into it – they stay in the archive, not on the website.
  const rows = RELEASE_BUILD ? data.listings.filter((L) => L.active !== false && L.site_hidden !== true) : data.listings;
  const keepFinal = collectKeepImageBases(rows);
  for (const L of rows) {
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
  if (isApi(L)) {
    const copy = {};
    for (const [k, v] of Object.entries(L)) if (!k.startsWith("_")) copy[k] = v;
    return copy;
  }
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

function looksLikeImmoweltId(id) {
  return typeof id === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);
}

async function atomicWriteJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(tmp, filePath);
}

async function writeCanonical(data) {
  await mkdir(path.dirname(DATA_PATH), { recursive: true });
  data.listings = data.listings.map((L) => (isApi(L) ? L : sanitizeListingForPublic(normalizeListingTextFields(L))));
  const out = {
    // Single Source of Truth = Immowelt. This file is a generated local mirror for rendering.
    sot: process.env.EICHMANN_SOT || "sqlite",
    source: data.source || PROFILE_URL,
    immowelt_profile: data.immowelt_profile || PROFILE_URL,
    scraped_at: data.scraped_at,
    ...(data.verified_at ? { verified_at: data.verified_at } : {}),
    ...(data.immowelt_checked_date ? { immowelt_checked_date: data.immowelt_checked_date } : {}),
    ...(data.immowelt_fingerprint ? { immowelt_fingerprint: data.immowelt_fingerprint } : {}),
    listing_count: data.listings.length,
    active_listing_count: data.listings.filter(isPublicListing).length,
    listings: data.listings.map(serializeListing),
  };
  if (!dryRun) await atomicWriteJson(DATA_PATH, out);
  return out;
}

async function renderExposePages(data) {
  setSiblingIndex(data.listings);
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

async function fileLastmodOr(filePath, fallbackDate) {
  return contentLastmod(filePath, fallbackDate);
}

/* Real lastmod: content hash per page (volatile bits like the "Stand" date stripped).
   Unchanged content keeps its previous lastmod; first seen → git commit date of the file
   (if git is available) else now. State: data/sitemap-lastmod.json (committed). */
const LASTMOD_STATE_PATH = path.join(ROOT, "data", "sitemap-lastmod.json");
let __lastmodState = null;
let __lastmodDirty = false;
async function lastmodState() {
  if (__lastmodState) return __lastmodState;
  try { __lastmodState = JSON.parse(await readFile(LASTMOD_STATE_PATH, "utf8")); } catch { __lastmodState = {}; }
  return __lastmodState;
}
async function gitLastCommitIso(rel) {
  try {
    const { execFileSync } = await import("node:child_process");
    const dirty = execFileSync("git", ["status", "--porcelain", "--", rel], { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    if (dirty) return null; // changed in this working tree → now
    const out = execFileSync("git", ["log", "-1", "--format=%cI", "--", rel], { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return out || null;
  } catch { return null; }
}
async function contentLastmod(filePath, fallbackDate) {
  const rel = path.relative(ROOT, filePath).replace(/\\/g, "/");
  let body;
  try { body = await readFile(filePath, "utf8"); } catch { return sitemapLastmod(fallbackDate); }
  const norm = body
    .replace(/Stand(?: der Angebote)?:\s*(?:[A-Za-zäöüÄÖÜß]+\s+\d{4}|\d{2}\.\d{2}\.\d{4})/g, "Stand")
    .replace(/\?v=[\w.-]+/g, "");
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha1").update(norm).digest("hex").slice(0, 16);
  const st = await lastmodState();
  const prev = st[rel];
  if (prev && prev.hash === hash && prev.lastmod) return prev.lastmod;
  const iso = prev ? sitemapLastmod(fallbackDate) : sitemapLastmod(new Date((await gitLastCommitIso(rel)) || fallbackDate));
  st[rel] = { hash, lastmod: iso };
  __lastmodDirty = true;
  return iso;
}
async function saveLastmodState() {
  if (!__lastmodDirty || dryRun) return;
  const st = await lastmodState();
  const sorted = Object.fromEntries(Object.keys(st).sort().map((k) => [k, st[k]]));
  await writeFile(LASTMOD_STATE_PATH, JSON.stringify(sorted, null, 2) + "\n", "utf8");
  __lastmodDirty = false;
}

function escapeXml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/* hreflang pairs (de ↔ en); x-default = German, or English where pages.json says "x_default": "en". Only pages that exist in both languages. */
const HREFLANG_PAIRS = hreflangPairs(loadSot(ROOT)); // SSOT: data/sot/pages.json
function hreflangXml(locPath) {
  const pair = HREFLANG_PAIRS.find((x) => x.de === locPath || x.en === locPath);
  if (!pair) return "";
  const a = (lang, p) => `<xhtml:link rel="alternate" hreflang="${lang}" href="${SITE_ORIGIN}${p}"/>`;
  return a("de", pair.de) + a("en", pair.en) + a("x-default", pair.xdef || pair.de);
}

function objektHreflang(L) {
  const a = (lang, href) => `<xhtml:link rel="alternate" hreflang="${lang}" href="${href}"/>`;
  const de = `${SITE_ORIGIN}/${L.local_url}`;
  return a("de", de) + a("en", `${SITE_ORIGIN}${enPath(L.slug)}`) + a("x-default", `${SITE_ORIGIN}${enPath(L.slug)}`);
}

async function updateSitemap(data) {
  // Publish/render moment — never reuse a frozen scraped_at (e.g. 2026-09-20).
  const publishAt = new Date();
  const publishLastmod = sitemapLastmod(publishAt);

  const staticLines = [];
  for (const u of STATIC_SITEMAP_PATHS) {
    const loc = u.loc === "/" ? `${SITE_ORIGIN}/` : `${SITE_ORIGIN}${u.loc}`;
    const rel = u.loc === "/" ? "index.html" : u.loc.replace(/^\//, "").replace(/\/$/, "/index.html");
    const lastmod = await fileLastmodOr(path.join(ROOT, rel), publishAt);
    staticLines.push(
      `  <url><loc>${loc}</loc><lastmod>${lastmod}</lastmod><changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority>${hreflangXml(u.loc)}</url>`
    );
  }
  const staticUrls = staticLines.join("\n");

  const projectLines = [];
  for (const u of data._projectSitemapPaths || []) {
    const loc = u.loc === "/" ? `${SITE_ORIGIN}/` : `${SITE_ORIGIN}${u.loc}`;
    const rel = u.loc.replace(/^\//, "");
    const lastmod = await fileLastmodOr(path.join(ROOT, rel), publishAt);
    // Image sitemap entries (Google Images) for project/flyer pages.
    const imgs = (u.images || [])
      .map((src) => `<image:image><image:loc>${escapeXml(src)}</image:loc></image:image>`)
      .join("");
    projectLines.push(
      `  <url><loc>${loc}</loc><lastmod>${lastmod}</lastmod><changefreq>${u.changefreq || "weekly"}</changefreq><priority>${u.priority || "0.8"}</priority>${hreflangXml(u.loc)}${imgs}</url>`
    );
  }
  const projectUrls = projectLines.join("\n");

  const objektLines = [];
  for (const L of data.listings.filter(hasPublicDetail)) {
    const loc = `${SITE_ORIGIN}/${L.local_url}`;
    // Exposé HTML is written in this publish pass → prefer file mtime, else publish time.
    const lastmod = await fileLastmodOr(path.join(ROOT, L.local_url), publishAt);
    objektLines.push(
      `  <url><loc>${loc}</loc><lastmod>${lastmod}</lastmod><changefreq>weekly</changefreq><priority>0.7</priority>${objektHreflang(L)}</url>`
    );
    const enRel = enPath(L.slug).slice(1);
    const enLastmod = await fileLastmodOr(path.join(ROOT, enRel), publishAt);
    objektLines.push(
      `  <url><loc>${SITE_ORIGIN}/${enRel}</loc><lastmod>${enLastmod}</lastmod><changefreq>weekly</changefreq><priority>0.6</priority>${objektHreflang(L)}</url>`
    );
  }
  const objektUrls = objektLines.join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${staticUrls}
<!-- PROJECT-SITEMAP:START -->
${projectUrls}
<!-- PROJECT-SITEMAP:END -->
${SITEMAP_OBJEKT_START}
${objektUrls}
${SITEMAP_OBJEKT_END}
</urlset>
`;
  if (!dryRun) await writeFile(SITEMAP_PATH, xml, "utf8");
  await saveLastmodState();
  console.log(
    `Updated sitemap.xml (${data.listings.filter(hasPublicDetail).length} objekt URLs, publish lastmod ${publishLastmod})`
  );
}

async function renderIntoPages(data) {
  {
    // Objekt-Register (data/sot/listings.json) wird aus den Daten erzeugt: Status und Prüfdatum folgen
    // der Datenbank. Overrides/Ausnahmen wirken nur noch auf Alt-Datensätze, nie auf API-Inserate.
    if (!dryRun) {
      const r = syncListingsLayer(ROOT, data);
      console.log(`Objekt-Register: ${r.active} aktiv, ${r.hidden} nicht öffentlich (${r.api} aus der Immowelt-API), Datenstand ${r.dataAsOf || "–"}`);
    }
    applyListingLayer(loadSot(ROOT, { fresh: true }), data);
    setStandNote(data);
  }
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
    html = patchBetween(html, COUNT_START, COUNT_END, countFn(publicListings));
    if (page === "projekte") {
      html = html.replace(/<h2>Aktuelle (?:Kaufangebote|Angebote)<\/h2>/, `<h2>${publicListings.some(isRent) ? "Aktuelle Angebote" : "Aktuelle Kaufangebote"}</h2>`);
    }
    // Echtes Datum des Datenstands (zuletzt geprüft bzw. zuletzt geändert), nicht die Render-Zeit.
    const stand = dataStandLabel(data);
    html = html.replace(
      /Stand(?: der Angebote)?:\s*(?:[A-Za-zäöüÄÖÜß]+\s+\d{4}|\d{2}\.\d{2}\.\d{4})(?: \([^)]*\))?\./,
      `Stand der Angebote: ${stand}${STAND_NOTE}.`
    );
    if (!dryRun) await writeFile(fp, html, "utf8");
    console.log(`Updated ${file} (${n} listings)`);
  }

  await renderExposePages(data);
  await renderTopicObjektLinks(data);
  // Flyer/projects SoT → ai/flyer-*.json, project SEO pages, homepage ItemList; orphans removed
  const projectPub = await publishProjects({
    siteRoot: ROOT,
    origin: SITE_ORIGIN,
    dryRun,
    listings: data.listings,
  });
  data._projectSitemapPaths = projectPub.sitemapPaths || [];
  const sunside = await publishSunsidePage({ siteRoot: ROOT, origin: SITE_ORIGIN, listings: data.listings, isPublic: hasPublicDetail, dryRun });
  if (sunside) data._projectSitemapPaths.push(sunside);
  // AI-Index + Discovery aus derselben Listing-Liste wie HTML (vor Sitemap, damit lastmod greift)
  const ai = await writeAiDiscoveryArtifacts(data, {
    siteRoot: ROOT,
    origin: SITE_ORIGIN,
    dryRun,
    projects: projectPub.aiProjects,
    project_unit_count_total: projectPub.project_unit_count_total,
  });
  console.log(
    `Updated AI discovery (${ai.aiDoc.listing_count} public listings, ${ai.aiDoc.projects?.length || 0} projects → llms.txt, agents.txt, ai/, .well-known/mcp*)`
  );
  await writePublishedSnapshot(data);
  // Claude global concept: English page per listing (/en/property/<slug>.html), before the sitemap (lastmod)
  data._enModels = publishEnListings(data, { siteRoot: ROOT, dryRun });
  console.log(`Updated EN property pages (${data._enModels.length} → en/property/)`);
  await updateSitemap(data);
}

/**
 * Publish path used by SQLite SoT: write listings.json export + render HTML/partials/sitemap.
 * Does not scrape Immowelt. Safe to call with a document that includes origin=eigen rows.
 */
export async function publishListingsDocument(doc, { siteRoot = ROOT, knownSlugs = null } = {}) {
  if (siteRoot && siteRoot !== ROOT) {
    console.warn(`publishListingsDocument: siteRoot=${siteRoot} (module ROOT=${ROOT}). Prefer EICHMANN_SITE_ROOT before import.`);
  }
  const data = prepareDocument(doc);
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

/**
 * ai/immowelt-snapshot.json – what this build publishes from Immowelt, per offer: ids, marketing,
 * price, numbers, every fact row, a hash of every text section and every picture in order
 * (Immowelt asset → local file). It lets anyone compare "API → published → rendered page"
 * from outside (scripts/verify/inventory-report.mjs) and contains nothing the pages do not show.
 */
async function writePublishedSnapshot(data) {
  const { createHash } = await import("node:crypto");
  const sha = (t) => createHash("sha256").update(String(t ?? "")).digest("hex");
  const rows = (data.listings || []).filter((L) => isApi(L) && hasPublicDetail(L));
  if (!rows.length && !RELEASE_BUILD) return null; // local/CI build from the scraper-era mirror: nothing to state
  const doc = {
    schema: "eichmann.immowelt-published/v1",
    source: "immowelt_official_api",
    data_as_of: data.immowelt_checked_date || null,
    fingerprint: data.immowelt_fingerprint || null,
    count: rows.length,
    listings: rows.map((L) => ({
      position: L.position,
      online_id: L.immowelt_online_id,
      estate_id: L.immowelt_estate_id,
      guid: L.immowelt_guid,
      slug: L.slug,
      url: `${SITE_ORIGIN}/${L.local_url}`,
      content_hash: L.content_hash || null,
      marketing: L.marketing,
      price_on_request: L.price_on_request === true,
      price_eur: L.price_on_request ? null : L.price_eur ?? null,
      price: L.price,
      title: L.title,
      type: L.type || null,
      rooms: L.rooms_value ?? null,
      living_area_m2: L.living_area_value ?? null,
      plot_area_m2: L.plot_area_value ?? null,
      location: L.location || null,
      facts: (L.fact_rows || []).map((r) => [r.label, r.value]),
      sections: (L.sections || []).filter((s) => s.html).map((s) => ({ id: s.id || null, title: s.title, chars: (s.text || "").length, html_sha256: sha(s.html) })),
      pictures: (L.media || []).map((m) => ({ role: m.role, asset: m.asset_key, file: m.base ? `${m.base}.jpg` : null })),
    })),
  };
  if (!dryRun) {
    await mkdir(path.join(ROOT, "ai"), { recursive: true });
    await writeFile(path.join(ROOT, "ai", "immowelt-snapshot.json"), JSON.stringify(doc, null, 2) + "\n", "utf8");
  }
  return doc;
}

/** Database document → render model. API rows are used as they are. */
function prepareDocument(doc) {
  const data = {
    source: doc.source || PROFILE_URL,
    immowelt_profile: doc.immowelt_profile || doc.source || PROFILE_URL,
    scraped_at: doc.scraped_at || doc.exported_at || new Date().toISOString(),
    immowelt_checked_date: doc.immowelt_checked_date || null,
    immowelt_fingerprint: doc.immowelt_fingerprint || null,
    listings: Array.isArray(doc.listings) ? doc.listings.map((L) => ({ ...L })) : [],
  };
  data.listings.forEach((L, i) => {
    if (isApi(L)) {
      // Slug is frozen in the database; picture paths come from the content-addressed media store.
      L.origin = "immowelt";
      L.local_url = localExposePath(L);
      return;
    }
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
  return data;
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

  if (!renderOnly && !exportOnly) {
    // Fetching Immowelt = official API pipeline (complete-or-nothing, atomic release).
    if (args.has("--enrich-only") || args.has("--force-scrape") || args.has("--from-json") || args.has("--skip-enrich")) {
      console.error("--enrich-only/--force-scrape/--from-json/--skip-enrich sind entfernt: der Abgleich läuft ausschließlich über die offizielle Immowelt-API (scripts/immowelt-sync.mjs); eine leere Datenbank wird mit scripts/db-migrate.mjs --bootstrap befüllt.");
      process.exit(2);
    }
    const { main: runImmoweltSync } = await import("./immowelt-sync.mjs");
    process.exitCode = await runImmoweltSync(["run", ...(dryRun ? ["--dry-run"] : [])]);
    return;
  }

  if (renderOnly || exportOnly) {
    // Database first. A release build reads ONLY the database it was given: an empty inventory is a
    // valid state and must never be replaced by an old JSON mirror.
    let doc = null;
    let slugs = null;
    try {
      const { openDb, exportListingsDocument, allSlugs } = await import("./lib/db.mjs");
      const db = openDb();
      doc = exportListingsDocument(db);
      slugs = allSlugs(db);
      db.close();
    } catch (e) {
      if (RELEASE_BUILD) throw e;
      console.warn("SQLite unavailable, falling back to JSON:", e.message || e);
    }
    if (doc && (RELEASE_BUILD || doc.listings?.length)) {
      if (exportOnly) {
        const prepared = prepareDocument(doc);
        process.env.EICHMANN_SOT = "sqlite";
        await writeCanonical(prepared);
        const r = syncListingsLayer(ROOT, prepared);
        console.log(`Export done (SQLite → data/listings.json, Objekt-Register ${r.active} aktiv).`);
        return;
      }
      await publishListingsDocument(doc, { knownSlugs: slugs });
      console.log("Render-only done (SQLite SoT → JSON export + HTML).");
      return;
    }
    if (exportOnly) {
      if (previous) syncListingsLayer(ROOT, previous);
      console.log("Export skipped (no database rows) – using data/listings.json as it is.");
      return;
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

  // (render-only with the JSON mirror ends above; nothing else is reachable here)
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

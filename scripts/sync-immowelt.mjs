#!/usr/bin/env node
/**
 * Immowelt → immobilieneichmann.de listings sync (Single Source of Truth).
 *
 * Canonical store: data/listings.json (keyed by expose UUID)
 * Regenerates listing cards in index.html + projekte.html between markers.
 * Downloads images to assets/listings/{nn}-{uuid8}.{jpg,webp}
 *
 * Usage:
 *   node scripts/sync-immowelt.mjs
 *   node scripts/sync-immowelt.mjs --from-json /path/to/listings.json
 *   node scripts/sync-immowelt.mjs --render-only
 *   node scripts/sync-immowelt.mjs --dry-run
 *
 * Soft-fail: if live scrape fails (DataDome / network), keep last good JSON
 * and exit 0 so CI does not wipe the site.
 */

import { readFile, writeFile, mkdir, readdir, unlink, copyFile, access } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const PROFILE_URL =
  process.env.IMMOWELT_PROFILE_URL ||
  "https://www.immowelt.de/profil/3b18336c6a2e401da38e9cc20268270d";

const DATA_PATH = path.join(ROOT, "data", "listings.json");
const IMAGES_DIR = path.join(ROOT, "assets", "listings");
const PARTIAL_PATH = path.join(ROOT, "partials", "listings-grid.html");

const MARKER_START = "<!-- IMMWELT-LISTINGS:START -->";
const MARKER_END = "<!-- IMMWELT-LISTINGS:END -->";
const COUNT_START = "<!-- IMMWELT-COUNT:START -->";
const COUNT_END = "<!-- IMMWELT-COUNT:END -->";

const args = new Set(process.argv.slice(2));
const fromJsonArg = (() => {
  const i = process.argv.indexOf("--from-json");
  return i >= 0 ? process.argv[i + 1] : null;
})();
const renderOnly = args.has("--render-only");
const dryRun = args.has("--dry-run");
const forceScrape = args.has("--force-scrape");

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

function badgeFor(listing) {
  const blob = `${listing.title || ""} ${listing.short_description || ""}`.toLowerCase();
  if (blob.includes("provisionsfrei")) {
    return { text: "Provisionsfrei", className: "listing-badge green" };
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

  return {
    id,
    title: (raw.title || "Immobilie").trim(),
    price: (raw.price || "").trim() || null,
    location: (raw.location || "").trim() || null,
    rooms: (raw.rooms || "").trim() || null,
    living_area: (raw.living_area || raw.livingArea || "").trim() || null,
    plot_area: raw.plot_area ?? raw.plotArea ?? null,
    type: (raw.type || "").trim() || null,
    status: (raw.status || "Kauf").trim() || "Kauf",
    short_description: (raw.short_description || raw.shortDescription || "").trim() || null,
    expose_url,
    main_image_url: raw.main_image_url || raw.mainImageUrl || raw.image || null,
    image_base: raw.image_base || imageBase(index, id),
  };
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

  return `        <a class="listing-card" href="${escapeHtml(listing.expose_url)}" target="_blank" rel="noopener noreferrer">
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
              <span class="btn btn-primary btn-sm">Zum Exposé</span>
            </div>
          </div>
        </a>`;
}

function renderGrid(listings) {
  const cards = listings.map(renderCard).join("\n\n");
  return `${MARKER_START}\n${cards}\n${MARKER_END}`;
}

function countTextIndex(n) {
  return `${COUNT_START}${n} Kaufobjekte in und um Konstanz – Fotos und Eckdaten, Exposé auf Immowelt.${COUNT_END}`;
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
  // Find matching close of listings-grid: first </div> that closes the grid after cards.
  // Prefer content until the note / next sibling after grid.
  const after = html.slice(openEnd);
  // Heuristic: cards end right before "</div>" that precedes immowelt-note OR section close.
  let closeRel = after.search(/\n\s*<\/div>\s*\n\s*<p class="immowelt-note"/);
  if (closeRel === -1) {
    closeRel = after.search(/<\/div>\s*<p class="immowelt-note"/);
  }
  if (closeRel === -1) {
    // projekte: </a></div> then note
    closeRel = after.search(/<\/a>\s*<\/div>/);
    if (closeRel !== -1) {
      // include through </a>, close div stays outside
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
      /(\d+)\s+Kaufobjekte in und um Konstanz – Fotos und Eckdaten, Exposé auf Immowelt\./,
      (_, n) => countTextIndex(n)
    );
  }
  return html.replace(
    /(\d+)\s+Objekte – Details im Exposé\./,
    (_, n) => countTextProjekte(n)
  );
}

async function loadJson(filePath) {
  const raw = JSON.parse(await readFile(filePath, "utf8"));
  const list = Array.isArray(raw) ? raw : raw.listings || [];
  const listings = list
    .map((item, i) => normalizeListing(item, i))
    .filter(Boolean);

  // Deduplicate by id, keep first
  const seen = new Set();
  const unique = [];
  for (const L of listings) {
    if (seen.has(L.id)) continue;
    seen.add(L.id);
    unique.push(L);
  }
  // Re-index image_base
  unique.forEach((L, i) => {
    L.image_base = imageBase(i, L.id);
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

async function convertImages(srcPath, base) {
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
    width: 800,
    height: 600,
    fit: "cover",
    withoutEnlargement: false,
  });

  await pipelineImg.clone().jpeg({ quality: 82, mozjpeg: true }).toFile(jpg);
  await pipelineImg.clone().webp({ quality: 78 }).toFile(webp);
}

async function syncImages(data, { skipDownload = false } = {}) {
  await mkdir(IMAGES_DIR, { recursive: true });

  const keepBases = new Set(data.listings.map((L) => L.image_base));

  for (let i = 0; i < data.listings.length; i++) {
    const L = data.listings[i];
    const jpgPath = path.join(IMAGES_DIR, `${L.image_base}.jpg`);
    const webpPath = path.join(IMAGES_DIR, `${L.image_base}.webp`);

    const haveJpg = await fileExists(jpgPath);
    const haveWebp = await fileExists(webpPath);

    if (haveJpg && haveWebp) {
      continue;
    }

    if (skipDownload && haveJpg && !haveWebp) {
      try {
        await convertImages(jpgPath, L.image_base);
      } catch (e) {
        console.warn(`webp convert failed for ${L.image_base}:`, e.message);
      }
      continue;
    }

    if (!L.main_image_url) {
      console.warn(`No image URL for ${L.id}`);
      continue;
    }

    const tmpExt = (L.main_image_url.split("?")[0].match(/\.(jpe?g|png|webp)$/i) || [
      ,
      "jpg",
    ])[1].toLowerCase();
    const tmp = path.join(IMAGES_DIR, `._tmp-${L.image_base}.${tmpExt}`);
    try {
      console.log(`Downloading image ${i + 1}/${data.listings.length}: ${L.image_base}`);
      await downloadTo(L.main_image_url, tmp);
      await convertImages(tmp, L.image_base);
      await unlink(tmp).catch(() => {});
    } catch (e) {
      console.warn(`Image sync failed for ${L.id}:`, e.message);
      await unlink(tmp).catch(() => {});
    }
  }

  // Remove orphaned listing images (only nn-uuid8 pattern)
  const files = await readdir(IMAGES_DIR);
  for (const f of files) {
    if (f.startsWith("._tmp-")) {
      await unlink(path.join(IMAGES_DIR, f)).catch(() => {});
      continue;
    }
    const m = f.match(/^(\d{2}-[a-f0-9]{8})\.(jpe?g|png|webp)$/i);
    if (!m) continue;
    if (!keepBases.has(m[1])) {
      console.log(`Removing orphan image ${f}`);
      if (!dryRun) await unlink(path.join(IMAGES_DIR, f));
    }
  }
}

async function writeCanonical(data) {
  await mkdir(path.dirname(DATA_PATH), { recursive: true });
  const out = {
    source: data.source || PROFILE_URL,
    scraped_at: data.scraped_at,
    listing_count: data.listings.length,
    listings: data.listings.map((L) => ({
      id: L.id,
      title: L.title,
      price: L.price,
      location: L.location,
      rooms: L.rooms,
      living_area: L.living_area,
      plot_area: L.plot_area,
      type: L.type,
      status: L.status,
      short_description: L.short_description,
      expose_url: L.expose_url,
      main_image_url: L.main_image_url,
      image_base: L.image_base,
    })),
  };
  const json = JSON.stringify(out, null, 2) + "\n";
  if (!dryRun) await writeFile(DATA_PATH, json, "utf8");
  return out;
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
    // Refresh stand note month/year lightly if present
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

    // Wait for expose links or DataDome challenge
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

    // Scroll to trigger lazy load
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

        // Climb to a likely card root
        let card = a;
        for (let i = 0; i < 8 && card.parentElement; i++) {
          card = card.parentElement;
          if (
            card.querySelectorAll('a[href*="/expose/"]').length === 1 ||
            (card.innerText && card.innerText.length > 40 && card.innerText.length < 800)
          ) {
            // prefer larger card containers
          }
        }
        // Better: find nearest element with price-like text
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

        // Parse loosely
        const priceM = text.match(/(\d{1,3}(?:\.\d{3})*(?:,\d+)?\s*€)/);
        const roomsM = text.match(/(\d+(?:,\d+)?\s*Zimmer)/i);
        const areaM = text.match(/(\d+(?:,\d+)?\s*m²)/);
        const plotM = text.match(/(\d+(?:\.\d{3})*(?:,\d+)?\s*m²\s*Grundstück)/i);

        // Title: often after price line
        let title = null;
        const parts = text.split("|").map((p) => p.trim());
        if (parts.length >= 2) title = parts[1];
        if (!title) {
          const lines = (best.innerText || "")
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);
          title = lines.find((l) => /zum Kauf|Miete|Wohnung|Haus|Penthouse|Maisonette/i.test(l)) || lines[1] || "Immobilie";
        }

        // Location: often last chunk with PLZ
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

    console.log(`Scraped ${raw.length} listings`);
    const listings = raw
      .map((item, i) => normalizeListing(item, i))
      .filter(Boolean);

    return {
      source: PROFILE_URL,
      scraped_at: new Date().toISOString(),
      listing_count: listings.length,
      listings,
    };
  } finally {
    await browser.close();
  }
}

async function main() {
  console.log("Immowelt sync – root:", ROOT);

  let data;

  if (renderOnly) {
    if (!(await fileExists(DATA_PATH))) {
      console.error("No data/listings.json – cannot --render-only");
      process.exit(1);
    }
    data = await loadJson(DATA_PATH);
    await renderIntoPages(data);
    console.log("Render-only done.");
    return;
  }

  if (fromJsonArg) {
    const src = path.resolve(fromJsonArg);
    console.log("Seeding from", src);
    data = await loadJson(src);
    // Preserve local images if seed points at workspace paths – remap image_base only
    data.scraped_at = data.scraped_at || new Date().toISOString();
  } else {
    try {
      data = await scrapeImmowelt();
    } catch (err) {
      console.error("Scrape failed (soft-fail):", err.message || err);
      if (await fileExists(DATA_PATH)) {
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

  // Reassign image_base in scrape order
  data.listings.forEach((L, i) => {
    L.image_base = imageBase(i, L.id);
  });
  data.listing_count = data.listings.length;

  if (dryRun) {
    console.log(JSON.stringify(data, null, 2));
    console.log("Dry-run: no files written.");
    return;
  }

  await writeCanonical(data);
  await syncImages(data, {
    // When seeding from local JSON that already has repo images, still fill gaps
    skipDownload: false,
  });
  await renderIntoPages(data);

  console.log(`Done. ${data.listing_count} listings → data/listings.json + HTML.`);
}

main().catch((err) => {
  console.error(err);
  // Soft-fail for CI: never fail the workflow hard on unexpected errors
  // if we already have good data (unless --force-scrape and explicit CI hard mode)
  const hard = process.env.IMMOWELT_HARD_FAIL === "1" || forceScrape;
  process.exit(hard ? 1 : 0);
});

#!/usr/bin/env node
/**
 * Screenshots for the visual check: always the same two viewports (desktop 1440×900,
 * mobile 390×844 @2x), always the whole page.
 *
 *   node scripts/verify/capture-screens.mjs --label before        BEFORE the sync changes anything
 *   node scripts/verify/capture-screens.mjs --label after         after the publish
 *       → the COMPLETE page inventory of the website: every URL of the sitemap plus every page
 *         that is linked internally (German and English, offer pages, legal pages …)
 *
 *   node scripts/verify/capture-screens.mjs --label immowelt [--headed]
 *       → the public Immowelt page of every offer (https://www.immowelt.de/expose/<online-id>).
 *         Immowelt answers data-centre addresses (GitHub Actions, the server) with 403, so this
 *         runs on your own computer. Nothing is circumvented: a page that is refused or shows a
 *         security check is recorded as "not captured". With --headed a normal browser window
 *         opens and waits for you – consent notices or checks are answered by you, not by the script.
 *
 *   node scripts/verify/capture-screens.mjs --label immowelt-api --snapshot <api-snapshot.json>
 *       → every offer exactly as the Immowelt API delivers it, in a neutral reference layout
 *         (snapshot file: inventory-report.mjs --api --api-snapshot <file>). Works everywhere.
 *
 * Options: --base https://immobilieneichmann.de   --out test-results/verify/screens
 *          --pages /a.html,/b.html (additional)   --max-pages 400   --online-ids a,b,c
 * Output:  <out>/<label>/{desktop,mobile}/<page>.jpg + manifest.json (release id, time, hashes).
 * Then:    node scripts/verify/build-review.mjs   → test-results/verify/review/index.html
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { VIEWPORTS, discoverPages, pageKey, referenceCardHtml, sha256 } from "./lib.mjs";
import { inspectExposeHtml } from "../lib/release-verify.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const label = opt("--label");
if (!label || !/^[a-z0-9_-]+$/i.test(label)) {
  console.error("--label before | after | immowelt | immowelt-api fehlt");
  process.exit(2);
}
const base = String(opt("--base", "https://immobilieneichmann.de")).replace(/\/+$/, "");
const OUT = path.resolve(opt("--out", "test-results/verify/screens"), label);
const headed = args.includes("--headed");
const JPEG_QUALITY = 85;
/** Chromium cannot paint arbitrarily tall bitmaps: very long pages are stored as consecutive parts. */
const MAX_PART_DEVICE_PX = 8000;

const getJson = async (url) => {
  try {
    const res = await fetch(url, { headers: { "Cache-Control": "no-cache", "User-Agent": "eichmann-verify/1" }, signal: AbortSignal.timeout(30_000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
};
const ask = (question) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(question, (answer) => {
    rl.close();
    resolve(answer.trim());
  });
});

/** Quiet page: no cookie layer over the content, no running animations. */
// Never html/body: this site marks <body class="cookie-banner-open"> – hiding that would hide the whole page.
const NOT_ROOT = ":not(html):not(body):not(main)";
const QUIET_CSS = `[id*="cookie" i]${NOT_ROOT},[class*="cookie" i]${NOT_ROOT},[id*="consent" i]${NOT_ROOT},[class*="consent" i]${NOT_ROOT},[id^="sp_message_container"],#usercentrics-root,#onetrust-consent-sdk,#didomi-host{display:none!important}*{animation:none!important;transition:none!important;scroll-behavior:auto!important}`;
async function quiet(context) {
  await context.addInitScript((css) => {
    const add = () => document.head && document.head.appendChild(Object.assign(document.createElement("style"), { textContent: css }));
    if (document.head) add();
    else document.addEventListener("DOMContentLoaded", add);
  }, QUIET_CSS);
}

/** Load lazy pictures over the whole height and wait until they are decoded (bounded). */
async function settle(page) {
  await page.evaluate(async () => {
    for (let y = 0; y < document.documentElement.scrollHeight; y += 600) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 60));
    }
    window.scrollTo(0, 0);
    const pending = [...document.images].filter((img) => !img.complete).map((img) => new Promise((r) => { img.onload = img.onerror = r; }));
    await Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, 15_000))]);
  });
}

/** Whole page as one JPEG, or as consecutive parts when it is taller than Chromium can paint at once. */
async function shoot(page, vp, name) {
  const dsf = VIEWPORTS[vp].deviceScaleFactor;
  const width = VIEWPORTS[vp].viewport.width;
  const height = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0, window.innerHeight));
  const part = Math.floor(MAX_PART_DEVICE_PX / dsf);
  const n = Math.max(1, Math.ceil(height / part));
  fs.mkdirSync(path.join(OUT, vp), { recursive: true });
  const files = [];
  for (let i = 0; i < n; i++) {
    const file = path.join(vp, n === 1 ? `${name}.jpg` : `${name}-${i + 1}.jpg`);
    await page.screenshot({ path: path.join(OUT, file), type: "jpeg", quality: JPEG_QUALITY, fullPage: true, clip: { x: 0, y: i * part, width, height: Math.min(part, height - i * part) } });
    files.push(file.split(path.sep).join("/"));
  }
  return { files, height_css_px: height, sha256: sha256(files.map((f) => sha256(fs.readFileSync(path.join(OUT, f)))).join("\n")) };
}

function writeManifest(manifest) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

const { chromium } = await import("playwright");
const contextOptions = (vp) => ({ ...VIEWPORTS[vp], locale: "de-DE", timezoneId: "Europe/Berlin", reducedMotion: "reduce" });

/* ------------------------------------------------------------------ the website (before / after) */
async function captureSite() {
  const build = await getJson(`${base}/ai/build.json`);
  const ai = await getJson(`${base}/ai/listings.json`);
  const extra = String(opt("--pages", "")).split(",").map((s) => s.trim()).filter(Boolean);
  for (const L of ai?.listings || []) if (L.local_url) extra.push(`/${L.local_url}`);
  const { pages, truncated } = await discoverPages(base, { maxPages: Number(opt("--max-pages", "400")), extra });
  if (!pages.length || pages[0].path !== "/" || pages[0].status !== 200) {
    console.error(`Startseite von ${base} nicht erreichbar – keine Aufnahme.`);
    process.exit(1);
  }
  console.log(`${pages.length} Seiten im Bestand von ${base}${truncated ? " (GEKÜRZT: --max-pages erhöhen)" : ""}`);
  const manifest = { schema: "eichmann.verify-screens/v1", label, kind: "site", base, captured_at: new Date().toISOString(), release_id: build?.release_id || null, data_as_of: build?.data_as_of || null, listing_count: ai?.listing_count ?? null, page_count: pages.length, truncated, viewports: VIEWPORTS, pages: [] };
  const browser = await chromium.launch();
  try {
    for (const vp of Object.keys(VIEWPORTS)) {
      const context = await browser.newContext(contextOptions(vp));
      await quiet(context);
      for (const p of pages) {
        const page = await context.newPage();
        const entry = { path: p.path, key: p.path, url: `${base}${p.path}`, viewport: vp, http_status: 0, title: "", html_sha256: p.html_sha256, source: p.source };
        try {
          const res = await page.goto(`${base}${encodeURI(p.path)}`, { waitUntil: "networkidle", timeout: 60_000 });
          entry.http_status = res?.status() || 0;
          if (/^\/objekt\//.test(p.path) && res) {
            const info = inspectExposeHtml(await res.text());
            entry.listing = { listing_id: info.listing_id, online_id: info.online_id, marketing: info.marketing, h1: info.h1, hero: info.hero, gallery_count: info.gallery_images.length, floorplan_count: info.floorplan_images.length };
          }
          await settle(page);
          entry.title = await page.title();
          const visible = await page.evaluate(() => (document.body ? document.body.getBoundingClientRect().height > 50 && document.body.innerText.trim().length > 50 : false));
          if (!visible) throw Object.assign(new Error("blank"), { name: "LeereSeite" });
          Object.assign(entry, await shoot(page, vp, pageKey(p.path)));
        } catch (err) {
          entry.error = String(err?.name || "Fehler");
          entry.files = [];
        }
        manifest.pages.push(entry);
        console.log(`${vp.padEnd(8)} ${String(entry.http_status).padEnd(4)} ${p.path}${entry.error ? `  FEHLER ${entry.error}` : ""}`);
        await page.close();
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
  writeManifest(manifest);
  const failed = manifest.pages.filter((p) => p.error).length;
  const not200 = new Set(manifest.pages.filter((p) => p.http_status !== 200).map((p) => p.path));
  console.log(`${manifest.pages.length} Aufnahmen in ${OUT} · Release ${manifest.release_id || "ohne Kennung"} · ${not200.size} Seite(n) nicht HTTP 200 · ${failed} Aufnahmefehler`);
  return failed ? 1 : 0;
}

/* ------------------------------------------------------------------ Immowelt, public pages */
async function onlineIds() {
  const given = String(opt("--online-ids", "")).split(",").map((s) => s.trim().toLowerCase()).filter((s) => /^[a-z0-9]{5,12}$/.test(s));
  if (given.length) return given;
  if (opt("--snapshot")) return JSON.parse(fs.readFileSync(opt("--snapshot"), "utf8")).listings.map((L) => L.immowelt_online_id);
  const published = await getJson(`${base}/ai/immowelt-snapshot.json`);
  return (published?.listings || []).map((L) => L.online_id);
}

async function refusal(page, status) {
  if (status === 403 || status === 429) return `HTTP ${status}`;
  const title = await page.title().catch(() => "");
  if (/captcha|sicherheits(über)?prüfung|access denied|zugriff verweigert|bist du ein mensch|are you a human/i.test(title)) return `Sicherheitsabfrage („${title.slice(0, 60)}“)`;
  if (await page.locator('iframe[src*="captcha-delivery"], iframe[src*="captcha"], #px-captcha').count().catch(() => 0)) return "Sicherheitsabfrage";
  return null;
}

async function captureImmowelt() {
  const ids = await onlineIds();
  if (!ids.length) {
    console.error("Keine Online-IDs: --online-ids a,b,c angeben (oder nach der Umstellung ohne Angabe: Liste kommt aus /ai/immowelt-snapshot.json).");
    process.exit(2);
  }
  const manifest = { schema: "eichmann.verify-screens/v1", label, kind: "immowelt-public", base: "https://www.immowelt.de", captured_at: new Date().toISOString(), headed, viewports: VIEWPORTS, pages: [] };
  const profile = path.resolve(opt("--profile", path.join(path.dirname(OUT), ".immowelt-browser-profile")));
  let first = true;
  for (const vp of Object.keys(VIEWPORTS)) {
    const browser = headed ? null : await chromium.launch();
    const context = headed ? await chromium.launchPersistentContext(profile, { ...contextOptions(vp), headless: false }) : await browser.newContext(contextOptions(vp));
    await quiet(context);
    try {
      for (const id of ids) {
        const page = await context.newPage();
        const url = `https://www.immowelt.de/expose/${id}`;
        const entry = { key: id, online_id: id, path: `/expose/${id}`, url, viewport: vp, http_status: 0, title: "", files: [] };
        try {
          const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
          entry.http_status = res?.status() || 0;
          if (headed && first) {
            await ask("Browserfenster: Hinweise/Abfragen von Immowelt bitte selbst beantworten. Wenn das Exposé zu sehen ist, hier Enter drücken … ");
            first = false;
          }
          let why = await refusal(page, headed ? 0 : entry.http_status);
          if (why && headed) {
            const answer = await ask(`${id}: ${why}. Im Browserfenster selbst beantworten, dann Enter (oder „s“ + Enter zum Überspringen) … `);
            why = answer.toLowerCase() === "s" ? why : await refusal(page, 0);
          }
          if (why) entry.blocked = why;
          else {
            await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
            await settle(page);
            entry.title = await page.title();
            Object.assign(entry, await shoot(page, vp, id));
          }
        } catch (err) {
          entry.blocked = `nicht ladbar (${err?.name || "Fehler"})`;
        }
        manifest.pages.push(entry);
        console.log(`${vp.padEnd(8)} ${id}  ${entry.blocked ? `NICHT AUFGENOMMEN: ${entry.blocked}` : "ok"}`);
        await page.close();
      }
    } finally {
      await context.close();
      if (browser) await browser.close();
    }
  }
  writeManifest(manifest);
  const blocked = manifest.pages.filter((p) => p.blocked).length;
  console.log(`${manifest.pages.length - blocked} von ${manifest.pages.length} Immowelt-Aufnahmen in ${OUT}`);
  if (blocked) console.log("Nicht aufgenommene Seiten: auf dem eigenen Rechner mit --headed wiederholen. In der Sichtprüfung erscheint dafür die API-Referenz (--label immowelt-api), sofern vorhanden.");
  return blocked === manifest.pages.length ? 3 : 0;
}

/* ------------------------------------------------------------------ Immowelt, as delivered by the API */
async function captureApiReference() {
  const file = opt("--snapshot");
  if (!file || !fs.existsSync(file)) {
    console.error("--snapshot <datei> fehlt (erzeugen mit: node scripts/verify/inventory-report.mjs --api --api-snapshot <datei>).");
    process.exit(2);
  }
  const snapshot = JSON.parse(fs.readFileSync(file, "utf8"));
  const manifest = { schema: "eichmann.verify-screens/v1", label, kind: "immowelt-api", base: "Immowelt API", captured_at: snapshot.fetched_at || new Date().toISOString(), viewports: VIEWPORTS, pages: [] };
  const browser = await chromium.launch();
  try {
    for (const vp of Object.keys(VIEWPORTS)) {
      const context = await browser.newContext(contextOptions(vp));
      for (const L of snapshot.listings || []) {
        const id = L.immowelt_online_id;
        const page = await context.newPage();
        await page.setContent(referenceCardHtml(L, { fetchedAt: snapshot.fetched_at }), { waitUntil: "load", timeout: 60_000 }).catch(() => {});
        await settle(page);
        const imagesFailed = await page.evaluate(() => [...document.images].filter((img) => !img.naturalWidth).length);
        manifest.pages.push({ key: id, online_id: id, path: `/expose/${id}`, url: `https://www.immowelt.de/expose/${id}`, viewport: vp, http_status: 200, title: L.title, images_failed: imagesFailed, ...(await shoot(page, vp, id)) });
        console.log(`${vp.padEnd(8)} ${id}  API-Referenz${imagesFailed ? ` (${imagesFailed} Bild(er) nicht ladbar)` : ""}`);
        await page.close();
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
  writeManifest(manifest);
  console.log(`${manifest.pages.length} API-Referenzaufnahmen in ${OUT}`);
  return 0;
}

const code = label === "immowelt" ? await captureImmowelt() : label === "immowelt-api" ? await captureApiReference() : await captureSite();
process.exit(code);

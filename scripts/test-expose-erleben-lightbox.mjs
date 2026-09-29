#!/usr/bin/env node
/**
 * Contract: Exposé "Erleben" lightbox is immersive fullscreen —
 * only a small close X top-left; no large sticky/nav chrome.
 *
 * Run: node scripts/test-expose-erleben-lightbox.mjs
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const css = readFileSync(join(ROOT, "css/styles.css"), "utf8");
const js = readFileSync(join(ROOT, "js/main.js"), "utf8");

assert.match(css, /expose-lightbox-v3-erleben-fs/, "CSS cache marker for erleben fullscreen");
assert.match(css, /\.lb-overlay\s*\{[\s\S]*?z-index:\s*1400/, "lightbox z-index above sticky-bar (1300)");
assert.match(css, /body\.lb-open\s+\.sticky-bar/, "sticky-bar hidden while lb-open");
assert.match(css, /body\.lb-open\s+\.floating-wa/, "floating-wa hidden while lb-open");
assert.match(css, /\.lb-close\s*\{[\s\S]*?left:\s*max\(/, "close control is top-left");
assert.doesNotMatch(
  css.match(/\.lb-close\s*\{[^}]+\}/)?.[0] || "",
  /right:\s*max\(/,
  "close must not be positioned top-right"
);
assert.match(css, /\.lb-nav\s*\{\s*display:\s*none\s*!important/, "large prev/next nav chrome hidden");

assert.match(js, /Exposé lightbox v3/, "JS immersion version");
assert.match(js, /classList\.add\("lb-open"\)/, "body.lb-open set on open");
assert.match(js, /classList\.remove\("lb-open"\)/, "body.lb-open cleared on close");
assert.match(js, /e\.key === "Escape"/, "Escape closes lightbox");
assert.match(js, /setAttribute\("aria-label",\s*"Exposé erleben"\)/, "dialog labeled as Erleben");
assert.doesNotMatch(js, /class="lb-nav lb-prev"/, "no large prev control in lightbox markup");
assert.doesNotMatch(js, /class="lb-nav lb-next"/, "no large next control in lightbox markup");
assert.match(js, /touchstart/, "mobile swipe navigation retained");

const objektDir = join(ROOT, "objekt");
const pages = existsSync(objektDir)
  ? readdirSync(objektDir).filter((n) => n.endsWith(".html")).slice(0, 1)
  : [];
assert.ok(pages.length, "at least one exposé page present for runtime check");

const PORT = Number(process.env.ERLEBEN_TEST_PORT || 8767);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

const server = createServer((req, res) => {
  try {
    let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    if (urlPath === "/") urlPath = "/index.html";
    const filePath = join(ROOT, urlPath.replace(/^\//, ""));
    if (!filePath.startsWith(ROOT) || !existsSync(filePath)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(readFileSync(filePath));
  } catch (e) {
    res.writeHead(500);
    res.end(String(e));
  }
});

await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(`${base}/objekt/${pages[0]}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  const galleryImg = page.locator("#expose-gallery img").first();
  await galleryImg.waitFor({ state: "attached", timeout: 10000 });
  await galleryImg.click({ force: true });
  await page.waitForSelector(".lb-overlay:not([hidden])", { timeout: 5000 });

  const state = await page.evaluate(() => {
    const overlay = document.querySelector(".lb-overlay");
    const close = document.querySelector(".lb-close");
    const nav = document.querySelectorAll(".lb-nav");
    const sticky = document.querySelector(".sticky-bar");
    const closeBox = close?.getBoundingClientRect();
    const stickyVisible = sticky
      ? getComputedStyle(sticky).display !== "none" && getComputedStyle(sticky).visibility !== "hidden"
      : false;
    return {
      lbOpen: document.body.classList.contains("lb-open"),
      overlayHidden: overlay?.hidden === true,
      navCount: nav.length,
      stickyVisible,
      closeLeft: closeBox ? Math.round(closeBox.left) : null,
      closeTop: closeBox ? Math.round(closeBox.top) : null,
      closeRight: closeBox ? Math.round(closeBox.right) : null,
      vw: window.innerWidth,
    };
  });

  assert.equal(state.lbOpen, true, "body.lb-open while experiencing");
  assert.equal(state.overlayHidden, false, "overlay visible");
  assert.equal(state.navCount, 0, "no large nav icons in DOM");
  assert.equal(state.stickyVisible, false, "sticky control bar hidden in erleben mode");
  assert.ok(state.closeLeft != null && state.closeLeft < 48, `close X top-left (left=${state.closeLeft})`);
  assert.ok(state.closeTop != null && state.closeTop < 64, `close X near top (top=${state.closeTop})`);
  assert.ok(state.closeRight != null && state.closeRight < state.vw / 2, "close not on the right half");

  await page.keyboard.press("Escape");
  await page.waitForFunction(() => {
    const overlay = document.querySelector(".lb-overlay");
    return overlay?.hidden === true && !document.body.classList.contains("lb-open");
  }, null, { timeout: 5000 });

  console.log("PASS — exposé erleben lightbox immersion:", pages[0]);
} finally {
  await browser.close();
  server.close();
}

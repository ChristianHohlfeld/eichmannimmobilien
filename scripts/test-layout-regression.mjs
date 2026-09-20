#!/usr/bin/env node
/**
 * Layout / optical regression guards (desktop + mobile).
 * Catches grobe Patzer: Horizontal-Overflow, collapsed logo, missing header/H1.
 * Default: SOFT (exit 0, issues logged). Hard gate: STRICT=1.
 *
 * Run: node scripts/test-layout-regression.mjs
 * Optional: BASE_URL=https://immobilieneichmann.de node scripts/test-layout-regression.mjs
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PORT = Number(process.env.LAYOUT_TEST_PORT || 8765);
const EXTERNAL = process.env.BASE_URL || '';

const PAGES = [
  '/',
  '/kontakt.html',
  '/immobilienmakler-konstanz.html',
  '/wohnung-kaufen-konstanz.html',
];

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'mobile', width: 390, height: 844 },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const errors = [];
function fail(msg) {
  errors.push(msg);
}

function startStaticServer() {
  const server = createServer((req, res) => {
    try {
      let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      if (urlPath === '/') urlPath = '/index.html';
      const filePath = join(ROOT, urlPath.replace(/^\//, ''));
      if (!filePath.startsWith(ROOT) || !existsSync(filePath) || !statSync(filePath).isFile()) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const ext = extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(readFileSync(filePath));
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  });
  return new Promise((resolve) => {
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

async function measurePage(page, base, path, vp) {
  const label = `${vp.name} ${path}`;
  await page.setViewportSize({ width: vp.width, height: vp.height });
  const res = await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (!res || !res.ok()) {
    fail(`${label}: HTTP ${res ? res.status() : 'no response'}`);
    return;
  }
  // allow fonts/layout to settle
  await page.waitForTimeout(400);

  const metrics = await page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    const header = document.querySelector('.site-header, header');
    const logoImg = document.querySelector('.site-header .logo-svg, .site-header .logo img, header .logo img');
    const logoBox = logoImg ? logoImg.getBoundingClientRect() : null;
    const headerBox = header ? header.getBoundingClientRect() : null;
    const overflowX = Math.max(doc.scrollWidth, body?.scrollWidth || 0) - window.innerWidth;
    // elements wider than viewport (ignore absolute offscreen flyers if display none)
    const offenders = [];
    for (const el of document.querySelectorAll('body *')) {
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') continue;
      if (st.position === 'fixed' || st.position === 'absolute') {
        // skip flyer/cookie overlays for overflow scan unless they force body scroll
        if (el.classList.contains('flyer-modal') || el.id === 'cookie-banner' || el.classList.contains('cookie-banner')) continue;
      }
      const r = el.getBoundingClientRect();
      if (r.width > window.innerWidth + 2) {
        offenders.push({
          tag: el.tagName.toLowerCase(),
          cls: (el.className || '').toString().slice(0, 80),
          w: Math.round(r.width),
        });
        if (offenders.length >= 5) break;
      }
    }
    return {
      overflowX: Math.round(overflowX),
      scrollWidth: Math.max(doc.scrollWidth, body?.scrollWidth || 0),
      innerWidth: window.innerWidth,
      logo: logoBox
        ? { w: Math.round(logoBox.width), h: Math.round(logoBox.height), x: Math.round(logoBox.x), y: Math.round(logoBox.y) }
        : null,
      headerH: headerBox ? Math.round(headerBox.height) : 0,
      hasH1: !!document.querySelector('h1'),
      title: document.title || '',
    };
  });

  if (metrics.overflowX > 8) {
    fail(`${label}: horizontal overflow ${metrics.overflowX}px (scrollWidth=${metrics.scrollWidth}, vw=${metrics.innerWidth})`);
  }
  if (!metrics.logo) {
    fail(`${label}: header logo <img> missing`);
  } else {
    if (metrics.logo.w < 100) fail(`${label}: logo width collapsed (${metrics.logo.w}px) — expected ≥100`);
    if (metrics.logo.h < 20) fail(`${label}: logo height collapsed (${metrics.logo.h}px)`);
    if (metrics.logo.w > vp.width - 40) fail(`${label}: logo wider than viewport (${metrics.logo.w}px)`);
  }
  if (metrics.headerH < 40) fail(`${label}: header too short (${metrics.headerH}px)`);
  if (!metrics.hasH1) fail(`${label}: missing <h1>`);
  if (!metrics.title || metrics.title.length < 5) fail(`${label}: missing document title`);

  // Contact form must reject empty submit and require privacy acknowledgement.
  if (path === '/kontakt.html') {
    const formGuard = await page.evaluate(() => {
      const form = document.getElementById('contact-form');
      const success = document.getElementById('form-success');
      const ack = form?.querySelector('[name="privacy_ack"]');
      if (!form || !ack) return null;
      const initialValid = form.checkValidity();
      form.querySelector('button[type="submit"]')?.click();
      return {
        initialValid,
        ackRequired: ack.required,
        ackChecked: ack.checked,
        successVisible: !!success && !success.hidden,
      };
    });
    if (!formGuard) fail(`${label}: contact form/privacy acknowledgement missing`);
    else {
      if (formGuard.initialValid) fail(`${label}: contact form must reject empty submit`);
      if (!formGuard.ackRequired) fail(`${label}: privacy acknowledgement must be required`);
      if (formGuard.ackChecked) fail(`${label}: privacy acknowledgement must start unchecked`);
      if (formGuard.successVisible) fail(`${label}: success message shown for invalid empty form`);
    }
  }

  // Home flyer: Close button must sit on the flyer's right edge on desktop and mobile.
  // Wait for the intentional 800ms auto-open delay before measuring.
  if (path === '/') {
    await page.waitForTimeout(900);
    const flyer = await page.evaluate(() => {
      const modal = document.getElementById('flyerModal');
      const dialog = modal?.querySelector('.flyer-dialog');
      const close = modal?.querySelector('.flyer-close');
      if (!modal || modal.hidden || !dialog || !close) return null;
      const d = dialog.getBoundingClientRect();
      const c = close.getBoundingClientRect();
      return {
        dialogLeft: Math.round(d.left),
        dialogRight: Math.round(d.right),
        closeLeft: Math.round(c.left),
        closeRight: Math.round(c.right),
      };
    });
    if (!flyer) {
      fail(`${label}: flyer did not auto-open for geometry check`);
    } else {
      const rightGap = Math.abs(flyer.dialogRight - flyer.closeRight);
      if (rightGap > 24) {
        fail(`${label}: flyer close is not aligned to flyer right edge (gap=${rightGap}px, closeRight=${flyer.closeRight}, dialogRight=${flyer.dialogRight})`);
      }
      if (flyer.closeLeft < flyer.dialogLeft - 2) {
        fail(`${label}: flyer close sits left of flyer dialog`);
      }
    }
  }

  // sample screenshot path for debugging on fail (always write small set)
  const shotDir = join(ROOT, 'test-results/layout');
  await page.screenshot({
    path: join(shotDir, `${vp.name}${path.replace(/\W+/g, '_') || '_home'}.png`),
    fullPage: false,
  }).catch(() => {});
}

async function main() {
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(ROOT, 'test-results/layout'), { recursive: true });

  let server = null;
  let base = EXTERNAL.replace(/\/$/, '');
  if (!base) {
    server = await startStaticServer();
    base = `http://127.0.0.1:${PORT}`;
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log('Layout regression test');
  console.log('======================');
  console.log(`Base: ${base}`);

  try {
    for (const vp of VIEWPORTS) {
      for (const path of PAGES) {
        process.stdout.write(`  ${vp.name} ${path} ... `);
        const before = errors.length;
        await measurePage(page, base, path, vp);
        console.log(errors.length === before ? 'ok' : 'FAIL');
      }
    }
  } finally {
    await browser.close();
    if (server) await new Promise((r) => server.close(r));
  }

  const soft = process.env.STRICT !== '1' && process.env.SOFT !== '0';
  if (errors.length) {
    console.log(`\n${soft ? 'ISSUES' : 'FAIL'} (${errors.length}):`);
    for (const e of errors) console.log(`  - ${e}`);
    if (soft) {
      console.log('\nSOFT — grobe Patzer gemeldet, Build läuft weiter (STRICT=1 für Hard-Fail).');
      process.exit(0);
    }
    process.exit(1);
  }
  console.log('\nPASS — no overflow, logo visible, header intact (desktop + mobile).');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

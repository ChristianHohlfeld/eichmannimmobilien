#!/usr/bin/env node
/**
 * (Former) A/B hero test → now: test ENDED (2026-10-10). Guards that nothing of it remains.
 * Original header: A/B hero test → GA4 delivery (hermetic: gtag.js is stubbed, no real GA hits).
 * Guards the bug where ab_assign / cta_click never reached GA4:
 *  - no AB event without Analytics consent
 *  - ab_assign queued before consent, sent once after "Alle akzeptieren" (with variant)
 *  - returning visitor (consent stored): ab_assign sent although ab script runs before analytics.js
 *  - cta_click sent on the home page (before navigation) with variant
 *  - downstream events (flyer_open etc.) carry ab_variant
 * Run: node scripts/test-ab-ga4.mjs
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PORT = Number(process.env.AB_TEST_PORT || 8767);
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json' };

const GTAG_STUB = `(function(){var dl=window.dataLayer=window.dataLayer||[];
function clean(p){var o={};Object.keys(p||{}).forEach(function(k){if(typeof p[k]!=='function')o[k]=p[k];});return o;}
function handle(a){if(!a||a[0]!=='event')return;var p=a[2]||{};window.__recordHit({name:a[1],params:clean(p),path:location.pathname});
if(typeof p.event_callback==='function')setTimeout(p.event_callback,20);}
for(var i=0;i<dl.length;i++)handle(dl[i]);var push=dl.push;dl.push=function(){for(var j=0;j<arguments.length;j++)handle(arguments[j]);return push.apply(dl,arguments);};})();`;

const errors = [];
const fail = (m) => errors.push(m);

const server = createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = join(ROOT, p.replace(/^\//, ''));
  if (!f.startsWith(ROOT) || !existsSync(f) || !statSync(f).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[extname(f).toLowerCase()] || 'application/octet-stream' });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const base = `http://127.0.0.1:${PORT}`;

const browser = await chromium.launch();
async function newCtx() {
  const ctx = await browser.newContext();
  const hits = [];
  await ctx.exposeBinding('__recordHit', (_src, h) => hits.push(h));
  await ctx.route(/googletagmanager\.com\/gtag\/js/, (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: GTAG_STUB }));
  await ctx.route(/google-analytics\.com|googletagmanager\.com\/(?!gtag)/, (r) => r.abort());
  // keep the flyer auto-open out of the way
  await ctx.addInitScript(() => { try { sessionStorage.setItem('eichmann_flyer_shown_v1', '1'); } catch (e) {} });
  return { ctx, hits };
}
const named = (hits, n) => hits.filter((h) => h.name === n);

try {
  // 1) Mobile home: single static hero, Anrufen first, no ab_assign / ab_variant even with stale storage + stale queue
  {
    const { ctx, hits } = await newCtx();
    await ctx.addInitScript(() => {
      localStorage.setItem('ab_hero_cta_r1', 'B');
      localStorage.setItem('eichmann_cookie_consent_v1', JSON.stringify({ necessary: true, analytics: true, ts: Date.now() }));
      window.__eichmannTrackQueue = [{ name: 'ab_assign', params: { experiment: 'hero_cta_r1', variant: 'B' } }];
    });
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base + '/', { waitUntil: 'load' });
    await page.waitForTimeout(1500);
    const hero = await page.evaluate(() => {
      const h = document.querySelector('.hero');
      const call = h.querySelector('.hero-actions a[href^="tel:"]');
      const vorm = h.querySelector('.hero-actions .hero-cta-vormerken');
      return {
        h1: h.querySelector('h1').textContent.trim(),
        big: (h.querySelector('.hero-title') || {}).textContent,
        text: h.innerText,
        abEl: !!document.querySelector('[data-ab-hero-cta], [data-ab-variant]'),
        abScript: !!document.querySelector('script[src*="ab-hero-cta"]'),
        callX: call && call.getBoundingClientRect().left,
        vormX: vorm && vorm.getBoundingClientRect().left,
        callTop: call && call.getBoundingClientRect().top,
        vormTop: vorm && vorm.getBoundingClientRect().top,
        callLabel: call && call.textContent.trim(),
        vormLabel: vorm && vorm.textContent.trim(),
      };
    });
    if (hero.h1 !== 'Immobilienmakler Konstanz · Bodensee') fail(`hero h1 wrong: ${hero.h1}`);
    if ((hero.big || '').trim() !== 'Neubau Allmannsdorf – jetzt provisionsfrei vormerken') fail(`hero title wrong: ${hero.big}`);
    if (hero.abEl || hero.abScript) fail('A/B markup or script still on the home page');
    if (hero.callLabel !== 'Anrufen' || hero.vormLabel !== 'Vormerken') fail(`hero CTA labels wrong: ${hero.callLabel} / ${hero.vormLabel}`);
    if (!(hero.callX < hero.vormX) || Math.abs(hero.callTop - hero.vormTop) > 2) fail(`mobile: Anrufen must be first, side by side (${hero.callX}/${hero.vormX}, ${hero.callTop}/${hero.vormTop})`);
    if (/\b44\b|m²|Seeblick|Seesicht|Bauantrag|Baubeginn|Genehmigung/.test(hero.text)) fail(`hero contains forbidden claims: ${hero.text}`);
    if (named(hits, 'ab_assign').length || named(hits, 'cta_click').length) fail('ab_assign/cta_click still sent');
    for (const h of hits) if (h.params.ab_variant) fail(`${h.name} still carries ab_variant=${h.params.ab_variant}`);
    await ctx.close();
  }
  // 2) Desktop: Vormerken first, no sticky bar, click_phone device_hint=desktop
  {
    const { ctx, hits } = await newCtx();
    await ctx.addInitScript(() => localStorage.setItem('eichmann_cookie_consent_v1', JSON.stringify({ necessary: true, analytics: true, ts: Date.now() })));
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(base + '/', { waitUntil: 'load' });
    await page.waitForTimeout(1200);
    const d = await page.evaluate(() => {
      const h = document.querySelector('.hero');
      const call = h.querySelector('.hero-actions a[href^="tel:"]').getBoundingClientRect();
      const vorm = h.querySelector('.hero-actions .hero-cta-vormerken').getBoundingClientRect();
      return { vormFirst: vorm.left < call.left, sameRow: Math.abs(vorm.top - call.top) < 2, sticky: getComputedStyle(document.querySelector('.sticky-bar')).display };
    });
    if (!d.vormFirst || !d.sameRow) fail(`desktop: Vormerken must be first, side by side ${JSON.stringify(d)}`);
    if (d.sticky !== 'none') fail(`desktop: sticky bar must be hidden (display=${d.sticky})`);
    await page.evaluate(() => document.addEventListener('click', (e) => { if (e.target.closest('a[href^="tel:"]')) e.preventDefault(); }, true));
    await page.click('.hero .hero-actions a[href^="tel:"]');
    await page.waitForTimeout(300);
    const c = named(hits, 'click_phone');
    if (c.length !== 1 || c[0].params.device_hint !== 'desktop' || c[0].params.location !== 'hero') fail(`desktop click_phone wrong: ${JSON.stringify(c)}`);
    await ctx.close();
  }
  // 3) "Nur notwendige": never any event
  {
    const { ctx, hits } = await newCtx();
    const page = await ctx.newPage();
    await page.goto(base + '/', { waitUntil: 'load' });
    await page.click('[data-cookie="necessary"]');
    await page.waitForTimeout(1000);
    if (hits.length) fail(`events without consent: ${hits.map((h) => h.name).join(',')}`);
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}

if (errors.length) {
  console.error('Hero (ended A/B) test FAILED:\n - ' + errors.join('\n - '));
  process.exit(1);
}
console.log('Hero test OK: A/B ended (no ab_assign/ab_variant), static hero Anrufen+Vormerken (mobile call first, desktop Vormerken first), no desktop sticky, click_phone device_hint');

#!/usr/bin/env node
/**
 * A/B hero test → GA4 delivery (hermetic: gtag.js is stubbed, no real GA hits).
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
  // 1) First visit: nothing before consent, ab_assign after consent, cta_click before navigation
  {
    const { ctx, hits } = await newCtx();
    const page = await ctx.newPage();
    await page.goto(base + '/', { waitUntil: 'load' });
    await page.waitForTimeout(800);
    if (hits.length) fail(`events before consent: ${hits.map((h) => h.name).join(',')}`);
    const variant = await page.getAttribute('[data-ab-hero-cta]', 'data-ab-variant');
    if (!/^[ABC]$/.test(variant || '')) fail(`no variant applied (${variant})`);
    await page.click('[data-cookie="all"]');
    await page.waitForTimeout(1500);
    const assigns = named(hits, 'ab_assign');
    if (assigns.length !== 1) fail(`expected 1 ab_assign after consent, got ${assigns.length}`);
    else if (assigns[0].params.variant !== variant || assigns[0].params.experiment !== 'hero_cta_r1') fail(`ab_assign params wrong: ${JSON.stringify(assigns[0].params)}`);
    await Promise.all([page.waitForURL(/allmannsdorf\.html\?ab=hero_cta_r1_/, { timeout: 5000 }), page.click('[data-ab-hero-cta]')]);
    const clicks = named(hits, 'cta_click');
    if (clicks.length !== 1) fail(`expected 1 cta_click, got ${clicks.length}`);
    else {
      const p = clicks[0].params;
      if (p.variant !== variant || p.location !== 'hero' || p.ab_variant !== `hero_cta_r1_${variant}`) fail(`cta_click params wrong: ${JSON.stringify(p)}`);
      if (clicks[0].path !== '/' && clicks[0].path !== '/index.html') fail(`cta_click sent on wrong page ${clicks[0].path}`);
    }
    // downstream lead funnel on another page carries the variant (form_view on kontakt.html)
    await page.goto(base + '/kontakt.html?interesse=allmannsdorf', { waitUntil: 'load' });
    await page.waitForTimeout(1500);
    const downstream = hits.filter((h) => h.path.includes('kontakt'));
    if (!named(downstream, 'form_view').length) fail('no form_view on kontakt.html');
    for (const h of downstream) if (h.params.ab_variant !== `hero_cta_r1_${variant}`) fail(`${h.name} on kontakt lacks ab_variant`);
    // reload home in same session: no second ab_assign
    await page.goto(base + '/', { waitUntil: 'load' });
    await page.waitForTimeout(1500);
    if (named(hits, 'ab_assign').length !== 1) fail('ab_assign fired twice in one session');
    await ctx.close();
  }
  // 2) "Nur notwendige": never any event
  {
    const { ctx, hits } = await newCtx();
    const page = await ctx.newPage();
    await page.goto(base + '/', { waitUntil: 'load' });
    await page.click('[data-cookie="necessary"]');
    await page.waitForTimeout(1200);
    await Promise.all([page.waitForURL(/allmannsdorf/, { timeout: 5000 }), page.click('[data-ab-hero-cta]')]);
    await page.waitForTimeout(800);
    if (hits.length) fail(`events without consent: ${hits.map((h) => h.name).join(',')}`);
    await ctx.close();
  }
  // 3) Returning visitor with stored consent: ab_assign still sent (ab script runs before analytics.js)
  {
    const { ctx, hits } = await newCtx();
    await ctx.addInitScript(() => localStorage.setItem('eichmann_cookie_consent_v1', JSON.stringify({ necessary: true, analytics: true, ts: Date.now() })));
    const page = await ctx.newPage();
    await page.goto(base + '/', { waitUntil: 'load' });
    await page.waitForTimeout(1500);
    if (named(hits, 'ab_assign').length !== 1) fail(`returning visitor: expected 1 ab_assign, got ${named(hits, 'ab_assign').length}`);
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}

if (errors.length) {
  console.error('A/B GA4 test FAILED:\n - ' + errors.join('\n - '));
  process.exit(1);
}
console.log('A/B GA4 test OK: consent-gated ab_assign (queued + once/session), cta_click with variant, ab_variant on downstream events');

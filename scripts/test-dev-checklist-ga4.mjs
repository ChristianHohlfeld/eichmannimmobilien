#!/usr/bin/env node
/**
 * GA4 developer checklist (hermetic: gtag.js stubbed, form gateway mocked, no real hits / mails).
 *  - click_phone on tel: links (consent-gated, ab_variant, location=sticky for the sticky bar, beacon)
 *  - click_whatsapp from the floating WhatsApp button carries location=sticky
 *  - generate_lead ONLY after a confirmed successful submit (not on click, not on server error)
 *  - short contact form: Name + Telefon suffice, E-Mail/Nachricht optional behind "Mehr Angaben"
 *  - mobile: Anrufen (sticky bar) + WhatsApp visible at 390px
 * Run: node scripts/test-dev-checklist-ga4.mjs
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PORT = Number(process.env.DEVCHECK_TEST_PORT || 8768);
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json' };
const GTAG_STUB = `(function(){var dl=window.dataLayer=window.dataLayer||[];
function clean(p){var o={};Object.keys(p||{}).forEach(function(k){if(typeof p[k]!=='function')o[k]=p[k];});return o;}
function handle(a){if(!a||a[0]!=='event')return;window.__recordHit({name:a[1],params:clean(a[2]||{}),path:location.pathname});}
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

async function newCtx({ consent = true, mobile = true, formStatus = 200 } = {}) {
  const ctx = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 800 } });
  const hits = [];
  const posts = [];
  await ctx.exposeBinding('__recordHit', (_s, h) => hits.push(h));
  await ctx.route(/googletagmanager\.com\/gtag\/js/, (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: GTAG_STUB }));
  await ctx.route(/google-analytics\.com|googletagmanager\.com\/(?!gtag)/, (r) => r.abort());
  await ctx.route(/forms\.digitalisierungsplanung\.de/, (r) => {
    posts.push(JSON.parse(r.request().postData() || '{}'));
    r.fulfill({ status: formStatus, contentType: 'application/json', body: JSON.stringify(formStatus === 200 ? { success: true } : { success: false }) });
  });
  await ctx.addInitScript(({ consent }) => {
    try { sessionStorage.setItem('eichmann_flyer_shown_v1', '1'); } catch (e) {}
    try { localStorage.setItem('ab_hero_cta_r1', 'A'); } catch (e) {}
    if (consent) localStorage.setItem('eichmann_cookie_consent_v1', JSON.stringify({ necessary: true, analytics: true, ts: Date.now() }));
    // keep tel:/wa.me clicks inside the test page (tracking listeners still run)
    window.addEventListener('click', (e) => {
      const a = e.target && e.target.closest && e.target.closest('a[href^="tel:"], a[href*="wa.me/"]');
      if (a) e.preventDefault();
    }, true);
  }, { consent });
  return { ctx, hits, posts };
}
const named = (hits, n) => hits.filter((h) => h.name === n);

try {
  // 1) click_phone + click_whatsapp from the mobile sticky elements (consent granted)
  {
    const { ctx, hits } = await newCtx();
    const page = await ctx.newPage();
    await page.goto(base + '/allmannsdorf.html', { waitUntil: 'load' });
    await page.waitForTimeout(800);
    const vis = await page.evaluate(() => {
      const v = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.bottom <= innerHeight + 1 && r.top >= 0; };
      return { tel: v(document.querySelector('.sticky-bar a[href^="tel:"]')), wa: v(document.querySelector('.floating-wa')) };
    });
    if (!vis.tel) fail('mobile: sticky Anrufen (tel:) not visible at 390px');
    if (!vis.wa) fail('mobile: floating WhatsApp not visible at 390px');
    await page.click('.sticky-bar a[href^="tel:"]');
    await page.click('.floating-wa');
    await page.locator('main a[href^="tel:"]:visible').first().click();
    await page.waitForTimeout(300);
    const calls = named(hits, 'click_phone');
    if (calls.length !== 2) fail(`expected 2 click_phone, got ${calls.length}`);
    else {
      const p = calls[0].params;
      if (p.location !== 'sticky') fail(`click_phone sticky location wrong: ${p.location}`);
      if (p.ab_variant !== 'hero_cta_r1_A') fail(`click_phone lacks ab_variant: ${JSON.stringify(p)}`);
      if (!/allmannsdorf/.test(p.page_path || '')) fail(`click_phone lacks page_path: ${p.page_path}`);
      if (p.transport_type !== 'beacon') fail('click_phone must use beacon transport');
      if (p.phone_target !== '+491705225568') fail(`click_phone phone_target wrong: ${p.phone_target}`);
      if (calls[1].params.location !== 'content') fail(`in-content tel location wrong: ${calls[1].params.location}`);
    }
    const wa = named(hits, 'click_whatsapp');
    if (wa.length !== 1 || wa[0].params.location !== 'sticky') fail(`click_whatsapp from floating button wrong: ${JSON.stringify(wa)}`);
    if (named(hits, 'click_call').length) fail('legacy click_call should be replaced by click_phone');
    await ctx.close();
  }
  // 2) No consent → no click_phone
  {
    const { ctx, hits } = await newCtx({ consent: false });
    const page = await ctx.newPage();
    await page.goto(base + '/kontakt.html', { waitUntil: 'load' });
    await page.waitForTimeout(600);
    await page.locator('main a[href^="tel:"]:visible').first().click();
    await page.waitForTimeout(300);
    if (hits.length) fail(`events without consent: ${hits.map((h) => h.name).join(',')}`);
    await ctx.close();
  }
  // 3) Short form: Name + Telefon → success → generate_lead (once, after success)
  {
    const { ctx, hits, posts } = await newCtx();
    const page = await ctx.newPage();
    await page.goto(base + '/kontakt.html?interesse=allmannsdorf', { waitUntil: 'load' });
    await page.waitForTimeout(800);
    const shape = await page.evaluate(() => {
      const f = document.getElementById('contact-form');
      const req = [...f.querySelectorAll('[required]')].map((el) => el.name).sort();
      const email = f.querySelector('[name="email"]');
      return { req, emailVisible: !!(email && email.checkVisibility()), hasMore: !!f.querySelector('details.form-more'), backend: [...f.querySelectorAll('[name]')].map((e) => e.name) };
    });
    if (JSON.stringify(shape.req) !== JSON.stringify(['name', 'phone'])) fail(`required fields should be name+phone, got ${shape.req}`);
    if (!shape.hasMore) fail('missing "Mehr Angaben (optional)" toggle');
    if (shape.emailVisible) fail('e-mail should be collapsed by default');
    for (const n of ['name', 'phone', 'anliegen', 'email', 'message']) if (!shape.backend.includes(n)) fail(`field ${n} removed from form`);
    // empty submit: invalid, no lead
    await page.click('#contact-submit');
    await page.waitForTimeout(300);
    if (named(hits, 'generate_lead').length) fail('generate_lead fired on invalid submit');
    await page.fill('#name', 'Test Kurzformular');
    await page.fill('#phone', '+49 170 0000000');
    await page.click('#contact-submit');
    await page.waitForSelector('#form-success:not([hidden])', { timeout: 5000 });
    await page.waitForTimeout(300);
    const leads = named(hits, 'generate_lead');
    if (leads.length !== 1) fail(`expected 1 generate_lead, got ${leads.length}`);
    else {
      const p = leads[0].params;
      if (p.form_id !== 'contact-form' || p.form_type !== 'contact') fail(`generate_lead form params wrong: ${JSON.stringify(p)}`);
      if (p.ab_variant !== 'hero_cta_r1_A') fail('generate_lead lacks ab_variant');
      if (p.anliegen !== 'vormerkung_allmannsdorf') fail(`generate_lead anliegen should reflect sent form: ${p.anliegen}`);
      for (const k of Object.keys(p)) if (/^(name|phone|email|message)$/.test(k)) fail(`PII key in generate_lead: ${k}`);
    }
    if (!named(hits, 'form_submit_success').length) fail('form_submit_success missing');
    if (!named(hits, 'vormerken_submit').length) fail('vormerken_submit missing');
    const order = hits.map((h) => h.name);
    if (order.indexOf('generate_lead') < order.indexOf('form_submit_success')) fail('generate_lead must follow form_submit_success');
    if (posts.length !== 1 || posts[0].phone !== '+49 170 0000000' || posts[0].email !== '') fail(`gateway payload unexpected: ${JSON.stringify(posts[0])}`);
    await ctx.close();
  }
  // 4) Server error → no generate_lead
  {
    const { ctx, hits } = await newCtx({ formStatus: 500 });
    const page = await ctx.newPage();
    await page.goto(base + '/kontakt.html', { waitUntil: 'load' });
    await page.fill('#name', 'Test');
    await page.fill('#phone', '0123');
    await page.click('#contact-submit');
    await page.waitForSelector('#form-error:not([hidden])', { timeout: 5000 });
    await page.waitForTimeout(300);
    if (named(hits, 'generate_lead').length) fail('generate_lead fired on server error');
    await ctx.close();
  }
  // 5) Widerruf keeps e-mail + message required and visible
  {
    const { ctx } = await newCtx();
    const page = await ctx.newPage();
    await page.goto(base + '/kontakt.html?interesse=widerruf', { waitUntil: 'load' });
    await page.waitForTimeout(400);
    const w = await page.evaluate(() => ({ open: document.querySelector('details.form-more').open, req: [...document.querySelectorAll('#contact-form [required]')].map((e) => e.name).sort() }));
    if (!w.open || JSON.stringify(w.req) !== JSON.stringify(['email', 'message', 'name', 'phone'])) fail(`widerruf form state wrong: ${JSON.stringify(w)}`);
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}

if (errors.length) {
  console.error('Dev-checklist GA4 test FAILED:\n - ' + errors.join('\n - '));
  process.exit(1);
}
console.log('Dev-checklist GA4 test OK: click_phone/click_whatsapp (sticky, ab_variant, consent-gated), generate_lead only on confirmed success, short form name+phone');

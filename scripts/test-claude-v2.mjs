#!/usr/bin/env node
/** Claude v2 website part A (hermetic: gtag stubbed, forms mocked – no GA4 hits, no mails). */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PORT = Number(process.env.CLAUDEV2_TEST_PORT || 8772);
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json' };
const GTAG_STUB = `(function(){var dl=window.dataLayer=window.dataLayer||[];
function clean(p){var o={};Object.keys(p||{}).forEach(function(k){if(typeof p[k]!=='function')o[k]=p[k];});return o;}
function handle(a){if(!a||a[0]!=='event')return;window.__recordHit({name:a[1],params:clean(a[2]||{}),path:location.pathname});}
for(var i=0;i<dl.length;i++)handle(dl[i]);var push=dl.push;dl.push=function(){for(var j=0;j<arguments.length;j++)handle(arguments[j]);return push.apply(dl,arguments);};})();`;

const errors = [];
const fail = (m) => errors.push(m);
const server = createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
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
const FORBIDDEN_EN = /construction (start|begins)|Bauantrag|Baubeginn|Genehmigung|planning permission|building permit|countdown|days left|only \d+ left/i; // Chris 10.10.: nur harte Regeln

async function submitVormerk(page, sel, { name = 'Test Vormerk', phone = '+41 79 000 00 00' } = {}) {
  await page.fill(`${sel} [name="name"]`, name);
  await page.fill(`${sel} [name="phone"]`, phone);
  await page.click(`${sel} button[type="submit"]`);
}
function checkLead(hits, { location, lang, label }) {
  const leads = named(hits, 'generate_lead');
  if (leads.length !== 1) { fail(`${label}: expected exactly 1 generate_lead, got ${leads.length}`); return; }
  const p = leads[0].params;
  if (p.form_type !== 'vormerken' || p.location !== location || p.lang !== lang) fail(`${label}: generate_lead params ${JSON.stringify(p)}`);
  for (const k of Object.keys(p)) if (/^(name|phone|email|message)$/.test(k)) fail(`${label}: PII in generate_lead (${k})`);
  if (named(hits, 'vormerken_submit').length !== 1) fail(`${label}: vormerken_submit should fire once on success`);
}

try {
  // 1) Home hero form (desktop): right column, lead once, lang=de
  {
    const { ctx, hits, posts } = await newCtx({ mobile: false });
    const page = await ctx.newPage();
    await page.goto(base + '/', { waitUntil: 'load' });
    await page.waitForTimeout(600);
    const geo = await page.evaluate(() => {
      const f = document.getElementById('vormerk-hero').getBoundingClientRect();
      const c = document.querySelector('.hero-copy').getBoundingClientRect();
      const req = [...document.querySelectorAll('#vormerk-hero [required]')].map((e) => e.name).sort();
      return { right: f.left > c.left + c.width * 0.6, top: f.top < innerHeight, req, h1: document.querySelector('h1').textContent.trim(), h1s: document.querySelectorAll('h1').length };
    });
    if (!geo.right || !geo.top) fail(`home desktop: hero form should sit in the right hero half ${JSON.stringify(geo)}`);
    if (JSON.stringify(geo.req) !== '["name","phone"]') fail(`home hero form required ${geo.req}`);
    if (geo.h1s !== 1 || geo.h1 !== 'Immobilienmakler Konstanz · Bodensee') fail(`home h1: ${geo.h1s}× ${geo.h1}`);
    await page.click('#vormerk-hero button[type="submit"]');
    await page.waitForTimeout(200);
    if (posts.length || named(hits, 'generate_lead').length) fail('home hero: empty submit must not post/lead');
    await submitVormerk(page, '#vormerk-hero');
    await page.waitForSelector('#vormerk-hero .vormerk-success:not([hidden])', { timeout: 5000 });
    await page.waitForTimeout(300);
    checkLead(hits, { location: 'home_hero', lang: 'de', label: 'home hero' });
    if (posts.length !== 1 || posts[0].anliegen !== 'Vormerkung Neubau Allmannsdorf' || posts[0].lang !== 'de' || posts[0].phone !== '+41 79 000 00 00') fail(`home hero payload ${JSON.stringify(posts[0])}`);
    await ctx.close();
  }
  // 2) Flyer modal form (mobile)
  {
    const { ctx, hits, posts } = await newCtx({ mobile: true });
    const page = await ctx.newPage();
    await page.goto(base + '/kontakt.html', { waitUntil: 'load' });
    await page.waitForTimeout(500);
    await page.evaluate(() => document.querySelector('[data-open-flyer]') ? document.querySelector('[data-open-flyer]').click() : null);
    await page.waitForTimeout(400);
    const open = await page.evaluate(() => !document.getElementById('flyerModal').hidden);
    if (!open) fail('flyer modal did not open');
    await page.locator('#vormerk-flyer [name="name"]').scrollIntoViewIfNeeded();
    await submitVormerk(page, '#vormerk-flyer');
    await page.waitForSelector('#vormerk-flyer .vormerk-success:not([hidden])', { timeout: 5000 });
    await page.waitForTimeout(300);
    checkLead(hits, { location: 'flyer_modal', lang: 'de', label: 'flyer modal' });
    if (posts.length !== 1) fail(`flyer: expected 1 post, got ${posts.length}`);
    await ctx.close();
  }
  // 3) allmannsdorf.html: Anrufen first, inline form; server error → no lead
  {
    const { ctx, hits } = await newCtx({ mobile: true, formStatus: 500 });
    const page = await ctx.newPage();
    await page.goto(base + '/allmannsdorf.html', { waitUntil: 'load' });
    await page.waitForTimeout(500);
    const first = await page.evaluate(() => {
      const a = document.querySelector('.page-hero .hero-actions a');
      return { href: a.getAttribute('href'), text: a.textContent.trim(), flyerBtn: !!document.querySelector('.page-hero .hero-actions [data-open-flyer]'), inline: !!document.getElementById('vormerk-projekt') };
    });
    if (first.href !== 'tel:+491705225568' || first.text !== 'Jetzt anrufen 0170 522 5568') fail(`allmannsdorf hero first CTA ${JSON.stringify(first)}`);
    if (first.flyerBtn) fail('allmannsdorf hero: Flyer öffnen should be a text link, not a button');
    if (!first.inline) fail('allmannsdorf: inline vormerk form missing');
    await submitVormerk(page, '#vormerk-projekt');
    await page.waitForSelector('#vormerk-projekt .vormerk-error:not([hidden])', { timeout: 5000 });
    await page.waitForTimeout(300);
    if (named(hits, 'generate_lead').length || named(hits, 'vormerken_submit').length) fail('allmannsdorf: lead/vormerken_submit fired on server error');
    if (!named(hits, 'form_submit_error').length) fail('allmannsdorf: form_submit_error missing');
    await ctx.close();
  }
  {
    const { ctx, hits } = await newCtx({ mobile: false });
    const page = await ctx.newPage();
    await page.goto(base + '/allmannsdorf.html', { waitUntil: 'load' });
    await page.waitForTimeout(400);
    await submitVormerk(page, '#vormerk-projekt');
    await page.waitForSelector('#vormerk-projekt .vormerk-success:not([hidden])', { timeout: 5000 });
    await page.waitForTimeout(300);
    checkLead(hits, { location: 'project_inline', lang: 'de', label: 'allmannsdorf inline' });
    await ctx.close();
  }
  // 4) Property page: Exposé short form, Helmut block, teaser, WhatsApp per property
  {
    const { ctx, hits, posts } = await newCtx({ mobile: true });
    const page = await ctx.newPage();
    const slug = readdirSync(join(ROOT, 'objekt')).filter((f) => f.endsWith('.html'))[0];
    await page.goto(base + '/objekt/' + slug, { waitUntil: 'load' });
    await page.waitForTimeout(500);
    const info = await page.evaluate(() => {
      const f = document.getElementById('contact-form');
      const title = f.dataset.exposeTitle;
      const wa = [...document.querySelectorAll('.sticky-bar a[href*="wa.me/491705225568"], a.expose-wa')].map((a) => decodeURIComponent(a.getAttribute('href')));
      return {
        req: [...f.querySelectorAll('[required]')].map((e) => e.name).sort(),
        emailHidden: !f.querySelector('[name="email"]').checkVisibility(),
        helmut: (document.getElementById('ansprechpartner') || {}).innerText || '',
        helmutImg: !!document.querySelector('#ansprechpartner img'),
        teaser: (document.querySelector('a.allmannsdorf-teaser') || {}).getAttribute ? document.querySelector('a.allmannsdorf-teaser').getAttribute('href') : '',
        waOk: wa.length >= 2 && wa.every((h) => h.includes(title)),
        ld: [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent).join(''),
      };
    });
    if (JSON.stringify(info.req) !== '["name","phone"]') fail(`exposé required ${info.req}`);
    if (!info.emailHidden) fail('exposé: optional fields should be collapsed');
    for (const n of ['Helmut Eichmann', '+49 170 522 5568', '+49 7531 9228848', 'info@immobilien-eichmann.com']) if (!info.helmut.includes(n)) fail(`Helmut block missing ${n}`);
    if (info.helmutImg) fail('Helmut block must not contain an image (no real photo)');
    if (!/allmannsdorf\.html$/.test(info.teaser)) fail(`teaser link ${info.teaser}`);
    if (!info.waOk) fail('WhatsApp links on property page must be prefilled with the property title');
    if (/InStock/.test(info.ld)) fail('property JSON-LD still has InStock');
    await page.fill('#name', 'Exposé Kurz');
    await page.fill('#phone', '+49 170 1111111');
    await page.click('#contact-submit');
    await page.waitForSelector('#form-success:not([hidden])', { timeout: 5000 });
    await page.waitForTimeout(300);
    const leads = named(hits, 'generate_lead');
    if (leads.length !== 1 || leads[0].params.form_type !== 'expose' || leads[0].params.lang !== 'de') fail(`exposé generate_lead ${JSON.stringify(leads)}`);
    if (posts.length !== 1 || posts[0].email !== '' || posts[0].phone !== '+49 170 1111111' || !posts[0].objekt_url) fail(`exposé payload ${JSON.stringify(posts[0])}`);
    await ctx.close();
  }
  // 5) /en/ home + allmannsdorf vormerk (lang=en) and /en/contact.html (lang=en)
  {
    const { ctx, hits, posts } = await newCtx({ mobile: true });
    const page = await ctx.newPage();
    await page.goto(base + '/en/', { waitUntil: 'load' });
    await page.waitForTimeout(500);
    const banner = await page.evaluate(() => (document.getElementById('cookie-banner') || {}).innerText || '');
    await submitVormerk(page, '#vormerk-hero-en');
    await page.waitForSelector('#vormerk-hero-en .vormerk-success:not([hidden])', { timeout: 5000 });
    await page.waitForTimeout(300);
    checkLead(hits, { location: 'home_hero', lang: 'en', label: '/en/ home' });
    if (posts[0]?.lang !== 'en') fail(`/en/ payload lang ${posts[0]?.lang}`);
    hits.length = 0; posts.length = 0;
    await page.goto(base + '/en/allmannsdorf.html', { waitUntil: 'load' });
    await page.waitForTimeout(400);
    await submitVormerk(page, '#vormerk-projekt-en');
    await page.waitForSelector('#vormerk-projekt-en .vormerk-success:not([hidden])', { timeout: 5000 });
    await page.waitForTimeout(300);
    checkLead(hits, { location: 'project_inline', lang: 'en', label: '/en/allmannsdorf' });
    hits.length = 0; posts.length = 0;
    await page.goto(base + '/en/contact.html?interesse=allmannsdorf', { waitUntil: 'load' });
    await page.waitForTimeout(500);
    await page.fill('#name', 'Jane Test');
    await page.fill('#phone', '+41 79 123 45 67');
    await page.click('#contact-submit');
    await page.waitForSelector('#form-success:not([hidden])', { timeout: 5000 });
    await page.waitForTimeout(300);
    const leads = named(hits, 'generate_lead');
    if (leads.length !== 1 || leads[0].params.lang !== 'en' || leads[0].params.form_type !== 'contact') fail(`/en/contact generate_lead ${JSON.stringify(leads)}`);
    if (posts[0]?.lang !== 'en' || posts[0]?.anliegen !== 'Vormerkung Neubau Allmannsdorf') fail(`/en/contact payload ${JSON.stringify(posts[0])}`);
    await ctx.close();
    // consent banner in English (fresh context, no consent)
    const c2 = await newCtx({ consent: false });
    const p2 = await c2.ctx.newPage();
    await p2.goto(base + '/en/', { waitUntil: 'load' });
    await p2.waitForTimeout(300);
    const txt = await p2.evaluate(() => (document.getElementById('cookie-banner') || {}).innerText || '');
    if (!/Accept all/.test(txt) || /akzeptieren/.test(txt)) fail(`/en/ cookie banner not English: ${txt.slice(0, 80)}`);
    await c2.ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}

// 6) Static checks: EN wording rules, hreflang reciprocity, sitemap alternates, no InStock
const O = 'https://immobilieneichmann.de';
const pairs = [['index.html', 'en/index.html', '/', '/en/'], ['allmannsdorf.html', 'en/allmannsdorf.html', '/allmannsdorf.html', '/en/allmannsdorf.html'], ['kontakt.html', 'en/contact.html', '/kontakt.html', '/en/contact.html']];
const deText = pairs.map(([de]) => readFileSync(join(ROOT, de), 'utf8')).join(' ') + readFileSync(join(ROOT, 'data/projects.json'), 'utf8');
for (const [de, en, deP, enP] of pairs) {
  for (const f of [de, en]) {
    const s = readFileSync(join(ROOT, f), 'utf8');
    for (const [lang, href] of [['de', O + deP], ['en', O + enP], ['x-default', O + deP]]) {
      if (!s.includes(`<link rel="alternate" hreflang="${lang}" href="${href}">`)) fail(`${f}: hreflang ${lang} → ${href} missing`);
    }
    if (/http-equiv="refresh"|navigator\.language/.test(s)) fail(`${f}: language redirect`);
  }
  const s = readFileSync(join(ROOT, en), 'utf8');
  if (!/<html lang="en">/.test(s)) fail(`${en}: lang attr`);
  if (!s.includes(`<link rel="canonical" href="${O + enP}">`)) fail(`${en}: self canonical`);
  if (FORBIDDEN_EN.test(s.replace(/<a [^>]*hreflang="de"[^>]*>[^<]*<\/a>/g, ''))) fail(`${en}: forbidden wording: ${s.match(FORBIDDEN_EN)[0]}`);
  // numbers in EN visible text + JSON-LD must exist on the German site / project data
  const text = s.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<(?:link|meta|img|source|script(?![^>]*ld\+json))[^>]*>/g, '').replace(/href="[^"]*"|src(set)?="[^"]*"|width="\d+"|height="\d+"|\?v=[\w-]+/g, '');
  for (const m of text.matchAll(/\d[\d.,]*/g)) {
    const raw = m[0].replace(/[.,]$/, '');
    const digits = raw.replace(/[.,]/g, '');
    if (digits.length < 2 || /^(2026|1200|630|0)$/.test(digits)) continue;
    if (!deText.replace(/[.,\s]/g, '').includes(digits)) fail(`${en}: number ${raw} not found on the German site/flyer`);
  }
  for (const block of s.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try { JSON.parse(block[1]); } catch (e) { fail(`${en}: invalid JSON-LD`); }
  }
}
const sm = readFileSync(join(ROOT, 'sitemap.xml'), 'utf8');
if (!sm.includes('xmlns:xhtml="http://www.w3.org/1999/xhtml"')) fail('sitemap: xhtml namespace');
for (const [, , deP, enP] of pairs) for (const loc of [deP, enP]) {
  const re = new RegExp(`<url><loc>${(O + loc).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}</loc>.*?</url>`);
  const line = (sm.match(re) || [''])[0];
  if (!line.includes(`hreflang="en" href="${O + enP}"`) || !line.includes(`hreflang="x-default" href="${O + deP}"`)) fail(`sitemap: alternates for ${loc}`);
}
if (/InStock/.test(readFileSync(join(ROOT, 'allmannsdorf.html'), 'utf8'))) fail('allmannsdorf.html: InStock');

if (errors.length) {
  console.error('Claude-v2 website test FAILED:\n - ' + errors.join('\n - '));
  process.exit(1);
}
console.log('Claude-v2 website test OK: vormerk forms (home hero, flyer, allmannsdorf, /en/) → 1 generate_lead with lang; exposé Name+Telefon; Helmut block/teaser/WhatsApp; /en/ wording, hreflang, sitemap');

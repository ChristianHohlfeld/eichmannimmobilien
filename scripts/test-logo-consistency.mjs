#!/usr/bin/env node
/**
 * Logo consistency regression test for immobilieneichmann.de
 * Ensures one canonical logo version everywhere and blocks known break patterns.
 *
 * Run: node scripts/test-logo-consistency.mjs
 * Exit 0 = OK, 1 = FAIL
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = new URL('..', import.meta.url).pathname;
const errors = [];
const warnings = [];

function walkHtml(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules' || name === 'admin') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkHtml(p, out);
    else if (name.endsWith('.html')) out.push(p);
  }
  return out;
}

function fail(msg) {
  errors.push(msg);
}
function warn(msg) {
  warnings.push(msg);
}

// --- Assets present ---
const logoSvgPath = join(ROOT, 'assets/logo.svg');
const logoPngPath = join(ROOT, 'assets/logo.png');
const applePath = join(ROOT, 'assets/apple-touch-icon.png');
for (const [label, p] of [
  ['assets/logo.svg', logoSvgPath],
  ['assets/logo.png', logoPngPath],
  ['assets/apple-touch-icon.png', applePath],
]) {
  if (!existsSync(p)) fail(`Missing ${label}`);
}

const svg = existsSync(logoSvgPath) ? readFileSync(logoSvgPath, 'utf8') : '';
const png = existsSync(logoPngPath) ? readFileSync(logoPngPath) : null;

// Canonical version from SVG comment
const bustMatch = svg.match(/cache-bust:\s*([A-Za-z0-9._-]+)/);
if (!bustMatch) fail('assets/logo.svg missing <!-- cache-bust: VERSION -->');
const CANONICAL = bustMatch ? bustMatch[1] : null;

// Block Immowelt / broken patterns in SVG
if (/<image[\s>]/i.test(svg) || /xlink:href/i.test(svg)) {
  fail('assets/logo.svg must be own vector — no <image>/xlink Immowelt-PNG wrapper');
}
if (/immowelt-hq|logo-fix-readable|mms\./i.test(svg)) {
  fail('assets/logo.svg contains Immowelt/raster wrapper markers');
}
if (CANONICAL && /immowelt|readable/i.test(CANONICAL)) {
  fail(`Canonical cache-bust looks like banned Immowelt path: ${CANONICAL}`);
}

// PNG sanity: not tiny, RGB/RGBA
if (png) {
  if (png.length < 5000) fail(`assets/logo.png suspiciously small (${png.length} bytes)`);
  const hash = createHash('sha256').update(png).digest('hex').slice(0, 12);
  // store for report
  warnings.push(`logo.png sha256[:12]=${hash} size=${png.length}`);
}

// --- HTML consistency ---
const htmlFiles = walkHtml(ROOT);
const versionCounts = new Map();
const bareFiles = [];
const multiVersion = [];
const bannedHits = [];

const logoRefRe = /assets\/logo\.(png|svg)(\?v=([^"'>\s]+))?/g;
const bannedRe = /immowelt-hq|logo-fix-readable|crisp-v5-own|textLength=/i;

for (const file of htmlFiles) {
  const t = readFileSync(file, 'utf8');
  const rel = relative(ROOT, file);
  if (bannedRe.test(t) && /logo\.(png|svg)/i.test(t)) {
    // only fail if banned string appears near logo refs
    for (const m of t.matchAll(/assets\/logo\.[^"'\s]+/g)) {
      if (bannedRe.test(m[0])) bannedHits.push(`${rel}: ${m[0]}`);
    }
  }
  const versions = new Set();
  let m;
  const re = new RegExp(logoRefRe.source, 'g');
  while ((m = re.exec(t)) !== null) {
    const ver = m[3] || null;
    if (!ver) bareFiles.push(`${rel} → assets/logo.${m[1]} (missing ?v=)`);
    else {
      versions.add(ver);
      versionCounts.set(ver, (versionCounts.get(ver) || 0) + 1);
      if (CANONICAL && ver !== CANONICAL) {
        fail(`${rel}: logo ?v=${ver} ≠ canonical ${CANONICAL}`);
      }
    }
  }
  if (versions.size > 1) multiVersion.push(`${rel}: ${[...versions].join(', ')}`);
}

for (const b of bareFiles) fail(`Bare logo ref (no cache-bust): ${b}`);
for (const b of multiVersion) fail(`Multiple logo versions in one file: ${b}`);
for (const b of bannedHits) fail(`Banned logo ref: ${b}`);

if (CANONICAL && versionCounts.size === 0) {
  fail('No logo.?v= references found in HTML');
}
if (versionCounts.size > 1) {
  fail(`Site-wide multiple logo versions: ${[...versionCounts.entries()].map(([k, v]) => `${k}×${v}`).join(', ')}`);
}

// Prefer PNG for visible <img class="logo-svg">
for (const file of htmlFiles) {
  const t = readFileSync(file, 'utf8');
  const rel = relative(ROOT, file);
  const bad = [...t.matchAll(/class="logo-svg"[^>]*src="assets\/logo\.svg/g)];
  if (bad.length) {
    warn(`${rel}: header uses logo.svg in <img class="logo-svg"> — prefer logo.png for consistent raster`);
  }
}

// CSS flex fix must remain (prevents 0-width logo)
const cssPath = join(ROOT, 'css/styles.css');
if (!existsSync(cssPath)) fail('Missing css/styles.css');
else {
  const css = readFileSync(cssPath, 'utf8');
  if (!/logo-flex-fix-v1/.test(css)) fail('css/styles.css missing logo-flex-fix-v1 marker');
  if (!/\.logo\s*\{[^}]*flex:\s*0\s+0\s+auto/s.test(css) && !/flex:\s*0 0 auto/.test(css)) {
    fail('css/styles.css .logo must use flex: 0 0 auto (no flex-shrink collapse)');
  }
  // Dangerous pattern that zeroed the logo before
  const logoBlock = css.match(/\/\* logo-flex-fix-v1 \*\/[\s\S]{0,400}/);
  if (logoBlock && /min-width:\s*0/.test(logoBlock[0]) && /flex:\s*1\s+1\s+auto/.test(logoBlock[0])) {
    fail('css/styles.css logo-flex block reintroduced min-width:0 + flex:1 1 auto');
  }
}

// Report
console.log('Logo consistency test');
console.log('=====================');
console.log(`Canonical version: ${CANONICAL || '(none)'}`);
console.log(`HTML files scanned: ${htmlFiles.length}`);
console.log(`Version counts: ${[...versionCounts.entries()].map(([k, v]) => `${k}=${v}`).join(', ') || '(none)'}`);
for (const w of warnings) console.log(`WARN: ${w}`);
if (errors.length) {
  console.log(`\nFAIL (${errors.length}):`);
  for (const e of errors) console.log(`  - ${e}`);
  process.exit(1);
}
console.log('\nPASS — logo refs consistent, no Immowelt wrapper, flex fix present.');
process.exit(0);

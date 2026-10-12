#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'https://immobilieneichmann.de';
const sitemap = readFileSync(path.join(root, 'sitemap.xml'), 'utf8');
const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
if (!urls.length || new Set(urls).size !== urls.length) throw new Error('Empty or duplicate sitemap');
for (const url of urls) {
  const u = new URL(url);
  if (u.origin !== origin || u.search || u.hash) throw new Error(`Non-canonical sitemap URL: ${url}`);
  const rel = u.pathname.endsWith('/') ? u.pathname + 'index.html' : u.pathname;
  const file = path.join(root, rel.slice(1));
  if (!existsSync(file)) throw new Error(`Missing sitemap page: ${url}`);
  const html = readFileSync(file, 'utf8');
  const tags = [...html.matchAll(/<(?:link|meta)\b[^>]*>/gi)].map(m => m[0]);
  const attr = (tag, key) => tag.match(new RegExp(`\\b${key}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1];
  const canonicals = tags.filter(t => attr(t, 'rel')?.toLowerCase() === 'canonical').map(t => attr(t, 'href'));
  if (canonicals.length !== 1 || canonicals[0] !== url) throw new Error(`Wrong canonical: ${url}`);
  if (tags.some(t => /^(robots|googlebot)$/i.test(attr(t, 'name') || '') && /\b(noindex|none)\b/i.test(attr(t, 'content') || ''))) throw new Error(`Sitemap page excluded: ${url}`);
  if (tags.some(t => /^refresh$/i.test(attr(t, 'http-equiv') || ''))) throw new Error(`Redirect in sitemap: ${url}`);
}
const robots = readFileSync(path.join(root, 'robots.txt'), 'utf8');
if (!robots.includes(`Sitemap: ${origin}/sitemap.xml`)) throw new Error('Sitemap discovery missing');
console.log(`Indexing OK: ${urls.length} existing, indexable, self-canonical sitemap pages`);

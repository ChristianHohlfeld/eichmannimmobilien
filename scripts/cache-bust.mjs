#!/usr/bin/env node
// Ersetzt feste ?v=-Kennungen lokaler CSS/JS/Bilder durch einen Inhalts-Hash (8 Zeichen).
// Nach einer Änderung an css/js bekommen wiederkehrende Besucher sofort die neue Datei.
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const root = path.resolve(process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname), ".."));
const hashCache = new Map();
function hashOf(rel) {
  if (hashCache.has(rel)) return hashCache.get(rel);
  const fp = path.join(root, rel);
  const h = existsSync(fp) ? createHash("sha256").update(readFileSync(fp)).digest("hex").slice(0, 8) : null;
  hashCache.set(rel, h);
  return h;
}
const RE = /((?:href|src|srcset|data-flyer-src)=["'])((?:\.\.\/|\/)?((?:css|js|assets|partials)\/[^"'?#\s]+))\?v=[^"'\s]*/g;
let changed = 0;
for (const d of ["partials", "", "en", "objekt"]) {
  const dir = path.join(root, d);
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir)) {
    const fp = path.join(dir, f);
    if (!f.endsWith(".html") || !statSync(fp).isFile()) continue;
    const s = readFileSync(fp, "utf8");
    const out = s.replace(RE, (m, pre, url, rel) => { const h = hashOf(rel); return h ? `${pre}${url}?v=${h}` : m; });
    if (out !== s) { writeFileSync(fp, out); changed++; }
  }
}
console.log(`cache-bust: ${changed} Seiten aktualisiert (?v=<sha256-8>)`);

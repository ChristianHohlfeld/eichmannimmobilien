#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import sharp from 'sharp';

const root = new URL('../', import.meta.url);
const source = await readFile(new URL('assets/share-card-source-plain-v2.jpg', root));
const imagePath = new URL('assets/share-card-plain-v2.jpg', root);
const url = 'https://immobilieneichmann.de/assets/share-card-plain-v2.jpg';
const bytes = await readFile(imagePath);
const meta = await sharp(bytes).metadata();

assert.equal(meta.width, 1200);
assert.equal(meta.height, 630);
assert.equal(meta.format, 'jpeg');
assert.ok(bytes.length < 300000, 'Keep previews small enough for messaging clients');
assert.deepEqual(bytes, source, 'Share card must be the approved property image without overlays');

let checked = 0;
for (const name of await readdir(root)) {
  if (!name.endsWith('.html')) continue;
  const html = await readFile(new URL(name, root), 'utf8');
  for (const tag of ['og:image', 'twitter:image']) {
    const matches = [...html.matchAll(new RegExp(`<meta (?:property|name)="${tag}" content="([^"]+)"`, 'g'))];
    assert.equal(matches.length, 1, `${name}: exactly one ${tag}`);
    assert.equal(matches[0][1], url, `${name}: current ${tag}`);
  }
  checked++;
}
const generator = await readFile(new URL('scripts/sync-immowelt.mjs', root), 'utf8');
assert.ok(generator.includes('/assets/share-card-plain-v2.jpg'), 'Generated listing fallback must use current card');
for (const legacy of ['assets/share-card-house-orig-v1.jpg', 'assets/share-card.jpg']) {
  assert.deepEqual(await readFile(new URL(legacy, root)), bytes, `${legacy}: legacy URL must match current card`);
}
console.log(`Share card OK: approved plain property image, 1200×630, ${bytes.length} bytes, ${checked} pages + listing fallback.`);

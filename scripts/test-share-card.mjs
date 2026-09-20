#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import sharp from 'sharp';

const root = new URL('../', import.meta.url);
const imagePath = new URL('assets/share-card-house-orig-v1.jpg', root);
const url = 'https://immobilieneichmann.de/assets/share-card-house-orig-v1.jpg';
const bytes = await readFile(imagePath);
const meta = await sharp(bytes).metadata();
assert.equal(meta.width, 1200);
assert.equal(meta.height, 630);
assert.equal(meta.format, 'jpeg');
assert.ok(bytes.length < 300000, 'Keep previews small enough for messaging clients');

// Compare the entire logo region with the canonical header asset, allowing JPEG loss.
const { data: expected, info } = await sharp(await readFile(new URL('assets/logo.png', root)))
  .resize({ width: 960 }).flatten({ background: '#fff' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const actual = await sharp(bytes).extract({ left: 120, top: 126, width: info.width, height: info.height })
  .removeAlpha().raw().toBuffer();
let difference = 0;
for (let i = 0; i < actual.length; i++) difference += Math.abs(actual[i] - expected[i]);
assert.ok(difference / actual.length < 5, 'Share card must contain the current, complete header logo');

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
assert.ok(generator.includes('/assets/share-card-house-orig-v1.jpg'), 'Generated listing fallback must use the current card');
assert.deepEqual(await readFile(new URL('assets/share-card.jpg', root)), bytes, 'Legacy image URL must also be fixed');
console.log(`Share card OK: canonical logo, 1200×630, ${bytes.length} bytes, ${checked} pages + listing fallback.`);

#!/usr/bin/env node
// Social preview = the approved property image only. No generated text, logo or overlays.
import { copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const asset = (name) => fileURLToPath(new URL(`../assets/${name}`, import.meta.url));
const source = asset('share-card-source-plain-v2.jpg');

for (const target of [
  'share-card-plain-v2.jpg',
  'share-card-house-orig-v1.jpg',
  'share-card.jpg',
]) {
  await copyFile(source, asset(target));
}
console.log('Rendered 1200×630 plain share card from approved property image.');

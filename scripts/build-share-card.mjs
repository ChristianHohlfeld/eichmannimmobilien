#!/usr/bin/env node
// Render the social card from the same canonical PNG used in the site header.
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';

const asset = (name) => fileURLToPath(new URL(`../assets/${name}`, import.meta.url));
const frame = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
  <rect width="1200" height="630" fill="#102743"/>
  <rect width="13" height="630" fill="#d2ab45"/>
  <rect x="72" y="100" width="1056" height="245" rx="4" fill="white"/>
  <g font-family="Arial, Helvetica, sans-serif">
    <text x="72" y="428" font-size="44" font-weight="700" fill="white">Immobilien persönlich vermitteln</text>
    <text x="72" y="478" font-size="28" fill="#d2ab45">Konstanz · Bodensee</text>
    <text x="72" y="567" font-size="23" fill="white">immobilieneichmann.de</text>
  </g>
</svg>`);
const logo = await sharp(asset('logo.png')).resize({ width: 960 }).png().toBuffer();
const card = await sharp(frame).composite([{ input: logo, left: 120, top: 126 }])
  .jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer();
// Keep the legacy URL correct too; the filename in metadata busts preview caches.
await sharp(card).toFile(asset('share-card-house-orig-v1.jpg'));
await sharp(card).toFile(asset('share-card.jpg'));
console.log('Rendered 1200×630 share card from assets/logo.png.');

#!/usr/bin/env node
import sharp from "sharp";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const asset = (name) => fileURLToPath(new URL(`../assets/${name}`, import.meta.url));
const SOURCE_URL = "https://mms.immowelt.de/8/d/d/e/8dde84a1-a61f-45a6-a793-4cb1b97d11d5.png?ci_seal=c0c1540c513d620e246e8aeb1f10293e242bca09";

const res = await fetch(SOURCE_URL, {
  headers: {
    "User-Agent": "Mozilla/5.0 (compatible; ImmobilienEichmannShareCard/1.0)",
    "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
  }
});
if (!res.ok) throw new Error(`Share source download failed: ${res.status} ${res.statusText}`);
const raw = Buffer.from(await res.arrayBuffer());
if (raw.length < 10000) throw new Error(`Share source unexpectedly small: ${raw.length} bytes`);

const card = await sharp(raw)
  .resize(1200, 630, { fit: "cover", position: "centre" })
  .jpeg({ quality: 82, chromaSubsampling: "4:4:4" })
  .toBuffer();

for (const name of [
  "share-card-source-plain-v2.jpg",
  "share-card-plain-v2.jpg",
  "share-card-house-orig-v1.jpg",
  "share-card.jpg"
]) {
  await writeFile(asset(name), card);
}
console.log(`Wrote plain 1200x630 share image (${card.length} bytes), no added text or overlay.`);

#!/usr/bin/env node
/**
 * Regeneriert AI-Discovery aus data/listings.json (gleiche Filterlogik wie Website).
 * Wird auch aus sync-immowelt renderIntoPages aufgerufen.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeAiDiscoveryArtifacts, DEFAULT_SITE_ORIGIN } from "./lib/ai-discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const siteRoot = process.env.EICHMANN_SITE_ROOT || root;
const dataPath = path.join(siteRoot, "data", "listings.json");

const raw = await fs.readFile(dataPath, "utf8");
const data = JSON.parse(raw);
const { aiDoc, paths } = await writeAiDiscoveryArtifacts(data, {
  siteRoot,
  origin: process.env.EICHMANN_SITE_ORIGIN || DEFAULT_SITE_ORIGIN,
});
console.log(
  `AI index: ${aiDoc.listing_count} öffentliche Objekte → ${paths.length} Dateien (siteRoot=${siteRoot})`
);
for (const p of paths) console.log(`  ${path.relative(siteRoot, p)}`);

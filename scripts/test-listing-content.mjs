#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const data = JSON.parse(await readFile(path.join(ROOT, "data/listings.json"), "utf8"));
const listings = Array.isArray(data) ? data : data.listings || [];

function flat(value) { return String(value || "").replace(/\s+/g, " ").trim(); }

function repeatedStartIndex(value) {
  const text = flat(value);
  if (text.length >= 120) {
    const probe = text.slice(0, Math.min(96, Math.floor(text.length / 2))).trim();
    if (probe.length >= 60) {
      const second = text.indexOf(probe, probe.length);
      if (second >= 70 && text.length - second >= second * 0.65) return second;
    }
  }

  const tokens = [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({
    word: m[0].toLowerCase(),
    index: m.index,
  }));
  if (tokens.length < 18) return -1;

  const n = Math.min(12, Math.max(8, Math.floor(tokens.length / 15)));
  for (let j = n; j <= tokens.length - n; j++) {
    if (tokens[j].index < 70) continue;
    let same = true;
    for (let k = 0; k < n; k++) {
      if (tokens[k].word !== tokens[j + k].word) {
        same = false;
        break;
      }
    }
    if (same && (tokens.length - j) >= j * 0.7) return tokens[j].index;
  }
  return -1;
}

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function fingerprint(value) {
  const words = (flat(value).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(Boolean);
  const hashes = new Set();
  for (let i = 0; i <= words.length - 3; i++) {
    hashes.add(fnv1a(words.slice(i, i + 3).join(" ")));
  }
  return [...hashes].sort().slice(0, 64);
}

function overlapRatio(expected, actual) {
  if (!expected.length) return 1;
  const actualSet = new Set(actual);
  return expected.filter((hash) => actualSet.has(hash)).length / expected.length;
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function wordSet(value) {
  return new Set(
    (flat(value).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
      .filter((word) => word.length >= 4)
  );
}

const problems = [];
let checked = 0;

// Loose mirror regression gate: exact published count, rough object mapping.
// This intentionally avoids brittle full-text equality. Immowelt remains the SoT;
// the rendered site only needs to represent the same set of current objects.
const expectedPublic = listings.filter(
  (item) => item.active !== false && item.site_hidden !== true
);
if (Number.isFinite(Number(data.listing_count)) && Number(data.listing_count) !== listings.length) {
  problems.push(`listing_count mismatch: metadata ${data.listing_count}, actual ${listings.length}`);
}
if (
  Number.isFinite(Number(data.active_listing_count)) &&
  Number(data.active_listing_count) !== expectedPublic.length
) {
  problems.push(
    `active_listing_count mismatch: metadata ${data.active_listing_count}, actual ${expectedPublic.length}`
  );
}

const gridHtml = await readFile(path.join(ROOT, "partials/listings-grid.html"), "utf8");
const renderedCardCount = (gridHtml.match(/<(?:a|article) class="listing-card\b/g) || []).length;
if (renderedCardCount !== expectedPublic.length) {
  problems.push(
    `published card count mismatch: expected ${expectedPublic.length}, rendered ${renderedCardCount}`
  );
}

const mappedObjects = expectedPublic.filter((item) => {
  const localUrl = String(item.local_url || "");
  if (!localUrl || !gridHtml.includes(localUrl)) return false;
  const id = String(item.immowelt_id || item.id || "").toLowerCase();
  const exposeUrl = String(item.expose_url || "").toLowerCase();
  return !id || exposeUrl.includes(id);
}).length;
const mappedRatio = expectedPublic.length ? mappedObjects / expectedPublic.length : 1;
if (mappedRatio < 0.8) {
  problems.push(
    `published objects only roughly map to Immowelt mirror (${mappedObjects}/${expectedPublic.length})`
  );
}

for (const item of listings) {
  if (item.active === false || item.site_hidden === true || item.detail_page === false) continue;
  checked++;

  const description = String(item.description || "").trim();
  if (description.length < 80) problems.push(`${item.slug}: description too short`);
  if (repeatedStartIndex(description) >= 0) problems.push(`${item.slug}: repeated description block`);

  for (const field of ["location_description", "additional_information"]) {
    const value = String(item[field] || "").trim();
    if (value && repeatedStartIndex(value) >= 0) {
      problems.push(`${item.slug}: repeated ${field}`);
    }
  }

  // The last successful source sync stores a compact 3-word-shingle
  // fingerprint. This verifies rough source parity without making CI depend
  // on Immowelt/DataDome being reachable on every run.
  const sourceFingerprint = Array.isArray(item.source_description_fingerprint)
    ? item.source_description_fingerprint
    : [];
  if (
    sourceFingerprint.length >= 12 &&
    overlapRatio(sourceFingerprint, fingerprint(description)) < 0.62
  ) {
    problems.push(`${item.slug}: description drifted too far from the last Immowelt source fingerprint`);
  }

  const exposeId = String(item.immowelt_id || item.id || "").toLowerCase();
  const exposeUrl = String(item.expose_url || "").toLowerCase();
  if (exposeId && !exposeUrl.includes(exposeId)) {
    problems.push(`${item.slug}: expose_url does not match Immowelt id`);
  }

  const html = await readFile(path.join(ROOT, item.local_url), "utf8");
  const match = html.match(
    /<h2>Objektbeschreibung<\/h2>\s*<div class="expose-description prose">([\s\S]*?)<\/div>/
  );
  if (!match) {
    problems.push(`${item.slug}: rendered description section missing`);
    continue;
  }

  const rendered = decodeHtml(match[1]);
  if (repeatedStartIndex(rendered) >= 0) {
    problems.push(`${item.slug}: rendered description is duplicated`);
  }

  const expectedWords = wordSet(description);
  const renderedWords = wordSet(rendered);
  let overlap = 0;
  for (const word of expectedWords) {
    if (renderedWords.has(word)) overlap++;
  }
  const ratio = expectedWords.size ? overlap / expectedWords.size : 1;
  if (ratio < 0.82) {
    problems.push(
      `${item.slug}: rendered text only roughly matches canonical source (${Math.round(ratio * 100)}%)`
    );
  }
}

if (problems.length) {
  console.error("Listing content integrity failed:\n" + problems.join("\n"));
  process.exit(1);
}

assert.ok(checked > 0, "expected at least one public detailed listing");
console.log(
  `Listing content OK: ${checked} exposés; source fingerprint parity + duplicate guard passed.`
);

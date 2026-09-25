#!/usr/bin/env node
/**
 * Upsert/delete origin=eigen listings in SQLite SoT, then publish.
 *
 *   node scripts/eigen-upsert.mjs --file payload.json
 *   node scripts/eigen-upsert.mjs --delete <id>
 *   node scripts/eigen-upsert.mjs --list
 *   node scripts/eigen-upsert.mjs --file payload.json --skip-publish
 *
 * payload.json: { "action": "upsert"|"delete", "listing": { ... } }
 * or a bare listing object for upsert.
 */
import fs from "node:fs";
import path from "node:path";
import {
  openDb,
  resolveDbPath,
  upsertEigenListing,
  deleteEigenListing,
  listByOrigin,
  getListingById,
  exportListingsDocument,
  allSlugs,
  ORIGIN_EIGEN,
  REPO_ROOT,
} from "./lib/db.mjs";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : null;
};

const skipPublish = has("--skip-publish");
const siteRoot = process.env.EICHMANN_SITE_ROOT
  ? path.resolve(process.env.EICHMANN_SITE_ROOT)
  : REPO_ROOT;
process.env.EICHMANN_SITE_ROOT = siteRoot;

const db = openDb(resolveDbPath());

async function maybePublish() {
  if (skipPublish) return;
  const doc = exportListingsDocument(db);
  const slugs = allSlugs(db);
  const { publishSiteFromDocument } = await import("./lib/publish.mjs");
  await publishSiteFromDocument(doc, { siteRoot, knownSlugs: slugs });
  console.log("Published after eigen change.");
}

if (has("--list")) {
  const rows = listByOrigin(db, ORIGIN_EIGEN);
  console.log(JSON.stringify({ count: rows.length, listings: rows }, null, 2));
  db.close();
  process.exit(0);
}

if (has("--delete")) {
  const id = val("--delete");
  if (!id) {
    console.error("Missing id for --delete");
    process.exit(1);
  }
  console.log(JSON.stringify(deleteEigenListing(db, id)));
  await maybePublish();
  db.close();
  process.exit(0);
}

let raw;
if (has("--file")) {
  raw = fs.readFileSync(path.resolve(val("--file")), "utf8");
} else if (has("--stdin")) {
  raw = fs.readFileSync(0, "utf8");
} else {
  console.error("Usage: --file payload.json | --stdin | --delete <id> | --list");
  process.exit(1);
}

const payload = JSON.parse(raw);
const action = payload.action || "upsert";
const listing = payload.listing || payload;

if (action === "delete" || listing._delete) {
  console.log(JSON.stringify(deleteEigenListing(db, listing.id)));
} else {
  const result = upsertEigenListing(db, listing);
  const saved = getListingById(db, result.id);
  console.log(JSON.stringify({ ...result, listing: saved }, null, 2));
}

await maybePublish();
db.close();

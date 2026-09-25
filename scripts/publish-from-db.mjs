#!/usr/bin/env node
import path from "node:path";
import {
  openDb,
  resolveDbPath,
  exportListingsDocument,
  allSlugs,
  REPO_ROOT,
} from "./lib/db.mjs";

const siteRoot = process.env.EICHMANN_SITE_ROOT
  ? path.resolve(process.env.EICHMANN_SITE_ROOT)
  : REPO_ROOT;
process.env.EICHMANN_SITE_ROOT = siteRoot;

const { publishSiteFromDocument } = await import("./lib/publish.mjs");

const dbPath = resolveDbPath();
const db = openDb(dbPath);
const doc = exportListingsDocument(db);
const slugs = allSlugs(db);
db.close();

console.log(`Publishing ${doc.listing_count} listings from ${dbPath} → ${siteRoot}`);
await publishSiteFromDocument(doc, { siteRoot, knownSlugs: slugs });
console.log("Publish complete.");

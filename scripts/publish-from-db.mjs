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

// A call of this script is a deliberate publish ("manual"; the backup restore passes "restore").
const reason = /^[a-z-]{2,20}$/.test(process.env.EICHMANN_PUBLISH_REASON || "") ? process.env.EICHMANN_PUBLISH_REASON : "manual";
console.log(`Publishing ${doc.listing_count} listings from ${dbPath} → ${siteRoot}`);
await publishSiteFromDocument(doc, { siteRoot, knownSlugs: slugs, reason });
console.log("Publish complete.");

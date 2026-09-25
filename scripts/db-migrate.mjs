#!/usr/bin/env node
/**
 * Migrate + optional bootstrap of the Eichmann listings SQLite SoT.
 *
 * Usage:
 *   node scripts/db-migrate.mjs
 *   node scripts/db-migrate.mjs --bootstrap
 *   node scripts/db-migrate.mjs --bootstrap --json data/listings.json
 *   EICHMANN_DB_PATH=/var/lib/eichmann/listings.db node scripts/db-migrate.mjs --bootstrap
 */
import fs from "node:fs";
import path from "node:path";
import {
  openDb,
  resolveDbPath,
  bootstrapFromJson,
  countByOrigin,
  listAllListings,
  REPO_ROOT,
  DROPLET_DB_PATH,
} from "./lib/db.mjs";

const args = new Set(process.argv.slice(2));
const doBootstrap = args.has("--bootstrap");
const jsonIdx = process.argv.indexOf("--json");
const jsonPath =
  jsonIdx >= 0
    ? path.resolve(process.argv[jsonIdx + 1])
    : path.join(REPO_ROOT, "data", "listings.json");

const dbPath = resolveDbPath();
console.log(`DB path: ${dbPath}`);
if (dbPath === DROPLET_DB_PATH) {
  console.log("Using droplet SoT at /var/lib/eichmann/listings.db");
}

const db = openDb(dbPath);
console.log("Schema migrated.");

if (doBootstrap) {
  if (!fs.existsSync(jsonPath)) {
    console.error(`Bootstrap JSON not found: ${jsonPath}`);
    process.exit(1);
  }
  const doc = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const results = bootstrapFromJson(db, doc);
  const counts = countByOrigin(db);
  console.log(
    `Bootstrapped ${results.length} rows from ${jsonPath} (immowelt=${counts.immowelt}, eigen=${counts.eigen})`
  );
} else {
  const counts = countByOrigin(db);
  console.log(
    `Existing rows: immowelt=${counts.immowelt}, eigen=${counts.eigen}, total=${listAllListings(db).length}`
  );
}

db.close();
console.log("Done.");

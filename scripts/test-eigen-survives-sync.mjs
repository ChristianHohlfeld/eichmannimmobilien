#!/usr/bin/env node
/**
 * Prove origin=eigen rows survive an Immowelt-only SQLite upsert + publish.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  openDb,
  upsertEigenListing,
  upsertImmoweltBatch,
  listByOrigin,
  getListingById,
  ORIGIN_EIGEN,
  ORIGIN_IMMOWELT,
  bootstrapFromJson,
  exportListingsDocument,
  countByOrigin,
} from "./lib/db.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eichmann-eigen-"));
const dbPath = path.join(tmp, "listings.db");
process.env.EICHMANN_DB_PATH = dbPath;

const db = openDb(dbPath);
const seed = JSON.parse(fs.readFileSync(new URL("../data/listings.json", import.meta.url), "utf8"));
bootstrapFromJson(db, seed);

const eigen = {
  id: "eigen-test-survive-0001",
  slug: "eigen-test-survive-0001",
  local_url: "objekt/eigen-test-survive-0001.html",
  title: "Eigen-Test – darf Sync nicht löschen",
  price: "123.456 €",
  location: "Konstanz",
  status: "Kauf",
  short_description: "nur bei uns – Testobjekt",
  active: true,
  detail_page: true,
  site_hidden: false,
  origin: "eigen",
  source: "eigen",
};
upsertEigenListing(db, eigen);

const before = getListingById(db, eigen.id);
if (!before || before.origin !== ORIGIN_EIGEN) {
  throw new Error("Eigen seed failed");
}

const immowelt = listByOrigin(db, ORIGIN_IMMOWELT).map((L) => ({
  ...L,
  title: `${L.title} (synced)`,
}));
// Simulate sync seeing only a subset → deactivate missing Immowelt, keep eigen
const keep = immowelt.slice(0, Math.max(1, immowelt.length - 1));
upsertImmoweltBatch(db, keep, {
  deactivateMissing: true,
  keepImmoweltIds: keep.map((L) => L.immowelt_id || L.id),
});

const after = getListingById(db, eigen.id);
if (!after) throw new Error("FAIL: eigen row deleted by Immowelt upsert");
if (after.origin !== ORIGIN_EIGEN) throw new Error("FAIL: eigen origin changed");
if (after.title !== eigen.title) throw new Error("FAIL: eigen title clobbered");

const counts = countByOrigin(db);
const doc = exportListingsDocument(db);
const eigenInExport = doc.listings.filter((L) => L.origin === "eigen");
if (!eigenInExport.some((L) => L.id === eigen.id)) {
  throw new Error("FAIL: eigen missing from export document");
}

console.log(
  JSON.stringify(
    {
      ok: true,
      dbPath,
      counts,
      eigenSurvived: true,
      immoweltActive: listByOrigin(db, ORIGIN_IMMOWELT).filter((L) => L.active !== false).length,
      eigenCount: listByOrigin(db, ORIGIN_EIGEN).length,
    },
    null,
    2
  )
);
db.close();

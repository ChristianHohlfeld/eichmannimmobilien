/**
 * SQLite listings SoT for Immobilien Eichmann.
 *
 * Droplet path: /var/lib/eichmann/listings.db (NOT in docroot, NOT in git).
 * Local/dev default: <repo>/var/listings.db (gitignored).
 *
 * origin: 'immowelt' | 'eigen' (CHECK). 'immoscout' can be added later via migration.
 * Immowelt sync may ONLY upsert/deactivate origin=immowelt rows.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "../..");

export const DROPLET_DB_PATH = "/var/lib/eichmann/listings.db";
export const LOCAL_DB_PATH = path.join(REPO_ROOT, "var", "listings.db");

export const ORIGIN_IMMOWELT = "immowelt";
export const ORIGIN_EIGEN = "eigen";
/** Reserved for a future ImmoScout sync – do not use in writers yet. */
export const ORIGIN_IMMOSCOUT = "immoscout";

const ALLOWED_ORIGINS = new Set([ORIGIN_IMMOWELT, ORIGIN_EIGEN]);

export function resolveDbPath(explicit) {
  if (explicit) return explicit;
  if (process.env.EICHMANN_DB_PATH) return process.env.EICHMANN_DB_PATH;
  if (fs.existsSync(DROPLET_DB_PATH) || process.env.EICHMANN_USE_DROPLET_DB === "1") {
    return DROPLET_DB_PATH;
  }
  return LOCAL_DB_PATH;
}

export function openDb(dbPath = resolveDbPath()) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

export function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS listings (
      id TEXT PRIMARY KEY,
      origin TEXT NOT NULL CHECK (origin IN ('immowelt', 'eigen')),
      slug TEXT NOT NULL,
      title TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      site_hidden INTEGER NOT NULL DEFAULT 0,
      detail_page INTEGER NOT NULL DEFAULT 1,
      immowelt_id TEXT,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_listings_slug ON listings(slug);
    CREATE INDEX IF NOT EXISTS idx_listings_origin ON listings(origin);
    CREATE INDEX IF NOT EXISTS idx_listings_immowelt_id ON listings(immowelt_id);
    CREATE INDEX IF NOT EXISTS idx_listings_active ON listings(active);
  `);

  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  if (!row) {
    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run("1");
  }
}

function nowIso() {
  return new Date().toISOString();
}

function assertOrigin(origin) {
  if (!ALLOWED_ORIGINS.has(origin)) {
    throw new Error(`Invalid origin '${origin}' (allowed: immowelt|eigen; immoscout later)`);
  }
}

/** Normalize listing object → DB origin. */
export function listingOrigin(listing) {
  const raw = String(listing?.origin || listing?.source || "").toLowerCase();
  if (raw === ORIGIN_EIGEN || raw === "local" || raw === "eigen") return ORIGIN_EIGEN;
  if (raw === ORIGIN_IMMOSCOUT || raw === "immoscout") {
    throw new Error("origin=immoscout is reserved – ImmoScout sync is not implemented");
  }
  return ORIGIN_IMMOWELT;
}

/** Attach origin onto listing for public JSON/HTML (keeps source as alias). */
export function withOrigin(listing, origin = listingOrigin(listing)) {
  const out = { ...listing, origin };
  // Keep legacy source field for older admin readers; eigen never writes Immowelt JSON.
  out.source = origin === ORIGIN_EIGEN ? "eigen" : origin === ORIGIN_IMMOWELT ? "immowelt" : out.source;
  return out;
}

export function rowToListing(row) {
  const listing = JSON.parse(row.payload);
  listing.id = row.id;
  listing.slug = row.slug;
  listing.title = row.title ?? listing.title;
  listing.active = row.active === 1;
  listing.site_hidden = row.site_hidden === 1;
  listing.detail_page = row.detail_page !== 0;
  if (row.immowelt_id) listing.immowelt_id = row.immowelt_id;
  return withOrigin(listing, row.origin);
}

export function listingToRowFields(listing, { origin } = {}) {
  const orig = origin || listingOrigin(listing);
  assertOrigin(orig);
  const id = String(listing.id || "").trim();
  if (!id) throw new Error("listing.id required");
  const slug = String(listing.slug || "").trim();
  if (!slug) throw new Error(`listing.slug required for ${id}`);
  const normalized = withOrigin({ ...listing, id, slug }, orig);
  return {
    id,
    origin: orig,
    slug,
    title: normalized.title || null,
    active: normalized.active === false ? 0 : 1,
    site_hidden: normalized.site_hidden === true ? 1 : 0,
    detail_page: normalized.detail_page === false ? 0 : 1,
    immowelt_id: normalized.immowelt_id || (orig === ORIGIN_IMMOWELT ? id : null),
    payload: JSON.stringify(normalized),
  };
}

export function getListingById(db, id) {
  const row = db.prepare("SELECT * FROM listings WHERE id = ?").get(id);
  return row ? rowToListing(row) : null;
}

export function getListingBySlug(db, slug) {
  const row = db.prepare("SELECT * FROM listings WHERE slug = ?").get(slug);
  return row ? rowToListing(row) : null;
}

export function listAllListings(db) {
  return db
    .prepare("SELECT * FROM listings ORDER BY origin ASC, title COLLATE NOCASE ASC")
    .all()
    .map(rowToListing);
}

export function listByOrigin(db, origin) {
  assertOrigin(origin);
  return db
    .prepare("SELECT * FROM listings WHERE origin = ? ORDER BY title COLLATE NOCASE ASC")
    .all(origin)
    .map(rowToListing);
}

export function listPublicListings(db) {
  return listAllListings(db).filter(
    (L) => L.active !== false && L.site_hidden !== true
  );
}

export function allSlugs(db) {
  return db.prepare("SELECT slug FROM listings").all().map((r) => r.slug);
}

/**
 * Upsert a single row. Immowelt writers must pass origin='immowelt'.
 * Eigen writers must pass origin='eigen'.
 * Refuses to change origin of an existing row (prevents Immowelt clobbering eigen).
 */
export function upsertListing(db, listing, { origin, allowOriginChange = false } = {}) {
  const fields = listingToRowFields(listing, { origin });
  const existing = db.prepare("SELECT id, origin FROM listings WHERE id = ?").get(fields.id);
  const ts = nowIso();

  if (existing) {
    if (existing.origin !== fields.origin && !allowOriginChange) {
      throw new Error(
        `Refusing to change origin of ${fields.id} from '${existing.origin}' to '${fields.origin}'`
      );
    }
    // Extra guard: Immowelt path must never touch eigen rows even by slug collision
    if (fields.origin === ORIGIN_IMMOWELT && existing.origin === ORIGIN_EIGEN) {
      throw new Error(`Immowelt upsert blocked: id ${fields.id} is origin=eigen`);
    }
    db.prepare(
      `UPDATE listings SET
        origin = ?, slug = ?, title = ?, active = ?, site_hidden = ?, detail_page = ?,
        immowelt_id = ?, payload = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      fields.origin,
      fields.slug,
      fields.title,
      fields.active,
      fields.site_hidden,
      fields.detail_page,
      fields.immowelt_id,
      fields.payload,
      ts,
      fields.id
    );
    return { id: fields.id, action: "updated", origin: fields.origin };
  }

  // Slug uniqueness: if another row owns the slug, fail clearly
  const slugOwner = db.prepare("SELECT id, origin FROM listings WHERE slug = ?").get(fields.slug);
  if (slugOwner && slugOwner.id !== fields.id) {
    throw new Error(
      `Slug '${fields.slug}' already owned by ${slugOwner.id} (origin=${slugOwner.origin})`
    );
  }

  db.prepare(
    `INSERT INTO listings (
      id, origin, slug, title, active, site_hidden, detail_page, immowelt_id, payload, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    fields.id,
    fields.origin,
    fields.slug,
    fields.title,
    fields.active,
    fields.site_hidden,
    fields.detail_page,
    fields.immowelt_id,
    fields.payload,
    ts,
    ts
  );
  return { id: fields.id, action: "inserted", origin: fields.origin };
}

/**
 * Immowelt-only batch upsert. Never deletes. Never touches origin=eigen.
 * Deactivates Immowelt rows whose immowelt_id is not in keepImmoweltIds
 * when deactivateMissing is true.
 */
export function upsertImmoweltBatch(db, listings, { deactivateMissing = false, keepImmoweltIds = null } = {}) {
  const upsertMany = db.transaction((items) => {
    const results = [];
    for (const raw of items) {
      const listing = withOrigin(raw, ORIGIN_IMMOWELT);
      // Skip if an eigen row already owns this id
      const existing = db.prepare("SELECT origin FROM listings WHERE id = ?").get(listing.id);
      if (existing?.origin === ORIGIN_EIGEN) {
        results.push({ id: listing.id, action: "skipped_eigen", origin: ORIGIN_EIGEN });
        continue;
      }
      results.push(upsertListing(db, listing, { origin: ORIGIN_IMMOWELT }));
    }

    if (deactivateMissing) {
      const keep = new Set(
        (keepImmoweltIds || items.map((L) => L.immowelt_id || L.id))
          .filter(Boolean)
          .map((x) => String(x).toLowerCase())
      );
      const immoweltRows = db
        .prepare("SELECT * FROM listings WHERE origin = ?")
        .all(ORIGIN_IMMOWELT);
      for (const row of immoweltRows) {
        const key = String(row.immowelt_id || row.id).toLowerCase();
        if (keep.has(key)) continue;
        if (row.active === 0) continue;
        const listing = rowToListing(row);
        listing.active = false;
        listing.missing_on_immowelt = true;
        upsertListing(db, listing, { origin: ORIGIN_IMMOWELT });
        results.push({ id: row.id, action: "deactivated", origin: ORIGIN_IMMOWELT });
      }
    }
    return results;
  });
  return upsertMany(listings);
}

/** Full eigen upsert (create/update). Always origin=eigen. */
export function upsertEigenListing(db, listing) {
  const id = listing.id || cryptoRandomId();
  const withId = { ...listing, id, origin: ORIGIN_EIGEN, source: "eigen" };
  return upsertListing(db, withId, { origin: ORIGIN_EIGEN });
}

export function deleteEigenListing(db, id) {
  const row = db.prepare("SELECT origin FROM listings WHERE id = ?").get(id);
  if (!row) return { id, action: "missing" };
  if (row.origin !== ORIGIN_EIGEN) {
    throw new Error(`Refusing to delete non-eigen listing ${id} (origin=${row.origin})`);
  }
  db.prepare("DELETE FROM listings WHERE id = ? AND origin = 'eigen'").run(id);
  return { id, action: "deleted", origin: ORIGIN_EIGEN };
}

export function setSiteHidden(db, id, hidden) {
  const listing = getListingById(db, id);
  if (!listing) throw new Error(`Listing not found: ${id}`);
  listing.site_hidden = hidden === true;
  return upsertListing(db, listing, { origin: listingOrigin(listing) });
}

function cryptoRandomId() {
  return globalThis.crypto?.randomUUID?.() || `eigen-${Date.now().toString(16)}`;
}

/**
 * Export canonical public JSON document from DB (backup/export artifact, not SoT).
 */
export function exportListingsDocument(db, { profileUrl = null, scrapedAt = null } = {}) {
  const listings = listAllListings(db);
  const metaScraped =
    scrapedAt ||
    db.prepare("SELECT value FROM meta WHERE key = 'immowelt_scraped_at'").get()?.value ||
    null;
  const profile =
    profileUrl ||
    db.prepare("SELECT value FROM meta WHERE key = 'immowelt_profile'").get()?.value ||
    null;

  return {
    sot: "sqlite",
    source: profile,
    immowelt_profile: profile,
    scraped_at: metaScraped,
    listing_count: listings.length,
    active_listing_count: listings.filter((L) => L.active !== false && L.site_hidden !== true).length,
    listings,
  };
}

export function setMeta(db, key, value) {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, String(value));
}

export function getMeta(db, key) {
  return db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
}

/**
 * Bootstrap DB from an existing listings.json export.
 * Existing Immowelt rows → origin=immowelt; source local/eigen → origin=eigen.
 * Does not delete existing rows that are absent from the JSON.
 */
export function bootstrapFromJson(db, doc) {
  const listings = Array.isArray(doc?.listings) ? doc.listings : [];
  const results = [];
  const tx = db.transaction((items) => {
    for (const raw of items) {
      const origin = listingOrigin(raw);
      results.push(upsertListing(db, withOrigin(raw, origin), { origin }));
    }
    if (doc?.scraped_at) setMeta(db, "immowelt_scraped_at", doc.scraped_at);
    if (doc?.immowelt_profile || doc?.source) {
      setMeta(db, "immowelt_profile", doc.immowelt_profile || doc.source);
    }
    setMeta(db, "bootstrapped_at", nowIso());
  });
  tx(listings);
  return results;
}

export function countByOrigin(db) {
  const rows = db.prepare("SELECT origin, COUNT(*) AS n FROM listings GROUP BY origin").all();
  const out = { immowelt: 0, eigen: 0 };
  for (const r of rows) out[r.origin] = r.n;
  return out;
}

/**
 * A throw-away copy of the server layout for pipeline tests:
 *   <tmp>/state    = /var/lib/eichmann   (DB, releases, media, status, locks, secrets)
 *   <tmp>/www/site = /var/www/immobilieneichmann.de (symlink into releases once bootstrapped)
 * The app tree is this repository; Immowelt and its image host are replaced by fixtures.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../scripts/lib/immowelt/config.mjs";
import { openDb, bootstrapFromJson, upsertEigenListing } from "../../scripts/lib/db.mjs";
import { runSync, publishFromDatabase } from "../../scripts/lib/immowelt/pipeline.mjs";
import { copyProcessor } from "../../scripts/lib/immowelt/media.mjs";
import { releasePaths, currentReleaseId } from "../../scripts/lib/release.mjs";
import { fakeImmowelt } from "./builder.mjs";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const TEST_KEY = "TEST-KEY-must-never-be-logged-4711";

async function hasSharp() {
  try {
    await import("sharp");
    return true;
  } catch {
    return false;
  }
}

/** Scratch root for test layouts; EICHMANN_TEST_TMP may point to a directory that does not exist yet. */
export function testTmpRoot() {
  const root = process.env.EICHMANN_TEST_TMP || os.tmpdir();
  fs.mkdirSync(root, { recursive: true });
  return root;
}

export async function makeEnv({ appDir = REPO } = {}) {
  process.env.NODE_ENV = "test";
  const base = fs.mkdtempSync(path.join(testTmpRoot(), "eichmann-sync-"));
  const env = {
    ...process.env,
    EICHMANN_STATE_DIR: path.join(base, "state"),
    EICHMANN_APP_DIR: appDir,
    EICHMANN_DB_PATH: path.join(base, "state", "listings.db"),
    EICHMANN_WEBROOT: path.join(base, "www", "site"),
    EICHMANN_SMOKE_URL: "",
    EICHMANN_IDENTITY_MAP_FILE: path.join(base, "no-identity-map.json"), // tests state their own evidence
    IMMOWELT_EXPOSE_DELAY_MS: "0",
    IMMOWELT_SECRETS_FILE: path.join(base, "state", "secrets", "immowelt-api.json"),
    IMMOWELT_API_KEY: "",
  };
  const config = loadConfig(env);
  fs.mkdirSync(path.dirname(config.webroot), { recursive: true });
  fs.mkdirSync(config.stateDir, { recursive: true });
  const state = { offers: [], apiKey: TEST_KEY };
  const logs = [];
  const processor = (await hasSharp()) ? null : copyProcessor();
  let clock = new Date("2026-11-11T10:00:00.000Z");

  const api = {
    base, env, config, state, logs,
    get now() { return clock; },
    advance(minutes) { clock = new Date(clock.getTime() + minutes * 60000); return clock; },
    db() { return openDb(config.dbPath); },
    current() { return currentReleaseId(config); },
    site(rel = "") { return path.join(config.webroot, rel); },
    read(rel) { return fs.readFileSync(path.join(config.webroot, rel), "utf8"); },
    exists(rel) { return fs.existsSync(path.join(config.webroot, rel)); },
    status() { return JSON.parse(fs.readFileSync(config.statusFile, "utf8")); },
    /** Seed the database with the scraper-era rows the repo still carries, plus one own listing. */
    seedLegacy() {
      const db = openDb(config.dbPath);
      bootstrapFromJson(db, JSON.parse(fs.readFileSync(path.join(REPO, "data", "listings.json"), "utf8")));
      upsertEigenListing(db, { id: "eigen-0001", slug: "eigen-testobjekt-konstanz", title: "Eigenes Testobjekt (nur bei uns)", price: "450.000 €", location: "Konstanz (78462)", rooms: "3 Zimmer", living_area: "80 m²", type: "Wohnung", status: "Kauf", description: "Eigenes Inserat, das kein Immowelt-Abgleich anfassen darf. Dieser Text ist lang genug für eine Detailseite und bleibt unverändert.", active: true, detail_page: true });
      db.close();
    },
    /** First release from the database as it is + webroot symlink (what install-release-layout.sh does). */
    async bootstrapLayout() {
      const db = openDb(config.dbPath);
      try {
        const p = releasePaths(config);
        fs.mkdirSync(p.dir, { recursive: true });
        if (!fs.existsSync(config.webroot)) fs.symlinkSync(p.current, config.webroot);
        return await publishFromDatabase(config, { db, reason: "bootstrap", log: (m) => logs.push(m) });
      } finally {
        db.close();
      }
    },
    async run(opts = {}) {
      const fetchImpl = fakeImmowelt(state);
      return runSync({
        trigger: "test",
        env,
        ...opts,
        deps: { config, apiKey: TEST_KEY, fetchImpl, imageProcessor: processor || undefined, sleepImpl: async () => {}, now: () => clock, log: (m) => logs.push(String(m)), ...(opts.deps || {}) },
      });
    },
    cleanup() { fs.rmSync(base, { recursive: true, force: true }); },
  };
  return api;
}

/**
 * Shared publish: listings.json export (sot:sqlite) + HTML render from a listings document.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { REPO_ROOT } from "./db.mjs";

/**
 * @param {object} doc exportListingsDocument() result
 * @param {{ siteRoot?: string, knownSlugs?: string[] }} [opts]
 */
export async function publishSiteFromDocument(doc, opts = {}) {
  const siteRoot = opts.siteRoot || process.env.EICHMANN_SITE_ROOT || REPO_ROOT;
  process.env.EICHMANN_SITE_ROOT = siteRoot;

  const sync = await import("../sync-immowelt.mjs");
  if (typeof sync.publishListingsDocument !== "function") {
    throw new Error("sync-immowelt.mjs must export publishListingsDocument");
  }
  return sync.publishListingsDocument(doc, {
    siteRoot,
    knownSlugs: opts.knownSlugs,
  });
}

export async function writeListingsJsonExport(doc, siteRoot = REPO_ROOT) {
  const outPath = path.join(siteRoot, "data", "listings.json");
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const payload = {
    ...doc,
    sot: "sqlite",
    exported_at: new Date().toISOString(),
  };
  await fs.writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return outPath;
}

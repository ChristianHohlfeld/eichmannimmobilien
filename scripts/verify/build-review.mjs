#!/usr/bin/env node
/**
 * Builds the review page for the visual check: every page of the complete inventory with three
 * pictures side by side –  before (dt-1) · after (dt) · Immowelt (dt).
 *
 *   node scripts/verify/build-review.mjs [--root test-results/verify]
 *
 * Reads what capture-screens.mjs wrote below <root>/screens/:
 *   before/        website before the sync            (--label before)
 *   after/         website after the publish          (--label after)
 *   immowelt/      public Immowelt pages              (--label immowelt, own computer; or your own
 *                                                      screenshots as desktop/<online-id>.png)
 *   immowelt-api/  offers as delivered by the API     (--label immowelt-api)
 * and, if present, the data comparison <root>/inventory-after.json (inventory-report.mjs --json).
 * Missing parts are shown as missing – the page is built from whatever is there.
 * Output: <root>/review/index.html (open it in a browser; pictures are linked relatively).
 */
import fs from "node:fs";
import path from "node:path";
import { buildReviewHtml } from "./lib.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const root = path.resolve(opt("--root", "test-results/verify"));
const outDir = path.resolve(opt("--out", path.join(root, "review")));
const dirs = {
  before: path.resolve(opt("--before", path.join(root, "screens", "before"))),
  after: path.resolve(opt("--after", path.join(root, "screens", "after"))),
  immowelt: path.resolve(opt("--immowelt", path.join(root, "screens", "immowelt"))),
  immoweltApi: path.resolve(opt("--immowelt-api", path.join(root, "screens", "immowelt-api"))),
};
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
const manifests = Object.fromEntries(Object.entries(dirs).map(([k, dir]) => [k, readJson(path.join(dir, "manifest.json"))]));

/**
 * Screenshots of the public Immowelt pages that you took yourself can simply be dropped in as
 * <immowelt>/desktop/<online-id>.png|jpg (and mobile/…): they are used wherever no automatic
 * capture exists.
 */
function adoptOwnScreenshots(dir, manifest) {
  const pages = manifest?.pages ? [...manifest.pages] : [];
  const captured = new Set(pages.filter((p) => !p.blocked && p.files?.length).map((p) => `${p.viewport}:${p.key}`));
  for (const vp of ["desktop", "mobile"]) {
    let names = [];
    try {
      names = fs.readdirSync(path.join(dir, vp));
    } catch {
      continue;
    }
    for (const name of names) {
      const m = /^([a-z0-9]{5,12})\.(jpe?g|png|webp)$/i.exec(name);
      if (!m || captured.has(`${vp}:${m[1].toLowerCase()}`)) continue;
      const id = m[1].toLowerCase();
      const entry = { key: id, online_id: id, path: `/expose/${id}`, url: `https://www.immowelt.de/expose/${id}`, viewport: vp, files: [`${vp}/${name}`], http_status: 200, title: "eigene Aufnahme" };
      const at = pages.findIndex((p) => p.key === id && p.viewport === vp);
      if (at >= 0) pages[at] = entry;
      else pages.push(entry);
    }
  }
  return pages.length ? { ...(manifest || { label: "immowelt", kind: "immowelt-public", captured_at: null }), pages } : manifest;
}
manifests.immowelt = adoptOwnScreenshots(dirs.immowelt, manifests.immowelt);
if (!manifests.before && !manifests.after) {
  console.error(`Weder Vorher- noch Nachher-Aufnahmen gefunden unter ${path.join(root, "screens")}. Erst: node scripts/verify/capture-screens.mjs --label before|after`);
  process.exit(2);
}
const report = readJson(opt("--report", path.join(root, "inventory-after.json")));
const prefix = Object.fromEntries(Object.entries(dirs).map(([k, dir]) => [k, `${path.relative(outDir, dir).split(path.sep).join("/")}/`]));

fs.mkdirSync(outDir, { recursive: true });
const html = buildReviewHtml({ ...manifests, report, prefix });
fs.writeFileSync(path.join(outDir, "index.html"), html);

const n = (m) => (m ? new Set(m.pages.map((p) => p.key || p.path)).size : 0);
console.log(`Sichtprüfung geschrieben: ${path.join(outDir, "index.html")}`);
console.log(`  Vorher ${n(manifests.before)} Seiten · Nachher ${n(manifests.after)} Seiten · Immowelt öffentlich ${n(manifests.immowelt)} · Immowelt-API ${n(manifests.immoweltApi)} · Datenvergleich ${report ? (report.differences?.length ? `${report.differences.length} Abweichung(en)` : "ohne Abweichung") : "nicht vorhanden"}`);

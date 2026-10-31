/**
 * Flyer-Fenster „Neubau Allmannsdorf“ – ENTFERNT (31.10.2026, Wunsch Chris: Pop-up nie mehr zeigen).
 * Der Build entfernt jeden Rest: FLYER-MODAL-Block bzw. #flyerModal-Container in allen Seiten (DE, objekt/, en/)
 * und die alten Partials partials/flyer-modal(-en).html. Vormerken läuft über die Inline-Formulare
 * (allmannsdorf.html#vormerken, en/allmannsdorf.html#register, Start-Hero).
 */
import { readFile, writeFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

export const FLYER_START = "<!-- FLYER-MODAL:START (erzeugt aus data/sot, scripts/lib/flyer-modal.mjs) -->";
export const FLYER_END = "<!-- FLYER-MODAL:END -->";
export const FLYER_PARTIAL = "partials/flyer-modal.html";
export const FLYER_PARTIAL_EN = "partials/flyer-modal-en.html";

function findBlock(s) {
  const a0 = s.indexOf(FLYER_START);
  if (a0 >= 0) { const e = s.indexOf(FLYER_END, a0); if (e >= 0) return [a0, e + FLYER_END.length]; }
  const a = s.indexOf('<div class="flyer-overlay" id="flyerModal"');
  if (a < 0) return null;
  let depth = 0;
  const re = /<div\b|<\/div>/g; re.lastIndex = a;
  let m;
  while ((m = re.exec(s))) { depth += m[0] === "<div" ? 1 : -1; if (depth === 0) return [a, m.index + m[0].length]; }
  return null;
}

/** Remove the flyer modal block (incl. its line) from a page; returns the page unchanged if none. */
export function stripFlyerModal(s) {
  let out = s;
  for (let b = findBlock(out); b; b = findBlock(out)) {
    let [a, e] = b;
    while (a > 0 && (out[a - 1] === " " || out[a - 1] === "\t")) a--;
    if (out[e] === "\n") e++;
    out = out.slice(0, a).replace(/[ \t]*<!-- Allmannsdorf flyer[^\n]*-->\n$/, "") + out.slice(e);
  }
  return out;
}

/** Strip the flyer modal from every page and delete the old partials. */
export async function removeFlyerModal({ siteRoot, dryRun = false } = {}) {
  const files = [];
  for (const d of ["", "objekt", "en", "en/property"]) {
    let entries = [];
    try { entries = await readdir(path.join(siteRoot, d), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) if (e.isFile() && e.name.endsWith(".html")) files.push(path.join(d, e.name));
  }
  let changed = 0;
  for (const rel of files) {
    const fp = path.join(siteRoot, rel);
    const s = await readFile(fp, "utf8");
    const out = stripFlyerModal(s);
    if (out !== s) { changed++; if (!dryRun) await writeFile(fp, out, "utf8"); }
  }
  if (!dryRun) for (const p of [FLYER_PARTIAL, FLYER_PARTIAL_EN]) await rm(path.join(siteRoot, p), { force: true });
  return { pages: changed };
}

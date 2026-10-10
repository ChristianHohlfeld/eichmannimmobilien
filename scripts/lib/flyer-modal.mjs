/**
 * Flyer-Fenster „Neubau Allmannsdorf“ – EIN Template aus der SSOT (data/sot/projects.json + contact.json).
 * Ausgabe: partials/flyer-modal.html (wird beim ersten Öffnen per fetch geladen, js/main.js).
 * Seiten enthalten nur noch den leeren Container (FLYER-MODAL-Marker) → kein doppelter Inhalt in 16 Seiten.
 */
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import path from "node:path";
import { loadSot, projectTexts, projectFacts, formatFact } from "./sot.mjs";
import { vormerkFormHtml } from "./vormerk-form.mjs";

export const FLYER_START = "<!-- FLYER-MODAL:START (erzeugt aus data/sot, scripts/lib/flyer-modal.mjs) -->";
export const FLYER_END = "<!-- FLYER-MODAL:END -->";
export const FLYER_PARTIAL = "partials/flyer-modal.html";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const ICONS = {
  lage: '<path d="M12 21s7-5.2 7-11a7 7 0 1 0-14 0c0 5.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.2"/>',
  gebaeude: '<rect x="3" y="10" width="7" height="11" rx="1"/><rect x="14" y="3" width="7" height="18" rx="1"/>',
  einheiten: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
  flaechen: '<path d="M4 8h6v6H4zM14 4h6v6h-6zM14 14h6v6h-6zM4 16h4v4H4z"/>',
  zimmer: '<path d="M3 21h18M5 21V10l7-5 7 5v11M9 21v-6h6v6"/>',
  grundstueck: '<path d="M4 20h16M6 20V9l6-4 6 4v11"/><path d="M9 20v-5h6v5"/>',
  highlight: '<path d="M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.4 6.8 19.1l1-5.8L3.5 9.2l5.9-.9z"/>',
  preise: '<path d="M12 2v20M16 6H9.5a3.5 3.5 0 0 0 0 7H14a3.5 3.5 0 0 1 0 7H7"/>',
  provision: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
};
const LABELS = { highlight: "Highlight", lage: "Lage", gebaeude: "Gebäude", einheiten: "Einheiten", flaechen: "Flächen", zimmer: "Zimmer", grundstueck: "Grundstück", preise: "Preise", provision: "Provision" };

export function flyerModalInner(sot = loadSot()) {
  const P = projectTexts(sot, "allmannsdorf", "de");
  const F = projectFacts(sot, "allmannsdorf");
  const c = sot.contact;
  const tel = `tel:${c.phone_mobile.e164}`;
  const specs = Object.entries(P.specs)
    .filter(([k]) => ICONS[k])
    .map(([k, v]) => `            <li>
              <span class="flyer-ico" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75">${ICONS[k]}</svg></span>
              <span class="flyer-spec-label">${LABELS[k]}</span>
              <span class="flyer-spec-val">${esc(v)}</span>
            </li>`).join("\n");
  const img = (k) => P.images?.[k] || null;
  const gal = (key) => P.gallery.find((g) => g.key === key) || {};
  return `    <div class="flyer-backdrop" data-close-flyer aria-hidden="true"></div>
    <div class="flyer-dialog" role="dialog" aria-modal="true" aria-labelledby="flyerTitle">
      <button type="button" class="flyer-close" data-close-flyer aria-label="Schließen">×</button>
      <div class="flyer">
        <div class="flyer-top">
          <div class="flyer-brand">
            <img src="/assets/logo.png?v=house-orig-v1" alt="${esc(c.name)}" width="320" height="56" loading="lazy">
          </div>
          <figure class="flyer-hero-img">
            <picture>
              <source srcset="/assets/flyer/hero-dining.webp" type="image/webp">
              <img src="/assets/flyer/hero-dining.jpg" alt="${esc(gal("hero").alt)}" width="520" height="550">
            </picture>
            <figcaption class="flyer-img-note">Visualisierung</figcaption>
          </figure>
          <div class="flyer-intro">
            <h2 id="flyerTitle">NEUBAU<br><span>ALLMANNSDORF</span></h2>
            <p>${esc(P.title)} in Konstanz – jetzt provisionsfrei vormerken.</p>
            <ul class="flyer-checks">
${P.checks.map((x) => `              <li>${esc(x)}</li>`).join("\n")}
            </ul>
            <p class="flyer-cta-script">Jetzt vormerken lassen!</p>
            <div class="flyer-intro-ctas">
              <a class="btn btn-accent" href="${tel}">Anrufen ${esc(c.phone_mobile.display)}</a>
            </div>
            <div class="flyer-form">
${vormerkFormHtml({ id: "vormerk-flyer", location: "flyer_modal", lang: "de", prefix: "/", heading: "h3", indent: "            " })}
            </div>
          </div>
        </div>
        <div class="flyer-mid">
          <ul class="flyer-specs">
${specs}
          </ul>
          <div class="flyer-mid-right">
            <div class="flyer-thumbs">
              <picture>
                <source srcset="/assets/flyer/living.webp" type="image/webp">
                <img src="/assets/flyer/living.jpg" alt="${esc(gal("living").alt)}" width="300" height="260" loading="lazy">
              </picture>
              <picture>
                <source srcset="/assets/flyer/dining-detail.webp" type="image/webp">
                <img src="/assets/flyer/dining-detail.jpg" alt="${esc(gal("dining_detail").alt)}" width="300" height="260" loading="lazy">
              </picture>
            </div>
            <p class="flyer-img-note">Visualisierungen aus dem Projektflyer</p>
            <div class="flyer-copy">
              <p>${esc(P.description)}</p>
              <ul class="flyer-features">
${P.features.map((x) => `                <li>${esc(x)}</li>`).join("\n")}
              </ul>
              <div class="flyer-actions">
                <a class="btn btn-outline" href="mailto:${esc(c.email)}?subject=${encodeURIComponent(P.cta.email_subject)}">E-Mail Vormerken</a>
              </div>
            </div>
          </div>
        </div>
        <div class="flyer-foot">
          <div class="flyer-foot-contact">
            <a href="${tel}">Tel ${esc(c.phone_mobile.display)}</a>
            <a href="mailto:${esc(c.email)}">${esc(c.email)}</a>
            <a href="${esc(c.website)}">www.immobilieneichmann.de</a>
          </div>
          <p class="flyer-slogan">Ihr Partner für Neubauimmobilien in Konstanz und am Bodensee.</p>
        </div>
      </div>
    </div>
`;
}

const STUB = `${FLYER_START}
  <div class="flyer-overlay" id="flyerModal" hidden data-flyer-src="/${FLYER_PARTIAL}?v=0"></div>
  ${FLYER_END}`;

function findBlock(s) {
  const a0 = s.indexOf(FLYER_START);
  if (a0 >= 0) { const e = s.indexOf(FLYER_END, a0); return [a0, e + FLYER_END.length]; }
  const a = s.indexOf('<div class="flyer-overlay" id="flyerModal"');
  if (a < 0) return null;
  let depth = 0;
  const re = /<div\b|<\/div>/g; re.lastIndex = a;
  let m;
  while ((m = re.exec(s))) { depth += m[0] === "<div" ? 1 : -1; if (depth === 0) return [a, m.index + m[0].length]; }
  return null;
}

/** Write partial + replace inline modal on every page with the stub. */
export async function publishFlyerModal({ siteRoot, dryRun = false } = {}) {
  const sot = loadSot(siteRoot);
  const inner = flyerModalInner(sot);
  if (!dryRun) {
    await mkdir(path.join(siteRoot, "partials"), { recursive: true });
    await writeFile(path.join(siteRoot, FLYER_PARTIAL), inner, "utf8");
  }
  const files = [];
  const walk = async (d) => {
    for (const e of await readdir(path.join(siteRoot, d), { withFileTypes: true })) {
      if (e.isDirectory()) { if (["", "objekt", "en"].includes(d) && !["node_modules", ".git"].includes(e.name) && d === "" && ["objekt", "en"].includes(e.name)) await walk(e.name); }
      else if (e.name.endsWith(".html")) files.push(path.join(d, e.name));
    }
  };
  await walk("");
  let changed = 0;
  for (const rel of files) {
    const fp = path.join(siteRoot, rel);
    const s = await readFile(fp, "utf8");
    const b = findBlock(s);
    if (!b) continue;
    let [a, e] = b;
    // drop the old comment line directly above the inline modal
    const before = s.slice(0, a).replace(/[ \t]*<!-- Allmannsdorf flyer[^\n]*-->\s*$/, "");
    const out = before + (before.endsWith("\n") ? "  " : "") + STUB + s.slice(e);
    if (out !== s) { changed++; if (!dryRun) await writeFile(fp, out, "utf8"); }
  }
  return { partial: FLYER_PARTIAL, pages: changed };
}

/**
 * English property pages /en/property/<slug>.html – generated from the same listing rows as the German
 * exposé pages (data/listings.json + SSOT layer data/sot/listings.json). Claude global concept, Code 1.
 * Rules (Chris): numbers only from the listing facts, nothing about planning/construction status or dates,
 * no countdowns, no invented availability. each page canonical to itself; hreflang de/en, x-default = English (Claude global concept, line 46).
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { EN_PRIVACY } from "./vormerk-form.mjs";

export const ORIGIN = "https://immobilieneichmann.de";
const TEL = "tel:+491705225568";
const TEL_DISPLAY = "+49 170 522 5568";
const EMAIL = "info@immobilien-eichmann.com";
const num = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 });
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const ld = (o) => JSON.stringify(o, null, 2).replace(/</g, "\\u003c").replace(/&/g, "\\u0026");
/** "47,04 m²" | "1.250.000 €" | "1,5" → number */
export const deNum = (s) => {
  const m = String(s ?? "").replace(/\s/g, "").match(/\d[\d.]*(,\d+)?/);
  return m ? Number(m[0].replace(/\./g, "").replace(",", ".")) : null;
};
const eur = (n) => `€${num.format(n)}`;

export const enPath = (slug) => `/en/property/${slug}.html`;
export const enUrl = (slug) => `${ORIGIN}${enPath(slug)}`;
export const dePath = (L) => `/${L.local_url || `objekt/${L.slug}.html`}`;
export const isPublicDetail = (L) => Boolean(L) && L.active !== false && L.site_hidden !== true && L.detail_page !== false && Boolean(L.slug);

const CONDITION_EN = { "Erstbezug": "first occupancy", "neuwertig": "as new", "teil-/vollsaniert": "partly/fully renovated", "saniert": "renovated", "gepflegt": "well kept", "renoviert": "renovated" };

/** Pure: listing row → English page model. */
export function listingEn(L) {
  const f = L.facts || {};
  const src = `${L.title || ""} ${L.type || ""}`;
  const typ = /dreifamil/i.test(src) ? "three-family house" : /maisonette/i.test(src) ? "maisonette" : /penthouse/i.test(String(L.title || "")) ? "penthouse" : /haus/i.test(String(L.type || "")) ? "house" : "apartment";
  const isHouse = /house/.test(typ);
  const rooms = deNum(f["Anzahl Zimmer"] ?? L.rooms);
  const area = deNum(L.living_area);
  const plot = deNum(L.plot_area);
  const price = deNum(f["Kaufpreis"] ?? L.price);
  const district = (String(L.location || "").split(",")[0] || "").trim();
  const place = district && district !== "Konstanz" ? `Konstanz-${district}` : "Konstanz";
  const postal = String(f["PLZ"] || (String(L.location || "").match(/\((\d{5})\)/) || [])[1] || "");
  const ref = L.reference_number || f["Referenznummer"] || "";
  const core = typ === "three-family house" || !rooms ? typ[0].toUpperCase() + typ.slice(1) : `${num.format(rooms)}-room ${typ}`;
  const name = `${ref ? ref + ": " : ""}${core} in ${place}`;
  let title = `${name} | Eichmann`;
  if (title.length > 60) title = name;
  if (title.length > 60) title = `${ref ? ref + ": " : ""}${core}, Konstanz`;
  const provDe = String(f["Käuferprovision"] || "").trim();
  const commission = /provisionsfrei/i.test(provDe) ? "commission-free" : /provisionspflichtig/i.test(provDe) ? "buyer's commission applies" : "commission on request";
  const commissionFact = /provisionsfrei/i.test(provDe) ? "None (commission-free)" : /provisionspflichtig/i.test(provDe) ? "Applies – see exposé" : "On request";
  const parts = [area ? `${num.format(area)} m²` : null, price ? eur(price) : null, commission].filter(Boolean).join(", ");
  let description = `${name}: ${parts}. Exposé and viewings: ${TEL_DISPLAY}.`;
  if (description.length > 160) description = `${name}: ${parts}. Call ${TEL_DISPLAY}.`;
  if (description.length > 160) description = `${name}: ${parts}.`;
  const facts = [
    ...(ref ? [["Reference", ref]] : []),
    ...(price ? [["Purchase price", eur(price)]] : []),
    ...(rooms ? [["Rooms", `${num.format(rooms)} (German count: living rooms and bedrooms)`]] : []),
    ...(area ? [["Living area", `${num.format(area)} m²`]] : []),
    ...(plot ? [["Plot", `${num.format(plot)} m²`]] : []),
    ["Location", `${district || "Konstanz"}, Konstanz${postal ? ` (${postal})` : ""}, Germany`],
    ["Property type", core],
    ...(CONDITION_EN[f["Zustand"]] ? [["Condition", CONDITION_EN[f["Zustand"]]]] : []),
    ...(f["Effizienzklasse"] && /^[A-H]\+?$/.test(f["Effizienzklasse"]) ? [["Energy efficiency class", f["Effizienzklasse"]]] : []),
    ...(/€/.test(f["Tiefgaragen Stellplatz (Kaufpreis)"] || "") ? [["Underground parking space (purchase price)", eur(deNum(f["Tiefgaragen Stellplatz (Kaufpreis)"]))]] : []),
    ["Buyer's commission", commissionFact],
  ];
  return { slug: L.slug, name, title, description, facts, price, rooms, area, postal, district, isHouse, ref, commission,
    titleDe: L.title || L.slug, de: `${ORIGIN}${dePath(L)}`, en: enUrl(L.slug), dataAsOf: L.verified_at || null };
}

/** Local listing images (same files as the German exposé). */
export function listingImages(siteRoot, L, max = 12) {
  const base = L.image_base;
  if (!base) return { main: null, gallery: [], og: null };
  const dir = path.join(siteRoot, "assets/listings");
  let files = [];
  try { files = readdirSync(dir); } catch { return { main: null, gallery: [], og: null }; }
  const main = files.includes(`${base}.jpg`) ? `${base}.jpg` : null;
  const gallery = files.filter((f) => new RegExp(`^${base}-g\\d+\\.jpg$`).test(f)).sort().slice(0, max - 1);
  const og = files.includes(`${base}-og.jpg`) ? `${base}-og.jpg` : main;
  return { main, gallery: [main, ...gallery].filter(Boolean), og, hasWebp: (f) => files.includes(f.replace(/\.jpg$/, ".webp")) };
}

export const hreflangHead = (dePathAbs, enPathAbs, indent = "  ") =>
  [["de", dePathAbs], ["en", enPathAbs], ["x-default", enPathAbs]].map(([l, h]) => `${indent}<link rel="alternate" hreflang="${l}" href="${h}">`).join("\n");

const WA = (text) => `https://wa.me/491705225568?text=${encodeURIComponent(text)}`;
const ddmmyyyy = (iso) => (iso ? iso.split("-").reverse().join("/") : "");

export function renderEnListingHtml(m, img, { siblings = [], css = "", js = {} } = {}) {
  const wa = WA(`Hello Mr Eichmann, I am interested in the property "${m.name}": ${m.en}`);
  const jsonld = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "RealEstateListing", "@id": `${m.en}#listing`, url: m.en, name: m.name, description: m.description, inLanguage: "en",
        ...(m.dataAsOf ? { dateModified: m.dataAsOf } : {}),
        ...(img.gallery.length ? { image: img.gallery.slice(0, 6).map((f) => `${ORIGIN}/assets/listings/${f}`) } : {}),
        provider: { "@id": `${ORIGIN}/#business` },
        translationOfWork: { "@id": m.de },
        about: {
          "@type": m.isHouse ? "House" : "Apartment",
          ...(m.rooms ? { numberOfRooms: m.rooms } : {}),
          ...(m.area ? { floorSize: { "@type": "QuantitativeValue", value: m.area, unitCode: "MTK" } } : {}),
          address: { "@type": "PostalAddress", addressLocality: "Konstanz", ...(m.postal ? { postalCode: m.postal } : {}), addressCountry: "DE" },
        },
        ...(m.price ? { offers: { "@type": "Offer", price: String(m.price), priceCurrency: "EUR", url: m.en, offeredBy: { "@id": `${ORIGIN}/#business` } } } : {}),
      },
      {
        "@type": "BreadcrumbList", "@id": `${m.en}#breadcrumb`,
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: `${ORIGIN}/en/` },
          { "@type": "ListItem", position: 2, name: "Properties", item: `${ORIGIN}/en/#listings` },
          { "@type": "ListItem", position: 3, name: m.name, item: m.en },
        ],
      },
    ],
  };
  const pic = (f, i) => `          <figure class="project-gallery-item">
            <picture>${img.hasWebp?.(f) ? `<source srcset="../../assets/listings/${f.replace(/\.jpg$/, ".webp")}" type="image/webp">` : ""}<img src="../../assets/listings/${f}" alt="${esc(m.name)} – photo ${i + 1}" width="${i === 0 ? 520 : 300}" height="${i === 0 ? 390 : 225}"${i === 0 ? ' fetchpriority="high"' : ' loading="lazy"'} decoding="async"></picture>
          </figure>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(m.title)}</title>
  <meta name="description" content="${esc(m.description)}">
  <meta name="robots" content="index,follow,max-image-preview:large">
  <link rel="canonical" href="${m.en}">
${hreflangHead(m.de, m.en)}
  <meta property="og:type" content="website">
  <meta property="og:locale" content="en_GB">
  <meta property="og:locale:alternate" content="de_DE">
  <meta property="og:site_name" content="Immobilien Eichmann">
  <meta property="og:title" content="${esc(m.title)}">
  <meta property="og:description" content="${esc(m.description)}">
  <meta property="og:url" content="${m.en}">
${img.og ? `  <meta property="og:image" content="${ORIGIN}/assets/listings/${img.og}">\n` : ""}  <meta name="twitter:card" content="summary_large_image">
  <link rel="icon" href="../../assets/logo.png?v=0" type="image/png">
  <link rel="apple-touch-icon" href="../../assets/apple-touch-icon.png">
  <link rel="stylesheet" href="../../css/styles.css?v=0">
  <script type="application/ld+json">
${ld(jsonld)}
  </script>
</head>
<body>
  <header class="site-header">
    <div class="container header-inner">
      <a class="logo" href="/en/" aria-label="Immobilien Eichmann – Home">
        <img class="logo-svg" src="../../assets/logo-header.svg?v=0" alt="Immobilien Eichmann" width="320" height="56" decoding="async">
        <span class="logo-text">
          <span class="logo-mark">Immobilien Eichmann</span>
          <span class="logo-sub">Sales · Brokerage · Project development</span>
        </span>
      </a>
      <button class="menu-toggle" type="button" aria-label="Open menu" aria-expanded="false">☰</button>
      <nav class="nav" aria-label="Main navigation">
        <a href="/en/">Home</a>
        <a href="/en/#listings" class="active">Properties</a>
        <a href="/en/allmannsdorf.html">New-build Allmannsdorf</a>
        <a href="/en/contact.html">Contact</a>
        <a href="${m.de}" hreflang="de" lang="de" class="lang-switch" data-lang-switch="de">Deutsch</a>
        <a href="${TEL}" class="nav-cta btn-call" data-location="header_number">Call<span class="nav-cta-num"> ${TEL_DISPLAY}</span></a>
      </nav>
    </div>
  </header>

  <main id="main">
    <section class="page-hero">
      <div class="container page-hero-inner">
        <p class="hero-links"><a href="/en/">Home</a> › <a href="/en/#listings">Properties</a></p>
        <h1>${esc(m.name)}</h1>
        <p class="lead">${m.price ? `<strong class="nowrap">${esc(eur(m.price))}</strong> · ` : ""}${esc(m.district || "Konstanz")}, Konstanz${m.postal ? ` (${esc(m.postal)})` : ""} · ${esc(m.commission)}</p>
        <p class="expose-hero-meta">${m.dataAsOf ? `<span class="nowrap">Data as of: ${ddmmyyyy(m.dataAsOf)}</span> · ` : ""}<span class="nowrap">Prices in euros</span></p>
        <div class="hero-actions project-hero-actions">
          <a class="btn btn-accent expose-jump" href="#anfragen" data-location="expose_jump">Request exposé</a>
          <a class="btn btn-outline btn-call" href="${TEL}" data-location="hero_number">Call <span class="nowrap">${TEL_DISPLAY}</span></a>
          <a class="btn btn-outline" href="${esc(wa)}" target="_blank" rel="noopener noreferrer">WhatsApp</a>
        </div>
      </div>
    </section>

    <section class="section section-alt">
      <div class="container contact-grid">
        <div class="content-card">
          <h2 style="margin-top:0">Key facts</h2>
          <ul class="helmut-contact">
${m.facts.map(([k, v]) => `            <li>${esc(k)}: <strong>${esc(v)}</strong></li>`).join("\n")}
          </ul>
          <p>The full description is available in German: <a href="${m.de}" hreflang="de" lang="de">${esc(m.titleDe)}</a>. Helmut Eichmann will send you the exposé and answer your questions personally.</p>
          <p class="immowelt-note">All information without guarantee. The current exposé is authoritative.</p>
        </div>
        <div class="content-card expose-cta-card" id="anfragen">
          <h2 style="margin-top:0">Request exposé</h2>
          <form id="contact-form" class="expose-form" action="https://forms.digitalisierungsplanung.de/v1/immobilieneichmann/expose" method="POST" data-expose-title="${esc(m.titleDe)}" data-expose-slug="${esc(m.slug)}">
            <input type="hidden" name="anliegen" value="Exposé-Anfrage (EN)">
            <input type="hidden" name="objekt" value="${esc(m.titleDe)}">
            <input type="hidden" name="objekt_url" value="${m.en}">
            <input type="hidden" name="lang" value="en">
            <input type="checkbox" name="botcheck" class="hp-field" tabindex="-1" autocomplete="off" aria-hidden="true">
            <div class="form-group">
              <label for="name">Name *</label>
              <input type="text" id="name" name="name" required autocomplete="name">
            </div>
            <div class="form-group">
              <label for="phone">Phone *</label>
              <input type="tel" id="phone" name="phone" required autocomplete="tel" inputmode="tel" placeholder="With country code, e.g. +41 …">
            </div>
            <details class="form-more">
              <summary>More details (optional)</summary>
              <div class="form-group">
                <label for="email">E-mail</label>
                <input type="email" id="email" name="email" autocomplete="email">
              </div>
            </details>
            <p class="form-note legal-request-note">${EN_PRIVACY("/")}</p>
            <button type="submit" class="btn btn-accent" id="contact-submit">Request exposé</button>
            <div id="form-success" class="form-success" role="status" hidden>Thank you. Helmut Eichmann will get back to you personally.</div>
            <div id="form-error" class="form-error" role="alert" hidden>Your request could not be sent. Please call or use WhatsApp: <a href="${TEL}">${TEL_DISPLAY}</a>.</div>
          </form>
        </div>
      </div>
    </section>
${img.gallery.length ? `    <section class="section" aria-labelledby="photos-title">
      <div class="container">
        <h2 id="photos-title" class="sr-only">Photos</h2>
        <div class="project-gallery">
${img.gallery.map(pic).join("\n")}
        </div>
        <p class="immowelt-note">More photos and floor plans on the <a href="${m.de}" hreflang="de" lang="de">German exposé page</a>.</p>
      </div>
    </section>
` : ""}
${siblings.length ? `
    <section class="section">
      <div class="container narrow">
        <h2>More properties in Konstanz</h2>
        <ul class="check-list">
${siblings.map((s) => `          <li><a href="${enPath(s.slug)}">${esc(s.name)}</a>${s.price ? ` – ${esc(eur(s.price))}` : ""}</li>`).join("\n")}
        </ul>
        <p><a href="/en/buying-from-abroad.html">Buying property in Konstanz from abroad</a></p>
      </div>
    </section>
` : ""}  </main>

  <footer class="site-footer">
    <div class="container">
      <div class="footer-grid footer-grid-seo">
        <div class="footer-brand">
          <p class="footer-name">Immobilien Eichmann</p>
          <p>Helmut Eichmann<br>Jacob-Burckhardt-Str. 40<br>78464 Konstanz, Germany</p>
          <p><a href="${TEL}">${TEL_DISPLAY}</a><br><a href="mailto:${EMAIL}">${EMAIL}</a></p>
        </div>
        <div class="footer-col">
          <h2 class="footer-heading">English</h2>
          <a href="/en/">Home</a>
          <a href="/en/#listings">Properties</a>
          <a href="/en/allmannsdorf.html">New-build Allmannsdorf</a>
          <a href="/en/buying-from-abroad.html">Buying from abroad</a>
          <a href="/en/contact.html">Contact</a>
        </div>
        <div class="footer-col">
          <h2 class="footer-heading">Legal (German)</h2>
          <a href="/impressum.html" hreflang="de">Legal notice (German)</a>
          <a href="/datenschutz.html" hreflang="de">Privacy policy (German)</a>
          <a href="#" data-open-cookie-settings>Cookie settings</a>
        </div>
      </div>
      <div class="footer-bottom">
        <span>© <span id="y">2026</span> Immobilien Eichmann · Helmut Eichmann</span>
        <span>immobilieneichmann.de</span>
      </div>
    </div>
  </footer>

  <nav class="sticky-bar sticky-bar--3" aria-label="Quick contact">
    <a href="${TEL}" class="sticky-item sticky-accent"><span>Call</span></a>
    <a href="#anfragen" class="sticky-item"><span>Exposé</span></a>
    <a href="${esc(wa)}" class="sticky-item sticky-item--wa" target="_blank" rel="noopener noreferrer"><span>WhatsApp</span></a>
  </nav>

  <script>window.__eichmannJsBase="../../js/";</script>
  <script src="../../js/cookie-consent.js?v=0" defer></script>
  <script src="../../js/main.js?v=0" defer></script>
</body>
</html>
`;
}

/** Write all EN property pages; remove orphans. Returns models (for sitemap, llms, /en/). */
export function publishEnListings(data, { siteRoot, dryRun = false } = {}) {
  const rows = (data?.listings || []).filter(isPublicDetail).filter((L) => existsSync(path.join(siteRoot, L.local_url || `objekt/${L.slug}.html`)) || dryRun);
  const models = rows.map((L) => ({ L, m: listingEn(L) }));
  const dir = path.join(siteRoot, "en/property");
  if (!dryRun) mkdirSync(dir, { recursive: true });
  const keep = new Set();
  for (const { L, m } of models) {
    const siblings = models.filter((x) => x.m.slug !== m.slug).map((x) => x.m).slice(0, 6);
    const html = renderEnListingHtml(m, listingImages(siteRoot, L), { siblings });
    keep.add(`${m.slug}.html`);
    if (!dryRun) writeFileSync(path.join(dir, `${m.slug}.html`), html, "utf8");
  }
  if (!dryRun) for (const f of readdirSync(dir)) if (f.endsWith(".html") && !keep.has(f)) unlinkSync(path.join(dir, f));
  return models.map((x) => x.m);
}

/** For /en/ and checks: models from the committed listing mirror. */
export function enListingModels(siteRoot) {
  try {
    const data = JSON.parse(readFileSync(path.join(siteRoot, "data/listings.json"), "utf8"));
    return (data.listings || []).filter(isPublicDetail).filter((L) => existsSync(path.join(siteRoot, "en/property", `${L.slug}.html`))).map(listingEn);
  } catch { return []; }
}

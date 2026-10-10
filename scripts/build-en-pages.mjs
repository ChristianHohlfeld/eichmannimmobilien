#!/usr/bin/env node
/**
 * Builds the English section /en/ (phase 1: home, New-build Allmannsdorf, contact).
 * Source texts: Claude's intl package (2026-10-10), checked against Chris's rules:
 *  - numbers only where they already appear on the German site / flyer
 *  - no lake/sea-view claims, nothing about planning/construction status or dates, no countdowns
 *  - no "under construction"/"reserve"/"pre-order"/"off-plan"/"completion"; no schema availability
 *  - hreflang de/en, x-default = German; no language redirect, only a DE/EN link
 * Run: node scripts/build-en-pages.mjs   (test: scripts/test-en-pages.mjs)
 */
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { vormerkFormHtml, EN_PRIVACY } from "./lib/vormerk-form.mjs";
import { enListingModels, enPath } from "./lib/listing-en.mjs";
import { loadSot, projectTexts, projectFacts, whatsappUrl } from "./lib/sot.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const O = "https://immobilieneichmann.de";
const V = "claude-final";
// SSOT: Kontakt + Allmannsdorf-Texte/Fakten aus data/sot/ (scripts/lib/sot.mjs)
const SOT = loadSot(ROOT);
const C = SOT.contact;
const AL = projectTexts(SOT, "allmannsdorf", "en");
const F = projectFacts(SOT, "allmannsdorf");
const TEL = `tel:${C.phone_mobile.e164}`;
const WA_GEN = whatsappUrl(SOT, C.whatsapp_text.en);
const WA_ALL = whatsappUrl(SOT, AL.whatsapp_text);
const MAIL_ALL = `mailto:${C.email}?subject=` + encodeURIComponent(AL.email_subject);

const PAIRS = { home: { de: "/", en: "/en/" }, allmannsdorf: { de: "/allmannsdorf.html", en: "/en/allmannsdorf.html" }, contact: { de: "/kontakt.html", en: "/en/contact.html" }, abroad: { de: "/kaufen-aus-der-schweiz.html", en: "/en/buying-from-abroad.html" } };

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const ld = (obj) => JSON.stringify(obj, null, 2).replace(/</g, "\\u003c").replace(/&/g, "\\u0026");

const BUSINESS = {
  "@type": ["RealEstateAgent", "LocalBusiness"],
  "@id": `${O}/#business`,
  name: "Immobilien Eichmann",
  url: `${O}/`,
  logo: `${O}/assets/logo.svg?v=house-orig-v1`,
  image: `${O}/assets/share-card-plain-v2.jpg`,
  telephone: [C.phone_mobile.e164, C.phone_landline.e164],
  email: C.email,
  address: { "@type": "PostalAddress", streetAddress: "Jacob-Burckhardt-Str. 40", addressLocality: "Konstanz", postalCode: "78464", addressCountry: "DE" },
  founder: { "@type": "Person", name: "Helmut Eichmann" },
  areaServed: ["Konstanz", "Allmannsdorf", "Lake Constance"],
};

const WA_SVG = `<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.435 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>`;
const PHONE_SVG = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`;

function head({ key, title, desc, ogAlt = "Immobilien Eichmann – new-build and property in Konstanz", jsonld }) {
  const p = PAIRS[key];
  const url = O + p.en;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}">
  <meta name="robots" content="index,follow,max-image-preview:large">
  <link rel="canonical" href="${url}">
  <link rel="alternate" hreflang="de" href="${O}${p.de}">
  <link rel="alternate" hreflang="en" href="${url}">
  <link rel="alternate" hreflang="x-default" href="${O}${p.de}">
  <meta property="og:type" content="website">
  <meta property="og:locale" content="en_GB">
  <meta property="og:locale:alternate" content="de_DE">
  <meta property="og:site_name" content="Immobilien Eichmann">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(desc)}">
  <meta property="og:url" content="${url}">
  <meta property="og:image" content="${O}/assets/share-card-plain-v2.jpg">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="${esc(ogAlt)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(title)}">
  <meta name="twitter:description" content="${esc(desc)}">
  <meta name="twitter:image" content="${O}/assets/share-card-plain-v2.jpg">
  <link rel="icon" href="../assets/logo.png?v=house-orig-v1" type="image/png">
  <link rel="apple-touch-icon" href="../assets/apple-touch-icon.png">
  <link rel="stylesheet" href="../css/styles.css?v=${V}">
  <script type="application/ld+json">
${ld(jsonld)}
  </script>
</head>
<body>
  <header class="site-header">
    <div class="container header-inner">
      <a class="logo" href="/en/" aria-label="Immobilien Eichmann – Home">
        <img class="logo-svg" src="../assets/logo-header.svg?v=header-safe-v1" alt="Immobilien Eichmann" width="320" height="56" decoding="async">
        <span class="logo-text">
          <span class="logo-mark">Immobilien Eichmann</span>
          <span class="logo-sub">Sales · Brokerage · Project development</span>
        </span>
      </a>
      <button class="menu-toggle" type="button" aria-label="Open menu" aria-expanded="false">☰</button>
      <nav class="nav" aria-label="Main navigation">
        <a href="/en/"${key === "home" ? ' class="active"' : ""}>Home</a>
        <a href="/en/#listings">Properties</a>
        <a href="/en/allmannsdorf.html"${key === "allmannsdorf" ? ' class="active"' : ""}>New-build Allmannsdorf</a>
        <a href="/en/contact.html"${key === "contact" ? ' class="active"' : ""}>Contact</a>
        <a href="${p.de}" hreflang="de" lang="de" class="lang-switch" data-lang-switch="de">Deutsch</a>
        <a href="${TEL}" class="nav-cta btn-call" data-location="header_number">Call<span class="nav-cta-num"> +49 170 522 5568</span></a>
      </nav>
    </div>
  </header>
`;
}

function foot(key, waHref = WA_GEN) {
  const p = PAIRS[key];
  return `
  <footer class="site-footer">
    <div class="container">
      <div class="footer-grid footer-grid-seo">
        <div class="footer-brand">
          <p class="footer-name">Immobilien Eichmann</p>
          <p>Helmut Eichmann<br>${C.address.street}<br>${C.address.postal_code} ${C.address.city}, Germany</p>
          <p><a href="${TEL}">${C.phone_mobile.display}</a><br>
          <a href="tel:${C.phone_landline.e164}">${C.phone_landline.display}</a><br>
          <a href="mailto:${C.email}">${C.email}</a></p>
          <p class="footer-hours">Appointments by arrangement</p>
        </div>
        <div class="footer-col">
          <h2 class="footer-heading">English</h2>
          <a href="/en/">Home</a>
          <a href="/en/#listings">Properties</a>
          <a href="/en/allmannsdorf.html">New-build Allmannsdorf</a>
          <a href="/en/buying-from-abroad.html">Buying from abroad</a>
          <a href="/en/contact.html">Contact</a>
          <a href="${p.de}" hreflang="de" lang="de" class="lang-switch" data-lang-switch="de">Deutsch</a>
        </div>
        <div class="footer-col">
          <h2 class="footer-heading">Legal (German)</h2>
          <a href="/impressum.html" hreflang="de">Legal notice (German)</a>
          <a href="/datenschutz.html" hreflang="de">Privacy policy (German)</a>
          <a href="#" data-open-cookie-settings>Cookie settings</a>
          <a href="/widerrufsbelehrung.html" hreflang="de">Cancellation policy (German)</a>
          <a href="/vertrag-widerrufen.html" hreflang="de">Cancellation form (German)</a>
        </div>
      </div>
      <div class="footer-bottom">
        <span>© <span id="y">2026</span> Immobilien Eichmann · Helmut Eichmann</span>
        <span>immobilieneichmann.de</span>
      </div>
    </div>
  </footer>

${key === "allmannsdorf" ? `  <div class="flyer-overlay" id="flyerModal" hidden data-flyer-src="/partials/flyer-modal-en.html?v=${V}"></div>\n` : ""}  <nav class="sticky-bar" aria-label="Quick contact">
    <a href="${TEL}" class="sticky-item sticky-accent">
      <span class="sticky-ico" aria-hidden="true">${PHONE_SVG}</span>
      <span>Call</span>
    </a>
    <a href="${esc(waHref)}" class="sticky-item sticky-item--wa" target="_blank" rel="noopener noreferrer">
      <span class="sticky-ico sticky-ico--fill" aria-hidden="true">${WA_SVG}</span>
      <span>WhatsApp</span>
    </a>
  </nav>
  <aside class="floating-wa-region" aria-label="WhatsApp">
  <a class="floating-wa" href="${esc(waHref)}" target="_blank" rel="noopener noreferrer" aria-label="WhatsApp: ask about a property" title="WhatsApp: ask about a property">
    <span class="floating-wa__icon" aria-hidden="true">${WA_SVG.replace(/width="22" height="22"/, 'width="28" height="28"')}</span>
  </a>
  </aside>

  <script>window.__eichmannJsBase="../js/";</script>
  <script src="../js/cookie-consent.js?v=${V}" defer></script>
  <script src="../js/main.js?v=${V}" defer></script>
  <script src="../js/vormerk.js?v=${V}" defer></script>
</body>
</html>
`;
}

/* ---------- /en/ ---------- */
async function homePage() {
  const title = "Real Estate Agent in Konstanz | Immobilien Eichmann";
  const desc = "Immobilien Eichmann in Konstanz on Lake Constance: properties for sale and New-build Allmannsdorf – commission-free, register your interest. +49 170 522 5568.";
  const jsonld = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebPage", "@id": `${O}/en/#webpage`, url: `${O}/en/`, name: title, description: desc, inLanguage: "en",
        isPartOf: { "@id": `${O}/#website` }, about: { "@id": `${O}/#business` }, publisher: { "@id": `${O}/#business` },
        translationOfWork: { "@id": `${O}/#webpage` },
        primaryImageOfPage: { "@type": "ImageObject", url: `${O}/assets/share-card-plain-v2.jpg`, width: 1200, height: 630 },
      },
      BUSINESS,
    ],
  };
  return head({ key: "home", title, desc, jsonld }) + `
  <main id="main">
    <section class="hero">
      <div class="hero-grid">
        <div class="hero-copy">
          <h1 class="hero-kicker">Real estate agent in Konstanz · Lake Constance</h1>
          <p class="hero-title">New-build Allmannsdorf – register your interest, commission‑free</p>
          <p class="lead" data-sot-lead="allmannsdorf">${esc(AL.lead)}</p>
          <div class="hero-actions hero-actions--dual">
            <a class="btn btn-accent hero-cta-call btn-call" href="${TEL}" data-location="hero_number">Call <span class="nowrap">${C.phone_mobile.display}</span></a>
            <a class="btn btn-accent hero-cta-vormerken" href="#vormerk-hero-en">Register interest</a>
          </div>
          <p class="hero-subline">
            <a href="${TEL}">${C.phone_mobile.display}</a> · <span class="nowrap">Landline <a href="tel:${C.phone_landline.e164}">${C.phone_landline.display}</a></span>
          </p>
          <p class="hero-links">
            <a href="/en/allmannsdorf.html">New-build Allmannsdorf</a> · <a href="/en/#listings">Properties</a> · <a href="/" hreflang="de" lang="de" data-lang-switch="de">Deutsch</a>
          </p>
        </div>
        <div class="hero-form">
${vormerkFormHtml({ id: "vormerk-hero-en", location: "home_hero", lang: "en", prefix: "/", heading: "h2", indent: "          " })}
        </div>
      </div>
    </section>

    <section class="section" id="listings">
      <div class="container narrow">
        <h2>Current listings</h2>
        <p>Properties for sale in Konstanz. Prices are in euros; the full exposés are in German.</p>
        <ul class="check-list en-listings">
${enListingModels(ROOT).map((m) => `          <li><a href="${enPath(m.slug)}">${esc(m.name)}</a>${m.price ? ` – €${m.price.toLocaleString("en-GB")}` : ""}${m.area ? `, ${m.area.toLocaleString("en-GB")} m²` : ""}, ${esc(m.commission)}</li>`).join("\n")}
        </ul>
        <p><a class="btn btn-outline" href="/en/buying-from-abroad.html">Buying from abroad</a> <a class="btn btn-outline" href="/#angebote" hreflang="de">Listings with photos (German)</a></p>
        <p class="immowelt-note">All information without guarantee. The current exposés are authoritative.</p>
      </div>
    </section>

    <section class="section section-alt">
      <div class="container narrow">
        <h2>New-build Allmannsdorf</h2>
        <p>${esc(AL.description)}</p>
        <p>Commission‑free – register your interest and Helmut Eichmann will get back to you personally.</p>
        <p class="hero-actions"><a class="btn btn-accent" href="/en/allmannsdorf.html">View project</a> <a class="btn btn-outline" href="#vormerk-hero-en">Register interest</a></p>
      </div>
    </section>

    <section class="section">
      <div class="container">
        <div class="section-head"><div><h2>Services</h2><p>Sales, brokerage and project development – local and personal.</p></div></div>
        <div class="services-strip services-strip-auto">
          <article class="service-card"><h3>Sales</h3><p>Marketing your property in Konstanz, with exposé, pricing and support for prospective buyers.</p></article>
          <article class="service-card"><h3>Brokerage</h3><p>Matching owners and buyers – transparent and easy to reach.</p></article>
          <article class="service-card"><h3>Project development</h3><p>Support for new-build and investment projects in the Lake Constance region.</p></article>
        </div>
      </div>
    </section>

    <section class="section section-alt" id="contact">
      <div class="container narrow">
        <h2>Contact</h2>
        <p>Immobilien Eichmann · Helmut Eichmann · ${C.address.street}, ${C.address.postal_code} ${C.address.city}, Germany</p>
        <p>Mobile &amp; WhatsApp <a href="${TEL}">${C.phone_mobile.display}</a> · <span class="nowrap">Landline <a href="tel:${C.phone_landline.e164}">${C.phone_landline.display}</a></span> · <a href="mailto:${C.email}">${C.email}</a></p>
        <p>Appointments by arrangement (Konstanz time, CET/CEST).</p>
        <p><a class="btn btn-outline" href="/en/contact.html">Contact form</a></p>
      </div>
    </section>
  </main>
` + foot("home");
}

/* ---------- /en/allmannsdorf.html ---------- */
const FAQ = AL.faq;
const DESC_ALL = AL.description;
const IMGS = AL.gallery.map((g) => ({ k: g.key, caption: g.caption, alt: g.alt }));

function allmannsdorfPage() {
  const url = `${O}/en/allmannsdorf.html`;
  const title = AL.page_title;
  const desc = AL.meta_description;
  const imgs = IMGS.map((i) => `${O}/assets/flyer/${i.k}.jpg`);
  const jsonld = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebPage", "@id": `${url}#webpage`, url, name: title, description: desc, inLanguage: "en",
        isPartOf: { "@id": `${O}/#website` },
        primaryImageOfPage: { "@type": "ImageObject", url: `${O}/assets/share-card-plain-v2.jpg`, width: 1200, height: 630 },
        breadcrumb: { "@id": `${url}#breadcrumb` }, about: { "@id": `${url}#complex` }, mainEntity: { "@id": `${url}#listing` },
        publisher: { "@id": `${O}/#business` }, translationOfWork: { "@id": `${O}/allmannsdorf.html#webpage` },
      },
      {
        "@type": "RealEstateListing", "@id": `${url}#listing`, name: "New-build Allmannsdorf", description: DESC_ALL, url, image: imgs, inLanguage: "en",
        provider: { "@id": `${O}/#business` }, about: { "@id": `${url}#complex` },
        offers: {
          "@type": "AggregateOffer", lowPrice: String(F.price.min), highPrice: String(F.price.max), priceCurrency: "EUR", offerCount: String(F.units.value),
          offeredBy: { "@id": `${O}/#business` }, url: `${url}#register`,
        },
      },
      {
        "@type": "ApartmentComplex", "@id": `${url}#complex`, name: "New-build Allmannsdorf", description: DESC_ALL, url, image: imgs,
        numberOfAccommodationUnits: F.units.value,
        address: { "@type": "PostalAddress", addressLocality: "Konstanz", addressRegion: "Baden-Württemberg", postalCode: "78464", addressCountry: "DE" },
        containedInPlace: { "@type": "Place", name: "Konstanz-Allmannsdorf", containedInPlace: { "@type": "City", name: "Konstanz" } },
        containsPlace: {
          "@type": "Apartment", name: "Apartments in Konstanz-Allmannsdorf",
          floorSize: { "@type": "QuantitativeValue", minValue: F.living_area.min, maxValue: F.living_area.max, unitCode: "MTK" },
          numberOfRooms: { "@type": "QuantitativeValue", minValue: F.rooms.min, maxValue: F.rooms.max },
        },
        amenityFeature: [
          { "@type": "LocationFeatureSpecification", name: "Low-barrier apartments", value: true },
          { "@type": "LocationFeatureSpecification", name: "Lift and underground parking", value: true },
        ],
      },
      {
        "@type": "BreadcrumbList", "@id": `${url}#breadcrumb`,
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: `${O}/en/` },
          { "@type": "ListItem", position: 2, name: "New-build Allmannsdorf", item: url },
        ],
      },
      BUSINESS,
      {
        "@type": "FAQPage", "@id": `${url}#faq`, inLanguage: "en",
        mainEntity: FAQ.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
      },
    ],
  };
  const facts = AL.facts;
  const features = AL.features;
  return head({ key: "allmannsdorf", title, desc, jsonld }) + `
  <main id="main">
    <nav class="breadcrumb container" aria-label="Breadcrumb">
      <ol>
        <li><a href="/en/">Home</a></li>
        <li aria-current="page">New-build Allmannsdorf</li>
      </ol>
    </nav>
    <section class="page-hero">
      <div class="container page-hero-inner project-hero-grid">
        <span class="eyebrow">New-build · Allmannsdorf · Commission-free</span>
        <h1>${esc(AL.h1)}</h1>
        <p class="lead">${esc(AL.lead)}</p>
        <figure class="project-hero-media">
          <a href="#flyerModal" data-open-flyer aria-label="Living and dining area with lake view – New-build Allmannsdorf (visualisation)">
            <picture>
              <source srcset="/assets/flyer/hero-dining.webp" type="image/webp">
              <img src="/assets/flyer/hero-dining.jpg" alt="Living and dining area with lake view – New-build Allmannsdorf (visualisation)" width="520" height="550" fetchpriority="high" decoding="async">
            </picture>
          </a>
          <figcaption>Visualisation</figcaption>
        </figure>
        <div class="hero-actions project-hero-actions">
          <a class="btn btn-accent hero-cta-call btn-call" href="${TEL}" data-location="hero_number">Call <span class="nowrap">${C.phone_mobile.display}</span></a>
          <a class="btn btn-outline hero-cta-vormerken" href="#register">Register interest</a>
        </div>
        <p class="hero-links"><a href="${esc(WA_ALL)}" target="_blank" rel="noopener noreferrer">WhatsApp</a> · <a href="${TEL}">${C.phone_mobile.display}</a> · <span class="nowrap">Landline <a href="tel:${C.phone_landline.e164}">${C.phone_landline.display}</a></span> · <a href="/allmannsdorf.html" hreflang="de" lang="de" data-lang-switch="de">Deutsch</a></p>
      </div>
    </section>

    <section class="section vormerk-section" id="register" aria-label="Register interest">
      <div class="container narrow">
${vormerkFormHtml({ id: "vormerk-projekt-en", location: "project_inline", lang: "en", prefix: "/", heading: "h2", indent: "        " })}
      </div>
    </section>

    <section class="section">
      <div class="container narrow">
        <p class="prose-lead">${esc(DESC_ALL)}</p>
      </div>
    </section>

    <section class="section section-alt">
      <div class="container">
        <div class="section-head"><div><h2>The project at a glance</h2><p>Key facts about New-build Allmannsdorf.</p></div></div>
        <div class="services-strip services-strip-auto">
${facts.map(([h, p]) => `          <article class="service-card"><h3>${esc(h)}</h3><p>${esc(p)}</p></article>`).join("\n")}
        </div>
      </div>
    </section>

    <section class="section" aria-labelledby="gallery-title">
      <div class="container">
        <div class="section-head"><div><h2 id="gallery-title">Inside New-build Allmannsdorf</h2><p>Illustrations from the project brochure.</p></div></div>
        <div class="project-gallery">
${IMGS.map((im, i) => `          <figure class="project-gallery-item">
            <picture>
              <source srcset="../assets/flyer/${im.k}.webp" type="image/webp">
              <img src="../assets/flyer/${im.k}.jpg" alt="${esc(im.alt)}" width="${i === 0 ? 520 : 300}" height="${i === 0 ? 550 : 260}" loading="lazy" decoding="async">
            </picture>
            <figcaption>${esc(im.caption)}</figcaption>
          </figure>`).join("\n")}
        </div>
      </div>
    </section>

    <section class="section section-alt">
      <div class="container">
        <div class="section-head"><div><h2>Features &amp; location</h2><p>Comfort and quality in a sought-after residential area.</p></div></div>
        <ul class="check-list">
${features.map((f) => `          <li>${esc(f)}</li>`).join("\n")}
        </ul>
        <p class="immowelt-note">All information without guarantee. Based on project data (brochure).</p>
      </div>
    </section>

    <section class="section">
      <div class="container narrow prose">
        <h2>Living in Konstanz-Allmannsdorf</h2>
${AL.location_text.map((t) => `        <p>${esc(t)}</p>`).join("\n")}
      </div>
    </section>

    <section class="section section-alt" id="faq">
      <div class="container narrow">
        <h2>Frequently asked questions about New-build Allmannsdorf</h2>
        <div class="faq-list">
${FAQ.map((f) => `          <details class="faq-item">
            <summary>${esc(f.q)}</summary>
            <p>${esc(f.a).replace("+49 170 522 5568", `<a href="${TEL}">${C.phone_mobile.display}</a>`)}</p>
          </details>`).join("\n")}
        </div>
      </div>
    </section>

    <section class="section">
      <div class="container narrow">
        <h2>Next step</h2>
        <p>Register your interest in New-build Allmannsdorf – Helmut Eichmann will get back to you personally.</p>
        <p class="hero-actions"><a class="btn btn-accent" href="#register">Register interest</a> <a class="btn btn-outline" href="${TEL}">Call</a> <a class="btn btn-outline" href="${esc(WA_ALL)}" target="_blank" rel="noopener noreferrer">WhatsApp</a> <a class="btn btn-outline" href="${esc(MAIL_ALL)}">E-mail</a></p>
      </div>
    </section>
  </main>
` + foot("allmannsdorf", WA_ALL);
}

/* ---------- /en/contact.html ---------- */
function contactPage() {
  const url = `${O}/en/contact.html`;
  const title = "Contact | Immobilien Eichmann Konstanz – Helmut Eichmann";
  const desc = "Contact Helmut Eichmann, Immobilien Eichmann in Konstanz: phone and WhatsApp +49 170 522 5568, info@immobilien-eichmann.com. Appointments by arrangement.";
  const jsonld = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": ["WebPage", "ContactPage"], "@id": `${url}#webpage`, url, name: title, description: desc, inLanguage: "en",
        isPartOf: { "@id": `${O}/#website` }, about: { "@id": `${O}/#business` }, publisher: { "@id": `${O}/#business` },
        translationOfWork: { "@id": `${O}/kontakt.html#contactpage` },
      },
      BUSINESS,
    ],
  };
  return head({ key: "contact", title, desc, jsonld }) + `
  <main id="main">
    <section class="page-hero">
      <div class="container page-hero-inner">
        <h1>Contact</h1>
        <p class="lead">Appointments by arrangement – Helmut Eichmann will get back to you personally.</p>
        <div class="hero-actions project-hero-actions">
          <a class="btn btn-accent" href="${esc(WA_GEN)}" target="_blank" rel="noopener noreferrer">WhatsApp</a>
          <a class="btn btn-outline" href="${TEL}">Call now</a>
          <a class="btn btn-outline" href="/en/allmannsdorf.html#register">Register interest in New-build Allmannsdorf</a>
        </div>
        <p class="hero-links"><a href="/kontakt.html" hreflang="de" lang="de" data-lang-switch="de">Deutsch</a></p>
      </div>
    </section>

    <section class="section">
      <div class="container contact-grid">
        <div class="content-card">
          <h2>Immobilien Eichmann</h2>
          <ul class="helmut-contact">
            <li>Contact person: <strong>Helmut Eichmann</strong></li>
            <li>Address: ${C.address.street}, ${C.address.postal_code} ${C.address.city}, Germany</li>
            <li>Mobile &amp; WhatsApp: <a href="${TEL}">${C.phone_mobile.display}</a></li>
            <li>Landline: <a href="tel:${C.phone_landline.e164}">${C.phone_landline.display}</a></li>
            <li>E-mail: <a href="mailto:${C.email}">${C.email}</a></li>
            <li>Appointments by arrangement (Konstanz time, CET/CEST)</li>
          </ul>
        </div>
        <div class="content-card">
          <h2 style="margin-top:0">Send a message</h2>
          <form id="contact-form" action="https://forms.digitalisierungsplanung.de/v1/immobilieneichmann/contact" method="POST">
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
            <div class="form-group">
              <label for="subject">Subject</label>
              <select id="subject" name="anliegen">
                <option value="Allgemeine Anfrage">General enquiry</option>
                <option value="Vormerkung Neubau Allmannsdorf">Register interest: New-build Allmannsdorf</option>
                <option value="Vermittlung / Kauf">Buying a property</option>
                <option value="Verkauf">Selling a property</option>
                <option value="Immobilienbewertung">Property valuation</option>
                <option value="Projektentwicklung">Project development</option>
              </select>
            </div>
            <details class="form-more">
              <summary>More details (optional)</summary>
              <div class="form-group">
                <label for="email">E-mail</label>
                <input type="email" id="email" name="email" autocomplete="email">
              </div>
              <div class="form-group">
                <label for="message">Your message</label>
                <textarea id="message" name="message" placeholder="Briefly describe your request …"></textarea>
              </div>
            </details>
            <p class="form-note legal-request-note">${EN_PRIVACY("/")}</p>
            <button type="submit" class="btn btn-accent" id="contact-submit">Send message</button>
            <div id="form-success" class="form-success" role="status" hidden>Thank you. Helmut Eichmann will get back to you personally.</div>
            <div id="form-error" class="form-error" role="alert" hidden>
              Your message could not be sent. Please call or use WhatsApp: <a href="${TEL}">${C.phone_mobile.display}</a>.
              <button type="button" class="linkish" id="mailto-fallback">Open your e-mail program instead</button>
            </div>
          </form>
        </div>
      </div>
    </section>

    <section class="section section-alt">
      <div class="container narrow">
        <h2>How to find us</h2>
        <p>${C.address.street}, ${C.address.postal_code} ${C.address.city} – appointments by arrangement.</p>
        <p><a href="https://www.google.com/maps/search/?api=1&amp;query=Jacob-Burckhardt-Str.+40%2C+78464+Konstanz" target="_blank" rel="noopener noreferrer">Open in Google Maps</a></p>
      </div>
    </section>
  </main>
` + foot("contact");
}

/* ---------- /en/buying-from-abroad.html (Claude global concept, Code 2; unconfirmed permit sentence left out) ---------- */
function abroadPage() {
  const url = `${O}/en/buying-from-abroad.html`;
  const title = "Buying property in Konstanz from abroad | Eichmann";
  const desc = "Buying property in Konstanz from abroad: prices in euros, notarised purchase in Germany, personal support by Helmut Eichmann. Call +49 170 522 5568.";
  const jsonld = { "@context": "https://schema.org", "@graph": [
    { "@type": "WebPage", "@id": `${url}#webpage`, url, name: title, description: desc, inLanguage: "en",
      isPartOf: { "@id": `${O}/#website` }, about: { "@id": `${O}/#business` }, publisher: { "@id": `${O}/#business` },
      translationOfWork: { "@id": `${O}/kaufen-aus-der-schweiz.html#webpage` } },
    { "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: `${O}/en/` },
      { "@type": "ListItem", position: 2, name: "Buying from abroad", item: url } ] },
    BUSINESS ] };
  const props = enListingModels(ROOT);
  return head({ key: "abroad", title, desc, jsonld }) + `
  <main id="main">
    <section class="page-hero">
      <div class="container page-hero-inner">
        <h1>Buying property in Konstanz from abroad</h1>
        <p class="lead">Konstanz lies on Lake Constance, directly on the Swiss border. Helmut Eichmann assists buyers from abroad from the first call to the notary appointment.</p>
        <div class="hero-actions project-hero-actions">
          <a class="btn btn-accent btn-call" href="${TEL}" data-location="hero_number">Call <span class="nowrap">${C.phone_mobile.display}</span></a>
          <a class="btn btn-outline" href="${esc(WA_GEN)}" target="_blank" rel="noopener noreferrer">WhatsApp</a>
          <a class="btn btn-outline" href="/en/#listings">Current listings</a>
        </div>
        <p class="hero-links"><a href="/kaufen-aus-der-schweiz.html" hreflang="de" lang="de" data-lang-switch="de">Deutsch</a></p>
      </div>
    </section>

    <section class="section">
      <div class="container narrow prose">
        <h2>Good to know</h2>
        <ul class="check-list">
          <li><strong>Prices:</strong> all purchase prices are in euros.</li>
          <li><strong>Contract:</strong> a purchase in Germany is concluded before a notary.</li>
          <li><strong>Property transfer tax:</strong> 5.0 % of the purchase price in Baden-Württemberg (source: <a href="https://www.heidelberg.de/-/Verfahrensbeschreibung/grunderwerbsteuer-zahlen/vbid413" target="_blank" rel="noopener noreferrer" hreflang="de">service-bw</a>).</li>
          <li><strong>Commission:</strong> shown for each property. New-build Allmannsdorf is commission-free.</li>
        </ul>
        <p>For individual legal or tax questions, please consult the notary or your tax adviser. Helmut Eichmann answers your questions about the properties personally.</p>
      </div>
    </section>

    <section class="section section-alt">
      <div class="container narrow">
        <h2>Current properties</h2>
        <ul class="check-list">
${props.map((m) => `          <li><a href="${enPath(m.slug)}">${esc(m.name)}</a>${m.price ? ` – €${m.price.toLocaleString("en-GB")}` : ""}</li>`).join("\n")}
          <li><a href="/en/allmannsdorf.html">New-build Allmannsdorf</a> – commission-free, register your interest</li>
        </ul>
      </div>
    </section>
  </main>
` + foot("abroad");
}

await mkdir(path.join(ROOT, "en"), { recursive: true });
await writeFile(path.join(ROOT, "en/index.html"), await homePage());
await writeFile(path.join(ROOT, "en/allmannsdorf.html"), allmannsdorfPage());
await writeFile(path.join(ROOT, "en/contact.html"), contactPage());
await writeFile(path.join(ROOT, "en/buying-from-abroad.html"), abroadPage());
console.log("EN pages written: en/index.html, en/allmannsdorf.html, en/contact.html");

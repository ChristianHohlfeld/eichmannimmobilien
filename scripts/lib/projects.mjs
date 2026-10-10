/**
 * Flyer / Neubau projects — SoT → generated SEO pages + AI flyer JSON + sitemap.
 *
 * Source of truth: data/projects.json (not Immowelt listings).
 * Publish (via sync renderIntoPages / publish-from-db):
 *   - regenerates ai/flyer-{slug}.json for active projects
 *   - patches project HTML SEO head (markers) + facts body (markers)
 *   - returns sitemap URL rows for active projects
 *   - removes orphan flyer JSON + project pages when project gone or active=false
 *
 * Listings remain origin=immowelt|eigen via SQLite; this module never touches them.
 */
import { loadSot, projectsDocument } from "./sot.mjs";
import { vormerkFormHtml } from "./vormerk-form.mjs";
import { readFile, writeFile, readdir, unlink, access } from "node:fs/promises";
import path from "node:path";

export const PROJECTS_SOT_PATH = "data/sot/projects.json";
export const PROJECT_SEO_START = "<!-- PROJECT-SEO:START -->";
export const PROJECT_SEO_END = "<!-- PROJECT-SEO:END -->";
export const PROJECT_FACTS_START = "<!-- PROJECT-FACTS:START -->";
export const PROJECT_FACTS_END = "<!-- PROJECT-FACTS:END -->";
export const HOME_LISTINGS_JSONLD_START = "<!-- HOME-LISTINGS-JSONLD:START -->";
export const HOME_LISTINGS_JSONLD_END = "<!-- HOME-LISTINGS-JSONLD:END -->";
export const SITEMAP_PROJECT_START = "<!-- PROJECT-SITEMAP:START -->";
export const SITEMAP_PROJECT_END = "<!-- PROJECT-SITEMAP:END -->";

const DEFAULT_ORIGIN = "https://immobilieneichmann.de";
const BUSINESS_ID = `${DEFAULT_ORIGIN}/#business`;

/* Escaped text → known office numbers become click-to-call links (never other numbers). */
function linkifyContactPhones(html) {
  return String(html || "")
    .replace(/(?<![\d+])(?:\+49|0049|0)\s?170[\s\/-]?522[\s-]?55\s?68(?!\d)/g, (m) => `<a href="tel:+491705225568">${m}</a>`)
    .replace(/(?<![\d+])(?:\+49|0049|0)\s?7531[\s\/-]?9228848(?!\d)/g, (m) => `<a href="tel:+4975319228848">${m}</a>`);
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function absUrl(origin, rel) {
  const o = String(origin || DEFAULT_ORIGIN).replace(/\/$/, "");
  const r = String(rel || "").replace(/^\//, "");
  if (/^https?:\/\//i.test(rel)) return rel;
  return `${o}/${r}`;
}

function whatsappUrl(text, phoneE164 = "491705225568") {
  const q = encodeURIComponent(text || "");
  return `https://wa.me/${phoneE164}?text=${q}`;
}

export async function loadProjectsDocument(siteRoot) {
  // SSOT: data/sot/projects.json (Fakten mit Beleg + Platzhalter-Texte) → Kompatibilitäts-Dokument.
  const doc = projectsDocument(loadSot(siteRoot));
  if (!Array.isArray(doc.projects)) throw new Error("projects[] missing in SSOT");
  return doc;
}

/** Shorten at a word boundary (never mid-word), add … only if cut. */
export function shortenAtWord(text, max = 140) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1);
  const sentence = cut.lastIndexOf(". ");
  if (sentence >= max * 0.5) return cut.slice(0, sentence + 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > 0 ? cut.slice(0, sp) : t.slice(0, max)).replace(/[\s,;:–-]+$/, "") + " …";
}

export function activeProjects(doc) {
  return (doc?.projects || []).filter((p) => p && p.active !== false && p.slug);
}

export function projectPagePath(project) {
  return project?.pages?.html || `${project.slug}.html`;
}

export function toPublicFlyerJson(project, { origin = DEFAULT_ORIGIN } = {}) {
  const o = String(origin || DEFAULT_ORIGIN).replace(/\/$/, "");
  const page = projectPagePath(project);
  const contactPath = project.pages?.contact_vormerkung || `kontakt.html?interesse=${project.slug}#contact-form`;
  const wa = whatsappUrl(project.cta?.whatsapp_text);
  const waEn = project.cta?.whatsapp_text_en ? whatsappUrl(project.cta.whatsapp_text_en) : null;
  const img = project.images || {};
  const absImg = (entry) => {
    if (!entry) return null;
    return {
      jpg: entry.jpg ? absUrl(o, entry.jpg) : undefined,
      webp: entry.webp ? absUrl(o, entry.webp) : undefined,
    };
  };
  return {
    schema: "eichmann.flyer.ai/v1",
    id: project.id,
    slug: project.slug,
    kind: project.kind || "neubau_vormerkung",
    title: project.title,
    language: "de",
    site: `${o}/`,
    pages: {
      project: absUrl(o, page),
      ...(project.pages?.html_en ? { project_en: absUrl(o, project.pages.html_en), contact_en: absUrl(o, "en/contact.html?interesse=" + project.slug) } : {}),
      projekte: absUrl(o, project.pages?.projekte || "projekte.html"),
      contact_vormerkung: absUrl(o, contactPath),
      flyer_modal_on: (project.pages?.flyer_modal_on || ["index.html"]).map((p) =>
        p === "/" ? `${o}/` : absUrl(o, p)
      ),
    },
    summary: project.summary,
    description: project.description,
    unit_count: project.unit_count,
    building_count: project.building_count,
    building_type: project.building_type,
    specs: project.specs,
    features: project.features || [],
    checks: project.checks || [],
    images: {
      hero: absImg(img.hero),
      living: absImg(img.living),
      dining_detail: absImg(img.dining_detail),
    },
    cta: {
      phone: project.cta?.phone || "+49 170 5225568",
      email: project.cta?.email || "info@immobilien-eichmann.com",
      email_subject: project.cta?.email_subject || project.title,
      anliegen: project.cta?.anliegen || project.title,
      whatsapp: wa,
      ...(waEn ? { whatsapp_en: waEn } : {}),
    },
    notes: project.notes || [],
    source: [PROJECTS_SOT_PATH, page, "assets/flyer/*"],
    contact: {
      phone_mobile: "+49 170 522 5568",
      tel: "tel:+491705225568",
      phone_landline: "+49 7531 9228848",
      tel_landline: "tel:+4975319228848",
      whatsapp: wa,
      email: project.cta?.email || "info@immobilien-eichmann.com",
      email_mailto: `mailto:${project.cta?.email || "info@immobilien-eichmann.com"}`,
      source: absUrl(o, "kontakt.html"),
    },
    agent_guidance:
      "Bei Interesse dem Menschen tel:+491705225568 und WhatsApp-Link zum Tippen zeigen. Agent darf nicht selbst anrufen oder WhatsApp/E-Mail senden (Anti-Spam). Anfragen schickt der Mensch selbst (Telefon, WhatsApp oder Kontaktformular).",
  };
}

export function projectsForAiIndex(doc, { origin = DEFAULT_ORIGIN } = {}) {
  const o = String(origin || DEFAULT_ORIGIN).replace(/\/$/, "");
  return activeProjects(doc).map((p) => ({
    id: p.id,
    slug: p.slug,
    kind: p.kind || "neubau_vormerkung",
    title: p.title,
    unit_count: p.unit_count,
    building_count: p.building_count,
    location: p.location || p.specs?.lage,
    living_area_range: p.specs?.flaechen,
    rooms_range: p.specs?.zimmer,
    price_range: p.specs?.preise,
    provisionsfrei: /JA/i.test(String(p.specs?.provision || "")),
    url: absUrl(o, projectPagePath(p)),
    ...(p.pages?.html_en ? { url_en: absUrl(o, p.pages.html_en) } : {}),
    flyer: absUrl(o, `ai/flyer-${p.slug}.json`),
    vormerkung_url: absUrl(o, p.pages?.contact_vormerkung || `kontakt.html?interesse=${p.slug}#contact-form`),
    short_description:
      shortenAtWord(p.summary, 140) ||
      `${p.building_count || ""} ${p.building_type || ""} mit ${p.unit_count || ""} Wohnungen`.trim(),
    mcp_next: ["get_flyer", "get_contact"],
    contact_hint:
      "Mensch: tel:+491705225568 oder WhatsApp wa.me/491705225568 – Agent sendet nicht selbst.",
  }));
}

function projectImages(project, o) {
  const img = project.images || {};
  const gallery = Array.isArray(project.gallery) && project.gallery.length
    ? project.gallery
    : Object.keys(img).map((key) => ({ key }));
  return gallery
    .map((g) => ({ ...g, entry: img[g.key] }))
    .filter((g) => g.entry && g.entry.jpg)
    .map((g) => ({
      key: g.key,
      jpg: g.entry.jpg,
      webp: g.entry.webp,
      abs: absUrl(o, g.entry.jpg),
      alt: g.alt || project.title,
      caption: g.caption || "",
    }));
}

function projectOgImage(project, o) {
  const og = project.og_image;
  if (og && og.jpg) {
    return {
      url: absUrl(o, og.jpg),
      width: og.width || 1200,
      height: og.height || 630,
      alt: og.alt || project.page_title || project.title,
    };
  }
  return {
    url: `${o}/assets/share-card-plain-v2.jpg`,
    width: 1200,
    height: 630,
    alt: project.page_title || project.title,
  };
}

/** Plain-text FAQ answers only (no HTML) — same text visible on page + FAQPage JSON-LD. */
function projectFaq(project) {
  return (project.faq || []).filter((f) => f && f.q && f.a);
}

export function buildProjectJsonLd(project, { origin = DEFAULT_ORIGIN, updatedAt } = {}) {
  const o = String(origin || DEFAULT_ORIGIN).replace(/\/$/, "");
  const page = projectPagePath(project);
  const url = absUrl(o, page);
  const images = projectImages(project, o);
  const hero = images[0]?.abs || `${o}/assets/share-card-plain-v2.jpg`;
  const imageList = images.length ? images.map((i) => i.abs) : [hero];
  const og = projectOgImage(project, o);
  const low = project.price_eur?.low;
  const high = project.price_eur?.high;
  const currency = project.price_eur?.currency || "EUR";
  const modified = project.updated_at || updatedAt || undefined;

  const business = {
    "@type": ["RealEstateAgent", "LocalBusiness"],
    "@id": BUSINESS_ID,
    name: "Immobilien Eichmann",
    url: `${o}/`,
    logo: `${o}/assets/logo.svg?v=house-orig-v1`,
    image: `${o}/assets/share-card-plain-v2.jpg`,
    telephone: ["+491705225568", "+4975319228848"],
    email: project.cta?.email || "info@immobilien-eichmann.com",
    address: {
      "@type": "PostalAddress",
      streetAddress: "Jacob-Burckhardt-Str. 40",
      addressLocality: "Konstanz",
      postalCode: "78464",
      addressCountry: "DE",
    },
    founder: { "@type": "Person", name: "Helmut Eichmann" },
    areaServed: ["Konstanz", "Allmannsdorf", "Bodensee"],
  };

  const webpage = {
    "@type": "WebPage",
    "@id": `${url}#webpage`,
    url,
    name: project.page_title || project.title,
    description: project.meta_description || project.summary || undefined,
    inLanguage: "de-DE",
    isPartOf: { "@id": `${o}/#website` },
    primaryImageOfPage: { "@type": "ImageObject", url: og.url, width: og.width, height: og.height },
    breadcrumb: { "@id": `${url}#breadcrumb` },
    about: { "@id": `${url}#complex` },
    mainEntity: { "@id": `${url}#listing` },
    publisher: { "@id": BUSINESS_ID },
    dateModified: modified,
  };

  const listing = {
    "@type": "RealEstateListing",
    "@id": `${url}#listing`,
    name: project.title,
    description: project.description || project.summary,
    url,
    image: imageList,
    inLanguage: "de-DE",
    provider: { "@id": BUSINESS_ID },
    about: { "@id": `${url}#complex` },
  };
  if (low != null && high != null) {
    listing.offers = {
      "@type": "AggregateOffer",
      lowPrice: String(low),
      highPrice: String(high),
      priceCurrency: currency,
      offerCount: String(project.unit_count || 1),
      offeredBy: { "@id": BUSINESS_ID },
      url: absUrl(o, project.pages?.contact_vormerkung || `kontakt.html?interesse=${project.slug}#contact-form`),
    };
  }

  const complex = {
    "@type": "ApartmentComplex",
    "@id": `${url}#complex`,
    name: project.title,
    description: project.description || project.summary,
    url,
    image: imageList,
    numberOfAccommodationUnits: project.unit_count,
    address: {
      "@type": "PostalAddress",
      addressLocality: "Konstanz",
      addressRegion: "Baden-Württemberg",
      postalCode: "78464",
      addressCountry: "DE",
    },
    // schema.org has no addressNeighborhood → neighbourhood as containing Place.
    containedInPlace: {
      "@type": "Place",
      name: project.location || project.specs?.lage || "Konstanz-Allmannsdorf",
      containedInPlace: { "@type": "City", name: "Konstanz" },
    },
  };
  const area = project.area_m2;
  const rooms = project.rooms;
  if (area || rooms) {
    const apt = { "@type": "Apartment", name: `Eigentumswohnungen ${project.location || ""}`.trim() };
    if (area && area.min != null && area.max != null) {
      apt.floorSize = { "@type": "QuantitativeValue", minValue: area.min, maxValue: area.max, unitCode: "MTK" };
    }
    if (rooms && rooms.min != null && rooms.max != null) {
      apt.numberOfRooms = { "@type": "QuantitativeValue", minValue: rooms.min, maxValue: rooms.max };
    }
    complex.containsPlace = apt;
  }
  const amenity = (project.features || []).filter((f) => /lift|tiefgarage|barriere/i.test(f));
  if (amenity.length) {
    complex.amenityFeature = amenity.map((name) => ({ "@type": "LocationFeatureSpecification", name, value: true }));
  }

  const crumbs = {
    "@type": "BreadcrumbList",
    "@id": `${url}#breadcrumb`,
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Startseite", item: `${o}/` },
      { "@type": "ListItem", position: 2, name: "Projekte", item: absUrl(o, project.pages?.projekte || "projekte.html") },
      { "@type": "ListItem", position: 3, name: project.breadcrumb_name || "Neubau Allmannsdorf", item: url },
    ],
  };

  const graph = [webpage, listing, complex, crumbs, business];
  const faq = projectFaq(project);
  if (faq.length) {
    graph.push({
      "@type": "FAQPage",
      "@id": `${url}#faq`,
      mainEntity: faq.map((f) => ({
        "@type": "Question",
        name: f.q,
        acceptedAnswer: { "@type": "Answer", text: f.a },
      })),
    });
  }

  return {
    "@context": "https://schema.org",
    "@graph": graph,
  };
}

export function buildProjectSeoHead(project, { origin = DEFAULT_ORIGIN, updatedAt } = {}) {
  const o = String(origin || DEFAULT_ORIGIN).replace(/\/$/, "");
  const page = projectPagePath(project);
  const url = absUrl(o, page);
  const title = project.page_title || `${project.title} | Immobilien Eichmann`;
  const desc = project.meta_description || project.summary || project.description || "";
  const og = projectOgImage(project, o);
  const ld = buildProjectJsonLd(project, { origin: o, updatedAt });
  // JSON-LD inside <script>: escape "<" / "&" (valid JSON, HTML-safe, test-jsonld clean).
  const ldJson = JSON.stringify(ld, null, 2).replace(/</g, "\\u003c").replace(/&/g, "\\u0026");
  return `${PROJECT_SEO_START}
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(desc)}">
  <meta name="robots" content="index,follow,max-image-preview:large">
  <link rel="canonical" href="${escapeHtml(url)}">
${project.pages?.html_en ? `  <link rel="alternate" hreflang="de" href="${escapeHtml(url)}">
  <link rel="alternate" hreflang="en" href="${escapeHtml(absUrl(o, project.pages.html_en))}">
  <link rel="alternate" hreflang="x-default" href="${escapeHtml(url)}">
` : ""}  <meta property="og:type" content="website">
  <meta property="og:locale" content="de_DE">
  <meta property="og:locale:alternate" content="de_CH">${project.pages?.html_en ? `
  <meta property="og:locale:alternate" content="en_GB">` : ""}
  <meta property="og:site_name" content="Immobilien Eichmann">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(desc)}">
  <meta property="og:url" content="${escapeHtml(url)}">
  <meta property="og:image" content="${escapeHtml(og.url)}">
  <meta property="og:image:width" content="${og.width}">
  <meta property="og:image:height" content="${og.height}">
  <meta property="og:image:alt" content="${escapeHtml(og.alt)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(desc)}">
  <meta name="twitter:image" content="${escapeHtml(og.url)}">
  <meta name="twitter:image:alt" content="${escapeHtml(og.alt)}">
  <script type="application/ld+json">
${ldJson}
  </script>
${PROJECT_SEO_END}`;
}

export function buildProjectFactsHtml(project) {
  const specs = project.specs || {};
  const features = project.features || [];
  const contact = project.pages?.contact_vormerkung || `kontakt.html?interesse=${project.slug}#contact-form`;
  const projekte = project.pages?.projekte || "projekte.html";
  const crumbName = project.breadcrumb_name || "Neubau Allmannsdorf";
  const cards = [
    { icon: String(project.building_count || specs.gebaeude || ""), h: "Gebäude", p: specs.gebaeude || "" },
    { icon: String(project.unit_count || ""), h: "Wohnungen", p: specs.einheiten || specs.highlight || "" },
    { icon: "m²", h: "Flächen", p: `${specs.flaechen || ""}${specs.zimmer ? `, ${specs.zimmer} Zimmer` : ""}`.trim() },
    { icon: "€", h: "Preise", p: `${specs.preise || ""}${specs.provision ? ` · ${specs.provision.replace(/: JA$/i, "")}` : ""}`.trim() },
  ];
  if (specs.grundstueck) {
    cards.push({ icon: "⌂", h: "Grundstück", p: specs.grundstueck });
  }
  const featureLis = features.map((f) => `            <li>${escapeHtml(f)}</li>`).join("\n");
  const images = projectImages(project, DEFAULT_ORIGIN);
  const galleryHtml = images.length
    ? `
    <section class="section" aria-labelledby="projekt-bilder-title">
      <div class="container">
        <div class="section-head">
          <div>
            <h2 id="projekt-bilder-title">Einblicke in den Neubau</h2>
            <p>Abbildungen aus dem Projektflyer.</p>
          </div>
        </div>
        <div class="project-gallery">
${images
  .map((im, i) => {
    const w = im.key === "hero" ? 520 : 300;
    const h = im.key === "hero" ? 550 : 260;
    return `          <figure class="project-gallery-item">
            <a href="#flyerModal" data-open-flyer aria-label="${escapeHtml(im.alt)} – Flyer öffnen">
              <picture>
${im.webp ? `                <source srcset="${escapeHtml(im.webp)}" type="image/webp">\n` : ""}                <img src="${escapeHtml(im.jpg)}" alt="${escapeHtml(im.alt)}" width="${w}" height="${h}" loading="lazy" decoding="async">
              </picture>
            </a>
${im.caption ? `            <figcaption>${escapeHtml(im.caption)}</figcaption>\n` : ""}          </figure>`;
  })
  .join("\n")}
        </div>
      </div>
    </section>
`
    : "";
  const locParas = (project.location_text || []).map((t) => `        <p>${escapeHtml(t)}</p>`).join("\n");
  const locationHtml = locParas
    ? `
    <section class="section" aria-labelledby="lage-title">
      <div class="container narrow prose">
        <h2 id="lage-title">Wohnen in Konstanz-Allmannsdorf</h2>
${locParas}
        <p>Mehr zur Stadt: <a href="konstanz.html">Immobilien in Konstanz</a> · <a href="wohnung-kaufen-konstanz.html">Wohnung kaufen in Konstanz</a> · <a href="${escapeHtml(projekte)}">alle Projekte &amp; Angebote</a>.</p>
      </div>
    </section>
`
    : "";
  const faq = projectFaq(project);
  const faqHtml = faq.length
    ? `
    <section class="section section-alt" id="faq" aria-labelledby="faq-title">
      <div class="container narrow">
        <h2 id="faq-title">Häufige Fragen zum Neubau Allmannsdorf</h2>
        <div class="faq-list">
${faq
  .map(
    (f) => `          <details class="faq-item">
            <summary>${escapeHtml(f.q)}</summary>
            <p>${linkifyContactPhones(escapeHtml(f.a))}</p>
          </details>`
  )
  .join("\n")}
        </div>
      </div>
    </section>
`
    : "";
  return `${PROJECT_FACTS_START}
    <nav class="breadcrumb container" aria-label="Brotkrumen">
      <ol>
        <li><a href="/">Startseite</a></li>
        <li><a href="${escapeHtml(projekte)}">Projekte</a></li>
        <li aria-current="page">${escapeHtml(crumbName)}</li>
      </ol>
    </nav>
    <section class="page-hero">
      <div class="container page-hero-inner">
        <span class="eyebrow">Neubau · ${escapeHtml((project.location || "Allmannsdorf").replace(/^Konstanz-/, ""))} · Provisionsfrei</span>
        <h1>${escapeHtml(project.h1 || project.title)}</h1>
        <p class="lead">${escapeHtml(project.lead || project.summary || "")}</p>
        <div class="hero-actions project-hero-actions">
          <a class="btn btn-accent hero-cta-call" href="tel:+491705225568" aria-label="Anrufen: +49 170 522 5568">Anrufen</a>
          <a class="btn btn-outline hero-cta-vormerken" href="#vormerken" data-focus-form="vormerk-projekt">Vormerken</a>
        </div>
        <p class="hero-links"><button type="button" class="linkish" data-open-flyer>Flyer öffnen</button> · <a href="tel:+491705225568">+49 170 522 5568</a> · <span class="nowrap">Festnetz <a href="tel:+4975319228848">+49 7531 9228848</a></span></p>
      </div>
    </section>

    <section class="section vormerk-section" id="vormerken" aria-label="Vormerken">
      <div class="container narrow">
${vormerkFormHtml({ id: "vormerk-projekt", location: "project_inline", lang: "de", heading: "h2", indent: "        " })}
      </div>
    </section>

    <section class="section">
      <div class="container narrow">
        <p class="prose-lead">${escapeHtml(project.description || project.summary || "")}</p>
      </div>
    </section>

    <section class="section section-alt">
      <div class="container">
        <div class="section-head">
          <div>
            <h2>Projekt auf einen Blick</h2>
            <p>Die wichtigsten Eckdaten des Neubauensembles.</p>
          </div>
        </div>
        <div class="services-strip services-strip-auto">
${cards
  .map(
    (c) =>
      `          <article class="service-card"><div class="icon" aria-hidden="true">${escapeHtml(c.icon)}</div><h3>${escapeHtml(c.h)}</h3><p>${escapeHtml(c.p)}</p></article>`
  )
  .join("\n")}
        </div>
      </div>
    </section>
${galleryHtml}
    <section class="section${galleryHtml ? " section-alt" : ""}">
      <div class="container">
        <div class="section-head">
          <div>
            <h2>Ausstattung &amp; Lage</h2>
            <p>${escapeHtml(specs.highlight || "Komfort und Qualität in gefragter Wohnlage.")}</p>
          </div>
        </div>
        <ul class="check-list">
${featureLis}
        </ul>
        <p class="immowelt-note">Angaben ohne Gewähr. Stand aus Projektdaten (Flyer). Vormerkung: <a href="${escapeHtml(contact)}">Kontakt</a>.</p>
      </div>
    </section>
${locationHtml}${faqHtml}${PROJECT_FACTS_END}`;
}

function patchBetween(html, start, end, inner) {
  const a = html.indexOf(start);
  const b = html.indexOf(end);
  if (a < 0 || b < 0 || b < a) {
    throw new Error(`Markers missing: ${start} … ${end}`);
  }
  return html.slice(0, a) + inner + html.slice(b + end.length);
}

export function buildHomeListingsItemList(listings, { origin = DEFAULT_ORIGIN } = {}) {
  const o = String(origin || DEFAULT_ORIGIN).replace(/\/$/, "");
  const publicOnes = (listings || []).filter(
    (L) => L && L.active !== false && L.site_hidden !== true && L.detail_page !== false
  );
  const elements = publicOnes.map((L, i) => ({
    "@type": "ListItem",
    position: i + 1,
    name: L.title,
    url: absUrl(o, L.local_url || `objekt/${L.slug}.html`),
    item: {
      "@type": "RealEstateListing",
      name: L.title,
      url: absUrl(o, L.local_url || `objekt/${L.slug}.html`),
      offers: L.price
        ? {
            "@type": "Offer",
            price: String(L.price).replace(/[^\d]/g, "") || undefined,
            priceCurrency: "EUR",
          }
        : undefined,
    },
  }));
  return {
    "@type": "ItemList",
    "@id": `${o}/#angebote-list`,
    name: "Aktuelle Kaufangebote – Immobilien Eichmann",
    numberOfItems: elements.length,
    itemListElement: elements,
  };
}

/** Patch homepage @graph to include/replace ItemList of public listings. */
export function patchHomeListingsJsonLd(indexHtml, listings, { origin = DEFAULT_ORIGIN } = {}) {
  const itemList = buildHomeListingsItemList(listings, { origin });
  const re =
    /(<script type="application\/ld\+json">\s*)([\s\S]*?)(\s*<\/script>)/;
  const m = indexHtml.match(re);
  if (!m) throw new Error("index.html: homepage JSON-LD script not found");
  const doc = JSON.parse(m[2]);
  if (!doc["@graph"] || !Array.isArray(doc["@graph"])) {
    throw new Error("index.html: JSON-LD @graph missing");
  }
  doc["@graph"] = doc["@graph"].filter((n) => n?.["@id"] !== itemList["@id"] && n?.["@type"] !== "ItemList");
  doc["@graph"].push(itemList);
  const block = `${m[1]}${JSON.stringify(doc, null, 2)}${m[3]}`;
  return indexHtml.replace(re, () => block);
}

export async function publishProjects(opts = {}) {
  const siteRoot = opts.siteRoot;
  if (!siteRoot) throw new Error("publishProjects: siteRoot required");
  const origin = opts.origin || DEFAULT_ORIGIN;
  const dryRun = Boolean(opts.dryRun);
  const listings = opts.listings || [];

  const doc = await loadProjectsDocument(siteRoot);
  const active = activeProjects(doc);
  const keepSlugs = new Set(active.map((p) => p.slug));
  const aiDir = path.join(siteRoot, "ai");

  for (const project of active) {
    const flyer = toPublicFlyerJson(project, { origin });
    const flyerPath = path.join(aiDir, `flyer-${project.slug}.json`);
    if (!dryRun) {
      await writeFile(flyerPath, `${JSON.stringify(flyer, null, 2)}\n`, "utf8");
    }
    console.log(`Updated ai/flyer-${project.slug}.json`);

    const pageRel = projectPagePath(project);
    const pagePath = path.join(siteRoot, pageRel);
    let html = await readFile(pagePath, "utf8");
    if (!html.includes(PROJECT_SEO_START) || !html.includes(PROJECT_SEO_END)) {
      throw new Error(`${pageRel}: missing PROJECT-SEO markers`);
    }
    if (!html.includes(PROJECT_FACTS_START) || !html.includes(PROJECT_FACTS_END)) {
      throw new Error(`${pageRel}: missing PROJECT-FACTS markers`);
    }
    html = patchBetween(
      html,
      PROJECT_SEO_START,
      PROJECT_SEO_END,
      buildProjectSeoHead(project, { origin, updatedAt: doc.updated_at })
    );
    html = patchBetween(html, PROJECT_FACTS_START, PROJECT_FACTS_END, buildProjectFactsHtml(project));

    if (!dryRun) await writeFile(pagePath, html, "utf8");
    console.log(`Updated project page ${pageRel}`);
  }

  // Orphan flyer JSON
  let aiFiles = [];
  try {
    aiFiles = await readdir(aiDir);
  } catch {
    aiFiles = [];
  }
  for (const f of aiFiles) {
    const m = /^flyer-(.+)\.json$/.exec(f);
    if (!m) continue;
    if (!keepSlugs.has(m[1])) {
      console.log(`Removing orphan flyer ${f}`);
      if (!dryRun) await unlink(path.join(aiDir, f));
    }
  }

  // Orphan project pages: only delete files that were generated/managed (slug.html present in previous SoT history).
  // Conservative: delete slug.html only if slug matches known managed pattern and not in keepSlugs,
  // and file contains PROJECT-SEO markers (managed).
  const candidates = ["allmannsdorf.html"]; // managed project pages whitelist + any active slug.html
  for (const p of doc.projects || []) {
    if (p?.pages?.html) candidates.push(p.pages.html);
    if (p?.slug) candidates.push(`${p.slug}.html`);
  }
  const uniquePages = [...new Set(candidates)];
  for (const rel of uniquePages) {
    const slug = rel.replace(/\.html$/, "");
    if (keepSlugs.has(slug)) continue;
    const fp = path.join(siteRoot, rel);
    try {
      await access(fp);
    } catch {
      continue;
    }
    const html = await readFile(fp, "utf8");
    if (!html.includes(PROJECT_SEO_START) && !html.includes("Neubauprojekt")) {
      continue;
    }
    console.log(`Removing orphan project page ${rel}`);
    if (!dryRun) await unlink(fp);
  }

  // Homepage ItemList from public listings
  const indexPath = path.join(siteRoot, "index.html");
  let indexHtml = await readFile(indexPath, "utf8");
  indexHtml = patchHomeListingsJsonLd(indexHtml, listings, { origin });
  if (!dryRun) await writeFile(indexPath, indexHtml, "utf8");
  console.log("Updated homepage ItemList JSON-LD from public listings");

  return {
    active,
    sitemapPaths: active.map((p) => ({
      loc: `/${projectPagePath(p)}`,
      priority: "0.9",
      changefreq: "weekly",
      images: [
        ...projectImages(p, origin).map((im) => im.abs),
        ...(p.og_image?.jpg ? [absUrl(origin, p.og_image.jpg)] : []),
      ],
    })),
    aiProjects: projectsForAiIndex(doc, { origin }),
    project_unit_count_total: active.reduce((n, p) => n + (Number(p.unit_count) || 0), 0),
  };
}

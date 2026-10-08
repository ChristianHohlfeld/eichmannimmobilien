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
import { readFile, writeFile, readdir, unlink, access } from "node:fs/promises";
import path from "node:path";

export const PROJECTS_SOT_PATH = "data/projects.json";
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
  const fp = path.join(siteRoot, PROJECTS_SOT_PATH);
  const raw = await readFile(fp, "utf8");
  const doc = JSON.parse(raw);
  if (!doc || doc.schema !== "eichmann.projects.sot/v1") {
    throw new Error(`Invalid projects SoT schema at ${fp}`);
  }
  if (!Array.isArray(doc.projects)) {
    throw new Error(`projects[] missing in ${fp}`);
  }
  return doc;
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
    flyer: absUrl(o, `ai/flyer-${p.slug}.json`),
    vormerkung_url: absUrl(o, p.pages?.contact_vormerkung || `kontakt.html?interesse=${p.slug}#contact-form`),
    short_description:
      p.summary?.slice(0, 140) ||
      `${p.building_count || ""} ${p.building_type || ""} mit ${p.unit_count || ""} Wohnungen`.trim(),
    mcp_next: ["get_flyer", "get_contact"],
    contact_hint:
      "Mensch: tel:+491705225568 oder WhatsApp wa.me/491705225568 – Agent sendet nicht selbst.",
  }));
}

export function buildProjectJsonLd(project, { origin = DEFAULT_ORIGIN } = {}) {
  const o = String(origin || DEFAULT_ORIGIN).replace(/\/$/, "");
  const page = projectPagePath(project);
  const url = absUrl(o, page);
  const hero = project.images?.hero?.jpg ? absUrl(o, project.images.hero.jpg) : `${o}/assets/share-card-plain-v2.jpg`;
  const low = project.price_eur?.low;
  const high = project.price_eur?.high;
  const currency = project.price_eur?.currency || "EUR";

  const listing = {
    "@type": "RealEstateListing",
    "@id": `${url}#listing`,
    name: project.title,
    description: project.description || project.summary,
    url,
    image: hero,
    datePosted: project.updated_at || undefined,
    provider: { "@id": BUSINESS_ID },
  };
  if (low != null && high != null) {
    listing.offers = {
      "@type": "AggregateOffer",
      lowPrice: String(low),
      highPrice: String(high),
      priceCurrency: currency,
      offerCount: String(project.unit_count || 1),
      availability: "https://schema.org/InStock",
    };
  }

  const complex = {
    "@type": "ApartmentComplex",
    "@id": `${url}#complex`,
    name: project.title,
    description: project.description || project.summary,
    url,
    image: hero,
    numberOfAccommodationUnits: project.unit_count,
    address: {
      "@type": "PostalAddress",
      addressLocality: "Konstanz",
      addressRegion: "Baden-Württemberg",
      postalCode: "78464",
      addressCountry: "DE",
      addressNeighborhood: project.location || project.specs?.lage || "Allmannsdorf",
    },
  };

  const crumbs = {
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: `${o}/` },
      { "@type": "ListItem", position: 2, name: project.h1 || project.title, item: url },
    ],
  };

  return {
    "@context": "https://schema.org",
    "@graph": [listing, complex, crumbs],
  };
}

export function buildProjectSeoHead(project, { origin = DEFAULT_ORIGIN } = {}) {
  const o = String(origin || DEFAULT_ORIGIN).replace(/\/$/, "");
  const page = projectPagePath(project);
  const url = absUrl(o, page);
  const title = project.page_title || `${project.title} | Immobilien Eichmann`;
  const desc = project.meta_description || project.summary || project.description || "";
  const shareImg = `${o}/assets/share-card-plain-v2.jpg`;
  const ld = buildProjectJsonLd(project, { origin: o });
  return `${PROJECT_SEO_START}
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(desc)}">
  <meta name="robots" content="index,follow">
  <link rel="canonical" href="${escapeHtml(url)}">
  <meta property="og:type" content="website">
  <meta property="og:locale" content="de_DE">
  <meta property="og:site_name" content="Immobilien Eichmann">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(desc)}">
  <meta property="og:url" content="${escapeHtml(url)}">
  <meta property="og:image" content="${escapeHtml(shareImg)}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="${escapeHtml(title)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(desc)}">
  <meta name="twitter:image" content="${escapeHtml(shareImg)}">
  <meta name="twitter:image:alt" content="${escapeHtml(title)}">
  <script type="application/ld+json">
${JSON.stringify(ld, null, 2)}
  </script>
${PROJECT_SEO_END}`;
}

export function buildProjectFactsHtml(project) {
  const specs = project.specs || {};
  const features = project.features || [];
  const contact = project.pages?.contact_vormerkung || `kontakt.html?interesse=${project.slug}#contact-form`;
  const cards = [
    { icon: String(project.building_count || specs.gebaeude || ""), h: "Gebäude", p: specs.gebaeude || "" },
    { icon: String(project.unit_count || ""), h: "Wohnungen", p: specs.einheiten || specs.highlight || "" },
    { icon: "m²", h: "Flächen", p: `${specs.flaechen || ""}${specs.zimmer ? `, ${specs.zimmer} Zimmer` : ""}`.trim() },
    { icon: "€", h: "Preise", p: `${specs.preise || ""}${specs.provision ? ` · ${specs.provision.replace(/: JA$/i, "")}` : ""}`.trim() },
  ];
  const featureLis = features.map((f) => `            <li>${escapeHtml(f)}</li>`).join("\n");
  return `${PROJECT_FACTS_START}
    <section class="page-hero">
      <div class="container page-hero-inner">
        <span class="eyebrow">Neubau · ${escapeHtml((project.location || "Allmannsdorf").replace(/^Konstanz-/, ""))}</span>
        <h1>${escapeHtml(project.h1 || project.title)}</h1>
        <p class="lead">${escapeHtml(project.lead || project.summary || "")}</p>
        <div class="hero-actions">
          <a class="btn btn-accent" href="#flyerModal" data-open-flyer>Flyer öffnen</a>
          <a class="btn btn-outline" href="${escapeHtml(contact)}">Vormerken</a>
        </div>
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

    <section class="section">
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
${PROJECT_FACTS_END}`;
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
    html = patchBetween(html, PROJECT_SEO_START, PROJECT_SEO_END, buildProjectSeoHead(project, { origin }));
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
      priority: "0.8",
      changefreq: "weekly",
    })),
    aiProjects: projectsForAiIndex(doc, { origin }),
    project_unit_count_total: active.reduce((n, p) => n + (Number(p.unit_count) || 0), 0),
  };
}

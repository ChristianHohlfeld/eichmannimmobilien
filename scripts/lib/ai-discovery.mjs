/**
 * AI-friendly Angebots-Index + Discovery artifacts.
 *
 * Eine Quelle: dieselbe listings-Dokumentenliste wie HTML/Sitemap
 * (Filter: active !== false && site_hidden !== true && detail_page !== false).
 *
 * Geschrieben beim Publish (renderIntoPages) und via `npm run ai:index`.
 */
import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_SITE_ORIGIN = "https://immobilieneichmann.de";

export const NAP = Object.freeze({
  name: "Immobilien Eichmann",
  person: "Helmut Eichmann",
  street: "Jacob-Burckhardt-Str. 40",
  postalCode: "78464",
  city: "Konstanz",
  country: "DE",
  phone: ["+49 170 5225568", "+49 7531 9228848"],
  email: "info@immobilien-eichmann.com",
  website: DEFAULT_SITE_ORIGIN + "/",
});

/**
 * Live Kontakt-URLs aus Impressum/Kontakt (nicht erfinden).
 * Nur zum Anzeigen als Links für den Menschen – Agents dürfen nicht selbst anrufen/WhatsAppen.
 */
export const PUBLIC_CONTACT = Object.freeze({
  source_pages: {
    kontakt: DEFAULT_SITE_ORIGIN + "/kontakt.html",
    impressum: DEFAULT_SITE_ORIGIN + "/impressum.html",
  },
  person: "Helmut Eichmann",
  company: "Immobilien Eichmann",
  address: "Jacob-Burckhardt-Str. 40, 78464 Konstanz",
  email: "info@immobilien-eichmann.com",
  email_mailto: "mailto:info@immobilien-eichmann.com",
  phone_mobile: {
    display: "+49 170 522 5568",
    e164: "+491705225568",
    tel: "tel:+491705225568",
  },
  phone_landline: {
    display: "+49 7531 9228848",
    e164: "+4975319228848",
    tel: "tel:+4975319228848",
  },
  whatsapp: {
    display: "+49 170 522 5568",
    url:
      "https://wa.me/491705225568?text=Guten%20Tag%2C%20ich%20interessiere%20mich%20f%C3%BCr%20ein%20Objekt%20bzw.%20eine%20Beratung%20bei%20Immobilien%20Eichmann.",
    url_allmannsdorf:
      "https://wa.me/491705225568?text=Guten%20Tag%2C%20ich%20interessiere%20mich%20f%C3%BCr%20das%20Neubauprojekt%20Allmannsdorf.",
  },
});

/** Anti-Spam / Human-only Kontaktregeln für MCP-Instructions und Tool-Beschreibungen */
export const AGENT_CONTACT_RULES =
  "WICHTIG Anti-Spam: Agents dürfen NICHT selbst anrufen, WhatsApp-Nachrichten senden oder Formulare automatisch absenden. " +
  "Nur tel:/wa.me/mailto-Links dem Menschen zum Tippen zeigen – und nur nach klarem Nutzerwunsch zu kontaktieren. " +
  "Über MCP werden keine Anfragen versendet; Kontakt nur durch den Menschen selbst (Telefon, WhatsApp oder Kontaktformular https://immobilieneichmann.de/kontakt.html). Kein Bot-Spam.";

const STATIC_PAGE_LINKS = [
  ["Startseite", "/"],
  ["Aktuelle Angebote (HTML)", "/#angebote"],
  ["Leistungen", "/leistungen.html"],
  ["Projekte", "/projekte.html"],
  ["Kontakt", "/kontakt.html"],
  ["MCP verbinden", "/mcp.html"],
  ["Immobilienmakler Konstanz", "/immobilienmakler-konstanz.html"],
  ["Wohnung kaufen Konstanz", "/wohnung-kaufen-konstanz.html"],
  ["Haus verkaufen Konstanz", "/haus-verkaufen-konstanz.html"],
  ["Immobilienbewertung Konstanz", "/immobilienbewertung-konstanz.html"],
  ["Konstanz", "/konstanz.html"],
  ["Wollmatingen", "/wollmatingen.html"],
  ["Allmannsdorf", "/allmannsdorf.html"],
  ["Ratgeber", "/ratgeber.html"],
];

export function isPublicListing(listing) {
  return Boolean(listing) && listing.active !== false && listing.site_hidden !== true;
}

export function hasPublicDetail(listing) {
  return isPublicListing(listing) && listing.detail_page !== false;
}

function absUrl(origin, rel) {
  const base = String(origin || DEFAULT_SITE_ORIGIN).replace(/\/$/, "");
  const pathPart = String(rel || "").replace(/^\//, "");
  return pathPart ? `${base}/${pathPart}` : `${base}/`;
}

function parseEuroPrice(price) {
  if (price == null) return null;
  if (typeof price === "number" && Number.isFinite(price)) return price;
  const digits = String(price).replace(/[^\d]/g, "");
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

/**
 * Slim, AI-readable listing row (public detail pages only).
 * @param {object} L
 * @param {string} origin
 */
export function toAiListing(L, origin = DEFAULT_SITE_ORIGIN) {
  const local = L.local_url || (L.slug ? `objekt/${L.slug}.html` : null);
  const url = local ? absUrl(origin, local) : null;
  return {
    id: L.id || L.immowelt_id || null,
    slug: L.slug || null,
    url,
    local_url: local,
    title: L.title || null,
    price: L.price || null,
    price_eur: parseEuroPrice(L.price),
    location: L.location || null,
    rooms: L.rooms || null,
    living_area: L.living_area || null,
    plot_area: L.plot_area ?? null,
    type: L.type || null,
    status: L.status || "Kauf",
    short_description: L.short_description || null,
    origin: L.origin || L.source || null,
    image: L.main_image_url || null,
  };
}

/**
 * Build public AI index document from the same listing array used for HTML.
 */
export function buildAiListingsDocument(
  data,
  { origin = DEFAULT_SITE_ORIGIN, generatedAt = null, projects = null, project_unit_count_total = null } = {}
) {
  const all = Array.isArray(data?.listings) ? data.listings : [];
  const publicDetail = all.filter(hasPublicDetail).map((L) => toAiListing(L, origin));
  const at = generatedAt || new Date().toISOString();
  const projectRows = Array.isArray(projects) ? projects : [];
  const unitTotal =
    project_unit_count_total != null
      ? project_unit_count_total
      : projectRows.reduce((n, p) => n + (Number(p.unit_count) || 0), 0);
  return {
    schema: "eichmann.listings.ai/v1",
    description:
      "Aktuelle Kaufangebote von Immobilien Eichmann (Konstanz). Spiegel der Live-Website – keine zweite manuelle Liste.",
    site: absUrl(origin, "/"),
    language: "de",
    nap: { ...NAP, website: absUrl(origin, "/") },
    generated_at: at,
    source_export: absUrl(origin, "data/listings.json"),
    tools: {
      search_listings: {
        description:
          "Kaufangebote suchen/filtern. Bei Queries zu Neubau/Allmannsdorf/Wohnung Konstanz auch projects[] (Allmannsdorf 44 WE) – dann get_flyer + get_contact. Kein Suchwort 'Flyer' nötig.",
        resource: absUrl(origin, "ai/listings.json"),
      },
      get_listing: {
        description:
          "Ein Angebot per slug oder id aus listings[] wählen; Detailseite unter url.",
        resource: absUrl(origin, "ai/listings.json"),
        detail_pages: `${absUrl(origin, "objekt/")}<slug>.html`,
        full_export: absUrl(origin, "data/listings.json"),
      },
      get_flyer: {
        description:
          "Neubauprojekt Allmannsdorf (44 WE): Fakten + prominente Kontakt-Links (tel/WhatsApp). Für Wohnung/Neubau/Konstanz/Allmannsdorf nutzen – nicht auf Suchwort 'Flyer' warten. Nur Links zeigen, nicht selbst schreiben/anrufen.",
        resource: absUrl(origin, "ai/flyer-allmannsdorf.json"),
        page: absUrl(origin, "allmannsdorf.html"),
      },
      get_contact: {
        description:
          "Telefon, WhatsApp-Link und E-Mail aus Live-Impressum/Kontakt. Nur dem Menschen zum Tippen zeigen; Agent startet keine Calls/Nachrichten.",
        resource: absUrl(origin, "kontakt.html"),
      },
    },
    listing_count: publicDetail.length,
    listings: publicDetail,
    projects: projectRows,
    project_unit_count_total: unitTotal,
  };
}

export function buildLlmsTxt(aiDoc, { origin = DEFAULT_SITE_ORIGIN } = {}) {
  const o = String(origin || DEFAULT_SITE_ORIGIN).replace(/\/$/, "");
  const lines = [];
  lines.push(`# ${NAP.name}`);
  lines.push("");
  lines.push(`> Immobilienmakler in Konstanz / Bodensee. Sprache: de.`);
  lines.push(`> Live-Stand der Angebote = dieser Index (generiert aus derselben Quelle wie die Website).`);
  lines.push("");
  lines.push("## NAP / Kontakt (Helmut Eichmann)");
  lines.push("");
  lines.push(`- Name: ${NAP.name} · ${NAP.person}`);
  lines.push(`- Adresse: ${NAP.street}, ${NAP.postalCode} ${NAP.city}, Deutschland`);
  lines.push(`- Telefon (Mobil, bevorzugt): ${PUBLIC_CONTACT.phone_mobile.display} (${PUBLIC_CONTACT.phone_mobile.tel})`);
  lines.push(`- Festnetz: ${PUBLIC_CONTACT.phone_landline.display} (${PUBLIC_CONTACT.phone_landline.tel})`);
  lines.push(`- WhatsApp (Link für Menschen): ${PUBLIC_CONTACT.whatsapp.url}`);
  lines.push(`- E-Mail: ${NAP.email}`);
  lines.push(`- Web: ${o}/`);
  lines.push(`- ${AGENT_CONTACT_RULES}`);
  lines.push("");
  lines.push("## Angebots-Index (für AI / Agents)");
  lines.push("");
  lines.push(`- **AI-Index (schlank, nur öffentlich):** ${o}/ai/listings.json`);
  lines.push(`- **Voll-Export (Render-Spiegel):** ${o}/data/listings.json`);
  lines.push(`- **MCP-Discovery:** ${o}/.well-known/mcp.json`);
  lines.push(`- **MCP-Catalog:** ${o}/.well-known/mcp/catalog.json`);
  lines.push(`- **Server-Card (statisch):** ${o}/ai/server-card.json`);
  lines.push(`- **agents.txt:** ${o}/agents.txt`);
  lines.push(`- **Sitemap:** ${o}/sitemap.xml`);
  lines.push(`- Anzahl Kaufobjekte im Index: ${aiDoc.listing_count}`);
  lines.push(`- generiert: ${aiDoc.generated_at}`);
  lines.push("");
  lines.push("## MCP (Streamable HTTP)");
  lines.push("");
  lines.push(`- **Endpoint:** ${o}/mcp`);
  lines.push("- **Transport:** streamable-http (JSON-RPC POST)");
  lines.push("- Tools: `search_listings`, `get_listing`, `get_flyer`, `get_contact` — Listings = Live `ai/listings.json`; Flyer = `ai/flyer-allmannsdorf.json`");
  lines.push(`- ${AGENT_CONTACT_RULES}`);
  lines.push(`- Discovery: ${o}/.well-known/mcp.json`);
  lines.push("");
  lines.push("## MCP in Assistenten verbinden");
  lines.push("");
  lines.push(`- **Anleitung (Website):** ${o}/mcp.html`);
  lines.push("- **Claude (Deep-Link Custom Connector):** https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Immobilien%20Eichmann&connectorUrl=https%3A%2F%2Fimmobilieneichmann.de%2Fmcp");
  lines.push("- **ChatGPT:** Developer Mode / Apps → Remote MCP URL `https://immobilieneichmann.de/mcp` (keine Auth)");
  lines.push('- **Cursor / VS Code mcp.json:** `{"mcpServers":{"immobilien-eichmann":{"url":"https://immobilieneichmann.de/mcp"}}}`');
  lines.push("- **Official Registry:** `de.immobilieneichmann/listings`");
  lines.push("");
  lines.push("## JSON-Feeds (ohne MCP-Client)");
  lines.push("");
  lines.push("1. `search_listings` — `GET ai/listings.json`, dann `listings[]` filtern.");
  lines.push("2. `get_listing` — Eintrag per `slug`/`id` aus dem Index; Details unter `url`.");
  lines.push("");
  lines.push("## Neubau-Flyer Allmannsdorf (44 Wohnungen)");
  lines.push("");
  lines.push(`- **Flyer (JSON):** ${o}/ai/flyer-allmannsdorf.json`);
  lines.push(`- **Projektseite:** ${o}/allmannsdorf.html`);
  lines.push("- 5 Mehrfamilienhäuser · 44 Wohnungen · 40–124 m² · 2–5 Zimmer · 295.000–1.450.000 € · provisionsfrei");
  lines.push("- Bei Wohnung/Neubau/Konstanz/Allmannsdorf: `get_flyer` (kein Suchwort 'Flyer' nötig) → Kontakt-Links dem Menschen zeigen");
  lines.push("- MCP: `get_flyer` + `get_contact` (tel/WhatsApp nur tippen lassen). Vormerkung macht der Mensch selbst per Telefon, WhatsApp oder Kontaktformular.");
  lines.push("");
  lines.push("## Aktuelle Objekt-URLs");
  lines.push("");
  for (const L of aiDoc.listings || []) {
    if (!L?.url) continue;
    const price = L.price ? ` — ${L.price}` : "";
    const loc = L.location ? ` (${L.location})` : "";
    lines.push(`- [${L.title || L.slug}](${L.url})${loc}${price}`);
  }
  lines.push("");
  lines.push("## Wichtige Seiten");
  lines.push("");
  for (const [label, rel] of STATIC_PAGE_LINKS) {
    lines.push(`- ${label}: ${absUrl(o, rel === "/" ? "/" : rel.replace(/^\//, ""))}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function buildAgentsTxt({ origin = DEFAULT_SITE_ORIGIN } = {}) {
  const o = String(origin || DEFAULT_SITE_ORIGIN).replace(/\/$/, "");
  return `# agents.txt — Immobilien Eichmann
# Kurzregeln für AI-Agents. Angebotsstand = Live-Website.

User-Agent: *
Allow: /
Allow: /ai/listings.json
Allow: /ai/flyer-allmannsdorf.json
Allow: /data/listings.json
Allow: /objekt/
Allow: /allmannsdorf.html
Allow: /llms.txt
Allow: /.well-known/mcp.json
Allow: /.well-known/mcp/catalog.json
Allow: /ai/server-card.json
Allow: /mcp
Allow: /mcp.html
Disallow: /admin/

# Erlaubt: Lesen der öffentlichen Kaufangebote, Flyer-Fakten und NAP/Kontakt-Links.
# Erlaubt über MCP: get_flyer / get_contact (Links dem Menschen zeigen). Anfragen werden über MCP nicht versendet.
# Nicht erlaubt: Agent-initiierte Calls/WhatsApp/E-Mails, Formular-Spam, Admin-API, Secrets.
# Bei Wohnung/Neubau/Konstanz/Allmannsdorf → get_flyer (nicht auf Suchwort "Flyer" warten).

Contact: ${NAP.email}
Index: ${o}/ai/listings.json
Llms: ${o}/llms.txt
`;
}

/**
 * MCP discovery: live Streamable-HTTP at /mcp + JSON resource fallbacks.
 */
export function buildMcpDiscovery(aiDoc, { origin = DEFAULT_SITE_ORIGIN } = {}) {
  const o = String(origin || DEFAULT_SITE_ORIGIN).replace(/\/$/, "");
  return {
    schema_version: "eichmann.mcp-discovery/v1",
    name: "immobilien-eichmann-listings",
    title: "Immobilien Eichmann – Angebots-Index",
    description:
      "Live MCP: Kaufangebote + Neubau Allmannsdorf (get_flyer). Wohnung/Neubau/Konstanz → Flyer + tel/WhatsApp-Links für den Menschen (kein Agent-Spam). Keine Anfragen über MCP.",
    websiteUrl: `${o}/`,
    transport: {
      type: "streamable-http",
      url: `${o}/mcp`,
      note: "POST JSON-RPC an /mcp. Quelle = Live ai/listings.json (Publish-Pipeline).",
    },
    remotes: [
      {
        type: "streamable-http",
        url: `${o}/mcp`,
      },
    ],
    resources: [
      {
        name: "listings_index",
        uri: `${o}/ai/listings.json`,
        mimeType: "application/json",
        description: "Schlanker öffentlicher Angebots-Index (search_listings / get_listing) inkl. projects[].",
      },
      {
        name: "flyer_allmannsdorf",
        uri: `${o}/ai/flyer-allmannsdorf.json`,
        mimeType: "application/json",
        description: "Neubauprojekt-Flyer Allmannsdorf: 5 MFH, 44 Wohnungen (get_flyer).",
      },
      {
        name: "listings_full_export",
        uri: `${o}/data/listings.json`,
        mimeType: "application/json",
        description: "Vollständiger Render-Export (gleiche Quelle wie HTML).",
      },
      {
        name: "llms_txt",
        uri: `${o}/llms.txt`,
        mimeType: "text/plain",
        description: "Menschen-/AI-lesbare Einstiegsseite mit Objekt-URLs und NAP.",
      },
    ],
    tools: [
      {
        name: "search_listings",
        description:
          "Kaufangebote suchen. Bei neubau/allmannsdorf/wohnung konstanz auch projects[] Allmannsdorf → danach get_flyer + get_contact. Kein Suchwort 'Flyer' nötig.",
        inputSchema: {
          type: "object",
          properties: {
            q: {
              type: "string",
              description: "Freitext; z.B. neubau, allmannsdorf, wohnung konstanz",
            },
            min_price_eur: { type: "number" },
            max_price_eur: { type: "number" },
            rooms: { type: "string" },
            location: { type: "string" },
            type: { type: "string" },
            limit: { type: "number" },
          },
        },
      },
      {
        name: "get_listing",
        description: "Ein Angebot per slug oder id",
        inputSchema: {
          type: "object",
          properties: {
            slug: { type: "string" },
            id: { type: "string" },
          },
        },
      },
      {
        name: "get_flyer",
        description:
          "Neubau Allmannsdorf (44 WE) inkl. tel/WhatsApp-Links. Für Wohnung/Neubau/Konstanz/Allmannsdorf. Nur Links dem Menschen zeigen – Agent ruft/schreibt nicht.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "get_contact",
        description:
          "Telefon, WhatsApp-Link, E-Mail (Live Impressum/Kontakt). Nur dem Menschen zum Tippen; nie Agent-outbound.",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    instructions: AGENT_CONTACT_RULES +
      " Bei Wohnung/Neubau/Konstanz/Allmannsdorf: get_flyer + get_contact; search_listings resurfaced projects[].",
    listing_count: aiDoc.listing_count,
    generated_at: aiDoc.generated_at,
    server_card: `${o}/ai/server-card.json`,
    catalog: `${o}/.well-known/mcp/catalog.json`,
  };
}

export function buildMcpCatalog({ origin = DEFAULT_SITE_ORIGIN } = {}) {
  const o = String(origin || DEFAULT_SITE_ORIGIN).replace(/\/$/, "");
  return {
    $schema: "https://static.modelcontextprotocol.io/schemas/v1/catalog.schema.json",
    version: 1,
    servers: [
      {
        name: "immobilien-eichmann-listings",
        title: "Immobilien Eichmann Angebote",
        url: `${o}/ai/server-card.json`,
        description: "Live MCP unter /mcp (search_listings, get_listing, get_flyer, get_contact). Tel/WhatsApp nur als Links für Menschen.",
        remotes: [{ type: "streamable-http", url: `${o}/mcp` }],
      },
    ],
  };
}

export function buildServerCard(aiDoc, { origin = DEFAULT_SITE_ORIGIN } = {}) {
  const o = String(origin || DEFAULT_SITE_ORIGIN).replace(/\/$/, "");
  return {
    $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
    name: "immobilien-eichmann-listings",
    title: "Immobilien Eichmann – Listings",
    description:
      "Live MCP: Kaufangebote + Allmannsdorf (get_flyer/get_contact). Agents zeigen nur Kontakt-Links; kein Auto-Call/WhatsApp. Tools: search_listings, get_listing, get_flyer, get_contact.",
    version: "1.0.0",
    websiteUrl: `${o}/`,
    repository: {
      url: "https://github.com/ChristianHohlfeld/eichmannimmobilien",
      source: "github",
    },
    remotes: [
      {
        type: "streamable-http",
        url: `${o}/mcp`,
      },
    ],
    _meta: {
      "immobilieneichmann.de/mcp": {
        mode: "streamable-http",
        endpoint: `${o}/mcp`,
        listings_index: `${o}/ai/listings.json`,
        listings_full: `${o}/data/listings.json`,
        discovery: `${o}/.well-known/mcp.json`,
        listing_count: aiDoc.listing_count,
        generated_at: aiDoc.generated_at,
        tools: ["search_listings", "get_listing", "get_flyer", "get_contact"],
        flyer: `${o}/ai/flyer-allmannsdorf.json`,
      },
    },
  };
}

async function writeJson(filePath, obj) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
}

/**
 * Write all AI discovery artifacts into siteRoot.
 * @returns {{ aiDoc: object, paths: string[] }}
 */
export async function writeAiDiscoveryArtifacts(data, opts = {}) {
  const siteRoot = opts.siteRoot;
  if (!siteRoot) throw new Error("writeAiDiscoveryArtifacts: siteRoot required");
  const origin = opts.origin || DEFAULT_SITE_ORIGIN;
  const dryRun = opts.dryRun === true;
  let projects = opts.projects;
  let project_unit_count_total = opts.project_unit_count_total;
  if (!Array.isArray(projects)) {
    try {
      const { loadProjectsDocument, projectsForAiIndex, activeProjects } = await import("./projects.mjs");
      const sot = await loadProjectsDocument(siteRoot);
      projects = projectsForAiIndex(sot, { origin });
      project_unit_count_total = activeProjects(sot).reduce(
        (n, p) => n + (Number(p.unit_count) || 0),
        0
      );
    } catch (e) {
      console.warn("AI discovery: projects SoT unavailable:", e.message || e);
      projects = [];
      project_unit_count_total = 0;
    }
  }
  const aiDoc = buildAiListingsDocument(data, {
    origin,
    generatedAt: opts.generatedAt,
    projects,
    project_unit_count_total,
  });

  const paths = {
    listings: path.join(siteRoot, "ai", "listings.json"),
    llms: path.join(siteRoot, "llms.txt"),
    agents: path.join(siteRoot, "agents.txt"),
    mcp: path.join(siteRoot, ".well-known", "mcp.json"),
    catalog: path.join(siteRoot, ".well-known", "mcp", "catalog.json"),
    serverCard: path.join(siteRoot, "ai", "server-card.json"),
  };

  if (!dryRun) {
    await writeJson(paths.listings, aiDoc);
    await fs.writeFile(paths.llms, buildLlmsTxt(aiDoc, { origin }), "utf8");
    await fs.writeFile(paths.agents, buildAgentsTxt({ origin }), "utf8");
    await writeJson(paths.mcp, buildMcpDiscovery(aiDoc, { origin }));
    await writeJson(paths.catalog, buildMcpCatalog({ origin }));
    await writeJson(paths.serverCard, buildServerCard(aiDoc, { origin }));
  }

  return { aiDoc, paths: Object.values(paths) };
}

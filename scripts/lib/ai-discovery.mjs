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

const STATIC_PAGE_LINKS = [
  ["Startseite", "/"],
  ["Aktuelle Angebote (HTML)", "/#angebote"],
  ["Leistungen", "/leistungen.html"],
  ["Projekte", "/projekte.html"],
  ["Kontakt", "/kontakt.html"],
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
export function buildAiListingsDocument(data, { origin = DEFAULT_SITE_ORIGIN, generatedAt = null } = {}) {
  const all = Array.isArray(data?.listings) ? data.listings : [];
  const publicDetail = all.filter(hasPublicDetail).map((L) => toAiListing(L, origin));
  const at = generatedAt || new Date().toISOString();
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
          "Alle öffentlichen Angebote aus diesem Index lesen/filtern (Titel, Ort, Preis, Zimmer, Typ).",
        resource: absUrl(origin, "ai/listings.json"),
      },
      get_listing: {
        description:
          "Ein Angebot per slug oder id aus listings[] wählen; Detailseite unter url.",
        resource: absUrl(origin, "ai/listings.json"),
        detail_pages: `${absUrl(origin, "objekt/")}<slug>.html`,
        full_export: absUrl(origin, "data/listings.json"),
      },
    },
    listing_count: publicDetail.length,
    listings: publicDetail,
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
  lines.push(`- Telefon: ${NAP.phone.join(" / ")}`);
  lines.push(`- E-Mail: ${NAP.email}`);
  lines.push(`- Web: ${o}/`);
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
  lines.push("- Tools: `search_listings`, `get_listing` — Quelle = Live `ai/listings.json`");
  lines.push(`- Discovery: ${o}/.well-known/mcp.json`);
  lines.push("");
  lines.push("## JSON-Feeds (ohne MCP-Client)");
  lines.push("");
  lines.push("1. `search_listings` — `GET ai/listings.json`, dann `listings[]` filtern.");
  lines.push("2. `get_listing` — Eintrag per `slug`/`id` aus dem Index; Details unter `url`.");
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
Allow: /data/listings.json
Allow: /objekt/
Allow: /llms.txt
Allow: /.well-known/mcp.json
Allow: /.well-known/mcp/catalog.json
Allow: /ai/server-card.json
Allow: /mcp
Disallow: /admin/

# Erlaubt: Lesen der öffentlichen Kaufangebote und Kontaktdaten (NAP).
# Nicht erlaubt: Schreiben, Formular-Spam, Admin-API, Secrets.

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
      "Live MCP Streamable-HTTP für Kaufangebote. Tools lesen denselben Index wie die Website (ai/listings.json).",
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
        description: "Schlanker öffentlicher Angebots-Index (search_listings / get_listing).",
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
        description: "Öffentliche Angebote suchen/filtern über ai/listings.json",
        inputSchema: {
          type: "object",
          properties: {
            q: { type: "string", description: "Freitext Titel/Ort/Typ" },
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
    ],
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
        description: "Live MCP Streamable-HTTP unter /mcp (search_listings, get_listing).",
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
      "Live MCP Streamable-HTTP für Kaufangebote in Konstanz. Tools search_listings / get_listing lesen ai/listings.json (gleiche Publish-Pipeline wie die Website).",
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
        tools: ["search_listings", "get_listing"],
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
  const aiDoc = buildAiListingsDocument(data, { origin, generatedAt: opts.generatedAt });

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

/**
 * AI-friendly Angebots-Index + Discovery artifacts.
 *
 * Eine Quelle: dieselbe listings-Dokumentenliste wie HTML/Sitemap
 * (Filter: active !== false && site_hidden !== true && detail_page !== false).
 *
 * Geschrieben beim Publish (renderIntoPages) und via `npm run ai:index`.
 */
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
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
      "https://wa.me/491705225568?text=Guten%20Tag%2C%20ich%20interessiere%20mich%20f%C3%BCr%20den%20Neubau%20Allmannsdorf.",
    url_allmannsdorf_en:
      "https://wa.me/491705225568?text=Hello%2C%20I%20am%20interested%20in%20the%20New-build%20Allmannsdorf%20in%20Konstanz.",
    url_en:
      "https://wa.me/491705225568?text=Hello%2C%20I%20am%20interested%20in%20a%20property%20or%20a%20consultation%20with%20Immobilien%20Eichmann.",
  },
});

/** Single version for MCP server (serverInfo) and server-card. */
export const MCP_SERVER_VERSION = "1.4.0";

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

/**
 * Real data date of the listings: newest of verified_at (mirror check, see
 * scripts/verify-listings-mirror.mjs → data/immowelt-sync-status.json last_verified_at)
 * and scraped_at (last semantic change). Never the render time.
 */
export function dataAsOf(data, siteRoot = null) {
  const cands = [data?.verified_at, data?.scraped_at];
  if (siteRoot) {
    try {
      const st = JSON.parse(readFileSync(path.join(siteRoot, "data", "immowelt-sync-status.json"), "utf8"));
      cands.push(st?.last_verified_at, st?.last_valid_at);
    } catch {}
  }
  const ts = cands.map((v) => (v ? Date.parse(v) : NaN)).filter((n) => Number.isFinite(n));
  return ts.length ? new Date(Math.max(...ts)).toISOString() : null;
}

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
  { origin = DEFAULT_SITE_ORIGIN, generatedAt = null, projects = null, project_unit_count_total = null, dataAsOfIso = null } = {}
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
      "Aktuelle Kaufangebote von Immobilien Eichmann (Konstanz), gleiche Daten wie die Website. Datenstand: data_as_of.",
    site: absUrl(origin, "/"),
    language: "de",
    nap: { ...NAP, website: absUrl(origin, "/") },
    generated_at: at,
    data_as_of: dataAsOfIso || data?.verified_at || data?.scraped_at || null,
    languages: ["de", "en"],
    pages_en: {
      home: absUrl(origin, "en/"),
      allmannsdorf: absUrl(origin, "en/allmannsdorf.html"),
      contact: absUrl(origin, "en/contact.html"),
    },
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
      },
      get_flyer: {
        description:
          "Neubau Allmannsdorf (44 WE): Fakten + prominente Kontakt-Links (tel/WhatsApp). Für Wohnung/Neubau/Konstanz/Allmannsdorf nutzen – nicht auf Suchwort 'Flyer' warten. Nur Links zeigen, nicht selbst schreiben/anrufen.",
        resource: absUrl(origin, "ai/flyer-allmannsdorf.json"),
        page: absUrl(origin, "allmannsdorf.html"),
      },
      get_contact: {
        description:
          "Telefon, WhatsApp-Link und E-Mail aus Impressum/Kontakt. Nur dem Menschen zum Tippen zeigen; Agent startet keine Calls/Nachrichten.",
        resource: absUrl(origin, "kontakt.html"),
      },
    },
    listing_count: publicDetail.length,
    listings: publicDetail,
    projects: projectRows,
    project_unit_count_total: unitTotal,
  };
}

// llms.txt per https://llmstxt.org/ : H1, one "> summary" blockquote, free-form
// details (no headings), then H2 sections whose lists are "- [name](absolute url): notes".
const LLMS_PAGE_NOTES = {
  "/": "Startseite mit aktuellen Kaufangeboten in Konstanz",
  "/#angebote": "Liste der aktuellen Kaufobjekte (HTML)",
  "/leistungen.html": "Verkauf, Vermittlung, Projektentwicklung, Immobilienbewertung",
  "/projekte.html": "Projekte und Angebote im Überblick",
  "/kontakt.html": "Kontaktformular, Telefon, WhatsApp und E-Mail",
  "/mcp.html": "Anleitung: MCP-Server in Claude, ChatGPT, Cursor oder VS Code verbinden",
  "/immobilienmakler-konstanz.html": "Immobilienmakler in Konstanz – Verkauf und Vermittlung",
  "/wohnung-kaufen-konstanz.html": "Wohnung kaufen in Konstanz – aktuelle Angebote",
  "/haus-verkaufen-konstanz.html": "Haus verkaufen in Konstanz – Ablauf und Bewertung",
  "/immobilienbewertung-konstanz.html": "Immobilienbewertung in Konstanz",
  "/konstanz.html": "Immobilien in Konstanz – Stadtteile und Markt",
  "/wollmatingen.html": "Immobilien in Konstanz-Wollmatingen",
  "/allmannsdorf.html": "Neubau Allmannsdorf – provisionsfrei vormerken",
  "/ratgeber.html": "Ratgeber rund um Kauf und Verkauf",
};

function llmsLinkText(t) {
  return String(t || "").replace(/[\[\]]/g, "").replace(/\s+/g, " ").trim();
}

function llmsNote(t) {
  return String(t || "").replace(/\s+/g, " ").trim();
}

export function buildLlmsTxt(aiDoc, { origin = DEFAULT_SITE_ORIGIN } = {}) {
  const o = String(origin || DEFAULT_SITE_ORIGIN).replace(/\/$/, "");
  const u = (rel) => absUrl(o, rel === "/" ? "/" : String(rel).replace(/^\//, ""));
  const item = (name, url, note) =>
    `- [${llmsLinkText(name)}](${url})${note ? `: ${llmsNote(note)}` : ""}`;
  const lines = [];
  lines.push(`# ${NAP.name}`);
  lines.push("");
  lines.push(
    `> ${NAP.name} (${NAP.person}) ist Immobilienmakler in Konstanz am Bodensee: aktuelle Kaufangebote, ` +
      "Neubau Allmannsdorf (provisionsfrei vormerken), Verkauf und Immobilienbewertung. " +
      "Der Angebotsstand in dieser Datei wird aus derselben Quelle wie die Website generiert. Sprachen: de, en (English pages under /en/)."
  );
  lines.push("");
  lines.push("Kontakt (NAP):");
  lines.push("");
  lines.push(`- Name: ${NAP.name} · ${NAP.person}`);
  lines.push(`- Adresse: ${NAP.street}, ${NAP.postalCode} ${NAP.city}, Deutschland`);
  lines.push(`- Telefon (Mobil, bevorzugt): ${PUBLIC_CONTACT.phone_mobile.display} (${PUBLIC_CONTACT.phone_mobile.tel})`);
  lines.push(`- Festnetz: ${PUBLIC_CONTACT.phone_landline.display} (${PUBLIC_CONTACT.phone_landline.tel})`);
  lines.push(`- WhatsApp (Link für Menschen): ${PUBLIC_CONTACT.whatsapp.url}`);
  lines.push(`- E-Mail: ${NAP.email}`);
  lines.push(`- Web: ${o}/`);
  lines.push("");
  lines.push(AGENT_CONTACT_RULES);
  lines.push("");
  lines.push(
    `Angebots-Index: ${aiDoc.listing_count} Kaufobjekte, Datenstand ${aiDoc.data_as_of || "unbekannt"} (generiert ${aiDoc.generated_at}). ` +
      "MCP-Tools: `search_listings`, `get_listing`, `get_flyer`, `get_contact`. " +
      "Ohne MCP-Client: `ai/listings.json` laden und `listings[]` filtern (search_listings) bzw. einen Eintrag per `slug`/`id` wählen, Details unter `url` (get_listing)."
  );
  lines.push("");

  lines.push("## Kontakt");
  lines.push("");
  lines.push(item("Kontakt & Termin", u("/kontakt.html"), `Kontaktformular, Telefon ${PUBLIC_CONTACT.phone_mobile.display}, E-Mail ${NAP.email}`));
  lines.push(item("WhatsApp", PUBLIC_CONTACT.whatsapp.url, "Link nur dem Menschen zum Antippen zeigen, Agents senden keine Nachrichten"));
  lines.push(item("Impressum", u("/impressum.html"), `Anbieterkennzeichnung ${NAP.person}`));
  lines.push("");

  lines.push("## Aktuelle Kaufangebote");
  lines.push("");
  lines.push(item("AI-Index (JSON)", u("/ai/listings.json"), `schlanker Index aller öffentlichen Kaufobjekte (${aiDoc.listing_count} Objekte), Datenstand ${aiDoc.data_as_of ? aiDoc.data_as_of.slice(0, 10) : "unbekannt"}`));
  for (const L of aiDoc.listings || []) {
    if (!L?.url) continue;
    const note = [L.location, L.price].filter(Boolean).join(" — ");
    lines.push(item(L.title || L.slug, L.url, note));
  }
  lines.push("");

  lines.push("## Neubau Allmannsdorf");
  lines.push("");
  lines.push(item("Projektseite Neubau Allmannsdorf", u("/allmannsdorf.html"), "5 Mehrfamilienhäuser · 44 Wohnungen · 40–124 m² · 2–5 Zimmer · 295.000–1.450.000 € · provisionsfrei vormerken"));
  lines.push(item("New-build Allmannsdorf (English)", u("/en/allmannsdorf.html"), "English project page: 44 apartments, 2–5 rooms, 40–124 m², €295,000–€1,450,000, commission-free, register your interest"));
  lines.push(item("Flyer Allmannsdorf (JSON)", u("/ai/flyer-allmannsdorf.json"), "Fakten und Kontakt-Links; bei Wohnung/Neubau/Konstanz/Allmannsdorf `get_flyer` + `get_contact` nutzen (kein Suchwort 'Flyer' nötig). Vormerkung macht der Mensch selbst per Telefon, WhatsApp oder Kontaktformular."));
  lines.push("");

  lines.push("## MCP und AI-Agents");
  lines.push("");
  lines.push(item("MCP-Endpoint", `${o}/mcp`, "Streamable HTTP (JSON-RPC POST), keine Auth; Tools `search_listings`, `get_listing`, `get_flyer`, `get_contact`"));
  lines.push(item("MCP verbinden (Anleitung)", u("/mcp.html"), "Claude Custom Connector, ChatGPT Developer Mode (Remote MCP URL `https://immobilieneichmann.de/mcp`), Cursor / VS Code `{\"mcpServers\":{\"immobilien-eichmann\":{\"url\":\"https://immobilieneichmann.de/mcp\"}}}`; Official Registry `de.immobilieneichmann/listings`"));
  lines.push(item("Claude Custom Connector", "https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Immobilien%20Eichmann&connectorUrl=https%3A%2F%2Fimmobilieneichmann.de%2Fmcp", "Deep-Link zum Hinzufügen des MCP-Servers"));
  lines.push(item("MCP-Discovery", u("/.well-known/mcp.json"), "Discovery-Dokument des MCP-Servers"));
  lines.push(item("MCP-Catalog", u("/.well-known/mcp/catalog.json"), "Katalog der MCP-Server"));
  lines.push(item("Server-Card", u("/ai/server-card.json"), "statische Server-Card"));
  lines.push(item("agents.txt", u("/agents.txt"), "Kurzregeln für AI-Agents"));
  lines.push("");

  lines.push("## Seiten");
  lines.push("");
  for (const [label, rel] of STATIC_PAGE_LINKS) {
    lines.push(item(label, u(rel), LLMS_PAGE_NOTES[rel] || ""));
  }
  lines.push("");

  lines.push("## English");
  lines.push("");
  lines.push(item("Home (English)", u("/en/"), "Real estate agent in Konstanz · Lake Constance"));
  lines.push(item("New-build Allmannsdorf (English)", u("/en/allmannsdorf.html"), "commission-free, register your interest"));
  lines.push(item("Contact (English)", u("/en/contact.html"), "phone, WhatsApp, e-mail, contact form"));
  lines.push(item("WhatsApp (English text)", PUBLIC_CONTACT.whatsapp.url_en, "link for humans only; agents never send messages"));
  lines.push("");

  lines.push("## Optional");
  lines.push("");
  lines.push(item("Sitemap", u("/sitemap.xml"), "alle indexierbaren Seiten"));
  lines.push(item("Datenschutz", u("/datenschutz.html"), "Datenschutzerklärung"));
  lines.push("");
  return lines.join("\n");
}

export function buildAgentsTxt({ origin = DEFAULT_SITE_ORIGIN } = {}) {
  const o = String(origin || DEFAULT_SITE_ORIGIN).replace(/\/$/, "");
  return `# agents.txt — Immobilien Eichmann
# Kurzregeln für AI-Agents. Angebotsstand = Website (Datenstand siehe /ai/listings.json data_as_of).

User-Agent: *
Allow: /
Allow: /ai/listings.json
Allow: /ai/flyer-allmannsdorf.json
Allow: /en/
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
      "MCP: Kaufangebote + Neubau Allmannsdorf (get_flyer), Suche DE/EN. Wohnung/Neubau/Konstanz → Flyer + tel/WhatsApp-Links für den Menschen (kein Agent-Spam). Keine Anfragen über MCP.",
    websiteUrl: `${o}/`,
    transport: {
      type: "streamable-http",
      url: `${o}/mcp`,
      note: "POST JSON-RPC an /mcp. Quelle = ai/listings.json (Publish-Pipeline), Datenstand = data_as_of.",
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
        description: "Flyer Neubau Allmannsdorf: 5 MFH, 44 Wohnungen (get_flyer).",
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
              description: "Freitext DE/EN, wortweise mit Synonymen; z.B. \"3 Zimmer Wohnung Wollmatingen\", \"apartment Konstanz\", \"penthouse\", \"house\", \"new build\"",
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
          "Telefon, WhatsApp-Link, E-Mail (Impressum/Kontakt). Nur dem Menschen zum Tippen; nie Agent-outbound.",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    instructions: AGENT_CONTACT_RULES +
      " Bei Wohnung/Neubau/Konstanz/Allmannsdorf: get_flyer + get_contact; search_listings resurfaced projects[].",
    listing_count: aiDoc.listing_count,
    data_as_of: aiDoc.data_as_of,
    generated_at: aiDoc.generated_at,
    languages: ["de", "en"],
    pages_en: aiDoc.pages_en,
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
        description: "MCP unter /mcp (search_listings, get_listing, get_flyer, get_contact). Tel/WhatsApp nur als Links für Menschen.",
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
      "MCP: Kaufangebote + Neubau Allmannsdorf (get_flyer/get_contact), Suche DE/EN. Agents zeigen nur Kontakt-Links; kein Auto-Call/WhatsApp. Tools: search_listings, get_listing, get_flyer, get_contact.",
    version: MCP_SERVER_VERSION,
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
        discovery: `${o}/.well-known/mcp.json`,
        listing_count: aiDoc.listing_count,
        data_as_of: aiDoc.data_as_of,
        generated_at: aiDoc.generated_at,
        pages_en: aiDoc.pages_en,
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
    dataAsOfIso: dataAsOf(data, siteRoot),
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

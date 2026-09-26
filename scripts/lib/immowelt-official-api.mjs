/**
 * Official Immowelt SOAP API (read-only).
 *
 * EstateService: GetListCustomerProjects
 * EstateExpose:  GetEstateExposeByEstateGuid
 *
 * NEVER writes to Immowelt profile/listings.
 */
import { XMLParser } from "./immowelt-xml-lite.mjs";

const ESTATE_SERVICE_URL = "https://api.immowelt.de/WebServices/EstateService.asmx";
const ESTATE_EXPOSE_URL = "https://api.immowelt.de/WebServices/EstateExpose.asmx";
const NS_SERVICES = "http://immowelt.de/services";
const NS_EXPOSE = "http://immowelt.de/";

const PROFILE_URL =
  process.env.IMMOWELT_PROFILE_URL ||
  "https://www.immowelt.de/profil/3b18336c6a2e401da38e9cc20268270d";

function escapeXml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function localName(tag) {
  const s = String(tag || "");
  const i = s.indexOf(":");
  return (i >= 0 ? s.slice(i + 1) : s).toLowerCase();
}

function textOf(node) {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (typeof node === "object") {
    if (typeof node["#text"] === "string") return node["#text"];
    if (typeof node._ === "string") return node._;
  }
  return "";
}

function attr(node, name) {
  if (!node || typeof node !== "object") return "";
  const attrs = node[":@"] || node["@_"] || {};
  if (attrs[name] != null) return String(attrs[name]);
  if (attrs[`@_${name}`] != null) return String(attrs[`@_${name}`]);
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(attrs)) {
    if (localName(k) === lower || k.replace(/^@_/, "").toLowerCase() === lower) {
      return String(v ?? "");
    }
  }
  // also allow direct @_guid style on node
  if (node[`@_${name}`] != null) return String(node[`@_${name}`]);
  if (node[`@${name}`] != null) return String(node[`@${name}`]);
  return "";
}

function findAll(node, pred, out = []) {
  if (node == null) return out;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, pred, out);
    return out;
  }
  if (typeof node !== "object") return out;
  if (pred(node)) out.push(node);
  for (const [k, v] of Object.entries(node)) {
    if (k === ":@" || k.startsWith("@")) continue;
    findAll(v, pred, out);
  }
  return out;
}

function walkElements(node, visit) {
  if (node == null) return;
  if (Array.isArray(node)) {
    for (const child of node) walkElements(child, visit);
    return;
  }
  if (typeof node !== "object") return;
  for (const [k, v] of Object.entries(node)) {
    if (k === ":@" || k.startsWith("@") || k === "#text" || k === "_") continue;
    visit(localName(k), v, k);
    walkElements(v, visit);
  }
}

function firstDeepText(node, names) {
  const want = new Set([...names].map((n) => n.toLowerCase()));
  let found = "";
  walkElements(node, (ln, v) => {
    if (found) return;
    if (!want.has(ln)) return;
    const t = textOf(v).trim();
    if (t) found = t;
  });
  return found;
}

function collectImageUrls(node) {
  const urls = [];
  const seen = new Set();
  const add = (u) => {
    const url = String(u || "").trim();
    if (!url || !/^https?:\/\//i.test(url)) return;
    if (!/immowelt|cloudimg|mms\.|\.(jpe?g|png|webp)(\?|$)/i.test(url)) return;
    const key = url.split("?")[0].toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    urls.push(url);
  };

  const visitString = (s) => {
    const str = String(s || "");
    const re = /https?:\/\/[^\s"'<>]+/gi;
    let m;
    while ((m = re.exec(str))) add(m[0].replace(/&amp;/g, "&"));
  };

  const walk = (n) => {
    if (n == null) return;
    if (typeof n === "string") {
      visitString(n);
      return;
    }
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (typeof n !== "object") return;
    for (const [k, v] of Object.entries(n)) {
      const ln = localName(k);
      if (
        /^(url|src|href|previewimage|bild|image|foto|medium|media)$/i.test(ln) ||
        /bild|image|foto|media|picture/i.test(ln)
      ) {
        if (typeof v === "string") add(v);
        else {
          add(textOf(v));
          add(attr(v, "url"));
          add(attr(v, "src"));
          add(attr(v, "href"));
        }
      }
      if (k === "#text" || k === "_") visitString(v);
      else if (!k.startsWith("@") && k !== ":@") walk(v);
    }
  };
  walk(node);
  return urls;
}

function formatPrice(raw, completeAttr) {
  if (completeAttr != null && String(completeAttr).trim() !== "") {
    const n = Number(String(completeAttr).replace(",", "."));
    if (Number.isFinite(n) && n > 0) {
      return `${new Intl.NumberFormat("de-DE").format(Math.round(n))} €`;
    }
  }
  const s = String(raw || "").trim();
  if (!s) return null;
  if (/€/.test(s)) return s;
  const n = Number(s.replace(/\./g, "").replace(",", "."));
  if (Number.isFinite(n) && n > 0) {
    return `${new Intl.NumberFormat("de-DE").format(Math.round(n))} €`;
  }
  return s;
}

function formatArea(raw, valueAttr, unitAttr) {
  const unit = (unitAttr || "m²").trim() || "m²";
  if (valueAttr != null && String(valueAttr).trim() !== "") {
    const n = Number(String(valueAttr).replace(",", "."));
    if (Number.isFinite(n) && n > 0) {
      return `${String(n).replace(".", ",")} ${unit}`;
    }
  }
  const s = String(raw || "").trim();
  if (!s) return null;
  if (/m²|qm/i.test(s)) return s;
  return `${s} ${unit}`;
}

function formatRooms(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (/zimmer/i.test(s)) return s;
  return `${s} Zimmer`;
}

export function buildListCustomerProjectsEnvelope(apiKey, { page = 1, pageSize = 50 } = {}) {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="${NS_SERVICES}">
  <soap:Header>
    <tns:ListAuthenticationHeader>
      <tns:ApiKey>${escapeXml(apiKey)}</tns:ApiKey>
    </tns:ListAuthenticationHeader>
  </soap:Header>
  <soap:Body>
    <tns:GetListCustomerProjects>
      <tns:ls>createdatedesc</tns:ls>
      <tns:IncludeIwObj>true</tns:IncludeIwObj>
      <tns:CurrentPage>${Number(page) || 1}</tns:CurrentPage>
      <tns:PageSize>${Number(pageSize) || 50}</tns:PageSize>
    </tns:GetListCustomerProjects>
  </soap:Body>
</soap:Envelope>`;
}

export function buildEstateExposeEnvelope(apiKey, estateGuid) {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="${NS_EXPOSE}">
  <soap:Header>
    <tns:ExposeAuthenticationHeader>
      <tns:ApiKey>${escapeXml(apiKey)}</tns:ApiKey>
    </tns:ExposeAuthenticationHeader>
  </soap:Header>
  <soap:Body>
    <tns:GetEstateExposeByEstateGuid>
      <tns:EstateGuid>${escapeXml(estateGuid)}</tns:EstateGuid>
    </tns:GetEstateExposeByEstateGuid>
  </soap:Body>
</soap:Envelope>`;
}

async function soapPost(url, soapAction, envelope) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: `"${soapAction}"`,
      Accept: "text/xml",
    },
    body: envelope,
  });
  const text = await res.text();
  if (!res.ok) {
    if (/Access denied/i.test(text)) {
      const err = new Error(
        "Immowelt hat den API-Schlüssel abgelehnt. Bitte Schlüssel und Kundennummer prüfen."
      );
      err.code = "immowelt_access_denied";
      throw err;
    }
    const err = new Error(`Immowelt-API antwortete mit HTTP ${res.status}.`);
    err.code = "immowelt_http_error";
    err.status = res.status;
    throw err;
  }
  if (/Access denied/i.test(text) || /faultstring[^>]*>Access denied/i.test(text)) {
    const err = new Error(
      "Immowelt hat den API-Schlüssel abgelehnt. Bitte Schlüssel und Kundennummer prüfen."
    );
    err.code = "immowelt_access_denied";
    throw err;
  }
  return text;
}

function parseSoapXml(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    textNodeName: "#text",
    removeNSPrefix: true,
  });
  return parser.parse(xml);
}

export function extractEstatePropertiesFromListResponse(xml) {
  const doc = parseSoapXml(xml);
  const props = [];
  findAll(doc, (node) => {
    if (!node || typeof node !== "object") return false;
    // EstateProperty element may be keyed or nested; detect by guid attribute presence + Category/Description
    return false;
  });

  // Prefer keyed walk: any EstateProperty object
  const collect = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(collect);
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (localName(k) === "estateproperty") {
        const items = Array.isArray(v) ? v : [v];
        for (const item of items) props.push(item);
      } else if (k !== ":@" && !k.startsWith("@")) {
        collect(v);
      }
    }
  };
  collect(doc);

  // Status check
  let status = "";
  walkElements(doc, (ln, v) => {
    if (ln === "status" && !status) status = textOf(v).trim();
  });
  if (status && status !== "OK" && status !== "NoData") {
    const err = new Error(`Immowelt-Listenabruf fehlgeschlagen (${status}).`);
    err.code = "immowelt_list_status";
    err.statusName = status;
    throw err;
  }

  return props.map(mapListProperty).filter((p) => p && p.id);
}

function mapListProperty(prop) {
  if (!prop || typeof prop !== "object") return null;
  const guid =
    attr(prop, "guid") ||
    attr(prop, "Guid") ||
    firstDeepText(prop, ["GlobalObjectKey"]) ||
    "";
  const id = String(guid || "").toLowerCase().trim();
  if (!/^[a-f0-9-]{36}$/i.test(id)) return null;

  const categoryNode = prop.Category || prop.category;
  const categoryText = textOf(categoryNode).trim();
  const saleRent = attr(categoryNode, "saleRentID") || attr(categoryNode, "salerentid");
  const status = saleRent === "2" || /miete/i.test(categoryText) ? "Miete" : "Kauf";

  const priceNode = prop.Price || prop.price;
  const livingNode = prop.LivingArea || prop.livingarea;
  const landNode = prop.LandArea || prop.landarea;

  const city = textOf(prop.City || prop.city).trim();
  const zip = textOf(prop.Zip || prop.zip).trim();
  const geo = attr(prop, "GeoDescription") || attr(prop, "geodescription");
  const location =
    [geo || [city, zip ? `(${zip})` : ""].filter(Boolean).join(" ")].filter(Boolean).join("") ||
    null;

  const description = textOf(prop.Description || prop.description).trim();
  const preview = textOf(prop.PreviewImage || prop.previewimage).trim();
  const exposeUrl =
    textOf(prop.UrlExpose || prop.urlexpose).trim() ||
    `https://www.immowelt.de/expose/${id}`;

  const typeGuess =
    categoryText ||
    (/haus/i.test(description) ? "Haus" : /wohnung|penthouse|maisonette/i.test(description) ? "Wohnung" : null);

  return {
    id,
    immowelt_id: id,
    title: description || `Immobilie ${id.slice(0, 8)}`,
    description: description || "",
    short_description: null,
    price: formatPrice(textOf(priceNode), attr(priceNode, "Complete") || attr(priceNode, "complete")),
    rooms: formatRooms(textOf(prop.Rooms || prop.rooms)),
    living_area: formatArea(
      textOf(livingNode),
      attr(livingNode, "value"),
      attr(livingNode, "unit")
    ),
    plot_area: formatArea(textOf(landNode), attr(landNode, "value"), attr(landNode, "unit")),
    location,
    status,
    type: typeGuess,
    expose_url: exposeUrl,
    main_image_url: preview || null,
    images: preview ? [preview] : [],
    reference_number: null,
    active: true,
    source: "immowelt",
    sync_policy: "independent",
    detail_page: true,
  };
}

export function parseXmlExposeDetails(xmlExpose) {
  if (!xmlExpose || !String(xmlExpose).trim()) return {};
  // XmlExpose may itself be an XML document string (possibly HTML-escaped once)
  let raw = String(xmlExpose).trim();
  if (/&lt;[A-Za-z]/.test(raw) && !/^</.test(raw)) {
    raw = raw
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&");
  }
  let doc;
  try {
    doc = parseSoapXml(raw);
  } catch {
    return { images: collectImageUrls({ root: raw }), description: "" };
  }

  const title =
    firstDeepText(doc, ["Titel", "Title", "Ueberschrift", "Überschrift", "Headline", "ObjektTitel"]) ||
    "";
  const description =
    firstDeepText(doc, [
      "Beschreibung",
      "Description",
      "AusfuehrlicheBeschreibung",
      "AusführlicheBeschreibung",
      "Objektbeschreibung",
      "Lagebeschreibung",
      "Text",
    ]) || "";
  const locationDescription =
    firstDeepText(doc, ["Lagebeschreibung", "LocationDescription", "Lage"]) || "";
  const shortDescription =
    firstDeepText(doc, ["Kurzbeschreibung", "Teaser", "ShortDescription"]) || "";
  const reference =
    firstDeepText(doc, ["Referenznummer", "ReferenceNumber", "ObjektNr", "Objektnummer", "RefNr"]) ||
    "";
  const rooms = formatRooms(
    firstDeepText(doc, ["Zimmer", "AnzahlZimmer", "Rooms", "AnzZimmer"])
  );
  const living = formatArea(
    firstDeepText(doc, ["Wohnflaeche", "Wohnfläche", "LivingArea", "Wfl"])
  );
  const plot = formatArea(
    firstDeepText(doc, ["Grundstuecksflaeche", "Grundstücksfläche", "LandArea", "Gfl"])
  );
  const price = formatPrice(firstDeepText(doc, ["Kaufpreis", "Preis", "Price", "Warmmiete", "Kaltmiete"]));
  const type =
    firstDeepText(doc, ["Objektart", "EstateType", "Immobilienart", "Nutzungsart", "Category"]) ||
    null;
  const city = firstDeepText(doc, ["Ort", "City", "Gemeinde"]);
  const zip = firstDeepText(doc, ["PLZ", "Zip", "Postleitzahl"]);
  const district = firstDeepText(doc, ["Stadtteil", "Bezirk", "District"]);
  const location =
    [district, city, zip ? `(${zip})` : ""].filter(Boolean).join(", ").replace(", (", " (") || null;

  const images = collectImageUrls(doc);

  return {
    title: title || null,
    description: description || null,
    location_description: locationDescription || null,
    short_description: shortDescription || null,
    reference_number: reference ? String(reference).toUpperCase() : null,
    rooms,
    living_area: living,
    plot_area: plot,
    price,
    type,
    location,
    images,
    main_image_url: images[0] || null,
  };
}

export function extractXmlExposeFromResponse(xml) {
  const doc = parseSoapXml(xml);
  let status = "";
  let xmlExpose = "";
  walkElements(doc, (ln, v) => {
    if (ln === "status" && !status) status = textOf(v).trim();
    if (ln === "xmlexpose" && !xmlExpose) xmlExpose = textOf(v);
  });
  if (status && status !== "OK") {
    const err = new Error(`Immowelt-Exposé ungültig (${status}).`);
    err.code = "immowelt_expose_invalid";
    err.statusName = status;
    throw err;
  }
  return xmlExpose;
}

function mergeListing(base, details) {
  const out = { ...base };
  if (details.title && details.title.length >= 8) out.title = details.title;
  if (details.description && details.description.length > (out.description || "").length) {
    out.description = details.description;
  }
  if (details.short_description) out.short_description = details.short_description;
  if (details.location_description) out.location_description = details.location_description;
  if (details.reference_number) out.reference_number = details.reference_number;
  if (details.rooms) out.rooms = details.rooms;
  if (details.living_area) out.living_area = details.living_area;
  if (details.plot_area) out.plot_area = details.plot_area;
  if (details.price) out.price = details.price;
  if (details.type) out.type = details.type;
  if (details.location) out.location = details.location;
  const images = [...(details.images || []), ...(base.images || [])];
  const seen = new Set();
  out.images = images.filter((u) => {
    const k = String(u).split("?")[0].toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  out.main_image_url = out.images[0] || out.main_image_url || null;
  if ((out.description || "").length >= 80) out.detail_page = true;
  return out;
}

/**
 * Fetch all customer projects + exposés via official SOAP API.
 * @returns {{ source: string, scraped_at: string, mode: string, listings: object[], confirmed_inactive_ids: string[] }}
 */
export async function fetchOfficialImmoweltListings(apiKey, previousData = null, options = {}) {
  if (!apiKey || !String(apiKey).trim()) {
    const err = new Error("Immowelt-API-Schlüssel fehlt.");
    err.code = "awaiting_api_key";
    throw err;
  }
  const pageSize = options.pageSize || 50;
  const maxPages = options.maxPages || 20;
  const listings = [];
  const seen = new Set();

  for (let page = 1; page <= maxPages; page++) {
    const envelope = buildListCustomerProjectsEnvelope(apiKey, { page, pageSize });
    const xml = await soapPost(
      ESTATE_SERVICE_URL,
      "http://immowelt.de/services/GetListCustomerProjects",
      envelope
    );
    const props = extractEstatePropertiesFromListResponse(xml);
    if (!props.length) break;
    for (const p of props) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      listings.push(p);
    }
    if (props.length < pageSize) break;
  }

  // Enrich each listing with expose details (images + long description).
  const enriched = [];
  for (const item of listings) {
    try {
      const env = buildEstateExposeEnvelope(apiKey, item.id);
      const xml = await soapPost(
        ESTATE_EXPOSE_URL,
        "http://immowelt.de/GetEstateExposeByEstateGuid",
        env
      );
      const xmlExpose = extractXmlExposeFromResponse(xml);
      const details = parseXmlExposeDetails(xmlExpose);
      enriched.push(mergeListing(item, details));
    } catch (e) {
      if (e.code === "immowelt_access_denied") throw e;
      console.warn(`Exposé ${item.id.slice(0, 8)}: ${e.message || e}`);
      enriched.push(item);
    }
  }

  const activeIds = new Set(enriched.map((L) => L.id));
  const confirmed_inactive_ids = [];
  for (const prev of previousData?.listings || []) {
    const id = String(prev?.immowelt_id || prev?.id || "").toLowerCase();
    if (!/^[a-f0-9-]{36}$/i.test(id)) continue;
    if (prev?.source === "local" || prev?.origin === "eigen") continue;
    if (!activeIds.has(id)) confirmed_inactive_ids.push(id);
  }

  return {
    source: PROFILE_URL,
    scraped_at: new Date().toISOString(),
    mode: "official_api",
    listings: enriched,
    confirmed_inactive_ids,
  };
}

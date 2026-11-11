/**
 * Immowelt SOAP API – read-only transport and response parsing.
 *
 *   EstateService.GetListCustomerProjects   list of the customer's active offers (paged)
 *   EstateExpose.GetEstateExposeByEstateGuid  full exposé (XmlExpose) of one offer
 *
 * Nothing in this module writes to Immowelt. The API key travels in the SOAP header only and
 * never appears in errors, logs or return values.
 */
import { parseXml, XmlError, child, childrenNamed, descendants, firstDescendant, textContent, attr, attributes, elements } from "./xml.mjs";
import { normalizeGuid, normalizeOnlineId, normalizeEstateId } from "./identity.mjs";

export const ESTATE_SERVICE_URL = "https://api.immowelt.de/WebServices/EstateService.asmx";
export const ESTATE_EXPOSE_URL = "https://api.immowelt.de/WebServices/EstateExpose.asmx";
export const ACTION_LIST = "http://immowelt.de/services/GetListCustomerProjects";
export const ACTION_EXPOSE = "http://immowelt.de/GetEstateExposeByEstateGuid";
const NS_SERVICES = "http://immowelt.de/services";
const NS_EXPOSE = "http://immowelt.de/";

export class ImmoweltError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "ImmoweltError";
    this.code = code;
    Object.assign(this, extra);
  }
}

function xmlEscape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Element order follows the WSDL sequence (GeoID, parameter, ls, IncludeIwObj, CurrentPage,
 * PageSize, Intranet). Without GeoID the service answers Status=UnknownLocation.
 */
export function buildListEnvelope(apiKey, { geoId = 108, page = 1, pageSize = 50, sort = "createdatedesc" } = {}) {
  const g = Number(geoId);
  const p = Number(page);
  const s = Number(pageSize);
  if (!Number.isInteger(g) || g <= 0) throw new ImmoweltError("immowelt_config", "GeoID ungültig");
  if (!Number.isInteger(p) || p < 1 || !Number.isInteger(s) || s < 1 || s > 200) throw new ImmoweltError("immowelt_config", "Seite/Seitengröße ungültig");
  if (!/^[A-Za-z]{1,40}$/.test(sort)) throw new ImmoweltError("immowelt_config", "Sortierung ungültig");
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="${NS_SERVICES}">
  <soap:Header>
    <tns:ListAuthenticationHeader>
      <tns:ApiKey>${xmlEscape(apiKey)}</tns:ApiKey>
    </tns:ListAuthenticationHeader>
  </soap:Header>
  <soap:Body>
    <tns:GetListCustomerProjects>
      <tns:GeoID>${g}</tns:GeoID>
      <tns:ls>${sort}</tns:ls>
      <tns:IncludeIwObj>true</tns:IncludeIwObj>
      <tns:CurrentPage>${p}</tns:CurrentPage>
      <tns:PageSize>${s}</tns:PageSize>
    </tns:GetListCustomerProjects>
  </soap:Body>
</soap:Envelope>`;
}

export function buildExposeEnvelope(apiKey, estateGuid) {
  const guid = normalizeGuid(estateGuid);
  if (!guid) throw new ImmoweltError("immowelt_config", "Exposé-GUID ungültig");
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="${NS_EXPOSE}">
  <soap:Header>
    <tns:ExposeAuthenticationHeader>
      <tns:ApiKey>${xmlEscape(apiKey)}</tns:ApiKey>
    </tns:ExposeAuthenticationHeader>
  </soap:Header>
  <soap:Body>
    <tns:GetEstateExposeByEstateGuid>
      <tns:EstateGuid>${guid}</tns:EstateGuid>
    </tns:GetEstateExposeByEstateGuid>
  </soap:Body>
</soap:Envelope>`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRYABLE = new Set(["immowelt_timeout", "immowelt_network", "immowelt_http_5xx", "immowelt_throttled", "immowelt_truncated"]);

/**
 * One SOAP POST with timeout, bounded size and retries (exponential backoff + jitter).
 * Auth failures and 4xx are never retried.
 */
export async function soapCall(url, action, envelope, opts = {}) {
  const {
    fetchImpl = globalThis.fetch,
    timeoutMs = 30_000,
    retries = 3,
    backoffMs = 1_500,
    maxBytes = 20 * 1024 * 1024,
    sleepImpl = sleep,
    onRetry = null,
  } = opts;
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const wait = Math.round(backoffMs * 3 ** (attempt - 1) * (0.75 + Math.random() * 0.5));
      if (onRetry) onRetry({ attempt, wait, code: lastErr?.code });
      await sleepImpl(wait);
    }
    try {
      return await soapOnce(url, action, envelope, { fetchImpl, timeoutMs, maxBytes });
    } catch (err) {
      lastErr = err;
      if (!(err instanceof ImmoweltError) || !RETRYABLE.has(err.code)) throw err;
    }
  }
  lastErr.attempts = retries + 1;
  throw lastErr;
}

async function soapOnce(url, action, envelope, { fetchImpl, timeoutMs, maxBytes }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  let text;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: `"${action}"`, Accept: "text/xml" },
      body: envelope,
      redirect: "error",
      signal: controller.signal,
    });
    text = await res.text();
  } catch (err) {
    if (err?.name === "AbortError" || controller.signal.aborted) {
      throw new ImmoweltError("immowelt_timeout", `Immowelt-API antwortete nicht innerhalb von ${Math.round(timeoutMs / 1000)} s.`);
    }
    // Deliberately no err.message passthrough for the body: only the transport reason.
    throw new ImmoweltError("immowelt_network", `Immowelt-API nicht erreichbar (${String(err?.cause?.code || err?.code || err?.name || "Netzwerkfehler")}).`);
  } finally {
    clearTimeout(timer);
  }
  if (text.length > maxBytes) throw new ImmoweltError("immowelt_response_too_large", "Immowelt-Antwort überschreitet die Größenbegrenzung.");
  // Only where the API itself speaks (error status, SOAP fault, Status element) – never inside offer texts.
  const voice = !res.ok || /<(?:\w+:)?Fault\b/i.test(text) ? text.slice(0, 20000) : (text.match(/<(?:\w+:)?Status\b[^>]*>[^<]{0,200}/gi) || []).join(" ");
  const denied = /Access denied|ApiKey[^<]{0,40}(invalid|ungültig)|Unauthori[sz]ed/i.test(voice);
  if (res.status === 401 || res.status === 403 || denied) {
    throw new ImmoweltError("immowelt_access_denied", "Immowelt hat den API-Schlüssel abgelehnt.", { status: res.status });
  }
  if (res.status === 429) throw new ImmoweltError("immowelt_throttled", "Immowelt-API drosselt Anfragen (HTTP 429).", { status: 429 });
  if (res.status >= 500) {
    // the server's fault text is not passed on: it is public via the status file and could quote the request
    throw new ImmoweltError("immowelt_http_5xx", `Immowelt-API antwortete mit HTTP ${res.status}.`, { status: res.status });
  }
  if (!res.ok) throw new ImmoweltError("immowelt_http_error", `Immowelt-API antwortete mit HTTP ${res.status}.`, { status: res.status });
  if (!/<\/(?:\w+:)?Envelope>\s*$/i.test(text.slice(-200))) {
    throw new ImmoweltError("immowelt_truncated", "Immowelt-Antwort ist unvollständig (SOAP-Envelope nicht geschlossen).");
  }
  return text;
}

function parseSoap(xml) {
  let root;
  try {
    root = parseXml(xml);
  } catch (err) {
    if (err instanceof XmlError) throw new ImmoweltError("immowelt_invalid_xml", err.message);
    throw err;
  }
  if (root.lname !== "envelope") throw new ImmoweltError("immowelt_invalid_xml", "Antwort ist kein SOAP-Envelope.");
  const body = child(root, "Body");
  if (!body) throw new ImmoweltError("immowelt_invalid_xml", "SOAP-Body fehlt.");
  const fault = child(body, "Fault");
  if (fault) {
    const reason = textContent(firstDescendant(fault, "faultstring") || firstDescendant(fault, "Text") || fault).trim().slice(0, 300);
    if (/access denied|apikey/i.test(reason)) throw new ImmoweltError("immowelt_access_denied", "Immowelt hat den API-Schlüssel abgelehnt.");
    throw new ImmoweltError("immowelt_soap_fault", `Immowelt meldet einen SOAP-Fehler: ${reason || "ohne Text"}`);
  }
  return body;
}

/** An element whose content is an XML document given as escaped text → parsed element. */
function embeddedDocument(node, expectedRoot) {
  if (!node) return null;
  const direct = elements(node).find((c) => c.lname === expectedRoot.toLowerCase());
  if (direct) return direct;
  const text = textContent(node).trim();
  if (!text) return null;
  if (!text.startsWith("<")) throw new ImmoweltError("immowelt_invalid_xml", `<${node.local}> enthält kein XML.`);
  try {
    const root = parseXml(text);
    if (root.lname === expectedRoot.toLowerCase()) return root;
    return firstDescendant(root, expectedRoot) || root;
  } catch (err) {
    if (err instanceof XmlError) throw new ImmoweltError("immowelt_invalid_xml", `<${node.local}>: ${err.message}`);
    throw err;
  }
}

function intOrNull(node) {
  const t = textContent(node).trim();
  return /^\d+$/.test(t) ? Number(t) : null;
}

/**
 * Parse one page of GetListCustomerProjects.
 * Strict: a property without the three valid ids fails the whole page (never dropped silently).
 */
export function parseListResponse(xml) {
  const body = parseSoap(xml);
  const result = firstDescendant(body, "GetListCustomerProjectsResult") || firstDescendant(body, "GetListCustomerProjectsResponse") || body;
  const status = textContent(firstDescendant(result, "Status")).trim();
  if (!status) throw new ImmoweltError("immowelt_list_status", "Listenantwort ohne Status.");
  if (status !== "OK" && status !== "NoData") {
    throw new ImmoweltError("immowelt_list_status", `Immowelt-Listenabruf fehlgeschlagen (Status ${status}).`, { statusName: status });
  }
  const totalCount = intOrNull(firstDescendant(result, "TotalCount"));
  const pageSize = intOrNull(firstDescendant(result, "PageSize"));
  const currentPage = intOrNull(firstDescendant(result, "CurrentPage"));

  const listNode = firstDescendant(result, "EstatePropertyList");
  let propNodes = [];
  if (listNode) {
    propNodes = descendants(listNode, "EstateProperty");
    if (!propNodes.length && textContent(listNode).trim().startsWith("<")) {
      const inner = embeddedDocument(listNode, "EstatePropertyList");
      propNodes = inner ? (inner.lname === "estateproperty" ? [inner] : descendants(inner, "EstateProperty")) : [];
    }
  }

  const properties = propNodes.map((node, index) => {
    const estateId = normalizeEstateId(attr(node, "id"));
    const guid = normalizeGuid(attr(node, "guid"));
    const onlineId = normalizeOnlineId(attr(node, "onlineID"));
    if (!estateId || !guid || !onlineId) {
      throw new ImmoweltError(
        "immowelt_list_parse",
        `Listeneintrag ${index + 1} ohne gültige Kennungen (id=${estateId ? "ok" : "fehlt"}, guid=${guid ? "ok" : "fehlt"}, onlineID=${onlineId ? "ok" : "fehlt"}).`
      );
    }
    const fields = {};
    for (const c of elements(node)) {
      const entry = { text: textContent(c).trim(), attrs: attributes(c) };
      if (fields[c.lname] === undefined) fields[c.lname] = entry;
      else fields[c.lname] = [].concat(fields[c.lname], entry);
    }
    return { estateId, guid, onlineId, attrs: attributes(node), fields };
  });

  if (totalCount == null) throw new ImmoweltError("immowelt_list_no_totalcount", "Listenantwort ohne TotalCount – Vollständigkeit nicht prüfbar.");
  if (status === "NoData" && (totalCount !== 0 || properties.length)) {
    throw new ImmoweltError("immowelt_list_status", "Status NoData, aber Einträge/TotalCount > 0 – widersprüchliche Antwort.");
  }
  return { status, totalCount, pageSize, currentPage, properties };
}

/** Parse GetEstateExposeByEstateGuid → the <expose> element (XmlExpose is XML inside a string). */
export function parseExposeResponse(xml) {
  const body = parseSoap(xml);
  const result = firstDescendant(body, "GetEstateExposeByEstateGuidResult") || firstDescendant(body, "GetEstateExposeByEstateGuidResponse") || body;
  const status = textContent(firstDescendant(result, "Status")).trim();
  if (status !== "OK") {
    throw new ImmoweltError("immowelt_expose_status", `Immowelt-Exposé nicht lieferbar (Status ${status || "fehlt"}).`, { statusName: status || null });
  }
  const holder = firstDescendant(result, "XmlExpose");
  const expose = embeddedDocument(holder, "expose");
  if (!expose || expose.lname !== "expose") throw new ImmoweltError("immowelt_expose_empty", "Exposé-Antwort ohne <expose>-Inhalt.");
  if (!child(expose, "estate")) throw new ImmoweltError("immowelt_expose_empty", "Exposé ohne <estate>.");
  return { status, expose };
}

/**
 * Complete inventory for one GeoID. Proof of completeness:
 *   - every page has Status OK and the same TotalCount
 *   - pages are read until the number of UNIQUE offers equals TotalCount
 *   - an empty or short page before that point, or a repeated offer, means the list moved
 *     while we were reading → the whole inventory is re-read; it never yields a partial result.
 */
export async function fetchInventory(apiKey, opts = {}) {
  const { geoId = 108, pageSize = 50, sort = "createdatedesc", maxAttempts = 3, hardPageCap = 200, call = soapCall, soap = {}, onPage = null } = opts;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const pages = [];
      const byGuid = new Map();
      let total = null;
      for (let page = 1; page <= hardPageCap; page++) {
        const xml = await call(ESTATE_SERVICE_URL, ACTION_LIST, buildListEnvelope(apiKey, { geoId, page, pageSize, sort }), soap);
        const parsed = parseListResponse(xml);
        pages.push({ page, xml, count: parsed.properties.length, totalCount: parsed.totalCount });
        if (onPage) onPage({ geoId, page, count: parsed.properties.length, totalCount: parsed.totalCount });
        if (total == null) total = parsed.totalCount;
        else if (parsed.totalCount !== total) {
          throw new ImmoweltError("immowelt_list_unstable", `TotalCount änderte sich während des Abrufs (${total} → ${parsed.totalCount}).`);
        }
        if (parsed.currentPage != null && parsed.currentPage !== page) {
          throw new ImmoweltError("immowelt_list_unstable", `Angeforderte Seite ${page}, geliefert wurde Seite ${parsed.currentPage}.`);
        }
        for (const p of parsed.properties) {
          if (byGuid.has(p.guid)) throw new ImmoweltError("immowelt_list_unstable", `Angebot ${p.onlineId} mehrfach in der Liste (Seitenwechsel während des Abrufs).`);
          byGuid.set(p.guid, p);
        }
        if (byGuid.size > total) throw new ImmoweltError("immowelt_list_unstable", `Mehr Angebote (${byGuid.size}) als TotalCount (${total}).`);
        if (byGuid.size === total) break;
        if (!parsed.properties.length) {
          throw new ImmoweltError("immowelt_list_missing_page", `Seite ${page} ist leer, obwohl erst ${byGuid.size} von ${total} Angeboten gelesen wurden.`);
        }
        if (page === hardPageCap) throw new ImmoweltError("immowelt_list_missing_page", `Seitenlimit erreicht (${byGuid.size} von ${total}).`);
      }
      if (byGuid.size !== total) throw new ImmoweltError("immowelt_list_missing_page", `Nur ${byGuid.size} von ${total} Angeboten gelesen.`);
      const properties = [...byGuid.values()];
      const dup = (key) => properties.length !== new Set(properties.map((p) => p[key])).size;
      if (dup("onlineId") || dup("estateId")) throw new ImmoweltError("immowelt_list_parse", "Doppelte Online-ID oder Objekt-ID in der Liste.");
      return { geoId, totalCount: total, properties, pages, attempts: attempt };
    } catch (err) {
      lastErr = err;
      const transient = err instanceof ImmoweltError && (err.code === "immowelt_list_unstable" || err.code === "immowelt_list_missing_page");
      if (!transient || attempt === maxAttempts) throw err;
    }
  }
  throw lastErr;
}

export async function fetchExpose(apiKey, guid, opts = {}) {
  const { call = soapCall, soap = {} } = opts;
  const xml = await call(ESTATE_EXPOSE_URL, ACTION_EXPOSE, buildExposeEnvelope(apiKey, guid), soap);
  const { expose } = parseExposeResponse(xml);
  return { xml, expose };
}

export { childrenNamed };

/**
 * Immowelt list entry + exposé → one canonical listing ("API form").
 *
 * Mapping is driven by item@id and the item's own <title>/<description>:
 *   - every <item> is taken over, either as a fact row (label → value) or as a text section
 *     (heading = Immowelt's title). Unknown ids are rendered the same generic way, so a new
 *     field on Immowelt shows up on the website without a code change.
 *   - every <image> is one picture; source / source_thumbnail / source_XXL are variants of it.
 * Nothing is merged with earlier data: a field that is empty on Immowelt is empty here.
 */
import { createHash } from "node:crypto";
import { child, childrenNamed, elements, textContent, attr, attributes } from "./xml.mjs";
import { sanitizeRichText, plainText, escapeHtml } from "./html.mjs";
import { ImmoweltError } from "./soap.mjs";
import { normalizeGuid, normalizeOnlineId, normalizeEstateId, dashedGuid } from "./identity.mjs";

export const SNAPSHOT_SCHEMA = "eichmann.immowelt-snapshot/v1";
const SALES_TYPE = { 1: "kauf", 2: "miete" };
const MARKETING_LABEL = { kauf: "Kauf", miete: "Miete" };

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
/** JSON with sorted keys → stable hashes independent of construction order. */
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** "1200.0000" (API attribute, dot decimal) → 1200. */
export function parseApiNumber(value) {
  const s = String(value ?? "").trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
/** "1.200,00 € (inkl. Nebenkosten)" / "46,54 m²" / "1,5" → number (first number in the text). */
export function parseGermanNumber(value) {
  const m = /-?\d{1,3}(?:\.\d{3})+(?:,\d+)?|-?\d+(?:,\d+)?/.exec(String(value ?? ""));
  if (!m) return null;
  const n = Number(m[0].replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}
const round2 = (n) => Math.round(n * 100) / 100;
export function formatEuro(n) {
  const cents = Math.abs(round2(n) % 1) > 0.004;
  return `${new Intl.NumberFormat("de-DE", { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: 2 }).format(round2(n))} €`;
}
export function formatArea(n) {
  return `${new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 }).format(round2(n))} m²`;
}
export function formatRooms(n) {
  return `${new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 }).format(n)} Zimmer`;
}

function fieldOf(prop, name) {
  const f = prop.fields[name.toLowerCase()];
  return Array.isArray(f) ? f[0] : f || null;
}
function fieldAttr(field, name) {
  if (!field) return null;
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(field.attrs || {})) if (k.toLowerCase() === want) return v;
  return null;
}

/** Child markup of an element as an HTML string (covers escaped text and real child tags alike). */
function innerMarkup(node) {
  if (!node) return "";
  let out = "";
  for (const c of node.children || []) {
    if (c.type === "text") out += c.value;
    else {
      const attrsText = c.lname === "a" && attr(c, "href") ? ` href="${escapeHtml(attr(c, "href"))}"` : "";
      out += `<${c.lname}${attrsText}>${innerMarkup(c)}</${c.lname}>`;
    }
  }
  return out;
}

function readItems(parent) {
  return childrenNamed(parent, "item").map((node) => {
    const descNode = child(node, "description");
    const raw = innerMarkup(descNode);
    const nested = [...childrenNamed(node, "item"), ...childrenNamed(child(node, "items") || {}, "item"), ...(descNode ? childrenNamed(descNode, "item") : [])];
    return {
      id: String(attr(node, "id") || "").trim(),
      title: plainText(innerMarkup(child(node, "title"))),
      raw: nested.length && descNode && childrenNamed(descNode, "item").length ? "" : raw,
      sub: nested.length ? readItems({ children: nested, lname: "items" }) : [],
      attrs: attributes(node),
    };
  });
}

const isPriceItem = (it) => /^price/i.test(it.id) || /^(kaufpreis|kaltmiete|warmmiete|nettokaltmiete|miete|pacht)$/i.test(it.id);
const isLocationItem = (it) => /^location/i.test(it.id);
const isSectionId = (id) => /^info\d*$/i.test(id) || /^(ausstattung|equipment|objektbeschreibung|lagebeschreibung|sonstiges)$/i.test(id);
const ON_REQUEST_RE = /auf\s+anfrage|on\s+request|preis\s+a\.\s?a\./i;
/** Side prices (parking, service charges, deposit …) say nothing about the price of the offer itself. */
const isSidePrice = (it) => /stellplatz|garage|parking|carport|neben|heiz|kaution|deposit|courtage|provision/i.test(`${it.id} ${it.title}`);

function splitCity(raw) {
  const s = String(raw || "").replace(/\s+/g, " ").trim();
  if (!s) return { city: null, district: null };
  const m = /^(.+?)\s*(?:\/|\(|\s[–-]\s)\s*([^()]+?)\)?$/.exec(s);
  if (m && m[1].trim() && m[2].trim()) return { city: m[1].trim(), district: m[2].trim() };
  return { city: s, district: null };
}

function imageAssetKey(url) {
  try {
    const u = new URL(url);
    const p = u.pathname.replace(/\/\d+x\d+\/?$/i, "").replace(/\/+$/, "");
    return `${u.hostname.toLowerCase()}${p}`;
  } catch {
    return null;
  }
}

function readImages(exposeNode) {
  const holder = child(exposeNode, "images");
  const out = [];
  const seen = new Set();
  let duplicates = 0;
  for (const node of childrenNamed(holder || {}, "image")) {
    const variant = (name) => {
      const t = textContent(child(node, name)).trim();
      return /^https:\/\//i.test(t) ? t : null;
    };
    const source = variant("source");
    const thumb = variant("source_thumbnail");
    const xxl = variant("source_XXL");
    const best = xxl || source || thumb;
    const others = {};
    for (const c of elements(node)) {
      if (["source", "source_thumbnail", "source_xxl"].includes(c.lname)) continue;
      const t = textContent(c).trim();
      if (t) others[c.lname] = t.slice(0, 300);
    }
    const meta = { ...attributes(node), ...others };
    const hint = Object.entries(meta).map(([k, v]) => `${k}=${v}`).join(" ");
    const role = /grundriss|floor\s?-?plan|lageplan|schnitt\b|ansicht\s*plan/i.test(hint) ? "floorplan" : "photo";
    const assetKey = best ? imageAssetKey(best) : null;
    if (assetKey && seen.has(assetKey)) {
      duplicates++;
      continue;
    }
    if (assetKey) seen.add(assetKey);
    out.push({
      index: out.length,
      api_id: attr(node, "id"),
      role,
      asset_key: assetKey,
      url: best,
      source_url: source,
      thumb_url: thumb,
      xxl_url: xxl,
      caption: meta.title || meta.caption || meta.description || meta.name || null,
    });
  }
  return { images: out, duplicates, declared: childrenNamed(holder || {}, "image").length };
}

/** Structure of elements the importer does not map yet: names, attribute names, kind of text – no content. */
function describeUnmapped(expose, names) {
  const out = new Set();
  const walk = (node, trail) => {
    const kids = elements(node);
    const here = `${trail}${node.lname}${Object.keys(attributes(node)).length ? `@${Object.keys(attributes(node)).sort().join(",")}` : ""}`;
    if (!kids.length) {
      const t = textContent(node).trim();
      const kind = !t ? "leer" : /^https?:\/\//i.test(t) ? `url:${(() => { try { const u = new URL(t); return `${u.hostname}${(/\.[a-z0-9]{2,5}$/i.exec(u.pathname) || [""])[0]}`; } catch { return "?"; } })()}` : `text:${t.length}`;
      out.add(`${here}[${kind}]`);
    } else for (const k of kids) walk(k, `${here}>`);
  };
  for (const c of elements(expose)) if (names.includes(c.lname)) walk(c, "");
  return [...out].slice(0, 40);
}

function sectionFromItem(it) {
  if (it.sub.length) {
    const parts = [];
    const texts = [];
    const own = sanitizeRichText(it.raw);
    if (own.html) {
      parts.push(own.html);
      texts.push(own.text);
    }
    for (const s of it.sub) {
      const body = sanitizeRichText(s.raw);
      if (!s.title && !body.text) continue;
      parts.push(`${s.title ? `<p><strong>${escapeHtml(s.title)}</strong></p>` : ""}${body.html}`);
      texts.push([s.title, body.text].filter(Boolean).join("\n"));
    }
    return { id: it.id || null, title: it.title || it.id || "Weitere Angaben", html: parts.join("\n"), text: texts.join("\n\n") };
  }
  const body = sanitizeRichText(it.raw);
  return { id: it.id || null, title: it.title || it.id || "Weitere Angaben", html: body.html, text: body.text };
}

/**
 * @param {object} prop    entry from parseListResponse().properties
 * @param {object} expose  <expose> element from parseExposeResponse()
 * @param {{ position: number, addressMode?: "locality"|"street", expectedOwnerGuid?: string|null }} ctx
 */
export function normalizeListing(prop, expose, ctx) {
  const { position, addressMode = "locality", expectedOwnerGuid = null } = ctx;
  const where = `Angebot ${prop.onlineId}`;
  const estate = child(expose, "estate");
  const problem = (code, message) => new ImmoweltError(code, `${where}: ${message}`, { onlineId: prop.onlineId });

  // --- identity: list and exposé must describe the same offer ---
  const eGuid = normalizeGuid(attr(estate, "guid"));
  const eOnline = normalizeOnlineId(attr(estate, "onlineid"));
  const eId = normalizeEstateId(attr(estate, "id"));
  if (!eGuid || eGuid !== prop.guid) throw problem("immowelt_identity_mismatch", "GUID im Exposé weicht von der Liste ab.");
  if (eOnline && eOnline !== prop.onlineId) throw problem("immowelt_identity_mismatch", "Online-ID im Exposé weicht von der Liste ab.");
  if (eId && eId !== prop.estateId) throw problem("immowelt_identity_mismatch", "Objekt-ID im Exposé weicht von der Liste ab.");
  const ownerGuid = normalizeGuid(attr(child(expose, "address"), "AdrGuid"));
  if (expectedOwnerGuid && ownerGuid && ownerGuid !== normalizeGuid(expectedOwnerGuid)) {
    throw problem("immowelt_owner_mismatch", "Angebot gehört laut Exposé nicht zum Eichmann-Profil.");
  }

  const items = readItems(estate);
  const byId = (re) => items.find((it) => re.test(it.id));
  const onlineItem = byId(/^onlineid$/i);
  if (onlineItem && normalizeOnlineId(plainText(onlineItem.raw)) && normalizeOnlineId(plainText(onlineItem.raw)) !== prop.onlineId) {
    throw problem("immowelt_identity_mismatch", "Online-ID-Feld im Exposé weicht von der Liste ab.");
  }

  // --- marketing type ---
  const category = fieldOf(prop, "Category");
  const listType = fieldAttr(category, "saleRentID");
  const exposeType = attr(estate, "salestype");
  const types = [listType, exposeType].filter((v) => v != null && String(v).trim() !== "").map((v) => SALES_TYPE[String(v).trim()] || `unbekannt:${v}`);
  if (!types.length) throw problem("immowelt_unknown_sales_type", "Vermarktungsart (Kauf/Miete) fehlt.");
  if (new Set(types).size > 1) throw problem("immowelt_unknown_sales_type", `Vermarktungsart widersprüchlich (${types.join(" / ")}).`);
  const marketing = types[0];
  if (!MARKETING_LABEL[marketing]) throw problem("immowelt_unknown_sales_type", `Vermarktungsart ${marketing} ist nicht abgebildet.`);

  // --- title ---
  const titleItem = byId(/^description$/i);
  const title = (titleItem ? plainText(titleItem.raw) : "") || plainText(fieldOf(prop, "Description")?.text || "");
  if (!title) throw problem("immowelt_incomplete", "Überschrift fehlt.");

  // --- price ---
  const priceField = fieldOf(prop, "Price");
  const listPrice = parseApiNumber(fieldAttr(priceField, "Complete"));
  const priceItems = items.filter(isPriceItem);
  const onRequestSignals = [
    ...priceItems.filter((it) => !isSidePrice(it)).map((it) => plainText(it.raw)),
    priceField?.text || "",
    ...Object.entries(priceField?.attrs || {}).filter(([k, v]) => /request|anfrage/i.test(k) && /^(true|1|yes|ja)$/i.test(String(v))).map(() => "auf Anfrage"),
  ];
  const priceOnRequest = !(listPrice > 0) || onRequestSignals.some((t) => ON_REQUEST_RE.test(t));
  const priceEur = priceOnRequest ? null : round2(listPrice);
  const pricedItem = priceItems.find((it) => priceEur != null && Math.abs((parseGermanNumber(plainText(it.raw)) ?? NaN) - priceEur) < 0.005) || null; // no matching item → neutral label, never the label of some other price
  const priceLabel = pricedItem?.title || (marketing === "miete" ? "Miete" : "Kaufpreis");
  const price = priceOnRequest ? "Preis auf Anfrage" : marketing === "miete" ? `${formatEuro(priceEur)} ${priceLabel}` : formatEuro(priceEur);

  // --- core numbers ---
  const livingField = fieldOf(prop, "LivingArea");
  const landField = fieldOf(prop, "LandArea");
  const livingValue = parseApiNumber(fieldAttr(livingField, "value")) ?? parseGermanNumber(plainText(byId(/^arealiving$/i)?.raw || ""));
  const plotValue = parseApiNumber(fieldAttr(landField, "value")) ?? parseGermanNumber(plainText(byId(/^area(land|plot)$/i)?.raw || ""));
  const roomsValue = parseApiNumber(fieldOf(prop, "Rooms")?.text) ?? parseGermanNumber(fieldOf(prop, "Rooms")?.text || "") ?? parseGermanNumber(plainText(byId(/^rooms$/i)?.raw || ""));

  // --- location ---
  const locText = (re) => plainText(byId(re)?.raw || "") || null;
  const zipCity = locText(/^locationzipcity$/i);
  const zip = locText(/^locationzip$/i) || fieldOf(prop, "Zip")?.text || (zipCity ? (/\b\d{5}\b/.exec(zipCity) || [])[0] : null) || null;
  const cityRaw = locText(/^locationcity$/i) || fieldOf(prop, "City")?.text || (zipCity ? zipCity.replace(/\b\d{5}\b/, "").trim() : null) || null;
  const { city, district: cityDistrict } = splitCity(cityRaw);
  const districtRaw = locText(/^location(district|quarter|ortsteil|stadtteil)$/i) || cityDistrict || prop.attrs.GeoDescription || null;
  // Immowelt names the quarter as "Konstanz (Wollmatingen)" – the quarter is the part in brackets
  const dParts = splitCity(districtRaw);
  const district = dParts.district && city && dParts.city.toLowerCase() === city.toLowerCase() ? dParts.district : districtRaw;
  const street = addressMode === "street" ? locText(/^locationstreet$/i) : null;
  const location = city ? `${district && district !== city ? `${district}, ` : ""}${city}${zip ? ` (${zip})` : ""}` : zip || null;

  // --- facts and sections, in Immowelt's order ---
  const factRows = [];
  const sections = [];
  const consumed = new Set([titleItem].filter(Boolean));
  const typeText = plainText(category?.text || "") || null;
  if (typeText) factRows.push({ id: "_category", label: "Objektart", value: typeText });
  factRows.push({ id: "_marketing", label: "Vermarktung", value: MARKETING_LABEL[marketing] });
  if (location) factRows.push({ id: "_location", label: "Lage", value: location });
  for (const it of items) {
    if (consumed.has(it)) continue;
    if (isLocationItem(it)) {
      // Structured address parts are merged into "Lage"; the street only when the address mode allows it.
      if (/^locationstreet$/i.test(it.id) && addressMode === "street" && street) factRows.push({ id: it.id, label: it.title || "Straße", value: street });
      continue;
    }
    const flat = plainText(it.raw);
    if (priceOnRequest && isPriceItem(it) && !isSidePrice(it) && !ON_REQUEST_RE.test(flat) && parseGermanNumber(flat) != null) continue; // never leak a stored amount – in no form
    const structured = it.sub.length > 0 || isSectionId(it.id) || /<\s*(br|p|ul|ol|li|div)\b/i.test(it.raw) || flat.length > 160;
    if (structured) {
      const sec = sectionFromItem(it);
      if (sec.text) sections.push(sec);
      continue;
    }
    if (!flat) continue; // deliberately empty on Immowelt → not shown, nothing kept from earlier
    factRows.push({ id: it.id || null, label: it.title || it.id || "Angabe", value: flat });
  }
  if (priceOnRequest && !factRows.some((r) => ON_REQUEST_RE.test(r.value))) {
    factRows.splice(Math.min(3, factRows.length), 0, { id: "_price", label: marketing === "miete" ? "Miete" : "Kaufpreis", value: "auf Anfrage" });
  }

  const referenceItem = items.find((it) => /^(referen[cz]e?(number|nummer)?|objekt-?nr|estatenumber|objectnumber)$/i.test(it.id) || /^(referenz(nummer)?|objekt-?(nr\.?|nummer))$/i.test(it.title));
  const sectionText = (re) => sections.find((s) => re.test(s.id || "") || re.test(s.title || ""))?.text || null;

  const { images, duplicates, declared } = readImages(expose);
  const extensions = {};
  for (const c of elements(child(expose, "extensions") || {})) extensions[c.lname] = String(attr(c, "visible") ?? "").toLowerCase() === "true";
  const known = new Set(["address", "estate", "images", "extensions", "geodata"]);
  const unmapped = [...new Set(elements(expose).map((c) => c.lname).filter((n) => !known.has(n)))];

  const facts = {};
  for (const r of factRows) if (!r.id?.startsWith("_") && facts[r.label] === undefined) facts[r.label] = r.value;
  if (zip) facts.PLZ = facts.PLZ ?? zip;
  if (city) facts.Ort = facts.Ort ?? city;

  const listing = {
    id: dashedGuid(prop.guid),
    immowelt_id: dashedGuid(prop.guid),
    immowelt_guid: prop.guid,
    immowelt_estate_id: prop.estateId,
    immowelt_online_id: prop.onlineId,
    immowelt_api: true,
    origin: "immowelt",
    source: "immowelt",
    sync_policy: "mirror",
    position,
    marketing,
    status: MARKETING_LABEL[marketing],
    price_on_request: priceOnRequest,
    price_eur: priceEur,
    price_label: priceLabel,
    price,
    title,
    type: typeText,
    rooms: roomsValue != null ? formatRooms(roomsValue) : null,
    rooms_value: roomsValue,
    living_area: livingValue != null && livingValue > 0 ? formatArea(livingValue) : null,
    living_area_value: livingValue != null && livingValue > 0 ? livingValue : null,
    plot_area: plotValue != null && plotValue > 0 ? formatArea(plotValue) : null,
    plot_area_value: plotValue != null && plotValue > 0 ? plotValue : null,
    location,
    city,
    zip,
    district: district && district !== city ? district : null,
    street,
    expose_url: `https://www.immowelt.de/expose/${prop.onlineId}`,
    reference_number: referenceItem ? plainText(referenceItem.raw) || null : null,
    short_description: null,
    fact_rows: factRows,
    facts,
    sections,
    // legacy text fields, derived 1:1 from the sections for readers that still expect them
    description: sectionText(/^(info1|objektbeschreibung)$/i) ?? sections[0]?.text ?? null,
    location_description: sectionText(/^(info3|lagebeschreibung|lage)$/i),
    additional_information: sectionText(/^(info2|sonstiges)$/i),
    amenities: [],
    media: images,
    images: images.filter((m) => m.role === "photo").map((m) => m.url),
    floor_plans: images.filter((m) => m.role === "floorplan").map((m) => m.url),
    main_image_url: images.find((m) => m.role === "photo")?.url || images[0]?.url || null,
    image_base: null,
    gallery_bases: [],
    floor_plan_bases: [],
    extensions,
    api_notes: { declared_images: declared, duplicate_image_assets: duplicates, unmapped_elements: unmapped, unmapped_outline: describeUnmapped(expose, unmapped), owner_guid_checked: Boolean(expectedOwnerGuid && ownerGuid) },
    active: true,
    detail_page: true,
    site_hidden: false,
    missing_on_immowelt: false,
  };
  listing.core_hash = coreHash(listing);
  return listing;
}

/** Hash over everything Immowelt delivered for this offer (not: position, local slug, file names). */
export function coreHash(L) {
  return sha256(
    stableJson({
      ids: [L.immowelt_guid, L.immowelt_estate_id, L.immowelt_online_id],
      marketing: L.marketing,
      price_on_request: L.price_on_request,
      price_eur: L.price_eur,
      price_label: L.price_label,
      title: L.title,
      type: L.type,
      rooms: L.rooms_value,
      living: L.living_area_value,
      plot: L.plot_area_value,
      location: [L.location, L.street],
      reference: L.reference_number,
      facts: L.fact_rows.map((r) => [r.id, r.label, r.value]),
      sections: L.sections.map((s) => [s.id, s.title, s.html]),
      media: L.media.map((m) => [m.role, m.asset_key, m.caption]),
      extensions: L.extensions,
    })
  );
}

/** Final per-listing hash: delivered content + the actual bytes of every picture. */
export function contentHash(L) {
  return sha256(stableJson({ core: L.core_hash, media: (L.media || []).map((m) => m.sha256 || null) }));
}

/** Order-sensitive fingerprint of the whole inventory. */
export function snapshotFingerprint(listings) {
  return sha256(stableJson(listings.map((L) => [L.immowelt_guid, L.content_hash || L.core_hash])));
}

/**
 * @param {{ inventories: object[], exposes: Map<string, object>, fetchedAt: string, config: object }} input
 */
export function buildSnapshot({ inventories, exposes, fetchedAt, config }) {
  const listings = [];
  const seen = new Set();
  for (const inv of inventories) {
    for (const prop of inv.properties) {
      if (seen.has(prop.guid)) continue; // same offer under two GeoIDs
      seen.add(prop.guid);
      const expose = exposes.get(prop.guid);
      if (!expose) throw new ImmoweltError("immowelt_incomplete", `Angebot ${prop.onlineId}: Exposé fehlt.`, { onlineId: prop.onlineId });
      listings.push(normalizeListing(prop, expose, { position: listings.length, addressMode: config.addressMode, expectedOwnerGuid: config.profileGuid }));
    }
  }
  return {
    schema: SNAPSHOT_SCHEMA,
    source: "immowelt_official_api",
    fetched_at: fetchedAt,
    geo_ids: inventories.map((i) => i.geoId),
    total_count: listings.length,
    reported_total_counts: inventories.map((i) => ({ geo_id: i.geoId, total_count: i.totalCount, pages: i.pages.length })),
    address_mode: config.addressMode,
    listings,
  };
}

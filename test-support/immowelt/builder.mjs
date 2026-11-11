/**
 * Test double for the Immowelt SOAP API and its image host.
 * Ids of the ten offers match the real inventory of 11.11.2026 (online ids, the two known
 * GUIDs); all texts and pictures are invented.
 */
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

const x = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const hex = (seed, n = 32) => createHash("sha256").update(seed).digest("hex").slice(0, n).toUpperCase();
const uuid = (seed) => {
  const h = hex(seed).toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

export const PROFILE_GUID = "3b18336c6a2e401da38e9cc20268270d";

function offer(onlineId, o) {
  const guid = o.guid || hex(`guid:${onlineId}`);
  const images = o.images ?? 4;
  return {
    onlineId,
    estateId: o.estateId || String(90100000 + (parseInt(hex(`id:${onlineId}`, 6), 16) % 90000)),
    guid,
    salesType: o.salesType ?? 1,
    category: o.category || "Wohnung",
    title: o.title,
    price: o.price ?? null, // null → Preis auf Anfrage
    priceItem: o.priceItem || (o.salesType === 2 ? { id: "PriceWarmmiete", title: "Warmmiete" } : { id: "PriceKaufpreis", title: "Kaufpreis" }),
    area: o.area,
    rooms: o.rooms,
    zip: o.zip || "78467",
    city: o.city || "Konstanz",
    street: o.street || "Fixturestraße 1",
    reference: o.reference || null,
    items: o.items || [],
    info1: o.info1 ?? `Fixture-Objektbeschreibung ${onlineId}, Absatz eins.<br/>Zweite Zeile.<br/><br/>Absatz zwei.`,
    info2: o.info2 ?? `Fixture-Sonstiges ${onlineId}.`,
    info3: o.info3 ?? `Fixture-Lagebeschreibung ${onlineId}.`,
    images: Array.from({ length: images }, (_, i) => ({ asset: uuid(`asset:${onlineId}:${i}`), variant: uuid(`variant:${onlineId}:${i}`), floorplan: Boolean(o.floorplans && i >= images - o.floorplans) })),
    ownerGuid: o.ownerGuid || PROFILE_GUID,
  };
}

/** The ten offers the API returned on 11.11.2026 (numbers from the brief, texts invented). */
export function realInventory() {
  return [
    offer("2ql2c52", { estateId: "90187795", guid: "E40350BE25F949F081CCE3377E64699A", salesType: 2, title: "Möblierte sonnige 1 Zimmerwohnung", price: 1200, area: 26, rooms: 1, zip: "78464", images: 16 }),
    offer("2k57b5v", { title: "3 Zimmerwohnung Konstanz Wollmatingen", price: 330000, area: 67, rooms: 3 }),
    offer("2gwzk5x", { title: "Fixture Dachgeschosswohnung Wollmatingen", price: 826925, area: 106.7, rooms: 3, images: 6, floorplans: 2 }),
    offer("2geq25e", { title: "A3 Fixture Erdgeschosswohnung", price: 361500, area: 46.54, rooms: 2, reference: "A3" }),
    offer("2ggn25e", { title: "A2 Fixture Erdgeschosswohnung", price: 363700, area: 47.04, rooms: 2, reference: "A2" }),
    offer("2f42h56", { title: "Fixture Dachgeschosswohnung A12", price: 738100, area: 102.34, rooms: 4, reference: "A12" }),
    offer("2fayg56", { title: "Fixture Dachgeschosswohnung A9", price: 696200, area: 95.49, rooms: 4, reference: "A9" }),
    offer("2fsjg56", { title: "Fixture Wohnung A5", price: 641200, area: 89.54, rooms: 3, reference: "A5" }),
    offer("2ewd75c", { title: "Fixture 4-Zimmer-Wohnung Petershausen", price: 735000, area: 95.7, rooms: 4 }),
    offer("2zbf747", { guid: "7BFF84E78370471DB3595319C8DF10EF", title: "4 Zimmer Wohnung B9 / Haus B", price: null, area: 93.22, rooms: 4, reference: "B9" }),
  ];
}
export { offer };

const de = (n, digits = 2) => new Intl.NumberFormat("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
export const imageUrl = (img, size) => `https://ms.immowelt.org/${img.asset}/${img.variant}/${size}`;

export function listProperty(o) {
  const price = o.price == null ? `<Price Complete="0.0000">auf Anfrage</Price>` : `<Price Complete="${o.price.toFixed(4)}">${x(de(o.price, 0))} €</Price>`;
  return `<EstateProperty id="${o.estateId}" guid="${o.guid}" onlineID="${o.onlineId}">
  <Category saleRentID="${o.salesType}">${x(o.category)}</Category>
  <Description>${x(o.title)}</Description>
  ${price}
  <LivingArea value="${o.area}" unit="m²">${x(de(o.area))} m²</LivingArea>
  <Rooms>${o.rooms}</Rooms>
  <Zip>${x(o.zip)}</Zip>
  <City>${x(o.city)}</City>
  <UrlExpose>https://www.immowelt.de/expose/${o.onlineId}</UrlExpose>
  <PreviewImage>~/App_Themes/MID_{0}/images/Immobilien/NoPicThumbnail_s.png</PreviewImage>
</EstateProperty>`;
}

export function listEnvelope({ status = "OK", offers = [], totalCount = offers.length, pageSize = 50, page = 1, omitTotalCount = false } = {}) {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>
<GetListCustomerProjectsResponse xmlns="http://immowelt.de/services"><GetListCustomerProjectsResult>
<Status>${status}</Status>
<EstatePropertyList>${offers.map(listProperty).join("\n")}</EstatePropertyList>
${omitTotalCount ? "" : `<TotalCount>${totalCount}</TotalCount>`}<PageSize>${pageSize}</PageSize><CurrentPage>${page}</CurrentPage>
</GetListCustomerProjectsResult></GetListCustomerProjectsResponse>
</soap:Body></soap:Envelope>`;
}

export function exposeInner(o) {
  const item = (id, title, desc) => `<item id="${id}"><title>${x(title)}</title><description>${x(desc)}</description></item>`;
  const priceText = o.price == null ? "auf Anfrage" : `${de(o.price)} €${o.salesType === 2 ? " (inkl. Nebenkosten)" : ""}`;
  const items = [
    item("OnlineID", "Online-ID", o.onlineId.toUpperCase()),
    item("Description", "Objekt", o.title),
    item(o.priceItem.id, o.priceItem.title, priceText),
    ...(o.reference ? [item("ReferenceNumber", "Referenznummer", o.reference)] : []),
    item("LocationStreet", "Straße", o.street),
    item("LocationZipCity", "Ort", `${o.zip} ${o.city}`),
    item("LocationZip", "PLZ", o.zip),
    item("LocationCity", "Ort", o.city),
    item("AreaLiving", "Wohnfläche", `${de(o.area)} m²`),
    item("Rooms", "Zimmer", String(o.rooms)),
    ...o.items.map((it) => item(it.id, it.title, it.value)),
    ...(o.info1 ? [item("Info1", "Objektbeschreibung", o.info1)] : []),
    ...(o.info2 ? [item("Info2", "Sonstiges", o.info2)] : []),
    ...(o.info3 ? [item("Info3", "Lagebeschreibung", o.info3)] : []),
  ];
  const images = o.images
    .map((img, i) => `<image id="${i}"${img.floorplan ? ' type="Grundriss"' : ""}><source>${imageUrl(img, "480x0")}</source><source_thumbnail>${imageUrl(img, "100x70")}</source_thumbnail><source_XXL>${imageUrl(img, "640x0")}</source_XXL></image>`)
    .join("");
  return `<expose><address AdrGuid="${o.ownerGuid}"/><estate id="${o.estateId}" guid="${o.guid}" onlineid="${o.onlineId}" salestype="${o.salesType}">
${items.join("\n")}
</estate><images>${images}</images>${(o.documents || []).length ? `<attachments>${o.documents.map((d, i) => `<document id="${i}"><source>https://ms.immowelt.org/doc-${d}</source></document>`).join("")}</attachments>` : ""}
<extensions><environmentmap visible="true"/><contactformular visible="true"/></extensions><GeoData><Latitude>47.0</Latitude><Longitude>9.0</Longitude></GeoData></expose>`;
}

export function exposeEnvelope(o, { status = "OK", innerXml = null } = {}) {
  const inner = innerXml ?? (o ? exposeInner(o) : "");
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>
<GetEstateExposeByEstateGuidResponse xmlns="http://immowelt.de/"><GetEstateExposeByEstateGuidResult>
<Status>${status}</Status><XmlExpose>${status === "OK" ? x(inner) : ""}</XmlExpose>
</GetEstateExposeByEstateGuidResult></GetEstateExposeByEstateGuidResponse>
</soap:Body></soap:Envelope>`;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * Deterministic REAL picture (16×12 PNG, colours derived from asset id and revision), so the
 * same fixtures work with the production image processor (sharp) in CI.
 */
export function imageBytes(assetId, revision = 0) {
  const seed = createHash("sha256").update(`${assetId}:${revision}`).digest();
  const w = 16;
  const h = 12;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = seed[(x + y) % 32];
      raw[o + 1] = seed[(x * 3 + 7) % 32];
      raw[o + 2] = seed[(y * 5 + 11) % 32];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

/**
 * fetch() replacement. `state` is mutable so a test can change Immowelt between runs:
 *   state.offers           current inventory (array order = API order)
 *   state.pageSizeOverride force small pages
 *   state.hooks            { list(page, call), expose(guid, call), image(url, call) } → return a Response to override
 *   state.imageRevisions   Map(asset → revision) to change bytes behind the same URL
 */
export function fakeImmowelt(state) {
  state.calls = state.calls || { list: 0, expose: 0, image: 0, auth: [] };
  state.imageRevisions = state.imageRevisions || new Map();
  const respond = (body, status = 200, headers = {}) => new Response(body, { status, headers: { "content-type": "text/xml; charset=utf-8", ...headers } });
  return async function fetchImpl(url, init = {}) {
    const u = String(url);
    if (u.includes("EstateService.asmx")) {
      state.calls.list++;
      const body = String(init.body || "");
      state.calls.auth.push(/<tns:ApiKey>([^<]*)</.exec(body)?.[1] || "");
      if (state.apiKey && !body.includes(`<tns:ApiKey>${state.apiKey}</tns:ApiKey>`)) return respond("<soap:Envelope xmlns:soap='http://schemas.xmlsoap.org/soap/envelope/'><soap:Body><soap:Fault><faultstring>Access denied</faultstring></soap:Fault></soap:Body></soap:Envelope>", 500);
      if (!/<tns:GeoID>\d+<\/tns:GeoID>/.test(body)) return respond(listEnvelope({ status: "UnknownLocation", offers: [], totalCount: 0 }));
      const page = Number(/<tns:CurrentPage>(\d+)</.exec(body)?.[1] || 1);
      const pageSize = state.pageSizeOverride || Number(/<tns:PageSize>(\d+)</.exec(body)?.[1] || 50);
      const hooked = state.hooks?.list?.(page, state.calls.list);
      if (hooked) return hooked instanceof Response ? hooked : respond(hooked);
      const offers = state.offers.slice((page - 1) * pageSize, page * pageSize);
      return respond(listEnvelope({ offers, totalCount: state.offers.length, pageSize, page, status: state.offers.length ? "OK" : state.emptyStatus || "OK" }));
    }
    if (u.includes("EstateExpose.asmx")) {
      state.calls.expose++;
      const guid = /<tns:EstateGuid>([^<]+)</.exec(String(init.body || ""))?.[1];
      const hooked = state.hooks?.expose?.(guid, state.calls.expose);
      if (hooked) return hooked instanceof Response ? hooked : respond(hooked);
      const o = state.offers.find((c) => c.guid === guid);
      if (!o) return respond(exposeEnvelope(null, { status: "Invalid" }));
      return respond(exposeEnvelope(o));
    }
    if (u.startsWith("https://ms.immowelt.org/")) {
      state.calls.image++;
      const hooked = state.hooks?.image?.(u, state.calls.image, init);
      if (hooked) return hooked;
      const asset = u.split("/")[3];
      if (asset.startsWith("doc-")) return new Response(Buffer.from(`%PDF-1.4\n% ${asset}\n%%EOF\n`), { status: 200, headers: { "content-type": "application/pdf" } });
      const rev = state.imageRevisions.get(asset) || 0;
      const etag = `"${asset}-${rev}"`;
      if (init.headers && (init.headers["If-None-Match"] || init.headers["if-none-match"]) === etag) return new Response(null, { status: 304, headers: { etag } });
      return new Response(imageBytes(asset, rev), { status: 200, headers: { "content-type": "image/png", etag } });
    }
    return new Response("not found", { status: 404 });
  };
}

export const respondXml = (body, status = 200) => new Response(body, { status, headers: { "content-type": "text/xml; charset=utf-8" } });

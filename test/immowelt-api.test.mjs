import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseXml, XmlError, attr, child, textContent } from "../scripts/lib/immowelt/xml.mjs";
import { sanitizeRichText, plainText } from "../scripts/lib/immowelt/html.mjs";
import { buildListEnvelope, buildExposeEnvelope, parseListResponse, parseExposeResponse, fetchInventory, fetchExpose, soapCall, ImmoweltError } from "../scripts/lib/immowelt/soap.mjs";
import { normalizeListing, buildSnapshot, coreHash, parseGermanNumber, formatEuro } from "../scripts/lib/immowelt/normalize.mjs";
import { validateSnapshot, classifyChange, needsConfirmation, confirmationState } from "../scripts/lib/immowelt/validate.mjs";
import { normalizeGuid, dashedGuid, planLegacyMigration } from "../scripts/lib/immowelt/identity.mjs";
import { realInventory, offer, fakeImmowelt, listEnvelope, exposeEnvelope, exposeInner, respondXml, PROFILE_GUID } from "../test-support/immowelt/builder.mjs";

const fx = (name) => readFileSync(new URL(`./fixtures/immowelt/${name}`, import.meta.url), "utf8");
const noSleep = { sleepImpl: async () => {}, retries: 2 };
const cfg = { addressMode: "locality", profileGuid: PROFILE_GUID };
const callWith = (state) => (url, action, envelope, soap) => soapCall(url, action, envelope, { ...soap, ...noSleep, fetchImpl: fakeImmowelt(state) });

async function snapshotOf(state, config = cfg) {
  const call = callWith(state);
  const inv = await fetchInventory("k", { call });
  const exposes = new Map();
  for (const p of inv.properties) exposes.set(p.guid, (await fetchExpose("k", p.guid, { call })).expose);
  return buildSnapshot({ inventories: [inv], exposes, fetchedAt: "2026-11-11T10:00:00.000Z", config });
}

/* ---------- XML ---------- */
test("XML: abgeschnittene oder kaputte Dokumente schlagen fehl statt repariert zu werden", () => {
  assert.throws(() => parseXml("<a><b>text</a>"), XmlError);
  assert.throws(() => parseXml("<a><b>text</b>"), /nicht geschlossen/);
  assert.throws(() => parseXml("<a/><b/>"), /mehr als ein Wurzelelement/);
  assert.throws(() => parseXml('<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>'), /DOCTYPE/);
  assert.throws(() => parseXml("<a b=1/>"), XmlError);
});
test("XML: Attribute mit '>' im Wert, CDATA, Entities, Leerraum bleibt erhalten", () => {
  const root = parseXml('<r xmlns:n="u"><n:x a="1 &gt; 0" B=\'q\'>  zwei  Leer &amp; &#228; <![CDATA[<br/>]]></n:x></r>');
  const x = child(root, "x");
  assert.equal(attr(x, "a"), "1 > 0");
  assert.equal(attr(x, "b"), "q");
  assert.equal(textContent(x), "  zwei  Leer & ä <br/>");
});

/* ---------- HTML ---------- */
test("HTML: nur erlaubtes Markup, Wortlaut unverändert", () => {
  const r = sanitizeRichText('Zeile eins<br/>Zeile zwei<br><br>Absatz &amp; mehr<script>alert(1)</script> Ende <b onclick="x()">fett</b> <a href="javascript:alert(1)">böse</a> <a href="https://example.org/a?b=1&amp;c=2">gut</a>');
  assert.equal(r.text, "Zeile eins\nZeile zwei\n\nAbsatz & mehr Ende fett böse gut");
  assert.equal(r.html, '<p>Zeile eins<br>Zeile zwei</p>\n<p>Absatz &amp; mehr Ende <strong>fett</strong> böse <a href="https://example.org/a?b=1&amp;c=2" target="_blank" rel="nofollow noopener noreferrer">gut</a></p>');
  assert.ok(!/script|onclick|javascript/i.test(r.html));
});
test("HTML: Listen, reiner Text mit Zeilenumbrüchen, einzelnes '<'", () => {
  assert.equal(sanitizeRichText("<ul><li>Balkon</li><li>Keller &uuml;ber 5 m&sup2;</li></ul>").html, "<ul><li>Balkon</li><li>Keller über 5 m²</li></ul>");
  assert.equal(sanitizeRichText("A\nB\n\nC").html, "<p>A<br>B</p>\n<p>C</p>");
  assert.equal(plainText("Fläche < 50 m² & hell"), "Fläche < 50 m² & hell");
  assert.deepEqual(sanitizeRichText("   "), { html: "", text: "", blocks: [] });
});

/* ---------- Envelope / Liste ---------- */
test("Envelope: GeoID wird gesendet, Reihenfolge wie im WSDL, Schlüssel escaped", () => {
  const env = buildListEnvelope("a<b&c", { geoId: 108, page: 2, pageSize: 50 });
  assert.match(env, /<tns:GeoID>108<\/tns:GeoID>\s*<tns:ls>createdatedesc<\/tns:ls>\s*<tns:IncludeIwObj>true<\/tns:IncludeIwObj>\s*<tns:CurrentPage>2<\/tns:CurrentPage>\s*<tns:PageSize>50<\/tns:PageSize>/);
  assert.match(env, /<tns:ApiKey>a&lt;b&amp;c<\/tns:ApiKey>/);
  assert.match(buildExposeEnvelope("k", "e40350be-25f9-49f0-81cc-e3377e64699a"), /<tns:EstateGuid>E40350BE25F949F081CCE3377E64699A<\/tns:EstateGuid>/);
  assert.throws(() => buildExposeEnvelope("k", "2ql2c52"), /GUID ungültig/);
});
test("Liste (echte Struktur): 32-stellige GUID ohne Bindestriche wird akzeptiert", () => {
  const r = parseListResponse(fx("list-real-shape.xml"));
  assert.equal(r.totalCount, 1);
  assert.deepEqual(r.properties.map((p) => [p.estateId, p.guid, p.onlineId]), [["90187795", "E40350BE25F949F081CCE3377E64699A", "2ql2c52"]]);
  assert.equal(r.properties[0].fields.category.attrs.saleRentID, "2");
  assert.equal(r.properties[0].fields.price.attrs.Complete, "1200.0000");
});
test("Liste: UnknownLocation, fehlender TotalCount und ungültige Kennung sind Fehler, kein leerer Bestand", () => {
  assert.throws(() => parseListResponse(listEnvelope({ status: "UnknownLocation", offers: [], totalCount: 0 })), (e) => e.code === "immowelt_list_status" && e.statusName === "UnknownLocation");
  assert.throws(() => parseListResponse(listEnvelope({ offers: realInventory().slice(0, 1), omitTotalCount: true })), (e) => e.code === "immowelt_list_no_totalcount");
  const broken = listEnvelope({ offers: realInventory().slice(0, 2) }).replace('guid="E40350BE25F949F081CCE3377E64699A"', 'guid="kaputt"');
  assert.throws(() => parseListResponse(broken), (e) => e.code === "immowelt_list_parse");
});

/* ---------- Exposé (echte Struktur) ---------- */
test("Exposé (echte Struktur): item@id → Titel/Fakten/Abschnitte, Bildvarianten zählen einmal", () => {
  const list = parseListResponse(fx("list-real-shape.xml"));
  const { expose } = parseExposeResponse(exposeEnvelope(null, { innerXml: fx("expose-real-shape.inner.xml") }));
  const L = normalizeListing(list.properties[0], expose, { position: 0, ...cfg, expectedOwnerGuid: PROFILE_GUID });
  assert.equal(L.title, "Möblierte sonnige 1 Zimmerwohnung"); // früher fälschlich "Online-ID"
  assert.equal(L.id, "e40350be-25f9-49f0-81cc-e3377e64699a");
  assert.deepEqual([L.immowelt_guid, L.immowelt_estate_id, L.immowelt_online_id], ["E40350BE25F949F081CCE3377E64699A", "90187795", "2ql2c52"]);
  assert.deepEqual([L.marketing, L.status, L.price_eur, L.price, L.price_label], ["miete", "Miete", 1200, "1.200 € Warmmiete", "Warmmiete"]);
  assert.deepEqual([L.rooms, L.living_area, L.location], ["1 Zimmer", "26 m²", "Konstanz (78464)"]);
  assert.equal(L.media.length, 2); // früher 6 (thumbnail/source/XXL einzeln gezählt)
  assert.ok(L.media.every((m) => m.url.endsWith("/640x0") && m.thumb_url && m.source_url));
  assert.deepEqual(L.sections.map((s) => s.title), ["Ausstattung", "Objektbeschreibung", "Sonstiges", "Lagebeschreibung"]);
  assert.equal(L.sections[1].html, "<p>Fixture-Absatz eins der Objektbeschreibung.<br>Zweite Zeile im selben Absatz.</p>\n<p>Fixture-Absatz zwei mit &amp; und Rest.</p>");
  assert.match(L.sections[0].html, /<strong>Bad<\/strong>.*Dusche, Fenster.*<strong>Küche<\/strong>.*Einbauküche/s);
  const facts = Object.fromEntries(L.fact_rows.map((r) => [r.label, r.value]));
  assert.equal(facts["Warmmiete"], "1.200,00 € (inkl. Nebenkosten)");
  assert.equal(facts["Kaution"], "2.400,00 €");
  assert.equal(facts["Online-ID"], "2QL2C52");
  assert.equal(facts["Lage"], "Konstanz (78464)");
  assert.ok(!JSON.stringify(L).includes("Fixturestraße"), "Straße wird im Modus locality nicht übernommen");
  assert.deepEqual(L.extensions, { environmentmap: true, contactformular: true });
  assert.equal(L.expose_url, "https://www.immowelt.de/expose/2ql2c52");
});
test("Exposé: Adressmodus street übernimmt die Straße, falscher Eigentümer und fremde GUID schlagen fehl", () => {
  const list = parseListResponse(fx("list-real-shape.xml"));
  const inner = fx("expose-real-shape.inner.xml");
  const parse = (xml) => parseExposeResponse(exposeEnvelope(null, { innerXml: xml })).expose;
  const L = normalizeListing(list.properties[0], parse(inner), { position: 0, addressMode: "street" });
  assert.equal(L.street, "Fixturestraße 1");
  assert.ok(L.fact_rows.some((r) => r.label === "Straße" && r.value === "Fixturestraße 1"));
  assert.throws(() => normalizeListing(list.properties[0], parse(inner), { position: 0, expectedOwnerGuid: "00000000000000000000000000000000" }), (e) => e.code === "immowelt_owner_mismatch");
  assert.throws(() => normalizeListing(list.properties[0], parse(inner.replace('guid="E40350BE25F949F081CCE3377E64699A"', 'guid="00000000000000000000000000000001"')), { position: 0 }), (e) => e.code === "immowelt_identity_mismatch");
  assert.throws(() => normalizeListing(list.properties[0], parse(inner.replace('salestype="2"', 'salestype="1"')), { position: 0 }), (e) => e.code === "immowelt_unknown_sales_type");
  assert.throws(() => parseExposeResponse(exposeEnvelope(null, { status: "Invalid" })), (e) => e.code === "immowelt_expose_status" && e.statusName === "Invalid");
});

/* ---------- Vollständigkeit der Liste ---------- */
test("Paging: mehr als eine Seite wird bis TotalCount gelesen", async () => {
  const offers = Array.from({ length: 120 }, (_, i) => offer(`p${String(i).padStart(5, "0")}`, { estateId: String(70000000 + i), title: `Fixture ${i}`, price: 100000 + i, area: 50, rooms: 2, images: 0 }));
  const state = { offers };
  const inv = await fetchInventory("k", { call: callWith(state) });
  assert.equal(inv.totalCount, 120);
  assert.equal(inv.properties.length, 120);
  assert.equal(inv.pages.length, 3);
  assert.equal(inv.properties[119].onlineId, "p00119");
});
test("Paging: fehlende Seite → Fehler statt 'weniger Angebote'", async () => {
  const offers = Array.from({ length: 120 }, (_, i) => offer(`q${String(i).padStart(5, "0")}`, { estateId: String(71000000 + i), title: `Fixture ${i}`, price: 1, area: 1, rooms: 1, images: 0 }));
  const state = { offers, hooks: { list: (page) => (page === 2 ? listEnvelope({ offers: [], totalCount: 120, page: 2 }) : null) } };
  await assert.rejects(fetchInventory("k", { call: callWith(state) }), (e) => e.code === "immowelt_list_missing_page");
  assert.equal(state.calls.list, 6, "3 vollständige Versuche à 2 Seiten");
});
test("Paging: Duplikat über Seitengrenzen → Liste war in Bewegung → neu lesen, sonst Fehler", async () => {
  const offers = Array.from({ length: 4 }, (_, i) => offer(`d${String(i).padStart(5, "0")}`, { title: `Fixture ${i}`, price: 1, area: 1, rooms: 1, images: 0 }));
  let moving = true;
  const state = { offers, pageSizeOverride: 2, hooks: { list: (page) => (moving && page === 2 ? ((moving = false), listEnvelope({ offers: [offers[1], offers[2]], totalCount: 4, page: 2, pageSize: 2 })) : null) } };
  const inv = await fetchInventory("k", { call: callWith(state), pageSize: 2 });
  assert.equal(inv.attempts, 2);
  assert.deepEqual(inv.properties.map((p) => p.onlineId), ["d00000", "d00001", "d00002", "d00003"]);
  const always = { offers, pageSizeOverride: 2, hooks: { list: (page) => (page === 2 ? listEnvelope({ offers: [offers[1], offers[2]], totalCount: 4, page: 2, pageSize: 2 }) : null) } };
  await assert.rejects(fetchInventory("k", { call: callWith(always), pageSize: 2 }), (e) => e.code === "immowelt_list_unstable");
});
test("Paging: TotalCount größer als gelieferte Einträge (Parser-/API-Verlust) wird erkannt", async () => {
  const offers = realInventory();
  const state = { offers, hooks: { list: () => listEnvelope({ offers: offers.slice(0, 9), totalCount: 10 }) } };
  await assert.rejects(fetchInventory("k", { call: callWith(state) }), (e) => e.code === "immowelt_list_missing_page" || e.code === "immowelt_list_unstable");
});
test("Leerer Bestand ist gültig, wenn die API ihn vollständig meldet", async () => {
  for (const emptyStatus of ["OK", "NoData"]) {
    const inv = await fetchInventory("k", { call: callWith({ offers: [], emptyStatus }) });
    assert.equal(inv.totalCount, 0);
    assert.deepEqual(inv.properties, []);
  }
});

/* ---------- Transport ---------- */
test("Transport: Timeout/5xx werden wiederholt, Zugriff verweigert nicht; Schlüssel nie in Fehlermeldungen", async () => {
  let n = 0;
  const flaky = async () => (++n < 3 ? new Response("<x/>", { status: 503 }) : respondXml(listEnvelope({ offers: [] })));
  assert.equal(parseListResponse(await soapCall("u", "a", buildListEnvelope("SECRET-KEY-123"), { fetchImpl: flaky, ...noSleep })).totalCount, 0);
  assert.equal(n, 3);
  let denied = 0;
  const deny = async () => (denied++, new Response("<soap:Envelope xmlns:soap='x'><soap:Body><soap:Fault><faultstring>Access denied</faultstring></soap:Fault></soap:Body></soap:Envelope>", { status: 500 }));
  await assert.rejects(soapCall("u", "a", buildListEnvelope("SECRET-KEY-123"), { fetchImpl: deny, ...noSleep }), (e) => e.code === "immowelt_access_denied" && !e.message.includes("SECRET-KEY-123"));
  assert.equal(denied, 1);
  const hang = (_u, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  await assert.rejects(soapCall("u", "a", "x", { fetchImpl: hang, timeoutMs: 20, retries: 1, sleepImpl: async () => {} }), (e) => e.code === "immowelt_timeout" && e.attempts === 2);
  const cut = async () => respondXml(listEnvelope({ offers: realInventory() }).slice(0, 900));
  await assert.rejects(soapCall("u", "a", "x", { fetchImpl: cut, ...noSleep }), (e) => e.code === "immowelt_truncated");
});

/* ---------- Snapshot ---------- */
test("Snapshot der zehn Angebote: Kennungen, Kauf/Miete/auf Anfrage, Bildanzahl, Reihenfolge", async () => {
  const snap = await snapshotOf({ offers: realInventory() });
  assert.equal(snap.total_count, 10);
  assert.deepEqual(snap.listings.map((L) => L.immowelt_online_id), ["2ql2c52", "2k57b5v", "2gwzk5x", "2geq25e", "2ggn25e", "2f42h56", "2fayg56", "2fsjg56", "2ewd75c", "2zbf747"]);
  const by = Object.fromEntries(snap.listings.map((L) => [L.immowelt_online_id, L]));
  assert.deepEqual([by["2ql2c52"].marketing, by["2ql2c52"].price, by["2ql2c52"].media.length], ["miete", "1.200 € Warmmiete", 16]);
  assert.deepEqual([by["2gwzk5x"].price, by["2gwzk5x"].living_area, by["2gwzk5x"].floor_plans.length, by["2gwzk5x"].images.length], ["826.925 €", "106,7 m²", 2, 4]);
  assert.deepEqual([by["2geq25e"].living_area, by["2geq25e"].reference_number], ["46,54 m²", "A3"]);
  const b9 = by["2zbf747"];
  assert.deepEqual([b9.price_on_request, b9.price_eur, b9.price, b9.id], [true, null, "Preis auf Anfrage", "7bff84e7-8370-471d-b359-5319c8df10ef"]);
  assert.ok(b9.fact_rows.some((r) => /auf Anfrage/.test(r.value)));
  const v = validateSnapshot(snap);
  assert.deepEqual(v.errors, []);
  assert.ok(v.ok);
});
test("Preis auf Anfrage: hinterlegter Betrag der API wird nie veröffentlicht", async () => {
  const o = offer("2zbf747", { title: "B9", price: 695000, area: 93.22, rooms: 4 });
  const inner = exposeInner({ ...o, price: null });
  const prop = parseListResponse(listEnvelope({ offers: [o] })).properties[0]; // Liste liefert noch 695000
  const L = normalizeListing(prop, parseExposeResponse(exposeEnvelope(null, { innerXml: inner })).expose, { position: 0 });
  assert.equal(L.price_on_request, true);
  assert.ok(!/695/.test(JSON.stringify(L)), "kein Betrag im Datensatz");
});
test("Gate: Miete, kurze/leere Texte, keine Bilder und Leerbestand sind gültig; Zählfehler nicht", async () => {
  const rent = offer("2aaaaaa", { salesType: 2, title: "Fixture Miete", price: 480, area: 18, rooms: 1, images: 0, info1: "", info2: "", info3: "" });
  const snap = await snapshotOf({ offers: [rent] });
  const v = validateSnapshot(snap);
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.deepEqual(v.warnings.map((w) => w.code).sort(), ["no_images", "no_text"]);
  assert.ok(validateSnapshot(await snapshotOf({ offers: [] })).ok);
  const bad = await snapshotOf({ offers: realInventory() });
  bad.listings.pop();
  assert.equal(validateSnapshot(bad).errors[0].code, "snapshot_count_mismatch");
  const foreign = await snapshotOf({ offers: realInventory().slice(0, 1) });
  foreign.listings[0].media[0].url = "https://evil.example/x/640x0";
  assert.ok(validateSnapshot(foreign).errors.some((e) => e.code === "media_host"));
});
test("Änderungserkennung: Text, Kauf→Miete, Bildtausch, Bildreihenfolge, Angebotsreihenfolge", async () => {
  const base = await snapshotOf({ offers: realInventory() });
  const variant = async (mutate) => {
    const offers = realInventory();
    mutate(offers);
    return snapshotOf({ offers });
  };
  const diff = async (mutate) => classifyChange(base.listings, (await variant(mutate)).listings);
  assert.ok((await diff(() => {})).unchanged);
  assert.deepEqual((await diff((o) => (o[1].info1 = "Gekürzt."))).changed, ["2k57b5v"]);
  assert.deepEqual((await diff((o) => (o[1].info2 = ""))).changed, ["2k57b5v"]);
  assert.deepEqual((await diff((o) => Object.assign(o[1], { salesType: 2, price: 990, priceItem: { id: "PriceKaltmiete", title: "Kaltmiete" } }))).changed, ["2k57b5v"]);
  assert.deepEqual((await diff((o) => o[1].images.reverse())).changed, ["2k57b5v"]);
  assert.deepEqual((await diff((o) => o[1].images.pop())).changed, ["2k57b5v"]);
  const re = await diff((o) => o.reverse());
  assert.deepEqual([re.changed, re.added, re.removed, re.reordered, re.unchanged], [[], [], [], true, false]);
  const gone = await diff((o) => o.splice(0, 2));
  assert.deepEqual(gone.removed, ["2ql2c52", "2k57b5v"]);
  assert.equal(needsConfirmation(gone), null);
  assert.equal(needsConfirmation(await diff((o) => o.splice(0, 6))), "mass_removal");
  assert.equal(needsConfirmation(await diff((o) => o.splice(0, 10))), "empty_inventory");
});
test("Bestätigung: großer Wegfall erst nach identischer zweiter Antwort mit Abstand", () => {
  const a = confirmationState(null, { fingerprint: "f1", reason: "empty_inventory", now: "2026-11-11T10:00:00Z" });
  assert.equal(a.confirmed, false);
  assert.equal(confirmationState(a.pending, { fingerprint: "f1", reason: "empty_inventory", now: "2026-11-11T10:05:00Z" }).confirmed, false);
  assert.equal(confirmationState(a.pending, { fingerprint: "f1", reason: "empty_inventory", now: "2026-11-11T10:30:00Z" }).confirmed, true);
  const other = confirmationState(a.pending, { fingerprint: "f2", reason: "mass_removal", now: "2026-11-11T10:30:00Z" });
  assert.deepEqual([other.confirmed, other.pending.sightings], [false, 1]);
});

/* ---------- Identität ---------- */
test("Identität: Website-UUID ≠ API-GUID; Zuordnung nur über Kennungen, nie über Titel/Preis", async () => {
  assert.equal(normalizeGuid("{e40350be-25f9-49f0-81cc-e3377e64699a}"), "E40350BE25F949F081CCE3377E64699A");
  assert.equal(dashedGuid("7BFF84E78370471DB3595319C8DF10EF"), "7bff84e7-8370-471d-b359-5319c8df10ef");
  assert.equal(normalizeGuid("2ql2c52"), null);
  const snap = await snapshotOf({ offers: realInventory() });
  const koenigsbau = snap.listings[0];
  const legacy = [
    { id: "7bff84e7-8370-471d-b359-5319c8df10ef", slug: "wohnung-wollmatingen-7bff84e7", title: "4 Zimmer Wohnung B9 / Haus B", price: "695.000 €", active: true },
    // gleicher Titel und gleiche Fläche wie das API-Angebot, aber KEIN Kennungs-Beleg → kein Match
    { id: "c6b1d820-4e82-416d-95ad-22472a129955", slug: "penthouse-konigsbau-c6b1d820", title: koenigsbau.title, price: "199.000 €", active: true },
    { id: "32a8908e-c8e0-4944-b44f-f203ccdaa8a9", slug: "mehrfamilienhaus-wollmatingen-32a8908e", title: "Dreifamilienhaus", active: true },
    // Beleg über gemeinsame Bild-Assets
    { id: "e7e58fe2-a93f-44f2-bc73-dabd3c7208b3", slug: "wohnung-wollmatingen-e7e58fe2", title: "x", active: true, images: snap.listings[1].media.map((m) => m.url.replace("ms.immowelt.org", "cdnihddipa.cloudimg.io")) },
  ];
  const manual = [{ legacy_id: "32a8908e-c8e0-4944-b44f-f203ccdaa8a9", online_id: "2ewd75c", verified_by: "Test", verified_at: "2026-11-11" }];
  const plan = planLegacyMigration(legacy, snap.listings, manual);
  const d = Object.fromEntries(plan.legacy.map((x) => [x.slug, x]));
  assert.deepEqual([d["wohnung-wollmatingen-7bff84e7"].decision, d["wohnung-wollmatingen-7bff84e7"].evidence[0].type, d["wohnung-wollmatingen-7bff84e7"].target.online_id], ["match", "guid_equal", "2zbf747"]);
  assert.deepEqual([d["penthouse-konigsbau-c6b1d820"].decision, d["penthouse-konigsbau-c6b1d820"].evidence], ["retire", []]);
  assert.deepEqual([d["mehrfamilienhaus-wollmatingen-32a8908e"].decision, d["mehrfamilienhaus-wollmatingen-32a8908e"].evidence[0].type], ["match", "online_id_manual"]);
  assert.deepEqual([d["wohnung-wollmatingen-e7e58fe2"].decision, d["wohnung-wollmatingen-e7e58fe2"].evidence[0].type, d["wohnung-wollmatingen-e7e58fe2"].target.online_id], ["match", "media_asset_overlap", "2k57b5v"]);
  assert.equal(plan.created.length, 7);
  assert.equal(plan.ambiguous, 0);
});

test("Identität: Kennungs-Beleg schlägt Bildüberschneidung; geteilte Projektbilder belegen nichts und blockieren nicht", async () => {
  const snap = await snapshotOf({ offers: realInventory() });
  const by = Object.fromEntries(snap.listings.map((L) => [L.immowelt_online_id, L]));
  const pics = (id) => by[id].media.map((m) => m.url);
  // Zwei Einheiten desselben Projekts: beide Alt-Datensätze tragen die Bilder BEIDER Einheiten (gemeinsame Visualisierungen)
  const shared = [...pics("2geq25e"), ...pics("2ggn25e")];
  const legacy = [
    { id: "bb241b38-d292-4047-98fd-4352b841bc5a", slug: "alt-a3", title: "Wohnung A3", active: true, images: shared },
    { id: "ff414db8-7e3d-4a01-99f8-029fe15a4d55", slug: "alt-a2", title: "Wohnung A2", active: true, images: shared },
  ];
  const open = planLegacyMigration(legacy, snap.listings, []);
  for (const d of open.legacy) {
    assert.deepEqual([d.decision, d.evidence[0].type, d.target], ["retire", "media_asset_overlap_ambiguous", null]);
    assert.deepEqual([...d.evidence[0].candidates].sort(), ["2geq25e", "2ggn25e"]);
  }
  assert.deepEqual([open.ambiguous, open.unresolved_overlaps, open.created.length], [0, 2, 10], "nicht blockierend: beide Angebote erscheinen als neu");

  // Ein dokumentierter Eintrag löst es auf – und der zweite Datensatz ist danach über die Bilder eindeutig
  const one = planLegacyMigration(legacy, snap.listings, [{ legacy_id: "bb241b38-d292-4047-98fd-4352b841bc5a", online_id: "2geq25e" }]);
  const d1 = Object.fromEntries(one.legacy.map((x) => [x.slug, x]));
  assert.deepEqual([d1["alt-a3"].decision, d1["alt-a3"].target.online_id, d1["alt-a3"].evidence.map((e) => e.type)], ["match", "2geq25e", ["online_id_manual", "media_asset_overlap"]]);
  assert.deepEqual([d1["alt-a2"].decision, d1["alt-a2"].target.online_id, d1["alt-a2"].evidence[0].type], ["match", "2ggn25e", "media_asset_overlap"]);
  assert.deepEqual([one.ambiguous, one.unresolved_overlaps, one.created.length], [0, 0, 8]);

  // Widerspruch in den Belegen (zwei Alt-Datensätze für dasselbe Angebot dokumentiert) blockiert – ausdrücklich
  const clash = planLegacyMigration(legacy, snap.listings, [
    { legacy_id: "bb241b38-d292-4047-98fd-4352b841bc5a", online_id: "2geq25e" },
    { legacy_id: "ff414db8-7e3d-4a01-99f8-029fe15a4d55", online_id: "2geq25e" },
  ]);
  assert.equal(clash.ambiguous, 2);
  assert.ok(clash.legacy.every((d) => d.decision === "ambiguous" && d.target === null && d.evidence[0].also_claimed_by.length === 1));

  // GUID-Gleichheit gewinnt gegen eine (falsche) Bildüberschneidung mit einem anderen Angebot
  const guidRow = [{ id: "7bff84e7-8370-471d-b359-5319c8df10ef", slug: "alt-b9", active: true, images: pics("2k57b5v") }];
  const g = planLegacyMigration(guidRow, snap.listings, []);
  assert.deepEqual([g.legacy[0].decision, g.legacy[0].target.online_id, g.legacy[0].evidence.map((e) => e.type)], ["match", "2zbf747", ["guid_equal"]]);
});

test("Hilfsfunktionen: deutsche Zahlen und Preisformat", () => {
  assert.equal(parseGermanNumber("1.200,00 € (inkl. Nebenkosten)"), 1200);
  assert.equal(parseGermanNumber("46,54 m²"), 46.54);
  assert.equal(parseGermanNumber("auf Anfrage"), null);
  assert.equal(formatEuro(826925), "826.925 €");
  assert.equal(formatEuro(1200.5), "1.200,50 €");
  assert.equal(typeof coreHash, "function");
  assert.ok(new ImmoweltError("x", "y") instanceof Error);
});

test("Zeitstempel der API werden als Datum gezeigt, alles andere bleibt wörtlich", async () => {
  const { displayValue } = await import("../scripts/lib/immowelt/normalize.mjs");
  assert.equal(displayValue("2026-05-22T22:00:00.000Z"), "23.05.2026", "deutsche Zeit, nicht UTC");
  assert.equal(displayValue("2023-07-01T00:00:00Z"), "01.07.2023");
  for (const v of ["Erstbezug", "ab sofort", "2024", "", "2026-13-45T00:00:00Z"]) assert.equal(displayValue(v), v);
});

test("Bezug: vergangenes Datum = „ab sofort“ (wie Immowelt und wie vor dem API-Umbau), künftiges bleibt Datum", async () => {
  const { availabilityValue } = await import("../scripts/lib/immowelt/normalize.mjs");
  const now = new Date("2026-11-11T21:00:00Z");
  assert.equal(availabilityValue("2026-09-17T00:00:00Z", now), "ab sofort");
  assert.equal(availabilityValue("2023-07-01T00:00:00Z", now), "ab sofort");
  assert.equal(availabilityValue("2027-03-01T00:00:00Z", now), "01.03.2027");
  assert.equal(availabilityValue("Erstbezug", now), "Erstbezug");
});

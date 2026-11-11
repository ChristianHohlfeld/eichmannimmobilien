/**
 * End-to-end: fixture Immowelt → pipeline → SQLite → release build → atomic switch.
 * Runs against a throw-away copy of the server layout; needs better-sqlite3 (npm ci).
 * Pictures are processed with sharp when it is installed, otherwise copied.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const hasSqlite = await import("better-sqlite3").then(() => true, () => false);
const skip = hasSqlite ? false : "better-sqlite3 nicht installiert (npm ci)";
const H = hasSqlite ? await import("../test-support/immowelt/env.mjs") : null;
const B = await import("../test-support/immowelt/builder.mjs");
const Store = hasSqlite ? await import("../scripts/lib/immowelt/store.mjs") : null;
const Status = await import("../scripts/lib/immowelt/status.mjs");
const Release = hasSqlite ? await import("../scripts/lib/release.mjs") : null;
const Pipeline = hasSqlite ? await import("../scripts/lib/immowelt/pipeline.mjs") : null;
const Lock = await import("../scripts/lib/immowelt/lock.mjs");
const { inspectExposeHtml } = await import("../scripts/lib/release-verify.mjs");

const slugOf = (e, onlineId) => {
  const db = e.db();
  try {
    return db.prepare("SELECT slug FROM listings WHERE immowelt_online_id = ?").get(onlineId)?.slug || null;
  } finally {
    db.close();
  }
};
const page = (e, onlineId) => e.read(`objekt/${slugOf(e, onlineId)}.html`);
const objektPages = (e) => fs.readdirSync(e.site("objekt")).filter((f) => f.endsWith(".html")).sort();
const eigenRow = (e) => {
  const db = e.db();
  try {
    return db.prepare("SELECT slug, title, active, site_hidden, payload, updated_at FROM listings WHERE origin = 'eigen'").all();
  } finally {
    db.close();
  }
};

test("Immowelt → Website: Cutover, harte Übernahme, Fehlerfälle, Rollback", { skip }, async (t) => {
  const e = await H.makeEnv();
  t.after(() => e.cleanup());
  e.seedLegacy();
  const eigenBefore = JSON.stringify(eigenRow(e));
  const boot = await e.bootstrapLayout();
  let lastRelease = boot.id;

  await t.test("Ausgangslage: Release aus dem alten Stand, Webroot ist ein Symlink", () => {
    assert.ok(fs.lstatSync(e.config.webroot).isSymbolicLink());
    assert.ok(Release.isLayoutActive(e.config));
    assert.equal(e.current(), boot.id);
    assert.equal(objektPages(e).length, 12, "11 Alt-Angebote + 1 eigenes");
    assert.ok(e.exists("objekt/mehrfamilienhaus-wollmatingen-32a8908e.html"));
    assert.ok(!e.exists("scripts") && !e.exists("package.json") && !e.exists("node_modules"), "keine Build-Dateien im Webroot");
    assert.ok(fs.lstatSync(e.site("media")).isSymbolicLink() && fs.lstatSync(e.site("data/immowelt-sync-status.json")).isSymbolicLink());
  });

  e.state.offers = B.realInventory();
  let plan;
  await t.test("Vor der Identitätsmigration wird nichts veröffentlicht (Exit 3, Status rot)", async () => {
    const r = await e.run();
    assert.deepEqual([r.outcome, r.exitCode], ["migration_required", 3]);
    assert.equal(e.current(), boot.id, "Website unverändert");
    assert.equal(e.status().state, "migration_required");
    assert.equal(e.status().ok, false);
    plan = r.plan;
    const by = Object.fromEntries(plan.legacy.map((d) => [d.slug, d]));
    assert.equal(plan.legacy.length, 13);
    assert.deepEqual([by["wohnung-wollmatingen-7bff84e7"].decision, by["wohnung-wollmatingen-7bff84e7"].evidence[0].type], ["match", "guid_equal"]);
    assert.equal(plan.legacy.filter((d) => d.decision === "retire").length, 12, "ohne Kennungs-Beleg keine Zuordnung");
    assert.equal(plan.created.length, 9);
    assert.ok(fs.existsSync(e.config.identityPlanFile));
    const db = e.db();
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM listings WHERE immowelt_guid IS NOT NULL").get().n, 0, "Datenbank unverändert");
    db.close();
  });

  await t.test("Ein Plan, der nicht zum Bestand passt, wird abgelehnt", async () => {
    const stale = { ...plan, plan_hash: "0000000000000000" };
    const r = await e.run({ identityPlan: stale });
    assert.deepEqual([r.outcome, r.error.code], ["failed", "identity_plan_stale"]);
    assert.equal(e.current(), boot.id);
  });

  await t.test("Cutover: freigegebener Plan → alle zehn API-Angebote live, Alt-Angebote ohne Beleg offline", async () => {
    const r = await e.run({ identityPlan: plan });
    assert.deepEqual([r.outcome, r.exitCode], ["published", 0], JSON.stringify(r.error));
    assert.notEqual(e.current(), boot.id);
    lastRelease = e.current();
    const pages = objektPages(e);
    assert.equal(pages.length, 11, "10 Immowelt + 1 eigenes");
    assert.ok(pages.includes("wohnung-wollmatingen-7bff84e7.html"), "B9 behält seine URL (gleiche GUID)");
    for (const gone of ["mehrfamilienhaus-wollmatingen-32a8908e", "penthouse-furstenberg-6fd6062e", "penthouse-konigsbau-c6b1d820"]) {
      assert.ok(!e.exists(`objekt/${gone}.html`) && !e.exists(`en/property/${gone}.html`), `${gone} ist offline`);
      assert.ok(!e.read("index.html").includes(gone) && !e.read("sitemap.xml").includes(gone));
    }
    assert.equal(JSON.parse(e.read("ai/listings.json")).listing_count, 11);
    assert.equal(JSON.parse(e.read("ai/build.json")).release_id, e.current());
    assert.match(e.read("index.html"), /11 Angebote \(10 Kauf, 1 Miete\) in und um Konstanz/);
    assert.match(e.read("index.html"), /Stand der Angebote: 11\.11\.2026 \(automatisch mit Immowelt abgeglichen\)/);
    const st = e.status();
    assert.deepEqual([st.state, st.ok, st.published.count, st.published.release_id], ["current", true, 10, e.current()]);
    assert.equal(st.last_change.identity.retired, 12);
  });

  await t.test("Inhalte 1:1: Miete, Preis auf Anfrage, Grundrisse, Reihenfolge, keine lokalen Overrides", () => {
    const rent = inspectExposeHtml(page(e, "2ql2c52"));
    assert.deepEqual([rent.marketing, rent.gallery_images.length, rent.h1], ["miete", 16, "Möblierte sonnige 1 Zimmerwohnung"]);
    assert.match(page(e, "2ql2c52"), /1\.200&nbsp;€ Warmmiete/);
    assert.ok(!/Käuferprovision/.test(page(e, "2ql2c52")), "Mietangebot ohne Käuferprovision");
    assert.match(page(e, "2ql2c52"), /"businessFunction": "http:\/\/purl\.org\/goodrelations\/v1#LeaseOut"/);
    const b9 = page(e, "2zbf747");
    assert.match(b9, /Preis auf Anfrage/);
    assert.ok(!/695\.000|695000/.test(b9), "alter Kaufpreis ist verschwunden");
    assert.match(b9, /93,22 m²/);
    const dg = inspectExposeHtml(page(e, "2gwzk5x"));
    assert.deepEqual([dg.gallery_images.length, dg.floorplan_images.length], [4, 2]);
    assert.match(page(e, "2gwzk5x"), /826\.925&nbsp;€/);
    // API-Reihenfolge in der Angebotsliste (eigenes Inserat zuerst, wie bisher)
    const order = [...e.read("index.html").matchAll(/href="objekt\/([a-z0-9-]+)\.html"/g)].map((m) => m[1]).filter((s, i, a) => a.indexOf(s) === i);
    assert.deepEqual(order.slice(0, 4), ["eigen-testobjekt-konstanz", slugOf(e, "2ql2c52"), slugOf(e, "2k57b5v"), slugOf(e, "2gwzk5x")]);
    // die frühere lokale Titel-Schicht ("… Neubau Sunside Living") ist für API-Inserate wirkungslos
    assert.ok(!/Neubau Sunside Living<\/span><\/h1>/.test(page(e, "2fsjg56")));
    assert.equal(inspectExposeHtml(page(e, "2fsjg56")).h1.replace(/^A5\s*·?\s*/, ""), "Fixture Wohnung A5");
    // Projektseite: Zuordnung über Online-IDs, Preise aus der API
    const sunside = e.read("sunside-living-wollmatingen.html");
    assert.match(sunside, /5 verfügbare Wohnungen ab 361\.500 €/);
    assert.ok(!/InStock/.test(sunside));
    // englische Seite: Miete als Miete
    assert.match(e.read(`en/property/${slugOf(e, "2ql2c52")}.html`), /Rent per month incl\. service charges \(Warmmiete\)/);
    assert.match(e.read(`en/property/${slugOf(e, "2zbf747")}.html`), /Price on request/);
  });

  await t.test("Eigene Inserate bleiben unberührt und sichtbar", () => {
    assert.equal(JSON.stringify(eigenRow(e)), eigenBefore);
    assert.ok(e.exists("objekt/eigen-testobjekt-konstanz.html"));
  });

  await t.test("Wiederholung ohne Änderung: kein neues Release, Status wird trotzdem fortgeschrieben", async () => {
    e.advance(30);
    const before = { ...e.state.calls };
    const r = await e.run();
    assert.equal(r.outcome, "unchanged");
    assert.equal(e.current(), lastRelease);
    assert.equal(e.state.calls.image, before.image, "keine Bilder erneut geladen");
    assert.equal(e.state.calls.expose, before.expose + 10, "Bestand wurde vollständig gelesen");
    assert.equal(e.status().last_success_at, e.now.toISOString());
    assert.equal(e.status().last_change_at, "2026-11-11T10:00:00.000Z");
  });

  await t.test("Tageswechsel: Datenstand rückt vor, auch wenn sich nichts geändert hat", async () => {
    e.advance(24 * 60);
    const r = await e.run();
    assert.equal(r.outcome, "date_roll");
    assert.notEqual(e.current(), lastRelease);
    lastRelease = e.current();
    assert.match(e.read("index.html"), /Stand der Angebote: 12\.11\.2026/);
    assert.equal(JSON.parse(e.read("ai/listings.json")).data_as_of.slice(0, 10), "2026-11-12");
  });

  await t.test("Änderungen auf Immowelt: gekürzt, geleert, Kauf→Miete, Bild getauscht/entfernt/umsortiert, Angebote umsortiert", async () => {
    e.advance(30);
    const o = Object.fromEntries(e.state.offers.map((x) => [x.onlineId, x]));
    o["2k57b5v"].info1 = "Nur noch ein kurzer Satz.";
    o["2k57b5v"].info3 = ""; // bewusst geleert
    Object.assign(o["2ewd75c"], { salesType: 2, price: 1890, priceItem: { id: "PriceKaltmiete", title: "Kaltmiete" } });
    const firstBefore = inspectExposeHtml(page(e, "2geq25e")).gallery_images;
    o["2geq25e"].images.reverse();
    o["2ggn25e"].images.pop();
    e.state.imageRevisions.set(o["2f42h56"].images[0].asset, 1); // gleiche Adresse, neues Bild
    e.advance(25 * 60); // Wiedervorlage der Bildprüfung
    e.state.offers = [...e.state.offers].reverse();
    const r = await e.run();
    assert.equal(r.outcome, "published", JSON.stringify(r.error));
    lastRelease = e.current();
    const changed = new Set(r.change.changed);
    for (const id of ["2k57b5v", "2ewd75c", "2geq25e", "2ggn25e", "2f42h56"]) assert.ok(changed.has(id), `${id} als geändert erkannt`);
    assert.equal(r.change.reordered || changed.size >= 5, true);
    const k = page(e, "2k57b5v");
    assert.match(k, /Nur noch ein kurzer Satz\./);
    assert.ok(!/Fixture-Objektbeschreibung 2k57b5v/.test(k), "alter Langtext ist weg");
    assert.ok(!/Lagebeschreibung/.test(k), "geleerter Abschnitt wird nicht aus dem alten Stand gerettet");
    assert.deepEqual(inspectExposeHtml(k).sections.map((s) => s.title), ["Objektbeschreibung", "Sonstiges"]);
    assert.deepEqual([inspectExposeHtml(page(e, "2ewd75c")).marketing], ["miete"]);
    assert.match(page(e, "2ewd75c"), /1\.890&nbsp;€ Kaltmiete/);
    assert.ok(!/735\.000/.test(page(e, "2ewd75c")));
    assert.deepEqual(inspectExposeHtml(page(e, "2geq25e")).gallery_images, [...firstBefore].reverse());
    assert.equal(inspectExposeHtml(page(e, "2ggn25e")).gallery_images.length, 3);
    const order = [...e.read("index.html").matchAll(/href="objekt\/([a-z0-9-]+)\.html"/g)].map((m) => m[1]).filter((s, i, a) => a.indexOf(s) === i);
    assert.equal(order[1], slugOf(e, "2zbf747"), "neue Reihenfolge der API ist sichtbar");
    assert.match(e.read("index.html"), /11 Angebote \(9 Kauf, 2 Miete\)/);
  });

  await t.test("Angebot aus → Seite weg; Angebot wieder an → gleiche URL", async () => {
    e.advance(30);
    const slug = slugOf(e, "2gwzk5x");
    const removed = e.state.offers.find((x) => x.onlineId === "2gwzk5x");
    e.state.offers = e.state.offers.filter((x) => x !== removed);
    let r = await e.run();
    assert.deepEqual([r.outcome, r.change.removed], ["published", ["2gwzk5x"]]);
    assert.ok(!e.exists(`objekt/${slug}.html`) && !e.read("sitemap.xml").includes(slug));
    const db = e.db();
    const row = db.prepare("SELECT active, retired_at FROM listings WHERE immowelt_online_id = '2gwzk5x'").get();
    const hist = db.prepare("SELECT change FROM listing_history WHERE listing_id = (SELECT id FROM listings WHERE immowelt_online_id = '2gwzk5x') ORDER BY seq").all().map((h) => h.change);
    db.close();
    assert.deepEqual([row.active, Boolean(row.retired_at), hist], [0, true, ["insert", "retire"]]);
    e.advance(30);
    e.state.offers = [removed, ...e.state.offers];
    r = await e.run();
    assert.deepEqual([r.outcome, r.change.reactivated], ["published", ["2gwzk5x"]]);
    assert.ok(e.exists(`objekt/${slug}.html`), "Slug bleibt eingefroren");
    lastRelease = e.current();
  });

  const expectFailed = async (label, code, mutate, restore) => {
    await t.test(label, async () => {
      e.advance(30);
      const release = e.current();
      const db0 = e.db();
      const dbBefore = JSON.stringify(db0.prepare("SELECT id, active, content_hash, position FROM listings ORDER BY id").all());
      db0.close();
      mutate();
      const r = await e.run();
      restore();
      assert.deepEqual([r.outcome, r.exitCode], ["failed", 1]);
      assert.ok([].concat(code).includes(r.error.code), `Fehlercode ${r.error.code}`);
      assert.equal(e.current(), release, "Website bleibt auf dem letzten vollständigen Stand");
      const db1 = e.db();
      assert.equal(JSON.stringify(db1.prepare("SELECT id, active, content_hash, position FROM listings ORDER BY id").all()), dbBefore, "Datenbank unverändert");
      db1.close();
      const st = e.status();
      assert.deepEqual([st.state, st.ok, st.error.code, st.published.release_id], ["failed", false, r.error.code, release]);
      assert.ok(st.consecutive_failures >= 1);
      assert.ok(Date.parse(st.last_success_at) < Date.parse(st.last_attempt_at), "last_success_at bleibt stehen");
    });
  };

  await expectFailed("Exposé eines Angebots nicht lieferbar → nichts wird veröffentlicht", "immowelt_expose_status",
    () => (e.state.hooks = { expose: (guid) => (guid === e.state.offers[3].guid ? B.exposeEnvelope(null, { status: "Invalid" }) : null) }),
    () => (e.state.hooks = null));
  await expectFailed("Liste unvollständig (Seite fehlt) → nichts wird veröffentlicht", ["immowelt_list_missing_page", "immowelt_list_unstable"],
    () => (e.state.hooks = { list: () => B.listEnvelope({ offers: e.state.offers.slice(0, 4), totalCount: e.state.offers.length }) }),
    () => (e.state.hooks = null));
  await expectFailed("Neues Bild nicht abrufbar → keine Teilpublikation", "media_download",
    () => {
      e.state.offers[2].images.push({ asset: "deadbeef-0000-4000-8000-00000000dead", variant: "deadbeef-0000-4000-8000-00000000beef", floorplan: false });
      e.state.hooks = { image: (url) => (url.includes("00000000dead") ? new Response("nope", { status: 404 }) : null) };
    },
    () => {
      e.state.offers[2].images.pop();
      e.state.hooks = null;
    });
  await expectFailed("API lehnt den Schlüssel ab → Fehlerstatus, Schlüssel taucht nirgends auf", "immowelt_access_denied",
    () => (e.state.apiKey = "anderer-schluessel"),
    () => (e.state.apiKey = H.TEST_KEY));
  await expectFailed("Kaputtes XML (abgeschnittene Antwort) → Fehler statt weniger Angebote", ["immowelt_truncated", "immowelt_invalid_xml"],
    () => (e.state.hooks = { list: () => B.listEnvelope({ offers: e.state.offers }).slice(0, 1500) }),
    () => (e.state.hooks = null));

  await t.test("Nach den Fehlläufen: nächster guter Lauf ist wieder 'current'", async () => {
    e.advance(30);
    const r = await e.run();
    assert.ok(["unchanged", "date_roll"].includes(r.outcome), r.outcome);
    assert.deepEqual([e.status().state, e.status().consecutive_failures], ["current", 0]);
    lastRelease = e.current();
  });

  await t.test("Großer Wegfall wird erst nach identischer zweiter Antwort mit Abstand veröffentlicht", async () => {
    e.advance(30);
    const full = e.state.offers;
    e.state.offers = full.slice(0, 4);
    let r = await e.run();
    assert.equal(r.outcome, "pending_confirmation");
    assert.equal(e.current(), lastRelease, "noch nichts geändert");
    assert.deepEqual([e.status().state, e.status().ok, e.status().pending.reason], ["pending_confirmation", true, "mass_removal"]);
    e.advance(5);
    r = await e.run();
    assert.equal(r.outcome, "pending_confirmation", "5 Minuten reichen nicht");
    // Ausreißer: beim nächsten Lauf ist alles wieder da → Bestätigung verfällt, nichts passiert
    e.advance(30);
    e.state.offers = full;
    r = await e.run();
    assert.ok(["unchanged", "date_roll"].includes(r.outcome));
    assert.equal(objektPages(e).length, 11);
    lastRelease = e.current();
  });

  await t.test("Leerer Bestand ist gültig – nach Bestätigung zeigt die Seite nur noch eigene Inserate", async () => {
    e.advance(30);
    const full = e.state.offers;
    e.state.offers = [];
    let r = await e.run();
    assert.deepEqual([r.outcome, e.status().pending.reason], ["pending_confirmation", "empty_inventory"]);
    e.advance(25);
    r = await e.run();
    assert.equal(r.outcome, "published", JSON.stringify(r.error));
    assert.deepEqual(objektPages(e), ["eigen-testobjekt-konstanz.html"]);
    assert.match(e.read("index.html"), /1 Kaufobjekt in und um Konstanz/);
    assert.equal(e.status().published.count, 0);
    assert.match(e.read("sunside-living-wollmatingen.html"), /Aktuell ist keine Wohnung aus diesem Projekt/);
    // und zurück: Bestand wieder da → alle Angebote mit ihren alten URLs
    e.advance(30);
    e.state.offers = full;
    r = await e.run();
    assert.equal(r.outcome, "published");
    assert.equal(objektPages(e).length, 11);
    assert.ok(e.exists("objekt/wohnung-wollmatingen-7bff84e7.html"));
    lastRelease = e.current();
  });

  await t.test("Parallelität: zweiter Lauf während einer Veröffentlichung endet als 'busy' ohne Wirkung", async () => {
    const lock = await Lock.acquireLock(e.config.lockDir, { purpose: "test" });
    const r = await e.run();
    lock.release();
    assert.deepEqual([r.outcome, r.exitCode], ["busy", 0]);
    assert.equal(e.current(), lastRelease);
    // verwaiste Sperre (Prozess existiert nicht mehr) wird übernommen
    fs.writeFileSync(path.join(e.config.lockDir, "pipeline.lock"), JSON.stringify({ token: "x", pid: 2 ** 22 + 12345, purpose: "tot", started_at: new Date().toISOString() }));
    e.advance(30);
    const again = await e.run();
    assert.ok(["unchanged", "date_roll"].includes(again.outcome), again.outcome);
    assert.ok(e.logs.some((l) => /Verwaiste Sperre übernommen/.test(l)));
    lastRelease = e.current();
  });

  await t.test("Abbruch zwischen Datenbank und Umschalten: nächster Lauf holt das Umschalten nach", async () => {
    e.advance(30);
    e.state.offers.find((x) => x.onlineId === "2fayg56").info2 = "Neuer Hinweis nach dem Absturz-Test.";
    const r = await e.run();
    assert.equal(r.outcome, "published");
    const fresh = e.current();
    // Simuliere: Prozess starb nach der Datenbank-Transaktion, bevor der Symlink gewechselt wurde →
    // die Datenbank erwartet das neue Release (release_pending), live ist noch das alte (release_live).
    const p = Release.releasePaths(e.config);
    const setLive = (id) => {
      const db = e.db();
      db.prepare("UPDATE meta SET value = ? WHERE key = 'release_live'").run(id);
      db.close();
    };
    fs.rmSync(p.current);
    fs.symlinkSync(lastRelease, p.current);
    setLive(lastRelease);
    assert.ok(!/Neuer Hinweis nach dem Absturz-Test/.test(page(e, "2fayg56")));
    e.advance(30);
    const heal = await e.run();
    assert.equal(heal.outcome, "unchanged");
    assert.equal(e.current(), fresh);
    assert.match(page(e, "2fayg56"), /Neuer Hinweis nach dem Absturz-Test/);
    assert.ok(e.logs.some((l) => /Unterbrochener Lauf erkannt/.test(l)));
    // Zweites Fenster: Symlink gewechselt, Prozess starb vor dem Vermerk → nur der Vermerk wird nachgezogen, kein neues Release
    setLive(lastRelease);
    const releasesBefore = Release.listReleases(e.config).length;
    e.advance(30);
    const heal2 = await e.run();
    assert.ok(["unchanged", "date_roll"].includes(heal2.outcome), heal2.outcome);
    if (heal2.outcome === "unchanged") assert.equal(Release.listReleases(e.config).length, releasesBefore);
    const dbm = e.db();
    assert.equal(dbm.prepare("SELECT value FROM meta WHERE key = 'release_live'").get().value, e.current());
    dbm.close();
    lastRelease = e.current();
  });

  await t.test("Build-Fehler im Release: Datenbank und Website bleiben unverändert", async () => {
    const brokenApp = path.join(e.base, "broken-app");
    fs.mkdirSync(path.join(brokenApp, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(brokenApp, "scripts", "build.mjs"), 'console.error("Build absichtlich kaputt"); process.exit(1);\n');
    e.advance(30);
    e.state.offers.find((x) => x.onlineId === "2fayg56").info2 = "Dieser Text darf nie erscheinen.";
    const r = await e.run({ deps: { config: { ...e.config, appDir: brokenApp } } });
    assert.deepEqual([r.outcome, r.error.code], ["failed", "release_build_failed"]);
    assert.equal(e.current(), lastRelease);
    const db = e.db();
    assert.ok(!db.prepare("SELECT payload FROM listings WHERE immowelt_online_id = '2fayg56'").get().payload.includes("darf nie erscheinen"));
    db.close();
    e.advance(30);
    const ok = await e.run();
    assert.equal(ok.outcome, "published");
    assert.match(page(e, "2fayg56"), /Dieser Text darf nie erscheinen\./); // jetzt, mit funktionierendem Build, ist es der gültige Stand
    lastRelease = e.current();
  });

  await t.test("Deploy/Admin: Release aus der Datenbank neu bauen ändert keine Immowelt-Daten", async () => {
    const db = e.db();
    const before = db.prepare("SELECT value FROM meta WHERE key = 'immowelt_fingerprint'").get().value;
    const lock = await Lock.acquireLock(e.config.lockDir, { purpose: "deploy" });
    const rel = await Pipeline.publishFromDatabase(e.config, { db, reason: "deploy", lockToken: lock.token });
    lock.release();
    assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'immowelt_fingerprint'").get().value, before);
    db.close();
    assert.equal(e.current(), rel.id);
    assert.equal(objektPages(e).length, 11);
    e.advance(30);
    assert.ok(["unchanged", "date_roll"].includes((await e.run()).outcome));
    lastRelease = e.current();
  });

  await t.test("Rollback: Immowelt-Zeilen aus der Sicherung, neues Release, Abgleich angehalten bis 'resume'", async () => {
    e.advance(30);
    e.state.offers.find((x) => x.onlineId === "2fsjg56").info1 = "Fehlerhafter Stand, der zurückgenommen wird.";
    assert.equal((await e.run()).outcome, "published");
    assert.match(page(e, "2fsjg56"), /Fehlerhafter Stand/);
    const backups = fs.readdirSync(e.config.backupsDir).filter((n) => n.endsWith(".db")).sort();
    const db = e.db();
    const res = Store.restoreImmoweltRows(db, path.join(e.config.backupsDir, backups[backups.length - 1]));
    Store.setJsonMeta(db, "immowelt_hold", { at: e.now.toISOString(), reason: "Test-Rollback" });
    const lock = await Lock.acquireLock(e.config.lockDir, { purpose: "rollback" });
    await Pipeline.publishFromDatabase(e.config, { db, reason: "rollback", lockToken: lock.token });
    lock.release();
    db.close();
    assert.equal(res.active_after, 10);
    assert.ok(!/Fehlerhafter Stand/.test(page(e, "2fsjg56")), "vorheriger Stand ist wieder online");
    assert.equal(JSON.stringify(eigenRow(e)), eigenBefore, "eigene Inserate vom Rollback unberührt");
    e.advance(30);
    const held = await e.run();
    assert.deepEqual([held.outcome, e.status().state, e.status().ok], ["held", "held", false]);
    assert.ok(!/Fehlerhafter Stand/.test(page(e, "2fsjg56")), "angehalten: nichts wird erneut veröffentlicht");
    const db2 = e.db();
    Store.setJsonMeta(db2, "immowelt_hold", null);
    db2.close();
    e.advance(30);
    assert.equal((await e.run()).outcome, "published");
    assert.match(page(e, "2fsjg56"), /Fehlerhafter Stand/);
  });

  await t.test("Release-Rollback: Seite zurück und angehalten; Admin-Speichern wartet, Deploy veröffentlicht, 'resume' holt den aktuellen Stand", async () => {
    const { publishViaRelease } = await import("../scripts/lib/publish.mjs");
    const good = e.current();
    e.advance(30);
    e.state.offers.find((x) => x.onlineId === "2k57b5v").info1 = "Stand nach dem Release, das zurückgenommen wird.";
    assert.equal((await e.run()).outcome, "published");
    const bad = e.current();
    assert.notEqual(bad, good);

    // Betreiber nimmt das Release zurück → Seite steht auf dem vorherigen, Veröffentlichung ist angehalten
    const rollback = async (targetId = null) => {
      const lock = await Lock.acquireLock(e.config.lockDir, { purpose: "release rollback" });
      const db = e.db();
      try {
        return await Pipeline.rollbackSite(e.config, { db, targetId, now: e.now });
      } finally {
        db.close();
        lock.release();
      }
    };
    const rb = await rollback();
    assert.deepEqual([rb.id, Boolean(rb.hold.at), e.current()], [good, true, good]);
    assert.ok(!/Stand nach dem Release/.test(page(e, "2k57b5v")));
    assert.deepEqual([e.status().state, e.status().ok, e.status().published.release_id], ["held", false, good]);

    // Timer-Läufe bleiben angehalten; die Wiederherstellung nach Abbruch macht den Rollback NICHT rückgängig
    const logMark = e.logs.length;
    e.advance(30);
    const held = await e.run();
    assert.deepEqual([held.outcome, held.exitCode, e.current()], ["held", 0, good]);
    assert.ok(!e.logs.slice(logMark).some((l) => /Unterbrochener Lauf/.test(l)));

    // Speichern im Admin-Bereich: gespeichert, aber nicht veröffentlicht
    await assert.rejects(publishViaRelease(e.config, { reason: "admin", log: () => {} }), (err) => err.status === 423 && err.code === "held" && /angehalten/.test(err.message));
    assert.equal(e.current(), good);

    // bewusster Build (Deploy mit der Korrektur) veröffentlicht den Datenbankstand; der Halt bleibt bestehen
    const dep = await publishViaRelease(e.config, { reason: "deploy", log: () => {} });
    assert.equal(e.current(), dep.release_id);
    assert.match(page(e, "2k57b5v"), /Stand nach dem Release/);
    e.advance(30);
    assert.equal((await e.run()).outcome, "held");

    // noch einmal zurück, diesmal Freigabe ohne Deploy: der nächste Lauf baut aus der Datenbank neu
    await rollback(good);
    assert.equal(e.current(), good);
    const db = e.db();
    Pipeline.clearHold(db);
    db.close();
    e.advance(30);
    const back = await e.run();
    assert.ok(["republished", "date_roll"].includes(back.outcome), back.outcome);
    assert.notEqual(e.current(), good);
    assert.match(page(e, "2k57b5v"), /Stand nach dem Release/);
    assert.deepEqual([e.status().state, e.status().ok], ["current", true]);
    assert.equal(JSON.stringify(eigenRow(e)), eigenBefore, "eigene Inserate unberührt");
    lastRelease = e.current();
  });

  await t.test("Schlüssel steht in keinem Log, Status, Archiv oder Release", () => {
    const hay = [e.logs.join("\n"), fs.readFileSync(e.config.statusFile, "utf8"), JSON.stringify(Release.listReleases(e.config))].join("\n");
    assert.ok(!hay.includes(H.TEST_KEY));
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : d.isFile() && d.name.endsWith(".json") ? [path.join(dir, d.name)] : []));
    for (const f of [...walk(path.join(e.config.stateDir, "releases", e.current(), "ai")), ...walk(path.join(e.config.stateDir, "status"))]) assert.ok(!fs.readFileSync(f, "utf8").includes(H.TEST_KEY), f);
    assert.ok(e.state.calls.auth.every((k) => k === H.TEST_KEY || k === "anderer-schluessel" || k === ""), "Schlüssel ging nur im SOAP-Header an die API");
  });

  await t.test("Aufbewahrung: alte Releases werden begrenzt, Historie und Rohdaten bleiben", () => {
    const releases = Release.listReleases(e.config);
    assert.ok(releases.length <= e.config.keepReleases + 2, `${releases.length} Releases`);
    assert.ok(releases.some((r) => r.current) && releases.some((r) => r.previous));
    const db = e.db();
    assert.ok(db.prepare("SELECT COUNT(*) AS n FROM immowelt_snapshots").get().n >= 5, "jeder gesehene Stand ist archiviert");
    assert.ok(db.prepare("SELECT COUNT(*) AS n FROM listing_history").get().n >= 25);
    assert.ok(db.prepare("SELECT COUNT(*) AS n FROM immowelt_runs WHERE outcome = 'failed'").get().n >= 5);
    db.close();
    assert.ok(fs.readdirSync(e.config.snapshotsDir).length >= 5, "Rohantworten der API je Stand (gzip)");
    assert.ok(fs.readdirSync(e.config.originalsDir).length >= 54, "Originalbilder bleiben archiviert");
  });
});

test("Status-Bewertung: veraltet, fehlgeschlagen, altes Format", () => {
  const now = new Date("2026-11-11T12:00:00Z");
  const base = { schema: Status.STATUS_SCHEMA, state: "current", stale_after_minutes: 120, last_success_at: "2026-11-11T11:30:00Z", warnings: [] };
  assert.deepEqual([Status.evaluateStatus(base, { now }).ok, Status.evaluateStatus(base, { now }).level], [true, "ok"]);
  const stale = Status.evaluateStatus({ ...base, last_success_at: "2026-11-11T08:00:00Z" }, { now });
  assert.deepEqual([stale.ok, stale.level, stale.age_minutes], [false, "alarm", 240]);
  assert.equal(Status.evaluateStatus({ ...base, state: "failed", error: { message: "x" } }, { now }).ok, false);
  assert.equal(Status.evaluateStatus({ ...base, state: "held" }, { now }).ok, false);
  assert.equal(Status.evaluateStatus({ ...base, state: "pending_confirmation" }, { now }).ok, true);
  // die heutige Statusdatei (awaiting_api_key, last_valid_at 20.09.) ist rot
  const old = JSON.parse(fs.readFileSync(new URL("../data/immowelt-sync-status.json", import.meta.url), "utf8"));
  const verdict = Status.evaluateStatus(old, { now });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.length >= 2);
  assert.equal(Status.evaluateStatus(null, { now }).ok, false);
});

test("Einstellungen: sync.env gilt für jeden Einstiegspunkt, Umgebung hat Vorrang, kein Schlüssel aus der Datei", { skip }, async () => {
  const { loadConfig, readSettingsFile } = await import("../scripts/lib/immowelt/config.mjs");
  const tmpRoot = process.env.EICHMANN_TEST_TMP || os.tmpdir();
  fs.mkdirSync(tmpRoot, { recursive: true });
  const state = fs.mkdtempSync(path.join(tmpRoot, "eichmann-settings-"));
  fs.writeFileSync(path.join(state, "sync.env"), [
    "# Kommentar",
    "IMMOWELT_ADDRESS_MODE=street",
    'IMMOWELT_IMAGE_SIZE="1920x0"',
    "EICHMANN_SMOKE_URL=",
    "IMMOWELT_STALE_AFTER_MINUTES = 90",
    "IMMOWELT_API_KEY=darf-nie-aus-dieser-datei-gelesen-werden",
    "PATH=/tmp/boese",
    "",
  ].join("\n"));
  const fromFile = loadConfig({ EICHMANN_STATE_DIR: state, EICHMANN_DB_PATH: path.join(state, "x.db") });
  assert.deepEqual([fromFile.addressMode, fromFile.imageSize, fromFile.smokeUrl, fromFile.staleAfterMinutes], ["street", "1920x0", null, 90]);
  assert.deepEqual(Object.keys(readSettingsFile(path.join(state, "sync.env"))).sort(), ["EICHMANN_SMOKE_URL", "IMMOWELT_ADDRESS_MODE", "IMMOWELT_IMAGE_SIZE", "IMMOWELT_STALE_AFTER_MINUTES"]);
  const envWins = loadConfig({ EICHMANN_STATE_DIR: state, EICHMANN_DB_PATH: path.join(state, "x.db"), IMMOWELT_ADDRESS_MODE: "locality", EICHMANN_SMOKE_URL: "http://127.0.0.1/ai/build.json" });
  assert.deepEqual([envWins.addressMode, envWins.smokeUrl], ["locality", "http://127.0.0.1/ai/build.json"]);
  const none = loadConfig({ EICHMANN_STATE_DIR: path.join(state, "gibt-es-nicht"), EICHMANN_DB_PATH: path.join(state, "x.db") });
  assert.deepEqual([none.addressMode, none.imageSize, none.smokeUrl], ["locality", null, "http://127.0.0.1/ai/build.json"]);
  fs.rmSync(state, { recursive: true, force: true });
});

test("Sperre: exklusiv, vererbbar an Kindprozesse, wird freigegeben", async () => {
  const tmpRoot = process.env.EICHMANN_TEST_TMP || os.tmpdir();
  fs.mkdirSync(tmpRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(tmpRoot, "eichmann-lock-"));
  const a = await Lock.acquireLock(dir, { purpose: "a" });
  await assert.rejects(Lock.acquireLock(dir, { purpose: "b" }), (err) => err.code === "pipeline_busy" && err.holder.purpose === "a");
  const child = await Lock.acquireLock(dir, { purpose: "kind", env: { EICHMANN_LOCK_TOKEN: a.token } });
  assert.equal(child.inherited, true);
  child.release();
  await assert.rejects(Lock.acquireLock(dir, { purpose: "b" }), /belegt/);
  a.release();
  const c = await Lock.acquireLock(dir, { purpose: "c" });
  c.release();
  // eine Sperrdatei, die gerade erst angelegt wird (noch leer), ist KEINE verwaiste Sperre
  fs.writeFileSync(path.join(dir, "pipeline.lock"), "");
  await assert.rejects(Lock.acquireLock(dir, { purpose: "d" }), (err) => err.code === "pipeline_busy");
  // alt und unlesbar (Absturz mitten im Schreiben) → wird übernommen
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(dir, "pipeline.lock"), old, old);
  const d = await Lock.acquireLock(dir, { purpose: "d" });
  assert.ok(d.tookOverFrom);
  d.release();
  fs.rmSync(dir, { recursive: true, force: true });
});

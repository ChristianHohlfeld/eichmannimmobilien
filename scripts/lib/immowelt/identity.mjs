/**
 * Immowelt identities.
 *
 * One offer has three IDs that live in different ID spaces:
 *   estate id   numeric            EstateProperty@id="90187795"
 *   API GUID    32 hex, no dashes  EstateProperty@guid="E40350BE25F949F081CCE3377E64699A"
 *   online id   7 chars            EstateProperty@onlineID="2ql2c52"  (immowelt.de/expose/2ql2c52)
 * The website UUID the old scraper stored (immowelt.de/expose/<uuid>) is a FOURTH id and is
 * usually NOT the API GUID with dashes. Nothing here guesses identity from titles or prices.
 */

const HEX32 = /^[0-9a-f]{32}$/i;
const DASHED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** → 32 upper-case hex chars, or null. Accepts dashed/undashed, braces, any case. */
export function normalizeGuid(value) {
  const s = String(value ?? "").trim().replace(/^\{|\}$/g, "");
  if (HEX32.test(s)) return s.toUpperCase();
  if (DASHED.test(s)) return s.replace(/-/g, "").toUpperCase();
  return null;
}

/** 32 hex → canonical dashed lower-case form (8-4-4-4-12). Used as DB primary key. */
export function dashedGuid(value) {
  const g = normalizeGuid(value);
  if (!g) return null;
  const l = g.toLowerCase();
  return `${l.slice(0, 8)}-${l.slice(8, 12)}-${l.slice(12, 16)}-${l.slice(16, 20)}-${l.slice(20)}`;
}

export function normalizeOnlineId(value) {
  const s = String(value ?? "").trim().toLowerCase();
  return /^[a-z0-9]{5,12}$/.test(s) ? s : null;
}

export function normalizeEstateId(value) {
  const s = String(value ?? "").trim();
  return /^[0-9]{1,15}$/.test(s) ? s : null;
}

/** Online id from https://www.immowelt.de/expose/<onlineid> (not from the UUID form). */
export function onlineIdFromExposeUrl(url) {
  const m = /\/expose\/([a-z0-9]{5,12})(?:[/?#]|$)/i.exec(String(url || ""));
  return m ? normalizeOnlineId(m[1]) : null;
}

/** Every GUID-shaped token inside media URLs (asset ids are unique per uploaded file). */
export function assetIdsFromUrls(urls) {
  const out = new Set();
  for (const u of urls || []) {
    const s = typeof u === "string" ? u : u?.url || u?.source_url || "";
    for (const m of String(s).matchAll(/[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/gi)) {
      out.add(m[0].replace(/-/g, "").toUpperCase());
    }
  }
  return out;
}

/** True for rows written by the pre-API importer (scraper era): no API identity stored. */
export function isLegacyImmoweltRow(row) {
  if (!row) return false;
  const origin = String(row.origin || row.source || "").toLowerCase();
  if (origin === "eigen" || origin === "local") return false;
  return !row.immowelt_guid && row.immowelt_api !== true;
}

/**
 * Evidence-based mapping of legacy rows to API offers for the one-time cutover.
 *
 * DECISIVE evidence (id level) – always wins:
 *   guid_equal            legacy UUID without dashes == API GUID
 *   online_id_manual      data/sot/immowelt-identity-map.json: someone looked the offer up and noted its online id
 * SUPPORTING evidence (file level) – only for rows and offers that no decisive evidence has claimed:
 *   media_asset_overlap   both sides reference the same uploaded files (>= 2 shared asset ids, at least
 *                         half of the smaller picture set, and unambiguous in both directions)
 *
 * Sibling units of one project often share pictures. Such an overlap proves nothing: the row is then
 * NOT matched (decision "retire", evidence "media_asset_overlap_ambiguous" with the candidates as a
 * hint for the reviewer) – the offer itself still goes online, under a new address. A documented
 * online id in the map resolves it. Only contradictory decisive evidence blocks the plan ("ambiguous").
 *
 * Whether an unmatched row is retired is decided by the completeness of the API list (see pipeline),
 * never by this function, and never by titles or prices.
 *
 * @param {object[]} legacyRows   DB listings (origin=immowelt, scraper era)
 * @param {object[]} apiListings  normalized snapshot listings
 * @param {{ legacy_id: string, online_id: string, verified_by?: string, verified_at?: string, note?: string }[]} [manual]
 */
export function planLegacyMigration(legacyRows, apiListings, manual = []) {
  const api = apiListings.map((L) => ({
    L,
    guid: normalizeGuid(L.immowelt_guid),
    online: normalizeOnlineId(L.immowelt_online_id),
    estate: normalizeEstateId(L.immowelt_estate_id),
    assets: assetIdsFromUrls((L.media || []).flatMap((m) => [m.source_url, m.thumb_url, m.xxl_url, m.url].filter(Boolean))),
  }));
  const manualByLegacy = new Map();
  for (const m of manual || []) {
    const key = String(m?.legacy_id || "").toLowerCase();
    const online = normalizeOnlineId(m?.online_id);
    if (key && online) manualByLegacy.set(key, { ...m, online_id: online });
  }
  const legacy = legacyRows.map((row) => {
    const id = String(row.id || "").toLowerCase();
    return {
      row,
      id,
      guid: normalizeGuid(row.immowelt_id || row.id),
      assets: assetIdsFromUrls([row.main_image_url, ...(row.images || []), ...(row.floor_plans || []).map((f) => (typeof f === "string" ? f : f?.url))]),
      manualHit: manualByLegacy.get(id) || null,
    };
  });
  const targetOf = (a) => ({ guid: a.guid, online_id: a.online, estate_id: a.estate });
  const overlapOf = (l, a) => {
    if (!l.assets.size || !a.assets.size) return null;
    let shared = 0;
    for (const x of l.assets) if (a.assets.has(x)) shared++;
    if (shared < 2 || shared / Math.min(l.assets.size, a.assets.size) < 0.5) return null;
    return { type: "media_asset_overlap", detail: `${shared} gemeinsame Bild-Assets (alt ${l.assets.size}, API ${a.assets.size})`, shared };
  };

  // --- 1. decisive evidence ---
  const strong = legacy.map((l) => {
    const hits = [];
    api.forEach((a, apiIndex) => {
      const evidence = [];
      if (l.guid && a.guid && l.guid === a.guid) evidence.push({ type: "guid_equal", detail: a.guid });
      if (l.manualHit && a.online && l.manualHit.online_id === a.online) {
        evidence.push({ type: "online_id_manual", detail: a.online, verified_by: l.manualHit.verified_by || null, verified_at: l.manualHit.verified_at || null, note: l.manualHit.note || null });
      }
      if (evidence.length) hits.push({ apiIndex, evidence });
    });
    return hits;
  });
  const strongClaims = new Map(); // apiIndex → legacy indexes
  strong.forEach((hits, li) => hits.forEach((h) => strongClaims.set(h.apiIndex, [...(strongClaims.get(h.apiIndex) || []), li])));
  const decided = new Map(); // legacy index → { decision, evidence, target }
  const matchedApi = new Set();
  legacy.forEach((l, li) => {
    const hits = strong[li];
    if (!hits.length) return;
    if (hits.length === 1 && strongClaims.get(hits[0].apiIndex).length === 1) {
      const a = api[hits[0].apiIndex];
      const extra = overlapOf(l, a);
      decided.set(li, { decision: "match", evidence: [...hits[0].evidence, ...(extra ? [extra] : [])], target: targetOf(a) });
      matchedApi.add(hits[0].apiIndex);
    } else {
      // two old rows documented for the same offer, or GUID and map entry pointing to different offers
      decided.set(li, {
        decision: "ambiguous",
        evidence: hits.flatMap((h) => h.evidence.map((e) => ({ ...e, api_online_id: api[h.apiIndex].online, also_claimed_by: strongClaims.get(h.apiIndex).filter((x) => x !== li).map((x) => legacy[x].row.slug || legacy[x].id) }))),
        target: null,
      });
    }
  });

  // --- 2. supporting evidence, among what is left on both sides ---
  const candidates = [];
  legacy.forEach((l, li) => {
    if (decided.has(li)) return;
    api.forEach((a, apiIndex) => {
      if (matchedApi.has(apiIndex)) return;
      const evidence = overlapOf(l, a);
      if (evidence) candidates.push({ li, apiIndex, evidence });
    });
  });
  const byLegacy = new Map();
  const byApi = new Map();
  for (const c of candidates) {
    byLegacy.set(c.li, [...(byLegacy.get(c.li) || []), c]);
    byApi.set(c.apiIndex, [...(byApi.get(c.apiIndex) || []), c]);
  }
  legacy.forEach((l, li) => {
    if (decided.has(li)) return;
    const mine = byLegacy.get(li) || [];
    if (mine.length === 1 && byApi.get(mine[0].apiIndex).length === 1) {
      decided.set(li, { decision: "match", evidence: [mine[0].evidence], target: targetOf(api[mine[0].apiIndex]) });
      return;
    }
    if (mine.length) {
      const involved = new Set(mine.map((c) => api[c.apiIndex].online));
      decided.set(li, {
        decision: "retire",
        evidence: [{ type: "media_asset_overlap_ambiguous", detail: `Bildüberschneidung mit ${[...involved].join(", ")} – nicht eindeutig (gemeinsam genutzte Bilder), deshalb keine Zuordnung`, candidates: [...involved] }],
        target: null,
      });
      return;
    }
    if (l.manualHit) {
      // Someone documented an online id that is not in the current API list: recorded, but the offer is offline.
      decided.set(li, { decision: "retire", evidence: [{ type: "online_id_manual_not_in_inventory", detail: l.manualHit.online_id }], target: null });
      return;
    }
    decided.set(li, { decision: "retire", evidence: [], target: null });
  });
  // unique overlap matches claim their offer only now (so that two rows can never both win it above)
  legacy.forEach((l, li) => {
    const d = decided.get(li);
    if (d.decision === "match") matchedApi.add(api.findIndex((a) => a.guid === d.target.guid));
  });

  const decisions = legacy.map((l, li) => ({
    legacy_id: l.id,
    slug: l.row.slug || null,
    was_public: l.row.active !== false && l.row.site_hidden !== true,
    // human context only, never used for matching:
    legacy_title: l.row.title || null,
    legacy_price: l.row.price || null,
    ...decided.get(li),
  }));
  const created = api
    .map((a, i) => ({ a, i }))
    .filter(({ i }) => !matchedApi.has(i))
    .map(({ a }) => ({ decision: "new", target: targetOf(a), api_title: a.L.title || null }));
  return {
    schema: "eichmann.immowelt-identity-plan/v1",
    legacy: decisions,
    created,
    // contradictory decisive evidence: blocks the approval until the map is corrected
    ambiguous: decisions.filter((d) => d.decision === "ambiguous").length,
    // picture overlap that proves nothing: not blocking, listed so the reviewer can document the online id
    unresolved_overlaps: decisions.filter((d) => d.evidence.some((e) => e.type === "media_asset_overlap_ambiguous")).length,
  };
}

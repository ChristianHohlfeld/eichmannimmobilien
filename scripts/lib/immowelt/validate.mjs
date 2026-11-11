/**
 * Snapshot gate. It answers exactly one question: "Is this the complete, consistent state of
 * the Immowelt account right now?" – never "does this change look plausible?".
 *
 * Deliberately NOT checked (the old listing-safety rules blocked valid changes):
 *   price ranges (rent is 1.200 €, not 199.000 €), count ratios, id overlap with the previous
 *   state, text got shorter, a field was emptied, fewer pictures than before.
 * A complete answer from Immowelt is the truth, including an empty inventory.
 */
import { normalizeGuid } from "./identity.mjs";

const DEFAULT_IMAGE_HOSTS = ["immowelt.org", "immowelt.de", "immowelt.com", "immowelt.net"];

export function hostAllowed(url, allowed = DEFAULT_IMAGE_HOSTS) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    return allowed.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/**
 * @returns {{ ok: boolean, errors: {code:string,message:string,online_id?:string}[], warnings: {code:string,message:string,online_id?:string}[] }}
 */
export function validateSnapshot(snapshot, { allowedImageHosts = DEFAULT_IMAGE_HOSTS } = {}) {
  const errors = [];
  const warnings = [];
  const err = (code, message, L) => errors.push({ code, message, ...(L ? { online_id: L.immowelt_online_id } : {}) });
  const warn = (code, message, L) => warnings.push({ code, message, ...(L ? { online_id: L.immowelt_online_id } : {}) });

  if (!snapshot || !Array.isArray(snapshot.listings)) return { ok: false, errors: [{ code: "snapshot_malformed", message: "Snapshot ohne Angebotsliste." }], warnings };
  const reported = (snapshot.reported_total_counts || []).reduce((a, r) => a + Number(r.total_count || 0), 0);
  if (!(snapshot.reported_total_counts || []).length) err("snapshot_no_proof", "Kein TotalCount der API vorhanden – Vollständigkeit nicht belegt.");
  // Offers listed under several GeoIDs are counted once, so reported >= unique is the invariant.
  if (snapshot.listings.length > reported) err("snapshot_count_mismatch", `Mehr Angebote (${snapshot.listings.length}) als die API gemeldet hat (${reported}).`);
  if ((snapshot.reported_total_counts || []).length === 1 && snapshot.listings.length !== reported) {
    err("snapshot_count_mismatch", `Angebote im Snapshot (${snapshot.listings.length}) ≠ TotalCount der API (${reported}).`);
  }

  const seen = { guid: new Set(), online: new Set(), estate: new Set() };
  snapshot.listings.forEach((L, i) => {
    if (!normalizeGuid(L.immowelt_guid) || !L.immowelt_online_id || !L.immowelt_estate_id) err("listing_identity", `Angebot ${i + 1}: Kennungen unvollständig.`, L);
    for (const [k, v] of [["guid", L.immowelt_guid], ["online", L.immowelt_online_id], ["estate", L.immowelt_estate_id]]) {
      if (seen[k].has(v)) err("listing_duplicate", `Kennung ${v} kommt mehrfach vor.`, L);
      seen[k].add(v);
    }
    if (L.position !== i) err("listing_order", `Angebot ${L.immowelt_online_id}: Position inkonsistent.`, L);
    if (!String(L.title || "").trim()) err("listing_incomplete", "Überschrift fehlt.", L);
    if (!["kauf", "miete"].includes(L.marketing)) err("listing_marketing", "Vermarktungsart unbekannt.", L);
    if (L.price_on_request ? L.price_eur != null : !(L.price_eur > 0)) err("listing_price", "Preisangabe widersprüchlich.", L);
    if (!Array.isArray(L.media) || !Array.isArray(L.sections) || !Array.isArray(L.fact_rows)) err("listing_incomplete", "Struktur unvollständig.", L);
    for (const m of L.media || []) {
      if (!m.url || !m.asset_key) err("media_url", `Bild ${m.index + 1} ohne verwertbare Adresse.`, L);
      else if (!hostAllowed(m.url, allowedImageHosts)) err("media_host", `Bild ${m.index + 1} liegt auf einem unbekannten Host.`, L);
    }
    if ((L.api_notes?.declared_images || 0) !== (L.media || []).length + (L.api_notes?.duplicate_image_assets || 0)) {
      err("media_count", "Anzahl der Bilder im Exposé und im Snapshot stimmt nicht überein.", L);
    }
    // Soft: legitimate on Immowelt, but worth seeing in the status.
    if (!(L.media || []).length) warn("no_images", "Angebot ohne Bilder.", L);
    if (!(L.sections || []).length) warn("no_text", "Angebot ohne Beschreibungstexte.", L);
    if ((L.api_notes?.unmapped_elements || []).length) warn("contract_drift", `Unbekannte Exposé-Elemente: ${L.api_notes.unmapped_elements.join(", ")}.`, L);
    if (L.api_notes?.duplicate_image_assets) warn("duplicate_images", `${L.api_notes.duplicate_image_assets} doppelt gelieferte Bilder zusammengefasst.`, L);
  });
  return { ok: errors.length === 0, errors, warnings };
}

/** What changes between the published state and the candidate (by API GUID, order-aware). */
export function classifyChange(publishedListings, candidateListings) {
  const pub = new Map((publishedListings || []).map((L) => [L.immowelt_guid, L]));
  const cand = new Map((candidateListings || []).map((L) => [L.immowelt_guid, L]));
  const added = [...cand.keys()].filter((g) => !pub.has(g));
  const removed = [...pub.keys()].filter((g) => !cand.has(g));
  const changed = [...cand.keys()].filter((g) => pub.has(g) && (pub.get(g).content_hash || pub.get(g).core_hash) !== (cand.get(g).content_hash || cand.get(g).core_hash));
  const common = (list, other) => list.map((L) => L.immowelt_guid).filter((g) => other.has(g));
  const reordered = common(publishedListings || [], cand).join("|") !== common(candidateListings || [], pub).join("|");
  const label = (g, src) => src.get(g)?.immowelt_online_id || g;
  return {
    added: added.map((g) => label(g, cand)),
    removed: removed.map((g) => label(g, pub)),
    changed: changed.map((g) => label(g, cand)),
    reordered,
    unchanged: !added.length && !removed.length && !changed.length && !reordered,
    published_count: pub.size,
    candidate_count: cand.size,
  };
}

/**
 * Large disappearances are published automatically, but only after Immowelt has given the
 * identical answer twice, some minutes apart. That makes an empty inventory provable without
 * a human, and keeps a one-off glitch from wiping the site.
 */
export function needsConfirmation(change, { minRemoved = 3, removedShare = 0.5 } = {}) {
  if (!change.published_count) return null;
  if (change.candidate_count === 0) return "empty_inventory";
  if (change.removed.length >= minRemoved && change.removed.length / change.published_count >= removedShare) return "mass_removal";
  return null;
}

/**
 * @param {object|null} pending   { fingerprint, reason, first_seen_at, sightings }
 * @returns {{ confirmed: boolean, pending: object }}
 */
export function confirmationState(pending, { fingerprint, reason, now, minMinutes = 20 }) {
  if (!pending || pending.fingerprint !== fingerprint) {
    return { confirmed: false, pending: { fingerprint, reason, first_seen_at: now, sightings: 1 } };
  }
  const ageMin = (Date.parse(now) - Date.parse(pending.first_seen_at)) / 60000;
  const next = { ...pending, sightings: (pending.sightings || 1) + 1 };
  return { confirmed: ageMin >= minMinutes, pending: next };
}

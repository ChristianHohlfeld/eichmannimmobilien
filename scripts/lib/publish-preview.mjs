/**
 * Diff live public listings.json vs SQLite SoT (or a proposed listing set).
 * Powers the admin Abnahme modal: Ist (live) vs Neu (would become live).
 */
import fs from "node:fs";
import path from "node:path";

function originOf(L) {
  const raw = String(L?.origin || L?.source || "").toLowerCase();
  if (raw === "eigen" || raw === "local") return "Eigen";
  return "Immowelt";
}

function publicKey(L) {
  return String(L?.id || L?.slug || "");
}

function isPublic(L) {
  return L && L.active !== false && L.site_hidden !== true;
}

function fingerprint(L) {
  return JSON.stringify({
    title: L.title || "",
    slug: L.slug || "",
    price: L.price || "",
    location: L.location || "",
    rooms: L.rooms || "",
    living_area: L.living_area || "",
    status: L.status || "",
    type: L.type || "",
    short_description: L.short_description || "",
    description: (L.description || "").slice(0, 500),
    main_image_url: L.main_image_url || "",
    images: L.images || [],
    gallery_bases: L.gallery_bases || [],
    image_base: L.image_base || "",
    active: L.active !== false,
    site_hidden: L.site_hidden === true,
    detail_page: L.detail_page !== false,
  });
}

function thumbOf(L) {
  if (L?.main_image_url) return String(L.main_image_url);
  const base = L?.image_base || (Array.isArray(L?.gallery_bases) && L.gallery_bases[0]) || null;
  if (!base) return null;
  const b = String(base).replace(/^\/+/, "");
  const rel = b.includes("/") ? b : `assets/listings/${b}`;
  return `/${rel}.jpg`;
}

function summarizeListing(L) {
  return {
    id: L.id,
    title: L.title || L.slug || L.id || "–",
    location: L.location || "–",
    origin: originOf(L),
    price: L.price || null,
    active: L.active !== false,
    site_hidden: L.site_hidden === true,
    thumb: thumbOf(L),
  };
}

function publicCards(listings) {
  return (listings || []).filter(isPublic).map(summarizeListing);
}

/**
 * @param {object[]} liveListings from public data/listings.json
 * @param {object[]} nextListings proposed public set (usually from DB export)
 */
export function diffListings(liveListings, nextListings) {
  const liveMap = new Map();
  for (const L of liveListings || []) {
    const k = publicKey(L);
    if (k) liveMap.set(k, L);
  }
  const nextMap = new Map();
  for (const L of nextListings || []) {
    const k = publicKey(L);
    if (k) nextMap.set(k, L);
  }

  const added = [];
  const removed = [];
  const changed = [];
  const visibility = [];

  for (const [id, next] of nextMap) {
    const live = liveMap.get(id);
    if (!live) {
      if (isPublic(next)) added.push(summarizeListing(next));
      continue;
    }
    const livePub = isPublic(live);
    const nextPub = isPublic(next);
    if (livePub !== nextPub) {
      visibility.push({
        ...summarizeListing(next),
        from: livePub ? "öffentlich" : "ausgeblendet",
        to: nextPub ? "öffentlich" : "ausgeblendet",
        ist: summarizeListing(live),
        neu: summarizeListing(next),
      });
    }
    if (fingerprint(live) !== fingerprint(next)) {
      const liveCore = { ...live, site_hidden: false, active: true };
      const nextCore = { ...next, site_hidden: false, active: true };
      if (fingerprint(liveCore) !== fingerprint(nextCore)) {
        changed.push({
          ...summarizeListing(next),
          ist: summarizeListing(live),
          neu: summarizeListing(next),
        });
      } else if (livePub === nextPub) {
        changed.push({
          ...summarizeListing(next),
          ist: summarizeListing(live),
          neu: summarizeListing(next),
        });
      }
    }
  }

  for (const [id, live] of liveMap) {
    if (!nextMap.has(id) && isPublic(live)) {
      removed.push(summarizeListing(live));
    }
  }

  const livePublic = (liveListings || []).filter(isPublic).length;
  const nextPublic = (nextListings || []).filter(isPublic).length;

  return {
    added,
    removed,
    changed,
    visibility,
    ist: {
      label: "Jetzt online (Ist)",
      count: livePublic,
      listings: publicCards(liveListings),
    },
    neu: {
      label: "Nach Übernahme (Neu)",
      count: nextPublic,
      listings: publicCards(nextListings),
    },
    counts: {
      live_public: livePublic,
      next_public: nextPublic,
      live_total: (liveListings || []).length,
      next_total: (nextListings || []).length,
    },
    empty_risk: nextPublic === 0 && livePublic > 0,
    has_changes:
      added.length + removed.length + changed.length + visibility.length > 0 ||
      livePublic !== nextPublic,
  };
}

export function loadLiveListings(siteRoot) {
  const p = path.join(siteRoot, "data", "listings.json");
  if (!fs.existsSync(p)) return [];
  try {
    const doc = JSON.parse(fs.readFileSync(p, "utf8"));
    return Array.isArray(doc.listings) ? doc.listings : [];
  } catch {
    return [];
  }
}

/** Build preview of publishing current DB document vs live site. */
export function previewPublish(siteRoot, dbDoc) {
  const live = loadLiveListings(siteRoot);
  const next = Array.isArray(dbDoc?.listings) ? dbDoc.listings : [];
  const diff = diffListings(live, next);
  return {
    ok: true,
    preview: true,
    ...diff,
    message: diff.empty_risk
      ? "Achtung: Danach wären keine Inserate mehr öffentlich."
      : diff.has_changes
        ? "Vergleichen Sie Ist (jetzt online) und Neu (nach Übernahme)."
        : "Keine Unterschiede zur öffentlichen Website.",
  };
}

export function previewEigenUpsert(siteRoot, dbListings, proposedListing) {
  const byId = new Map((dbListings || []).map((L) => [L.id, L]));
  byId.set(proposedListing.id, {
    ...proposedListing,
    origin: "eigen",
    source: "eigen",
  });
  return previewPublish(siteRoot, { listings: [...byId.values()] });
}

export function previewEigenDelete(siteRoot, dbListings, id) {
  const next = (dbListings || []).filter((L) => L.id !== id);
  return previewPublish(siteRoot, { listings: next });
}

export function previewVisibility(siteRoot, dbListings, id, site_hidden) {
  const next = (dbListings || []).map((L) =>
    L.id === id ? { ...L, site_hidden: site_hidden === true } : L
  );
  return previewPublish(siteRoot, { listings: next });
}

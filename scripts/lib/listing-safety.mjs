const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function idFromUrl(url) {
  const match = String(url || "").match(/\/expose\/([a-f0-9-]{36})/i);
  return match ? match[1].toLowerCase() : null;
}

function listingId(item) {
  return String(item?.immowelt_id || item?.id || idFromUrl(item?.expose_url) || idFromUrl(item?.url) || "").toLowerCase();
}

function isPublic(item) {
  return Boolean(item) && item.active !== false && item.site_hidden !== true;
}

function hasText(value, min = 1) {
  return typeof value === "string" && value.trim().length >= min;
}

function parseGermanNumber(value) {
  const raw = String(value ?? "").replace(/\s/g, "").replace(/[^0-9,.-]/g, "");
  if (!raw) return null;
  const normalized = raw.includes(",")
    ? raw.replace(/\./g, "").replace(",", ".")
    : raw.replace(/(?<=\d)\.(?=\d{3}(?:\D|$))/g, "");
  const num = Number.parseFloat(normalized);
  return Number.isFinite(num) ? num : null;
}

function wordSet(value) {
  return new Set(
    (String(value || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
      .filter((word) => word.length >= 4)
  );
}

function overlapRatio(a, b) {
  const left = wordSet(a);
  const right = wordSet(b);
  if (!left.size || !right.size) return 1;
  let overlap = 0;
  for (const word of left) if (right.has(word)) overlap++;
  return overlap / Math.min(left.size, right.size);
}

export function validateIncomingSnapshot(rawListings, previousData = null) {
  if (!Array.isArray(rawListings) || rawListings.length === 0) {
    throw new Error("Immowelt snapshot rejected: empty listing set");
  }

  const ids = rawListings.map(listingId);
  const unique = new Set(ids.filter(Boolean));
  if (ids.some((id) => !UUID_RE.test(id))) {
    throw new Error("Immowelt snapshot rejected: invalid or missing expose UUID");
  }
  if (unique.size !== rawListings.length) {
    throw new Error("Immowelt snapshot rejected: duplicate expose UUIDs");
  }

  const titleCount = rawListings.filter((item) => hasText(item.title, 5)).length;
  const exposeCount = rawListings.filter((item) => idFromUrl(item.expose_url || item.url) === listingId(item)).length;
  const priceCount = rawListings.filter((item) => parseGermanNumber(item.price) > 0).length;
  const locationCount = rawListings.filter((item) => hasText(item.location, 3)).length;

  if (titleCount / rawListings.length < 0.8) {
    throw new Error(`Immowelt snapshot rejected: only ${titleCount}/${rawListings.length} titles are usable`);
  }
  if (exposeCount !== rawListings.length) {
    throw new Error(`Immowelt snapshot rejected: expose identity mismatch (${exposeCount}/${rawListings.length})`);
  }
  if (priceCount / rawListings.length < 0.55) {
    throw new Error(`Immowelt snapshot rejected: only ${priceCount}/${rawListings.length} prices are usable`);
  }
  if (locationCount / rawListings.length < 0.55) {
    throw new Error(`Immowelt snapshot rejected: only ${locationCount}/${rawListings.length} locations are usable`);
  }

  const previousPublic = Array.isArray(previousData?.listings)
    ? previousData.listings.filter(isPublic)
    : [];
  if (previousPublic.length >= 5) {
    const ratio = rawListings.length / previousPublic.length;
    if (ratio < 0.55 || ratio > 1.75) {
      throw new Error(
        `Immowelt snapshot rejected: implausible count ${rawListings.length} vs last valid ${previousPublic.length}`
      );
    }

    const previousIds = new Set(previousPublic.map(listingId).filter(Boolean));
    const overlap = ids.filter((id) => previousIds.has(id)).length;
    const overlapRatioValue = overlap / Math.min(previousIds.size, rawListings.length);
    if (overlapRatioValue < 0.55) {
      throw new Error(
        `Immowelt snapshot rejected: object identity overlap only ${overlap}/${Math.min(previousIds.size, rawListings.length)}`
      );
    }

    return {
      count: rawListings.length,
      previous_count: previousPublic.length,
      overlap_count: overlap,
      overlap_ratio: overlapRatioValue,
    };
  }

  return {
    count: rawListings.length,
    previous_count: previousPublic.length,
    overlap_count: 0,
    overlap_ratio: 1,
  };
}

export function stabilizeListingsAgainstPrevious(listings, previousData = null) {
  if (!Array.isArray(listings)) return { listings: [], warnings: [] };
  const previous = new Map(
    (Array.isArray(previousData?.listings) ? previousData.listings : [])
      .map((item) => [listingId(item), item])
      .filter(([id]) => id)
  );
  const warnings = [];

  const preserve = (item, prev, field, reason) => {
    if (prev?.[field] == null) return;
    item[field] = Array.isArray(prev[field])
      ? [...prev[field]]
      : prev[field] && typeof prev[field] === "object"
        ? { ...prev[field] }
        : prev[field];
    warnings.push(`${listingId(item).slice(0, 8)}:${field} kept from last-known-good (${reason})`);
  };

  for (const item of listings) {
    const prev = previous.get(listingId(item));
    if (!prev) continue;

    for (const field of ["title", "price", "location", "rooms", "living_area", "description", "location_description", "additional_information"]) {
      const incoming = item[field];
      if ((incoming == null || String(incoming).trim() === "") && prev[field] != null && String(prev[field]).trim() !== "") {
        preserve(item, prev, field, "incoming field empty");
      }
    }

    if (!hasText(item.title, 5) || /^immobilie$/i.test(String(item.title || "").trim())) {
      preserve(item, prev, "title", "implausible title");
    }

    const numericRules = [
      ["price", 0.5, 1.5],
      ["living_area", 0.7, 1.3],
      ["plot_area", 0.55, 1.8],
    ];
    for (const [field, minRatio, maxRatio] of numericRules) {
      const before = parseGermanNumber(prev[field]);
      const after = parseGermanNumber(item[field]);
      if (before > 0 && after > 0) {
        const ratio = after / before;
        if (ratio < minRatio || ratio > maxRatio) {
          preserve(item, prev, field, `numeric jump x${ratio.toFixed(2)}`);
        }
      }
    }

    const beforeRooms = parseGermanNumber(prev.rooms);
    const afterRooms = parseGermanNumber(item.rooms);
    if (beforeRooms > 0 && afterRooms > 0 && Math.abs(afterRooms - beforeRooms) > 2) {
      preserve(item, prev, "rooms", "implausible room-count jump");
    }

    for (const field of ["description", "location_description", "additional_information"]) {
      const before = String(prev[field] || "").trim();
      const after = String(item[field] || "").trim();
      if (before.length >= 160 && after.length > 0 && after.length < Math.max(80, before.length * 0.4)) {
        preserve(item, prev, field, "sudden text truncation");
        continue;
      }
      if (before.length >= 180 && after.length >= 100 && overlapRatio(before, after) < 0.08) {
        preserve(item, prev, field, "content no longer maps to same object");
      }
    }

    const oldImages = Array.isArray(prev.images) ? prev.images : [];
    const newImages = Array.isArray(item.images) ? item.images : [];
    if (oldImages.length >= 4 && newImages.length > 0 && newImages.length < Math.max(2, Math.floor(oldImages.length * 0.3))) {
      preserve(item, prev, "images", "gallery collapsed unexpectedly");
      if (Array.isArray(prev.gallery_bases)) preserve(item, prev, "gallery_bases", "gallery collapsed unexpectedly");
      if (prev.main_image_url) preserve(item, prev, "main_image_url", "gallery collapsed unexpectedly");
    }

    const oldFacts = prev.facts && typeof prev.facts === "object" ? Object.keys(prev.facts).length : 0;
    const newFacts = item.facts && typeof item.facts === "object" ? Object.keys(item.facts).length : 0;
    if (oldFacts >= 5 && newFacts > 0 && newFacts < Math.ceil(oldFacts * 0.4)) {
      preserve(item, prev, "facts", "facts collapsed unexpectedly");
    }
  }

  return { listings, warnings };
}

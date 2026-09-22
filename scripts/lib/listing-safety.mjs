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

export function validateNoDestructiveOverwrite(listings, previousData = null) {
  if (!Array.isArray(listings) || listings.length === 0) {
    throw new Error("Immowelt snapshot rejected: empty final listing set");
  }

  const previous = new Map(
    (Array.isArray(previousData?.listings) ? previousData.listings : [])
      .map((item) => [listingId(item), item])
      .filter(([id]) => id)
  );
  if (!previous.size) return { checked: 0 };

  const requiredIfPreviouslyPresent = [
    "title",
    "price",
    "location",
    "rooms",
    "living_area",
    "description",
    "location_description",
    "additional_information",
  ];
  const losses = [];
  let checked = 0;

  for (const item of listings) {
    const id = listingId(item);
    const prev = previous.get(id);
    if (!prev) continue;
    checked++;

    for (const field of requiredIfPreviouslyPresent) {
      if (hasText(prev[field]) && !hasText(item[field])) {
        losses.push(`${id.slice(0, 8)}:${field}`);
      }
    }

    const oldImages = Array.isArray(prev.images) ? prev.images.length : 0;
    const newImages = Array.isArray(item.images) ? item.images.length : 0;
    if (oldImages > 0 && newImages === 0) losses.push(`${id.slice(0, 8)}:images`);

    const oldFacts = prev.facts && typeof prev.facts === "object" ? Object.keys(prev.facts).length : 0;
    const newFacts = item.facts && typeof item.facts === "object" ? Object.keys(item.facts).length : 0;
    if (oldFacts > 0 && newFacts === 0) losses.push(`${id.slice(0, 8)}:facts`);
  }

  if (losses.length) {
    throw new Error(
      `Immowelt snapshot rejected: would erase existing source data (${losses.slice(0, 12).join(", ")}${losses.length > 12 ? ", …" : ""})`
    );
  }

  return { checked };
}


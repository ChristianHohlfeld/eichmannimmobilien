const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function idFromUrl(url) {
  const match = String(url || "").match(/\/expose\/([a-f0-9-]{36})/i);
  return match ? match[1].toLowerCase() : null;
}

function listingId(item) {
  return String(
    item?.immowelt_id ||
    item?.id ||
    idFromUrl(item?.expose_url) ||
    idFromUrl(item?.url) ||
    ""
  ).toLowerCase();
}

function hasText(value, min = 1) {
  return typeof value === "string" && value.trim().length >= min;
}

export function validateIncomingSnapshot(rawListings) {
  if (!Array.isArray(rawListings) || rawListings.length === 0) {
    throw new Error("Immowelt snapshot rejected: empty listing set");
  }

  const ids = rawListings.map(listingId);
  if (ids.some((id) => !UUID_RE.test(id))) {
    throw new Error("Immowelt snapshot rejected: invalid or missing expose UUID");
  }
  if (new Set(ids).size !== rawListings.length) {
    throw new Error("Immowelt snapshot rejected: duplicate expose UUIDs");
  }

  for (const item of rawListings) {
    const id = listingId(item);
    if (idFromUrl(item.expose_url || item.url) !== id) {
      throw new Error(`Immowelt snapshot rejected: expose identity mismatch for ${id.slice(0, 8)}`);
    }
    if (!hasText(item.title, 5)) {
      throw new Error(`Immowelt snapshot rejected: missing title for ${id.slice(0, 8)}`);
    }
  }

  return { count: rawListings.length };
}

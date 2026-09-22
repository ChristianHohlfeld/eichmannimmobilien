const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function idFromUrl(url) {
  const match = String(url || "").match(/\/expose\/([a-f0-9-]{36})/i);
  return match ? match[1].toLowerCase() : null;
}

export function listingId(item) {
  return String(item?.immowelt_id || item?.id || idFromUrl(item?.expose_url) || idFromUrl(item?.url) || "").toLowerCase();
}

function hasText(value, min = 1) {
  return typeof value === "string" && value.trim().length >= min;
}

export function parseGermanNumber(value) {
  const raw = String(value ?? "").replace(/\s/g, "").replace(/[^0-9,.-]/g, "");
  if (!raw) return null;
  const normalized = raw.includes(",")
    ? raw.replace(/\./g, "").replace(",", ".")
    : raw.replace(/(?<=\d)\.(?=\d{3}(?:\D|$))/g, "");
  const n = Number.parseFloat(normalized);
  return Number.isFinite(n) ? n : null;
}

const sourceActive = (item) => Boolean(item) && item.active !== false;

export function validateIncomingSnapshot(rawListings, previousData = null) {
  if (!Array.isArray(rawListings) || rawListings.length === 0) {
    throw new Error("Immowelt snapshot rejected: empty listing set");
  }
  const ids = rawListings.map(listingId);
  if (ids.some((id) => !UUID_RE.test(id))) throw new Error("Immowelt snapshot rejected: invalid or missing expose UUID");
  if (new Set(ids).size !== rawListings.length) throw new Error("Immowelt snapshot rejected: duplicate expose UUIDs");

  const previousAll = Array.isArray(previousData?.listings) ? previousData.listings : [];
  const previousIds = new Set(previousAll.map(listingId).filter(Boolean));

  for (const item of rawListings) {
    const id = listingId(item);
    if (idFromUrl(item.expose_url || item.url) !== id) throw new Error(`Immowelt snapshot rejected: expose identity mismatch for ${id.slice(0,8)}`);
    if (!hasText(item.title, 5)) throw new Error(`Immowelt snapshot rejected: missing title for ${id.slice(0,8)}`);
    const price=parseGermanNumber(item.price), living=parseGermanNumber(item.living_area ?? item.livingArea), plot=parseGermanNumber(item.plot_area ?? item.plotArea), rooms=parseGermanNumber(item.rooms);
    if (price!=null && (price<10000 || price>100000000)) throw new Error(`Immowelt snapshot rejected: implausible price for ${id.slice(0,8)}`);
    if (living!=null && (living<8 || living>5000)) throw new Error(`Immowelt snapshot rejected: implausible living area for ${id.slice(0,8)}`);
    if (plot!=null && (plot<5 || plot>1000000)) throw new Error(`Immowelt snapshot rejected: implausible plot area for ${id.slice(0,8)}`);
    if (rooms!=null && (rooms<0.5 || rooms>100)) throw new Error(`Immowelt snapshot rejected: implausible room count for ${id.slice(0,8)}`);
    if (!previousIds.has(id) && (!hasText(item.location,3) || !(price>0) || !(living>0 || plot>0))) {
      throw new Error(`Immowelt snapshot rejected: new offer ${id} lacks safe core fields`);
    }
  }

  const previousActive = previousAll.filter(sourceActive);
  if (previousActive.length >= 5) {
    const ratio=rawListings.length/previousActive.length;
    if (ratio<0.55 || ratio>1.75) throw new Error(`Immowelt snapshot rejected: implausible count ${rawListings.length} vs last valid active ${previousActive.length}`);
    const prevIds=new Set(previousActive.map(listingId).filter(Boolean));
    const overlap=ids.filter(id=>prevIds.has(id)).length;
    const den=Math.min(prevIds.size,rawListings.length);
    const overlapRatio=den?overlap/den:1;
    if (overlapRatio<0.55) throw new Error(`Immowelt snapshot rejected: object identity overlap only ${overlap}/${den}`);
    return {count:rawListings.length,previous_count:previousActive.length,overlap_count:overlap,overlap_ratio:overlapRatio};
  }
  return {count:rawListings.length,previous_count:previousActive.length,overlap_count:0,overlap_ratio:1};
}

export function validateNoDestructiveOverwrite(listings, previousData = null) {
  if (!Array.isArray(listings) || !listings.length) throw new Error("Immowelt snapshot rejected: empty final listing set");
  const previous=new Map((Array.isArray(previousData?.listings)?previousData.listings:[]).map(x=>[listingId(x),x]).filter(([id])=>id));
  const problems=[]; let checked=0;
  for (const item of listings) {
    const id=listingId(item), prev=previous.get(id); if(!prev) continue; checked++;
    for (const field of ["title","price","location","rooms","living_area","description","location_description","additional_information"]) {
      if (hasText(prev[field]) && !hasText(item[field])) problems.push(`${id.slice(0,8)}:${field}:would-be-empty`);
    }
    for (const [field,min,max] of [["price",0.5,1.5],["living_area",0.7,1.3],["plot_area",0.5,2]]) {
      const before=parseGermanNumber(prev[field]), after=parseGermanNumber(item[field]);
      if(before>0&&after>0){const ratio=after/before;if(ratio<min||ratio>max)problems.push(`${id.slice(0,8)}:${field}:implausible-x${ratio.toFixed(2)}`);}
    }
    const br=parseGermanNumber(prev.rooms), ar=parseGermanNumber(item.rooms);
    if(br>0&&ar>0&&Math.abs(ar-br)>2)problems.push(`${id.slice(0,8)}:rooms:implausible-jump`);
    for(const field of ["description","location_description","additional_information"]){
      const before=String(prev[field]||"").trim(),after=String(item[field]||"").trim();
      if(before.length>=160&&after.length>0&&after.length<Math.max(80,before.length*0.4))problems.push(`${id.slice(0,8)}:${field}:truncated`);
    }
    const oi=Array.isArray(prev.images)?prev.images.length:0,ni=Array.isArray(item.images)?item.images.length:0;
    if(oi>0&&ni===0)problems.push(`${id.slice(0,8)}:images:would-be-empty`);
    const of=prev.facts&&typeof prev.facts==="object"?Object.keys(prev.facts).length:0,nf=item.facts&&typeof item.facts==="object"?Object.keys(item.facts).length:0;
    if(of>0&&nf===0)problems.push(`${id.slice(0,8)}:facts:would-be-empty`);
  }
  if(problems.length)throw new Error(`Immowelt snapshot rejected: destructive/inconsistent changes (${problems.slice(0,12).join(", ")}${problems.length>12?", …":""})`);
  return {checked};
}

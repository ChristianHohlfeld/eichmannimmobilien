/**
 * Content-addressed media store for Immowelt pictures.
 *
 *   originals   <immowelt>/originals/<sha256>                      (not public, kept as archive)
 *   public      <media>/immowelt/<aa>/<sha256>-g.jpg|.webp         gallery picture, 800×600 cover
 *                                              -fp.jpg|.webp        floor plan, max 1200×1200, uncropped
 *                                              -g-og.jpg|.webp      share picture 1200×630 (first picture only)
 *
 * File names are derived from the picture's BYTES. A replaced picture therefore always gets
 * a new URL (browser caches cannot serve the old one), the same picture is stored once, and
 * new files never touch what the live site is showing. Nothing is deleted here; see gcMedia().
 *
 * Every picture of every offer must be available, otherwise the run fails as a whole –
 * a half-filled gallery is never published.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { ImmoweltError } from "./soap.mjs";
import { hostAllowed } from "./validate.mjs";
import { contentHash } from "./normalize.mjs";

export const PUBLIC_PREFIX = "media/immowelt";
const PROFILES = {
  g: { width: 800, height: 600, fit: "cover" },
  fp: { width: 1200, height: 1200, fit: "inside" },
  "g-og": { width: 1200, height: 630, fit: "cover" },
};

function sniffImage(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString("latin1"))) return "gif";
  if (buf.length >= 12 && buf.subarray(4, 8).toString("latin1") === "ftyp" && /avif|heic|mif1/.test(buf.subarray(8, 12).toString("latin1"))) return "avif";
  return null;
}

/** Production image processor (sharp). Kept behind an interface so tests need no native module. */
export async function sharpProcessor() {
  let sharp;
  try {
    sharp = (await import("sharp")).default;
  } catch {
    throw new ImmoweltError("media_processor_missing", "Bildverarbeitung (sharp) ist auf dem Server nicht installiert.");
  }
  return {
    name: "sharp",
    async probe(file) {
      const meta = await sharp(file).metadata();
      if (!meta.width || !meta.height) throw new Error("no dimensions");
      return { width: meta.width, height: meta.height, format: meta.format };
    },
    async derive(file, destBase, profile) {
      const p = PROFILES[profile];
      const pipeline = sharp(file).rotate().resize({ width: p.width, height: p.height, fit: p.fit, position: "centre", withoutEnlargement: p.fit === "inside" });
      await pipeline.clone().jpeg({ quality: profile === "g-og" ? 85 : 82, mozjpeg: true }).toFile(`${destBase}.jpg.tmp`);
      await pipeline.clone().webp({ quality: profile === "g-og" ? 80 : 78 }).toFile(`${destBase}.webp.tmp`);
    },
  };
}

/** Test-only processor: no decoding, copies the bytes. Refused outside NODE_ENV=test. */
export function copyProcessor() {
  if (process.env.NODE_ENV !== "test") throw new ImmoweltError("media_processor_missing", "Der Kopier-Prozessor ist nur für Tests zugelassen.");
  return {
    name: "copy",
    async probe() {
      return { width: 640, height: 480, format: "jpeg" };
    },
    async derive(file, destBase) {
      await fsp.copyFile(file, `${destBase}.jpg.tmp`);
      await fsp.copyFile(file, `${destBase}.webp.tmp`);
    },
  };
}

function loadIndex(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return data && typeof data.assets === "object" ? data : { assets: {} };
  } catch {
    return { assets: {} };
  }
}

async function writeAtomic(file, data, mode = 0o644) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await fsp.writeFile(tmp, data, { mode });
  await fsp.rename(tmp, file);
}

const exists = (p) => fsp.access(p).then(() => true, () => false);

async function download(url, { fetchImpl, timeoutMs, maxBytes, headers = {}, retries = 2 }) {
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, process.env.NODE_ENV === "test" ? 1 : 800 * 3 ** (attempt - 1)));
    try {
      const res = await fetchImpl(url, { headers: { Accept: "image/*", "User-Agent": "EichmannImmobilienSync/2 (+https://immobilieneichmann.de)", ...headers }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 304) return { notModified: true };
      if (res.status >= 500 || res.status === 429) {
        last = new ImmoweltError("media_download", `Bildserver antwortete mit HTTP ${res.status}.`);
        continue;
      }
      if (!res.ok) throw new ImmoweltError("media_download", `Bild nicht abrufbar (HTTP ${res.status}).`, { final: true });
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw new ImmoweltError("media_download", "Bild ist leer.", { final: true });
      if (buf.length > maxBytes) throw new ImmoweltError("media_download", "Bild überschreitet die Größenbegrenzung.", { final: true });
      return { buf, etag: res.headers.get("etag"), lastModified: res.headers.get("last-modified") };
    } catch (err) {
      if (err instanceof ImmoweltError && err.final) throw err;
      last = err instanceof ImmoweltError ? err : new ImmoweltError("media_download", `Bild nicht abrufbar (${err?.name === "TimeoutError" || err?.name === "AbortError" ? "Zeitüberschreitung" : "Netzwerkfehler"}).`);
    }
  }
  throw last;
}

/** Optional larger rendition: replace the trailing "<w>x<h>" of the delivered URL. Undocumented → verified, with fallback. */
function sizedUrl(url, size) {
  return size && /\/\d+x\d+\/?$/.test(url) ? url.replace(/\/\d+x\d+\/?$/, `/${size}`) : null;
}

/**
 * Make every picture of the snapshot available locally and fill image_base / gallery_bases /
 * floor_plan_bases / content_hash on each listing (mutates snapshot.listings).
 */
export async function ensureMedia(snapshot, config, { fetchImpl = globalThis.fetch, processor = null, now = new Date(), log = () => {} } = {}) {
  const proc = processor || (await sharpProcessor());
  const publicDir = path.join(config.mediaDir, "immowelt");
  await fsp.mkdir(publicDir, { recursive: true });
  await fsp.mkdir(config.originalsDir, { recursive: true });
  const index = loadIndex(config.mediaIndexFile);
  const stats = { pictures: 0, downloaded: 0, revalidated: 0, reused: 0, derived: 0, larger_variant: 0, larger_variant_fallback: 0, bytes: 0 };
  const jobs = [];
  for (const L of snapshot.listings) {
    const firstPhoto = L.media.find((m) => m.role === "photo") || L.media[0] || null;
    for (const m of L.media) jobs.push({ L, m, og: m === firstPhoto });
  }
  stats.pictures = jobs.length;

  const fetchOriginal = async (m) => {
    if (!hostAllowed(m.url, config.allowedImageHosts)) throw new ImmoweltError("media_host", "Bild liegt auf einem nicht zugelassenen Host.");
    const entry = index.assets[m.asset_key] || null;
    const haveOriginal = entry?.sha256 && (await exists(path.join(config.originalsDir, entry.sha256)));
    const ageH = entry?.checked_at ? (now.getTime() - Date.parse(entry.checked_at)) / 3_600_000 : Infinity;
    const wanted = sizedUrl(m.url, config.imageSize) || m.url;
    if (haveOriginal && entry.requested === wanted && ageH < config.imageRevalidateHours) {
      stats.reused++;
      return entry.sha256;
    }
    const conditional = haveOriginal && entry.requested === wanted ? { ...(entry.etag ? { "If-None-Match": entry.etag } : {}), ...(entry.last_modified ? { "If-Modified-Since": entry.last_modified } : {}) } : {};
    const dl = { fetchImpl, timeoutMs: config.imageTimeoutMs, maxBytes: config.imageMaxBytes };
    let got = null;
    let used = wanted;
    if (wanted !== m.url) {
      try {
        got = await download(wanted, { ...dl, headers: conditional, retries: 1 });
        if (got.buf && !sniffImage(got.buf)) got = null;
        if (got) stats.larger_variant++;
      } catch {
        got = null;
      }
      if (!got) {
        stats.larger_variant_fallback++;
        used = m.url;
      }
    }
    if (!got) got = await download(used, { ...dl, headers: used === wanted ? conditional : {} });
    if (got.notModified) {
      index.assets[m.asset_key] = { ...entry, checked_at: now.toISOString() };
      stats.revalidated++;
      return entry.sha256;
    }
    const kind = sniffImage(got.buf);
    if (!kind) throw new ImmoweltError("media_invalid", "Gelieferte Datei ist kein Bild.");
    const sha = createHash("sha256").update(got.buf).digest("hex");
    const original = path.join(config.originalsDir, sha);
    if (!(await exists(original))) await writeAtomic(original, got.buf, 0o640);
    try {
      await proc.probe(original);
    } catch {
      throw new ImmoweltError("media_invalid", "Bild lässt sich nicht dekodieren.");
    }
    index.assets[m.asset_key] = { sha256: sha, requested: used === wanted ? wanted : m.url, source_url: used, etag: got.etag || null, last_modified: got.lastModified || null, bytes: got.buf.length, format: kind, fetched_at: now.toISOString(), checked_at: now.toISOString() };
    stats.downloaded++;
    stats.bytes += got.buf.length;
    return sha;
  };

  const derive = async (sha, profile) => {
    const dir = path.join(publicDir, sha.slice(0, 2));
    const base = path.join(dir, `${sha}-${profile}`);
    if ((await exists(`${base}.jpg`)) && (await exists(`${base}.webp`))) return;
    await fsp.mkdir(dir, { recursive: true });
    try {
      await proc.derive(path.join(config.originalsDir, sha), base, profile);
      await fsp.rename(`${base}.jpg.tmp`, `${base}.jpg`);
      await fsp.rename(`${base}.webp.tmp`, `${base}.webp`);
      await fsp.chmod(`${base}.jpg`, 0o644);
      await fsp.chmod(`${base}.webp`, 0o644);
    } catch (err) {
      await fsp.rm(`${base}.jpg.tmp`, { force: true });
      await fsp.rm(`${base}.webp.tmp`, { force: true });
      throw new ImmoweltError("media_invalid", `Bild lässt sich nicht verarbeiten (${err?.code || err?.name || "Fehler"}).`);
    }
    stats.derived++;
  };

  // The same upload can appear in several offers (project pictures): do each piece of work once.
  const originals = new Map();
  const renditions = new Map();
  const once = (map, key, fn) => {
    if (!map.has(key)) map.set(key, fn());
    return map.get(key);
  };
  let cursor = 0;
  let firstError = null;
  const worker = async () => {
    while (cursor < jobs.length && !firstError) {
      const job = jobs[cursor++];
      try {
        const sha = await once(originals, job.m.asset_key, () => fetchOriginal(job.m));
        const profile = job.m.role === "floorplan" ? "fp" : "g";
        await once(renditions, `${sha}:${profile}`, () => derive(sha, profile));
        if (job.og && profile === "g") await once(renditions, `${sha}:g-og`, () => derive(sha, "g-og"));
        job.m.sha256 = sha;
        job.m.base = `${PUBLIC_PREFIX}/${sha.slice(0, 2)}/${sha}-${profile}`;
      } catch (err) {
        const e = err instanceof ImmoweltError ? err : new ImmoweltError("media_failed", "Bildverarbeitung fehlgeschlagen.");
        e.message = `Angebot ${job.L.immowelt_online_id}, Bild ${job.m.index + 1}: ${e.message}`;
        e.onlineId = job.L.immowelt_online_id;
        firstError = firstError || e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(config.imageConcurrency, Math.max(1, jobs.length)) }, worker));
  // Persist what was learned even when one picture failed: the next run starts from there.
  await writeAtomic(config.mediaIndexFile, `${JSON.stringify(index)}\n`, 0o640);
  if (firstError) throw firstError;

  // documents of the offers (PDF or picture): stored unchanged under a content-derived name
  for (const L of snapshot.listings) {
    for (const d of L.documents || []) {
      try {
        if (!hostAllowed(d.url, config.allowedImageHosts)) throw new ImmoweltError("media_host", "Dokument liegt auf einem nicht zugelassenen Host.");
        const key = `doc:${d.asset_key}`;
        const entry = index.assets[key] || null;
        const fresh = entry?.file && (await exists(path.join(config.mediaDir, entry.file.replace(`${PUBLIC_PREFIX}/`, "immowelt/")))) && (now.getTime() - Date.parse(entry.checked_at)) / 3_600_000 < config.imageRevalidateHours;
        if (!fresh) {
          const got = await download(d.url, { fetchImpl, timeoutMs: config.imageTimeoutMs, maxBytes: config.imageMaxBytes });
          const kind = got.buf.subarray(0, 5).toString("latin1") === "%PDF-" ? "pdf" : sniffImage(got.buf);
          if (!kind) throw new ImmoweltError("media_invalid", "Dokument ist weder PDF noch Bild.");
          const sha = createHash("sha256").update(got.buf).digest("hex");
          const ext = kind === "jpeg" ? "jpg" : kind;
          const dir = path.join(publicDir, sha.slice(0, 2));
          await fsp.mkdir(dir, { recursive: true });
          const file = path.join(dir, `${sha}-doc.${ext}`);
          if (!(await exists(file))) await writeAtomic(file, got.buf, 0o644);
          index.assets[key] = { sha256: sha, kind, bytes: got.buf.length, file: `${PUBLIC_PREFIX}/${sha.slice(0, 2)}/${sha}-doc.${ext}`, checked_at: now.toISOString() };
          stats.downloaded++;
        }
        const e = index.assets[key];
        Object.assign(d, { sha256: e.sha256, kind: e.kind, bytes: e.bytes, file: e.file });
      } catch (err) {
        await writeAtomic(config.mediaIndexFile, `${JSON.stringify(index)}\n`, 0o640);
        const e = err instanceof ImmoweltError ? err : new ImmoweltError("media_failed", "Dokument konnte nicht übernommen werden.");
        e.message = `Angebot ${L.immowelt_online_id}, Dokument ${d.index + 1}: ${e.message}`;
        throw e;
      }
    }
  }
  await writeAtomic(config.mediaIndexFile, `${JSON.stringify(index)}\n`, 0o640);

  for (const L of snapshot.listings) {
    const photos = L.media.filter((m) => m.role === "photo");
    const plans = L.media.filter((m) => m.role === "floorplan");
    // identical bytes delivered twice within one offer are shown once (first position wins)
    L.gallery_bases = [...new Set(photos.map((m) => m.base))];
    L.floor_plan_bases = [...new Set(plans.map((m) => m.base))];
    // Lead picture = first photo. An offer that only has plans shows the placeholder on cards.
    L.image_base = photos[0]?.base || null;
    L.content_hash = contentHash(L);
  }
  log(`Bilder: ${stats.pictures} gesamt, ${stats.downloaded} geladen, ${stats.revalidated} unverändert bestätigt, ${stats.reused} aus Bestand.`);
  // The API delivers pictures up to 640 px. Whether the optional larger variant was really served is said here, not assumed.
  if (config.imageSize && stats.larger_variant + stats.larger_variant_fallback > 0) {
    log(`Bildgröße ${config.imageSize}: ${stats.larger_variant} Bild(er) in dieser Größe geliefert, ${stats.larger_variant_fallback} nicht verfügbar → dafür die von der API gelieferte Größe.`);
  }
  return stats;
}

/** All public files (relative to the site root) a listings document needs. */
export function mediaFilesOf(listings) {
  const out = new Set();
  for (const L of listings || []) {
    for (const base of [...(L.gallery_bases || []), ...(L.floor_plan_bases || [])]) {
      if (typeof base !== "string" || !base.startsWith(`${PUBLIC_PREFIX}/`)) continue;
      out.add(`${base}.jpg`);
      out.add(`${base}.webp`);
    }
    for (const d of L.documents || []) if (typeof d.file === "string" && d.file.startsWith(`${PUBLIC_PREFIX}/`)) out.add(d.file);
    if (typeof L.image_base === "string" && L.image_base.startsWith(`${PUBLIC_PREFIX}/`)) {
      out.add(`${L.image_base}-og.jpg`);
      out.add(`${L.image_base}-og.webp`);
    }
  }
  return out;
}

/**
 * Remove public renditions that no retained release references. Originals stay (archive);
 * a rendition can always be rebuilt from its original.
 * @param {Set<string>} keep  relative paths as returned by mediaFilesOf()
 */
export async function gcMedia(config, keep, { minAgeMinutes = 60, now = Date.now() } = {}) {
  const root = path.join(config.mediaDir, "immowelt");
  let removed = 0;
  let dirs = [];
  try {
    dirs = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return { removed };
  }
  for (const d of dirs) {
    if (!d.isDirectory() || !/^[0-9a-f]{2}$/.test(d.name)) continue;
    for (const f of await fsp.readdir(path.join(root, d.name))) {
      const rel = `${PUBLIC_PREFIX}/${d.name}/${f}`;
      if (keep.has(rel)) continue;
      const full = path.join(root, d.name, f);
      const st = await fsp.stat(full).catch(() => null);
      if (!st || (now - st.mtimeMs) / 60000 < minAgeMinutes) continue;
      await fsp.rm(full, { force: true });
      removed++;
    }
  }
  return { removed };
}

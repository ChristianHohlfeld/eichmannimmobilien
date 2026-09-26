/**
 * Eigen listing image storage on the droplet (NOT in git).
 *
 * Layout:  <siteRoot>/media/eigen/<listing-id>/<nn>.jpg|.webp
 * Public:  /media/eigen/<listing-id>/<nn>.jpg
 *
 * gallery_bases / image_base store path stems like "media/eigen/<id>/01"
 * (contain "/") so Immowelt pictureTag can resolve them via assetRelPath().
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export const EIGEN_MEDIA_ROOT = "media/eigen";
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MiB per file
export const MAX_IMAGES_PER_LISTING = 40;
export const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);
export const ALLOWED_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);

/** Immowelt NN-xxxxxxxx OR path-style media/eigen/... */
export function assetRelPath(base) {
  const b = String(base || "").replace(/^\/+/, "").replace(/\\/g, "/");
  if (!b) return null;
  if (b.includes("/")) return b;
  return `assets/listings/${b}`;
}

export function publicUrlForBase(base, { origin = "" } = {}) {
  const rel = assetRelPath(base);
  if (!rel) return null;
  const pathUrl = `/${rel}.jpg`;
  return origin ? `${origin.replace(/\/$/, "")}${pathUrl}` : pathUrl;
}

export function listingMediaDir(siteRoot, listingId) {
  const id = sanitizeListingId(listingId);
  return path.join(siteRoot, EIGEN_MEDIA_ROOT, id);
}

export function sanitizeListingId(id) {
  const s = String(id || "").trim();
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(s)) {
    const err = new Error("Ungültige Listing-ID für Bildupload");
    err.status = 400;
    throw err;
  }
  return s;
}

export function detectImageType(buf, filename = "") {
  const ext = path.extname(String(filename || "")).toLowerCase();
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: "image/jpeg", ext: ".jpg" };
  }
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return { mime: "image/png", ext: ".png" };
  }
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return { mime: "image/webp", ext: ".webp" };
  }
  if (ALLOWED_EXT.has(ext)) {
    if (ext === ".jpeg" || ext === ".jpg") return { mime: "image/jpeg", ext: ".jpg" };
    if (ext === ".png") return { mime: "image/png", ext: ".png" };
    if (ext === ".webp") return { mime: "image/webp", ext: ".webp" };
  }
  return null;
}

function nextStem(existingBases, listingId) {
  const id = sanitizeListingId(listingId);
  const prefix = `${EIGEN_MEDIA_ROOT}/${id}/`;
  let max = 0;
  for (const b of existingBases || []) {
    const s = String(b || "");
    if (!s.startsWith(prefix)) continue;
    const n = Number(s.slice(prefix.length));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return String(max + 1).padStart(2, "0");
}

export function galleryBaseFor(listingId, stem) {
  return `${EIGEN_MEDIA_ROOT}/${sanitizeListingId(listingId)}/${stem}`;
}

async function convertToJpgWebp(srcBuf, destBasePath) {
  let sharp;
  try {
    sharp = (await import("sharp")).default;
  } catch {
    // Fallback: write raw buffer as .jpg only
    await fsp.writeFile(`${destBasePath}.jpg`, srcBuf);
    return;
  }
  const pipeline = sharp(srcBuf).rotate().resize({
    width: 1920,
    height: 1440,
    fit: "inside",
    withoutEnlargement: true,
  });
  await pipeline.clone().jpeg({ quality: 85, mozjpeg: true }).toFile(`${destBasePath}.jpg`);
  await pipeline.clone().webp({ quality: 80 }).toFile(`${destBasePath}.webp`);
}

/**
 * Write one uploaded image for an Eigen listing.
 * @returns {{ base: string, url: string, stem: string }}
 */
export async function storeEigenImage(siteRoot, listingId, buffer, { filename = "", existingBases = [] } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    const err = new Error("Leere Datei");
    err.status = 400;
    throw err;
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    const err = new Error(`Bild zu groß (max ${MAX_IMAGE_BYTES / 1024 / 1024} MB)`);
    err.status = 413;
    throw err;
  }
  const kind = detectImageType(buffer, filename);
  if (!kind || !ALLOWED_MIME.has(kind.mime)) {
    const err = new Error("Nur JPEG, PNG oder WebP erlaubt");
    err.status = 400;
    throw err;
  }
  if ((existingBases || []).length >= MAX_IMAGES_PER_LISTING) {
    const err = new Error(`Maximal ${MAX_IMAGES_PER_LISTING} Bilder pro Inserat`);
    err.status = 400;
    throw err;
  }

  const id = sanitizeListingId(listingId);
  const stem = nextStem(existingBases, id);
  const dir = listingMediaDir(siteRoot, id);
  await fsp.mkdir(dir, { recursive: true });
  const destBase = path.join(dir, stem);
  await convertToJpgWebp(buffer, destBase);

  const base = galleryBaseFor(id, stem);
  return {
    base,
    stem,
    url: publicUrlForBase(base),
  };
}

/** Apply ordered gallery bases onto listing image fields (Immowelt-compatible). */
export function applyGalleryToListing(listing, bases) {
  const ordered = (bases || []).filter(Boolean);
  const images = ordered.map((b) => publicUrlForBase(b));
  listing.gallery_bases = ordered;
  listing.image_base = ordered[0] || null;
  listing.images = images;
  listing.main_image_url = images[0] || null;
  return listing;
}

export async function removeEigenImageFiles(siteRoot, base) {
  const rel = assetRelPath(base);
  if (!rel || !rel.startsWith(`${EIGEN_MEDIA_ROOT}/`)) return;
  const abs = path.join(siteRoot, rel);
  await fsp.unlink(`${abs}.jpg`).catch(() => {});
  await fsp.unlink(`${abs}.webp`).catch(() => {});
  await fsp.unlink(`${abs}.png`).catch(() => {});
}

export async function removeAllEigenMedia(siteRoot, listingId) {
  const dir = listingMediaDir(siteRoot, listingId);
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
}

/**
 * Minimal multipart/form-data parser for file uploads.
 * Returns { fields: Record<string,string>, files: Array<{field,filename,mime,buffer}> }
 */
export async function parseMultipart(req, { maxTotalBytes = 40 * 1024 * 1024 } = {}) {
  const ct = String(req.headers["content-type"] || "");
  const m = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!m) {
    const err = new Error("multipart boundary fehlt");
    err.status = 400;
    throw err;
  }
  const boundary = m[1] || m[2];
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxTotalBytes) {
      const err = new Error("Upload zu groß");
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  const buf = Buffer.concat(chunks);
  const boundaryBuf = Buffer.from(`--${boundary}`);
  const fields = {};
  const files = [];

  let start = buf.indexOf(boundaryBuf);
  while (start !== -1) {
    let partStart = start + boundaryBuf.length;
    if (buf[partStart] === 0x2d && buf[partStart + 1] === 0x2d) break; // --
    if (buf[partStart] === 0x0d && buf[partStart + 1] === 0x0a) partStart += 2;

    const next = buf.indexOf(boundaryBuf, partStart);
    if (next === -1) break;
    let partEnd = next - 2; // strip \r\n before boundary
    if (partEnd < partStart) partEnd = next;

    const part = buf.subarray(partStart, partEnd);
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      start = next;
      continue;
    }
    const headerText = part.subarray(0, headerEnd).toString("utf8");
    const body = part.subarray(headerEnd + 4);
    const nameMatch = headerText.match(/name="([^"]+)"/i);
    const fileMatch = headerText.match(/filename="([^"]*)"/i);
    const mimeMatch = headerText.match(/Content-Type:\s*([^\r\n]+)/i);
    const name = nameMatch ? nameMatch[1] : null;
    if (!name) {
      start = next;
      continue;
    }
    if (fileMatch) {
      files.push({
        field: name,
        filename: fileMatch[1] || "upload.bin",
        mime: mimeMatch ? mimeMatch[1].trim() : "",
        buffer: body,
      });
    } else {
      fields[name] = body.toString("utf8");
    }
    start = next;
  }

  return { fields, files };
}

export function randomUploadToken() {
  return crypto.randomBytes(8).toString("hex");
}

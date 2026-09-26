/**
 * DigitalOcean droplet snapshots for eichmann-web (list-only in Admin).
 * Token is read from a server-side file — never exposed to the browser or git.
 *
 * Restore is intentionally NOT done via API by default: use DO Console rebuild.
 */
import fs from "node:fs";

export const DO_TOKEN_FILE =
  process.env.DO_TOKEN_FILE || "/var/lib/eichmann/secrets/do-api-token";
export const DROPLET_NAME = process.env.DROPLET_NAME || "eichmann-web";
export const DROPLET_IP = process.env.DROPLET_IP || "46.101.163.236";
const API = "https://api.digitalocean.com/v2";

function structuredError(code, message, status = 503) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  err.public = true;
  return err;
}

export function readDoToken() {
  try {
    if (!fs.existsSync(DO_TOKEN_FILE)) {
      throw structuredError(
        "do_token_missing",
        "DigitalOcean-Zugang fehlt auf dem Server (Token-Datei nicht gefunden). Bitte den Administrator informieren — der Token liegt nur serverseitig und nie im Browser.",
        503
      );
    }
    const token = fs.readFileSync(DO_TOKEN_FILE, "utf8").replace(/[\s\r\n\t]/g, "");
    if (!token) {
      throw structuredError(
        "do_token_empty",
        "DigitalOcean-Token-Datei ist leer. Bitte einen Personal Access Token mit Droplet-/Snapshot-Leserechten hinterlegen.",
        503
      );
    }
    return token;
  } catch (e) {
    if (e.public) throw e;
    throw structuredError(
      "do_token_unreadable",
      "DigitalOcean-Token konnte nicht gelesen werden. Bitte Dateirechte prüfen (nur root, Mode 600).",
      503
    );
  }
}

async function doFetch(token, path) {
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });
  } catch (e) {
    throw structuredError(
      "do_network",
      "Verbindung zur DigitalOcean-API fehlgeschlagen. Bitte später erneut versuchen.",
      502
    );
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (res.status === 401 || res.status === 403) {
    throw structuredError(
      "do_token_scope",
      "DigitalOcean-Token ungültig oder ohne Rechte für Snapshots. Bitte Token mit Lesezugriff auf Droplets/Images erneuern.",
      503
    );
  }
  if (!res.ok) {
    const msg =
      (data && (data.message || data.id)) ||
      `DigitalOcean-API Fehler (${res.status})`;
    throw structuredError("do_api_error", String(msg), res.status >= 500 ? 502 : 400);
  }
  return data;
}

export async function resolveDroplet(token) {
  const data = await doFetch(token, "/droplets?per_page=200");
  const droplets = data.droplets || [];
  for (const d of droplets) {
    const ips = (d.networks?.v4 || [])
      .filter((n) => n.type === "public")
      .map((n) => n.ip_address);
    if (d.name === DROPLET_NAME || ips.includes(DROPLET_IP)) {
      return {
        id: d.id,
        name: d.name,
        ip: ips[0] || DROPLET_IP,
        status: d.status,
        region: d.region?.slug || null,
      };
    }
  }
  throw structuredError(
    "do_droplet_not_found",
    `Droplet „${DROPLET_NAME}“ / ${DROPLET_IP} wurde in DigitalOcean nicht gefunden.`,
    404
  );
}

function consoleUrls(dropletId, snapshotId) {
  const rebuild =
    dropletId != null
      ? `https://cloud.digitalocean.com/droplets/${dropletId}/settings`
      : "https://cloud.digitalocean.com/droplets";
  const images =
    snapshotId != null
      ? `https://cloud.digitalocean.com/images?i=${encodeURIComponent(String(snapshotId))}`
      : "https://cloud.digitalocean.com/images";
  return {
    console_rebuild_url: rebuild,
    console_images_url: images,
    docs_rebuild_url: "https://docs.digitalocean.com/products/droplets/how-to/rebuild/",
  };
}

/**
 * List snapshots for the eichmann-web droplet.
 * Never returns the API token.
 */
export async function listDoSnapshots() {
  const token = readDoToken();
  const droplet = await resolveDroplet(token);
  const data = await doFetch(
    token,
    `/droplets/${droplet.id}/snapshots?per_page=200`
  );
  const snapshots = (data.snapshots || [])
    .map((s) => ({
      id: s.id,
      name: s.name,
      created_at: s.created_at || null,
      size_gigabytes: s.size_gigabytes ?? null,
      min_disk_size: s.min_disk_size ?? null,
      status: s.status || null,
      ...consoleUrls(droplet.id, s.id),
    }))
    .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));

  return {
    ok: true,
    droplet,
    snapshots,
    restore_preferred: "console",
    restore_steps_de: [
      "In der Tabelle auf „In DO-Konsole wiederherstellen“ klicken — es öffnet sich die DigitalOcean-Website (mit dem richtigen Server).",
      "Auf der Seite „Einstellungen“ wählen, danach „Rebuild“ (Server neu aufbauen).",
      `In der Liste den gewünschten Snapshot auswählen (Name beginnt oft mit „${DROPLET_NAME}“). Zur Bestätigung den Servernamen „${DROPLET_NAME}“ eintippen und auf Rebuild klicken.`,
      "Der Server ist währenddessen einige Minuten nicht erreichbar. Alles, was neuer ist als der Snapshot, geht verloren.",
      "Wenn die Website wieder läuft, sind Sie fertig — kein Terminal und keine Befehle nötig.",
    ],
    ...consoleUrls(droplet.id, snapshots[0]?.id),
  };
}

#!/usr/bin/env node
/**
 * Store the address of the "sign of life" check (healthcheck service) on the server.
 * STDIN only, never printed. File: /var/lib/eichmann/secrets/alarm.json (0600).
 *
 *   printf '%s' "$URL" | node scripts/alarm-install.mjs      store (keeps an existing webhook_url)
 *   node scripts/alarm-install.mjs --status                  what is configured (host only)
 *   node scripts/alarm-install.mjs --off                     stop sending (file stays)
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./lib/immowelt/config.mjs";

const file = loadConfig().alarmFile;
const read = () => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
const write = (cfg) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify({ ...cfg, updated_at: new Date().toISOString() })}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
};
const describe = (cfg) => {
  let host = null;
  try {
    host = cfg?.healthcheck_url ? new URL(cfg.healthcheck_url).host : null;
  } catch {}
  return { enabled: cfg?.enabled === true, has_healthcheck: Boolean(host), healthcheck_host: host, has_webhook: Boolean(cfg?.webhook_url) };
};

if (process.argv.includes("--status")) {
  console.log(JSON.stringify(describe(read())));
  process.exit(0);
}
if (process.argv.includes("--off")) {
  const cfg = read();
  if (cfg) write({ ...cfg, enabled: false });
  console.log(JSON.stringify(describe(read())));
  process.exit(0);
}
if (process.stdin.isTTY) {
  console.error("Die Adresse wird nur über STDIN angenommen (Pipe).");
  process.exit(2);
}
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const url = input.trim().replace(/\/+$/, "");
let parsed = null;
try {
  parsed = new URL(url);
} catch {}
if (!parsed || parsed.protocol !== "https:" || /\s/.test(url) || url.length > 300 || parsed.username || parsed.search || parsed.pathname.length < 9 || /\/(fail|start|log)$/.test(parsed.pathname)) {
  console.error("Nicht gespeichert: erwartet wird die Ping-Adresse der Prüfung (https://…/<Kennung>, ohne /fail am Ende).");
  process.exit(1);
}
const previous = read() || {};
write({ ...(previous.webhook_url ? { webhook_url: previous.webhook_url } : {}), enabled: true, healthcheck_url: url });
console.log(JSON.stringify(describe(read())));

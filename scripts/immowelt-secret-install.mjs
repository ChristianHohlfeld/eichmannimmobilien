#!/usr/bin/env node
/**
 * Install the Immowelt API key on the droplet. The key is read from STDIN only –
 * never from an argument or an environment variable on the server, never echoed.
 *
 *   printf '%s' "$KEY" | node scripts/immowelt-secret-install.mjs [--kundennummer <Nummer>]
 *   node scripts/immowelt-secret-install.mjs --status        (present yes/no and date – nothing derived from the key)
 *
 * The output of this script ends up in CI logs of a public repository. It therefore prints no
 * part of the key (not even masked characters or its length) and no customer number.
 *
 * Target: /var/lib/eichmann/secrets/immowelt-api.json (0600, directory 0700), or the path in
 * IMMOWELT_SECRETS_FILE / EICHMANN_IMMOWELT_SECRETS_FILE (these two variables hold a PATH,
 * never the key).
 */
import { installImmoweltApiKey, getImmoweltCredentialsStatus, immoweltSecretsPath } from "./lib/immowelt-secrets.mjs";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

function printStatus(st) {
  console.log(JSON.stringify({ file: immoweltSecretsPath(), has_key: st.has_key, kundennummer_set: Boolean(st.kundennummer), updated_at: st.updated_at }));
}

if (args.includes("--status")) {
  printStatus(getImmoweltCredentialsStatus());
  process.exit(0);
}
if (process.stdin.isTTY) {
  console.error("Schlüssel wird nur über STDIN angenommen (Pipe). Siehe Kopfkommentar.");
  process.exit(2);
}
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 4096) {
    console.error("Eingabe zu lang.");
    process.exit(2);
  }
}
let apiKey = input.trim();
let kundennummer = opt("--kundennummer");
if (apiKey.startsWith("{")) {
  try {
    const obj = JSON.parse(apiKey);
    apiKey = String(obj.api_key || "").trim();
    kundennummer = kundennummer ?? obj.kundennummer ?? null;
  } catch {
    console.error("Eingabe ist kein gültiges JSON.");
    process.exit(2);
  }
}
try {
  printStatus(installImmoweltApiKey({ api_key: apiKey, ...(kundennummer ? { kundennummer } : {}) }));
} catch (err) {
  console.error(err.code === "api_key_invalid" ? err.message : `Schlüssel konnte nicht gespeichert werden (${err.code || err.name}).`);
  process.exit(1);
}

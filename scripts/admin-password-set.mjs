#!/usr/bin/env node
/**
 * Set the admin password on the server. The new password is read from STDIN only – never an
 * argument, never an environment variable on the server, never printed. Stored as before:
 * SHA-256 in /var/lib/eichmann/secrets/admin-auth.json (0600). Existing sessions end.
 *
 *   printf '%s' "$NEW" | node scripts/admin-password-set.mjs
 */
import { sha256Hex, savePasswordHash, adminAuthSecretsPath, MIN_PASSWORD_LENGTH } from "./lib/admin-password.mjs";

if (process.stdin.isTTY) {
  console.error("Passwort wird nur über STDIN angenommen (Pipe).");
  process.exit(2);
}
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 1024) {
    console.error("Eingabe zu lang.");
    process.exit(2);
  }
}
const password = input.replace(/\r?\n$/, "");
if (password.length < MIN_PASSWORD_LENGTH) {
  console.error(`Nicht gesetzt: Das Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen haben.`);
  process.exit(1);
}
savePasswordHash("", sha256Hex(password));
console.log(JSON.stringify({ ok: true, file: adminAuthSecretsPath(), updated_at: new Date().toISOString() }));

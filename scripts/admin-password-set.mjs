#!/usr/bin/env node
/**
 * Set the admin password on the server. The new password is read from STDIN only – never an
 * argument, never an environment variable on the server, never printed. Emergency reset: the password
 * then applies to every sign-in address until each person sets an own one (own passwords and open reset
 * links are dropped). Stored in /var/lib/eichmann/secrets/admin-auth.json (0600). Existing sessions end.
 *
 *   printf '%s' "$NEW" | node scripts/admin-password-set.mjs
 */
import { sha256Hex, adminAuthSecretsPath, MIN_PASSWORD_LENGTH } from "./lib/admin-password.mjs";
import { resetEveryoneToShared } from "./lib/admin-auth.mjs";

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
// Emergency reset: this one password then applies to everyone; own passwords and open reset links are dropped.
resetEveryoneToShared(sha256Hex(password));
console.log(JSON.stringify({ ok: true, file: adminAuthSecretsPath(), updated_at: new Date().toISOString() }));

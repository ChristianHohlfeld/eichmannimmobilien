#!/usr/bin/env node
/**
 * Mail sending for the admin area ("Passwort vergessen"). Settings come over STDIN only and are
 * never printed. File: /var/lib/eichmann/secrets/mail.json (0600).
 *
 *   printf '%s' 'smtps://BENUTZER:PASSWORT@server:465/?from=absender@domain' | node scripts/mail-install.mjs
 *   node scripts/mail-install.mjs --status     what is configured (server and sender only)
 *   node scripts/mail-install.mjs --test       send a short test message to every sign-in address
 */
import fs from "node:fs";
import path from "node:path";
import { mailConfigFile, parseMailSettings, readMailSettings, sendMail } from "./lib/smtp.mjs";
import { loadAdminEmails } from "./lib/admin-password.mjs";

const file = mailConfigFile();
const describe = (s) => (s ? { configured: true, server: `${s.host}:${s.port}`, encrypted: s.secure ? "TLS" : s.local ? "lokal" : "STARTTLS", from: s.from } : { configured: false });
const mask = (email) => email.replace(/^(.).*(@.*)$/, "$1…$2");

if (process.argv.includes("--status")) {
  console.log(JSON.stringify(describe(readMailSettings(file))));
  process.exit(0);
}
if (process.argv.includes("--test")) {
  const settings = readMailSettings(file);
  if (!settings) {
    console.error("Mailversand ist nicht eingerichtet.");
    process.exit(1);
  }
  const to = loadAdminEmails(process.env.EICHMANN_ADMIN_CONFIG || "");
  if (!to.length) {
    console.error("Es sind keine Anmelde-Adressen hinterlegt.");
    process.exit(1);
  }
  let failed = 0;
  for (const email of to) {
    try {
      await sendMail(settings, {
        to: email,
        subject: "Test: Mailversand der Website-Verwaltung",
        text: "Guten Tag,\n\ndies ist nur ein Test: Der Mailversand der Website-Verwaltung von Immobilien Eichmann funktioniert.\nSie müssen nichts tun.\n\nDiese Nachricht wurde automatisch verschickt.",
      });
      console.log(JSON.stringify({ to: mask(email), ok: true }));
    } catch (e) {
      failed++;
      console.log(JSON.stringify({ to: mask(email), ok: false, error: e.message }));
    }
  }
  process.exit(failed ? 1 : 0);
}
if (process.stdin.isTTY) {
  console.error("Die Einstellung wird nur über STDIN angenommen (Pipe).");
  process.exit(2);
}
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
let settings;
try {
  settings = parseMailSettings(input.trim());
} catch (e) {
  console.error(`Nicht gespeichert: ${e.message}`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
const tmp = `${file}.tmp-${process.pid}`;
fs.writeFileSync(tmp, `${JSON.stringify({ url: input.trim(), updated_at: new Date().toISOString() })}\n`, { mode: 0o600 });
fs.renameSync(tmp, file);
console.log(JSON.stringify(describe(settings)));

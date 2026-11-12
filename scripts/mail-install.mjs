#!/usr/bin/env node
/**
 * Mail sending for the admin area ("Passwort vergessen"). File: /var/lib/eichmann/secrets/mail.json (0600).
 *
 * Usual way – through the form gateway that already delivers the website's inquiries; no mail password here:
 *   node scripts/mail-install.mjs --key          create this server's signing key (once), print the public half
 *   node scripts/mail-install.mjs --gateway-on   ask the gateway whether it accepts this server; only then switch on
 * Other way – directly through a mailbox; the setting comes over STDIN only and is never printed:
 *   printf '%s' 'smtps://BENUTZER:PASSWORT@server:465/?from=absender@domain' | node scripts/mail-install.mjs
 *
 *   node scripts/mail-install.mjs --status       what is set up (no secrets)
 *   node scripts/mail-install.mjs --test         send a short test message to every sign-in address
 */
import fs from "node:fs";
import path from "node:path";
import { mailConfigFile, parseMailSettings } from "./lib/smtp.mjs";
import { readMailer } from "./lib/mailer.mjs";
import { ensureGatewayKey, gatewayKeyFile, gatewayPing, gatewayPublicKey, hasGatewayKey, parseGatewayUrl } from "./lib/mail-gateway.mjs";
import { loadAdminEmails } from "./lib/admin-password.mjs";

const file = mailConfigFile();
const describe = (s) => ({ configured: true, way: "Postfach (SMTP)", server: `${s.host}:${s.port}`, encrypted: s.secure ? "TLS" : s.local ? "lokal" : "STARTTLS", from: s.from });
const mask = (email) => email.replace(/^(.).*(@.*)$/, "$1…$2");
const save = (content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify({ ...content, updated_at: new Date().toISOString() })}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
};

if (process.argv.includes("--status")) {
  console.log(JSON.stringify(readMailer(file)?.describe || { configured: false, signing_key: hasGatewayKey() ? "vorhanden" : "fehlt" }));
  process.exit(0);
}
if (process.argv.includes("--key")) {
  const created = ensureGatewayKey();
  // the public half is not a secret: it only lets the gateway recognise this server
  console.log(JSON.stringify({ signing_key: created ? "neu angelegt" : "war schon da", public_key: gatewayPublicKey() }));
  process.exit(0);
}
if (process.argv.includes("--gateway-on")) {
  let url;
  try {
    url = parseGatewayUrl(process.env.EICHMANN_MAIL_GATEWAY_URL || "");
  } catch (e) {
    console.error(`Nicht eingeschaltet: ${e.message}`);
    process.exit(1);
  }
  ensureGatewayKey();
  try {
    // sends no mail: the gateway only checks the signature
    await gatewayPing({ url, keyFile: gatewayKeyFile() });
  } catch (e) {
    console.error(`Nicht eingeschaltet – nichts geändert: ${e.message}.`);
    process.exit(1);
  }
  save({ transport: "gateway", url });
  console.log(JSON.stringify(readMailer(file).describe));
  process.exit(0);
}
if (process.argv.includes("--test")) {
  const mailer = readMailer(file);
  if (!mailer) {
    console.error("Mailversand ist nicht eingerichtet.");
    process.exit(1);
  }
  // one test message per mailbox, even if a person may sign in with two spellings of the same address
  const to = [...new Map(loadAdminEmails(process.env.EICHMANN_ADMIN_CONFIG || "").map((e) => [mailer.deliveryAddress(e), e])).values()];
  if (!to.length) {
    console.error("Es sind keine Anmelde-Adressen hinterlegt.");
    process.exit(1);
  }
  let failed = 0;
  for (const email of to) {
    try {
      await mailer.sendTest({ to: email });
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
save({ url: input.trim() });
console.log(JSON.stringify(describe(settings)));

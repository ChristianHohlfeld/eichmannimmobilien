#!/usr/bin/env node
/**
 * Retire the shared admin password (the one every sign-in address accepted before each person had an own
 * one). Afterwards only own passwords work; whoever has none yet clicks "Passwort vergessen?" on the
 * sign-in page. Refuses while no mail way is switched on – otherwise nobody without an own password could
 * get back in. Undo in an emergency: admin-password-set.
 *
 *   node scripts/admin-shared-password-off.mjs            switch off
 *   node scripts/admin-shared-password-off.mjs --status   is the shared password still accepted?
 */
import { dropSharedPassword, sharedPasswordActive } from "./lib/admin-auth.mjs";
import { loadAdminEmails } from "./lib/admin-password.mjs";
import { readMailer } from "./lib/mailer.mjs";

const configPath = process.env.EICHMANN_ADMIN_CONFIG || "";
if (process.argv.includes("--status")) {
  console.log(JSON.stringify({ shared_password: sharedPasswordActive(configPath) ? "wird noch angenommen" : "abgeschaltet", mail: readMailer() ? "eingerichtet" : "nicht eingerichtet" }));
  process.exit(0);
}
if (!readMailer()) {
  console.error("Nicht abgeschaltet – nichts geändert: Der Mailversand für „Passwort vergessen?“ ist noch nicht eingeschaltet. Ohne ihn käme niemand ohne eigenes Passwort mehr hinein.");
  process.exit(1);
}
const { own_passwords } = dropSharedPassword();
console.log(JSON.stringify({ ok: true, shared_password: "abgeschaltet", sign_in_addresses: loadAdminEmails(configPath).length, with_own_password: own_passwords, next: "Wer noch kein eigenes Passwort hat: auf der Anmeldeseite „Passwort vergessen?“." }));

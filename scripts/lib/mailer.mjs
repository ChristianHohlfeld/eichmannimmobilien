/**
 * The admin area's outgoing mail, whichever way is set up in /var/lib/eichmann/secrets/mail.json:
 *
 *   { "transport": "gateway", "url": "https://forms.…/v1/immobilieneichmann/admin-reset" }
 *       through the form gateway that already delivers the website's inquiries (see mail-gateway.mjs)
 *   { "url": "smtps://USER:PASS@host:465", "from": "absender@domain" }
 *       directly through a mailbox (see smtp.mjs)
 *
 * Nothing set up → null, and the sign-in page says so instead of promising a mail.
 */
import fs from "node:fs";
import { mailConfigFile, parseMailSettings, sendMail } from "./smtp.mjs";
import { gatewayKeyFile, gatewayResetMail, gatewayTestMail, hasGatewayKey, parseGatewayUrl } from "./mail-gateway.mjs";

export const RESET_SUBJECT = "Neues Passwort für Ihre Website-Verwaltung";
export const TEST_SUBJECT = "Test: Mailversand der Website-Verwaltung";

export function resetMailText(link, minutes) {
  return [
    "Guten Tag,",
    "",
    "für die Website-Verwaltung von Immobilien Eichmann wurde ein neues Passwort angefordert.",
    "",
    "Mit diesem Link legen Sie Ihr neues Passwort fest:",
    link,
    "",
    `Der Link gilt ${minutes} Minuten und funktioniert nur einmal.`,
    "",
    "Sie haben das nicht angefordert? Dann müssen Sie nichts tun – Ihr Passwort bleibt, wie es ist.",
    "",
    "Diese Nachricht wurde automatisch verschickt. Bitte antworten Sie nicht darauf.",
  ].join("\n");
}

export const TEST_TEXT =
  "Guten Tag,\n\ndies ist nur ein Test: Der Mailversand der Website-Verwaltung von Immobilien Eichmann funktioniert.\nSie müssen nichts tun.\n\nDiese Nachricht wurde automatisch verschickt.";

export function readMailer(file = mailConfigFile()) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (raw?.transport === "gateway") {
    let url;
    try {
      url = parseGatewayUrl(raw.url);
    } catch {
      return null;
    }
    const keyFile = gatewayKeyFile();
    if (!hasGatewayKey(keyFile)) return null;
    const settings = { url, keyFile };
    // googlemail.com and gmail.com are one and the same mailbox; the gateway lists the gmail.com spelling
    const deliveryAddress = (email) => String(email).trim().toLowerCase().replace(/@googlemail\.com$/, "@gmail.com");
    return {
      kind: "gateway",
      deliveryAddress,
      describe: { configured: true, way: "Formular-Gateway", server: new URL(url).host, encrypted: url.startsWith("https:") ? "TLS" : "lokal" },
      sendReset: ({ to, link, minutes }) => gatewayResetMail(settings, { to: deliveryAddress(to), link, minutes }),
      sendTest: ({ to }) => gatewayTestMail(settings, { to: deliveryAddress(to) }),
    };
  }
  let smtp;
  try {
    smtp = parseMailSettings(raw);
  } catch {
    return null;
  }
  return {
    kind: "smtp",
    deliveryAddress: (email) => String(email).trim().toLowerCase(),
    describe: { configured: true, way: "Postfach (SMTP)", server: `${smtp.host}:${smtp.port}`, encrypted: smtp.secure ? "TLS" : smtp.local ? "lokal" : "STARTTLS", from: smtp.from },
    sendReset: ({ to, link, minutes }) => sendMail(smtp, { to, subject: RESET_SUBJECT, text: resetMailText(link, minutes) }),
    sendTest: ({ to }) => sendMail(smtp, { to, subject: TEST_SUBJECT, text: TEST_TEXT }),
  };
}

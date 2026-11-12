/**
 * Send one plain-text e-mail over SMTP. No dependencies.
 *
 * Settings (server only, 0600): /var/lib/eichmann/secrets/mail.json
 *   { "url": "smtps://USER:PASS@host:465", "from": "absender@domain", "from_name": "…" }
 * smtps:// = TLS from the first byte (port 465); smtp:// = STARTTLS (port 587). Unencrypted only to a
 * mail server on this very machine (127.0.0.1/localhost), where user and password may be left out.
 * Works with Amazon SES SMTP credentials or any ordinary mailbox.
 *
 * Nothing here logs the password or the message body.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import crypto from "node:crypto";

export function mailConfigFile() {
  return process.env.EICHMANN_MAIL_FILE || path.join(process.env.EICHMANN_STATE_DIR || "/var/lib/eichmann", "secrets", "mail.json");
}

/** Parse and check settings. Throws with a message that names no secret. */
export function parseMailSettings(input) {
  const raw = typeof input === "string" ? { url: input } : input || {};
  let u;
  try {
    u = new URL(String(raw.url || ""));
  } catch {
    throw new Error("Mail-Einstellung ungültig: erwartet smtps://BENUTZER:PASSWORT@server:465/?from=absender@domain");
  }
  if (!["smtps:", "smtp:"].includes(u.protocol)) throw new Error("Mail-Einstellung ungültig: Adresse muss mit smtps:// oder smtp:// beginnen.");
  const from = String(raw.from || u.searchParams.get("from") || "").trim();
  if (!/^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(from)) throw new Error("Mail-Einstellung ungültig: Absender fehlt (…/?from=absender@domain).");
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (!u.hostname || (!local && (!u.username || !u.password))) throw new Error("Mail-Einstellung ungültig: Server, Benutzer oder Passwort fehlt.");
  const secure = u.protocol === "smtps:";
  return {
    host: u.hostname,
    port: Number(u.port || (secure ? 465 : 587)),
    secure,
    local,
    user: decodeURIComponent(u.username),
    pass: decodeURIComponent(u.password),
    from,
    fromName: String(raw.from_name || u.searchParams.get("name") || "Immobilien Eichmann – Website").replace(/[\r\n"<>]/g, ""),
    // only for tests against a local server with a self-signed certificate
    rejectUnauthorized: raw.reject_unauthorized !== false,
  };
}

export function readMailSettings(file = mailConfigFile()) {
  try {
    return parseMailSettings(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

const encodeHeader = (text) => (/^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`);

export function buildMessage({ from, fromName, to, subject, text, now = new Date(), host = "localhost" }) {
  const body = Buffer.from(String(text).replace(/\r?\n/g, "\r\n"), "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
  return [
    `From: ${encodeHeader(fromName)} <${from}>`,
    `To: <${to}>`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${now.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${crypto.randomBytes(16).toString("hex")}@${host}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "Auto-Submitted: auto-generated",
    "",
    body,
  ].join("\r\n");
}

/** One SMTP conversation. Resolves when the server has accepted the message, rejects otherwise. */
export function sendMail(settings, { to, subject, text }, { timeoutMs = 20_000 } = {}) {
  const s = settings;
  if (!/^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(String(to))) return Promise.reject(new Error("Empfänger ungültig"));
  return new Promise((resolve, reject) => {
    let socket = s.secure
      ? tls.connect({ host: s.host, port: s.port, servername: s.host, rejectUnauthorized: s.rejectUnauthorized })
      : net.connect({ host: s.host, port: s.port });
    let buffer = "";
    let waiting = null;
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      // never pass on what the server echoed (it can contain the address or credentials)
      reject(new Error(`Mailversand fehlgeschlagen (${err.smtpStep || err.code || err.name || "Fehler"})`));
    };
    const timer = setTimeout(() => fail(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })), timeoutMs);
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      // a reply is complete when its last line is "NNN text" (not "NNN-text")
      const lines = buffer.split("\r\n");
      if (lines.length < 2) return;
      const last = lines[lines.length - 2];
      if (!/^\d{3} /.test(last)) return;
      const reply = { code: Number(last.slice(0, 3)), text: buffer };
      buffer = "";
      const w = waiting;
      waiting = null;
      if (w) w(reply);
    };
    const attach = () => {
      socket.on("data", onData);
      socket.on("error", fail);
      socket.on("close", () => fail(Object.assign(new Error("closed"), { code: "ECONNCLOSED" })));
    };
    attach();
    const read = () => new Promise((r) => (waiting = r));
    const command = async (line, expect, step) => {
      if (line != null) socket.write(`${line}\r\n`);
      const reply = await read();
      if (!expect.includes(reply.code)) throw Object.assign(new Error("smtp"), { smtpStep: `${step} ${reply.code}` });
      return reply;
    };
    (async () => {
      await command(null, [220], "Begrüßung");
      let hello = await command("EHLO immobilieneichmann.de", [250], "EHLO");
      if (!s.secure && !/STARTTLS/i.test(hello.text) && !s.local) throw Object.assign(new Error("smtp"), { smtpStep: "kein STARTTLS" });
      if (!s.secure && /STARTTLS/i.test(hello.text)) {
        await command("STARTTLS", [220], "STARTTLS");
        socket.removeAllListeners("data");
        socket.removeAllListeners("error");
        socket.removeAllListeners("close");
        socket = tls.connect({ socket, servername: s.host, rejectUnauthorized: s.rejectUnauthorized });
        await new Promise((r, j) => (socket.once("secureConnect", r), socket.once("error", j)));
        attach();
        hello = await command("EHLO immobilieneichmann.de", [250], "EHLO");
      }
      if (s.user) await command(`AUTH PLAIN ${Buffer.from(`\0${s.user}\0${s.pass}`, "utf8").toString("base64")}`, [235], "Anmeldung");
      await command(`MAIL FROM:<${s.from}>`, [250], "Absender");
      await command(`RCPT TO:<${to}>`, [250, 251], "Empfänger");
      await command("DATA", [354], "DATA");
      await command(`${buildMessage({ from: s.from, fromName: s.fromName, to, subject, text, host: s.host })}\r\n.`, [250], "Nachricht");
      done = true;
      clearTimeout(timer);
      socket.write("QUIT\r\n");
      socket.end();
      resolve({ ok: true });
    })().catch(fail);
  });
}

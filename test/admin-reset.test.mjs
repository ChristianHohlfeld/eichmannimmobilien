// "Passwort vergessen": per-person passwords, reset link by e-mail, limits against flooding.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hasSqlite = await import("better-sqlite3").then(() => true, () => false);
const skip = hasSqlite ? false : "better-sqlite3 nicht installiert";
const tmpRoot = () => {
  const base = process.env.EICHMANN_TEST_TMP || os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, "reset-"));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });

/** Minimal SMTP server on this machine (plain, with AUTH PLAIN). */
function fakeSmtp() {
  const mails = [];
  const server = net.createServer((sock) => {
    let data = "", inData = false, mail = { to: [], raw: "" };
    sock.write("220 test ESMTP\r\n");
    sock.on("data", (chunk) => {
      data += chunk.toString("utf8");
      for (;;) {
        if (inData) {
          const end = data.indexOf("\r\n.\r\n");
          if (end < 0) return;
          mail.raw = data.slice(0, end);
          data = data.slice(end + 5);
          inData = false;
          mails.push(mail);
          mail = { to: [], raw: "" };
          sock.write("250 queued\r\n");
          continue;
        }
        const nl = data.indexOf("\r\n");
        if (nl < 0) return;
        const line = data.slice(0, nl);
        data = data.slice(nl + 2);
        if (/^EHLO/i.test(line)) sock.write("250-test\r\n250 AUTH PLAIN\r\n");
        else if (/^AUTH PLAIN /i.test(line)) { mail.auth = Buffer.from(line.slice(11), "base64").toString("utf8"); sock.write(mail.auth === "\0user\0pass" ? "235 ok\r\n" : "535 no\r\n"); }
        else if (/^MAIL FROM:/i.test(line)) { mail.from = line.slice(10); sock.write("250 ok\r\n"); }
        else if (/^RCPT TO:/i.test(line)) { mail.to.push(line.slice(8)); sock.write("250 ok\r\n"); }
        else if (/^DATA/i.test(line)) { inData = true; sock.write("354 go\r\n"); }
        else if (/^QUIT/i.test(line)) { sock.write("221 bye\r\n"); sock.end(); }
        else sock.write("500 ?\r\n");
      }
    });
    sock.on("error", () => {});
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, mails, port: server.address().port })));
}
const bodyOf = (raw) => Buffer.from(raw.split("\r\n\r\n").slice(1).join("").replace(/\s+/g, ""), "base64").toString("utf8");

test("Mail: Einstellungen werden geprüft, Nachricht ist sauber aufgebaut", async () => {
  const { parseMailSettings, buildMessage } = await import("../scripts/lib/smtp.mjs");
  const s = parseMailSettings("smtps://AKIA%2Fuser:p%40ss@email-smtp.eu-central-1.amazonaws.com:465/?from=noreply@immobilieneichmann.de");
  assert.deepEqual([s.host, s.port, s.secure, s.user, s.pass, s.from], ["email-smtp.eu-central-1.amazonaws.com", 465, true, "AKIA/user", "p@ss", "noreply@immobilieneichmann.de"]);
  assert.equal(parseMailSettings({ url: "smtp://u:p@mail.example.org", from: "a@b.de" }).port, 587);
  assert.equal(parseMailSettings("smtp://localhost:25/?from=web@immobilieneichmann.de").local, true, "Mailserver auf demselben Rechner: ohne Anmeldung möglich");
  for (const bad of ["", "https://u:p@x.de/?from=a@b.de", "smtps://u:p@x.de", "smtps://x.de/?from=a@b.de", "smtps://u:p@x.de/?from=keine-adresse"]) {
    assert.throws(() => parseMailSettings(bad), /Mail-Einstellung ungültig/, bad);
  }
  const msg = buildMessage({ from: "a@b.de", fromName: "Immobilien Eichmann – Website", to: "x@y.de", subject: "Neues Passwort für Ihre Website-Verwaltung", text: "Zeile 1\nÄ ö ü\n.\nEnde" });
  const [head] = msg.split("\r\n\r\n");
  assert.match(head, /^From: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <a@b\.de>\r\nTo: <x@y\.de>\r\nSubject: =\?UTF-8\?B\?/);
  assert.ok(!/[^\x00-\x7f]/.test(msg), "nur ASCII auf der Leitung");
  assert.ok(!msg.split("\r\n").some((l) => l === "."), "keine einzelne Punkt-Zeile (würde die Nachricht beenden)");
  assert.equal(bodyOf(msg), "Zeile 1\r\nÄ ö ü\r\n.\r\nEnde");
});

test("Passwörter je Person, Rücksetz-Link einmalig und befristet, wachsende Pausen", async () => {
  const dir = tmpRoot();
  process.env.EICHMANN_ADMIN_AUTH_FILE = path.join(dir, "secrets", "admin-auth.json");
  delete process.env.EICHMANN_ADMIN_RESET_THROTTLE_FILE;
  const A = await import("../scripts/lib/admin-auth.mjs");
  const P = await import("../scripts/lib/admin-password.mjs");
  P.saveAdminEmails(["helmut@example.com", "chris@example.com"]);
  P.savePasswordHash("", P.sha256Hex("GemeinsamAlt1"));

  // bisher: ein gemeinsames Passwort für alle
  assert.ok(A.checkLogin("Helmut@Example.com", "GemeinsamAlt1", ""));
  assert.ok(A.checkLogin("chris@example.com", "GemeinsamAlt1", ""));
  assert.ok(!A.checkLogin("fremd@example.com", "GemeinsamAlt1", ""), "nicht zugelassene Adresse");
  assert.ok(!A.checkLogin("helmut@example.com", "falsch", ""));
  const before = A.credentialFingerprint("helmut@example.com", "");

  // Helmut setzt per Link ein eigenes – Chris' Passwort bleibt
  const t0 = Date.parse("2026-11-12T10:00:00Z");
  const token = A.createResetToken("helmut@example.com", { now: t0 });
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  const stored = fs.readFileSync(process.env.EICHMANN_ADMIN_AUTH_FILE, "utf8");
  assert.ok(!stored.includes(token), "der Link selbst wird nicht gespeichert, nur sein Fingerabdruck");
  assert.equal(fs.statSync(process.env.EICHMANN_ADMIN_AUTH_FILE).mode & 0o777, 0o600);
  assert.equal(A.resetTokenOwner(token, { now: t0 + 29 * 60_000 }), "helmut@example.com");
  assert.equal(A.resetTokenOwner(token, { now: t0 + 31 * 60_000 }), null, "nach 30 Minuten abgelaufen");
  assert.equal(A.resetTokenOwner("x".repeat(43), { now: t0 }), null);
  assert.equal(A.resetPasswordWithToken(token, "HelmutsNeues9", { now: t0 + 31 * 60_000 }), null, "abgelaufener Link ändert nichts");
  assert.ok(A.checkLogin("helmut@example.com", "GemeinsamAlt1", ""));
  assert.equal(A.resetPasswordWithToken(token, "HelmutsNeues9", { now: t0 + 60_000 }), "helmut@example.com");
  assert.equal(A.resetPasswordWithToken(token, "NochEinmal123", { now: t0 + 120_000 }), null, "Link funktioniert nur einmal");
  assert.ok(A.checkLogin("helmut@example.com", "HelmutsNeues9", ""));
  assert.ok(!A.checkLogin("helmut@example.com", "GemeinsamAlt1", ""), "altes Passwort gilt für Helmut nicht mehr");
  assert.ok(A.checkLogin("chris@example.com", "GemeinsamAlt1", ""), "Chris ist nicht betroffen");
  assert.ok(!A.checkLogin("chris@example.com", "HelmutsNeues9", ""));
  assert.notEqual(A.credentialFingerprint("helmut@example.com", ""), before, "Helmuts alte Anmeldungen enden");
  assert.ok(!fs.readFileSync(process.env.EICHMANN_ADMIN_AUTH_FILE, "utf8").includes("HelmutsNeues9"));

  // ein neuer Link ersetzt den alten
  const t1 = A.createResetToken("chris@example.com", { now: t0 });
  const t2 = A.createResetToken("chris@example.com", { now: t0 });
  assert.equal(A.resetTokenOwner(t1, { now: t0 }), null);
  assert.equal(A.resetTokenOwner(t2, { now: t0 }), "chris@example.com");

  // wachsende Pausen: 1, 2, 4, 8 Minuten … je Person und je Absender
  const slot = (email, ip, at) => A.takeResetSlot({ email, ip }, t0 + at).ok;
  assert.equal(slot("helmut@example.com", "1.1.1.1", 0), true);
  assert.equal(slot("helmut@example.com", "1.1.1.1", 30_000), false, "innerhalb der ersten Minute: nichts");
  assert.equal(slot("helmut@example.com", "2.2.2.2", 30_000), false, "andere Herkunft hilft nicht – die Person ist geschützt");
  assert.equal(slot("chris@example.com", "1.1.1.1", 30_000), false, "derselbe Absender kann nicht reihum alle anschreiben");
  assert.equal(slot("helmut@example.com", "1.1.1.1", 61_000), true);
  assert.equal(slot("helmut@example.com", "1.1.1.1", 61_000 + 119_000), false, "jetzt 2 Minuten Pause");
  assert.equal(slot("helmut@example.com", "1.1.1.1", 61_000 + 121_000), true);
  assert.equal(slot("helmut@example.com", "1.1.1.1", 61_000 + 121_000 + 239_000), false, "jetzt 4 Minuten Pause");
  A.clearResetPause("helmut@example.com");
  assert.equal(A.pauseLeftMs("mail:helmut@example.com", t0 + 400_000), 0, "nach erfolgreicher Anmeldung beginnt die Zählung neu");

  // Gesamtgrenze: höchstens 8 Mails pro Stunde, egal für wen und von wo
  fs.rmSync(A.throttleFile(), { force: true });
  let sent = 0;
  for (let i = 0; i < 20; i++) if (A.takeResetSlot({ email: `p${i}@example.com`, ip: `10.0.0.${i}` }, t0 + i).ok) sent++;
  assert.equal(sent, 8);
  assert.equal(A.takeResetSlot({ email: "neu@example.com", ip: "10.9.9.9" }, t0 + 61 * 60_000).ok, true, "eine Stunde später wieder möglich");

  // Notfall-Reset von der Konsole: ein Passwort für alle, eigene Passwörter und offene Links entfallen
  A.resetEveryoneToShared(P.sha256Hex("NotfallPasswort5"));
  assert.ok(A.checkLogin("helmut@example.com", "NotfallPasswort5", ""));
  assert.ok(A.checkLogin("chris@example.com", "NotfallPasswort5", ""));
  assert.ok(!A.checkLogin("helmut@example.com", "HelmutsNeues9", ""));
  assert.equal(A.resetTokenOwner(t2, { now: t0 }), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Gemeinsames Passwort abschalten: danach zählt nur noch das eigene; ohne Mailweg wird nichts abgeschaltet", async () => {
  const dir = tmpRoot();
  const { spawnSync } = await import("node:child_process");
  const authFile = path.join(dir, "secrets", "admin-auth.json");
  const mailFile = path.join(dir, "secrets", "mail.json");
  process.env.EICHMANN_ADMIN_AUTH_FILE = authFile;
  const A = await import("../scripts/lib/admin-auth.mjs");
  const P = await import("../scripts/lib/admin-password.mjs");
  P.saveAdminEmails(["helmut@example.com", "chris@example.com"]);
  P.savePasswordHash("", P.sha256Hex("GemeinsamAlt1"));
  A.setUserPassword("helmut@example.com", "HelmutsEigenes9");
  const run = (args = []) => spawnSync(process.execPath, [path.join(ROOT, "scripts", "admin-shared-password-off.mjs"), ...args], { env: { ...process.env, EICHMANN_ADMIN_AUTH_FILE: authFile, EICHMANN_MAIL_FILE: mailFile, EICHMANN_STATE_DIR: dir, EICHMANN_ADMIN_CONFIG: "" }, encoding: "utf8" });
  try {
    // ohne Mailweg: verweigert, das gemeinsame Passwort gilt weiter (sonst wäre Chris ausgesperrt)
    const refused = run();
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /nichts geändert/);
    assert.ok(A.checkLogin("chris@example.com", "GemeinsamAlt1", ""));
    assert.equal(JSON.parse(run(["--status"]).stdout).shared_password, "wird noch angenommen");

    fs.writeFileSync(mailFile, JSON.stringify({ url: "smtp://user:pass@127.0.0.1:2525", from: "noreply@example.com" }));
    const done = run();
    assert.equal(done.status, 0, done.stderr);
    assert.deepEqual([JSON.parse(done.stdout).sign_in_addresses, JSON.parse(done.stdout).with_own_password], [2, 1]);
    assert.ok(!/example\.com/.test(done.stdout), "Ausgabe nennt keine Adresse");
    assert.ok(!A.checkLogin("chris@example.com", "GemeinsamAlt1", ""), "altes gemeinsames Passwort öffnet nichts mehr");
    assert.equal(A.credentialFingerprint("chris@example.com", ""), "", "offene Anmeldungen mit dem gemeinsamen Passwort enden");
    assert.ok(A.checkLogin("helmut@example.com", "HelmutsEigenes9", ""), "eigenes Passwort bleibt");
    assert.equal(JSON.parse(run(["--status"]).stdout).shared_password, "abgeschaltet");

    // Chris kommt über den Link wieder hinein
    const token = A.createResetToken("chris@example.com");
    assert.equal(A.resetPasswordWithToken(token, "ChrisEigenes123", { configPath: "" }), "chris@example.com");
    assert.ok(A.checkLogin("chris@example.com", "ChrisEigenes123", ""));
    // Notfall: admin-password-set stellt ein gemeinsames Passwort wieder her
    A.resetEveryoneToShared(P.sha256Hex("NotfallNeu12345"));
    assert.ok(A.checkLogin("helmut@example.com", "NotfallNeu12345", ""));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Passwort vergessen – ganzer Weg über die Admin-Schnittstelle", { skip }, async (t) => {
  const dir = tmpRoot();
  const smtp = await fakeSmtp();
  const port = await freePort();
  const site = path.join(dir, "site");
  fs.mkdirSync(path.join(site, "admin"), { recursive: true });
  fs.mkdirSync(path.join(dir, "secrets"), { recursive: true });
  fs.writeFileSync(path.join(site, "admin", "config.json"), JSON.stringify({ password_sha256: "", auth_mode: "password_session" }));
  const authFile = path.join(dir, "secrets", "admin-auth.json");
  const { sha256Hex } = await import("../scripts/lib/admin-password.mjs");
  fs.writeFileSync(authFile, JSON.stringify({ password_sha256: sha256Hex("GemeinsamAlt1"), admin_emails: ["helmut@example.com", "chris@example.com"] }));
  // the fake mail server runs on this machine – the only place where the sender accepts an unencrypted connection
  const mailFile = path.join(dir, "secrets", "mail.json");
  fs.writeFileSync(mailFile, JSON.stringify({ url: `smtp://user:pass@127.0.0.1:${smtp.port}`, from: "noreply@example.com" }));
  const env = {
    ...process.env, EICHMANN_SITE_ROOT: site, EICHMANN_ADMIN_CONFIG: path.join(site, "admin", "config.json"), EICHMANN_ADMIN_AUTH_FILE: authFile,
    EICHMANN_SESSION_SECRET_FILE: path.join(dir, "session.secret"), EICHMANN_ADMIN_API_PORT: String(port), EICHMANN_DB_PATH: path.join(dir, "listings.db"),
    EICHMANN_MAIL_FILE: mailFile, EICHMANN_ADMIN_RESET_THROTTLE_FILE: path.join(dir, "secrets", "throttle.json"), EICHMANN_PUBLIC_ORIGIN: "https://immobilieneichmann.de", EICHMANN_STATE_DIR: dir,
  };
  const api = spawn(process.execPath, [path.join(ROOT, "scripts", "admin-api.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  api.stdout.on("data", (d) => (log += d));
  api.stderr.on("data", (d) => (log += d));
  t.after(() => (api.kill(), smtp.server.close(), fs.rmSync(dir, { recursive: true, force: true })));
  const base = `http://127.0.0.1:${port}/admin/api`;
  for (let i = 0; i < 50; i++) { try { await fetch(`${base}/auth/options`); break; } catch { await sleep(100); } }
  const post = async (p, body, headers = {}) => { const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})), cookie: r.headers.get("set-cookie") }; };
  const waitMails = async (n) => { for (let i = 0; i < 40 && smtp.mails.length < n; i++) await sleep(50); return smtp.mails.length; };

  assert.equal((await (await fetch(`${base}/auth/options`)).json()).reset_by_mail, true);

  // unbekannte Adresse: dieselbe Antwort, keine Mail
  const unknown = await post("/password/forgot", { email: "fremd@example.com" }, { "x-forwarded-for": "9.9.9.1" });
  const known = await post("/password/forgot", { email: "Helmut@Example.com" }, { "x-forwarded-for": "9.9.9.2" });
  assert.deepEqual([unknown.status, known.status], [200, 200]);
  assert.equal(unknown.json.message, known.json.message, "die Antwort verrät nicht, ob die Adresse zugelassen ist");
  assert.equal(await waitMails(1), 1, log);
  const mail = smtp.mails[0];
  assert.deepEqual([mail.from, mail.to], ["<noreply@example.com>", ["<helmut@example.com>"]], "geht genau an die eingegebene, zugelassene Adresse");
  const text = bodyOf(mail.raw);
  const link = /https:\/\/immobilieneichmann\.de\/admin\/#reset=([A-Za-z0-9_-]{43})/.exec(text);
  assert.ok(link, "Link zeigt auf die echte Seite");
  assert.match(text, /gilt 30 Minuten und funktioniert nur einmal/);
  assert.ok(!log.includes(link[1]) && !log.includes("GemeinsamAlt1"), "weder Link noch Passwort im Protokoll");

  // sofort noch einmal (auch von anderswo): Pause → keine zweite Mail
  await post("/password/forgot", { email: "helmut@example.com" }, { "x-forwarded-for": "9.9.9.3" });
  await sleep(300);
  assert.equal(smtp.mails.length, 1, "kein Fluten des Postfachs");
  // Bot füllt das unsichtbare Feld aus → nichts
  await post("/password/forgot", { email: "chris@example.com", website: "http://spam" }, { "x-forwarded-for": "9.9.9.4" });
  await sleep(300);
  assert.equal(smtp.mails.length, 1);

  // Link prüfen, neues Passwort setzen
  assert.equal((await post("/password/reset/check", { token: link[1] })).status, 200);
  assert.equal((await post("/password/reset/check", { token: "A".repeat(43) })).status, 410);
  assert.equal((await post("/password/reset", { token: link[1], new_password: "kurz", new_password_repeat: "kurz" })).status, 400);
  assert.equal((await post("/password/reset", { token: link[1], new_password: "HelmutsNeues9", new_password_repeat: "anders12345" })).status, 400);
  const done = await post("/password/reset", { token: link[1], new_password: "HelmutsNeues9", new_password_repeat: "HelmutsNeues9" });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal((await post("/password/reset", { token: link[1], new_password: "NochEinmal123", new_password_repeat: "NochEinmal123" })).status, 410, "Link nur einmal");

  // anmelden: Helmut mit neuem, Chris weiter mit bisherigem Passwort
  assert.equal((await post("/login", { email: "helmut@example.com", password: "GemeinsamAlt1" })).status, 401);
  const helmut = await post("/login", { email: "helmut@example.com", password: "HelmutsNeues9" });
  assert.equal(helmut.status, 200);
  const chris = await post("/login", { email: "chris@example.com", password: "GemeinsamAlt1" });
  assert.equal(chris.status, 200);
  const me = async (cookie) => (await fetch(`${base}/me`, { headers: { cookie: cookie.split(";")[0] } })).status;
  assert.deepEqual([await me(helmut.cookie), await me(chris.cookie)], [200, 200]);

  // Chris ändert angemeldet sein Passwort → nur seine Anmeldung wechselt, Helmut bleibt angemeldet
  const change = await fetch(`${base}/password`, { method: "POST", headers: { "content-type": "application/json", cookie: chris.cookie.split(";")[0] }, body: JSON.stringify({ current_password: "GemeinsamAlt1", new_password: "ChrisNeues123", new_password_repeat: "ChrisNeues123" }) });
  assert.equal(change.status, 200);
  assert.deepEqual([await me(helmut.cookie), await me(chris.cookie)], [200, 401], "alte Anmeldung von Chris endet, Helmut ist nicht betroffen");
  assert.equal((await post("/login", { email: "chris@example.com", password: "ChrisNeues123" })).status, 200);
  assert.equal((await post("/login", { email: "fremd@example.com", password: "ChrisNeues123" })).status, 401);
  const auth = fs.readFileSync(authFile, "utf8");
  assert.ok(!auth.includes("HelmutsNeues9") && !auth.includes("ChrisNeues123") && auth.includes("scrypt$"), "Passwörter nur als gesalzener Hash");
});

// "Passwort vergessen" über das Formular-Gateway: signierte Anfrage statt Mail-Passwort auf dem Server.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ensureGatewayKey, gatewayPublicKey, hasGatewayKey, parseGatewayUrl, signedRequest, signingText } from "../scripts/lib/mail-gateway.mjs";
import { readMailer } from "../scripts/lib/mailer.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hasSqlite = await import("better-sqlite3").then(() => true, () => false);
const skip = hasSqlite ? false : "better-sqlite3 nicht installiert";
const tmpRoot = () => {
  const base = process.env.EICHMANN_TEST_TMP || os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, "reset-gw-"));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });

/** Stand-in for the gateway: checks the signature like the real one and records what it would send. */
function fakeGateway(publicKeyB64, { status = 200 } = {}) {
  const key = publicKeyB64 ? crypto.createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" }) : null;
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const answer = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      let d;
      try { d = JSON.parse(raw); } catch { return answer(403, { success: false }); }
      const ok = key && req.url === "/v1/immobilieneichmann/admin-reset" && req.method === "POST"
        && crypto.verify(null, Buffer.from(signingText(d), "utf8"), key, Buffer.from(String(d.sig), "base64")) && Math.abs(Date.now() - d.ts) < 300_000;
      if (!ok) return answer(403, { success: false, error: "forbidden" });
      requests.push(d);
      return status === 200 ? answer(200, { success: true }) : answer(status, { success: false });
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, requests, url: `http://127.0.0.1:${server.address().port}/v1/immobilieneichmann/admin-reset` })));
}

test("Gateway-Weg: Schlüssel bleibt auf dem Server, Signatur ist festgelegt (gemeinsamer Prüfwert mit dem Gateway)", () => {
  const dir = tmpRoot();
  try {
    const keyFile = path.join(dir, "secrets", "key.pem");
    assert.equal(hasGatewayKey(keyFile), false);
    assert.equal(ensureGatewayKey(keyFile), true);
    assert.equal(ensureGatewayKey(keyFile), false, "ein vorhandener Schlüssel wird nie ersetzt");
    assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
    const pub = gatewayPublicKey(keyFile);
    assert.ok(pub && !fs.readFileSync(keyFile, "utf8").includes(pub), "öffentlicher Teil ist nicht der Schlüssel selbst");

    // Fester Prüfwert – derselbe steht im Test des Gateways (server/forms-gateway.test.js). Nur ein Wegwerf-Testschlüssel.
    const seed = crypto.createHash("sha256").update("eichmann admin-reset test vector – kein echter Schlüssel").digest();
    const testKey = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
    const vecFile = path.join(dir, "vec.pem");
    fs.writeFileSync(vecFile, testKey.export({ type: "pkcs8", format: "pem" }));
    assert.equal(gatewayPublicKey(vecFile), "MCowBQYDK2VwAyEAQ4nrjVCTxr8z4qgLu7oh7P3IHNx5LwWUsE+dGK63xWs=");
    const body = signedRequest(
      { kind: "reset", to: "Info@Immobilien-Eichmann.com", link: "https://immobilieneichmann.de/admin/#reset=" + "A".repeat(43), minutes: 30 },
      { keyFile: vecFile, now: 1794480000000, nonce: "000102030405060708090a0b0c0d0e0f" },
    );
    assert.equal(body.to, "info@immobilien-eichmann.com");
    assert.equal(signingText(body), "dp-forms-admin-reset-v1\nimmobilieneichmann\nreset\ninfo@immobilien-eichmann.com\nhttps://immobilieneichmann.de/admin/#reset=" + "A".repeat(43) + "\n30\n1794480000000\n000102030405060708090a0b0c0d0e0f");
    assert.equal(body.sig, "l8Ne3IQsgsYTwQ62+mgMUvBxYNPrBMzaCrFRj1xmLQ2JzvNlckoyZEDAu7sd4loPvi9LFdxrr3ppzNttRupHBQ==");

    assert.equal(parseGatewayUrl(""), "https://forms.digitalisierungsplanung.de/v1/immobilieneichmann/admin-reset");
    for (const bad of ["http://forms.digitalisierungsplanung.de/x", "https://user:pw@forms.example/x", "ftp://x", "https://forms.example/x?to=a"]) assert.throws(() => parseGatewayUrl(bad), /ungültig/, bad);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Gateway-Weg einschalten: nur wenn das Gateway diesen Server anerkennt; sonst bleibt alles, wie es ist", async (t) => {
  const dir = tmpRoot();
  const keyFile = path.join(dir, "secrets", "mail-gateway-key.pem");
  const mailFile = path.join(dir, "secrets", "mail.json");
  const run = (args, extra = {}) => spawnSync(process.execPath, [path.join(ROOT, "scripts", "mail-install.mjs"), ...args], { env: { ...process.env, EICHMANN_STATE_DIR: dir, EICHMANN_MAIL_FILE: mailFile, EICHMANN_MAIL_GATEWAY_KEY_FILE: keyFile, ...extra }, encoding: "utf8" });
  // spawnSync would block the stand-in gateway in this process → run the script asynchronously where it must answer
  const runAsync = (args, extra = {}) => new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, "scripts", "mail-install.mjs"), ...args], { env: { ...process.env, EICHMANN_STATE_DIR: dir, EICHMANN_MAIL_FILE: mailFile, EICHMANN_MAIL_GATEWAY_KEY_FILE: keyFile, ...extra } });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });

  assert.deepEqual(JSON.parse(run(["--status"]).stdout), { configured: false, signing_key: "fehlt" });
  const first = JSON.parse(run(["--key"]).stdout);
  assert.equal(first.signing_key, "neu angelegt");
  assert.equal(JSON.parse(run(["--key"]).stdout).public_key, first.public_key, "zweiter Aufruf zeigt denselben öffentlichen Teil");
  assert.ok(!first.public_key.includes("PRIVATE") && first.public_key === gatewayPublicKey(keyFile));

  // Gateway kennt den Schlüssel (noch) nicht → nicht eingeschaltet, keine Datei
  const stranger = await fakeGateway(gatewayPublicKey((() => { const f = path.join(dir, "other.pem"); ensureGatewayKey(f); return f; })()));
  t.after(() => stranger.server.close());
  const refused = await runAsync(["--gateway-on"], { EICHMANN_MAIL_GATEWAY_URL: stranger.url });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Nicht eingeschaltet – nichts geändert: Gateway lehnt ab/);
  assert.equal(fs.existsSync(mailFile), false);
  assert.equal(readMailer(mailFile), null);

  // Gateway kennt den Schlüssel → eingeschaltet; die Probe verschickt keine Mail
  const gw = await fakeGateway(first.public_key);
  t.after(() => (gw.server.close(), fs.rmSync(dir, { recursive: true, force: true })));
  const on = await runAsync(["--gateway-on"], { EICHMANN_MAIL_GATEWAY_URL: gw.url });
  assert.equal(on.status, 0, on.stderr);
  assert.deepEqual(gw.requests.map((r) => [r.kind, r.to, r.link]), [["ping", "", ""]]);
  assert.equal(JSON.parse(on.stdout).way, "Formular-Gateway");
  const saved = fs.readFileSync(mailFile, "utf8");
  assert.equal(JSON.parse(saved).transport, "gateway");
  assert.ok(!/PRIVATE|pass|smtps?:/i.test(saved), "kein Geheimnis in der Einstellungsdatei");
  assert.equal(fs.statSync(mailFile).mode & 0o777, 0o600);
  assert.equal(JSON.parse(run(["--status"]).stdout).configured, true);
});

test("Passwort vergessen über das Gateway – ganzer Weg über die Admin-Schnittstelle", { skip }, async (t) => {
  const dir = tmpRoot();
  const port = await freePort();
  const site = path.join(dir, "site");
  fs.mkdirSync(path.join(site, "admin"), { recursive: true });
  fs.mkdirSync(path.join(dir, "secrets"), { recursive: true });
  fs.writeFileSync(path.join(site, "admin", "config.json"), JSON.stringify({ password_sha256: "", auth_mode: "password_session" }));
  const authFile = path.join(dir, "secrets", "admin-auth.json");
  const { sha256Hex } = await import("../scripts/lib/admin-password.mjs");
  fs.writeFileSync(authFile, JSON.stringify({ password_sha256: sha256Hex("GemeinsamAlt1"), admin_emails: ["helmut@example.com", "chris@example.com", "chris@googlemail.com"] }));
  const keyFile = path.join(dir, "secrets", "mail-gateway-key.pem");
  ensureGatewayKey(keyFile);
  const gw = await fakeGateway(gatewayPublicKey(keyFile));
  const mailFile = path.join(dir, "secrets", "mail.json");
  const env = {
    ...process.env, EICHMANN_SITE_ROOT: site, EICHMANN_ADMIN_CONFIG: path.join(site, "admin", "config.json"), EICHMANN_ADMIN_AUTH_FILE: authFile,
    EICHMANN_SESSION_SECRET_FILE: path.join(dir, "session.secret"), EICHMANN_ADMIN_API_PORT: String(port), EICHMANN_DB_PATH: path.join(dir, "listings.db"),
    EICHMANN_MAIL_FILE: mailFile, EICHMANN_MAIL_GATEWAY_KEY_FILE: keyFile, EICHMANN_ADMIN_RESET_THROTTLE_FILE: path.join(dir, "secrets", "throttle.json"),
    EICHMANN_PUBLIC_ORIGIN: "https://immobilieneichmann.de", EICHMANN_STATE_DIR: dir,
  };
  const api = spawn(process.execPath, [path.join(ROOT, "scripts", "admin-api.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  api.stdout.on("data", (d) => (log += d));
  api.stderr.on("data", (d) => (log += d));
  t.after(() => (api.kill(), gw.server.close(), fs.rmSync(dir, { recursive: true, force: true })));
  const base = `http://127.0.0.1:${port}/admin/api`;
  for (let i = 0; i < 50; i++) { try { await fetch(`${base}/auth/options`); break; } catch { await sleep(100); } }
  const post = async (p, body, headers = {}) => { const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  const waitFor = async (n) => { for (let i = 0; i < 40 && gw.requests.length < n; i++) await sleep(50); return gw.requests.length; };
  const options = async () => (await (await fetch(`${base}/auth/options`)).json()).reset_by_mail;

  assert.equal(await options(), false, "ohne Einstellung verspricht die Anmeldeseite keine Mail");
  fs.writeFileSync(mailFile, JSON.stringify({ transport: "gateway", url: gw.url }));
  assert.equal(await options(), true);

  await post("/password/forgot", { email: "fremd@example.com" }, { "x-forwarded-for": "9.8.9.1" });
  await post("/password/forgot", { email: "Chris@Example.com" }, { "x-forwarded-for": "9.8.9.2" });
  assert.equal(await waitFor(1), 1, log);
  await sleep(200);
  assert.equal(gw.requests.length, 1, "für eine fremde Adresse geht nichts ans Gateway");
  const sent = gw.requests[0];
  assert.deepEqual([sent.kind, sent.to, sent.minutes], ["reset", "chris@example.com", 30], "genau die eingegebene, zugelassene Adresse");
  const token = /^https:\/\/immobilieneichmann\.de\/admin\/#reset=([A-Za-z0-9_-]{43})$/.exec(sent.link)?.[1];
  assert.ok(token, "Link zeigt in die Verwaltung der echten Seite");
  assert.ok(!log.includes(token) && log.includes('"via":"gateway"'), "Link nicht im Protokoll");

  // zweite Schreibweise desselben Postfachs (googlemail.com) → geht an die gmail.com-Schreibweise, die das Gateway kennt
  await post("/password/forgot", { email: "chris@googlemail.com" }, { "x-forwarded-for": "9.8.9.3" });
  assert.equal(await waitFor(2), 2, log);
  assert.equal(gw.requests[1].to, "chris@gmail.com");

  const done = await post("/password/reset", { token, new_password: "ChrisNeues123", new_password_repeat: "ChrisNeues123" });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal((await post("/login", { email: "chris@example.com", password: "ChrisNeues123" })).status, 200);
  assert.equal((await post("/login", { email: "helmut@example.com", password: "GemeinsamAlt1" })).status, 200, "die andere Person ist nicht betroffen");
});

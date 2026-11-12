// Server watchdog: checks the sync AND the public site, then gives the sign of life.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { notifySinks, STATUS_SCHEMA } from "../scripts/lib/immowelt/status.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The server scripts read their paths from the shared configuration, which needs the database driver.
// Where it is not installed (rules-only CI job), these two tests are skipped; the logic test above them runs everywhere.
const hasSqlite = await import("better-sqlite3").then(() => true, () => false);
const skip = hasSqlite ? false : "better-sqlite3 nicht installiert";
const tmpRoot = () => {
  const base = process.env.EICHMANN_TEST_TMP || os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, "watchdog-"));
};
const run = (script, args, { env = {}, input = null } = {}) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "scripts", script), ...args], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.end(input ?? "");
  });

test("Lebenszeichen: „in Ordnung“ sagt nur der Wächter, ein Fehler wird sofort gemeldet", async () => {
  const dir = tmpRoot();
  const file = path.join(dir, "alarm.json");
  fs.writeFileSync(file, JSON.stringify({ enabled: true, healthcheck_url: "https://hc.example/ping/abc-123" }));
  const calls = [];
  const fetchImpl = async (url, init) => (calls.push([url, init.body]), { ok: true, status: 200 });
  const good = { state: "current", ok: true, last_attempt_at: "t", last_success_at: "t", error: null, published: { count: 11 } };
  const bad = { ...good, state: "failed", ok: false, error: { message: "Immowelt nicht erreichbar" } };

  await notifySinks(file, good, { state: "current" }, { fetchImpl, okPing: false }); // Abgleich, guter Lauf
  assert.equal(calls.length, 0, "der Abgleich allein meldet kein „in Ordnung“");
  await notifySinks(file, bad, { state: "current" }, { fetchImpl, okPing: false }); // Abgleich, Fehler
  assert.deepEqual(calls.map((c) => c[0]), ["https://hc.example/ping/abc-123/fail"]);
  await notifySinks(file, good, { state: "current" }, { fetchImpl }); // Wächter nach voller Prüfung
  assert.equal(calls.at(-1)[0], "https://hc.example/ping/abc-123");

  fs.writeFileSync(file, JSON.stringify({ enabled: false, healthcheck_url: "https://hc.example/ping/abc-123" }));
  calls.length = 0;
  await notifySinks(file, bad, null, { fetchImpl });
  assert.equal(calls.length, 0, "abgeschaltet = nichts senden");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Wächter auf dem Server: prüft Abgleich und öffentliche Seite", { skip }, async (t) => {
  const dir = tmpRoot();
  const state = path.join(dir, "state");
  fs.mkdirSync(path.join(state, "status"), { recursive: true });
  const published = { count: 2, detail_total: 2, public_total: 2, data_as_of: "2026-11-12", release_id: "R1", fingerprint: "f1" };
  const status = { schema: STATUS_SCHEMA, state: "current", ok: true, last_success_at: new Date().toISOString(), stale_after_minutes: 120, published, warnings: [] };
  const statusFile = path.join(state, "status", "immowelt-sync-status.json");
  fs.writeFileSync(statusFile, JSON.stringify(status));

  const site = { missing: null, release: "R1" };
  const server = http.createServer((req, res) => {
    const json = (o) => (res.setHeader("content-type", "application/json"), res.end(JSON.stringify(o)));
    const base = `http://127.0.0.1:${server.address().port}`;
    if (req.url === "/data/immowelt-sync-status.json") return json(status);
    if (req.url === "/ai/build.json") return json({ release_id: site.release, immowelt_fingerprint: "f1" });
    if (req.url === "/ai/listings.json") return json({ listing_count: 2, data_as_of: "2026-11-12", listings: [{ slug: "a", url: `${base}/objekt/a.html` }, { slug: "b", url: `${base}/objekt/b.html` }] });
    if (/^\/objekt\/[ab]\.html$/.test(req.url) && req.url !== site.missing) return res.end("ok");
    res.statusCode = 404;
    res.end("nope");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => (server.close(), fs.rmSync(dir, { recursive: true, force: true })));
  const env = { EICHMANN_STATE_DIR: state, EICHMANN_SETTINGS_FILE: "/nonexistent", EICHMANN_PUBLIC_ORIGIN: `http://127.0.0.1:${server.address().port}` };

  const fine = await run("watchdog-check.mjs", ["--local"], { env });
  assert.equal(fine.code, 0, fine.err);
  assert.deepEqual([JSON.parse(fine.out).ok, JSON.parse(fine.out).public], [true, "2 Objektseite(n) geprüft."]);

  site.missing = "/objekt/b.html"; // Abgleich gut, aber eine Angebotsseite fehlt → Alarm
  const page = await run("watchdog-check.mjs", ["--local"], { env });
  assert.equal(page.code, 1);
  assert.match(JSON.parse(page.out).problems.join(" "), /Objektseite b antwortet mit HTTP 404/);

  site.missing = null;
  site.release = "R0"; // Website liefert einen anderen Stand als der Abgleich meldet
  const drift = await run("watchdog-check.mjs", ["--local"], { env });
  assert.equal(drift.code, 1);
  assert.match(JSON.parse(drift.out).problems.join(" "), /Website liefert Release R0/);

  site.release = "R1";
  fs.writeFileSync(statusFile, JSON.stringify({ ...status, last_success_at: new Date(Date.now() - 5 * 3600e3).toISOString() }));
  const stale = await run("watchdog-check.mjs", ["--local"], { env });
  assert.equal(stale.code, 1);
  assert.match(JSON.parse(stale.out).problems.join(" "), /Letzter erfolgreicher Abgleich vor 300 Minuten/);
});

test("Adresse der Lebenszeichen-Prüfung: nur über STDIN, nie in der Ausgabe", { skip }, async () => {
  const dir = tmpRoot();
  const env = { EICHMANN_STATE_DIR: dir, EICHMANN_SETTINGS_FILE: "/nonexistent" };
  const file = path.join(dir, "secrets", "alarm.json");
  const url = "https://hc-ping.com/11111111-2222-3333-4444-555555555555";

  assert.deepEqual(JSON.parse((await run("alarm-install.mjs", ["--status"], { env })).out), { enabled: false, has_healthcheck: false, healthcheck_host: null, has_webhook: false });
  for (const bad of ["", "http://hc-ping.com/11111111-2222-3333-4444-555555555555", "https://hc-ping.com/", `${url}/fail`, "kein link", `${url}?x=1`]) {
    assert.equal((await run("alarm-install.mjs", [], { env, input: bad })).code, 1, `abgelehnt: ${bad}`);
  }
  assert.ok(!fs.existsSync(file));

  const ok = await run("alarm-install.mjs", [], { env, input: `${url}\n` });
  assert.equal(ok.code, 0, ok.err);
  assert.ok(!ok.out.includes("11111111") && !ok.err.includes("11111111"), "Adresse erscheint nicht in der Ausgabe");
  assert.deepEqual(JSON.parse(ok.out), { enabled: true, has_healthcheck: true, healthcheck_host: "hc-ping.com", has_webhook: false });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).healthcheck_url, url);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const off = await run("alarm-install.mjs", ["--off"], { env });
  assert.equal(JSON.parse(off.out).enabled, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

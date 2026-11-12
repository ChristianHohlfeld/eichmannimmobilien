#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  sha256Hex,
  validatePasswordChange,
  savePasswordHash,
  loadPasswordHash,
  migratePasswordHashFromConfig,
  sessionMatchesPassword,
  adminAuthSecretsPath,
  MIN_PASSWORD_LENGTH,
} from "./lib/admin-password.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eichmann-pw-"));
const secretsDir = path.join(tmpDir, "secrets");
const authPath = path.join(secretsDir, "admin-auth.json");
const configPath = path.join(tmpDir, "config.json");
process.env.EICHMANN_ADMIN_AUTH_FILE = authPath;

const oldPw = "AltesPasswort1";
const newPw = "NeuesPasswort2";
const oldHash = sha256Hex(oldPw);

fs.writeFileSync(
  configPath,
  JSON.stringify(
    {
      password_sha256: oldHash,
      admin_emails: ["helmut@example.com"],
      note: "keep-me",
    },
    null,
    2
  ) + "\n"
);

assert.equal(MIN_PASSWORD_LENGTH, 8);
assert.equal(adminAuthSecretsPath(), authPath);

{
  const bad = validatePasswordChange({
    currentPassword: "",
    newPassword: newPw,
    newPasswordRepeat: newPw,
    expectHash: oldHash,
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 400);
}

{
  const bad = validatePasswordChange({
    currentPassword: "wrong",
    newPassword: newPw,
    newPasswordRepeat: newPw,
    expectHash: oldHash,
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 401);
}

{
  const bad = validatePasswordChange({
    currentPassword: oldPw,
    newPassword: "kurz",
    newPasswordRepeat: "kurz",
    expectHash: oldHash,
  });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /8 Zeichen/);
}

{
  const bad = validatePasswordChange({
    currentPassword: oldPw,
    newPassword: newPw,
    newPasswordRepeat: newPw + "x",
    expectHash: oldHash,
  });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /stimmen nicht/);
}

{
  const bad = validatePasswordChange({
    currentPassword: oldPw,
    newPassword: oldPw,
    newPasswordRepeat: oldPw,
    expectHash: oldHash,
  });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /unterscheiden/);
}

// Fallback: secrets missing → config.json
assert.equal(loadPasswordHash(configPath), oldHash);

const mig = migratePasswordHashFromConfig(configPath);
assert.equal(mig.migrated, true);
assert.equal(mig.prefix, oldHash.slice(0, 7));
assert.ok(fs.existsSync(authPath));
assert.equal(fs.statSync(authPath).mode & 0o777, 0o600);
assert.equal(loadPasswordHash(configPath), oldHash);

// Second migrate is a no-op (does not overwrite)
const mig2 = migratePasswordHashFromConfig(configPath);
assert.equal(mig2.migrated, false);

const ok = validatePasswordChange({
  currentPassword: oldPw,
  newPassword: newPw,
  newPasswordRepeat: newPw,
  expectHash: oldHash,
});
assert.equal(ok.ok, true);
assert.equal(ok.newHash, sha256Hex(newPw));

const written = savePasswordHash(configPath, ok.newHash);
assert.equal(written, sha256Hex(newPw));
const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
assert.equal(auth.password_sha256, sha256Hex(newPw));
// Public/legacy config must NOT be rewritten by password change
const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
assert.equal(cfg.password_sha256, oldHash);
assert.equal(cfg.note, "keep-me");
assert.deepEqual(cfg.admin_emails, ["helmut@example.com"]);
assert.equal(loadPasswordHash(configPath), sha256Hex(newPw));

assert.equal(sessionMatchesPassword({ ph: oldHash }, sha256Hex(newPw)), false);
assert.equal(sessionMatchesPassword({ ph: sha256Hex(newPw) }, sha256Hex(newPw)), true);
assert.equal(sessionMatchesPassword({}, sha256Hex(newPw)), false);

fs.rmSync(tmpDir, { recursive: true, force: true });
delete process.env.EICHMANN_ADMIN_AUTH_FILE;
console.log("test-admin-password: ok");

// ---- sign-in addresses live server-side only; the public config.json names no one ----
{
  const { loadAdminEmails, saveAdminEmails, migrateAdminEmailsFromConfig } = await import("./lib/admin-password.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eichmann-emails-"));
  const auth = path.join(dir, "secrets", "admin-auth.json");
  const real = path.join(dir, "admin-config.json");
  const link = path.join(dir, "config.json"); // the served file is a link to the persistent one
  process.env.EICHMANN_ADMIN_AUTH_FILE = auth;
  const hash = sha256Hex("EinPasswort9");
  fs.mkdirSync(path.dirname(auth), { recursive: true });
  fs.writeFileSync(auth, JSON.stringify({ password_sha256: hash }));
  fs.writeFileSync(real, JSON.stringify({ password_sha256: "", repo: "x/y", note: "intern", admin_emails: ["Helmut@Example.com", "chris@example.com ", "kaputt"] }));
  fs.symlinkSync(real, link);

  assert.deepEqual(loadAdminEmails(link), ["helmut@example.com", "chris@example.com"], "vor dem Umzug: aus der öffentlichen Datei");
  const first = migrateAdminEmailsFromConfig(link);
  assert.deepEqual([first.moved, first.cleaned, first.count], [true, true, 2]);
  const pub = JSON.parse(fs.readFileSync(link, "utf8"));
  assert.ok(!("admin_emails" in pub) && !("note" in pub), "öffentliche Datei nennt niemanden mehr");
  assert.equal(pub.repo, "x/y", "übrige Einstellungen bleiben");
  assert.ok(fs.lstatSync(link).isSymbolicLink(), "Verknüpfung bleibt erhalten");
  const stored = JSON.parse(fs.readFileSync(auth, "utf8"));
  assert.equal(stored.password_sha256, hash, "Passwort unverändert");
  assert.deepEqual(loadAdminEmails(link), ["helmut@example.com", "chris@example.com"], "Anmeldung geht weiter – jetzt aus der Server-Datei");
  assert.equal(fs.statSync(auth).mode & 0o777, 0o600);

  const again = migrateAdminEmailsFromConfig(link);
  assert.deepEqual([again.moved, again.cleaned, again.count], [false, false, 2], "zweiter Lauf ändert nichts");

  // a list already stored server-side wins and is never overwritten by the public file
  fs.writeFileSync(real, JSON.stringify({ admin_emails: ["fremd@example.com"] }));
  const third = migrateAdminEmailsFromConfig(link);
  assert.deepEqual([third.moved, third.cleaned], [false, true]);
  assert.deepEqual(loadAdminEmails(link), ["helmut@example.com", "chris@example.com"]);

  // changing the password keeps the list; changing the list keeps the password
  savePasswordHash(link, sha256Hex("NochEinPasswort3"));
  assert.deepEqual(loadAdminEmails(link), ["helmut@example.com", "chris@example.com"]);
  saveAdminEmails(["neu@example.com"]);
  assert.equal(loadPasswordHash(link), sha256Hex("NochEinPasswort3"));
  assert.deepEqual(loadAdminEmails(link), ["neu@example.com"]);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("test-admin-emails: ok");
}

// ---- the password hash must not stay in the publicly served config.json ----
{
  const { scrubPasswordHashFromPublicConfig } = await import("./lib/admin-password.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eichmann-scrub-"));
  const auth = path.join(dir, "secrets", "admin-auth.json");
  const real = path.join(dir, "admin-config.json");
  const link = path.join(dir, "config.json");
  process.env.EICHMANN_ADMIN_AUTH_FILE = auth;
  const hash = sha256Hex("GeheimesPasswort7");
  fs.writeFileSync(real, JSON.stringify({ password_sha256: hash, repo: "x/y" }));
  fs.symlinkSync(real, link);

  // only place the hash is stored → must stay, signing in keeps working
  assert.deepEqual(scrubPasswordHashFromPublicConfig(link), { cleaned: false });
  assert.equal(loadPasswordHash(link), hash);

  // moved server-side → public copy is blanked, signing in still works
  assert.equal(migratePasswordHashFromConfig(link).migrated, true);
  assert.deepEqual(scrubPasswordHashFromPublicConfig(link), { cleaned: true });
  const pub = JSON.parse(fs.readFileSync(link, "utf8"));
  assert.equal(pub.password_sha256, "");
  assert.equal(pub.repo, "x/y");
  assert.ok(!fs.readFileSync(real, "utf8").includes(hash), "Hash steht nicht mehr in der öffentlichen Datei");
  assert.equal(loadPasswordHash(link), hash, "Anmeldung prüft weiter gegen die Server-Datei");
  assert.deepEqual(scrubPasswordHashFromPublicConfig(link), { cleaned: false }, "zweiter Lauf ändert nichts");
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("test-admin-hash-scrub: ok");
}

#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  sha256Hex,
  validatePasswordChange,
  savePasswordHash,
  sessionMatchesPassword,
  MIN_PASSWORD_LENGTH,
} from "./lib/admin-password.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eichmann-pw-"));
const configPath = path.join(tmpDir, "config.json");
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
assert.equal(sha256Hex("abc"), sha256Hex("abc"));

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
const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
assert.equal(cfg.password_sha256, sha256Hex(newPw));
assert.equal(cfg.note, "keep-me");
assert.deepEqual(cfg.admin_emails, ["helmut@example.com"]);

assert.equal(sessionMatchesPassword({ ph: oldHash }, sha256Hex(newPw)), false);
assert.equal(sessionMatchesPassword({ ph: sha256Hex(newPw) }, sha256Hex(newPw)), true);
assert.equal(sessionMatchesPassword({}, sha256Hex(newPw)), false);

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log("test-admin-password: ok");

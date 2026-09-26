import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  maskApiKey,
  saveImmoweltCredentials,
  getImmoweltCredentialsStatus,
  hasImmoweltApiKey,
  readImmoweltCredentials,
} from "./lib/immowelt-secrets.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "iw-secrets-"));
const file = path.join(tmp, "immowelt-api.json");
process.env.EICHMANN_IMMOWELT_SECRETS_FILE = file;

assert.equal(maskApiKey(""), null);
assert.equal(maskApiKey("abcd"), "••••");
assert.equal(maskApiKey("abcdefghijklmnop"), "••••…mnop");
assert.equal(hasImmoweltApiKey(), false);

let threw = false;
try {
  saveImmoweltCredentials({ kundennummer: "", api_key: "12345678" });
} catch (e) {
  threw = true;
  assert.equal(e.code, "kundennummer_required");
}
assert.equal(threw, true);

threw = false;
try {
  saveImmoweltCredentials({ kundennummer: "12345", api_key: "" });
} catch (e) {
  threw = true;
  assert.equal(e.code, "api_key_required");
}
assert.equal(threw, true);

const saved = saveImmoweltCredentials({
  kundennummer: "998877",
  api_key: "super-secret-api-key-xyz",
});
assert.equal(saved.has_key, true);
assert.equal(saved.kundennummer, "998877");
assert.equal(saved.masked_key, "••••…-xyz");
assert.ok(!JSON.stringify(saved).includes("super-secret-api-key-xyz"));

const st = fs.statSync(file);
assert.equal(st.mode & 0o777, 0o600);

const full = readImmoweltCredentials();
assert.equal(full.api_key, "super-secret-api-key-xyz");

const kept = saveImmoweltCredentials({
  kundennummer: "998877",
  api_key: "",
  keep_existing_key: true,
});
assert.equal(kept.has_key, true);
assert.equal(readImmoweltCredentials().api_key, "super-secret-api-key-xyz");

const pub = getImmoweltCredentialsStatus();
assert.ok(!JSON.stringify(pub).includes("super-secret"));

fs.rmSync(tmp, { recursive: true, force: true });
console.log("test-immowelt-secrets: ok");

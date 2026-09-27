import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getSiteSettings,
  saveFlyerImmoNummer,
  getFlyerImmoNummer,
  writePublicFlyerSettings,
} from "./lib/site-settings.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "site-settings-"));
const file = path.join(tmp, "site-settings.json");
const siteRoot = path.join(tmp, "site");
fs.mkdirSync(path.join(siteRoot, "data"), { recursive: true });
process.env.EICHMANN_SITE_SETTINGS_FILE = file;
process.env.EICHMANN_SITE_ROOT = siteRoot;

assert.equal(getFlyerImmoNummer(), null);

const saved = saveFlyerImmoNummer("2800", { siteRoot });
assert.equal(saved.flyer_immo_nummer, "2800");
assert.equal(getFlyerImmoNummer(), "2800");

const st = fs.statSync(file);
assert.equal(st.mode & 0o777, 0o600);

const pubPath = path.join(siteRoot, "data", "flyer-settings.json");
assert.ok(fs.existsSync(pubPath));
const pub = JSON.parse(fs.readFileSync(pubPath, "utf8"));
assert.equal(pub.flyer_immo_nummer, "2800");

saveFlyerImmoNummer("", { siteRoot });
assert.equal(getFlyerImmoNummer(), null);
assert.equal(JSON.parse(fs.readFileSync(pubPath, "utf8")).flyer_immo_nummer, null);

let threw = false;
try {
  saveFlyerImmoNummer("bad nummer!", { siteRoot });
} catch (e) {
  threw = true;
  assert.equal(e.code, "flyer_immo_nummer_invalid");
}
assert.equal(threw, true);

writePublicFlyerSettings(siteRoot, "9999");
assert.equal(JSON.parse(fs.readFileSync(pubPath, "utf8")).flyer_immo_nummer, "9999");
// secrets store still null from clear above
assert.equal(getSiteSettings().flyer_immo_nummer, null);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("test-site-settings: ok");

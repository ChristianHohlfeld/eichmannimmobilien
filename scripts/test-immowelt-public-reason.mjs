import assert from "node:assert/strict";
import {
  publicImmoweltSyncReason,
  IMMOWELT_PUBLIC_REASON_DEFAULTS,
} from "./lib/immowelt-public-reason.mjs";

const pw =
  "browserType.launch: Executable doesn't exist at /root/.cache/ms-playwright/chromium_headless_shell-1194/chrome-headless-shell\n" +
  "╔══════════════════════════════════════════════════════╗\n" +
  "║ Looks like Playwright was just installed or updated. ║\n" +
  "║ Please run the following command to download new browsers: ║\n" +
  "║                                                      ║\n" +
  "║     npx playwright install                           ║\n" +
  "╚══════════════════════════════════════════════════════╝";

assert.equal(publicImmoweltSyncReason(pw, "rejected"), IMMOWELT_PUBLIC_REASON_DEFAULTS.rejected);
assert.equal(
  publicImmoweltSyncReason("DataDome blocked the request (HTTP 403)", "rejected"),
  IMMOWELT_PUBLIC_REASON_DEFAULTS.network
);
assert.equal(
  publicImmoweltSyncReason("Immowelt snapshot incomplete for abc – keeping last-known-good", "rejected"),
  IMMOWELT_PUBLIC_REASON_DEFAULTS.unsafe
);

const german =
  "Offizielle immowelt.de-API technisch erreichbar; accountgebundener API-Key ist noch nicht im Deployment hinterlegt. Last Known Good bleibt unverändert.";
assert.equal(publicImmoweltSyncReason(german, "awaiting_api_key"), german);
assert.equal(publicImmoweltSyncReason(null, "rejected"), IMMOWELT_PUBLIC_REASON_DEFAULTS.rejected);
assert.ok(!publicImmoweltSyncReason(pw).includes("playwright"));
assert.ok(!publicImmoweltSyncReason(pw).includes("/root/"));

console.log("test-immowelt-public-reason: ok");

#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const PORT = Number(process.env.EXPOSE_FORM_TEST_PORT || 8771);
const objektDir = join(ROOT, "objekt");
const file = readdirSync(objektDir).filter((x) => x.endsWith(".html")).sort()[0];
assert.ok(file, "No generated expose page found");
const path = "/objekt/" + file;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

const server = createServer((req, res) => {
  let p = decodeURIComponent((req.url || "/").split("?")[0]);
  const fp = join(ROOT, p.replace(/^\//, ""));
  if (!fp.startsWith(ROOT) || !existsSync(fp) || !statSync(fp).isFile()) {
    res.writeHead(404); res.end("not found"); return;
  }
  res.writeHead(200, { "Content-Type": MIME[extname(fp).toLowerCase()] || "application/octet-stream" });
  res.end(readFileSync(fp));
});
await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
let posted = null;
await context.route("https://forms.digitalisierungsplanung.de/v1/immobilieneichmann/expose", async (route) => {
  posted = JSON.parse(route.request().postData() || "{}");
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ success: true, requestId: "ci-test" }),
  });
});

const page = await context.newPage();
try {
  await page.goto("http://127.0.0.1:" + PORT + path, { waitUntil: "domcontentloaded" });

  const controls = await page.locator("#contact-form").evaluate((form) =>
    [...form.querySelectorAll("select, input, textarea")]
      .filter((el) => el.type !== "hidden" && !el.classList.contains("hp-field"))
      .map((el) => ({ name: el.name, type: el.type, required: el.required, placeholder: el.placeholder || "" }))
  );

  assert.deepEqual(
    controls.map((x) => x.name),
    ["anrede", "vorname", "name", "strasse", "plz", "ort", "phone", "email"],
    "Visible expose input set/order differs from BI reference flow"
  );
  assert.equal(await page.locator('#contact-form textarea').count(), 0, "Expose flow must not add a message field");
  assert.equal(await page.locator('#contact-form [name="privacy_ack"], #contact-form [name="datenschutz"]').count(), 0, "No redundant privacy checkbox");
  assert.equal(await page.locator("#contact-form").evaluate((f) => f.checkValidity()), false, "Empty expose form must be invalid");

  await page.selectOption('[name="anrede"]', "Herr");
  await page.fill('[name="vorname"]', "Technischer");
  await page.fill('[name="name"]', "Test");
  await page.fill('[name="strasse"]', "Teststraße 1");
  await page.fill('[name="plz"]', "78462");
  await page.fill('[name="ort"]', "Konstanz");
  await page.fill('[name="phone"]', "000000000");
  await page.fill('[name="email"]', "technical-test@example.com");
  assert.equal(await page.locator("#contact-form").evaluate((f) => f.checkValidity()), true, "Completed expose form must be valid");

  await page.click("#contact-submit");
  await page.waitForFunction(() => {
    const el = document.getElementById("form-success");
    return !!el && !el.hidden;
  });

  assert.ok(posted, "AJAX submission was not issued");
  for (const [key, value] of Object.entries({
    anrede: "Herr",
    vorname: "Technischer",
    name: "Test",
    strasse: "Teststraße 1",
    plz: "78462",
    ort: "Konstanz",
    phone: "000000000",
    email: "technical-test@example.com",
    anliegen: "Exposé-Anfrage",
  })) {
    assert.equal(posted[key], value, "Payload mismatch for " + key);
  }
  assert.ok(posted.objekt, "Object title missing from payload");
  assert.match(posted.objekt_url || "", /^https:\/\/immobilieneichmann\.de\/objekt\//, "Object URL missing/invalid");
  assert.equal(await page.locator("#contact-submit").textContent(), "Exposé anfragen", "Submit label not restored after send");

  console.log("PASS — expose input parity + validation + AJAX success flow verified:", path);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

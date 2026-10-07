#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadProjectsDocument,
  activeProjects,
  toPublicFlyerJson,
  buildProjectJsonLd,
  publishProjects,
  PROJECT_SEO_START,
  PROJECT_FACTS_START,
} from "./lib/projects.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function copyMinimalFixture(tmp) {
  const sot = await fs.readFile(path.join(root, "data/projects.json"), "utf8");
  await fs.mkdir(path.join(tmp, "data"), { recursive: true });
  await fs.mkdir(path.join(tmp, "ai"), { recursive: true });
  await fs.writeFile(path.join(tmp, "data/projects.json"), sot);
  const pageFixed = `<!DOCTYPE html><html lang="de"><head>
<!-- PROJECT-SEO:START -->
  <title>old</title>
  <script type="application/ld+json">{"@type":"BreadcrumbList"}</script>
<!-- PROJECT-SEO:END -->
</head><body><main>
<!-- PROJECT-FACTS:START -->
<section>old facts</section>
<!-- PROJECT-FACTS:END -->
</main></body></html>`;
  await fs.writeFile(path.join(tmp, "allmannsdorf.html"), pageFixed);
  await fs.writeFile(
    path.join(tmp, "index.html"),
    `<!DOCTYPE html><html><head><script type="application/ld+json">
{"@context":"https://schema.org","@graph":[{"@type":["RealEstateAgent","LocalBusiness"],"@id":"https://immobilieneichmann.de/#business","name":"Immobilien Eichmann"},{"@type":"WebSite","@id":"https://immobilieneichmann.de/#website"}]}
</script></head><body></body></html>`
  );
}

async function main() {
  const doc = await loadProjectsDocument(root);
  assert.equal(doc.schema, "eichmann.projects.sot/v1");
  const active = activeProjects(doc);
  assert.ok(active.length >= 1);
  const flyer = toPublicFlyerJson(active[0]);
  assert.equal(flyer.schema, "eichmann.flyer.ai/v1");
  assert.equal(flyer.unit_count, 44);
  const ld = buildProjectJsonLd(active[0]);
  const types = ld["@graph"].map((n) => n["@type"]);
  assert.ok(types.includes("RealEstateListing"));
  assert.ok(types.includes("ApartmentComplex"));

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "eich-projects-"));
  await copyMinimalFixture(tmp);
  const pub = await publishProjects({
    siteRoot: tmp,
    listings: [
      {
        active: true,
        detail_page: true,
        slug: "demo-slug",
        title: "Demo Wohnung",
        local_url: "objekt/demo-slug.html",
        price: "199.000 €",
      },
    ],
  });
  assert.equal(pub.active.length, 1);
  const flyerOut = JSON.parse(await fs.readFile(path.join(tmp, "ai/flyer-allmannsdorf.json"), "utf8"));
  assert.equal(flyerOut.unit_count, 44);
  const page = await fs.readFile(path.join(tmp, "allmannsdorf.html"), "utf8");
  assert.match(page, /RealEstateListing/);
  assert.match(page, /ApartmentComplex/);
  assert.match(page, /Neubau Konstanz-Allmannsdorf/);
  const index = await fs.readFile(path.join(tmp, "index.html"), "utf8");
  assert.match(index, /ItemList/);
  assert.match(index, /Demo Wohnung/);

  // deactivate → orphan remove
  const sot = JSON.parse(await fs.readFile(path.join(tmp, "data/projects.json"), "utf8"));
  sot.projects[0].active = false;
  await fs.writeFile(path.join(tmp, "data/projects.json"), JSON.stringify(sot, null, 2));
  await publishProjects({ siteRoot: tmp, listings: [] });
  await assert.rejects(() => fs.access(path.join(tmp, "ai/flyer-allmannsdorf.json")));
  await assert.rejects(() => fs.access(path.join(tmp, "allmannsdorf.html")));

  console.log("test-projects-publish: OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

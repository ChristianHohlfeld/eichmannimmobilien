#!/usr/bin/env node
/**
 * Smoke: MCP Streamable-HTTP tools against local ai/listings.json (no network needed).
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 19848 + Math.floor(Math.random() * 100);
const HOST = "127.0.0.1";

function rpc(method, params, id = 1) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path: "/mcp",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({ status: res.statusCode, json: JSON.parse(raw) });
          } catch (e) {
            reject(new Error(`bad json ${res.statusCode}: ${raw.slice(0, 200)}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function health() {
  return new Promise((resolve, reject) => {
    http
      .get(`http://${HOST}:${PORT}/health`, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            json: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          });
        });
      })
      .on("error", reject);
  });
}

const child = spawn(
  process.execPath,
  [path.join(root, "scripts", "mcp-server.mjs")],
  {
    env: {
      ...process.env,
      EICHMANN_SITE_ROOT: root,
      EICHMANN_MCP_HOST: HOST,
      EICHMANN_MCP_PORT: String(PORT),
      EICHMANN_MCP_CACHE_MS: "1000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }
);

let stderr = "";
child.stderr.on("data", (d) => {
  stderr += d.toString();
});

async function waitReady() {
  for (let i = 0; i < 40; i++) {
    try {
      const h = await health();
      if (h.status === 200 && h.json.ok) return h;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`MCP not ready. stderr=${stderr}`);
}

const errors = [];
function fail(m) {
  errors.push(m);
}

try {
  const h = await waitReady();
  if (!h.json.listing_count) fail("health missing listing_count");

  const init = await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "eichmann-test", version: "0.0.1" },
  });
  if (init.status !== 200) fail(`initialize status ${init.status}`);
  if (!init.json?.result?.serverInfo?.name) fail("initialize missing serverInfo");

  const tools = await rpc("tools/list", {}, 2);
  const names = (tools.json?.result?.tools || []).map((t) => t.name).sort();
  const expected = ["get_contact", "get_flyer", "get_listing", "search_listings"];
  if (names.join(",") !== expected.join(",")) {
    fail(`tools unexpected: ${names.join(",")}`);
  }

  const search = await rpc(
    "tools/call",
    { name: "search_listings", arguments: { location: "Wollmatingen", limit: 5 } },
    3
  );
  const searchText = search.json?.result?.content?.[0]?.text || "";
  const searchObj = JSON.parse(searchText);
  if (!searchObj.count || searchObj.count < 1) fail("search_listings empty for Wollmatingen");

  const slug = searchObj.listings[0].slug;
  const get = await rpc(
    "tools/call",
    { name: "get_listing", arguments: { slug } },
    4
  );
  const getObj = JSON.parse(get.json?.result?.content?.[0]?.text || "{}");
  if (!getObj.listing?.slug || getObj.listing.slug !== slug) {
    fail(`get_listing failed for ${slug}`);
  }

  const flyer = await rpc("tools/call", { name: "get_flyer", arguments: {} }, 5);
  const flyerObj = JSON.parse(flyer.json?.result?.content?.[0]?.text || "{}");
  if (flyerObj.flyer?.unit_count !== 44) {
    fail(`get_flyer unit_count expected 44 got ${flyerObj.flyer?.unit_count}`);
  }
  // UTM attribution on outbound page links (mcp-utm-v1)
  {
    const lUrl = String(getObj.listing?.url || "");
    if (!/[?&]utm_source=mcp&utm_medium=mcp&utm_campaign=objekte&utm_content=get_listing$/.test(lUrl)) fail(`get_listing url lacks UTM: ${lUrl}`);
    if (!lUrl.startsWith("https://immobilieneichmann.de/objekt/")) fail(`get_listing url host/path changed: ${lUrl}`);
    if (/utm_/.test(String(getObj.listing?.image || ""))) fail("image URL must not get UTM");
    const pages = flyerObj.flyer?.pages || {};
    const vorm = String(pages.contact_vormerkung || "");
    if (!/^https:\/\/immobilieneichmann\.de\/kontakt\.html\?interesse=allmannsdorf&utm_source=mcp&utm_medium=mcp&utm_campaign=allmannsdorf&utm_content=get_flyer#contact-form$/.test(vorm)) fail(`flyer vormerkung url wrong (query/fragment must stay): ${vorm}`);
    if (/utm_/.test(JSON.stringify(flyerObj.flyer?.images || {}))) fail("flyer image URLs must not get UTM");
    const rawText = flyer.json?.result?.content?.[0]?.text || "";
    if (/ai\/flyer-allmannsdorf\.json\?utm|llms\.txt\?utm/.test(rawText)) fail("data file URLs must stay canonical");
    if (!/kontakt\.html\?utm_source=mcp/.test(String(flyerObj.next_step_for_human || ""))) fail("free-text contact link lacks UTM");
    const listingsFile = fs.readFileSync(path.join(root, "ai", "listings.json"), "utf8");
    if (/utm_source=mcp/.test(listingsFile)) fail("ai/listings.json (canonical data) must not contain UTM");
  }
  if (!flyerObj.contact?.preferred?.tel?.includes("491705225568")) {
    fail("get_flyer missing prominent contact.preferred.tel");
  }
  if (!String(flyerObj.contact?.preferred?.whatsapp_url || "").includes("wa.me/491705225568")) {
    fail("get_flyer missing WhatsApp link");
  }
  const toolsList = tools.json?.result?.tools || [];
  const flyerDesc = toolsList.find((x) => x.name === "get_flyer")?.description || "";
  if (!/allmannsdorf/i.test(flyerDesc) || !/WhatsApp|tel/i.test(flyerDesc)) {
    fail("get_flyer description should mention Allmannsdorf + contact");
  }
  if (!/nicht selbst|Anti-Spam|nicht.*anrufen|Agent.*NICHT/i.test(flyerDesc)) {
    fail("get_flyer description missing anti-spam / no agent outbound");
  }

  const contact = await rpc("tools/call", { name: "get_contact", arguments: {} }, 15);
  const contactObj = JSON.parse(contact.json?.result?.content?.[0]?.text || "{}");
  if (!contactObj.contact?.preferred?.tel?.includes("491705225568")) {
    fail("get_contact missing tel");
  }
  if (!String(contactObj.contact?.preferred?.whatsapp_url || "").includes("wa.me")) {
    fail("get_contact missing whatsapp");
  }

  const neo = await rpc(
    "tools/call",
    { name: "search_listings", arguments: { q: "neubau allmannsdorf", limit: 5 } },
    16
  );
  const neoObj = JSON.parse(neo.json?.result?.content?.[0]?.text || "{}");
  if (!Array.isArray(neoObj.projects) || !neoObj.projects.some((p) => p.slug === "allmannsdorf")) {
    fail("search_listings neubau/allmannsdorf should surface projects[]");
  }
  const wohn = await rpc(
    "tools/call",
    { name: "search_listings", arguments: { q: "wohnung konstanz", limit: 5 } },
    17
  );
  const wohnObj = JSON.parse(wohn.json?.result?.content?.[0]?.text || "{}");
  if (!Array.isArray(wohnObj.projects) || !wohnObj.projects.length) {
    fail("search_listings 'wohnung konstanz' should surface Allmannsdorf project");
  }

  const initText = String(init.json?.result?.instructions || "");
  if (!/Anti-Spam|nicht selbst|WhatsApp/i.test(initText)) {
    fail("initialize instructions missing anti-spam contact rules");
  }

  // submit_inquiry is disabled: even a complete, consented call must not send anything.
  const inquiry = await rpc(
    "tools/call",
    {
      name: "submit_inquiry",
      arguments: {
        flow: "contact",
        name: "Test",
        email: "test@example.com",
        message: "x",
        privacy_consent: true,
      },
    },
    6
  );
  const inqRes = inquiry.json?.result || {};
  if (!inqRes.isError) fail("submit_inquiry must be disabled (isError)");
  if (inqRes.structuredContent?.disabled !== true) fail("submit_inquiry missing disabled:true");
  if (inqRes.structuredContent?.next_tool !== "get_contact") fail("submit_inquiry should point to get_contact");
  if (!String(inqRes.structuredContent?.contact_for_human?.contact_form || "").includes("kontakt.html")) {
    fail("submit_inquiry should link the website contact form");
  }
  const serverSrc = fs.readFileSync(path.join(root, "scripts", "mcp-server.mjs"), "utf8");
  if (/forms\.digitalisierungsplanung\.de|EICHMANN_FORMS_BASE/.test(serverSrc)) {
    fail("mcp-server.mjs must not reference the forms endpoint (submit_inquiry disabled)");
  }

  if (errors.length) {
    console.error(`MCP smoke FAILED (${errors.length}):`);
    errors.forEach((e) => console.error(" -", e));
    process.exitCode = 1;
  } else {
    console.log(
      `MCP OK: health=${h.json.listing_count} flyer=${flyerObj.flyer.unit_count} search=${searchObj.count} get=${slug} tools=${names.join(",")} port=${PORT}`
    );
  }
} catch (err) {
  console.error("MCP smoke ERROR:", err);
  process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 100));
  try {
    child.kill("SIGKILL");
  } catch {
    /* ignore */
  }
}

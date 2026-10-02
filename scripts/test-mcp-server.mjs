#!/usr/bin/env node
/**
 * Smoke: MCP Streamable-HTTP tools against local ai/listings.json (no network needed).
 */
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
  if (names.join(",") !== "get_listing,search_listings") {
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

  if (errors.length) {
    console.error(`MCP smoke FAILED (${errors.length}):`);
    errors.forEach((e) => console.error(" -", e));
    process.exitCode = 1;
  } else {
    console.log(
      `MCP OK: health=${h.json.listing_count} search=${searchObj.count} get=${slug} port=${PORT}`
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

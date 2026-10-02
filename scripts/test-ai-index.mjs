#!/usr/bin/env node
/**
 * Smoke: ai/listings.json spiegelt dieselben öffentlichen Objekte wie index.html + objekt/.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAiListingsDocument,
  hasPublicDetail,
  isPublicListing,
} from "./lib/ai-discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];

function fail(msg) {
  errors.push(msg);
}

const dataPath = path.join(root, "data", "listings.json");
const aiPath = path.join(root, "ai", "listings.json");
const indexHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");
const data = JSON.parse(fs.readFileSync(dataPath, "utf8"));

if (!fs.existsSync(aiPath)) fail("ai/listings.json fehlt — npm run ai:index ausführen");
const ai = JSON.parse(fs.readFileSync(aiPath, "utf8"));

const expected = buildAiListingsDocument(data);
const expectedSlugs = new Set(expected.listings.map((L) => L.slug).filter(Boolean));
const aiSlugs = new Set((ai.listings || []).map((L) => L.slug).filter(Boolean));

if (ai.listing_count !== expected.listing_count) {
  fail(`listing_count ai=${ai.listing_count} expected=${expected.listing_count}`);
}

for (const s of expectedSlugs) {
  if (!aiSlugs.has(s)) fail(`AI-Index fehlt slug aus data: ${s}`);
}
for (const s of aiSlugs) {
  if (!expectedSlugs.has(s)) fail(`AI-Index hat Extra-slug: ${s}`);
}

// index.html hrefs
const hrefs = [...indexHtml.matchAll(/href="(objekt\/[^"]+\.html)"/g)].map((m) => m[1]);
const indexSlugs = new Set(hrefs.map((h) => h.replace(/^objekt\//, "").replace(/\.html$/, "")));
for (const s of indexSlugs) {
  if (!aiSlugs.has(s)) fail(`index.html Objekt nicht im AI-Index: ${s}`);
}
for (const s of aiSlugs) {
  if (!indexSlugs.has(s)) fail(`AI-Index slug nicht in index.html: ${s}`);
}

// objekt/ HTML files
const objektDir = path.join(root, "objekt");
const files = fs.existsSync(objektDir)
  ? fs.readdirSync(objektDir).filter((f) => f.endsWith(".html"))
  : [];
const fileSlugs = new Set(files.map((f) => f.replace(/\.html$/, "")));
for (const s of aiSlugs) {
  if (!fileSlugs.has(s)) fail(`AI-Index slug ohne objekt/*.html: ${s}`);
}
for (const s of fileSlugs) {
  if (!aiSlugs.has(s)) fail(`objekt/*.html ohne AI-Index Eintrag: ${s}`);
}

// Discovery files exist
for (const rel of [
  "llms.txt",
  "agents.txt",
  ".well-known/mcp.json",
  ".well-known/mcp/catalog.json",
  "ai/server-card.json",
]) {
  if (!fs.existsSync(path.join(root, rel))) fail(`fehlt: ${rel}`);
}

const llms = fs.readFileSync(path.join(root, "llms.txt"), "utf8");
if (!llms.includes("/ai/listings.json")) fail("llms.txt ohne Link zu ai/listings.json");
if (!llms.includes("Helmut Eichmann")) fail("llms.txt ohne Helmut Eichmann");
if (!llms.includes("info@immobilien-eichmann.com")) fail("llms.txt ohne E-Mail");
if (!llms.includes("wa.me/491705225568")) fail("llms.txt ohne WhatsApp-Link");
if (!llms.includes("get_contact")) fail("llms.txt ohne get_contact");
if (!/Anti-Spam|nicht selbst/i.test(llms)) fail("llms.txt ohne Anti-Spam-Hinweis");
const mcpDisc = JSON.parse(fs.readFileSync(path.join(root, ".well-known/mcp.json"), "utf8"));
const toolNames = (mcpDisc.tools || []).map((x) => x.name);
for (const n of ["get_flyer", "get_contact", "search_listings", "submit_inquiry"]) {
  if (!toolNames.includes(n)) fail(`mcp.json fehlt Tool ${n}`);
}
for (const L of ai.listings) {
  if (L.url && !llms.includes(L.url) && !llms.includes(L.slug)) {
    fail(`llms.txt ohne Objekt ${L.slug}`);
  }
}

const robots = fs.readFileSync(path.join(root, "robots.txt"), "utf8");
if (!/ai\/listings\.json/i.test(robots) && !/llms\.txt/i.test(robots)) {
  fail("robots.txt erwähnt AI-Discovery nicht");
}

// data filter sanity
const publicFromData = data.listings.filter(hasPublicDetail);
if (publicFromData.length !== ai.listing_count) {
  fail(`hasPublicDetail count ${publicFromData.length} != ai ${ai.listing_count}`);
}

// no inactive in AI index
for (const raw of data.listings) {
  if (!isPublicListing(raw) && aiSlugs.has(raw.slug)) {
    fail(`inaktives/hidden Listing im AI-Index: ${raw.slug}`);
  }
}

if (errors.length) {
  console.error(`AI-Index smoke FAILED (${errors.length}):`);
  errors.forEach((e) => console.error(" -", e));
  process.exit(1);
}
console.log(
  `AI-Index OK: ${ai.listing_count} Objekte = data(public) = index.html = objekt/ HTML`
);

#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
const bareAmp = /&(?!amp;|lt;|gt;|quot;|#\d+;|#x[0-9a-f]+;)/i;
let errors = [];
let checked = 0;

function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === ".git") continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p);
    else if (ent.name.endsWith(".html")) {
      const html = fs.readFileSync(p, "utf8");
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(html))) {
        checked++;
        const body = m[1];
        if (bareAmp.test(body)) {
          errors.push(`${path.relative(root, p)}: bare & in JSON-LD (HTML-unsafe)`);
        }
        try {
          JSON.parse(body);
        } catch (e) {
          errors.push(`${path.relative(root, p)}: ${e.message}`);
        }
      }
    }
  }
}
walk(root);
const soft = process.env.STRICT !== "1";
if (errors.length) {
  console.error(`JSON-LD issues (${errors.length}/${checked}):`);
  errors.forEach((e) => console.error(" -", e));
  process.exit(soft ? 0 : 1);
}
console.log(`JSON-LD OK: ${checked} blocks`);

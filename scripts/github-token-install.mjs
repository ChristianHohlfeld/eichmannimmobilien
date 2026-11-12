#!/usr/bin/env node
/**
 * Store the GitHub token the admin area uses to start the "verify live" workflow.
 * STDIN only, never printed. File: /var/lib/eichmann/secrets/github-dispatch.json (0600).
 * The token needs exactly one right: Actions read/write on this repository (fine-grained token).
 * Optional: without a token the review is still renewed every night by the workflow's own schedule; the
 * token only lets the button in the admin area start one at once. Never store a token that can do more
 * than that one right on that one repository.   --remove deletes the stored token, --status shows whether one is stored.
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./lib/immowelt/config.mjs";

const file = loadConfig().dispatchTokenFile;
if (process.argv.includes("--status")) {
  console.log(JSON.stringify({ file, has_token: fs.existsSync(file) }));
  process.exit(0);
}
if (process.argv.includes("--remove")) {
  // the review is renewed every night without it; "Jetzt prüfen" then only runs the server's own check
  const had = fs.existsSync(file);
  fs.rmSync(file, { force: true });
  console.log(JSON.stringify({ file, has_token: false, removed: had }));
  process.exit(0);
}
if (process.stdin.isTTY) {
  console.error("Token wird nur über STDIN angenommen (Pipe).");
  process.exit(2);
}
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const token = input.trim();
if (!/^[A-Za-z0-9_]{20,400}$/.test(token)) {
  console.error("Nicht gespeichert: Eingabe sieht nicht wie ein GitHub-Token aus.");
  process.exit(1);
}
fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
const tmp = `${file}.tmp-${process.pid}`;
fs.writeFileSync(tmp, `${JSON.stringify({ token, updated_at: new Date().toISOString() })}\n`, { mode: 0o600 });
fs.renameSync(tmp, file);
console.log(JSON.stringify({ file, has_token: true }));

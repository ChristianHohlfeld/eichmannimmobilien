#!/usr/bin/env node
/**
 * Seal a GitHub token into admin/config.json using the admin password.
 * Usage:
 *   node admin/seal-token.mjs --password 'secret'
 *   node admin/seal-token.mjs --password 'secret' --token 'github_pat_…'
 * Default token: `gh auth token`
 */
import { createHash, pbkdf2Sync, randomBytes, createCipheriv } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, "config.json");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

const password = arg("--password");
if (!password) {
  console.error("Usage: node admin/seal-token.mjs --password '…' [--token '…']");
  process.exit(1);
}

const token =
  arg("--token") ||
  execSync("gh auth token", { encoding: "utf8" }).trim();

const iterations = 120000;
const salt = randomBytes(16);
const iv = randomBytes(12);
const key = pbkdf2Sync(password, salt, iterations, 32, "sha256");
const cipher = createCipheriv("aes-256-gcm", key, iv);
const enc = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
const tag = cipher.getAuthTag();
const sealed = Buffer.concat([Buffer.from([1]), salt, iv, tag, enc]).toString("base64");
const hash = createHash("sha256").update(password, "utf8").digest("hex");

let config = {};
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
} catch {
  config = {};
}

config.password_sha256 = hash;
config.github_token_sealed = sealed;
config.kdf = { name: "PBKDF2", hash: "SHA-256", iterations };
config.repo = config.repo || "ChristianHohlfeld/eichmannimmobilien";
config.branch = config.branch || "main";
config.listings_path = config.listings_path || "data/listings.json";
config.assets_prefix = config.assets_prefix || "assets/listings";
config.workflow_file = config.workflow_file || "sync-immowelt.yml";
config.admin_save_workflow = config.admin_save_workflow || "admin-save.yml";
config.note =
  "Nur SHA-256 und versiegelter Token. Klartext-Passwort nie committen. Immowelt-Konto bleibt unberührt.";

writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
console.log("Updated", configPath);
console.log("password_sha256", hash);
console.log("Do NOT commit the plaintext password.");

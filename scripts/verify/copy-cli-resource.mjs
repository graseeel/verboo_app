#!/usr/bin/env node
// Copies the bundled `@verboo/code` CLI (cli.mjs) into src-tauri/resources/
// so `tauri build` picks it up as a bundled resource.
//
// Run automatically by `build:tauri` before `cargo tauri build`.
// Skips silently if the source CLI is not installed (dev-only builds).

import { copyFile, mkdir, stat, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const source = join(root, "node_modules", "@verboo", "code", "dist", "cli.mjs");
const targetDir = join(root, "src-tauri", "resources");
const target = join(targetDir, "cli.mjs");

if (!existsSync(source)) {
  console.warn(`[copy-cli-resource] Source not found: ${source}`);
  console.warn(`[copy-cli-resource] Skipping CLI bundling. The app will fall back to 'verboo' on PATH.`);
  process.exit(0);
}

await mkdir(targetDir, { recursive: true });

const sourceSize = (await stat(source)).size;
if (sourceSize < 1024) {
  console.error(`[copy-cli-resource] Source cli.mjs is suspiciously small (${sourceSize} bytes). Aborting.`);
  process.exit(1);
}

await copyFile(source, target);
console.log(`[copy-cli-resource] Copied ${sourceSize} bytes → ${target}`);

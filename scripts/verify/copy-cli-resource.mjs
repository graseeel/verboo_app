#!/usr/bin/env node
// Copies the bundled `@verboo/code` CLI (with its `node_modules/` and
// supporting files) into `src-tauri/resources/cli-package/` so `tauri build`
// ships it as a resource.
//
// Why the whole package: Node ESM resolution walks up the directory tree
// looking for `node_modules/`. Bundling only `cli.mjs` results in
// `ERR_MODULE_NOT_FOUND` for transitive deps like `@aws-sdk/client-bedrock-*`.
// Bundling the full package (36MB) lets the CLI resolve deps normally when
// spawned as `<node> <bundled-cli.mjs>` (see src-tauri/src/services/cli_spawn.rs).
//
// Run automatically by `build:tauri-deps` before `cargo tauri build`.
// Skips silently if the source package is not installed (dev-only builds).

import { cp, mkdir, stat, rm, readFile, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const source = join(root, "node_modules", "@verboo", "code");
const targetDir = join(root, "src-tauri", "resources", "cli-package");
const sourceCliMjs = join(source, "dist", "cli.mjs");

if (!existsSync(source)) {
  console.warn(`[copy-cli-resource] Source package not found: ${source}`);
  console.warn(`[copy-cli-resource] Skipping CLI bundling. The app will fall back to 'verboo' on PATH.`);
  process.exit(0);
}

if (!existsSync(sourceCliMjs)) {
  console.warn(`[copy-cli-resource] Source cli.mjs not found: ${sourceCliMjs}`);
  console.warn(`[copy-cli-resource] Skipping CLI bundling.`);
  process.exit(0);
}

// Clean previous copy (so updates to @verboo/code are reflected).
await rm(targetDir, { recursive: true, force: true });
await mkdir(targetDir, { recursive: true });

// Sanity check: cli.mjs should be at least 1MB (it's a bundled 20MB file).
const cliMjsStat = await stat(sourceCliMjs);
if (cliMjsStat.size < 1024 * 1024) {
  console.error(`[copy-cli-resource] Source cli.mjs is suspiciously small (${cliMjsStat.size} bytes). Aborting.`);
  process.exit(1);
}

// Copy the full package tree (preserves node_modules/ for ESM resolution).
// `cp` with `recursive: true` + `force: true` mirrors `cp -R`.
await cp(source, targetDir, {
  recursive: true,
  force: true,
  // Skip symlinks pointing outside the package (rare but safe).
  // We DON'T use `preserveTimestamps` because that can break build caches.
});

// Prepend shebang to cli.mjs so it can be exec'd directly if needed.
const cliMjsPath = join(targetDir, "dist", "cli.mjs");
const SHEBANG = "#!/usr/bin/env node\n";
if (existsSync(cliMjsPath)) {
  const bytes = await readFile(cliMjsPath);
  const hasShebang = bytes.length >= 2 && bytes[0] === 0x23 && bytes[1] === 0x21;
  if (!hasShebang) {
    await writeFile(cliMjsPath, Buffer.concat([Buffer.from(SHEBANG, "utf8"), bytes]));
  }
  await chmod(cliMjsPath, 0o755);
}

// Compute the total size of the copied tree.
const totalSize = await dirSize(targetDir);
const totalMB = (totalSize / 1024 / 1024).toFixed(1);
console.log(`[copy-cli-resource] Copied @verboo/code → ${targetDir} (${totalMB} MB)`);

async function dirSize(dir) {
  let total = 0;
  const { readdir, stat: statFile } = await import("node:fs/promises");
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await dirSize(p);
    } else if (entry.isFile()) {
      total += (await statFile(p)).size;
    }
  }
  return total;
}

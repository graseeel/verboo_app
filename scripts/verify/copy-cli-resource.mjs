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

import { cp, mkdir, stat, rm, rename, readFile, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// FS errors that are typically transient under iCloud's file provider:
// the provider re-materializes "dataless" files mid-rmdir, so a single
// recursive rm can trip ENOTEMPTY/EBUSY. Retry these with backoff.
const TRANSIENT_FS_ERRORS = new Set([
  "ENOTEMPTY",
  "EBUSY",
  "ENOTDIR",
  "EPERM",
  "EACCES",
]);

// robustRm: rm(path, { recursive, force }) with bounded retry for transient
// FS errors (iCloud re-materialization). If retries exhaust, fall back to
// renaming path to a sibling .trash-<n> dir (best-effort cleanup, never
// aborts the build). Happy path (rm succeeds on first try) is unchanged.
async function robustRm(path) {
  const MAX_ATTEMPTS = 5;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return; // success
    } catch (err) {
      lastErr = err;
      if (!TRANSIENT_FS_ERRORS.has(err.code)) throw err; // non-transient: propagate
      if (attempt === MAX_ATTEMPTS) break;
      // Backoff: 100, 200, 400, 500 ms (capped at 500).
      const delay = Math.min(100 * 2 ** (attempt - 1), 500);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  // Retries exhausted on a transient error: rename to a .trash-<n> sibling
  // and let the build proceed. Best-effort cleanup; never aborts the build.
  const base = `${path}.trash`;
  let trashPath = `${base}-0`;
  let counter = 0;
  while (existsSync(trashPath)) {
    counter++;
    trashPath = `${base}-${counter}`;
  }
  try {
    await rename(path, trashPath);
    console.warn(`[copy-cli-resource] Retries exhausted; moved ${path} → ${trashPath} (best-effort cleanup).`);
    // Best-effort: try to delete the trash dir in the background. Don't await.
    rm(trashPath, { recursive: true, force: true }).catch(() => {
      /* swallow — best-effort */
    });
  } catch (renameErr) {
    // Rename also failed (e.g. EXDEV cross-device, or path already gone).
    // If the target no longer exists, treat as success (nothing to remove).
    if (renameErr.code === "ENOENT") return;
    // Otherwise surface the original FS error (more informative than the
    // rename failure) so the build fails with the real root cause.
    throw lastErr;
  }
}

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
// Use robustRm: iCloud's file provider can re-materialize "dataless" files
// mid-rmdir, tripping ENOTEMPTY/EBUSY on a single rm. Retries + rename-to-trash
// fallback keep the build reliable without aborting on transient FS races.
await robustRm(targetDir);
await mkdir(targetDir, { recursive: true });

// Sanity check: cli.mjs should be at least 1MB (it's a bundled 20MB file).
const cliMjsStat = await stat(sourceCliMjs);
if (cliMjsStat.size < 1024 * 1024) {
  console.error(`[copy-cli-resource] Source cli.mjs is suspiciously small (${cliMjsStat.size} bytes). Aborting.`);
  process.exit(1);
}

// 1. Copy the @verboo/code package itself (dist/, package.json, any nested
//    node_modules) into cli-package/.
await cp(source, targetDir, { recursive: true, force: true });

// 2. Copy the FULL production dependency closure. npm hoists @verboo/code's
//    hundreds of transitive deps to the ROOT node_modules, so copying only the
//    package (step 1) misses them and the CLI crashes with ERR_MODULE_NOT_FOUND
//    (e.g. `@aws-sdk/client-bedrock-runtime`). BFS the closure from package.json
//    and copy each dep from the hoisted root node_modules into the bundle.
const rootModules = join(root, "node_modules");
const bundleModules = join(targetDir, "node_modules");

async function readPkgJson(dir) {
  try {
    return JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

const rootPkg = await readPkgJson(source);
const seen = new Set();
const queue = Object.keys({
  ...(rootPkg?.dependencies ?? {}),
  ...(rootPkg?.optionalDependencies ?? {}),
});
const closure = [];
while (queue.length) {
  const name = queue.shift();
  if (seen.has(name)) continue;
  seen.add(name);
  const pj = await readPkgJson(join(rootModules, ...name.split("/")));
  if (!pj) continue; // optional/peer dep not installed — skip
  closure.push(name);
  for (const d of Object.keys({
    ...(pj.dependencies ?? {}),
    ...(pj.optionalDependencies ?? {}),
  })) {
    if (!seen.has(d)) queue.push(d);
  }
}

await mkdir(bundleModules, { recursive: true });
for (const name of closure) {
  const src = join(rootModules, ...name.split("/"));
  const dst = join(bundleModules, ...name.split("/"));
  await mkdir(dirname(dst), { recursive: true });
  await cp(src, dst, { recursive: true, force: true });
}
console.log(`[copy-cli-resource] Copied ${closure.length} dependency packages into the bundle.`);

// 3. Prepend shebang to cli.mjs so it can be exec'd directly if needed.
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

// 3b. NEVER let the bundled Desktop CLI rewrite the user's global install.
// Headless `--print` calls startBackgroundHousekeeping → autoUpdateCliInBackground
// which runs `npm install -g @verboo/code` when baked version < npm latest.
// That path ignores DISABLE_AUTOUPDATER (≤0.10.7). Patch the bundled copy only
// (not the user's global CLI) so chat never mutates /opt/homebrew/bin/verboo.
if (existsSync(cliMjsPath)) {
  let cliText = await readFile(cliMjsPath, "utf8");
  const needle = "async function autoUpdateCliInBackground() {";
  const guard =
    "async function autoUpdateCliInBackground() {\n  // Desktop bundle: never mutate global/user CLI installs.\n  return;";
  if (cliText.includes(needle) && !cliText.includes("Desktop bundle: never mutate global/user CLI installs")) {
    cliText = cliText.replace(needle, guard);
    await writeFile(cliMjsPath, cliText, "utf8");
    console.log(`[copy-cli-resource] ✓ Disabled headless autoUpdateCliInBackground in bundled CLI`);
  } else if (!cliText.includes(needle)) {
    console.warn(
      `[copy-cli-resource] WARN: autoUpdateCliInBackground not found — headless global npm install may still run`,
    );
  }
}

// 4. VERIFY the bundle actually runs. Safety net: if any dep is missing,
//    `node cli.mjs --version` throws ERR_MODULE_NOT_FOUND and we FAIL the build
//    loudly instead of shipping a silently-broken CLI (the exact bug we hit).
try {
  const out = execFileSync(process.execPath, [cliMjsPath, "--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000,
  });
  console.log(`[copy-cli-resource] ✓ Bundled CLI runs: ${out.trim()}`);
} catch (err) {
  const detail = (err.stderr || err.message || "").toString().split("\n").slice(0, 8).join("\n");
  console.error(`[copy-cli-resource] ✗ FATAL: bundled CLI failed to run — dependency closure incomplete:`);
  console.error(detail);
  process.exit(1);
}

// 5. Report the total size.
const totalSize = await dirSize(targetDir);
const totalMB = (totalSize / 1024 / 1024).toFixed(1);
console.log(`[copy-cli-resource] Bundled @verboo/code → ${targetDir} (${totalMB} MB)`);

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

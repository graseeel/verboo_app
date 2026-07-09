#!/usr/bin/env node
// Removes iCloud-generated conflict copies ("* 2.*" or "* 2") from the
// bundled cli-package directory. iCloud Desktop/Documents sync re-creates
// these duplicates over time, inflating file counts and tripping tauri_build's
// rerun-if-changed limit (error 60 / "argument list too long").
//
// Run automatically at the start of `build:tauri-deps` (before
// copy-cli-resource.mjs) so every build starts from a clean tree.
//
// Patterns matched (basename only):
//   - ends in " 2" (no extension)            → "foo 2"
//   - matches /^.* 2\.[^.]+$/                → "foo 2.js", "foo 2.mjs"
//   - matches /^.* 2 .*\.[^.]+$/             → "foo 2 bar.js" (rare)
//
// Dry-run support: DEDUP_DRY_RUN=1 prints what would be removed without deleting.

import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const targetDir = join(root, "src-tauri", "resources", "cli-package");

const DRY_RUN = process.env.DEDUP_DRY_RUN === "1";

// Match basenames that look like iCloud conflict copies.
const CONFLICT_RE = /^.* 2(?: .*)?\.[^.]+$/; // "foo 2.js", "foo 2 bar.js"
const CONFLICT_NO_EXT_RE = /^.* 2$/;          // "foo 2" (no extension)

function isConflictCopy(name) {
  return CONFLICT_RE.test(name) || CONFLICT_NO_EXT_RE.test(name);
}

let removed = 0;
let scanned = 0;

async function walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return; // dir doesn't exist — nothing to dedup
    throw err;
  }
  for (const entry of entries) {
    scanned++;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (isConflictCopy(entry.name)) {
        if (DRY_RUN) {
          console.log(`[dedup] DRY-RUN would remove dir: ${full}`);
          removed++;
        } else {
          await rm(full, { recursive: true, force: true });
          removed++;
        }
      } else {
        await walk(full);
      }
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      if (isConflictCopy(entry.name)) {
        if (DRY_RUN) {
          console.log(`[dedup] DRY-RUN would remove file: ${full}`);
          removed++;
        } else {
          await rm(full, { force: true });
          removed++;
        }
      }
    }
  }
}

const start = Date.now();
await walk(targetDir);
const ms = Date.now() - start;

if (removed === 0) {
  console.log(`[dedup-cli-package] Clean. Scanned ${scanned} entries, no iCloud conflict copies found (${ms}ms).`);
} else {
  console.log(`[dedup-cli-package] Removed ${removed} iCloud conflict cop${removed === 1 ? "y" : "ies"} from ${targetDir} (${ms}ms).`);
}

#!/usr/bin/env node
// Copies the bundled `@verboo/code` CLI (cli.mjs) into src-tauri/resources/
// so `tauri build` picks it up as a bundled resource.
//
// Run automatically by `build:tauri` before `cargo tauri build`.
// Skips silently if the source CLI is not installed (dev-only builds).
//
// The copy is made executable (0755) and given a shebang so the OS can
// exec it directly via `#!/usr/bin/env node`. Without this, the bundled
// file is mode 0644 with no shebang and `cli_path::resolve()` correctly
// falls through to the PATH-installed `verboo`.

import { readFile, writeFile, mkdir, stat, chmod } from "node:fs/promises";
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

// Read source, prepend shebang if missing, write to target.
const sourceBytes = await readFile(source);
const SHEBANG = "#!/usr/bin/env node\n";
const hasShebang = sourceBytes.length >= 2 && sourceBytes[0] === 0x23 && sourceBytes[1] === 0x21;
const outBytes = hasShebang ? sourceBytes : Buffer.concat([Buffer.from(SHEBANG, "utf8"), sourceBytes]);
await writeFile(target, outBytes);

// chmod +x so the OS can exec it directly.
await chmod(target, 0o755);

console.log(`[copy-cli-resource] Copied ${outBytes.length} bytes → ${target} (mode 0755, shebang: ${hasShebang ? "preserved" : "added"})`);

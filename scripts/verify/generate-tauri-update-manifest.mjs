#!/usr/bin/env node
// Generates Tauri updater manifests (`latest-*.json` and `latest*.json`)
// from a directory of build artifacts. Produces the Tauri-shaped manifests
// that `tauri-plugin-updater` reads at runtime.
//
// Usage:
//   node scripts/verify/generate-tauri-update-manifest.mjs \
//     --tag v0.3.0-beta.1 \
//     --version 0.3.0-beta.1 \
//     --prerelease true \
//     --bundles-dir bundles \
//     --output update-manifests

import { readdir, writeFile, mkdir, stat, readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";

const args = parseArgs(process.argv.slice(2));
const tag = args.tag;
const version = args.version;
const prerelease = args.prerelease === "true" || args.prerelease === true;
const bundlesDir = args["bundles-dir"];
const outputDir = args.output;

if (!tag || !version || !bundlesDir || !outputDir) {
  console.error(
    "Missing required args: --tag, --version, --bundles-dir, --output"
  );
  process.exit(2);
}

await mkdir(outputDir, { recursive: true });

const files = await readdir(bundlesDir).catch(() => []);
if (files.length === 0) {
  console.error(`No files found in ${bundlesDir}`);
  process.exit(1);
}

const RELEASE_URL = `https://github.com/graseeel/verboo_app/releases/download/${tag}`;

const platformMap = {
  ".dmg": "macos",
  ".app": "macos", // bundled inside .dmg, skip — not a downloadable URL
  ".exe": "windows",
  ".msi": "windows",
  ".AppImage": "linux",
  ".deb": "linux",
};

// Group files by platform. Skip `.app` bundles — they're directories, not
// downloadable URLs (they ship inside the `.dmg`).
const byPlatform = { macos: [], windows: [], linux: [] };
for (const f of files) {
  // Determine platform from lowercased extension.
  const lower = f.toLowerCase();
  let platform = null;
  let ext = null;
  if (lower.endsWith(".dmg")) {
    platform = "macos";
    ext = ".dmg";
  } else if (lower.endsWith(".exe")) {
    platform = "windows";
    ext = ".exe";
  } else if (lower.endsWith(".msi")) {
    platform = "windows";
    ext = ".msi";
  } else if (lower.endsWith(".appimage")) {
    platform = "linux";
    ext = ".AppImage";
  } else if (lower.endsWith(".deb")) {
    platform = "linux";
    ext = ".deb";
  }
  if (platform && ext) {
    byPlatform[platform].push({ path: join(bundlesDir, f), name: f });
  } else {
    console.log(`Skipping ${f} (unrecognized platform)`);
  }
}

async function fileInfo(path) {
  const data = await readFile(path);
  const s = await stat(path);
  return {
    size: s.size,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}

function pickPrimary(platform, files) {
  // Prefer .dmg > .exe > .AppImage (the user-facing installer per platform).
  const order =
    platform === "macos"
      ? [".dmg"]
      : platform === "windows"
      ? [".exe", ".msi"]
      : [".AppImage", ".deb"];
  for (const ext of order) {
    const match = files.find((f) =>
      f.name.toLowerCase().endsWith(ext.toLowerCase())
    );
    if (match) return { match, ext };
  }
  return null;
}

const manifests = [];
for (const [platform, list] of Object.entries(byPlatform)) {
  if (list.length === 0) continue;
  const picked = pickPrimary(platform, list);
  if (!picked) continue;
  const info = await fileInfo(picked.match.path);
  const manifest = {
    version,
    notes: `Release ${tag}`,
    pub_date: new Date().toISOString(),
    platforms: {
      [platform === "macos"
        ? "darwin"
        : platform === "windows"
        ? "windows"
        : "linux"]: {
        signature: "", // Reserved for future signed updates; unsigned for now.
        url: `${RELEASE_URL}/${picked.match.name}`,
        size: info.size,
        // `tauri-plugin-updater` infers the file type from the URL extension.
        // Older versions required `contentType`; v2 reads the URL directly.
      },
    },
  };
  manifests.push({ platform, manifest });
}

if (manifests.length === 0) {
  console.error("No platform manifests could be built from the artifacts");
  process.exit(1);
}

// Write one manifest per platform AND a top-level `latest.json` that is the
// native-Tauri default URL. This matches the convention documented in the
// `updater.endpoints` config in `tauri.conf.json`.
for (const { platform, manifest } of manifests) {
  const filename =
    platform === "macos"
      ? "latest-mac.json"
      : platform === "windows"
      ? "latest-win.json"
      : "latest-linux.json";
  const out = join(outputDir, filename);
  await writeFile(out, JSON.stringify(manifest, null, 2));
  console.log(`✓ Wrote ${out}`);
}

// Also write a combined `latest.json` (linux shape, since it's the default
// `tauri updater build --bundles` output for `linux-x86_64`). The Tauri
// `tauri.conf.json` updater endpoints list points at the latest.json in the
// root of the release as a fallback.
await writeFile(
  join(outputDir, "latest.json"),
  JSON.stringify(manifests[0].manifest, null, 2)
);
console.log(`✓ Wrote ${join(outputDir, "latest.json")}`);

// `--prerelease true` ⇒ suffix files with `-beta` so the updater can pick
// the right channel.
if (prerelease) {
  for (const { platform, manifest } of manifests) {
    const filename =
      platform === "macos"
        ? "latest-mac-beta.json"
        : platform === "windows"
        ? "latest-win-beta.json"
        : "latest-linux-beta.json";
    await writeFile(
      join(outputDir, filename),
      JSON.stringify(manifest, null, 2)
    );
  }
  console.log("✓ Wrote prerelease variants");
}

function parseArgs(arr) {
  const out = {};
  for (let i = 0; i < arr.length; i++) {
    if (arr[i].startsWith("--")) {
      const key = arr[i].slice(2);
      const val = arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : true;
      out[key] = val;
      if (val !== true) i++;
    }
  }
  return out;
}

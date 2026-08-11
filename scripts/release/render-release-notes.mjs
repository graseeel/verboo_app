#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { readReleaseCatalog, validateReleaseCatalog } from "./release-catalog.mjs";

export function renderReleaseNotes(entry, version) {
  const copy = entry["en-US"];
  const highlights = copy.items.flatMap((item) => [
    `- **${item.title}**`,
    `  ${item.body}`,
  ]);
  return [
    `## Verboo Code ${version}`,
    "",
    copy.summary,
    "",
    "### What's new",
    "",
    ...highlights,
    "",
    "### Download the right file",
    "",
    "| Your computer | Download |",
    "|---|---|",
    `| **macOS Apple Silicon** (M1 / M2 / M3 / M4) | \`Verboo-Code-${version}-macOS-Apple-Silicon.dmg\` |`,
    `| **macOS Intel** | \`Verboo-Code-${version}-macOS-Intel.dmg\` |`,
    `| **Windows 10/11 (64-bit)** | \`Verboo-Code-${version}-Windows-x64-Setup.exe\` |`,
    `| **Linux (AppImage, any distro)** | \`Verboo-Code-${version}-Linux-x64.AppImage\` |`,
    `| **Linux Debian/Ubuntu** | \`Verboo-Code-${version}-Linux-x64.deb\` |`,
    `| **Linux Fedora/RHEL** | \`Verboo-Code-${version}-Linux-x64.rpm\` |`,
    "",
    "> Tip: on a Mac, open **Apple menu → About This Mac**. If the chip says Apple M…, pick **Apple Silicon**.",
    "",
    "Assets appear as each platform build finishes.",
    "",
  ].join("\n");
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    result[values[index]?.replace(/^--/, "")] = values[index + 1];
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.version || !args.output) {
    throw new Error("usage: render-release-notes.mjs --version <version> --output <path>");
  }
  const catalog = await readReleaseCatalog();
  const entry = validateReleaseCatalog(catalog, args.version);
  await writeFile(args.output, renderReleaseNotes(entry, args.version));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

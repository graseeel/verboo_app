#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { buildUpdateManifest } from "./update-manifest.mjs";

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    if (!values[index].startsWith("--")) continue;
    parsed[values[index].slice(2)] = values[index + 1];
    index += 1;
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));
for (const key of ["tag", "version", "bundles-dir", "output"]) {
  if (!args[key]) throw new Error(`Missing --${key}`);
}

const manifest = await buildUpdateManifest({
  tag: args.tag,
  version: args.version,
  bundlesDir: args["bundles-dir"],
  releaseBaseUrl: `https://github.com/graseeel/verboo_app/releases/download/${args.tag}`,
});

await mkdir(args.output, { recursive: true });
await writeFile(
  join(args.output, "latest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

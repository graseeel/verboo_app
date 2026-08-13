#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  assertCanonicalVersion,
  EDITORIAL_SENTINEL,
  RELEASE_LOCALES,
} from "./release-catalog.mjs";

function editorialLocale() {
  return {
    title: EDITORIAL_SENTINEL,
    summary: EDITORIAL_SENTINEL,
    items: Array.from({ length: 4 }, () => ({
      title: EDITORIAL_SENTINEL,
      body: EDITORIAL_SENTINEL,
    })),
  };
}

export function scaffoldReleaseVersion(catalog, version) {
  assertCanonicalVersion(version);
  if (catalog?.schemaVersion !== 1 || !catalog.releases || typeof catalog.releases !== "object") {
    throw new Error("release catalog must use schemaVersion 1 and contain releases");
  }
  if (catalog.releases[version]) {
    throw new Error(`release ${version} already exists in the catalog`);
  }
  const next = structuredClone(catalog);
  next.releases[version] = Object.fromEntries(
    RELEASE_LOCALES.map((locale) => [locale, editorialLocale()]),
  );
  return next;
}

async function main() {
  const version = process.argv[2];
  if (!version) throw new Error("usage: npm run release:prepare -- <version>");
  const path = "release-notes/releases.json";
  const catalog = JSON.parse(await readFile(path, "utf8"));
  const next = scaffoldReleaseVersion(catalog, version);
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`);
  process.stdout.write(`Scaffolded editorial fields for ${version} in ${path}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

import { readFile } from "node:fs/promises";

export const EDITORIAL_SENTINEL = "EDITORIAL_COPY_REQUIRED";
export const RELEASE_LOCALES = Object.freeze(["pt-BR", "en-US"]);
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function assertCanonicalVersion(version) {
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    throw new Error(`release version must be canonical semantic version: ${String(version)}`);
  }
  return version;
}

function assertReviewedText(value, path) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be non-empty`);
  }
  if (value.includes(EDITORIAL_SENTINEL)) {
    throw new Error(`${path} still requires reviewed editorial copy`);
  }
}

function validateLocale(copy, path) {
  if (!copy || typeof copy !== "object" || Array.isArray(copy)) {
    throw new Error(`${path} must be an object`);
  }
  assertReviewedText(copy.title, `${path}.title`);
  assertReviewedText(copy.summary, `${path}.summary`);
  if (!Array.isArray(copy.items) || copy.items.length < 4 || copy.items.length > 6) {
    throw new Error(`${path}.items must contain four to six highlights`);
  }
  copy.items.forEach((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${path}.items[${index}] must be an object`);
    }
    assertReviewedText(item.title, `${path}.items[${index}].title`);
    assertReviewedText(item.body, `${path}.items[${index}].body`);
  });
  return copy;
}

export function releaseEntry(catalog, version) {
  assertCanonicalVersion(version);
  const entry = catalog?.releases?.[version];
  if (!entry) throw new Error(`release catalog has no entry for ${version}`);
  return entry;
}

export function validateReleaseCatalog(catalog, version) {
  if (catalog?.schemaVersion !== 1) {
    throw new Error("release catalog schemaVersion must be 1");
  }
  const entry = releaseEntry(catalog, version);
  for (const locale of RELEASE_LOCALES) {
    validateLocale(entry[locale], `releases.${version}.${locale}`);
  }
  return entry;
}

export async function readReleaseCatalog(path = "release-notes/releases.json") {
  return JSON.parse(await readFile(path, "utf8"));
}

import assert from "node:assert/strict";
import test from "node:test";

import {
  EDITORIAL_SENTINEL,
  readReleaseCatalog,
  releaseEntry,
  validateReleaseCatalog,
} from "./release-catalog.mjs";
import { renderReleaseNotes } from "./render-release-notes.mjs";

test("0.7.0-beta has complete reviewed pt-BR and en-US copy", async () => {
  const catalog = await readReleaseCatalog();
  const entry = validateReleaseCatalog(catalog, "0.7.0-beta");

  assert.equal(entry["pt-BR"].items.length, 6);
  assert.equal(entry["en-US"].items.length, 6);
  assert.match(entry["pt-BR"].items[0].title, /Simulador de iOS/);
  assert.match(entry["en-US"].items[0].title, /iOS Simulator/);
  assert.deepEqual(releaseEntry(catalog, "0.7.0-beta"), entry);
});

test("rejects missing locale, editorial sentinel, and invalid item count", async () => {
  const original = await readReleaseCatalog();

  const missingLocale = structuredClone(original);
  delete missingLocale.releases["0.7.0-beta"]["en-US"];
  assert.throws(
    () => validateReleaseCatalog(missingLocale, "0.7.0-beta"),
    /en-US/,
  );

  const sentinel = structuredClone(original);
  sentinel.releases["0.7.0-beta"]["pt-BR"].summary = EDITORIAL_SENTINEL;
  assert.throws(
    () => validateReleaseCatalog(sentinel, "0.7.0-beta"),
    /editorial copy/i,
  );

  const tooShort = structuredClone(original);
  tooShort.releases["0.7.0-beta"]["en-US"].items = tooShort.releases["0.7.0-beta"]["en-US"].items.slice(0, 3);
  assert.throws(
    () => validateReleaseCatalog(tooShort, "0.7.0-beta"),
    /four to six/i,
  );
});

test("rejects non-canonical release versions", async () => {
  const catalog = await readReleaseCatalog();
  assert.throws(() => validateReleaseCatalog(catalog, "v0.7.0-beta"), /canonical/i);
  assert.throws(() => validateReleaseCatalog(catalog, "0.7"), /canonical/i);
});

test("renders GitHub notes from the reviewed English catalog entry", async () => {
  const catalog = await readReleaseCatalog();
  const entry = validateReleaseCatalog(catalog, "0.7.0-beta");
  const markdown = renderReleaseNotes(entry, "0.7.0-beta");

  assert.match(markdown, /^## Verboo Code 0\.7\.0-beta/m);
  assert.match(markdown, /Built-in iOS Simulator — macOS/);
  assert.match(markdown, /A much lighter installation/);
  assert.match(markdown, /Verboo-Code-0\.7\.0-beta-Windows-x64-Setup\.exe/);
  assert.doesNotMatch(markdown, /EDITORIAL_COPY_REQUIRED/);
});

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

test("0.7.1-beta has complete reviewed hotfix copy", async () => {
  const catalog = await readReleaseCatalog();
  const entry = validateReleaseCatalog(catalog, "0.7.1-beta");

  assert.equal(entry["pt-BR"].items.length, 4);
  assert.equal(entry["en-US"].items.length, 4);
  assert.match(entry["pt-BR"].items[0].title, /Claude e Codex/);
  assert.match(entry["en-US"].items[2].title, /compatible with Claude and Codex/);
  assert.deepEqual(releaseEntry(catalog, "0.7.1-beta"), entry);
});

test("0.7.2-beta has complete reviewed provider hotfix copy", async () => {
  const catalog = await readReleaseCatalog();
  const entry = validateReleaseCatalog(catalog, "0.7.2-beta");

  assert.equal(entry["pt-BR"].items.length, 4);
  assert.equal(entry["en-US"].items.length, 4);
  assert.match(entry["pt-BR"].items[0].title, /MCPs atualizados/);
  assert.match(entry["en-US"].items[1].title, /Claude and Codex/);
  assert.deepEqual(releaseEntry(catalog, "0.7.2-beta"), entry);
});

test("0.7.3-beta has complete reviewed release copy", async () => {
  const catalog = await readReleaseCatalog();
  const entry = validateReleaseCatalog(catalog, "0.7.3-beta");

  assert.equal(entry["pt-BR"].items.length, 4);
  assert.equal(entry["en-US"].items.length, 4);
  assert.match(entry["pt-BR"].items[0].title, /Login no Windows/);
  assert.match(entry["en-US"].items[1].title, /BOM-less/);
  assert.deepEqual(releaseEntry(catalog, "0.7.3-beta"), entry);
});

test("0.8.0-beta has complete reviewed Android Simulator release copy", async () => {
  const catalog = await readReleaseCatalog();
  const entry = validateReleaseCatalog(catalog, "0.8.0-beta");

  assert.equal(entry["pt-BR"].items.length, 5);
  assert.equal(entry["en-US"].items.length, 5);
  assert.match(entry["pt-BR"].items[0].title, /Simulador de Android/);
  assert.match(entry["en-US"].items[0].title, /Android Simulator/);
  assert.deepEqual(releaseEntry(catalog, "0.8.0-beta"), entry);
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
  const entry = validateReleaseCatalog(catalog, "0.7.2-beta");
  const markdown = renderReleaseNotes(entry, "0.7.2-beta");

  assert.match(markdown, /^## Verboo Code 0\.7\.2-beta/m);
  assert.match(markdown, /MCPs updated with the app/);
  assert.match(markdown, /Migration without another sign-in/);
  assert.match(markdown, /Verboo-Code-0\.7\.2-beta-Windows-x64-Setup\.exe/);
  assert.doesNotMatch(markdown, /EDITORIAL_COPY_REQUIRED/);
});

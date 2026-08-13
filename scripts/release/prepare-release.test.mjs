import assert from "node:assert/strict";
import test from "node:test";

import { EDITORIAL_SENTINEL, validateReleaseCatalog } from "./release-catalog.mjs";
import { scaffoldReleaseVersion } from "./prepare-release.mjs";

const emptyCatalog = { schemaVersion: 1, releases: {} };

test("scaffolds both locales with four explicit editorial sentinels", () => {
  const next = scaffoldReleaseVersion(emptyCatalog, "0.8.0-beta");
  const entry = next.releases["0.8.0-beta"];

  assert.equal(entry["pt-BR"].title, EDITORIAL_SENTINEL);
  assert.equal(entry["en-US"].title, EDITORIAL_SENTINEL);
  assert.equal(entry["pt-BR"].items.length, 4);
  assert.equal(entry["en-US"].items.length, 4);
  assert.throws(
    () => validateReleaseCatalog(next, "0.8.0-beta"),
    /editorial copy/i,
  );
});

test("refuses to overwrite an existing release", () => {
  const once = scaffoldReleaseVersion(emptyCatalog, "0.8.0-beta");
  assert.throws(
    () => scaffoldReleaseVersion(once, "0.8.0-beta"),
    /already exists/i,
  );
});

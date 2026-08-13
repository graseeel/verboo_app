import assert from "node:assert/strict";
import test from "node:test";

import { verifyReleaseVersions } from "./verify-release-version.mjs";

const reviewedLocale = {
  title: "Reviewed title",
  summary: "Reviewed summary",
  items: Array.from({ length: 4 }, (_, index) => ({
    title: `Highlight ${index + 1}`,
    body: `Reviewed body ${index + 1}`,
  })),
};

const reviewedCatalog = {
  schemaVersion: 1,
  releases: {
    "0.6.0-beta.1": {
      "pt-BR": structuredClone(reviewedLocale),
      "en-US": structuredClone(reviewedLocale),
    },
  },
};

test("accepts one identical tag/package/cargo/tauri version", () => {
  assert.doesNotThrow(() =>
    verifyReleaseVersions({
      tag: "v0.6.0-beta.1",
      packageVersion: "0.6.0-beta.1",
      cargoVersion: "0.6.0-beta.1",
      tauriVersion: "0.6.0-beta.1",
      catalog: reviewedCatalog,
    }),
  );
});

test("rejects any version mismatch", () => {
  assert.throws(
    () =>
      verifyReleaseVersions({
        tag: "v0.6.0",
        packageVersion: "0.6.0",
        cargoVersion: "0.5.2",
        tauriVersion: "0.6.0",
        catalog: reviewedCatalog,
      }),
    /Cargo.*0\.5\.2.*0\.6\.0/i,
  );
});

test("requires a canonical v-prefixed release tag", () => {
  assert.throws(
    () =>
      verifyReleaseVersions({
        tag: "0.6.0",
        packageVersion: "0.6.0",
        cargoVersion: "0.6.0",
        tauriVersion: "0.6.0",
        catalog: reviewedCatalog,
      }),
    /release tag/i,
  );
});

test("rejects a matching version that has no reviewed catalog entry", () => {
  assert.throws(
    () => verifyReleaseVersions({
      tag: "v0.6.0-beta.2",
      packageVersion: "0.6.0-beta.2",
      cargoVersion: "0.6.0-beta.2",
      tauriVersion: "0.6.0-beta.2",
      catalog: reviewedCatalog,
    }),
    /no entry/i,
  );
});

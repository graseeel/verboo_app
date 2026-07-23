import assert from "node:assert/strict";
import test from "node:test";

import { verifyReleaseVersions } from "./verify-release-version.mjs";

test("accepts one identical tag/package/cargo/tauri version", () => {
  assert.doesNotThrow(() =>
    verifyReleaseVersions({
      tag: "v0.6.0-beta.1",
      packageVersion: "0.6.0-beta.1",
      cargoVersion: "0.6.0-beta.1",
      tauriVersion: "0.6.0-beta.1",
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
      }),
    /release tag/i,
  );
});

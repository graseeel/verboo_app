import assert from "node:assert/strict";
import { mkdtemp, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildUpdateManifest } from "./update-manifest.mjs";

const artifacts = {
  "darwin-aarch64": "Verboo-Code-1.2.3-darwin-aarch64.app.tar.gz",
  "darwin-x86_64": "Verboo-Code-1.2.3-darwin-x86_64.app.tar.gz",
  "windows-x86_64": "Verboo-Code-1.2.3-windows-x86_64.nsis.zip",
  "linux-x86_64": "Verboo-Code-1.2.3-linux-x86_64.AppImage.tar.gz",
};

async function completeFixture() {
  const dir = await mkdtemp(join(tmpdir(), "verboo-update-manifest-"));
  for (const file of Object.values(artifacts)) {
    await writeFile(join(dir, file), "signed updater bytes");
    await writeFile(join(dir, `${file}.sig`), `signature:${file}`);
  }
  return dir;
}

test("builds one deterministic manifest for all supported targets", async () => {
  const bundlesDir = await completeFixture();
  const manifest = await buildUpdateManifest({
    tag: "v1.2.3",
    version: "1.2.3",
    bundlesDir,
    releaseBaseUrl:
      "https://github.com/graseeel/verboo_app/releases/download/v1.2.3",
    publishedAt: "2026-07-22T18:00:00.000Z",
  });

  assert.deepEqual(Object.keys(manifest.platforms), Object.keys(artifacts));
  assert.equal(manifest.version, "1.2.3");
  assert.equal(
    manifest.platforms["darwin-aarch64"].signature,
    `signature:${artifacts["darwin-aarch64"]}`,
  );
});

test("rejects a missing signature", async () => {
  const bundlesDir = await completeFixture();
  await unlink(
    join(bundlesDir, `${artifacts["windows-x86_64"]}.sig`),
  );

  await assert.rejects(
    buildUpdateManifest({
      tag: "v1.2.3",
      version: "1.2.3",
      bundlesDir,
      releaseBaseUrl:
        "https://github.com/graseeel/verboo_app/releases/download/v1.2.3",
    }),
    /missing signature.*windows-x86_64/i,
  );
});

test("rejects an empty signature", async () => {
  const bundlesDir = await completeFixture();
  await writeFile(
    join(bundlesDir, `${artifacts["windows-x86_64"]}.sig`),
    "",
  );

  await assert.rejects(
    buildUpdateManifest({
      tag: "v1.2.3",
      version: "1.2.3",
      bundlesDir,
      releaseBaseUrl:
        "https://github.com/graseeel/verboo_app/releases/download/v1.2.3",
    }),
    /empty signature.*windows-x86_64/i,
  );
});

test("rejects a missing supported target", async () => {
  const bundlesDir = await completeFixture();
  await unlink(join(bundlesDir, artifacts["linux-x86_64"]));

  await assert.rejects(
    buildUpdateManifest({
      tag: "v1.2.3",
      version: "1.2.3",
      bundlesDir,
      releaseBaseUrl:
        "https://github.com/graseeel/verboo_app/releases/download/v1.2.3",
    }),
    /missing updater artifact.*linux-x86_64/i,
  );
});

test("rejects mismatched tags and non-HTTPS URLs", async () => {
  const bundlesDir = await completeFixture();

  await assert.rejects(
    buildUpdateManifest({
      tag: "v1.2.4",
      version: "1.2.3",
      bundlesDir,
      releaseBaseUrl:
        "https://github.com/graseeel/verboo_app/releases/download/v1.2.4",
    }),
    /tag.*version/i,
  );
  await assert.rejects(
    buildUpdateManifest({
      tag: "v1.2.3",
      version: "1.2.3",
      bundlesDir,
      releaseBaseUrl: "http://example.test/v1.2.3",
    }),
    /https/i,
  );
});

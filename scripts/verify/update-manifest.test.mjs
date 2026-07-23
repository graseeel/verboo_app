import assert from "node:assert/strict";
import { mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildUpdateManifest } from "./update-manifest.mjs";

const artifacts = {
  "darwin-aarch64-app": "Verboo-Code-1.2.3-darwin-aarch64.app.tar.gz",
  "darwin-x86_64-app": "Verboo-Code-1.2.3-darwin-x86_64.app.tar.gz",
  "windows-x86_64-nsis": "Verboo-Code-1.2.3-windows-x86_64-setup.exe",
  "linux-x86_64-appimage": "Verboo-Code-1.2.3-linux-x86_64.AppImage",
  "linux-x86_64-deb": "Verboo-Code-1.2.3-linux-x86_64.deb",
  "linux-x86_64-rpm": "Verboo-Code-1.2.3-linux-x86_64.rpm",
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
    manifest.platforms["darwin-aarch64-app"].signature,
    `signature:${artifacts["darwin-aarch64-app"]}`,
  );
  assert.match(
    manifest.platforms["linux-x86_64-appimage"].url,
    /\.AppImage$/,
  );
  assert.match(manifest.platforms["linux-x86_64-deb"].url, /\.deb$/);
  assert.match(manifest.platforms["linux-x86_64-rpm"].url, /\.rpm$/);
});

test("rejects a missing signature", async () => {
  const bundlesDir = await completeFixture();
  await unlink(
    join(bundlesDir, `${artifacts["windows-x86_64-nsis"]}.sig`),
  );

  await assert.rejects(
    buildUpdateManifest({
      tag: "v1.2.3",
      version: "1.2.3",
      bundlesDir,
      releaseBaseUrl:
        "https://github.com/graseeel/verboo_app/releases/download/v1.2.3",
    }),
    /missing signature.*windows-x86_64-nsis/i,
  );
});

test("rejects an empty signature", async () => {
  const bundlesDir = await completeFixture();
  await writeFile(
    join(bundlesDir, `${artifacts["windows-x86_64-nsis"]}.sig`),
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
    /empty signature.*windows-x86_64-nsis/i,
  );
});

test("rejects a missing supported target", async () => {
  const bundlesDir = await completeFixture();
  await unlink(join(bundlesDir, artifacts["linux-x86_64-rpm"]));

  await assert.rejects(
    buildUpdateManifest({
      tag: "v1.2.3",
      version: "1.2.3",
      bundlesDir,
      releaseBaseUrl:
        "https://github.com/graseeel/verboo_app/releases/download/v1.2.3",
    }),
    /missing updater artifact.*linux-x86_64-rpm/i,
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

test("release workflow publishes native v2 artifacts for every installer", async () => {
  const workflow = await readFile(".github/workflows/tauri-release.yml", "utf8");

  assert.doesNotMatch(workflow, /\*\.nsis\.zip/);
  assert.doesNotMatch(workflow, /\*\.AppImage\.tar\.gz/);
  assert.match(workflow, /windows-x86_64-setup\.exe/);
  assert.match(workflow, /linux-x86_64\.AppImage/);
  assert.match(workflow, /linux-x86_64\.deb/);
  assert.match(workflow, /linux-x86_64\.rpm/);
  assert.match(workflow, /tauri signer sign/);
  assert.match(workflow, /node --test scripts\/verify\/update-manifest\.test\.mjs/);
  assert.match(workflow, /PIPESTATUS\[0\]/);
  assert.match(
    workflow,
    /does not match the public key from.*exit 1/s,
  );
});

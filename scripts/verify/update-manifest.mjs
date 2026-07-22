import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

export const TARGET_ARTIFACTS = Object.freeze({
  "darwin-aarch64": (version) =>
    `Verboo-Code-${version}-darwin-aarch64.app.tar.gz`,
  "darwin-x86_64": (version) =>
    `Verboo-Code-${version}-darwin-x86_64.app.tar.gz`,
  "windows-x86_64": (version) =>
    `Verboo-Code-${version}-windows-x86_64.nsis.zip`,
  "linux-x86_64": (version) =>
    `Verboo-Code-${version}-linux-x86_64.AppImage.tar.gz`,
});

export async function buildUpdateManifest({
  tag,
  version,
  bundlesDir,
  releaseBaseUrl,
  publishedAt = new Date().toISOString(),
}) {
  if (tag !== `v${version}`) {
    throw new Error(`release tag ${tag} does not match version ${version}`);
  }

  const baseUrl = new URL(releaseBaseUrl);
  if (baseUrl.protocol !== "https:") {
    throw new Error("update release URL must use HTTPS");
  }

  const files = new Set(await readdir(bundlesDir));
  const platforms = {};

  for (const [target, makeName] of Object.entries(TARGET_ARTIFACTS)) {
    const artifact = makeName(version);
    const signatureFile = `${artifact}.sig`;

    if (!files.has(artifact)) {
      throw new Error(`missing updater artifact for ${target}: ${artifact}`);
    }
    if (!files.has(signatureFile)) {
      throw new Error(`missing signature for ${target}: ${signatureFile}`);
    }

    const signature = (
      await readFile(join(bundlesDir, signatureFile), "utf8")
    ).trim();
    if (!signature) {
      throw new Error(`empty signature for ${target}: ${signatureFile}`);
    }

    platforms[target] = {
      signature,
      url: `${releaseBaseUrl.replace(/\/$/, "")}/${encodeURIComponent(
        basename(artifact),
      )}`,
    };
  }

  return {
    version,
    notes: `Verboo Code ${version}`,
    pub_date: publishedAt,
    platforms,
  };
}

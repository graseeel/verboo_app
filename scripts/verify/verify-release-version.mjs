import { readFile } from "node:fs/promises";

export function verifyReleaseVersions({
  tag,
  packageVersion,
  cargoVersion,
  tauriVersion,
}) {
  if (!tag?.startsWith("v") || tag.length === 1) {
    throw new Error(`release tag must be v-prefixed: ${tag ?? "missing"}`);
  }

  const expected = tag.slice(1);
  for (const [source, actual] of Object.entries({
    package: packageVersion,
    Cargo: cargoVersion,
    Tauri: tauriVersion,
  })) {
    if (actual !== expected) {
      throw new Error(
        `${source} version ${actual} does not match release ${expected}`,
      );
    }
  }
  return expected;
}

async function main() {
  const tagIndex = process.argv.indexOf("--tag");
  const tag = tagIndex >= 0 ? process.argv[tagIndex + 1] : undefined;
  if (!tag) throw new Error("Missing --tag");

  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const tauriConfig = JSON.parse(
    await readFile("src-tauri/tauri.conf.json", "utf8"),
  );
  const cargo = await readFile("src-tauri/Cargo.toml", "utf8");
  const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (!cargoVersion) throw new Error("Cargo package version not found");

  verifyReleaseVersions({
    tag,
    packageVersion: packageJson.version,
    cargoVersion,
    tauriVersion: tauriConfig.version,
  });
}

if (process.argv[1]?.endsWith("verify-release-version.mjs")) {
  await main();
}

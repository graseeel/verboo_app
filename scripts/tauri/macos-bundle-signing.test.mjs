import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseCodesignRequirement,
  signMacosExternalBinaries,
  stableSidecarIdentifier,
  verifyMacosAppBundle,
} from "./macos-bundle-signing.mjs";

const sidecars = [
  "verboo-in-chrome",
  "verboo-ios-simulator",
  "verboo-android-emulator",
  "verboo-ffmpeg",
  "verboo-ffprobe",
  "verboo-whisper",
];

async function writeMachO(target) {
  await writeFile(target, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]));
}

async function makeBundleFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "verboo-signing-"));
  const appPath = path.join(root, "Verboo Code.app");
  const macosDir = path.join(appPath, "Contents", "MacOS");
  await mkdir(macosDir, { recursive: true });
  await writeMachO(path.join(macosDir, "verboo-desktop"));
  for (const sidecar of sidecars) {
    await writeMachO(path.join(macosDir, sidecar));
  }
  return { appPath, macosDir };
}

function developerSignature(identifier) {
  return {
    authority: "Developer ID Application: Gabriel Grasel de Moura (6444BXPL32)",
    identifier,
    requirement: `identifier "${identifier}" and anchor apple generic`,
    signature: "signed",
    teamIdentifier: "6444BXPL32",
  };
}

test("parses the designated requirement when codesign writes it to stdout", () => {
  const requirement = parseCodesignRequirement({
    stderr: "Executable=/Applications/Verboo Code.app/Contents/MacOS/verboo-desktop\n",
    stdout: 'designated => identifier "ai.verboo.code.desktop" and anchor apple generic\n',
  });

  assert.equal(
    requirement,
    'identifier "ai.verboo.code.desktop" and anchor apple generic',
  );
});

test("uses the stable sidecar identifiers emitted by the Tauri bundler", () => {
  for (const sidecar of sidecars) {
    assert.equal(stableSidecarIdentifier(sidecar), sidecar);
  }
});

test("signs every configured macOS sidecar with an explicit stable identifier", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "verboo-sidecars-"));
  for (const sidecar of sidecars) {
    await writeMachO(path.join(root, `${sidecar}-aarch64-apple-darwin`));
  }

  const calls = [];
  const signed = await signMacosExternalBinaries({
    binaryDir: root,
    identity: "Developer ID Application: Test (TEAM123456)",
    keychain: "/tmp/test.keychain-db",
    platform: "darwin",
    runCodesign: async (args) => calls.push(args),
  });

  assert.deepEqual(signed.map((entry) => entry.name).sort(), [...sidecars].sort());
  assert.equal(calls.length, sidecars.length);
  for (const sidecar of sidecars) {
    const call = calls.find((args) => args.at(-1).endsWith(`${sidecar}-aarch64-apple-darwin`));
    assert.ok(call, `${sidecar} must be signed`);
    assert.deepEqual(call.slice(0, 7), [
      "--force",
      "--options",
      "runtime",
      "--timestamp",
      "--identifier",
      stableSidecarIdentifier(sidecar),
      "--sign",
    ]);
    assert.ok(call.includes("--keychain"));
  }
});

test("rejects an ad hoc nested executable even when deep verification succeeds", async () => {
  const { appPath } = await makeBundleFixture();
  const inspectCode = async (target) => {
    if (target.endsWith("verboo-ios-simulator") || target.endsWith("verboo-android-emulator")) {
      return {
        authority: "",
        identifier: "verboo_ios_simulator-62192f8c36efd836",
        requirement: 'cdhash H"de2cd628ac2d2bde436115aaaf344b03b71d9675"',
        signature: "adhoc",
        teamIdentifier: "not set",
      };
    }
    const name = path.basename(target);
    const identifier = target.endsWith(".app")
      ? "ai.verboo.code.desktop"
      : name === "verboo-desktop"
        ? "ai.verboo.code.desktop"
        : stableSidecarIdentifier(name);
    return developerSignature(identifier);
  };

  await assert.rejects(
    verifyMacosAppBundle({
      appPath,
      inspectCode,
      platform: "darwin",
      verifyDeep: async () => {},
    }),
    /verboo-ios-simulator.*ad hoc|verboo-android-emulator.*ad hoc/i,
  );
});

test("accepts a bundle only when the app and every Mach-O share stable Developer ID trust", async () => {
  const { appPath } = await makeBundleFixture();
  const inspected = [];
  const inspectCode = async (target) => {
    inspected.push(target);
    const name = path.basename(target);
    const identifier = target.endsWith(".app")
      ? "ai.verboo.code.desktop"
      : name === "verboo-desktop"
        ? "ai.verboo.code.desktop"
        : stableSidecarIdentifier(name);
    return developerSignature(identifier);
  };

  const result = await verifyMacosAppBundle({
    appPath,
    inspectCode,
    platform: "darwin",
    verifyDeep: async () => {},
  });

  assert.equal(result.teamIdentifier, "6444BXPL32");
  assert.equal(result.machOFiles.length, sidecars.length + 1);
  assert.ok(inspected.includes(appPath));
  for (const sidecar of sidecars) {
    assert.ok(inspected.some((target) => target.endsWith(sidecar)));
  }
});

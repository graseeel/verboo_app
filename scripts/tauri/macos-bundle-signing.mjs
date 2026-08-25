import { execFile as execFileCallback } from "node:child_process";
import { open, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);

const APP_IDENTIFIER = "ai.verboo.code.desktop";
const MAIN_EXECUTABLE = "verboo-desktop";
const SIDECARS = [
  "verboo-in-chrome",
  "verboo-ios-simulator",
  "verboo-android-emulator",
  "verboo-ffmpeg",
  "verboo-ffprobe",
  "verboo-whisper",
];
const MACH_O_MAGICS = new Set([
  0xfeedface,
  0xcefaedfe,
  0xfeedfacf,
  0xcffaedfe,
  0xcafebabe,
  0xbebafeca,
  0xcafebabf,
  0xbfbafeca,
]);

export function stableSidecarIdentifier(name) {
  if (!SIDECARS.includes(name)) {
    throw new Error(`Unsupported macOS sidecar: ${name}`);
  }
  return name;
}

async function runCodesign(args) {
  await execFile("/usr/bin/codesign", args, { maxBuffer: 4 * 1024 * 1024 });
}

export async function signMacosExternalBinaries({
  binaryDir,
  identity,
  keychain,
  platform = process.platform,
  runCodesign: executeCodesign = runCodesign,
}) {
  if (platform !== "darwin") return [];
  if (!identity?.trim()) {
    throw new Error(
      "APPLE_SIGNING_IDENTITY is required for a macOS release build; refusing to create ad hoc sidecars",
    );
  }

  const entries = await readdir(binaryDir, { withFileTypes: true });
  const signed = [];

  for (const name of SIDECARS) {
    const pattern = new RegExp(`^${name}-(?:aarch64|x86_64)-apple-darwin$`);
    const matches = entries
      .filter((entry) => entry.isFile() && pattern.test(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name));
    if (matches.length === 0) {
      throw new Error(`Missing macOS sidecar before signing: ${name}`);
    }

    for (const entry of matches) {
      const target = path.join(binaryDir, entry.name);
      const args = [
        "--force",
        "--options",
        "runtime",
        "--timestamp",
        "--identifier",
        stableSidecarIdentifier(name),
        "--sign",
        identity,
      ];
      if (keychain?.trim()) args.push("--keychain", keychain);
      args.push(target);
      await executeCodesign(args);
      signed.push({ name, path: target });
    }
  }

  return signed;
}

export function parseCodesignRequirement({ stdout = "", stderr = "" }) {
  return `${stdout}\n${stderr}`
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.includes("designated =>"))
    ?.replace(/^#?\s*designated =>\s*/, "") ?? "";
}

async function inspectCodeWithCodesign(target) {
  const [{ stderr: display }, requirementResult] = await Promise.all([
    execFile("/usr/bin/codesign", ["-dv", "--verbose=4", target], {
      maxBuffer: 4 * 1024 * 1024,
    }),
    execFile("/usr/bin/codesign", ["-d", "-r-", target], {
      maxBuffer: 4 * 1024 * 1024,
    }),
  ]);
  const value = (key) => {
    const match = display.match(new RegExp(`^${key}=(.*)$`, "m"));
    return match?.[1]?.trim() ?? "";
  };
  const authority = display.match(/^Authority=(Developer ID Application:.*)$/m)?.[1]?.trim() ?? "";
  const requirement = parseCodesignRequirement(requirementResult);
  return {
    authority,
    identifier: value("Identifier"),
    requirement,
    signature: value("Signature") || "signed",
    teamIdentifier: value("TeamIdentifier"),
  };
}

async function verifyDeepWithCodesign(appPath) {
  await execFile(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", "--verbose=2", appPath],
    { maxBuffer: 4 * 1024 * 1024 },
  );
}

async function isMachO(target) {
  const handle = await open(target, "r");
  try {
    const bytes = Buffer.alloc(4);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    return bytesRead === 4 && MACH_O_MAGICS.has(bytes.readUInt32BE(0));
  } finally {
    await handle.close();
  }
}

async function collectMachOFiles(directory) {
  const result = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      result.push(...await collectMachOFiles(target));
    } else if (entry.isFile() && await isMachO(target)) {
      result.push(target);
    }
  }
  return result.sort();
}

function assertDeveloperIdentity({ signature, target, teamIdentifier }) {
  const label = path.basename(target);
  if (signature.signature.toLowerCase() === "adhoc" || signature.teamIdentifier === "not set") {
    throw new Error(`${label} has an ad hoc signature; every packaged Mach-O must use Developer ID`);
  }
  if (!signature.authority.startsWith("Developer ID Application:")) {
    throw new Error(`${label} is not signed by a Developer ID Application identity`);
  }
  if (!signature.teamIdentifier || signature.teamIdentifier !== teamIdentifier) {
    throw new Error(`${label} does not share the app TeamIdentifier ${teamIdentifier}`);
  }
  if (!signature.requirement || /\bcdhash\b/i.test(signature.requirement)) {
    throw new Error(`${label} has a version-bound designated requirement instead of a stable identity`);
  }
}

export async function verifyMacosAppBundle({
  appPath,
  platform = process.platform,
  inspectCode = inspectCodeWithCodesign,
  verifyDeep = verifyDeepWithCodesign,
}) {
  if (platform !== "darwin") {
    throw new Error("macOS bundle signature verification can only run on macOS");
  }

  await verifyDeep(appPath);
  const appSignature = await inspectCode(appPath);
  if (appSignature.identifier !== APP_IDENTIFIER) {
    throw new Error(`Unexpected app signing identifier: ${appSignature.identifier || "missing"}`);
  }
  const teamIdentifier = appSignature.teamIdentifier;
  assertDeveloperIdentity({
    signature: appSignature,
    target: appPath,
    teamIdentifier,
  });

  const contentsPath = path.join(appPath, "Contents");
  const machOFiles = await collectMachOFiles(contentsPath);
  if (machOFiles.length === 0) {
    throw new Error("The macOS bundle contains no Mach-O executables");
  }

  for (const target of machOFiles) {
    const signature = await inspectCode(target);
    assertDeveloperIdentity({ signature, target, teamIdentifier });
    const name = path.basename(target);
    const expectedIdentifier = name === MAIN_EXECUTABLE
      ? APP_IDENTIFIER
      : SIDECARS.includes(name)
        ? stableSidecarIdentifier(name)
        : undefined;
    if (expectedIdentifier && signature.identifier !== expectedIdentifier) {
      throw new Error(
        `${name} uses signing identifier ${signature.identifier || "missing"}; expected ${expectedIdentifier}`,
      );
    }
  }

  return { machOFiles, teamIdentifier };
}

async function main() {
  const [command, target] = process.argv.slice(2);
  if (command === "prepare-sidecars") {
    const binaryDir = target ?? path.resolve("src-tauri", "binaries");
    const signed = await signMacosExternalBinaries({
      binaryDir,
      identity: process.env.APPLE_SIGNING_IDENTITY,
      keychain: process.env.APPLE_CODESIGN_KEYCHAIN,
    });
    if (process.platform === "darwin") {
      process.stdout.write(`Signed ${signed.length} macOS sidecar binaries with stable identifiers.\n`);
    }
    return;
  }
  if (command === "verify-app") {
    if (!target) throw new Error("Usage: macos-bundle-signing.mjs verify-app <path-to-app>");
    const result = await verifyMacosAppBundle({ appPath: path.resolve(target) });
    process.stdout.write(
      `Verified ${result.machOFiles.length} Mach-O files with Developer ID team ${result.teamIdentifier}.\n`,
    );
    return;
  }
  throw new Error(
    "Usage: macos-bundle-signing.mjs <prepare-sidecars [binary-dir] | verify-app <path-to-app>>",
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

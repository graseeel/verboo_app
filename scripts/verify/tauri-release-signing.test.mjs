import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowPath = new URL(
  "../../.github/workflows/tauri-release.yml",
  import.meta.url,
);

test("macOS releases require Developer ID signing and API-key notarization", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /secrets\.APPLE_CERTIFICATE\b/);
  assert.match(workflow, /secrets\.APPLE_CERTIFICATE_PASSWORD\b/);
  assert.match(workflow, /secrets\.APPLE_API_PRIVATE_KEY\b/);
  assert.match(workflow, /secrets\.APPLE_API_KEY\b/);
  assert.match(workflow, /secrets\.APPLE_API_ISSUER\b/);
  assert.match(workflow, /APPLE_API_KEY_PATH/);
});

test("macOS release gate verifies the app and notarizes the distributed DMG", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /codesign --verify --deep --strict/);
  assert.match(workflow, /spctl .*--type execute/);
  assert.match(workflow, /notarytool submit "\$DMG_PATH"/);
  assert.match(workflow, /stapler staple .*"\$DMG_PATH"/);
  assert.match(workflow, /stapler validate .*"\$DMG_PATH"/);
});

test("notarization key exists only for macOS build steps and is always removed", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(
    workflow,
    /- name: Prepare Apple notarization credentials[\s\S]*?if: runner\.os == 'macOS'/,
  );
  assert.match(
    workflow,
    /- name: Remove Apple notarization credentials[\s\S]*?if: always\(\) && runner\.os == 'macOS'/,
  );
  assert.match(workflow, /rm -f "\$\{APPLE_API_KEY_PATH:-\}"/);
});

test("embedded CLI Mach-O binaries receive Developer ID hardened signatures", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /security import "\$CERTIFICATE_PATH"/);
  assert.match(workflow, /find "\$RESOURCE_ROOT" -type f -print0/);
  assert.match(workflow, /FILE_DESCRIPTION=.*file -b "\$candidate"/);
  assert.match(workflow, /FILE_DESCRIPTION.*Mach-O/);
  assert.match(workflow, /EXPECTED_MACHO_ARCH/);
  assert.match(
    workflow,
    /FILE_DESCRIPTION.*EXPECTED_MACHO_ARCH[\s\S]*?exit 1/,
  );
  assert.match(
    workflow,
    /codesign --force --options runtime --timestamp[\s\S]*?"\$candidate"/,
  );
  assert.doesNotMatch(workflow, /ripgrep|libvips|sharp-darwin/);
});

test("macOS target architectures use matching native runners", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(
    workflow,
    /- os: macos-15\n\s+target: aarch64-apple-darwin/,
  );
  assert.match(
    workflow,
    /- os: macos-15-intel\n\s+target: x86_64-apple-darwin/,
  );
});

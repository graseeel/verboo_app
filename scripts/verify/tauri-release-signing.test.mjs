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

test("macOS release build submits once without waiting and persists the exact artifacts", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const submitStart = workflow.indexOf(
    "- name: Verify and submit macOS artifacts for asynchronous notarization",
  );
  const submitEnd = workflow.indexOf("\n      - name:", submitStart + 1);
  const submitStep = workflow.slice(submitStart, submitEnd);

  assert.match(workflow, /codesign --verify --deep --strict/);
  assert.match(submitStep, /notarytool submit "\$DMG_PATH"/);
  assert.doesNotMatch(submitStep, /--wait/);
  assert.match(submitStep, /submission_id/);
  assert.match(submitStep, /ditto -c -k --keepParent --sequesterRsrc/);
  assert.match(workflow, /Notarization-\$\{\{ matrix\.label \}\}/);
  assert.match(workflow, /retention-days: 30/);
  assert.equal(
    [...workflow.matchAll(/notarytool submit/g)].length,
    1,
    "the workflow template must submit only the final DMG for each macOS architecture",
  );
});

test("macOS build does not let Tauri synchronously notarize the app", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const buildStart = workflow.indexOf(
    "- name: Build Tauri bundle and signed updater artifacts",
  );
  const buildEnd = workflow.indexOf("\n      - name:", buildStart + 1);
  const buildStep = workflow.slice(buildStart, buildEnd);

  assert.doesNotMatch(buildStep, /APPLE_API_KEY:/);
  assert.doesNotMatch(buildStep, /APPLE_API_ISSUER:/);
  assert.doesNotMatch(buildStep, /--wait/);
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
  const prepareStart = workflow.indexOf(
    "- name: Prepare Apple notarization credentials",
  );
  const prepareEnd = workflow.indexOf(
    "- name: Build Tauri bundle and signed updater artifacts",
    prepareStart,
  );
  const prepareStep = workflow.slice(prepareStart, prepareEnd);

  assert.match(workflow, /security import "\$CERTIFICATE_PATH"/);
  assert.match(prepareStep, /-T \/usr\/bin\/codesign/);
  assert.doesNotMatch(prepareStep, /^\s+-A\s*\\$/m);
  assert.match(workflow, /ORIGINAL_KEYCHAINS=\(\)/);
  assert.match(
    workflow,
    /security list-keychains -d user -s "\$KEYCHAIN_PATH" "\$\{ORIGINAL_KEYCHAINS\[@\]\}"/,
  );
  assert.match(
    workflow,
    /security list-keychains -d user -s "\$\{ORIGINAL_KEYCHAINS\[@\]\}"/,
  );
  const partitionIndex = prepareStep.indexOf(
    "security set-key-partition-list",
  );
  const searchListIndex = prepareStep.indexOf(
    'security list-keychains -d user -s "$KEYCHAIN_PATH"',
  );
  const identityIndex = prepareStep.indexOf("security find-identity");
  const codesignIndex = prepareStep.indexOf("codesign --force");
  assert.ok(
    partitionIndex < searchListIndex &&
      searchListIndex < identityIndex &&
      identityIndex < codesignIndex,
    "the prepared identity must enter the user search list before codesign",
  );
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

test("prerelease builds do not block publishing on packaged runtime smoke", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  for (const platform of ["macOS", "Windows", "Linux"]) {
    const stepStart = workflow.indexOf(
      `- name: Run packaged multiwebview runtime smoke (${platform})`,
    );
    const stepEnd = workflow.indexOf("\n      - name:", stepStart + 1);
    const step = workflow.slice(stepStart, stepEnd);

    assert.notEqual(stepStart, -1, `${platform} smoke step must remain available`);
    assert.match(
      step,
      /needs\.resolve-tag\.outputs\.is_prerelease != 'true'/,
      `${platform} smoke must be skipped for beta releases`,
    );
  }
});

test("notarization finalizer polls the saved IDs and republishes only after stapling", async () => {
  const releaseWorkflow = await readFile(workflowPath, "utf8");
  const workflow = await readFile(
    new URL("../../.github/workflows/tauri-notarization.yml", import.meta.url),
    "utf8",
  );

  assert.match(
    releaseWorkflow,
    /uses: \.\/\.github\/workflows\/tauri-notarization\.yml/,
  );
  assert.match(releaseWorkflow, /-f operation="notarization"/);
  assert.match(workflow, /notarytool info "\$SUBMISSION_ID"/);
  assert.match(workflow, /name: apple-notarization-retry/);
  assert.match(workflow, /gh workflow run tauri-release\.yml/);
  assert.match(workflow, /stapler staple -v "\$APP_PATH"/);
  assert.match(workflow, /stapler staple -v "\$DMG_PATH"/);
  assert.match(workflow, /tauri signer sign "\$UPDATER_PATH"/);
  assert.match(workflow, /generate-tauri-update-manifest\.mjs/);
  assert.match(workflow, /gh release upload updater-beta "\$MANIFEST"/);
});

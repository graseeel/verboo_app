import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowPath = new URL(
  "../../.github/workflows/tauri-release.yml",
  import.meta.url,
);
const tauriConfigPath = new URL(
  "../../src-tauri/tauri.conf.json",
  import.meta.url,
);
const entitlementsPath = new URL(
  "../../src-tauri/Entitlements.plist",
  import.meta.url,
);
const localBuildPath = new URL(
  "../build-release-app.sh",
  import.meta.url,
);
const packagePath = new URL("../../package.json", import.meta.url);

// Normalize CRLF -> LF on read: git checkout on Windows brings CRLF into
// the workflow files, and comparing/slicing workflow text with "\n" (or
// /\n/ regexes) breaks when the file arrives with "\r\n". Same pattern
// as browser_panel.rs:3625 (vendored-Wry read). macOS/Linux are no-ops.
async function readWorkflowText(target) {
  return (await readFile(target, "utf8")).replace(/\r\n/g, "\n");
}

test("macOS releases require Developer ID signing and API-key notarization", async () => {
  const workflow = await readWorkflowText(workflowPath);

  assert.match(workflow, /secrets\.APPLE_CERTIFICATE\b/);
  assert.match(workflow, /secrets\.APPLE_CERTIFICATE_PASSWORD\b/);
  assert.match(workflow, /secrets\.APPLE_API_PRIVATE_KEY\b/);
  assert.match(workflow, /secrets\.APPLE_API_KEY\b/);
  assert.match(workflow, /secrets\.APPLE_API_ISSUER\b/);
  assert.match(workflow, /APPLE_API_KEY_PATH/);
});

test("macOS release build submits once without waiting and persists the exact artifacts", async () => {
  const workflow = await readWorkflowText(workflowPath);
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
  const workflow = await readWorkflowText(workflowPath);
  const buildStart = workflow.indexOf(
    "- name: Build Tauri bundle and signed updater artifacts",
  );
  const buildEnd = workflow.indexOf("\n      - name:", buildStart + 1);
  const buildStep = workflow.slice(buildStart, buildEnd);

  assert.doesNotMatch(buildStep, /APPLE_API_KEY:/);
  assert.doesNotMatch(buildStep, /APPLE_API_ISSUER:/);
  assert.doesNotMatch(buildStep, /--wait/);
});

test("macOS builds the app with Tauri and creates the signed DMG in a bounded retry step", async () => {
  const workflow = await readWorkflowText(workflowPath);
  const buildStart = workflow.indexOf(
    "- name: Build Tauri bundle and signed updater artifacts",
  );
  const buildEnd = workflow.indexOf("\n      - name:", buildStart + 1);
  const buildStep = workflow.slice(buildStart, buildEnd);
  const dmgStart = workflow.indexOf(
    "- name: Create signed macOS DMG with bounded retry",
  );
  const dmgEnd = workflow.indexOf("\n      - name:", dmgStart + 1);
  const dmgStep = workflow.slice(dmgStart, dmgEnd);

  assert.match(buildStep, /runner\.os.*macOS[\s\S]*?--bundles app/);
  assert.notEqual(dmgStart, -1, "the workflow must create the DMG outside Tauri");
  assert.match(dmgStep, /"hdiutil"[\s\S]*?"create"/);
  assert.match(dmgStep, /timeout\s*=/);
  assert.match(dmgStep, /attempts\s*=/);
  assert.match(dmgStep, /codesign --force --timestamp/);
  assert.match(dmgStep, /--keychain "\$APPLE_CODESIGN_KEYCHAIN"/);
  assert.match(dmgStep, /--sign "\$APPLE_SIGNING_IDENTITY"/);
  assert.match(dmgStep, /hdiutil verify "\$DMG_PATH"/);
});

test("notarization key exists only for macOS build steps and is always removed", async () => {
  const workflow = await readWorkflowText(workflowPath);

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

test("macOS release and local builds sign only the app-owned bundle", async () => {
  const workflow = await readWorkflowText(workflowPath);
  const tauriConfig = JSON.parse(await readFile(tauriConfigPath, "utf8"));
  const entitlements = await readFile(entitlementsPath, "utf8");
  const localBuild = await readWorkflowText(localBuildPath);
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
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
  assert.ok(
    partitionIndex < searchListIndex &&
      searchListIndex < identityIndex,
    "the prepared identity must enter the user search list before the build",
  );
  assert.doesNotMatch(workflow, /sign-macos-node-runtime|resources\/node-runtime/);
  assert.doesNotMatch(localBuild, /sign-macos-node-runtime|Contents\/MacOS\/verboo-node|resources\/node-runtime/);
  const localIdentityIndex = localBuild.indexOf("APPLE_SIGNING_IDENTITY");
  const localBuildIndex = localBuild.indexOf("npm run tauri:build");
  assert.ok(
    localIdentityIndex !== -1 && localIdentityIndex < localBuildIndex,
    "the local Developer ID identity must be exported before Tauri signs the bundle",
  );
  assert.match(
    packageJson.scripts["tauri:build"],
    /macos-bundle-signing\.mjs prepare-sidecars/,
  );
  assert.match(localBuild, /macos-bundle-signing\.mjs verify-app "\$APP_PATH"/);
  assert.match(localBuild, /codesign --verify --strict --verbose=2 "\$DMG_PATH"/);
  assert.match(localBuild, /hdiutil verify "\$DMG_PATH"/);
  assert.match(workflow, /macos-bundle-signing\.mjs verify-app "\$APP_PATH"/);
  assert.match(workflow, /test ! -e "\$APP_PATH\/Contents\/MacOS\/verboo-node"/);
  assert.equal([...workflow.matchAll(/Contents\/MacOS\/verboo-node/g)].length, 1);
  assert.match(workflow, /codesign --verify --deep --strict --verbose=2 "\$APP_PATH"/);
  assert.equal(tauriConfig.bundle.macOS.entitlements, "Entitlements.plist");
  assert.match(entitlements, /com\.apple\.security\.cs\.allow-jit/);
  assert.match(
    entitlements,
    /com\.apple\.security\.cs\.allow-unsigned-executable-memory/,
  );
  assert.match(
    entitlements,
    /com\.apple\.security\.cs\.disable-library-validation/,
  );
  assert.doesNotMatch(workflow, /resources\/cli-package|copy-cli-resource/);
});

test("macOS target architectures use matching native runners", async () => {
  const workflow = await readWorkflowText(workflowPath);

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
  const workflow = await readWorkflowText(workflowPath);

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
  const releaseWorkflow = await readWorkflowText(workflowPath);
  const workflow = await readWorkflowText(
    new URL("../../.github/workflows/tauri-notarization.yml", import.meta.url),
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

test("release artifacts are stamped and published from the reviewed catalog", async () => {
  const workflow = await readWorkflowText(workflowPath);

  assert.match(
    workflow,
    /VERBOO_RELEASE_TAG:\s*\$\{\{ needs\.resolve-tag\.outputs\.tag \}\}/,
  );
  assert.match(workflow, /render-release-notes\.mjs/);
  assert.doesNotMatch(workflow, /This beta brings a macOS embedded browser/);
  assert.doesNotMatch(
    workflow,
    /printf '%s\\n' "- On macOS, work beside a live local site/,
  );
});

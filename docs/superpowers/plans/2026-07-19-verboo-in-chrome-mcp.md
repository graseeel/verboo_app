# Verboo in Chrome MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an official, user-configurable `verboo-in-chrome` MCP integration that controls only Google Chrome, works with Verboo CLI 0.13.0 while the desktop app is closed, and appears in Settings and Plugins.

**Architecture:** A dedicated Rust sidecar runs either as a stdio MCP server or as Chrome's Native Messaging Host. The two processes discover one another through a per-user authenticated Unix socket or Windows named pipe, while the extension remains the sole browser policy and approval authority. Tauri installs and diagnoses the helper but is absent from the runtime tool path.

**Tech Stack:** Rust 1.89, Tokio, official `rmcp` Rust SDK, Chrome MV3 Native Messaging, Tauri v2 sidecars and commands, React 19, TypeScript 6, Vitest, Node test runner.

## Global Constraints

- Start only after the browser stabilization plan has merged and passed on `dev`.
- Create `feat/verboo-in-chrome-mcp` from the updated local `dev` in an isolated worktree.
- The integration is Google Chrome-only on macOS, Windows, and Linux.
- The global MCP server name is exactly `verboo-in-chrome` at user scope.
- The MCP exposes browser tools only and never app, filesystem, terminal, Git, or review tools.
- The desktop app is a configurator/diagnostic client and is not required at runtime.
- Extension approvals are authoritative and happen inside Chrome; rejection or timeout executes nothing.
- CLI and extension OAuth sessions remain separate and no token crosses Native Messaging.
- Never overwrite or remove a foreign MCP entry or path.
- Generated sidecar binaries remain ignored and are never committed.
- Follow RED -> verify RED -> GREEN -> verify GREEN for each behavior.

---

### Task 1: Create the Isolated MCP Feature Worktree

**Files:**
- Modify: Git worktree metadata only.

**Interfaces:**
- Consumes: verified updated `dev`.
- Produces: `/Users/grasel/Documents/gabriel workshell/workspace/code/verboo_app-chrome-mcp` on `feat/verboo-in-chrome-mcp`.

- [ ] **Step 1: Verify the base state**

Run in the dev checkout:

```bash
git status --short --branch
git log -1 --oneline
```

Expected: `dev` contains the verified browser-use merge; known untracked local files are not staged.

- [ ] **Step 2: Create the feature worktree**

After reading and following `using-git-worktrees`:

```bash
git worktree add "/Users/grasel/Documents/gabriel workshell/workspace/code/verboo_app-chrome-mcp" -b feat/verboo-in-chrome-mcp dev
```

Expected: the new checkout is clean and points at the verified dev merge.

- [ ] **Step 3: Verify the clean baseline**

Run in the new checkout:

```bash
npm test
cargo +1.89.0 test --manifest-path src-tauri/Cargo.toml --lib
```

Expected: both baseline suites exit 0.

### Task 2: Create the Dual-Mode Rust Helper Protocol Core

**Files:**
- Create: `src-tauri/verboo-in-chrome/Cargo.toml`
- Create: `src-tauri/verboo-in-chrome/src/main.rs`
- Create: `src-tauri/verboo-in-chrome/src/lib.rs`
- Create: `src-tauri/verboo-in-chrome/src/error.rs`
- Create: `src-tauri/verboo-in-chrome/src/protocol.rs`
- Create: `src-tauri/verboo-in-chrome/src/framing.rs`
- Create: `src-tauri/verboo-in-chrome/src/discovery.rs`
- Create: `src-tauri/verboo-in-chrome/src/local_transport.rs`
- Create: `src-tauri/verboo-in-chrome/tests/framing.rs`
- Create: `src-tauri/verboo-in-chrome/tests/discovery.rs`

**Interfaces:**
- Produces: `run_mcp()`, `run_native_host(origin: String)`, and `run_ping()` entry modes.
- Produces: `Envelope { version, id, kind, secret, payload }` serialized with camelCase fields.
- Produces: `DiscoveryRecord { protocol_version, pid, endpoint, secret, helper_version, extension_origin }`.
- Produces: `FrameReader<R>` and `write_native_message<W>()`.

- [ ] **Step 1: Write framing tests first**

Cover partial headers, partial bodies, two frames in one read, UTF-8 byte lengths, a 1 MiB host-to-Chrome limit, a 64 MiB Chrome-to-host limit, malformed JSON, and bytes retained after one frame.

Core assertions:

```rust
#[test]
fn retains_second_frame_from_one_read() {
    let bytes = [frame(json!({"id":"one"})), frame(json!({"id":"two"}))].concat();
    let mut reader = FrameReader::new(Cursor::new(bytes), Direction::FromChrome);
    assert_eq!(reader.read().unwrap().unwrap()["id"], "one");
    assert_eq!(reader.read().unwrap().unwrap()["id"], "two");
}
```

- [ ] **Step 2: Run helper tests and verify RED**

Run:

```bash
cargo +1.89.0 test --manifest-path src-tauri/verboo-in-chrome/Cargo.toml
```

Expected: compilation fails because the helper modules do not exist.

- [ ] **Step 3: Implement framing and versioned envelopes**

Use buffered `read_exact` logic; never use stream pushback. All diagnostics go to stderr because stdout is reserved for Chrome/MCP framing. Reject frames before allocating bodies larger than the direction-specific maximum.

Define:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    pub version: u32,
    pub id: String,
    pub kind: MessageKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,
    pub payload: serde_json::Value,
}
```

- [ ] **Step 4: Write discovery tests and verify RED**

Use `tempfile::TempDir` to assert 0700 runtime directory and 0600 record permissions on Unix, random secret rotation, stale PID rejection, and multiple live session discovery returning `MultipleBrowserSessions`.

- [ ] **Step 5: Implement per-user discovery and local transport adapters**

Store one record per Native Host PID under a product-owned runtime directory. macOS/Linux endpoints are Unix sockets; Windows endpoints use Tokio named pipes. `discover_session()` returns none, exactly one verified live session, or an ambiguity error. Do not use `HOME` strings or fixed usernames; use platform directory APIs.

- [ ] **Step 6: Run helper tests and verify GREEN**

Run:

```bash
cargo +1.89.0 test --manifest-path src-tauri/verboo-in-chrome/Cargo.toml
```

Expected: all framing, discovery, permission, stale-session, and ambiguity tests pass on the host platform.

- [ ] **Step 7: Commit the helper protocol core**

```bash
git add src-tauri/verboo-in-chrome
git commit -m "feat(chrome): add secure browser bridge helper core"
```

### Task 3: Implement the MCP Server and Browser-Only Catalog

**Files:**
- Modify: `src-tauri/verboo-in-chrome/Cargo.toml`
- Create: `src-tauri/verboo-in-chrome/src/catalog.rs`
- Create: `src-tauri/verboo-in-chrome/src/mcp_server.rs`
- Create: `src-tauri/verboo-in-chrome/tests/catalog.rs`
- Create: `src-tauri/verboo-in-chrome/tests/mcp_server.rs`
- Modify: `extensions/verboo-chrome/src/controller/browserTools.json`

**Interfaces:**
- Consumes: the shared `browserTools.json` introduced by the stabilization plan.
- Produces: `BrowserMcpServer` implementing `rmcp::ServerHandler` over stdio.
- Produces: `BrowserSessionClient::call_tool(name, arguments) -> ToolRelayResult`.

- [ ] **Step 1: Add failing catalog contract tests**

Parse the shared JSON at compile time with `include_str!` and assert:

```rust
assert!(!catalog.tools.is_empty());
assert!(catalog.tools.iter().all(|tool| matches!(tool.risk.as_str(), "read" | "mutate" | "elevated")));
assert!(catalog.tools.iter().all(|tool| !["shell", "filesystem", "terminal", "git", "app"].contains(&tool.name.as_str())));
```

Also assert unique names and a nonempty JSON Schema for every tool.

- [ ] **Step 2: Run catalog tests and verify RED**

Expected: missing `catalog` module or unmet parsing interface.

- [ ] **Step 3: Add the official Rust MCP SDK and implement dynamic tools**

Pin `rmcp = { version = "=0.16.0", features = ["server"] }` and its resolved dependencies in `Cargo.lock` rather than using a moving Git branch. Build `ListToolsResult` from the shared catalog and forward `call_tool` arguments unchanged except for schema validation. Return structured MCP content for:

- `chrome_not_connected`;
- `multiple_browser_sessions`;
- `approval_rejected`;
- `approval_timeout`;
- `protocol_version_mismatch`;
- `connection_lost`.

The MCP server must not start Chrome or the desktop app.

- [ ] **Step 4: Add a fake local-session MCP integration test**

Start a test socket/pipe endpoint, run `BrowserMcpServer` against it, list tools, invoke one read-only tool, and assert the exact request ID and result are relayed. Assert an unknown tool fails before local transport.

- [ ] **Step 5: Run helper tests and verify GREEN**

Run:

```bash
cargo +1.89.0 test --manifest-path src-tauri/verboo-in-chrome/Cargo.toml
```

Expected: all protocol and MCP tests pass.

- [ ] **Step 6: Commit the browser-only MCP server**

```bash
git add src-tauri/verboo-in-chrome extensions/verboo-chrome/src/controller/browserTools.json
git commit -m "feat(chrome): expose browser tools through MCP"
```

### Task 4: Connect the Chrome Extension to the Rust Native Host

**Files:**
- Create: `extensions/verboo-chrome/src/native/bridge.js`
- Create: `extensions/verboo-chrome/src/native/bridge.test.js`
- Modify: `extensions/verboo-chrome/manifest.json`
- Modify: `extensions/verboo-chrome/package.json`
- Modify: `extensions/verboo-chrome/src/background.js`
- Modify: `extensions/verboo-chrome/src/controller/nativeMessaging.ts`
- Modify: `extensions/verboo-chrome/native-messaging/PROTOCOL.md`
- Modify: `extensions/verboo-chrome/PERMISSIONS.md`
- Modify: `src-tauri/verboo-in-chrome/src/main.rs`
- Create: `src-tauri/verboo-in-chrome/src/native_host.rs`
- Create: `src-tauri/verboo-in-chrome/tests/native_host.rs`

**Interfaces:**
- Produces: `NativeBridge` with `connect()`, `disconnect()`, and `sendResponse(envelope)`.
- Consumes: `executeWithApproval` from the stabilized extension.
- Produces: Native Host relay from authenticated local requests to the extension port.

- [ ] **Step 1: Add failing extension bridge tests**

Mock `chrome.runtime.connectNative` and assert:

```js
test('native tool requests use the shared approval executor', async () => {
  const bridge = createNativeBridge({ executeWithApproval: recordedExecutor })
  bridge.connect()
  nativePort.emitMessage(validToolRequest)
  await tick()
  assert.equal(recordedExecutor.calls.length, 1)
  assert.equal(nativePort.posted[0].kind, 'toolResponse')
})
```

Also cover protocol mismatch, malformed envelope, reconnect on `runtime.onStartup`, disconnection, and no automatic replay.

- [ ] **Step 2: Run bridge tests and verify RED**

Run:

```bash
node --test extensions/verboo-chrome/src/native/bridge.test.js
```

Expected: missing module or behavior failures.

- [ ] **Step 3: Implement lazy Native Messaging connection**

Restore only the `nativeMessaging` permission. Connect on service-worker initialization and `runtime.onStartup`, with one bounded reconnect while the worker remains active. Route `toolRequest` exclusively through `executeWithApproval`; return the canonical execution result with the same request ID.

If approval UI is unavailable because the side panel is closed, return `approval_ui_unavailable` with localized instructions to open the Verboo side panel. Never auto-approve.

- [ ] **Step 4: Implement the Native Host relay**

`run_native_host(origin)` validates the origin passed by Chrome against the installed manifest, creates its discovery record, accepts one authenticated MCP connection, serializes one in-flight browser request at a time, and relays Chrome responses by request ID. On shutdown it removes its record and socket. On Windows, ignore only the documented `--parent-window=<handle>` argument.

- [ ] **Step 5: Run extension and helper tests**

Run:

```bash
npm --prefix extensions/verboo-chrome test
cargo +1.89.0 test --manifest-path src-tauri/verboo-in-chrome/Cargo.toml
```

Expected: all tests pass, including no-replay and approval-unavailable behavior.

- [ ] **Step 6: Commit the live extension bridge**

```bash
git add extensions/verboo-chrome src-tauri/verboo-in-chrome
git commit -m "feat(chrome): connect extension to native MCP bridge"
```

### Task 5: Bundle the Helper as a Tauri Sidecar

**Files:**
- Create: `scripts/tauri/build-chrome-helper.mjs`
- Create: `scripts/tauri/build-chrome-helper.test.mjs`
- Modify: `package.json`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `.gitignore`
- Modify: `.github/workflows/tauri-release.yml`

**Interfaces:**
- Produces: `src-tauri/binaries/verboo-in-chrome-<target-triple>[.exe]` as an ignored build artifact.
- Consumes: Tauri `bundle.externalBin: ["binaries/verboo-in-chrome"]`.

- [ ] **Step 1: Add failing target-name tests**

Export a pure `sidecarFilename(targetTriple, platform)` helper and test Apple Silicon, Intel macOS, x86_64 Linux, and x86_64 Windows names exactly as required by Tauri v2.

- [ ] **Step 2: Run the script test and verify RED**

Run:

```bash
node --test scripts/tauri/build-chrome-helper.test.mjs
```

Expected: missing module or missing filename helper.

- [ ] **Step 3: Implement the helper build script**

The script reads the explicit target from `TAURI_ENV_TARGET_TRIPLE` or `--target`, otherwise parses `rustc -vV`; runs Cargo for the helper crate; copies the resulting binary to the exact target-suffixed Tauri sidecar path; and sets executable permissions on Unix. It never downloads a binary.

- [ ] **Step 4: Wire local and release builds**

Add `build:chrome-helper`, call it before `cargo tauri build`, list the sidecar in `externalBin`, ignore generated target-suffixed binaries, and invoke the same script in every release-matrix job before bundling.

- [ ] **Step 5: Verify sidecar preparation**

Run:

```bash
node --test scripts/tauri/build-chrome-helper.test.mjs
npm run build:chrome-helper
```

Expected: script tests pass and the current-target ignored sidecar exists with executable permission.

- [ ] **Step 6: Commit packaging support**

```bash
git add scripts/tauri package.json src-tauri/tauri.conf.json .gitignore .github/workflows/tauri-release.yml
git commit -m "build(chrome): bundle the browser MCP helper"
```

### Task 6: Implement Safe Installation, CLI Registration, and Diagnostics

**Files:**
- Create: `src-tauri/src/services/chrome_integration/mod.rs`
- Create: `src-tauri/src/services/chrome_integration/models.rs`
- Create: `src-tauri/src/services/chrome_integration/paths.rs`
- Create: `src-tauri/src/services/chrome_integration/manifest.rs`
- Create: `src-tauri/src/services/chrome_integration/cli_mcp.rs`
- Create: `src-tauri/src/services/chrome_integration/installer.rs`
- Create: `src-tauri/src/services/chrome_integration/diagnostics.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`

**Interfaces:**
- Produces: `ChromeIntegrationService::{status, configure, repair, test_connection, remove}`.
- Produces: `ChromeIntegrationStatus` with extension, bridge, MCP, connection, aggregate state, versions, and actionable error.
- Produces: `ChromeIntegrationRequest { development_extension_id: Option<String> }`, accepted only in debug builds.
- Consumes: `CliSpawn` and the bundled sidecar source path.

- [ ] **Step 1: Add path and manifest tests first**

Use injected directory roots and assert platform-specific outputs:

```rust
assert_eq!(mac_manifest_suffix(), "Google/Chrome/NativeMessagingHosts/com.verboo.code.browser_extension.json");
assert_eq!(linux_manifest_suffix(), "google-chrome/NativeMessagingHosts/com.verboo.code.browser_extension.json");
assert_eq!(windows_registry_key(), r"Software\Google\Chrome\NativeMessagingHosts\com.verboo.code.browser_extension");
```

Assert manifest `path` is absolute, `type` is `stdio`, and `allowed_origins` contains only the configured production or development extension ID.

- [ ] **Step 2: Add installer ownership tests and verify RED**

With temp directories and a fake CLI runner, cover fresh configure, repeated configure, repair, upgrade, managed remove, foreign helper path, foreign Native Messaging manifest, foreign `verboo-in-chrome` MCP entry, and atomic-write failure. Expected RED: modules do not exist.

- [ ] **Step 3: Implement platform paths and managed metadata**

Install the helper into a versioned per-user Verboo data directory. Write the Chrome manifest atomically. On Windows, write/remove only the HKCU key for the exact host name using a direct `winreg` dependency. Store ownership/version in a product-owned installation record and in MCP env markers:

```text
VERBOO_IN_CHROME_MANAGED=1
VERBOO_IN_CHROME_VERSION=<app version>
```

Release metadata comes from compile-time `VERBOO_CHROME_EXTENSION_ID` and `VERBOO_CHROME_WEB_STORE_URL`. Debug builds may accept a temporary extension ID matching `^[a-p]{32}$`; release builds reject that request field.

- [ ] **Step 4: Implement CLI MCP inspection and mutation**

Use `CliSpawn` with:

```text
verboo mcp doctor --config-only --json --scope user
verboo mcp add --scope user -e VERBOO_IN_CHROME_MANAGED=1 -e VERBOO_IN_CHROME_VERSION=<version> verboo-in-chrome -- <installed-helper> mcp
verboo mcp remove --scope user verboo-in-chrome
```

Never invoke remove unless diagnostics prove the entry matches the managed path and markers. A foreign entry becomes `McpState::Conflict`.

- [ ] **Step 5: Implement status and safe actions**

`status()` is read-only. `configure()` creates only absent managed components. `repair()` atomically replaces invalid managed components. `test_connection()` calls `<installed-helper> ping` and performs no browser tool. `remove()` removes only verified managed targets and leaves the Chrome extension installed.

- [ ] **Step 6: Run focused and full Rust tests**

Run:

```bash
cargo +1.89.0 test --manifest-path src-tauri/Cargo.toml chrome_integration
cargo +1.89.0 test --manifest-path src-tauri/Cargo.toml --lib
```

Expected: all installation, conflict, diagnostic, and existing library tests pass without touching real user configuration.

- [ ] **Step 7: Commit the installation service**

```bash
git add src-tauri/src/services/chrome_integration src-tauri/src/services/mod.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(chrome): configure and diagnose the MCP integration"
```

### Task 7: Expose Typed Tauri Commands to the Renderer

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/renderer/verboo-bridge.ts`
- Modify: `src/renderer/verboo-bridge.test.ts`

**Interfaces:**
- Produces renderer methods: `chromeIntegrationStatus`, `chromeIntegrationConfigure(request)`, `chromeIntegrationRepair(request)`, `chromeIntegrationTest`, `chromeIntegrationRemove`, `openChromeExtensionStore`.
- Consumes: `ChromeIntegrationService` from Task 6.

- [ ] **Step 1: Add failing bridge contract tests**

Assert the API exposes all six methods and that each maps to the exact Tauri command/payload. Status and test calls carry no mutation flag or filesystem path from the renderer.

- [ ] **Step 2: Run the bridge test and verify RED**

Run:

```bash
npm test -- src/renderer/verboo-bridge.test.ts
```

Expected: missing API methods.

- [ ] **Step 3: Add shared serializable types**

Define discriminated states:

```ts
export type ChromeComponentState = 'missing' | 'managed' | 'outdated' | 'invalid' | 'conflict'
export type ChromeConnectionState = 'connected' | 'waitingForChrome' | 'ambiguous' | 'incompatible'
export type ChromeIntegrationAggregate = 'notConfigured' | 'incomplete' | 'ready' | 'connected'
```

`ChromeIntegrationStatus` includes component states, versions, `canConfigure`, `canRepair`, `canRemove`, `storeUrlAvailable`, `developmentBuild`, the active extension ID source, and an optional localized error code rather than prelocalized prose. `ChromeIntegrationRequest` carries only an optional `developmentExtensionId`.

- [ ] **Step 4: Register state and commands**

Manage one `ChromeIntegrationService` in Tauri setup and add six commands to `generate_handler!`. `open_chrome_extension_store` uses the existing opener plugin and only accepts the release-configured URL from Rust; the renderer cannot supply an arbitrary URL.

- [ ] **Step 5: Run focused and full bridge tests**

Run:

```bash
npm test -- src/renderer/verboo-bridge.test.ts
cargo +1.89.0 test --manifest-path src-tauri/Cargo.toml chrome_integration
```

Expected: both commands exit 0.

- [ ] **Step 6: Commit the typed bridge**

```bash
git add src/shared/types.ts src-tauri/src/lib.rs src/renderer/verboo-bridge.ts src/renderer/verboo-bridge.test.ts
git commit -m "feat(chrome): expose MCP integration controls"
```

### Task 8: Add the Verboo in Chrome Settings Tab

**Files:**
- Create: `src/renderer/features/settings/ChromeIntegrationSettings.tsx`
- Create: `src/renderer/features/settings/ChromeIntegrationSettings.test.tsx`
- Create: `src/renderer/features/settings/useChromeIntegration.ts`
- Create: `src/renderer/features/settings/useChromeIntegration.test.ts`
- Modify: `src/renderer/features/settings/SettingsView.tsx`
- Modify: `src/shared/types.ts`
- Modify: `src/renderer/i18n.tsx`
- Modify: `src/renderer/styles/surfaces.css`
- Modify: `src/renderer/styles/responsive.css`

**Interfaces:**
- Produces: `SettingsTab` value `verbooInChrome`.
- Produces: `useChromeIntegration()` as the only renderer action/state adapter.
- Consumes: typed bridge methods from Task 7.

- [ ] **Step 1: Add failing hook tests**

Test initial read-only status load, explicit configure, development-ID validation, repair refresh, test ping, removal confirmation, and error-code preservation. Opening/mounting the hook must call only `chromeIntegrationStatus`.

- [ ] **Step 2: Add failing component tests**

Render each approved state and assert:

- four component rows;
- `Configure`, `Install extension`, `Repair configuration`, `Test connection`, and `Remove integration` appear only when their backend capability flag allows them;
- no mutation method runs on mount;
- Chrome closed renders `Configured, waiting for Chrome`, not an error;
- development extension ID controls are absent outside a development build.

- [ ] **Step 3: Run settings tests and verify RED**

Run:

```bash
npm test -- src/renderer/features/settings/useChromeIntegration.test.ts src/renderer/features/settings/ChromeIntegrationSettings.test.tsx
```

Expected: missing hook/component or missing `SettingsTab` value.

- [ ] **Step 4: Implement the hook and focused settings component**

Keep asynchronous state and actions out of `SettingsView.tsx`. `ChromeIntegrationSettings` renders the four status rows and delegates mutations to the hook. In debug builds it also renders the validated temporary unpacked-extension ID field; release builds never render or accept it. Destructive removal requires an in-app confirmation. Store opening occurs only on explicit click.

- [ ] **Step 5: Add navigation, localized copy, and responsive styles**

Add the Chrome tab to `settingsTabs`, render the component for `activeTab === 'verbooInChrome'`, and provide complete English and Brazilian Portuguese strings. Reuse existing settings surfaces; add only Chrome-specific status-grid and action-row rules.

- [ ] **Step 6: Run focused and renderer gates**

Run:

```bash
npm test -- src/renderer/features/settings/useChromeIntegration.test.ts src/renderer/features/settings/ChromeIntegrationSettings.test.tsx
npm run build:renderer
```

Expected: tests and typecheck/build pass.

- [ ] **Step 7: Commit the settings experience**

```bash
git add src/renderer/features/settings src/shared/types.ts src/renderer/i18n.tsx src/renderer/styles/surfaces.css src/renderer/styles/responsive.css
git commit -m "feat(settings): add Verboo in Chrome configuration"
```

### Task 9: Add the Official Verboo Plugin Card

**Files:**
- Create: `src/renderer/features/plugins/OfficialChromeIntegrationCard.tsx`
- Create: `src/renderer/features/plugins/OfficialChromeIntegrationCard.test.tsx`
- Modify: `src/renderer/features/plugins/PluginsView.tsx`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/i18n.tsx`
- Modify: `src/renderer/styles/plugins.css`

**Interfaces:**
- Produces: `PluginsViewProps.onManageChromeIntegration(): void`.
- Consumes: the same `chromeIntegrationStatus()` backend source as Settings.
- Produces: App navigation to `settingsTab = 'verbooInChrome'` and `activeView = 'settings'`.

- [ ] **Step 1: Add failing card and navigation tests**

Assert official Verboo identity and the four aggregate states. Assert the card never calls configure/repair itself. Clicking `Configure` or `Manage` must call only `onManageChromeIntegration`.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npm test -- src/renderer/features/plugins/OfficialChromeIntegrationCard.test.tsx
```

Expected: missing card/prop behavior.

- [ ] **Step 3: Implement the official card above marketplace groups**

Render it as a first-party Verboo integration with `Not configured`, `Configuration incomplete`, `Ready`, or `Chrome connected`. Do not synthesize a marketplace plugin, install it through `usePlugins`, or mix it into community search results.

- [ ] **Step 4: Implement direct navigation to Settings**

In `App.tsx`:

```tsx
onManageChromeIntegration={() => {
  setSettingsTab('verbooInChrome')
  setActiveView('settings')
}}
```

The card and settings component both refresh from the same Tauri diagnostics service.

- [ ] **Step 5: Run plugin and renderer gates**

Run:

```bash
npm test -- src/renderer/features/plugins/OfficialChromeIntegrationCard.test.tsx
npm run build:renderer
```

Expected: tests and build pass.

- [ ] **Step 6: Commit the official integration card**

```bash
git add src/renderer/features/plugins src/renderer/App.tsx src/renderer/i18n.tsx src/renderer/styles/plugins.css
git commit -m "feat(plugins): add official Verboo in Chrome card"
```

### Task 10: Verify Packaging, Runtime Independence, and Safe Integration

**Files:**
- Modify: documentation only if verification reveals an evidenced platform limitation.
- Modify: Git history for the final merge after every gate passes.

**Interfaces:**
- Consumes: all prior MCP feature tasks.
- Produces: verified feature branch and local integration into `dev`.

- [ ] **Step 1: Run every automated gate freshly**

Run:

```bash
git diff --check
npm --prefix extensions/verboo-chrome test
cargo +1.89.0 test --manifest-path src-tauri/verboo-in-chrome/Cargo.toml
npm test
npm run build:renderer
cargo +1.89.0 test --manifest-path src-tauri/Cargo.toml --lib
npm run tauri:build
```

Expected: all commands exit 0 and produce a packaged macOS app with the sidecar included.

- [ ] **Step 2: Inspect package and configuration ownership**

Confirm the packaged sidecar exists, generated target binaries remain ignored, and the committed diff contains no filled production extension ID, personal path, OAuth secret, ZIP, or diagnostic directory.

- [ ] **Step 3: Perform packaged macOS Computer Use acceptance**

Using only Computer Use for the visual interaction portion:

1. Open Plugins and verify the official Verboo in Chrome card.
2. Open its Settings tab and verify no mutation occurs before a click.
3. Configure the integration and load the development extension in Chrome.
4. Close the desktop app.
5. Run the CLI with a safe read-only browser request and verify the tool result.
6. Request one action requiring approval and verify the prompt is only in Chrome.
7. Reject it and verify no browser action occurs.
8. Disconnect Chrome and verify the CLI receives an actionable non-retried error.

- [ ] **Step 4: Verify the feature diff and merge into `dev`**

Run:

```bash
git status --short --branch
git diff --stat dev...HEAD
git diff --name-status dev...HEAD
```

After review, run in the dev checkout:

```bash
git merge --no-ff feat/verboo-in-chrome-mcp -m "merge: integrate Verboo in Chrome MCP"
```

Do not remove the externally located worktree.

- [ ] **Step 5: Re-run final merged gates**

Run on `dev`:

```bash
npm --prefix extensions/verboo-chrome test
cargo +1.89.0 test --manifest-path src-tauri/verboo-in-chrome/Cargo.toml
npm test
npm run build:renderer
cargo +1.89.0 test --manifest-path src-tauri/Cargo.toml --lib
```

Expected: every merged gate exits 0. Report macOS runtime evidence separately from Windows/Linux compilation evidence, and report the external OAuth client registration as incomplete until the backend values are supplied and tested.

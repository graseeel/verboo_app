# Verboo in Chrome MCP Integration Design

**Status:** Approved in conversation

**Date:** 2026-07-19

## Problem

The `feat/browser-use` work introduces a Chrome extension, a browser tool catalog, and Native Messaging scaffolding, but the committed branch is not safe to merge into `dev` yet. The current implementation has protocol, permission, approval, serialization, and authentication gaps. Its documentation also does not match its runtime behavior.

The bundled Verboo CLI 0.13.0 already understands global MCP servers and contains a Chrome-oriented transport shape, but its proprietary browser-tool module is stubbed and its identifiers belong to a different product. Verboo therefore cannot make the integration functional by enabling the existing hidden CLI path or by patching the generated, minified CLI bundle.

Users need an official Verboo integration that:

- exposes Chrome-only tools to the Verboo CLI through MCP;
- keeps all browser approvals inside the Chrome extension;
- keeps working when the desktop app is closed;
- can be installed, diagnosed, repaired, and removed from the desktop app;
- appears as an official integration in the Plugins screen;
- preserves the extension's independent chat mode;
- supports Google Chrome on macOS, Windows, and Linux.

## Goals

- Stabilize `feat/browser-use` and merge it safely into `dev` before building the product integration.
- Ship an app-owned `verboo-in-chrome` helper that works with the current Verboo CLI 0.13.0 without requiring a new `@verboo/code` release.
- Register `verboo-in-chrome` as a user-scoped, global stdio MCP server available to every CLI project.
- Use the same helper as the Google Chrome Native Messaging Host.
- Keep the desktop app strictly in the setup and diagnostics path; it must not proxy browser tools at runtime.
- Make installation and repair explicit, observable, idempotent, and reversible.
- Keep the MCP mode independent from the extension's standalone chat authentication.
- Make the extension the canonical authority for browser tool validation, risk classification, site access, and approval.

## Non-goals

- Giving the MCP access to the desktop app, filesystem, terminal, Git, or review panel.
- Requiring the desktop app to stay open while the CLI controls Chrome.
- Editing the generated `src-tauri/resources/cli-package/dist/cli.mjs` bundle directly.
- Requiring a new Verboo CLI release for the first delivery.
- Supporting Firefox, Safari, Edge, Brave, or other Chromium browsers in this delivery.
- Moving browser approval prompts into the desktop app or CLI transcript.
- Sharing CLI OAuth credentials with the extension.
- Automatically installing, configuring, repairing, or opening Chrome merely because a user visits a screen.

## Approved Architecture

### Runtime topology

The desktop app bundles a first-party executable named `verboo-in-chrome`. The executable has two explicit modes:

1. **MCP mode** is started by the Verboo CLI as a stdio MCP server.
2. **Native host mode** is started by Google Chrome through its Native Messaging manifest.

The two processes communicate through a local, authenticated transport:

```text
Verboo CLI
    | MCP over stdio
    v
verboo-in-chrome mcp
    | authenticated Unix socket or Windows named pipe
    v
verboo-in-chrome native-host
    | Chrome Native Messaging
    v
Verboo Chrome extension
    | chrome.* APIs
    v
Google Chrome
```

The app participates only in installation, status inspection, diagnostics, repair, and removal. Closing the app after setup has no effect on the runtime path.

The helper is owned and built by this repository. The bundled CLI remains an MCP client and launches the registered helper through its existing MCP configuration support. A later upstream CLI integration may replace this packaging boundary, but is not required or implemented here.

### Local discovery and authentication

The Native Messaging Host creates a per-user runtime directory and publishes a small discovery record containing protocol version, process identity, endpoint, and a random per-session secret. The directory and record are readable only by the current OS user.

- macOS and Linux use a Unix domain socket.
- Windows uses a named pipe scoped to the current user.
- Every connection performs a version handshake and proves possession of the session secret.
- Session secrets rotate whenever the native host starts.
- Discovery records are removed on clean shutdown and rejected when their recorded process is no longer alive.
- Logs never include the session secret, OAuth tokens, page contents, or sensitive tool arguments.

The MCP process reports Chrome as disconnected when no valid native-host session exists. It does not start the desktop app, open Chrome, or retry state-changing browser actions automatically.

### MCP server contract

The global MCP server name is `verboo-in-chrome`. It exposes only the extension's supported browser tools. Tool names, JSON schemas, risk classes, approval requirements, and protocol versions come from a versioned first-party catalog rather than caller-provided metadata.

The MCP server:

- validates the incoming MCP schema;
- forwards the requested browser tool and normalized arguments;
- waits while the extension requests any required user approval;
- returns structured success, rejection, timeout, disconnection, ambiguity, and version-mismatch results;
- never treats a caller-supplied risk label as authoritative;
- never exposes a generic app, shell, filesystem, or arbitrary native-command tool.

The extension remains the final enforcement boundary. The helper cannot downgrade an operation or bypass extension policy.

### Native Messaging protocol

The native-host process implements Chrome's four-byte little-endian length framing correctly across partial reads, multiple messages in one read, and backpressure. Messages use versioned envelopes with unique request IDs and explicit direction:

- extension request to native host;
- native host request to extension;
- response to a matching request ID;
- lifecycle event such as connection, disconnection, approval pending, or protocol error.

Unknown versions, duplicate request IDs, malformed envelopes, oversized frames, and unsolicited responses are rejected without terminating subsequent valid traffic when recovery is safe.

The background worker distinguishes tool requests, responses, and lifecycle events. It never reinterprets a tool result as a new tool call.

## Extension Modes

### MCP-controlled mode

The CLI owns model inference and authentication. The extension executes browser tools received through the authenticated local bridge. No Verboo cloud token is required by the extension for this mode.

Approvals appear only inside Chrome. The MCP request remains pending until the user approves, rejects, closes the prompt, or reaches the approval timeout.

### Standalone chat mode

The extension keeps its independent chat experience when the CLI is disconnected. It uses a separate extension OAuth session and never reads or receives CLI tokens.

Production builds do not ask for or persist a raw API key. The extension OAuth client and Chrome redirect URI must be registered by the Verboo backend. Until that external registration is available, standalone chat fails closed with a specific sign-in availability message; MCP-controlled mode remains fully functional.

Development-only authentication or extension identifiers must be guarded by an explicit development build configuration and must not be present in production UI or defaults.

## Browser Security and Permission Model

### Canonical policy

The extension derives each operation's risk and approval requirement from its internal tool catalog. It validates arguments again immediately before execution. Risk, input summaries, current host information, or approval state supplied by the MCP caller are informational only.

Site grants are evaluated against the actual target of an operation. In particular, navigation and new-tab operations validate the destination origin rather than relying on the current active tab's origin.

### Approvals

- Read-only, locally classified tools may run under the extension's established site policy.
- Elevated or state-changing tools require an extension-owned approval.
- Rejection, dismissal, timeout, and tab closure result in no action.
- Approval applies to the exact normalized operation shown to the user; changing arguments invalidates it.
- A response cannot be forged by the native host or MCP process because the extension owns the approval state.

### Untrusted web content

Text, accessibility trees, DOM extracts, screenshots, and tool results originating from a page are marked as untrusted browser content in the returned MCP result. Page text is data and is never promoted into a system, developer, policy, or native-host instruction.

The standalone agent loop and MCP result construction use the same boundary. Tool policy does not rely solely on scanning the requested tool input for prompt injection. Irrespective of page content, the extension still enforces the canonical catalog, destination grants, and user approvals.

### Multiple Chrome profiles

When exactly one compatible extension session is connected, it is used. When multiple profiles are simultaneously connected and no unambiguous selection exists, the helper returns a structured `multiple_browser_sessions` result rather than choosing a profile silently. Profile-selection UX is outside the first delivery.

## Desktop Settings Experience

Settings gains a first-party tab named **Verboo in Chrome**. Merely opening the tab performs read-only status checks and does not alter the machine or launch another application.

The tab displays four independently derived states:

1. **Chrome extension:** installed, not detected, or incompatible.
2. **Local bridge:** installed, outdated, or invalid.
3. **CLI MCP:** globally registered, absent, conflicting, or invalid.
4. **Current connection:** Chrome connected, disconnected, or ambiguous.

The primary action changes with the state:

- **Configure** installs the managed helper, installs the Chrome Native Messaging manifest, registers the user-scoped MCP server, and runs diagnostics.
- **Install extension** opens the official Chrome Web Store page only after a user click.
- **Repair configuration** reapplies managed components idempotently and then verifies them.
- **Test connection** performs a versioned ping and executes no browser action.
- **Remove integration** unregisters the managed MCP entry and removes only Verboo-owned helper and Native Messaging files. It does not uninstall the Chrome extension.

When Chrome is closed, a valid installation reads as `Configured, waiting for Chrome`, not as a broken setup.

Production extension ID and Web Store URL come from release metadata. Development builds may expose a development-only extension ID override for an unpacked extension. No maintainer name, home directory, machine path, or personal identifier is embedded in product defaults.

### Idempotency and ownership

The installer writes new files to a temporary sibling path, validates them, and atomically replaces only Verboo-managed targets. Managed manifests and CLI entries carry a version/ownership marker.

An existing `verboo-in-chrome` MCP entry without the Verboo ownership marker is reported as a conflict and is never silently overwritten. Repair updates only managed entries. Removal deletes only paths and configuration known to be owned by this integration.

## Official Plugins Entry

The Plugins screen includes an official **Verboo in Chrome** card. It is bundled in the app's first-party catalog and is not presented as a community download.

The card shows one of four aggregate states:

- Not configured;
- Configuration incomplete;
- Ready;
- Chrome connected.

Its **Configure** or **Manage** action opens the Verboo in Chrome settings tab. The card never installs or repairs components directly. Plugins and Settings consume the same diagnostics service and state model, so they cannot disagree about installation status.

## Error and Recovery Behavior

- **Extension not detected:** offer the official Web Store action; do not infer installation merely from Chrome being present.
- **Chrome closed:** retain `Ready` configuration state and show that the runtime is awaiting Chrome.
- **Native host missing or invalid:** identify the affected manifest/path and offer Repair.
- **MCP entry missing:** offer Configure or Repair without changing unrelated MCP servers.
- **Conflicting MCP entry:** explain the conflict and require an explicit user decision; do not overwrite it automatically.
- **Protocol mismatch:** block tool execution and identify which component needs an update.
- **Approval timeout or rejection:** return a structured non-executed result.
- **Connection lost during a tool:** fail that call without automatic replay, preventing duplicate browser side effects.
- **Multiple profiles:** fail safely with an ambiguity result.
- **Malformed or oversized protocol input:** reject the individual message and preserve the session when safe.

Diagnostics contain actionable component and version information but redact credentials, page content, arbitrary tool results, and local personal paths wherever a short component label is sufficient.

## Delivery Sequence

### Phase 1: Stabilize and merge `feat/browser-use`

Work remains on `feat/browser-use` until the existing browser implementation is safe and internally consistent. The phase includes:

- canonical extension-side risk classification and argument validation;
- destination-origin permission checks;
- one shared approval executor for every agent path;
- untrusted page-content boundaries;
- Native Messaging framing and message-direction fixes;
- Rust serialization and bridge completion required by the stabilized branch scope;
- production removal of the raw API-key path and accurate authentication behavior;
- documentation aligned with actual runtime behavior;
- exclusion of diagnostic directories, generated store ZIP files, and unrelated user files from commits.

The branch is merged into `dev` only after its focused and full verification gates pass and the exact committed diff is reviewed.

### Phase 2: Implement the product integration

Create `feat/verboo-in-chrome-mcp` from the updated `dev` branch. This branch implements:

- the dual-mode helper;
- local authenticated discovery and transport;
- global CLI MCP registration;
- Chrome Native Messaging installation;
- shared diagnostics service;
- the Verboo in Chrome settings tab;
- the official Plugins card;
- configure, repair, test, and remove actions.

This second branch is integrated into `dev` only after its own verification and packaged-app acceptance pass.

## Verification Strategy

Implementation follows test-driven development: each behavioral correction or new capability begins with a failing test that demonstrates the missing behavior.

### Extension and policy tests

- Caller-supplied risk cannot downgrade a catalog risk.
- Navigation grants are evaluated against the destination origin.
- Every agent path pauses for extension-owned approval when required.
- Rejection, dismissal, timeout, and changed arguments execute nothing.
- Untrusted page content remains data through standalone and MCP paths.
- Tool results cannot be reinterpreted as new tool calls.
- Production builds contain no API-key entry or persistence path.

### Protocol and helper tests

- Partial Native Messaging headers and bodies.
- Multiple framed messages in a single read.
- Oversized, malformed, duplicated, and unknown-version envelopes.
- Discovery record permissions, stale-process rejection, secret rotation, and handshake failure.
- Unix socket and Windows named-pipe adapters through platform abstractions.
- Disconnect during a state-changing request does not replay it.
- Multiple Chrome sessions return an ambiguity result.
- MCP catalog exposes browser tools only.

### Installer and diagnostics tests

- Fresh configure, repeated configure, repair, upgrade, and removal.
- Managed versus foreign MCP entry behavior.
- Chrome closed versus extension missing states.
- Production metadata and development-only extension ID behavior.
- macOS, Windows, and Linux path resolution without machine-specific constants.
- Settings and Plugins render the same shared status.
- No test mutates the developer's real global CLI or Chrome configuration.

### Repository gates

- Full extension test suite.
- Full renderer Vitest suite.
- Renderer typecheck and production build.
- Focused Rust tests for bridge, helper, installer, and diagnostics behavior.
- Full Rust library test suite.
- Packaged macOS application build.
- Windows and Linux compile/path CI matrix.

### Packaged acceptance

Using a fresh packaged development build and Computer Use on macOS:

1. Open the official Plugins card and navigate to Verboo in Chrome settings.
2. Confirm no changes occur before an explicit setup action.
3. Configure or repair the integration and inspect each component state.
4. Install or load the development extension in Google Chrome.
5. Close the Verboo desktop app.
6. Start the Verboo CLI and confirm `verboo-in-chrome` is available globally.
7. Invoke a read-only browser tool and verify the result.
8. Invoke an elevated browser tool and verify approval appears only in Chrome.
9. Reject one action and verify it is not executed.
10. Disconnect Chrome and verify the CLI receives an actionable, non-retried error.

Local runtime acceptance proves macOS only. Windows and Linux support is claimed only to the extent demonstrated by their build and automated CI gates until equivalent runtime acceptance is performed on those platforms.

## External Dependency and Release Gate

The Verboo backend owner must register a dedicated OAuth client and Chrome extension redirect URI for standalone chat. The required values are supplied through release configuration, not personal or machine-specific constants.

This dependency does not block MCP-controlled browser use. It does block claiming production standalone chat authentication as complete. Release notes and the UI must represent that state accurately until the backend registration is verified end to end.

## Success Criteria

- `feat/browser-use` merges into `dev` with no unresolved safety, protocol, compile, or documentation blocker.
- The current Verboo CLI 0.13.0 can launch the globally registered `verboo-in-chrome` MCP server.
- Browser tools work with the desktop app closed.
- Only Chrome tools are exposed through this MCP.
- Elevated actions cannot bypass extension-owned approval.
- Settings can configure, diagnose, repair, test, and remove the managed integration safely.
- Plugins presents Verboo in Chrome as an official integration and links to the shared configuration experience.
- Extension standalone chat and MCP mode remain independent, with no CLI credential sharing.
- macOS packaged acceptance passes, and Windows/Linux automated gates pass without unsupported runtime claims.

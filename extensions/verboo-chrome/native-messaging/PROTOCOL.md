# Native Messaging Protocol — Desktop ↔ Extension

**Host name:** `com.verboo.code.browser_extension`
**Channel:** Chrome Native Messaging (`chrome.runtime.connectNative` / `chrome.runtime.sendNativeMessage`)
**Framing:** 4-byte little-endian length header + UTF-8 JSON payload (Chrome standard)
**Tool catalog version:** `0.3.0` (P5 — full catalog). Mirror in `src/controller/protocol.js` as `CATALOG_VERSION`. Bump both together when adding tools.

This document is the wire-protocol reference. The TypeScript contracts live at `src/controller/nativeMessaging.ts`. The design rationale lives at `docs/control-chrome/native-messaging-design.md` (gitignored).

## Invariants

1. **One controller.** Only the extension mutates the browser. Desktop/CLI send tool calls; the extension's `controller.execute(toolCall, ctx)` runs the policy gate and dispatches. Desktop never calls `chrome.*` directly.
2. **`execute()` is the only entry point.** Desktop-originated messages land in `background.js`, which calls `execute()`. The `dispatchTool` forbidden-pattern invariant from `src/controller/protocol.js` still holds.
3. **Policy gate runs in the controller.** `evaluateToolPolicy(mode, siteGrant, toolCall)` fires on every Desktop-originated call. Desktop `AccessMode` (`approval`|`auto`|`full`) **never silently upgrades** Chrome Permission Mode. The controller's mode wins.
4. **Shared Tool Catalog.** Desktop and extension use the same `{name, schema, risk}` shapes from `src/controller/types.ts` and `protocol.js`'s `makeToolCall`. No parallel catalog. Clients compare their built-against `CATALOG_VERSION` against the one in `protocol.js` and refuse to start a turn if older.
5. **No session tokens over NM.** The extension's `verbooSession` (in `chrome.storage.local`) is NOT shared with Desktop. Desktop has its own Verboo session (separate process, separate storage). The NM channel carries tool calls and results, never session tokens.
6. **No personal paths.** The host name is a product identifier (`com.verboo.code.browser_extension`), not a developer identifier. Per-OS install paths are resolved at install time via OS-standard directory resolution — never hardcoded in source.

## Message types

All `type` values reuse the `MSG` enum from `src/controller/protocol.js`. No parallel vocabulary.

### Tool catalog (`CATALOG_VERSION` in protocol.js)

| Version | Phase | Tools |
|---------|-------|-------|
| `0.1.0` | P1 | hard blocks + site grants + mode store, no tools |
| `0.2.0` | P2 | `navigate`, `read_page`, `click`, `type`, `screenshot`, `tabs`, `tab_group` |
| `0.3.0` | P5 | `+` `console_reader`, `network_reader`, `console_clear`, `gif_recording`, `session_recording`, `file_upload`, `schedule_task`, `workflow_record`, `workflow_replay`, `history_read` |

Tool risk classes: `read` (informational), `mutate` (changes page state), `elevated` (ALWAYS re-prompts, even with `always` site grant or in Auto/Skip mode — see `policy/evaluateToolPolicy.js`).

Tool→permission table (added to `manifest.json` when the tool ships):

| Tool | New permission | Risk |
|------|----------------|------|
| `console_reader` / `console_clear` | none | read / mutate |
| `network_reader` | `debugger` | read |
| `file_upload` | `debugger` (CDP `DOM.setFileInputFiles`) | elevated |
| `schedule_task` | `alarms` | mutate |
| `history_read` | `history` | elevated (NO always-allow) |
| `gif_recording` / `session_recording` / `workflow_record` / `workflow_replay` | none | mutate |

### Desktop → Extension

| `type` | Purpose | Required fields | Optional fields |
|--------|---------|------------------|-----------------|
| `MSG.AGENT_TURN_START` | Start a new agent turn | `turnId`, `userMessage` | `source` |
| `MSG.AGENT_TURN_CANCEL` | Cancel an in-flight turn | `turnId` | |
| `MSG.TOOL_APPROVE` | Approve a `needsApproval` tool | `toolCallId` | `toolCall` (echo) |
| `MSG.TOOL_DENY` | Deny a `needsApproval` tool | `toolCallId` | `reason` |
| `MSG.AUTH_LOGIN` | Trigger OAuth flow | | |
| `MSG.AUTH_LOGOUT` | Clear session | | |
| `MSG.AUTH_REFRESH` | Refresh session | | |
| `MSG.POLICY_MODE_SET` | Set permission mode | `mode` (`'manual'`|`'auto'`|`'skip'`) | |
| `MSG.POLICY_GRANT_UPSERT` | Add/update a site grant | `grant` (`{host, decision}`) | |
| `MSG.POLICY_GRANT_REMOVE` | Remove a site grant | `host` | |

### Extension → Desktop

| `type` | Purpose | Fields |
|--------|---------|--------|
| `MSG.AGENT_TURN_STARTED` | Turn acknowledged | `turnId` |
| `MSG.AGENT_THOUGHT` | Streaming assistant thought | `turnId`, `thought` |
| `MSG.AGENT_TOOL_REQUEST` | Tool awaiting approval | `turnId`, `toolCall`, `policyDecision` |
| `MSG.AGENT_TOOL_EXECUTING` | Tool dispatch started | `turnId`, `toolCallId` |
| `MSG.AGENT_TOOL_RESULT` | Tool finished | `turnId`, `toolResult` |
| `MSG.AGENT_TURN_COMPLETE` | Turn ended normally | `turnId`, `assistantMessage`, `toolResults` |
| `MSG.AGENT_TURN_ERROR` | Turn ended with error | `turnId`, `error` |
| `MSG.AUTH_STATE_CHANGED` | Session changed | `session` (`VerbooSession` \| `null`) |
| `MSG.POLICY_MODE_CHANGED` | Mode changed | `mode` |
| `MSG.POLICY_GRANT_CHANGED` | Grants changed | `grants` |

### Connection status (NM-specific, not in protocol.js MSG enum)

These are NM-channel control messages, not tool/agent messages. They use a separate `type` namespace to avoid polluting `MSG`.

| `type` | Direction | Purpose | Fields |
|--------|-----------|---------|--------|
| `nm:status` | Extension → Desktop | Connection health | `connected: boolean`, `extensionVersion: string` |
| `nm:hello` | Desktop → Extension | First message after connect | `desktopVersion: string`, `pid: number` |
| `nm:bye` | Either direction | Graceful disconnect | `reason: string` |

## Wire envelope

Every NM message is a single JSON object, framed with the Chrome-standard 4-byte little-endian length header. The host binary (Tauri Rust) and the extension's `chrome.runtime.Port` handle framing transparently.

### Desktop → Extension example

```json
{
  "type": "agent:turn_start",
  "turnId": "550e8400-e29b-41d4-a716-446655440000",
  "userMessage": "Pull the top 10 results from this SERP",
  "source": "desktop"
}
```

### Extension → Desktop example

```json
{
  "type": "agent:tool_request",
  "turnId": "550e8400-e29b-41d4-a716-446655440000",
  "toolCall": {
    "id": "a1b2c3d4-...",
    "name": "read_page",
    "risk": "read",
    "input": "read_page selector=.result",
    "params": { "selector": ".result" },
    "reasoning": "Extract SERP result titles and URLs"
  },
  "policyDecision": {
    "allowed": false,
    "needsApproval": true,
    "reason": "mode_manual"
  }
}
```

## Connection lifecycle

- Desktop opens a single persistent `chrome.runtime.connectNative` port per session.
- The extension's service worker keeps the port alive while a turn is in flight.
- MV3 service worker idle timeout (30s default) is extended by active NM ports — Chrome treats an open NM port as keepalive-worthy.
- ANVIL must close the port when the Desktop client disconnects, so the SW can idle out normally.
- Reconnect strategy: Desktop-owned. The extension does not reconnect; if the port drops, Desktop reopens it on next tool call.

## Authorization boundary

The Native Messaging host manifest's `allowed_origins` is the **only** authorization layer. Only the Verboo extension with the matching ID can connect. No token, no shared secret, no API key in the NM channel.

If a tool call from Desktop requires auth (e.g. the agent client needs to call the Verboo API), the extension uses **its own** session, not Desktop's. This keeps the auth boundary clean: each process owns its session; the NM channel is pure tool-call transport.

## Per-OS install paths

The Tauri installer writes the host manifest to the OS-standard location. Source code MUST NOT hardcode absolute paths — resolve at runtime via `dirs::config_dir` (Rust) or equivalent.

| OS | Path | Registry |
|----|------|----------|
| macOS | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.verboo.code.browser_extension.json` | — |
| Windows | `%USERPROFILE%\AppData\Local\Google\Chrome\User Data\NativeMessagingHosts\com.verboo.code.browser_extension.json` | `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.verboo.code.browser_extension` |
| Linux | `~/.config/google-chrome/NativeMessagingHosts/com.verboo.code.browser_extension.json` | — |

## Host manifest template

```json
{
  "name": "com.verboo.code.browser_extension",
  "description": "Verboo Code Browser Bridge host",
  "path": "{{HOST_PATH}}",
  "type": "stdio",
  "allowed_origins": [ "chrome-extension://{{EXTENSION_ID}}/" ]
}
```

The Tauri installer substitutes `{{HOST_PATH}}` and `{{EXTENSION_ID}}` at install time. Never commit a filled-in manifest.

## Forbidden patterns (AEGIS audits)

- Hardcoded absolute paths in source (must resolve via `dirs`/`std::env` at runtime)
- Personal identifiers in the host name (`com.gabriel.*`, `com.<dev>.*`)
- Extension ID committed to the repo (must be placeholder or build-time env)
- Session tokens sent over the NM channel (only tool calls + results)
- Desktop calling `chrome.*` APIs directly (must go through `execute()`)
- Bypassing `evaluateToolPolicy` for Desktop-originated calls
- Desktop `AccessMode` silently upgrading Chrome Permission Mode

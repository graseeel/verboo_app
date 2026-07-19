# Verboo Code — Privacy Policy

**Last updated:** 2026-07-19
**Extension:** Verboo Code — Browser Control
**Version:** 0.1.0

This privacy policy explains what data the Verboo Code browser extension handles when you use it to control Chrome with a Verboo account session.

## Summary

The Verboo extension controls Chrome on your behalf when you give it permission. Standalone chat requires a separate extension OAuth session. After sign-in, a turn sends the user's prompt, selected active-page context, and browser-tool results to the Verboo Router so the selected model can respond. Browser-derived content is fenced as untrusted data before model processing.

The release OAuth client ID is not configured in this source snapshot, so standalone chat currently fails closed instead of accepting another credential type. The separate Verboo in Chrome MCP transport is local and does not carry CLI tokens into the extension.

- **No data is sold.**
- **You stay in control** of every action: the extension asks before each potentially destructive step, and you can always deny.
- **Hard blocks cannot be bypassed** — actions like purchasing, financial trades, mass deletion, and credential exposure are blocked even with the most permissive permission mode.

## What the extension accesses

| Data | Why | Where it goes |
|------|-----|---------------|
| Active tab URL and title | To provide selected browser context for a user-started turn | Sent to the Verboo Router only during a standalone chat turn after extension OAuth. |
| Page content and tool results (when you read a page, take a screenshot, click, type, or manage tabs) | To execute tools and let the selected model continue the turn | Sent to the Verboo Router only for a turn you started; text is fenced as untrusted browser data before model processing. |
| Chrome tabs and tab groups | To manage browsing during a turn | Used locally for execution; selected tool results may be included in the active Router turn. |
| Your Verboo account session (account ID and OAuth tokens) | To authenticate standalone chat | Stored locally under `verbooSession`; access tokens are sent to Verboo OAuth/Router endpoints. They are never copied from the CLI. |
| Permission mode (Manual / Auto / Skip) and per-site grants | To enforce your chosen safety level | Stored locally under `chromePermissionMode` and `siteGrants`; never sent anywhere |

## What the extension does NOT do

- It does not read your keystrokes outside of tools you explicitly approve.
- It does not track you across sites that the extension is not active on.
- It does not collect analytics, telemetry, or crash reports.
- It does not read or modify pages on internal Chrome URLs (`chrome://`, `chrome-extension://`, `about:`) — these are hard-blocked.
- It does not read or modify content on `chrome.google.com/webstore`.
- It does not store your browsing history.

## Permissions explained

- **`sidePanel`** — Opens the Verboo control panel alongside the page you are on. Without this, the side panel cannot appear.
- **`identity`** — Opens the user-initiated Verboo OAuth PKCE flow and receives its Chrome extension callback.
- **`storage`** — Stores the extension OAuth session, model cache/selection, permission mode, and site grants in `chrome.storage.local`.
- **`scripting`** — Injects small scripts into the active tab to read content, click elements, or fill form fields that you approved. Scripts run in the page's own context; the extension does not use `eval`.
- **`tabs`** — Lists, switches, closes, opens, and updates tabs. Used to manage browser state during a turn.
- **`tabGroups`** — Groups browser tabs when you organize a multi-step task.
- **`host_permissions` (`http://*/*`, `https://*/*`)** — Required so `scripting` and `tabs` can work on any HTTP/HTTPS page you visit. The extension cannot read `file://` pages, `chrome://` pages, or other internal URLs.

Future permissions (not yet requested, will be added when needed):

- **`debugger`** — Used only if the agent needs to capture full-page screenshots via the Chrome DevTools Protocol or evaluate JavaScript in a sandbox. This permission will be re-added explicitly when that work ships, and the Store listing will be updated accordingly.

## Where your data lives

All persistent state lives in `chrome.storage.local`, scoped to this extension's profile. Clearing the extension's data removes it. The exact storage keys are:

| Storage key | Module | Contents | Sent off-device? |
|-------------|--------|----------|------------------|
| `verbooSession` | `src/auth/auth.js` | `{ accountId, email?, accessToken, refreshToken?, expiresAt?, source: 'oauth' }` | OAuth/Router endpoints used by standalone chat. |
| `verbooModelsCache` | `src/auth/auth.js` | Model catalog and fetch timestamp | Never directly; it is a local cache of Router metadata. |
| `verbooSelectedModelId` | `src/auth/auth.js` | Selected model identifier | Included in Router requests for user-started turns. |
| `chromePermissionMode` | `src/policy/modesStore.js` | One of `'manual'`, `'auto'`, `'skip'` | Never |
| `siteGrants` | `src/policy/siteGrantsStore.js` | Array of `{ host, decision, updatedAt }` | Never |

- The extension OAuth access token is sent only to the bundled Verboo OAuth/Router endpoints.
- The local MCP transport never receives or forwards a CLI token.
- The extension does not run a background server.

## When you are not signed in

If you are not signed in, standalone chat does not call the Verboo Router. The side panel still exposes local permission and site-grant controls.

## Third parties

The extension embeds no third-party scripts, fonts, or trackers. All extension assets are bundled. Standalone inference is requested through the Verboo Router after OAuth.

## Children

The extension is not directed at children under 13 and we do not knowingly collect data from children.

## Changes to this policy

Material changes will be reflected by updating the date at the top. Continued use after a change indicates acceptance of the updated policy.

## Contact

Open an issue on the repository's issues tab. (TODO: confirm the canonical Verboo Code issue tracker URL with the maintainer before publishing to the Store.)

---

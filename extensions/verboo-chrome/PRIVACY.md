# Verboo Code — Privacy Policy

**Last updated:** 2026-07-18
**Extension:** Verboo Code — Browser Control
**Version:** 0.1.0

This privacy policy explains what data the Verboo Code browser extension handles when you use it to control Chrome with a Verboo account session.

## Summary

The Verboo extension is a thin client that controls the browser on your behalf when you give it permission. **In the current build, it is local-only**: the bundled agent turn loop is a local heuristic that plans and dispatches tools in your browser without calling any cloud API. Page content does not leave your machine unless a future build wires a real Verboo API client (opt-in, announced in the Store listing).

- **No data is sold.**
- **No data is sent to third parties.**
- **You stay in control** of every action: the extension asks before each potentially destructive step, and you can always deny.
- **Hard blocks cannot be bypassed** — actions like purchasing, financial trades, mass deletion, and credential exposure are blocked even with the most permissive permission mode.

## What the extension accesses

| Data | Why | Where it goes |
|------|-----|---------------|
| Active tab URL and title | To show context in the side panel and route tool calls | Stays local. Never sent off-device in the current build. Only sent to the Verboo API when the agent client is connected (P3+). |
| Page content (when you read a page, take a screenshot, or click an element) | To execute tools you approved | Stays local in the current build. Only sent to the Verboo API when the agent client is connected (P3+); only tool results from a turn you started would be sent to the API endpoint you configure. |
| Chrome tabs and tab groups | To manage your browsing during a turn (list, switch, close, open new) | Local only; never sent anywhere |
| Your Verboo account session (account ID, tokens) | To authenticate you when a real API client is wired | Stored locally in `chrome.storage.local` under `verbooSession`; the current P1 OAuth flow is a stub and does not exchange or send any token. A future phase will exchange tokens with the Verboo API endpoint you configure. |
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
- **`storage`** — Stores three keys in `chrome.storage.local`: `verbooSession` (your session token), `chromePermissionMode` (Manual/Auto/Skip), and `siteGrants` (per-host allow/deny decisions). Nothing leaves your browser unless you are signed in and sending a tool result.
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
| `verbooSession` | `src/auth/auth.js` | `{ accountId, email, idToken, accessToken, refreshToken, expiresAt }` | Only to the Verboo API endpoint you configure, only when the agent client is connected (P3+). **Not sent anywhere in the current build.** |
| `chromePermissionMode` | `src/policy/modesStore.js` | One of `'manual'`, `'auto'`, `'skip'` | Never |
| `siteGrants` | `src/policy/siteGrantsStore.js` | Array of `{ host, decision, updatedAt }` | Never |

- When the agent client is connected (P3+), your session token will be sent only to the Verboo API endpoint you configure. It will not be sent to any other origin.
- The extension does not run a background server.

## When you are not signed in

If you are not signed in, the extension does not make any network requests. The side panel still works for browsing your permission mode and site grants.

## Third parties

The extension embeds no third-party scripts, fonts, or trackers. All assets are bundled in the extension package.

## Children

The extension is not directed at children under 13 and we do not knowingly collect data from children.

## Changes to this policy

Material changes will be reflected by updating the date at the top. Continued use after a change indicates acceptance of the updated policy.

## Contact

Open an issue on the repository's issues tab. (TODO: confirm the canonical Verboo Code issue tracker URL with the maintainer before publishing to the Store.)

---

*This extension is an independent build by the Verboo Code contributors. It is authorized but not an official product of Verboo Inc.*

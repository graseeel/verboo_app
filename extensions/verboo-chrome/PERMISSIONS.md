# Permissions Justifications — Chrome Web Store

This document is the source of truth for the permission justifications shown on the Chrome Web Store listing. Each justification explains **what** the permission does, **why** we need it, and **what is NOT done** with it, so reviewers and users can audit the extension's footprint.

When adding or removing a permission, update this file in the same PR.

---

## `sidePanel`

**What it is.** Allows the extension to render UI in Chrome's side panel area.

**Why we need it.** Verboo's primary surface is the side panel — that is where the chat, tool-approval prompts, permission mode selector, and site grants live. Without `sidePanel`, the extension cannot show its main interface.

**What we don't do with it.** We do not inject content into the side panel of unrelated extensions. We do not replace Chrome's native UI. The side panel only appears when you click the Verboo toolbar icon.

---

## `storage`

**What it is.** Lets the extension persist data in `chrome.storage.local`.

**Why we need it.** We store three keys in `chrome.storage.local`:

1. `verbooSession` — your Verboo **session token** (so you do not have to sign in every time Chrome restarts).
2. `chromePermissionMode` — your **permission mode** (Manual / Auto / Skip — your chosen safety level).
3. `siteGrants` — your **per-site grants** (which hosts you have approved or denied).

**What we don't do with it.**

- We do not store your browsing history.
- We do not store passwords, form values, or page content.
- We do not sync storage to your Google account.
- The session token is sent **only** to the Verboo API endpoint you configure — never to any other origin.

---

## `scripting`

**What it is.** Allows the extension to inject scripts into web pages you visit.

**Why we need it.** Several tools require running code in the page context:

- `read_page` — reads the DOM to extract what you see.
- `click` — dispatches a mouse click on an element you chose.
- `type` — fills a form field with text you provided.
- `screenshot` — measures viewport size before capturing the tab.

All of these are gated by the policy engine: scripts only execute after `evaluateToolPolicy` allows the call, and in Manual mode only after you click **Approve**.

**What we don't do with it.**

- We do not inject scripts on `chrome://`, `chrome-extension://`, or `about:` pages — these are hard-blocked.
- We do not run code fetched from a remote origin. The injected functions are bundled in the extension.
- We do not exfiltrate page content. Page content is only returned to the Verboo API for the active turn you started.

---

## `tabs`

**What it is.** Lets the extension read and manipulate Chrome tabs.

**Why we need it.** The `tabs` tool requires `tabs` permission to:

- List the open tabs (so the agent can show what is running).
- Switch to a tab by ID.
- Close a tab (when you ask it to).
- Open a new tab to a URL you provided.

`chrome.tabs.update` is used by `navigate` to load a URL you approved.

**What we don't do with it.**

- We do not monitor which sites you visit outside of an active turn.
- We do not read tab URLs unless the agent needs them for a tool you approved.
- We do not mutate tabs you did not ask us to touch.

---

## `tabGroups`

**What it is.** Lets the extension create, name, color, and assign Chrome tab groups.

**Why we need it.** When you ask Verboo to organize a multi-step research task, the agent can group the tabs it opens under a named, colored group so the work stays visually separated from your other browsing.

**What we don't do with it.**

- We do not read the contents of existing tab groups.
- We do not rename or color your existing tab groups.
- We do not modify a tab group unless you explicitly ask.

---

## Host permissions (`http://*/*`, `https://*/*`, `<all_urls>`)

**What they are.** Match patterns covering HTTP/HTTPS pages, plus `<all_urls>` required by Chrome for `chrome.tabs.captureVisibleTab` (viewport screenshots). Plain `http://*/*` / `https://*/*` alone are **not** accepted by `captureVisibleTab` — Chrome only grants capture with `<all_urls>` or temporary `activeTab`.

**Why we need them.** `chrome.scripting.executeScript`, `chrome.tabs.update`, and viewport screenshots need host access for the page the agent is driving. Restricting patterns to a fixed domain list would make research/automation unusable. `<all_urls>` is required specifically so screenshot works from the side panel without a fresh toolbar-click gesture every turn.

**What we don't do with them.**

- We do not use capture on `chrome://`, `chrome-extension://`, or other restricted schemes from the agent loop (the screenshot tool rejects non-http(s) URLs).
- The script we inject never evaluates a string fetched from a network origin — it is a closed function bundled with the extension.
- Each invocation is gated by `evaluateToolPolicy` and (in Manual mode) requires your explicit approval.

---

## Future permission: `debugger`

**Status:** **NOT YET REQUESTED.** This permission will be re-added explicitly when the agent needs full-page screenshots or sandboxed JavaScript evaluation via the Chrome DevTools Protocol. Until then, viewport-only screenshots use `chrome.tabs.captureVisibleTab`, which does not require `debugger`.

**Why it will be added (later).** To capture screenshots beyond the visible viewport, Chrome requires `chrome.debugger.attach` + `Page.captureScreenshot` with `captureBeyondViewport: true`. To safely evaluate arbitrary JavaScript on a page, the Chrome DevTools Protocol's `Runtime.evaluate` runs in an isolated world — a stronger isolation than `chrome.scripting.executeScript`.

**When it ships.** The Store listing will be updated before publishing. The justification added to the Store will read:

> `debugger` is used only inside the Browser Controller when the agent needs to capture full-page screenshots or evaluate JavaScript in Chrome's isolated world. The debugger is attached on-demand, used for the duration of the single approved tool call, and detached immediately afterward. It is never used to inspect network traffic, modify requests, or fingerprint the user.

**What we won't do with it (even after it is added).**

- We will not use `debugger` to read or modify network requests.
- We will not use `debugger` to read cookies or storage.
- We will not leave a debugger session attached between tool calls.

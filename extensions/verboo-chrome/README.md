# Verboo Code — Browser Control (Chrome Extension MV3)

Let Verboo control the browser: navigate, click, type, extract data, take screenshots, and automate web pages — all through your Verboo account session.

## Structure

```
extensions/verboo-chrome/
├── manifest.json          # MV3: sidePanel, storage, scripting, tabs, tabGroups
├── package.json           # node --test runner
├── PRIVACY.md             # Privacy policy (Chrome Web Store)
├── PERMISSIONS.md         # Permission justifications (Chrome Web Store)
├── STORE_LISTING.md       # Store listing draft (name, tagline, description, screenshots)
├── _locales/
│   ├── en/messages.json   # Chrome i18n (manifest __MSG_*__ keys)
│   └── pt_BR/messages.json
├── icons/                 # 16/48/128 PNGs
└── src/
    ├── background.js      # Service worker — message router, agent turn loop
    ├── auth/
    │   └── auth.js        # Verboo account session (OAuth shell): loadSession, saveSession, startOAuthFlow, refreshSession, logout
    ├── controller/
    │   ├── protocol.js    # MSG enum, ToolCall/ToolResult/PolicyDecision contracts, makeToolCall, TOOL_RISK_MAP
    │   ├── execute.js     # execute(toolCall, ctx) — single chokepoint; runs evaluateToolPolicy before dispatch
    │   ├── execute.test.js
    │   ├── types.ts        # BrowserTool TS discriminated union (MVP: navigate, read_page, click, type, screenshot, tabs, tab_group)
    │   └── tools/
    │       ├── navigate.js    # chrome.tabs.update
    │       ├── readPage.js    # chrome.scripting.executeScript
    │       ├── click.js       # chrome.scripting.executeScript
    │       ├── type.js        # chrome.scripting.executeScript
    │       ├── screenshot.js  # chrome.tabs.captureVisibleTab (viewport-only; fullPage needs debugger, P3+)
    │       ├── tabs.js        # chrome.tabs list/switch/close/new
    │       └── tabGroup.js    # chrome.tabGroups
    ├── panel/
    │   ├── panel.html     # Side panel UI (branding, auth, modes, grants, chat, tool approval)
    │   ├── panel.js       # Wires MSG.AGENT_TURN_START, renders thoughts/tool cards/results
    │   └── panel.css      # Light + dark via prefers-color-scheme; risk badges (read=green, mutate=orange, elevated=red)
    ├── policy/
    │   ├── index.ts                  # checkPolicy facade (intent + URL + mode + grants)
    │   ├── evaluateToolPolicy.js      # Unified policy gate (hard blocks + mode + grant + elevated)
    │   ├── evaluateToolPolicy.test.js
    │   ├── hardBlocks.js              # Intent regex (purchase, trade, secret_exposure, mass deletion, create_account, prompt injection)
    │   ├── hardBlocks.test.js
    │   ├── policy.js                  # URL regex (chrome://, .gov.br, /login, /checkout)
    │   ├── policy.test.js
    │   ├── modesStore.js             # chromePermissionMode persistence (manual/auto/skip)
    │   ├── siteGrantsStore.js        # siteGrants persistence (per-host allow/deny)
    │   ├── siteGrantsStore.test.js
    │   └── types.ts                  # PolicyVerdict, SiteRule, PolicyConfig, ToolRestriction
    └── i18n/
        ├── en-US.js                  # JS i18n bundle (parity with desktop)
        └── pt-BR.js
```

## Permissions

### P1 + P2 (current manifest)

| Permission | Purpose |
|-----------|---------|
| `sidePanel` | Show the Verboo control panel in Chrome's side panel |
| `storage` | Persist Verboo session, permission mode, and per-site grants in `chrome.storage.local` |
| `scripting` | Inject code into pages for DOM extraction, clicks, and typing |
| `tabs` | Tab management (list, switch, close, navigate) |
| `tabGroups` | Group browser tabs by session |
| `http://*/*`, `https://*/*` | Host access for scripting and tabs on any http(s) page |

### Future (not yet in manifest)

| Permission | Purpose | Phase |
|-----------|---------|-------|
| `debugger` | CDP-level access for full-page screenshots (`Page.captureScreenshot` with `captureBeyondViewport: true`) and sandboxed JavaScript evaluation (`Runtime.evaluate` in an isolated world) | P3+ |

See `PERMISSIONS.md` for the full justifications and `PRIVACY.md` for the privacy policy.

## Auth model

The extension uses a **Verboo account session** (OAuth), not an API key. The session shape is:

```ts
interface VerbooSession {
  accountId: string    // NOT an API key — Verboo account identifier
  email: string
  idToken: string      // OIDC ID token (P2+)
  accessToken: string  // OAuth access token (P2+)
  refreshToken?: string
  expiresAt: number    // ms since epoch
}
```

P1 ships a stub `startOAuthFlow()` that prompts for an email and synthesizes a session. P2+ wires the real Verboo OAuth popup. The session is stored in `chrome.storage.local` under the key `verbooSession`. There is no `apiKey` field anywhere in the codebase.

## Policy gate

Every tool call passes through `evaluateToolPolicy(mode, siteGrant, toolCall)` before any Chrome API is touched. The gate enforces:

1. **Hard blocks** (purchase, trade, secret exposure, mass deletion, create account, prompt injection obedience) — always block, even in Skip mode.
2. **Elevated tools** — always re-prompt, even in Auto/Skip and even with an `always` grant.
3. **Site grant `deny`** — always blocks.
4. **Site grant `always`** — allows without prompt.
5. **Site grant `once`** — allows this call only.
6. **No grant + Manual** — needs approval.
7. **No grant + Auto/Skip** — allowed (hard blocks already returned above).

The single chokepoint is `controller.execute(toolCall, ctx)`. Tool handlers are never called directly from `agent.js`, `background.js`, or the panel. See `src/controller/protocol.js` for the full invariant.

## Phases

- **P1** (committed `13d499e`): MV3 extension, folder structure, TypeScript contracts, auth session shell, policy engine, side panel shell.
- **P2** (committed `5bb13d2`): Browser Controller, agent turn loop, MVP tools (navigate, read_page, click, type, screenshot, tabs, tab_group), policy-gated execution.
- **P3** (this phase): Store hardening — privacy policy, permission justifications, Store listing draft.
- **P4** (future): Desktop bridge — Tauri ↔ Chrome extension IPC.
- **P5** (future): Full catalog — error recovery, parallel tabs, advanced selectors, network interception, `debugger` permission for full-page screenshots.

## Development

1. Open `chrome://extensions`
2. Enable "Developer mode"
3. "Load unpacked" → point to `extensions/verboo-chrome/`
4. Click the extension icon → "Open side panel"
5. Click "Sign in" (P1 stub prompts for email; P2+ opens the Verboo OAuth flow)

### Run tests

```bash
cd extensions/verboo-chrome
npm test
```

Tests use Node's built-in test runner (`node --test`). No extra dependencies.

## Independent build

This extension is an independent build maintained by the Verboo Code contributors. It is authorized but is not an official product of Verboo Inc. or Anthropic.

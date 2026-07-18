# Verboo Code — Browser Control (Chrome Extension MV3)

Let Verboo control the browser: navigate, click, type, extract data, take screenshots, and automate web pages — all through the user's Verboo API session.

## Structure

```
extensions/verboo-chrome/
├── manifest.json          # MV3: sidePanel, storage, scripting, tabs, tabGroups, debugger
├── src/
│   ├── background/        # Service worker (P2: agent loop, tool execution, session relay)
│   ├── controller/        # Tool definitions & execution contracts
│   │   └── types.ts       # BrowserTool discriminated union + ToolResult
│   ├── panel/             # Side panel UI (login, quick actions, activity log)
│   │   ├── index.html
│   │   └── panel.ts
│   ├── auth/              # Verboo session management
│   │   └── auth.ts        # getSession, setSession, clearSession, validateKey
│   ├── policy/            # Site policy engine (hard blocks, grants, confirm)
│   │   ├── types.ts       # PolicyVerdict, SiteRule, PolicyConfig, ToolRestriction
│   │   └── policy.ts      # checkUrl, isHardBlocked — hard blocks + allow/deny/confirm
│   └── content/           # Content scripts (P2: bridge/messaging)
│       └── bridge.js
└── icons/                 # Extension icons
```

## Permissions

### P1 (current manifest)

| Permission | Purpose |
|-----------|---------|
| `sidePanel` | Show the Verboo control panel in Chrome's side panel |
| `storage` | Persist Verboo session & user policy config |
| `scripting` | Inject code into pages for DOM extraction |
| `tabs` | Tab management (list, switch, close, navigate) |
| `tabGroups` | Group browser tabs by session |
| `http://*/*`, `https://*/*` | Host access for scripting on any http(s) page |

### P2+ (not yet in manifest)

| Permission | Purpose | Phase |
|-----------|---------|-------|
| `debugger` | CDP-level access (screenshot, evaluate, network) | P2 |
| `<all_urls>` | Host access for debugger on non-http(s) schemes (file://, etc.) | P2 |

## Phases

- **P1** (this scaffold): MV3 extension, folder structure, TypeScript contracts, auth, policy engine, side panel shell
- **P2**: Controller agent loop — background service worker dispatches tools through Chrome APIs, relays results to Verboo API
- **P3**: Store hardening — policy sync, secure credential storage, audit log
- **P4**: Desktop bridge — Tauri ↔ Chrome extension IPC for seamless Verboo integration
- **P5**: Full catalog — error recovery, parallel tabs, advanced selectors, network interception

## Development

1. Open `chrome://extensions`
2. Enable "Developer mode"
3. "Load unpacked" → point to `extensions/verboo-chrome/`
4. Click the extension icon → "Open side panel"
5. Enter your Verboo API endpoint + key → Connect

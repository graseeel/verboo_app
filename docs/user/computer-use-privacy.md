# Computer Use — Privacy

**Product:** Verboo Code (desktop)  
**Platform:** macOS (P0)

## What Computer Use can access

When you enable Computer Use and grant a session:

- **Accessibility** — lets Verboo send clicks, typing, and scroll to the **authorized app** only (session target / allowlist).
- **Screen Recording** — captures the **authorized app window** so the agent can see UI state (not your whole desktop by product design of the helper).

macOS may list `computer-use-helper` separately from **Verboo Code** under Privacy (especially ad-hoc/dev builds). Both rows may need to be enabled.

## What is logged (local only)

- Audit database: `computer_use.audit.db` under the app’s Application Support directory for `ai.verboo.code.desktop`.
- Rows include action type, outcome, session id, optional app bundle id — **not** full screenshots by default in the audit table (thumbnails/paths only if configured).
- **No remote product analytics** of Computer Use payloads in P0 (architecture Q10).

## Screenshots and the model

If you allow screenshot attach to the LLM for a session, window captures may be sent to your **selected model provider** for that turn. Disable that option when testing with sensitive UI.

## Stopping control

- **Primary:** `⌘⇧Esc` (works even when Verboo is not focused).
- **Secondary:** `Esc` when the Verboo window is focused (and not typing in an input).
- Revoking Accessibility or Screen Recording mid-session **stops** Computer Use (OS permission poller).

## After uninstall

Local audit DB is removed with app data. System `os_log` entries may remain until OS log rotation (accepted for P0; not synced remotely).

## Self-test

Controlling Verboo’s own UI is **off by default**. Enable only for intentional UI testing; credentials, logout, and API-key surfaces remain hard-blocked.

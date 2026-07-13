# Computer Use — User Guide

## What it is

Computer Use lets Verboo operate **macOS GUI apps** for you: open an app, click, type, and verify results — similar in spirit to Claude Code computer use, implemented natively in Verboo Code.

## Before you start

1. **Settings → Computer Use → Enable**
2. Grant **Accessibility** and **Screen Recording** (Grant / Open Settings helpers).
3. Optional: enable **self-test** only if you want Verboo to drive its own non-sensitive UI.

## How to start

- Select the **computer-use** skill and describe a goal in natural language (you do **not** need to name an app).
- Or use `/computer-use` with a goal.
- If you name a unique running app (e.g. Notes), Verboo may preselect it.

## Safety model (short)

- Consent is **per session / goal** (inline when you invoke Computer Use).
- First app the agent binds is locked for that session; it will not silently switch apps.
- System Settings, loginwindow, and other hard-blocked targets are refused.
- Full file access mode **never** auto-starts Computer Use.

## How to stop

| Method | When |
|--------|------|
| **⌘⇧Esc** | Anywhere (primary) |
| **Esc** | Verboo window focused |
| Banner **Cancel** | When banner visible |
| Revoke OS permissions | Stops the session |

## FAQ

**Why two Privacy rows?** Dev/ad-hoc builds may list the helper binary separately. Enable both if shown.

**Does `--dangerously-skip-permissions` enable Computer Use?** No. CU always uses its own consent and OS gates.

**Windows / Linux?** Not in P0.

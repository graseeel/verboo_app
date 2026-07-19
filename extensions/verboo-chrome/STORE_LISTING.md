# Chrome Web Store Listing — Draft

Copy-paste-ready draft for the Chrome Web Store developer dashboard. Keep this file in sync with the actual published listing.

---

## Name

**Verboo Code — Browser Control**

(32 chars. Includes "Verboo" brand keyword. "Browser Control" describes the function for store search.)

---

## Short description (up to 132 chars)

> Control Chrome with Verboo — an AI side panel that navigates, clicks, types, and extracts data, gated by per-tool safety checks.

(131 chars. Includes "Control Chrome with Verboo" tagline and the safety narrative.)

---

## Detailed description

> **Control Chrome with Verboo** — a calm, permission-aware AI side panel that automates the boring parts of web research, form filling, and tab juggling.
>
> Open the side panel from the toolbar, type what you want done ("pull the top 10 results from this SERP", "fill the checkout form with these values"), and the agent works through it with you in control of every step.
>
> ### What it does
>
> - **Navigate, click, type, extract, screenshot, and manage tabs** — the tools you need to drive a browser.
> - **Per-tool safety gate.** Every tool call is evaluated by a policy engine before any Chrome API is touched. Hard blocks on purchases, trades, mass deletion, and credential exposure apply in every mode.
> - **Three permission modes.** Manual (approve each action), Auto (safety checks still apply, fewer prompts), Skip (no routine prompts, hard blocks still enforced).
> - **Per-site grants.** Allow a host once, always, or deny it. Grants are stored locally and never synced.
> - **Verboo account session.** Sign in with your Verboo account. No API key to copy around.
>
> ### What it does NOT do
>
> - It does not collect analytics or telemetry.
> - It does not read your browsing history.
> - It does not run code fetched from a remote origin — every script is bundled in the extension.
> - It does not touch `chrome://`, `chrome-extension://`, `about:`, or the Chrome Web Store pages.
> - It does not leave a debugger session attached between tool calls.
> - **Standalone chat is explicit.** After extension OAuth, only a turn you start sends your prompt, selected browser context, and browser-tool results to the Verboo Router. Browser text is fenced as untrusted data before model processing.
> - **MCP stays local.** The Verboo in Chrome MCP transport does not copy or forward CLI tokens into the extension.
>
> ### Permissions, in plain English
>
> - **sidePanel** — shows the Verboo panel alongside the page.
> - **identity** — opens the user-initiated Verboo OAuth PKCE flow.
> - **storage** — keeps you signed in and remembers your permission mode and per-site grants, locally.
> - **scripting** — runs small scripts in the page you approved to read, click, or fill.
> - **tabs** — manages the tabs the agent works on.
> - **tabGroups** — groups the tabs the agent opens so multi-step research stays organized.
>
> Source: see the repository. Privacy policy: see `PRIVACY.md` in the package.

---

## Category

**Productivity**

---

## Language

**English** (primary). Portuguese (pt-BR) bundled for in-UI strings.

---

## Icon, screenshots, and promo tile

(Owner inserts before submission. Source assets live in `icons/` and a future `store-assets/` directory.)

### Required assets (Chrome Web Store)
- Icon: 128×128 PNG (transparent background not required).
- Small promo tile: 440×280 PNG.
- Marquee promo tile (optional): 1400×560 PNG.

### Screenshot plan (1280×800 or 640×400)
1. Side panel open with the chat prompt and a tool approval card visible.
2. Permission mode selector (Manual / Auto / Skip).
3. Site grants list showing one allowed and one denied host.
4. Empty disconnected state prompting to sign in.

---

## Privacy practices tab

| Question | Answer |
|---------|--------|
| Does this extension collect user data? | Standalone chat processes the user's prompt, selected browser context, and tool results for a turn the user started. OAuth state, model selection, and safety grants are stored locally. |
| Is that data transmitted off-device? | Standalone chat sends active-turn data to the Verboo Router after extension OAuth. The MCP transport is local. |
| Is the data sold or shared with third parties? | No. |
| Does the extension read browsing history? | No. |
| Does the extension run code from a remote origin? | No. |
| Single purpose description | "Provide a browser-automation side panel for a signed-in Verboo account." |

---

## Distribution

- **Visibility:** Public.
- **Regions:** All.
- **Pricing:** Free.

---

## Reviewer notes (paste into the submission form)

> This extension implements `chrome.identity`, `chrome.scripting`, `chrome.tabs`, `chrome.tabGroups`, `chrome.storage`, and `chrome.sidePanel` to provide a browser-automation side panel. There is no remote-loaded code; all injected scripts are bundled. Standalone chat uses user-initiated OAuth PKCE and sends active-turn prompts, selected browser context, and tool results to the Verboo Router. Browser content is fenced as untrusted data. The separate MCP transport is local and carries no CLI token. The extension does not request `debugger` at this time. The full privacy policy is bundled at `PRIVACY.md` and `privacy.html` and linked from the side panel.

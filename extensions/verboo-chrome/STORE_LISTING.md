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
> - **In the current build, it does not send page content off-device.** The bundled agent turn loop is a local heuristic that plans and dispatches tools in your browser. A future phase may add an opt-in Verboo API client; when it does, only tool results from a turn you started will be sent to the Verboo API endpoint you configure.
>
> ### Permissions, in plain English
>
> - **sidePanel** — shows the Verboo panel alongside the page.
> - **storage** — keeps you signed in and remembers your permission mode and per-site grants, locally.
> - **scripting** — runs small scripts in the page you approved to read, click, or fill.
> - **tabs** — manages the tabs the agent works on.
> - **tabGroups** — groups the tabs the agent opens so multi-step research stays organized.
>
> ### Independent build
>
> Verboo Code — Browser Control is an independent build maintained by the Verboo Code contributors. It is authorized but is not an official product of Verboo Inc. or Anthropic.
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
| Does this extension collect user data? | In the current build, no data leaves your device. A future phase may add an opt-in Verboo API client; when it does, only tool results from a turn you started will be sent to the Verboo API endpoint you configure. |
| Is that data transmitted off-device? | Not in the current build. Future opt-in API client will send tool results only to the Verboo API endpoint you configure. |
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

> This extension implements the `chrome.scripting`, `chrome.tabs`, `chrome.tabGroups`, `chrome.storage`, and `chrome.sidePanel` APIs to provide a browser-automation side panel. There is no remote-loaded code. All injected scripts are bundled in the package. The extension does not request the `debugger` permission at this time. A future release may add `debugger` for full-page screenshots and sandboxed evaluation; the Store listing will be updated before that release. The bundled agent turn loop in the current build is a local heuristic — it does not call any cloud API and does not transmit page content off-device. A future opt-in Verboo API client will be announced in a Store update before it ships. The full privacy policy is bundled at `PRIVACY.md` and `privacy.html`, and is also linked from the extension's side panel.

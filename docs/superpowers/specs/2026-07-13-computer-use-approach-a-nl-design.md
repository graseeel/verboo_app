# Computer Use Approach A + Claude-like NL Intent — Design

**Status:** Approved by product owner (2026-07-13) for overnight implementation.  
**Branch:** `feat/computer-use-p0`  
**Restore point:** `6619090` (`chore(computer-use): restore point before Approach A + NL intent`)

## Context

1. Manual TCC grant for `computer-use-helper` via Accessibility **+** and Screen Recording **worked**. The OS-permission warning is gone.
2. Remaining UX failure: composer shows *“Informe um app em execução…”* when the user asks for computer-use without naming an app (e.g. skill selected + “adicionamos essa feature, quero que você teste…”). That is **not** Claude-like.
3. Desired product: Claude Computer Use behavior as a base (docs below), Verboo-owned stack.

### Claude reference (behavior only, not copy)

Sources: Claude Code computer-use docs, Desktop “Let Claude use your computer”, Cowork safety article.

| Claude behavior | Verboo implication |
|---|---|
| Natural language goals; model decides tools | Do **not** require the user to name an app in the prompt |
| Tool ladder: connector → bash → browser → computer use | Keep; CU only when GUI is needed |
| Per-app approval at first need | Session can start goal-first; expand target when app is known |
| Hide other apps while working; Esc stop | Keep existing isolation + `Cmd+Shift+Esc` |
| Accessibility + Screen Recording OS grants | Keep; productize helper packaging (Approach A) |
| Not hardcoded to Notes/Safari | Remove hardcoded “name an app” failure path |

## Problem A — Hardcoded app requirement

### Current bug

`startComputerUseFromComposer` in `App.tsx`:

1. Detects intent (`detectComputerUseIntent` / skill) ✓  
2. Checks OS permissions ✓  
3. **Requires** `resolveComputerUseTarget` / selector → toast `computerUse.composer.missingApp` ✗  
4. Only then grants session + sends message

So a Claude-style request never reaches the agent.

### Target behavior (goal-first)

```
User: "adicionamos feature X, use o computador para testar e achar bugs"
  → OS perms OK
  → Session ACTIVE with goal, target_app optional
  → Agent turn with CU MCP + mission contract
  → Agent list-apps / launch-app / focus / act
  → When a concrete app is first needed and not yet authorized:
       consent expand (per-app, Claude-style) OR soft preselect if unique mention
```

### Rules

1. **Explicit unique app mention** → preselect that app (current resolve path).  
2. **No app mention** → still start CU; do **not** toast `missingApp`.  
3. **Optional picker** only when user invoked bare `/computer-use` with empty goal *or* user chooses “pick app” — not for natural language goals.  
4. **Never silently control a hard-blocked app** (System Settings, loginwindow).  
5. **Self-test on Verboo** still requires `selfTestEnabled`.  
6. **Session without target_app**:
   - `list-apps`, `permissions`, `capabilities` allowed (no bundle).
   - Mutating / app-scoped reads require either `session.target_app` match or allowlist entry.
7. **Agent discovers app**: mission text must say: interpret the goal, list running apps, launch if needed, then control only the authorized target. If the goal implies “the app I’m building / frontmost / Verboo”, prefer matching running apps; if multiple candidates, pick the best match and **state it**, or ask once via normal chat tools — do not block composer entry.  
8. **Ephemeral target bind**: when grant happens with an app, or when the first successful `resolve-app` + user already granted session-wide desktop control for that goal, bind `target_app` for the session (existing ephemeral allowlist path).

### Capability / MCP changes

`Capability.app` is currently `String` required. Change to:

- `app: String` empty string or sentinel `"*"` meaning “bootstrap / goal-directed, no single target yet”.
- Focus HUD: skip isolation overlay until a concrete app is bound (or only show compact HUD).
- MCP tools that need an app return a clear error `app_not_selected` prompting the agent to resolve/bind.

### Bind target mid-session

Add Tauri command + store action:

`bind_computer_use_target(session_id, bundle_id)`  

- Only while session active.  
- Runs hard-block / self-test / denylist gates.  
- Updates `Session.target_app` + capability JSON + optional focus helper start.  
- Audited.

Renderer: agent does not call this directly; the MCP server (`--computer-use-mcp`) exposes `computer_bind_app` / uses first successful app-scoped grant path. Prefer implementing bind inside MCP when agent first passes a valid `app` selector and session has no target yet **only if** session was granted as goal-directed with scope ≥ view. User already consented to the goal; first app bind still checks hard blocks.

**Safety choice for P0 (approved):** Goal-directed session grant = user authorizes computer use for this goal. First non-blocked app the agent successfully resolves becomes the session target (ephemeral). Second different app requires a new consent expand (deny cross-app silent switch). This mirrors Claude “approve apps” without forcing the user to type the name.

## Problem B — Approach A (helper identity packaging)

### What Approach A means (product)

Make `computer-use-helper` a first-class part of **Verboo Code** so enabling Computer Use in Settings drives helper permissions — user should not need a scavenger hunt for a random binary name when the product is signed and packaged.

### What Approach A is **not** (honest constraint)

macOS Accessibility TCC is **per process binary path**. Ad-hoc / CLI-built sidecars often appear as a separate list entry (`computer-use-helper`). That is an OS limitation; we cannot silently flip TCC for another binary without private APIs.

### Approach A deliverables

1. **Always ship** helper at:
   - Dev: `src-tauri/binaries/computer-use-helper-<triple>`
   - Packaged: `Verboo Code.app/Contents/MacOS/computer-use-helper` (and triple-suffixed if Tauri requires)
2. **Build pipeline**: `build:tauri-deps` already builds helper; ensure `tauri.conf.json` `externalBin` + copy into MacOS on package.
3. **Settings coupling** when user enables CU or clicks “Grant permissions”:
   - Invoke helper `request-permissions` (registers helper in TCC lists when possible).
   - Open Accessibility + Screen Recording panes.
   - Show helper absolute path + “Reveal in Finder” + short PT/EN copy:
     - Signed product: “Enable **Verboo Code** and **computer-use-helper** if both appear.”
     - Ad-hoc: “If only the helper appears, enable it (normal for dev builds).”
4. **Reveal helper path** Tauri command: `reveal_computer_use_helper()` → `open -R <path>`.
5. **Optional same-bundle branding**: set helper compile flags / install name so Activity Monitor shows “Verboo Computer Use Helper”.
6. **Do not** rewrite architecture to in-process AX in this wave (arch D2 stays sidecar). Document follow-up if product later wants single TCC entry via in-process FFI.

## Out of scope (this wave)

- Windows computer use  
- Multi-session CU  
- Changing hard-block list  
- Auto-clicking TCC toggles (impossible / private)  
- Committing secrets; pushing to remote unless owner asks  

## Acceptance criteria

1. With an explicit Computer Use goal *without* app name, no `missingApp` toast; agent turn starts with CU MCP.
2. With goal naming Notes uniquely, Notes is pre-bound as today.  
3. Cross-app silent switch after first bind is denied.  
4. Settings → Grant permissions opens OS panes and requests helper permissions; reveal helper works.  
5. Unit tests: intent, bind rules, session without target allows list-apps only.  
6. Restore point `6619090` remains reachable; implementation commits are separate.  
7. MAESTRO does not edit application source; agents implement.

## Risks

| Risk | Mitigation |
|---|---|
| Goal-directed first-bind is broad | Hard blocks + denylist + self-test gate + audit + single session |
| Focus HUD without app | Skip until bind |
| Ad-hoc still two TCC rows | Honest UI copy; Approach A packaging |
| Agent confuses goal | Stronger mission contract + list-apps first |

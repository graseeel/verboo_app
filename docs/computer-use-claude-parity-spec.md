# Computer Use — Claude Code Behavioral Parity Spec (v3)

> **Status**: APPROVED design baseline
> **Date**: 2026-07-15
> **Scope**: Verboo Code desktop on macOS
> **Transport constraint**: use only supported Verboo CLI seams (`--mcp-config`,
> `--strict-mcp-config`, `--model`, stream-json). Do not edit the Router, the
> bundled CLI, `node_modules`, or `src-tauri/resources/cli-package/dist/cli.mjs`.
> **Supersedes**: the action, vision, app-permission, screenshot, emergency-stop,
> and delivery sections of `computer-use-architecture-v1.md` and v2.1 of this
> document. The existing consent, audit, TCC, capability-token, and fail-closed
> foundations survive where this document does not explicitly replace them.

## 1. Product objective

Verboo Computer Use must reproduce the documented, externally observable
behavior of Claude Code Computer Use while remaining compatible with the
multi-model Verboo runtime:

- screen control is off by default and explicitly enabled;
- precise structured tools are preferred over visual control;
- the user approves each target app for the current conversation session;
- unapproved apps are hidden and excluded from screenshots while control runs;
- one machine-wide Computer Use owner exists at a time;
- the model receives a fresh screenshot after every successful action;
- screen coordinates are computed in the exact pixel grid shown to the model;
- `Esc` stops control globally and is consumed by the helper;
- the current model runs the loop when it supports vision;
- otherwise Verboo temporarily delegates the entire visual loop to a
  vision-capable model, then restores the original model with a trusted handoff;
- the product never presents price, cost, billing, quota, upgrade, or plan-limit
  copy in Computer Use surfaces;
- the Router and bundled CLI remain unchanged.

Behavioral parity is the target. Verboo does not claim to reproduce Anthropic's
private classifiers or proprietary internal engine.

## 2. Official behavior used as source material

The design follows these public Anthropic sources as of 2026-07-15:

- Claude Code Computer Use: <https://code.claude.com/docs/en/computer-use>
- Claude Desktop application: <https://code.claude.com/docs/en/desktop>
- Claude Platform Computer Use tool:
  <https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool>
- Anthropic Computer Use best practices:
  <https://claude.com/blog/best-practices-for-computer-and-browser-use-with-claude>
- Anthropic native macOS reference implementation:
  <https://github.com/anthropics/claude-quickstarts/tree/main/computer-use-best-practices>

### 2.1 Public-seam parity boundaries

This implementation targets the documented, observable behavior. Three Claude
internals are not available through the supported Verboo CLI seams and must not
be presented as exact parity:

1. The desktop can bound its local screenshot registry and audit evidence, but
   cannot rewrite or replace historical image blocks already owned by the CLI
   conversation. Exact Anthropic message-level screenshot pruning is therefore
   not claimed; the CLI remains responsible for its own context compaction.
2. A process restart cannot resume an ephemeral helper, capability, machine
   lock, or CLI child. A webview reload may resume only when the backend proves
   the exact conversation child and native session are still live. A full
   process restart restores the original model, clears stale authority, and
   starts a new explicitly approved session if the user continues.
3. Anthropic's proprietary prompt-injection and consequential-action classifier
   is unavailable. Verboo uses its local fail-closed policy, one-shot
   confirmations, app tiers, hard blocks, fresh screenshots, and verified audit
   evidence without claiming the same classifier.

The model catalog used for executor selection comes from the backend cache
written by the app's existing model-discovery flow. Renderer-supplied vision
flags are not authoritative. Computer Use accepts vision only when the cached
Router payload carries explicit boolean/capability evidence; name-based
heuristics may remain a non-authoritative UI hint but never grant control. No
new Router API or private convention is introduced.

## 3. Non-negotiable constraints

1. **No Router work.** Consume only the existing model catalog fields already
   returned to the desktop. Do not add Router endpoints, flags, or private
   conventions.
2. **No bundled CLI work.** Use the existing documented flags and structured
   I/O. Never patch the compiled `cli.mjs`.
3. **No native-tool assumption.** The official `computer_20251124` tool is
   schema-less and trained into compatible Claude models. The shipped Verboo CLI
   currently exposes MCP tools, so Verboo publishes one custom MCP tool named
   `computer` with a strict schema and a matching internal action model.
4. **No implicit privilege.** `full` file access, `auto`,
   `--dangerously-skip-permissions`, or a trusted skill never grants Computer
   Use.
5. **No blind spatial execution.** A model that cannot see the current
   screenshot never chooses raw click coordinates.
6. **No hidden product copy about usage economics.** Computer Use UI, audit
   display, notifications, errors, and model-swap copy omit all price, billing,
   quota, upgrade, and plan-limit language.
7. **macOS first.** Windows and Linux adapters are outside this delivery.
8. **Fail closed.** Missing consent, stale capability, revoked TCC permission,
   audit failure, helper failure, model-handoff failure, or target-app mismatch
   prevents the action.

## 4. Deep-module shape

The external seam is one Rust module, `ComputerUseEngine`. Callers and tests use
the same interface:

```rust
pub trait ComputerUseEngine {
    fn request(&self, request: StartRequest) -> Result<ConsentRequest, ComputerUseError>;
    fn approve(&self, approval: SessionApproval) -> Result<ComputerUseSession, ComputerUseError>;
    fn invoke(&self, request: ActionRequest) -> Result<ActionResult, ComputerUseError>;
    fn stop(&self, session_id: &str, reason: StopReason) -> Result<StopReceipt, ComputerUseError>;
    fn status(&self) -> Option<ComputerUseSession>;
}
```

Complexity stays behind this interface. Its implementation owns these internal
modules:

| Module | Responsibility |
|---|---|
| `ComputerToolAdapter` | Translate between the single MCP `computer` tool and `ActionRequest`/`ActionResult`. |
| `VisualExecutorCoordinator` | Choose the current model or start a temporary vision executor through existing CLI flags. |
| `MacDesktopAdapter` | Capture filtered screenshots and execute mouse/keyboard actions through the Swift helper. |
| `AppPermissionPolicy` | Resolve fixed app tiers, denied apps, requested extra permissions, and human confirmations. |
| `ComputerUseSessionController` | Own the machine lock, app approvals, hidden-app lifecycle, capability token, pause, stop, and recovery. |
| `ScreenshotPipeline` | Capture, filter, resize, snapshot coordinate transforms, encode PNG, and retain recent screenshots. |
| `ComputerUseHandoffBuilder` | Produce trusted structured context when a temporary executor returns control. |
| `TrajectoryRecorder` | Write one local action record per attempted action and provide diagnostics without logging sensitive text. |

Internal adapters are injectable so Rust and Swift behavior can be verified
without controlling the developer's actual desktop.

## 5. Tool routing and activation

Computer Use is the broadest and least preferred interaction mechanism. System
instructions tell the model to choose in this order:

1. an existing connector or domain-specific MCP tool;
2. a filesystem, text-editor, or Bash action;
3. a browser-specific integration;
4. the `computer` tool for native apps, simulators, visual verification, and
   GUI-only software.

Activation has two gates:

- a global Settings toggle, disabled by default;
- explicit target-app approval for the current conversation session.

The global toggle does not approve any app. A session never starts from intent
detection alone; intent detection may only open the approval flow.

## 6. Single `computer` tool

The MCP server exposes exactly one tool named `computer`:

```json
{
  "name": "computer",
  "description": "Inspect and control the approved macOS apps. A fresh screenshot follows each successful action. Coordinates use the pixel grid of the latest screenshot.",
  "inputSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "action": {
        "type": "string",
        "enum": [
          "screenshot",
          "left_click",
          "right_click",
          "middle_click",
          "double_click",
          "triple_click",
          "type",
          "key",
          "hold_key",
          "mouse_move",
          "scroll",
          "left_click_drag",
          "left_mouse_down",
          "left_mouse_up",
          "wait",
          "zoom"
        ]
      },
      "coordinate": {
        "type": "array",
        "items": { "type": "integer", "minimum": 0 },
        "minItems": 2,
        "maxItems": 2
      },
      "start_coordinate": {
        "type": "array",
        "items": { "type": "integer", "minimum": 0 },
        "minItems": 2,
        "maxItems": 2
      },
      "text": { "type": "string" },
      "duration": { "type": "number", "minimum": 0.1, "maximum": 60 },
      "scroll_amount": { "type": "integer", "minimum": 1, "maximum": 100 },
      "scroll_direction": { "enum": ["up", "down", "left", "right"] },
      "region": {
        "type": "array",
        "items": { "type": "integer", "minimum": 0 },
        "minItems": 4,
        "maxItems": 4
      },
      "modifiers": {
        "type": "array",
        "items": { "enum": ["cmd", "ctrl", "alt", "shift"] },
        "uniqueItems": true
      }
    },
    "required": ["action"]
  }
}
```

`cursor_position` is returned as metadata on every screenshot and is not a
separate action. This keeps the public tool aligned with the documented action
surface.

## 7. Action loop

For each model tool call:

1. Validate JSON into `ActionRequest`.
2. Verify session, capability token, TCC state, app approval, app tier, current
   frontmost app, rate limit, drag state, and user-confirmation policy.
3. Append an audit row with `pending` outcome. If that write fails, revoke the
   capability and return an error.
4. Send one action to the Swift helper.
5. Capture a new filtered screenshot after the UI settles.
6. Finish the audit row as `success`, `error`, `denied`, or `aborted`.
7. Return a structured MCP tool result containing action metadata and the fresh
   PNG.
8. The executor evaluates the new screenshot before choosing the next action.

Errors that happen before execution do not attach a new screenshot when doing so
could expose a denied app or secure field. Recoverable execution errors may
attach a filtered screenshot only if the app policy still allows viewing it.

## 8. Screenshot and coordinate contract

### 8.1 Capture

- Use ScreenCaptureKit on macOS.
- Exclude the Verboo application and every unapproved application from capture.
- Hide unapproved visible applications while a session owns the lock.
- Capture the display containing the current approved foreground app.
- Render the cursor into the returned image.
- Encode lossless PNG.
- Never capture a secure field or denied app to satisfy an error response.

### 8.2 Resize

- Preserve the source aspect ratio.
- Never rely on server-side image downscaling.
- Default unknown-model output to a maximum 1280×720 bounding box.
- Use a larger maximum only when the model catalog exposes an explicit verified
  visual input limit.
- Never upscale beyond the captured source.
- `display_width_px` and `display_height_px` always equal the PNG dimensions sent
  to the executor.

### 8.3 Coordinates

Each screenshot creates an immutable `ScreenshotTransform`:

```rust
pub struct ScreenshotTransform {
    pub screenshot_id: String,
    pub display_id: u32,
    pub api_width: u32,
    pub api_height: u32,
    pub screen_origin_x: f64,
    pub screen_origin_y: f64,
    pub screen_width: f64,
    pub screen_height: f64,
}
```

Action coordinates must reference the latest screenshot id stored in the
capability. The transform maps independently on each axis:

```text
screen_x = origin_x + api_x * screen_width  / api_width
screen_y = origin_y + api_y * screen_height / api_height
```

The engine rejects coordinates outside the API image and rejects an action when
the transform is stale.

## 9. App permissions and privacy

Approval may contain multiple apps. Each app receives a fixed maximum tier:

| Tier | Allowed | Default categories |
|---|---|---|
| `viewOnly` | screenshot and zoom | browsers, trading and financial apps |
| `clickOnly` | view, mouse move, click, drag, scroll | terminals and IDEs |
| `fullControl` | view, mouse, typing, keys, shortcuts | other approved apps |

The tier is a maximum; the user may grant a narrower tier. The user cannot grant
more than the category maximum.

Finder and System Settings are not silently hard-blocked. They show sentinel
warnings explaining their reach. The denied-app list rejects configured apps
without prompting. Credential managers, banking apps, health-record apps,
cryptocurrency apps, loginwindow, secure text fields, and Verboo credential or
safety surfaces remain hard-blocked.

The consent modal shows:

- requested app names and icons;
- maximum control tier for each app;
- requested clipboard access, if any;
- the number of other visible apps that will be hidden;
- sentinel warning text for shell, filesystem, or system-settings reach;
- `Allow for this session` and `Deny` actions.

Approvals last for the current conversation session. Adding an app later opens a
new consent modal. Approval is never inferred from a previous conversation.

## 10. Session and stop behavior

- A machine-wide lock is acquired on the first successful Computer Use action.
- Only the owning conversation may use the helper until that conversation ends,
  the user stops Computer Use, the process dies, or stale-owner recovery proves
  the owner is gone.
- Hidden apps and their prior visibility state are recorded before mutation and
  restored on normal completion, denial, interrupt, helper crash, TCC revocation,
  and app shutdown.
- Every stop path closes the in-process action gate and removes the capability
  before reading the final audit trajectory for handoff.
- The helper registers global `Esc`. While Computer Use owns the lock, the key is
  consumed and triggers `StopReason::EmergencyStop`.
- An unexpected helper, HUD, or emergency-monitor exit is reported as an
  executor/runtime failure, not as a user-initiated `Esc` stop.
- The composer Stop button interrupts the executor process and stops the desktop
  session.
- macOS notifications announce start (`Press Esc to stop`) and completion.
- A stopped or paused session cannot execute further actions with an old token.

## 11. Vision executor selection

### 11.1 Current model supports vision

The current model remains the executor. It receives the `computer` MCP tool and
the screenshot loop directly.

### 11.2 Current model does not support vision

Verboo selects a temporary visual executor from the existing model catalog:

1. filter `supports_vision == Some(true)` whose provenance is explicit Router or
   raw capability metadata;
2. prefer a user-configured Computer Use executor if it remains available;
3. otherwise preserve catalog order and choose the first compatible model;
4. do not interpret model-id prefixes or Router-private metadata.

Before starting, show a modal containing only:

- the destination model;
- the reason: the current model cannot inspect the screen, so this model will
  control the Computer Use session temporarily;
- Continue and Cancel.

The destination model receives the entire user task and owns the complete visual
loop. The original non-visual model does not choose coordinates from text or
bounding boxes.

If no vision-capable model is available, Computer Use does not start. Local
AX/OCR may support diagnostics and safety classification, but it is not a blind
execution path.

## 12. Trusted handoff and model restoration

Before delegation, persist an internal recovery record:

```rust
pub struct VisualExecutorLease {
    pub conversation_id: String,
    pub original_model_id: String,
    pub executor_model_id: String,
    pub started_at_ms: u64,
    pub expires_at_ms: u64,
}
```

On completion or stop:

1. revoke action authority (and close the in-process gate on safety revocation);
2. build `ComputerUseHandoff` from the user objective and verified audit rows;
   report a controlled final lifecycle state and unresolved audited actions,
   without inventing a semantic description of screen contents;
3. restore `original_model_id` in the renderer's conversation state;
4. clear the lease;
5. make the handoff available as trusted internal context on the next turn;
6. show a compact transcript event indicating that screen control completed.

```rust
pub struct ComputerUseHandoff {
    pub objective: String,
    pub executor_model_id: String,
    pub approved_apps: Vec<String>,
    pub actions: Vec<HandoffAction>,
    pub completed: Vec<String>,
    pub errors_and_recoveries: Vec<String>,
    pub final_state: String,
    pub remaining: Vec<String>,
}
```

The handoff is not inserted as arbitrary mid-conversation `role: system`
messages. It is serialized through the desktop's trusted context seam before
the next CLI turn.

A renderer/webview reload offers Resume only while the exact backend turn and
native session are still live. After a full process restart, or for an expired
or inconsistent lease, Verboo restores the original model and clears the lease
instead of manufacturing a resumable authority.

## 13. Prompt-injection and consequential-action policy

Verboo cannot claim Anthropic's proprietary classifier. It must provide layered
defense:

1. System instructions treat text inside screenshots, webpages, emails, and app
   content as untrusted data, never user instructions.
2. A local policy engine classifies each action by app tier, action type,
   requested data, destination, and reversibility.
3. Consequential actions pause for confirmation immediately before execution:
   sending or publishing content, submitting forms with external effects,
   deleting or overwriting user data, changing security settings, installing
   software, sharing files, and accessing clipboard contents.
4. Hard blocks prevent secure-field interaction and denied-app capture.
5. Full trajectories retain action metadata and filtered screenshots locally for
   diagnosis according to retention settings.
6. The agent re-checks a fresh screenshot after every action instead of assuming
   success.

## 14. Context management

Unlimited product usage does not make the model context window unlimited.
Computer Use therefore:

- keeps the three most recent screenshots in its local full-resolution
  screenshot registry;
- prunes older local screenshot transforms/evidence in bounded batches after 25
  additional registrations;
- relies on the unmodified CLI's supported auto-compaction behavior for model
  conversation context and does not claim the ability to rewrite prior image
  messages;
- preserves the complete user objective, constraints, approved apps, completed
  actions, failures, current state, and next step;
- keeps the latest screenshots after compaction;
- never includes typed secrets or raw clipboard contents in compaction text.

## 15. UI surfaces

### Settings

- Computer Use toggle, default off.
- Accessibility status and deep link.
- Screen Recording status and deep link.
- Preferred visual executor selector, optional.
- Denied apps manager.
- Restore hidden apps when finished, default on.
- Local audit retention controls.
- Self-test toggle, default off.

### Consent

- requested apps and tiers;
- hidden-app count;
- requested clipboard access;
- sentinel warnings;
- allow for session / deny.

### Active session

- persistent banner with active app and current action;
- Stop button;
- instruction that `Esc` stops from anywhere;
- collapsed action rows in the transcript;
- model-delegation indicator when a temporary executor is active.

### Completion

- apps restored;
- original model restored;
- completion notification;
- concise handoff event and final executor response.

## 16. Delivery slices

### Slice 1 — Contract and state core

- canonical action types and validation;
- one-tool MCP surface;
- machine lock and multi-app session model;
- app-tier policy;
- unit tests for every action/tier pair.

### Slice 2 — macOS runtime

- ScreenCaptureKit filtered capture;
- screenshot resize and coordinate transforms;
- complete Swift action set;
- global Esc;
- app hide/restore;
- Swift and Rust integration tests.

### Slice 3 — Model orchestration

- visual executor selection without Router-private heuristics;
- temporary `--model` executor turn;
- lease recovery;
- trusted handoff and model restoration;
- bounded local screenshot/audit retention and the unmodified CLI's own
  compaction behavior.

### Slice 4 — Product UI

- Settings controls;
- app consent modal and sentinel warnings;
- active banner, action state, delegation state, and Stop;
- notifications and completion event;
- English and Portuguese copy.

### Slice 5 — Safety and release gate

- consequential-action confirmations;
- prompt-injection fixtures;
- denied-app and secure-field tests;
- audit and crash recovery;
- automated suite;
- packaged local macOS build;
- supervised real-desktop acceptance run.

## 17. Acceptance criteria

The feature is not complete until all criteria have evidence:

1. MCP `tools/list` returns exactly one `computer` tool.
2. Every documented action validates required and forbidden fields.
3. Every successful action returns a fresh filtered screenshot.
4. Retina, non-Retina, and multi-display transforms hit the intended coordinates.
5. Verboo and unapproved apps never appear in screenshots.
6. Multiple approved apps work; an unapproved cross-app action prompts or fails.
7. App-tier limits are enforced independently of model instructions.
8. `Esc` stops the helper globally and no later queued action executes.
9. Helper crash, TCC revocation, and audit failure restore apps and fail closed.
10. A vision model runs directly without model delegation.
11. A non-vision model triggers explicit delegation, restores the original
    model, and receives the bounded trusted handoff that can be proven from the
    verified audit trajectory.
12. No Router, bundled CLI, or `node_modules` file changes appear in the diff.
13. No prohibited product copy appears in Computer Use sources or rendered UI.
14. Unit, renderer, Rust, Swift, integration, build, and packaging gates pass.
15. A supervised macOS run completes representative tasks in Notes/TextEdit,
    one Verboo-built native app, and a simulator or second approved app.
16. The acceptance run covers denial, global stop, model delegation, app switch,
    tiny target/zoom, scroll, keyboard, drag, helper crash, and permission revoke.

## 18. Explicit non-goals

- Router changes;
- bundled CLI changes;
- claiming access to Anthropic's private classifier;
- Windows or Linux control;
- autonomous access to credential, banking, health, trading, or cryptocurrency
  applications;
- browser automation when a connector or browser-specific tool is available;
- a blind model choosing coordinates from textual descriptions;
- remote audit upload;
- multiple simultaneous desktop-control owners.

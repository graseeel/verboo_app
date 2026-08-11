# Interactive iOS Simulator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing simulator preview into a smooth 30/60 fps surface with direct touch and keyboard control, element and rectangular Add to Chat annotations, and generation-safe Verboo agent presence over the same WDA session.

**Architecture:** `IosSimulatorService` remains the single owner of device, WDA process, WebDriver session, latest frame, input queue, accessibility snapshot, and agent-presence generation. A focused blocking WDA client handles HTTP endpoints while React consumes only the newest frame per animation frame and maps pointer positions through the actual `object-fit: contain` rectangle. A managed `verboo-ios-simulator` MCP binary relays authenticated loopback requests into that same desktop service; it never starts a second WDA process or stream.

**Tech Stack:** Rust 1.89, Tauri 2.11, blocking `reqwest` with rustls, WebDriverAgent 16.1.4, React 19, TypeScript 6, Vitest/Testing Library, CSS animations, `rmcp` 0.16.

## Global Constraints

- Preserve the current dirty user baseline; stage and commit only the files named by the active task.
- Keep one WDA process, one WebDriver session, and one MJPEG stream for the attached simulator.
- Bind every WDA and MCP transport to `127.0.0.1`; authenticate the MCP relay with a per-process secret stored in a user-private discovery record.
- Default MJPEG to exactly 30 fps; expose exactly 30 and 60 fps stream profiles.
- Do not persist 60 fps as the default; every new attach starts at 30 fps.
- Keep `mjpegScalingFactor` at exactly 100.
- Keep the existing 0.5, 1, and 2 fps `simctl` fallback rates independent from the MJPEG profile.
- Selecting 60 fps must show: “High fluency uses more processing and may warm up your computer or reduce the performance of other apps.”
- Portuguese 60 fps copy must be: “Alta fluidez usa mais processamento e pode aquecer o computador ou reduzir o desempenho de outros apps.”
- Manual interaction never emits agent presence.
- Agent presence must be emitted before its WDA action and removed on turn completion, detach, panel close, app hide, and app exit.
- Detach must never issue `simctl shutdown`.
- Preserve Xcode 26 and 27 detection, the `simctl` warmup/fallback, bounded WDA process cleanup, packaged WDA portability, and loopback-only security.
- Do not add H.264, WDA downscaling, adaptive bitrate, physical-device support, or a second `serve-sim`/XcodeBuildMCP process in this iteration.
- Real-app verification must not call the Verboo model; use manual panel input and the local MCP seam directly.

---

## File Structure

### Backend authority

- Create `src-tauri/src/services/ios_simulator/wda_client.rs`: WebDriver session creation, settings, window/source reads, tap/drag/text/key calls, response validation, and session deletion.
- Create `src-tauri/src/services/ios_simulator/capture_store.rs`: frame crop, temporary simulator PNG validation, promotion into conversation-owned storage, and cleanup.
- Create `src-tauri/src/services/ios_simulator/bridge.rs`: authenticated loopback discovery/server, simulator tool dispatch, and bridge shutdown.
- Modify `src-tauri/src/services/ios_simulator.rs`: session authority, stream profiles, latest-frame ownership, serialized input, Tauri commands, presence generations, and lifecycle convergence.
- Modify `src-tauri/src/services/mod.rs` and `src-tauri/src/lib.rs`: service setup, managed state, commands, bridge startup, and shutdown.

### Renderer interaction

- Modify `src/renderer/features/simulator/iosSimulatorApi.ts`: exact Tauri types/commands/events.
- Modify `src/renderer/features/simulator/iosSimulatorModel.ts`: 30/60 profiles, fallback rates, supported key map, and interaction modes.
- Create `src/renderer/features/simulator/simulatorGeometry.ts`: painted-image rectangle and normalized/device coordinate conversion.
- Create `src/renderer/features/simulator/frameCoalescer.ts`: newest-frame-only `requestAnimationFrame` commit and throttled telemetry.
- Create `src/renderer/features/simulator/useSimulatorInteraction.ts`: pointer threshold, pointer cancellation, focus, text, paste, composition, and special-key routing.
- Create `src/renderer/features/simulator/SimulatorSurface.tsx`: focused live surface, mode toolbar, image, manual gesture handlers, selection state, and annotation confirmation.
- Create `src/renderer/features/simulator/SimulatorPresenceOverlay.tsx`: adaptive aurora, cursor, ripple, drag path, reduced motion, and generation guards.
- Create `src/renderer/features/simulator/simulatorAnnotations.ts`: simulator attachment creation, second snapshot expansion, promotion, and cleanup.
- Create `src/renderer/features/attachments/visualAttachments.ts`: shared browser/simulator visual classification, snapshot expansion, promotion, and temporary-file dispatch.
- Modify `src/renderer/features/simulator/useIosSimulatorPanel.ts`, `IosSimulatorPanel.tsx`, and `src/renderer/App.tsx`: state/event wiring and Add to Chat integration.
- Modify `src/renderer/styles/ios-simulator.css` and `src/renderer/i18n.tsx`: controls, focus/annotation/presence visuals, warning, and localized accessible copy.

### Attachment contract

- Modify `src/shared/types.ts`: `simulator-annotation` kind and simulator-specific metadata.
- Modify `src-tauri/src/models/types.rs` and `src-tauri/src/services/turn_service.rs`: deserialize simulator visual attachments and treat them as images with structured extracted context.
- Modify `src/renderer/features/composer/Composer.tsx` and `src/renderer/components/Transcript.tsx`: annotation-only submission, chip labels, thumbnails, and persisted metadata.

### Agent sidecar

- Create `src-tauri/verboo-in-chrome/src/bin/verboo-ios-simulator.rs`: MCP executable entrypoint.
- Create `src-tauri/verboo-in-chrome/src/simulator_catalog.rs`, `simulator_client.rs`, `simulator_mcp.rs`, and `simulator_protocol.rs`: tool catalog, discovery client, validation, relay, EOF/signal cleanup.
- Create `src-tauri/verboo-in-chrome/src/simulatorTools.json`: narrow simulator tool schemas.
- Modify `src-tauri/verboo-in-chrome/Cargo.toml` and `src-tauri/verboo-in-chrome/src/lib.rs`: second binary/modules.
- Modify `scripts/tauri/build-chrome-helper.mjs`, its test, `package.json`, and `src-tauri/tauri.conf.json`: build/package both helpers.
- Create `src-tauri/src/services/ios_simulator_mcp.rs`: install the managed helper and idempotently register `verboo-ios-simulator` in the user CLI configuration.

---

### Task 1: Establish the WDA Session and 30/60 Stream Profiles

**Files:**
- Create: `src-tauri/src/services/ios_simulator/wda_client.rs`
- Modify: `src-tauri/src/services/ios_simulator.rs:26-104,431-684,1092-1310,1433-2320`
- Modify: `src/renderer/features/simulator/iosSimulatorApi.ts`
- Modify: `src/renderer/features/simulator/iosSimulatorModel.ts`
- Modify: `src/renderer/features/simulator/iosSimulatorModel.test.ts`
- Modify: `src/renderer/features/simulator/useIosSimulatorPanel.ts`
- Modify: `src/renderer/features/simulator/useIosSimulatorPanel.test.ts`
- Modify: `src/renderer/features/simulator/IosSimulatorPanel.tsx`
- Modify: `src/renderer/features/simulator/IosSimulatorPanel.test.tsx`
- Modify: `src/renderer/i18n.tsx`

**Interfaces:**
- Produces: `StreamProfile`, `WdaSessionHandle`, `WdaWindowSize`, and `WdaClient` for later input/source tasks.
- Produces: renderer `streamFps: 30 | 60` and `fallbackFps: 0.5 | 1 | 2` as separate state.

- [ ] **Step 1: Write the failing profile and handshake tests**

Add Rust tests that make the fake WDA HTTP listener record each request and assert the exact order:

```rust
#[test]
fn wda_session_applies_30_fps_and_scale_100_before_mjpeg_activation() {
    let http = FakeWdaHttpServer::start();
    let client = SystemWdaClient::default();
    let session = client.create_session(&http.base_url()).unwrap();
    client.apply_stream_settings(&session, StreamProfile::Fps30).unwrap();

    assert_eq!(http.requests(), vec![
        RecordedRequest::post("/session", serde_json::json!({
            "capabilities": { "alwaysMatch": {}, "firstMatch": [{}] }
        })),
        RecordedRequest::post(format!("/session/{}/appium/settings", session.id), serde_json::json!({
            "settings": { "mjpegServerFramerate": 30, "mjpegScalingFactor": 100 }
        })),
    ]);
}

#[test]
fn stream_profile_rejects_every_value_except_30_and_60() {
    assert_eq!(StreamProfile::try_from(30).unwrap(), StreamProfile::Fps30);
    assert_eq!(StreamProfile::try_from(60).unwrap(), StreamProfile::Fps60);
    assert!(StreamProfile::try_from(10).is_err());
    assert!(StreamProfile::try_from(120).is_err());
}
```

Extend the fake launcher so its HTTP listener answers `/status`, `/session`, settings, `/window/size`, and `DELETE /session/{id}` while its existing MJPEG listener remains separate. Record an `Arc<AtomicBool>` when settings succeed; have the MJPEG listener refuse connections before that flag becomes true. This is the red counterfactual proving that omitting the settings call leaves migration unavailable.

Add TypeScript expectations:

```ts
expect(IOS_SIMULATOR_STREAM_RATES).toEqual([30, 60])
expect(IOS_SIMULATOR_FALLBACK_RATES).toEqual([0.5, 1, 2])
expect(DEFAULT_SIMULATOR_STREAM_FPS).toBe(30)
```

Add a panel test that changes the stream selector to 60, asserts
`onSetStreamRate(60)`, and asserts the exact Portuguese warning is rendered.
Keep a separate fallback selector test that still calls
`onSetFallbackRate(1)`.

- [ ] **Step 2: Run the focused tests and confirm the red state**

Run:

```bash
cargo +1.89.0 test --manifest-path src-tauri/Cargo.toml ios_simulator::tests::wda_session_applies_30_fps_and_scale_100_before_mjpeg_activation -- --nocapture
npm test -- src/renderer/features/simulator/iosSimulatorModel.test.ts src/renderer/features/simulator/useIosSimulatorPanel.test.ts src/renderer/features/simulator/IosSimulatorPanel.test.tsx
```

Expected: Rust fails because no WebDriver session/settings client exists; Vitest fails because stream and fallback rates are still one `[0.5, 1, 2]` array.

- [ ] **Step 3: Implement the focused WDA client and profile split**

Define these exact public module interfaces in `wda_client.rs`:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "u16", into = "u16")]
pub enum StreamProfile { Fps30, Fps60 }

impl StreamProfile {
    pub const DEFAULT: Self = Self::Fps30;
    pub fn fps(self) -> u16 { match self { Self::Fps30 => 30, Self::Fps60 => 60 } }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WdaWindowSize { pub width: f64, pub height: f64 }

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WdaSessionHandle { pub base_url: String, pub id: String }

pub trait WdaClient: Send + Sync {
    fn wait_until_ready(&self, base_url: &str, deadline: Instant) -> Result<(), String>;
    fn create_session(&self, base_url: &str) -> Result<WdaSessionHandle, String>;
    fn apply_stream_settings(&self, session: &WdaSessionHandle, profile: StreamProfile) -> Result<(), String>;
    fn window_size(&self, session: &WdaSessionHandle) -> Result<WdaWindowSize, String>;
    fn delete_session(&self, session: &WdaSessionHandle) -> Result<(), String>;
}
```

Use a five-second connect/request timeout and validate the WDA envelope as `{ "value": ... }`; treat a non-null `value.error`, non-2xx status, absent session id, or non-positive window size as an explicit `Err`.

In `ios_simulator.rs`, replace the overloaded `fps` with:

```rust
pub const DEFAULT_FALLBACK_FPS: f64 = 2.0;
const MIN_FALLBACK_FPS: f64 = 0.5;
const MAX_FALLBACK_FPS: f64 = 2.0;

struct Session {
    udid: String,
    fallback_fps: Arc<Mutex<f64>>,
    stream_profile: Arc<Mutex<StreamProfile>>,
    stats: Arc<Mutex<StreamStats>>,
    stop: Arc<AtomicBool>,
    wda_session: Arc<Mutex<Option<(WdaSessionHandle, WdaWindowSize)>>>,
    wda_force_stop: Arc<Mutex<Option<WdaForceStop>>>,
    workers: Vec<JoinHandle<()>>,
}
```

Create the WDA session, apply profile settings, and read window size after the HTTP `/status` becomes ready and before connecting to MJPEG. On detach, take and delete the WebDriver session before terminating the WDA process.

Mirror the split at the Tauri boundary:

```ts
export type IosSimulatorStreamFps = 30 | 60
export type IosSimulatorFallbackFps = 0.5 | 1 | 2

attach: (udid, streamFps, fallbackFps) => invoke('ios_simulator_attach', { udid, streamFps, fallbackFps }),
setStreamRate: (streamFps) => invoke('ios_simulator_set_stream_rate', { streamFps }),
setFallbackRate: (fallbackFps) => invoke('ios_simulator_set_fallback_rate', { fallbackFps }),
```

Replace the single rate control with a primary “Fluency” selector for 30/60
and a secondary “Low-cost fallback rate” selector for 0.5/1/2. Render the
localized inline warning only while 60 is selected; it is non-modal and uses
`role="note"`.

- [ ] **Step 4: Run focused green tests**

Run:

```bash
cargo +1.89.0 test --manifest-path src-tauri/Cargo.toml ios_simulator -- --nocapture
npm test -- src/renderer/features/simulator/iosSimulatorModel.test.ts src/renderer/features/simulator/useIosSimulatorPanel.test.ts src/renderer/features/simulator/IosSimulatorPanel.test.tsx
```

Expected: all focused Rust and Vitest tests pass; the fake MJPEG stream cannot activate before settings.

- [ ] **Step 5: Commit only Task 1 files**

```bash
git add src-tauri/src/services/ios_simulator.rs src-tauri/src/services/ios_simulator/wda_client.rs src/renderer/features/simulator/iosSimulatorApi.ts src/renderer/features/simulator/iosSimulatorModel.ts src/renderer/features/simulator/iosSimulatorModel.test.ts src/renderer/features/simulator/useIosSimulatorPanel.ts src/renderer/features/simulator/useIosSimulatorPanel.test.ts src/renderer/features/simulator/IosSimulatorPanel.tsx src/renderer/features/simulator/IosSimulatorPanel.test.tsx src/renderer/i18n.tsx
git commit -m "perf: configure iOS simulator stream profiles"
```

### Task 2: Coalesce Renderer Frames and Throttle Telemetry

**Files:**
- Create: `src/renderer/features/simulator/frameCoalescer.ts`
- Create: `src/renderer/features/simulator/frameCoalescer.test.ts`
- Modify: `src/renderer/features/simulator/useIosSimulatorPanel.ts`
- Modify: `src/renderer/features/simulator/useIosSimulatorPanel.test.ts`

**Interfaces:**
- Produces: `LatestFrameCoalescer<T>` used only by `useIosSimulatorPanel`.
- Consumes: `IosSimulatorFrame` and device generation from Task 1.

- [ ] **Step 1: Write the newest-frame-only failing test**

```ts
it('commits only the newest pending frame in one animation frame', () => {
  const callbacks: FrameRequestCallback[] = []
  const committed: number[] = []
  const coalescer = new LatestFrameCoalescer<number>(
    callback => { callbacks.push(callback); return callbacks.length },
    () => {},
    value => committed.push(value),
  )

  coalescer.push(1)
  coalescer.push(2)
  coalescer.push(3)
  expect(callbacks).toHaveLength(1)
  callbacks[0](16)
  expect(committed).toEqual([3])
})
```

Add a hook test that sends 60 frame events before the scheduled callback and asserts one React frame update and telemetry no more often than once per 500 ms.

- [ ] **Step 2: Run and confirm the red state**

Run: `npm test -- src/renderer/features/simulator/frameCoalescer.test.ts src/renderer/features/simulator/useIosSimulatorPanel.test.ts`

Expected: module-not-found or missing class failure.

- [ ] **Step 3: Implement the coalescer and hook wiring**

```ts
export class LatestFrameCoalescer<T> {
  private pending: T | undefined
  private requestId: number | undefined

  constructor(
    private readonly schedule: (callback: FrameRequestCallback) => number,
    private readonly cancel: (id: number) => void,
    private readonly commit: (value: T) => void,
  ) {}

  push(value: T) {
    this.pending = value
    if (this.requestId !== undefined) return
    this.requestId = this.schedule(() => {
      this.requestId = undefined
      const next = this.pending
      this.pending = undefined
      if (next !== undefined) this.commit(next)
    })
  }

  dispose() {
    if (this.requestId !== undefined) this.cancel(this.requestId)
    this.requestId = undefined
    this.pending = undefined
  }
}
```

Store the coalescer in a ref. Its commit updates only `frameDataUrl` and `frameGeneration`; update `streamSource` and `effectiveFps` from a separate 500 ms telemetry gate. Dispose on listener cleanup, detach, and device change.

- [ ] **Step 4: Run the green tests and renderer build**

```bash
npm test -- src/renderer/features/simulator/frameCoalescer.test.ts src/renderer/features/simulator/useIosSimulatorPanel.test.ts
npm run build:renderer
```

Expected: tests and TypeScript/Vite build pass.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/renderer/features/simulator/frameCoalescer.ts src/renderer/features/simulator/frameCoalescer.test.ts src/renderer/features/simulator/useIosSimulatorPanel.ts src/renderer/features/simulator/useIosSimulatorPanel.test.ts
git commit -m "perf: coalesce iOS simulator frames"
```

### Task 3: Make Device Geometry Authoritative

**Files:**
- Create: `src/renderer/features/simulator/simulatorGeometry.ts`
- Create: `src/renderer/features/simulator/simulatorGeometry.test.ts`

**Interfaces:**
- Produces: `Size`, `Rect`, `NormalizedPoint`, `paintedContainRect`, `clientPointToNormalized`, and `normalizedRectToCss`.
- Consumed by Tasks 5, 7, and 9 for manual input, annotations, and presence.

- [ ] **Step 1: Write portrait, landscape, iPad, and letterbox tests**

```ts
it.each([
  [{ width: 600, height: 600 }, { width: 393, height: 852 }, { x: 161.62, y: 0, width: 276.76, height: 600 }],
  [{ width: 600, height: 400 }, { width: 852, height: 393 }, { x: 0, y: 61.62, width: 600, height: 276.76 }],
])('computes the object-fit contain rectangle', (container, image, expected) => {
  expect(paintedContainRect(container, image)).toMatchObject({
    x: expect.closeTo(expected.x, 1), y: expect.closeTo(expected.y, 1),
    width: expect.closeTo(expected.width, 1), height: expect.closeTo(expected.height, 1),
  })
})

it('rejects a click in the letterbox and normalizes a click inside the device', () => {
  const painted = { x: 100, y: 0, width: 200, height: 400 }
  expect(clientPointToNormalized({ x: 50, y: 200 }, painted)).toBeNull()
  expect(clientPointToNormalized({ x: 200, y: 100 }, painted)).toEqual({ x: 0.5, y: 0.25 })
})
```

- [ ] **Step 2: Run and confirm module failure**

Run: `npm test -- src/renderer/features/simulator/simulatorGeometry.test.ts`

Expected: module-not-found failure.

- [ ] **Step 3: Implement clamped, finite geometry functions**

```ts
export type Size = { width: number; height: number }
export type Rect = { x: number; y: number; width: number; height: number }
export type NormalizedPoint = { x: number; y: number }

export function paintedContainRect(container: Size, image: Size): Rect {
  if (container.width <= 0 || container.height <= 0 || image.width <= 0 || image.height <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 }
  }
  const scale = Math.min(container.width / image.width, container.height / image.height)
  const width = image.width * scale
  const height = image.height * scale
  return { x: (container.width - width) / 2, y: (container.height - height) / 2, width, height }
}

export function clientPointToNormalized(point: { x: number; y: number }, painted: Rect): NormalizedPoint | null {
  if (point.x < painted.x || point.y < painted.y || point.x > painted.x + painted.width || point.y > painted.y + painted.height) return null
  return { x: (point.x - painted.x) / painted.width, y: (point.y - painted.y) / painted.height }
}
```

Implement `normalizedRectToCss` with the same finite/range guards and clamp every edge to `[0,1]`.

- [ ] **Step 4: Run green geometry tests**

Run: `npm test -- src/renderer/features/simulator/simulatorGeometry.test.ts`

Expected: all geometry tests pass.

- [ ] **Step 5: Commit Task 3**

```bash
git add src/renderer/features/simulator/simulatorGeometry.ts src/renderer/features/simulator/simulatorGeometry.test.ts
git commit -m "test: define iOS simulator geometry"
```

### Task 4: Add Serialized WDA Input and Accessibility Reads

**Files:**
- Modify: `src-tauri/src/services/ios_simulator/wda_client.rs`
- Modify: `src-tauri/src/services/ios_simulator.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/renderer/features/simulator/iosSimulatorApi.ts`
- Modify: `src/renderer/features/simulator/iosSimulatorModel.ts`
- Modify: `src/renderer/features/simulator/iosSimulatorModel.test.ts`

**Interfaces:**
- Produces Tauri commands: `ios_simulator_tap`, `ios_simulator_drag`, `ios_simulator_type_text`, `ios_simulator_press_key`, and `ios_simulator_accessibility_snapshot`.
- Produces: `IosSimulatorAccessibilityNode[]` with stable snapshot identity and device-point frames.
- Consumes: Task 1 `WdaSessionHandle`/`WdaWindowSize`.

- [ ] **Step 1: Write failing endpoint, coordinate, and serialization tests**

Assert exact WDA payloads:

```rust
assert_eq!(recorded, vec![
    RecordedRequest::post("/session/session-1/wda/tap", json!({ "x": 196.5, "y": 213.0 })),
    RecordedRequest::post("/session/session-1/wda/dragfromtoforduration", json!({
        "fromX": 39.3, "fromY": 681.6, "toX": 353.7, "toY": 170.4, "duration": 0.18
    })),
    RecordedRequest::post("/session/session-1/wda/keys", json!({ "value": ["Verboo"] })),
    RecordedRequest::post("/session/session-1/wda/performIoHidEvent", json!({ "keys": ["XCUIKeyboardKeyDelete"] })),
]);
```

Use a blocking fake client with an `AtomicBool` inside `tap`; start `tap` and `type_text` on separate threads and assert `type_text` cannot record before `tap` releases. Add mapping cases for 393×852 portrait, 852×393 landscape, and 1024×1366 iPad.

Add a source sanitizer test using:

```rust
json!({ "type": "Button", "rawIdentifier": "save", "label": "Save", "rect": {
    "x": 20, "y": 30, "width": 120, "height": 44
}, "enabled": true, "visible": true, "children": [] })
```

Expected node: actionable, frame preserved, label bounded, and deterministic id across two sanitizations.

- [ ] **Step 2: Run and confirm missing command/client failures**

Run: `cargo +1.89.0 test --manifest-path src-tauri/Cargo.toml ios_simulator -- --nocapture`

Expected: compile failures for missing methods and command types.

- [ ] **Step 3: Implement input and source contracts**

Extend `WdaClient` with:

```rust
fn tap(&self, session: &WdaSessionHandle, point: WdaPoint) -> Result<(), String>;
fn drag(&self, session: &WdaSessionHandle, from: WdaPoint, to: WdaPoint, duration: Duration) -> Result<(), String>;
fn type_text(&self, session: &WdaSessionHandle, text: &str) -> Result<(), String>;
fn press_key(&self, session: &WdaSessionHandle, key: IosSimulatorKey) -> Result<(), String>;
fn source_json(&self, session: &WdaSessionHandle) -> Result<serde_json::Value, String>;
```

Use `GET /session/{id}/source?format=json&excluded_attributes=customActions,nativeFrame,traits` and support exactly:

```rust
pub enum IosSimulatorKey { Enter, Backspace, Tab, ArrowUp, ArrowDown, ArrowLeft, ArrowRight }
```

Map these to `XCUIKeyboardKeyReturn`, `XCUIKeyboardKeyDelete`, `XCUIKeyboardKeyTab`, and the four `XCUIKeyboardKey*Arrow` names. Validate text as non-empty UTF-8 with at most 4,000 Unicode scalar values; validate normalized coordinates as finite `[0,1]`; clamp drag duration to 50–2,000 ms.

Add `input_lock: Arc<Mutex<()>>` to `Session`. Clone the WDA handle/window size under the state lock, release the state lock, then hold only `input_lock` during the HTTP call. This prevents deadlock with detach while preserving action order.

- [ ] **Step 4: Run backend and renderer type tests**

```bash
cargo +1.89.0 test --manifest-path src-tauri/Cargo.toml ios_simulator -- --nocapture
npm test -- src/renderer/features/simulator/iosSimulatorModel.test.ts
npm run build:renderer
```

Expected: all pass.

- [ ] **Step 5: Commit Task 4**

```bash
git add src-tauri/src/services/ios_simulator.rs src-tauri/src/services/ios_simulator/wda_client.rs src-tauri/src/lib.rs src/renderer/features/simulator/iosSimulatorApi.ts src/renderer/features/simulator/iosSimulatorModel.ts src/renderer/features/simulator/iosSimulatorModel.test.ts
git commit -m "feat: control the attached iOS simulator"
```

### Task 5: Build the Focusable Manual Interaction Surface

**Files:**
- Create: `src/renderer/features/simulator/useSimulatorInteraction.ts`
- Create: `src/renderer/features/simulator/useSimulatorInteraction.test.ts`
- Create: `src/renderer/features/simulator/SimulatorSurface.tsx`
- Create: `src/renderer/features/simulator/SimulatorSurface.test.tsx`
- Modify: `src/renderer/features/simulator/IosSimulatorPanel.tsx`
- Modify: `src/renderer/features/simulator/IosSimulatorPanel.test.tsx`
- Modify: `src/renderer/styles/ios-simulator.css`
- Modify: `src/renderer/i18n.tsx`

**Interfaces:**
- Produces: `SimulatorInteractionMode = 'interact' | 'select-element' | 'select-area'`.
- Produces manual callbacks `onTap`, `onDrag`, `onTypeText`, `onPressKey`; it does not accept or emit presence events.
- Consumes: Task 3 geometry and Task 4 API commands.

`useSimulatorInteraction(options)` returns this exact handler surface:

```ts
export type SimulatorInteractionHandlers = {
  onPointerDown: React.PointerEventHandler<HTMLDivElement>
  onPointerMove: React.PointerEventHandler<HTMLDivElement>
  onPointerUp: React.PointerEventHandler<HTMLDivElement>
  onPointerCancel: React.PointerEventHandler<HTMLDivElement>
  onKeyDown: React.KeyboardEventHandler<HTMLDivElement>
  onPaste: React.ClipboardEventHandler<HTMLDivElement>
  onCompositionStart: React.CompositionEventHandler<HTMLDivElement>
  onCompositionEnd: React.CompositionEventHandler<HTMLDivElement>
}
```

- [ ] **Step 1: Write failing manual interaction tests**

Cover these effects in `SimulatorSurface.test.tsx`:

```ts
fireEvent.pointerDown(surface, { pointerId: 1, clientX: 200, clientY: 300 })
fireEvent.pointerUp(surface, { pointerId: 1, clientX: 202, clientY: 302 })
expect(onTap).toHaveBeenCalledWith(expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }))
expect(onDrag).not.toHaveBeenCalled()

fireEvent.pointerDown(surface, { pointerId: 2, clientX: 200, clientY: 700 })
fireEvent.pointerMove(surface, { pointerId: 2, clientX: 200, clientY: 200 })
fireEvent.pointerUp(surface, { pointerId: 2, clientX: 200, clientY: 200 })
expect(onDrag).toHaveBeenCalledTimes(1)

surface.focus()
fireEvent.keyDown(surface, { key: 'a' })
fireEvent.paste(surface, { clipboardData: { getData: () => ' colado' } })
fireEvent.compositionEnd(surface, { data: 'ção' })
fireEvent.keyDown(surface, { key: 'Backspace' })
expect(onTypeText).toHaveBeenNthCalledWith(1, 'a')
expect(onTypeText).toHaveBeenNthCalledWith(2, ' colado')
expect(onTypeText).toHaveBeenNthCalledWith(3, 'ção')
expect(onPressKey).toHaveBeenCalledWith('backspace')
```

Before firing pointers, mock the surface bounds as
`{left:0,top:0,width:600,height:900,right:600,bottom:900}` and define the
image’s `naturalWidth=393`/`naturalHeight=852`; this makes the test exercise
the real contain mapping instead of jsdom’s zero-sized layout.

Also assert Command/Ctrl shortcuts are not prevented, `Escape` blurs without calling WDA, pointer cancel/window blur sends no action, and the letterbox rejects gestures.

- [ ] **Step 2: Run and confirm missing-surface failures**

Run: `npm test -- src/renderer/features/simulator/useSimulatorInteraction.test.ts src/renderer/features/simulator/SimulatorSurface.test.tsx src/renderer/features/simulator/IosSimulatorPanel.test.tsx`

Expected: missing module/component behavior failures.

- [ ] **Step 3: Implement pointer and keyboard ownership**

Use a six-CSS-pixel movement threshold:

```ts
const TAP_MOVEMENT_PX = 6
const distance = Math.hypot(current.clientX - start.clientX, current.clientY - start.clientY)
if (distance <= TAP_MOVEMENT_PX) onTap(start.normalized)
else onDrag(start.normalized, current.normalized, 180)
```

Make the surface a real focus target:

```tsx
<div
  ref={surfaceRef}
  className="ios-simulator-interaction-surface"
  role="application"
  tabIndex={mode === 'interact' && interactive ? 0 : -1}
  aria-label={t('simulator.interactionLabel', { name: deviceName })}
  aria-describedby="ios-simulator-keyboard-hint"
  data-mode={mode}
  {...interactionHandlers}
>
  <img ref={imageRef} src={frameDataUrl} alt={previewAlt} draggable={false} />
</div>
```

Use `setPointerCapture`, release it on completion/cancel, ignore non-primary buttons, and prevent default only for owned gestures/keys. Disable all WDA input when the stream is `simctl`, because there is no active WebDriver session.

- [ ] **Step 4: Add focus/mode styling and localized instructions**

Add a quiet inset violet focus ring and `touch-action: none` only on the interaction surface. Add English and Portuguese copy for Interact, Select component, Select area, keyboard focus, Escape release, and interaction-unavailable fallback. Keep all overlays `aria-hidden="true"`.

- [ ] **Step 5: Run focused tests and build**

```bash
npm test -- src/renderer/features/simulator/useSimulatorInteraction.test.ts src/renderer/features/simulator/SimulatorSurface.test.tsx src/renderer/features/simulator/IosSimulatorPanel.test.tsx
npm run build:renderer
```

Expected: all pass.

- [ ] **Step 6: Commit Task 5**

```bash
git add src/renderer/features/simulator/useSimulatorInteraction.ts src/renderer/features/simulator/useSimulatorInteraction.test.ts src/renderer/features/simulator/SimulatorSurface.tsx src/renderer/features/simulator/SimulatorSurface.test.tsx src/renderer/features/simulator/IosSimulatorPanel.tsx src/renderer/features/simulator/IosSimulatorPanel.test.tsx src/renderer/styles/ios-simulator.css src/renderer/i18n.tsx
git commit -m "feat: interact with the iOS simulator panel"
```

### Task 6: Capture Accessibility Elements and Free Areas

**Files:**
- Create: `src-tauri/src/services/ios_simulator/capture_store.rs`
- Modify: `src-tauri/src/services/ios_simulator.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/renderer/features/simulator/iosSimulatorApi.ts`

**Interfaces:**
- Produces: `IosSimulatorAnnotationCapture` containing crop/full paths, pixel sizes, device identity, orientation, device generation, frame generation, normalized/device rects, and optional accessibility metadata.
- Produces Tauri commands for capture, temp deletion, promotion, owner deletion, and orphan cleanup.
- Consumes: latest complete frame bytes and sanitized accessibility nodes from Tasks 1 and 4.

- [ ] **Step 1: Write failing same-generation capture and cleanup tests**

Add a test frame with known 400×800 PNG pixels, select normalized `{x:0.25,y:0.25,width:0.5,height:0.25}`, and assert a 200×200 crop plus a 400×800 full snapshot. Assert both files share one UUID stem and the report repeats one `frame_generation`.

Add red tests for:

```rust
assert!(capture_for_generation(current + 1, rect).is_err());
assert!(delete_temp_files(vec!["/tmp/not-verboo/file.png".into()]).is_err());
assert!(!capture_store.owner_dir("conversation-a").eq(&capture_store.owner_dir("conversation-b")));
```

Simulate device generation changing after bytes are copied but before files are returned; assert both temporary files are removed and no attachment report escapes.

- [ ] **Step 2: Run and confirm missing store/report failures**

Run: `cargo +1.89.0 test --manifest-path src-tauri/Cargo.toml ios_simulator -- --nocapture`

Expected: missing `capture_store`/capture command compile failures.

- [ ] **Step 3: Store the latest complete frame and implement safe capture**

Add to `Session`:

```rust
struct LatestFrame {
    device_generation: u64,
    frame_generation: u64,
    bytes: Vec<u8>,
    media_type: &'static str,
}

latest_frame: Arc<Mutex<Option<LatestFrame>>>,
```

Update it before emitting each complete `simctl` or MJPEG frame. The capture command clones one `LatestFrame`, validates the requested device generation, decodes once with `image::load_from_memory`, clamps the normalized rectangle, writes viewport/crop into `std::env::temp_dir()/verboo-ios-simulator`, then rechecks device generation before returning.

Change the `simctl` helper to return raw PNG bytes first and derive its data
URL from those same bytes. For MJPEG, store the extracted JPEG bytes before
base64 encoding. Do not decode a renderer data URL back into bytes.

Create a dedicated durable root `app_data_dir/simulator_captures`. Hash owner ids with SHA-256 and accept only direct `.png` children of the simulator temp root. Never reuse the browser temp allowlist.

- [ ] **Step 4: Register commands and store state**

Register:

```rust
ios_simulator_accessibility_snapshot,
ios_simulator_capture_annotation,
ios_simulator_delete_temp_files,
ios_simulator_promote_temp_files,
ios_simulator_delete_capture_owner,
ios_simulator_cleanup_capture_owners,
```

Manage `IosSimulatorCaptureStore` from `app_data_dir` during Tauri setup.

- [ ] **Step 5: Run backend tests**

```bash
cargo +1.89.0 fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo +1.89.0 test --manifest-path src-tauri/Cargo.toml ios_simulator -- --nocapture
```

Expected: formatting and all simulator backend tests pass.

- [ ] **Step 6: Commit Task 6**

```bash
git add src-tauri/src/services/ios_simulator.rs src-tauri/src/services/ios_simulator/capture_store.rs src-tauri/src/lib.rs src/renderer/features/simulator/iosSimulatorApi.ts
git commit -m "feat: capture iOS simulator annotations"
```

### Task 7: Add Simulator Annotations to Chat

**Files:**
- Create: `src/renderer/features/simulator/simulatorAnnotations.ts`
- Create: `src/renderer/features/simulator/simulatorAnnotations.test.ts`
- Create: `src/renderer/features/attachments/visualAttachments.ts`
- Create: `src/renderer/features/attachments/visualAttachments.test.ts`
- Modify: `src/shared/types.ts`
- Modify: `src-tauri/src/models/types.rs`
- Modify: `src-tauri/src/services/turn_service.rs`
- Modify: `src/renderer/features/simulator/SimulatorSurface.tsx`
- Modify: `src/renderer/features/simulator/SimulatorSurface.test.tsx`
- Modify: `src/renderer/features/simulator/useIosSimulatorPanel.ts`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/features/composer/Composer.tsx`
- Modify: `src/renderer/features/composer/Composer.test.tsx`
- Modify: `src/renderer/components/Transcript.tsx`
- Modify: `src/renderer/components/Transcript.test.tsx`
- Modify: `src/renderer/i18n.tsx`
- Modify: `src/renderer/styles/ios-simulator.css`

**Interfaces:**
- Produces: `SimulatorAnnotation`, `createSimulatorAnnotationAttachment`, `expandVisualAttachmentSnapshots`, `promoteVisualAttachments`, and `deleteVisualTempFiles`.
- Consumes: Task 6 capture report and Task 5 selection modes.

- [ ] **Step 1: Write failing attachment-contract tests**

Define the exact frontend metadata:

```ts
export type SimulatorAnnotation = {
  kind: 'element' | 'area'
  crop: string
  note?: string
  device: { name: string; udid: string; iosVersion: string; orientation: 'portrait' | 'landscape' }
  deviceGeneration: number
  frameGeneration: number
  rect: { x: number; y: number; width: number; height: number }
  deviceRect: { x: number; y: number; width: number; height: number }
  element?: { id: string; role: string; label?: string }
  viewportSnapshot: { path: string; width: number; height: number; size: number }
}
```

Assert `createSimulatorAnnotationAttachment` returns `kind: 'simulator-annotation'`, never includes URL/selector text, and includes:

```text
Simulator annotation (element) on iPhone 17 Pro, iOS 26.5, portrait.
Selected component: Button “Save”.
User note (authoritative instruction): Increase the spacing.
Treat the written instruction and selected simulator component as authoritative. Use the crop and full simulator viewport only as supporting visual context.
```

Assert expanded request attachments contain the crop as `simulator-annotation` plus one ordinary full-viewport `image`. Assert promotion updates both paths. Assert annotation-only submit is enabled for browser and simulator annotations.

- [ ] **Step 2: Run and confirm red type/behavior failures**

```bash
npm test -- src/renderer/features/simulator/simulatorAnnotations.test.ts src/renderer/features/attachments/visualAttachments.test.ts src/renderer/features/composer/Composer.test.tsx src/renderer/components/Transcript.test.tsx
cargo +1.89.0 test --manifest-path src-tauri/Cargo.toml turn_service -- --nocapture
```

Expected: missing kind/type/functions and Rust enum variant failures.

- [ ] **Step 3: Implement simulator-specific attachment identity**

Extend only the required contracts, including the persisted transcript
attachment `Pick` so `simulatorAnnotation` survives conversation reload:

```ts
export type AttachmentKind = 'image' | 'video' | 'file' | 'browser-annotation' | 'simulator-annotation'

export type AttachmentMeta = {
  path: string
  name: string
  size: number
  kind: AttachmentKind
  mediaType?: string
  width?: number
  height?: number
  extractedText?: string
  extractionStatus?: ExtractionStatus
  video?: VideoStreamMetadata
  browserAnnotation?: BrowserAnnotation
  simulatorAnnotation?: SimulatorAnnotation
}

export type StoredAttachmentMeta = Pick<AttachmentMeta,
  'path' | 'name' | 'kind' | 'size' | 'mediaType' | 'browserAnnotation' | 'simulatorAnnotation'>
```

Add `SimulatorAnnotation` to Rust `AttachmentKind`, `attachment_kind_label`, `is_visual_attachment`, and the structured-context-preserving branch of `merge_vision_description`. Rust does not need the frontend-only geometry object; it receives authoritative text through `extractedText` and the two image paths through expanded attachments.

Implement shared dispatch without renaming browser-specific functions:

```ts
export function isVisualAttachment(a: Pick<AttachmentMeta, 'kind'>) {
  return a.kind === 'image' || a.kind === 'browser-annotation' || a.kind === 'simulator-annotation'
}

export function expandVisualAttachmentSnapshots(items: AttachmentMeta[]) {
  return expandSimulatorAnnotationSnapshots(expandBrowserAnnotationSnapshots(items))
}
```

`promoteVisualAttachments` runs browser promotion, then simulator promotion. `deleteVisualTempFiles` partitions exact `/verboo-browser/` and `/verboo-ios-simulator/` paths and calls the corresponding Tauri commands.

- [ ] **Step 4: Wire element/area confirmation into the surface**

When `select-element` activates, request one accessibility snapshot. On click, choose the smallest actionable node whose frame contains the normalized point, call `captureAnnotation` immediately, and show an inline note/confirm panel. For `select-area`, draw the clamped rectangle during drag; reject width or height under 0.01 normalized units; capture on pointer up before showing the note.

On cancel, call simulator temp deletion for both files. On confirm, build the attachment and pass it to App through `onAddAnnotation`; the existing ordered attachment queue preserves its position.

- [ ] **Step 5: Generalize send, queue, transcript, and conversation cleanup**

Replace App’s browser-only expansion/promotion/temp tracking with the shared visual helpers. Persist `simulatorAnnotation` in `slimMeta`. Delete the simulator capture owner when deleting a conversation and clean orphan owners at startup. Composer and Transcript classify both annotation kinds as image chips; simulator chip copy uses device name plus selected role/label and never a URL.

- [ ] **Step 6: Run focused frontend/backend tests and build**

```bash
npm test -- src/renderer/features/simulator/SimulatorSurface.test.tsx src/renderer/features/simulator/simulatorAnnotations.test.ts src/renderer/features/attachments/visualAttachments.test.ts src/renderer/features/composer/Composer.test.tsx src/renderer/components/Transcript.test.tsx
cargo +1.89.0 test --manifest-path src-tauri/Cargo.toml turn_service -- --nocapture
npm run build:renderer
```

Expected: all pass.

- [ ] **Step 7: Commit Task 7**

```bash
git add src/shared/types.ts src-tauri/src/models/types.rs src-tauri/src/services/turn_service.rs src/renderer/features/simulator/simulatorAnnotations.ts src/renderer/features/simulator/simulatorAnnotations.test.ts src/renderer/features/attachments/visualAttachments.ts src/renderer/features/attachments/visualAttachments.test.ts src/renderer/features/simulator/SimulatorSurface.tsx src/renderer/features/simulator/SimulatorSurface.test.tsx src/renderer/features/simulator/useIosSimulatorPanel.ts src/renderer/App.tsx src/renderer/features/composer/Composer.tsx src/renderer/features/composer/Composer.test.tsx src/renderer/components/Transcript.tsx src/renderer/components/Transcript.test.tsx src/renderer/i18n.tsx src/renderer/styles/ios-simulator.css
git commit -m "feat: add iOS simulator annotations to chat"
```

### Task 8: Add the Authenticated Agent Bridge and Presence Generations

**Files:**
- Create: `src-tauri/src/services/ios_simulator/bridge.rs`
- Modify: `src-tauri/src/services/ios_simulator.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/renderer/features/simulator/iosSimulatorApi.ts`
- Modify: `src/renderer/features/simulator/useIosSimulatorPanel.ts`
- Modify: `src/renderer/features/simulator/useIosSimulatorPanel.test.ts`

**Interfaces:**
- Produces loopback JSON-line messages `toolRequest`, `toolResponse`, `error`, and `turnComplete` at protocol version 1.
- Produces renderer events `ios-simulator:presence` and `ios-simulator:open-requested`.
- Consumes the same Task 4 service methods used by manual input.

- [ ] **Step 1: Write failing authentication, same-session, and generation tests**

Test that wrong/missing secrets receive `unauthorized`, unknown tools receive `unknown_tool`, and a request for a UDID other than the attached device receives `device_mismatch` rather than silently attaching another simulator.

Pin the concurrency bug:

```rust
let first = presence.begin(AgentAction::Tap {
    target: NormalizedPoint { x: 0.2, y: 0.3 },
});
let second = presence.begin(AgentAction::Tap {
    target: NormalizedPoint { x: 0.7, y: 0.8 },
});
assert!(!presence.complete(first));
assert_eq!(presence.current_generation(), Some(second));
assert!(presence.complete(second));
assert_eq!(presence.current_generation(), None);
```

Record events around a fake WDA call and assert `Start(generation)` is emitted before the fake client’s action record. Assert `turnComplete`, detach, panel close, window hide, and app exit each emit a clear event and leave no active generation.

- [ ] **Step 2: Run and confirm missing bridge/presence failures**

Run: `cargo +1.89.0 test --manifest-path src-tauri/Cargo.toml ios_simulator -- --nocapture`

Expected: missing bridge/presence compile failures.

- [ ] **Step 3: Implement private discovery and loopback server**

Use a record shaped exactly as:

```rust
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SimulatorDiscoveryRecord {
    protocol_version: u32,
    pid: u32,
    endpoint: String,
    secret: String,
    app_version: String,
}
```

Bind `TcpListener` to `127.0.0.1:0`, generate a 128-bit random UUID secret, atomically write the record with mode `0600` under the user cache directory `verboo-ios-simulator`, and set the directory to `0700` on Unix. Remove stale records whose pid is dead or endpoint cannot be reached. Accept one newline-delimited JSON envelope per connection, compare the secret before parsing tool arguments, and cap one request line at 1 MiB.

Tool dispatch supports exact names: `ios_simulator_list`, `ios_simulator_attach`, `ios_simulator_inspect`, `ios_simulator_screenshot`, `ios_simulator_tap`, `ios_simulator_drag`, `ios_simulator_type_text`, `ios_simulator_press_key`, and `ios_simulator_detach`.

- [ ] **Step 4: Implement presence authority**

Add an `AtomicU64` counter and `Mutex<Option<u64>>` current generation. Emit:

```rust
pub struct IosSimulatorPresenceEvent {
    pub generation: u64,
    pub phase: IosSimulatorPresencePhase,
    pub action: Option<IosSimulatorPresenceAction>,
    pub target: Option<NormalizedPoint>,
    pub start: Option<NormalizedPoint>,
    pub end: Option<NormalizedPoint>,
}
```

The bridge calls `begin_agent_action` and emits `open-requested` before executing WDA. Completion clears only when its generation still owns presence. `turnComplete` calls unconditional `clear_agent_presence`; manual Tauri commands call the WDA methods directly and never call presence methods.

- [ ] **Step 5: Start and stop the bridge with the app**

Start the bridge during Tauri setup with cloned `AppHandle` and `IosSimulatorService`; retain a stop flag/worker handle in managed state. On app exit, stop accepting, remove the discovery record, clear presence, then run the existing bounded WDA cleanup.

- [ ] **Step 6: Run bridge/lifecycle tests**

```bash
cargo +1.89.0 test --manifest-path src-tauri/Cargo.toml ios_simulator -- --nocapture
cargo +1.89.0 test --manifest-path src-tauri/Cargo.toml close_to_tray_detaches_the_simulator_session -- --nocapture
cargo +1.89.0 test --manifest-path src-tauri/Cargo.toml app_exit_cleanup_stops_the_session_within_its_deadline -- --nocapture
```

Expected: authenticated relay, presence ordering/generation, and lifecycle tests pass.

- [ ] **Step 7: Commit Task 8**

```bash
git add src-tauri/src/services/ios_simulator/bridge.rs src-tauri/src/services/ios_simulator.rs src-tauri/src/lib.rs src/renderer/features/simulator/iosSimulatorApi.ts src/renderer/features/simulator/useIosSimulatorPanel.ts src/renderer/features/simulator/useIosSimulatorPanel.test.ts
git commit -m "feat: expose the iOS simulator agent bridge"
```

### Task 9: Render Device-Adaptive Agent Presence

**Files:**
- Create: `src/renderer/features/simulator/SimulatorPresenceOverlay.tsx`
- Create: `src/renderer/features/simulator/SimulatorPresenceOverlay.test.tsx`
- Modify: `src/renderer/features/simulator/SimulatorSurface.tsx`
- Modify: `src/renderer/features/simulator/SimulatorSurface.test.tsx`
- Modify: `src/renderer/features/simulator/useIosSimulatorPanel.ts`
- Modify: `src/renderer/features/simulator/useIosSimulatorPanel.test.ts`
- Modify: `src/renderer/features/simulator/IosSimulatorPanel.tsx`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/styles/ios-simulator.css`

**Interfaces:**
- Consumes: Task 3 painted rectangle and Task 8 presence/open events.
- Produces no backend actions; it is a generation-filtered visual projection only.

- [ ] **Step 1: Write failing visual authority tests**

Assert the overlay’s inline bounds equal the painted device cutout rather than the panel. Feed generation 5 start, generation 6 start, and generation 5 complete; assert generation 6 remains visible. Feed generation 6 complete and assert removal.

Assert tap renders one cursor and ripple at the normalized target, drag renders a start/end path, manual pointer callbacks never create the overlay, and reduced motion sets `data-reduced-motion="true"` with no travel animation class.

- [ ] **Step 2: Run and confirm missing overlay behavior**

Run: `npm test -- src/renderer/features/simulator/SimulatorPresenceOverlay.test.tsx src/renderer/features/simulator/SimulatorSurface.test.tsx src/renderer/features/simulator/useIosSimulatorPanel.test.ts`

Expected: missing component/event behavior failures.

- [ ] **Step 3: Implement the overlay with the Chrome visual language**

Reuse the pointer SVG path data from `extensions/verboo-chrome/src/presence/inject.js` without importing extension runtime code:

```tsx
<svg width="30" height="30" viewBox="0 0 34 34" aria-hidden="true">
  <path fill="#a468ff" stroke="#fff" strokeWidth="1.25" strokeLinejoin="round"
    d="M4.4 3.8 L6.1 26.4 L12.05 20.34 L16.64 29.25 L20.64 27.19 L16.05 18.28 L24.58 17.42 Z" />
  <path fill="#7f48eb" fillOpacity=".52" d="M5.25 4.7 L15.98 18.24 L11.94 20.1 L6.25 25.45 Z" />
  <path fill="none" stroke="#fff" strokeOpacity=".5" strokeWidth="1" strokeLinecap="round" d="M7.1 7.1 L7.9 20.2" />
</svg>
```

Place the aurora absolutely at `paintedRect`, use the extension’s violet inset shadows/blurred moving edge gradients, and derive border radius as `clamp(10px, paintedRect.width * 0.035, 24px)`. Cursor positions are normalized inside that same local rectangle. Supersede active Web Animations when a newer generation arrives; fall back to final transform when `Element.animate` is unavailable.

- [ ] **Step 4: Wire event/open behavior and cleanup**

`useIosSimulatorPanel` listens for presence and open-requested only once. It
accepts a start event only when `generation >= current`, ignores stale
completion, and clears on detach/close. The hook exposes an incrementing
`agentOpenRequest` token instead of changing competing panels itself. An App
effect consumes each token once, switches to chat, closes terminal/review/browser,
clears the selected subagent, and calls `simulator.open()`; this makes the
simulator the sole visible right rail.

- [ ] **Step 5: Run visual tests and renderer build**

```bash
npm test -- src/renderer/features/simulator/SimulatorPresenceOverlay.test.tsx src/renderer/features/simulator/SimulatorSurface.test.tsx src/renderer/features/simulator/useIosSimulatorPanel.test.ts src/renderer/features/simulator/IosSimulatorPanel.test.tsx
npm run build:renderer
```

Expected: tests/build pass.

- [ ] **Step 6: Commit Task 9**

```bash
git add src/renderer/features/simulator/SimulatorPresenceOverlay.tsx src/renderer/features/simulator/SimulatorPresenceOverlay.test.tsx src/renderer/features/simulator/SimulatorSurface.tsx src/renderer/features/simulator/SimulatorSurface.test.tsx src/renderer/features/simulator/useIosSimulatorPanel.ts src/renderer/features/simulator/useIosSimulatorPanel.test.ts src/renderer/features/simulator/IosSimulatorPanel.tsx src/renderer/App.tsx src/renderer/styles/ios-simulator.css
git commit -m "feat: show agent presence on the iOS simulator"
```

### Task 10: Package and Register the Simulator MCP Sidecar

**Files:**
- Create: `src-tauri/verboo-in-chrome/src/bin/verboo-ios-simulator.rs`
- Create: `src-tauri/verboo-in-chrome/src/simulator_catalog.rs`
- Create: `src-tauri/verboo-in-chrome/src/simulator_client.rs`
- Create: `src-tauri/verboo-in-chrome/src/simulator_mcp.rs`
- Create: `src-tauri/verboo-in-chrome/src/simulator_protocol.rs`
- Create: `src-tauri/verboo-in-chrome/src/simulatorTools.json`
- Create: `src-tauri/verboo-in-chrome/tests/simulator_catalog.rs`
- Create: `src-tauri/verboo-in-chrome/tests/simulator_mcp.rs`
- Modify: `src-tauri/verboo-in-chrome/Cargo.toml`
- Modify: `src-tauri/verboo-in-chrome/src/lib.rs`
- Create: `src-tauri/src/services/ios_simulator_mcp.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `scripts/tauri/build-chrome-helper.mjs`
- Modify: `scripts/tauri/build-chrome-helper.test.mjs`
- Modify: `package.json`
- Modify: `src-tauri/tauri.conf.json`

**Interfaces:**
- Produces the stdio MCP server `verboo-ios-simulator` registered at user scope.
- Consumes Task 8 discovery/protocol and sends `turnComplete` on EOF, SIGINT, and SIGTERM.

- [ ] **Step 1: Write failing catalog, relay, cleanup, and filename tests**

Pin the catalog to exactly nine names from Task 8, validate normalized points as numbers in `[0,1]`, bound text to 4,000 characters, and classify list/inspect/screenshot as read-only.

Add MCP tests that start a fake loopback desktop bridge, invoke `ios_simulator_tap`, and assert structured success. Send invalid arguments and assert `is_error: true` with `invalid_arguments`. Close stdin, then repeat with SIGINT/SIGTERM harnesses; each must deliver one `turnComplete` within 200 ms.

Update build filename tests:

```js
assert.equal(sidecarFilename('verboo-in-chrome', 'aarch64-apple-darwin', 'darwin'), 'verboo-in-chrome-aarch64-apple-darwin')
assert.equal(sidecarFilename('verboo-ios-simulator', 'aarch64-apple-darwin', 'darwin'), 'verboo-ios-simulator-aarch64-apple-darwin')
```

- [ ] **Step 2: Run and confirm red failures**

```bash
cargo +1.89.0 test --manifest-path src-tauri/verboo-in-chrome/Cargo.toml simulator -- --nocapture
node --test scripts/tauri/build-chrome-helper.test.mjs
```

Expected: missing binary/modules and old filename signature failures.

- [ ] **Step 3: Implement the MCP catalog/client/server**

Use `rmcp` exactly as the Chrome server does, but use simulator-specific names and errors. `SimulatorSessionClient` reads the Task 8 discovery record, verifies protocol version, connects only to a parsed `127.0.0.1` socket, injects the secret, and removes a stale record after connection failure.

The binary accepts only `mcp` and `ping`:

```rust
#[tokio::main]
async fn main() {
    let result = match std::env::args().nth(1).as_deref() {
        Some("mcp") => verboo_in_chrome::simulator_mcp::run_mcp().await,
        Some("ping") => verboo_in_chrome::simulator_mcp::run_ping(),
        _ => Err("usage: verboo-ios-simulator <mcp|ping>".into()),
    };
    if let Err(error) = result { eprintln!("verboo-ios-simulator: {error}"); std::process::exit(1); }
}
```

Copy the existing EOF/signal shutdown shape but call simulator `complete_turn`; keep the cleanup timeout at 200 ms so it fits the CLI’s 400 ms SIGTERM→SIGKILL grace.

- [ ] **Step 4: Build and package both sidecars**

Change `build-chrome-helper.mjs` to iterate `['verboo-in-chrome', 'verboo-ios-simulator']`, copy both target-triple binaries, and return both destinations. Keep the existing npm script name to avoid release-pipeline churn. Add `binaries/verboo-ios-simulator` to Tauri `externalBin`.

- [ ] **Step 5: Install and idempotently register the helper**

`ios_simulator_mcp.rs` copies only the bundled simulator helper into `app_data_dir/ios-simulator-integration/{app_version}/`, sets mode `0755`, and inspects the user CLI config before mutation. Register:

```text
verboo mcp add verboo-ios-simulator --scope user \
  -e VERBOO_IOS_SIMULATOR_MANAGED=1 \
  -e VERBOO_IOS_SIMULATOR_VERSION=<app-version> \
  -- <managed-helper-path> mcp
```

If the existing entry lacks the managed marker or points outside the owned integration root, report a conflict and leave it untouched. If managed but outdated, remove and re-add. Run setup in `spawn_blocking` so app startup/first paint does not wait on the CLI.

- [ ] **Step 6: Run sidecar, installer, build-script, and package gates**

```bash
cargo +1.89.0 test --manifest-path src-tauri/verboo-in-chrome/Cargo.toml -- --nocapture
cargo +1.89.0 test --manifest-path src-tauri/Cargo.toml ios_simulator_mcp -- --nocapture
node --test scripts/tauri/build-chrome-helper.test.mjs
npm run build:chrome-helper
```

Expected: both binaries are built with target-triple suffixes; all tests pass.

- [ ] **Step 7: Commit Task 10**

```bash
git add src-tauri/verboo-in-chrome/Cargo.toml src-tauri/verboo-in-chrome/src/lib.rs src-tauri/verboo-in-chrome/src/bin/verboo-ios-simulator.rs src-tauri/verboo-in-chrome/src/simulator_catalog.rs src-tauri/verboo-in-chrome/src/simulator_client.rs src-tauri/verboo-in-chrome/src/simulator_mcp.rs src-tauri/verboo-in-chrome/src/simulator_protocol.rs src-tauri/verboo-in-chrome/src/simulatorTools.json src-tauri/verboo-in-chrome/tests/simulator_catalog.rs src-tauri/verboo-in-chrome/tests/simulator_mcp.rs src-tauri/src/services/ios_simulator_mcp.rs src-tauri/src/services/mod.rs src-tauri/src/lib.rs scripts/tauri/build-chrome-helper.mjs scripts/tauri/build-chrome-helper.test.mjs package.json src-tauri/tauri.conf.json
git commit -m "feat: package the iOS simulator MCP helper"
```

---

## Final Verification Gate

- [ ] Run every affected automated gate from a clean index while preserving unrelated worktree changes:

```bash
npm test -- src/renderer/features/simulator src/renderer/features/attachments/visualAttachments.test.ts src/renderer/features/composer/Composer.test.tsx src/renderer/components/Transcript.test.tsx
node --test scripts/tauri/copy-wda-resource.test.mjs scripts/tauri/build-chrome-helper.test.mjs
cargo +1.89.0 test --manifest-path src-tauri/verboo-in-chrome/Cargo.toml -- --nocapture
cargo +1.89.0 test --manifest-path src-tauri/Cargo.toml ios_simulator -- --nocapture
cargo +1.89.0 test --manifest-path src-tauri/Cargo.toml turn_service -- --nocapture
npm run build:renderer
```

Expected: every command exits 0.

- [ ] Start the real app without calling the Verboo model and prove the production path:

```bash
npm run tauri:dev
```

1. Attach a shutdown iPhone 17 Pro and observe `simctl` warmup followed by MJPEG near 30 fps.
2. Tap Safari, drag between Home Screen pages, focus a text field, type accented text, paste text, press Backspace/Enter, and release focus with Escape.
3. Select one accessibility component and one free rectangle; add both to chat and verify two simulator-specific chips, complete crops, full snapshots, and no browser URL/selector metadata.
4. Invoke tap, drag, and type through the local `verboo-ios-simulator` MCP helper; verify panel auto-open, pre-action cursor/aurora/ripple/path, correct target, and turn cleanup.
5. Keep a newer presence action active while completing an older generation; verify the newer aurora remains until its own completion.
6. Switch to 60 fps, confirm the localized warning, observe sustained high fluency, record Verboo/WDA CPU, and return to 30 fps.
7. Close/detach while another tab/panel is active; verify WDA, MJPEG/HTTP ports, bridge presence, and input stop while Simulator.app remains usable.

- [ ] Build the packaged application and verify bundled resources/sidecars:

```bash
npm run tauri:build
```

Expected: build exits 0, the `.app` contains WebDriverAgent plus both `verboo-in-chrome` and `verboo-ios-simulator` target binaries, and launching the packaged app repeats steps 1–7.

- [ ] Inspect the final diff and report exact evidence:

```bash
git diff --check
git status --short
git log --oneline --decorate -12
```

Report measured default/high-fluency FPS, process CPU snapshots, manual interaction results, both annotation modes, MCP action results, presence cleanup, exact test commands/outcomes, packaged app path, and any skipped verification. Do not claim completion if the real packaged path or cleanup proof is missing.

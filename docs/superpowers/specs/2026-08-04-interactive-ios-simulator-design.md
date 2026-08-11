# Interactive iOS Simulator Design

**Date:** 2026-08-04
**Status:** Approved for implementation planning

## Objective

Turn the existing read-only iOS Simulator panel into a smooth, directly
interactive surface that can also be controlled by the Verboo agent. The panel
must support manual touch, drag, and keyboard input, visual annotations that can
be added to chat, and the same agent-presence language used by the Verboo Chrome
extension.

The implementation must keep the current `simctl` warmup/fallback, WDA cleanup,
loopback-only networking, and package portability intact.

## Confirmed Product Decisions

- Manual keyboard input is captured directly after the user focuses the
  simulator surface. `Escape` releases that focus.
- Annotation mode supports both element-aware selection and free rectangular
  selection.
- Manual interaction does not show agent presence.
- Agent interaction shows a violet aurora around the rendered device cutout and
  a moving agent cursor with click feedback.
- MJPEG defaults to 30 fps.
- 60 fps is optional and carries a friendly high-performance warning.
- WDA scaling remains at 100 percent.
- Simulator annotations reuse the existing Add to Chat experience but retain a
  simulator-specific attachment identity and metadata.

## Measured Baseline

The current WDA package defaults `mjpegServerFramerate` to 10. In the real app,
the raw WDA endpoint and renderer matched at approximately 9.4 fps, proving that
the producer setting was the active ceiling.

Temporary runtime counterfactuals measured:

| Configuration | Raw stream | Visible panel | Approximate process cost |
| --- | ---: | ---: | --- |
| 10 fps, scale 100 | 9.39-9.40 fps | 9.5 fps | Existing ceiling |
| 30 fps, scale 100 | 27.36-27.42 fps | 27.6-28.4 fps | Verboo 7 percent, WDA 1.2 percent CPU |
| 60 fps, scale 100 | 50.59-57.10 fps | 57.7 fps | Verboo 11-13 percent, WDA 2-2.5 percent CPU |
| 30 fps, scale 50 | 26.56-26.85 fps | Kept pace | WDA 19-24 percent CPU |

Scale 50 also increased a representative frame from roughly 100 KB to 140 KB.
It is therefore explicitly excluded as an optimization.

## Architecture

### One WDA Authority

`IosSimulatorService` remains the authority for the attached simulator. It owns:

- the selected simulator and its lifecycle state;
- the bounded `xcodebuild`/WDA process tree;
- one WDA WebDriver session;
- the MJPEG reader and `simctl` fallback;
- the current device window size in iOS points;
- the latest complete visual frame;
- manual and agent input serialization;
- the accessibility snapshot used for element selection;
- agent-presence generations and cleanup.

After WDA reports ready, the service creates a WebDriver session and applies
settings through `/session/{id}/appium/settings`. It sets
`mjpegServerFramerate` to the selected stream profile and
`mjpegScalingFactor` to 100 before promoting MJPEG to the renderer.

The fallback rate remains independent. Its existing 0.5, 1, and 2 fps options
continue to control only sequential `simctl` capture during warmup or WDA
failure.

### WDA Client Boundary

HTTP and WebDriver details live behind a focused WDA client rather than growing
inside the capture loop. Its interface covers:

- readiness and WebDriver session creation;
- applying MJPEG settings;
- reading the window size and accessibility snapshot;
- tap, drag, text, and special-key input;
- deleting the WebDriver session during detach.

All requests bind to and consume `127.0.0.1` only. A failed WDA request reports a
specific error and preserves the visual fallback where possible. It never
silently reports a manual or agent action as successful.

## Manual Interaction

The simulator image is wrapped in a focusable interaction surface with three
explicit modes:

1. **Interact** is the default. A short pointer gesture becomes a tap. A gesture
   that exceeds the movement threshold becomes a drag from its actual start and
   end positions.
2. **Select component** reads the current accessibility snapshot, highlights the
   smallest actionable element containing the pointer, and does not forward the
   click to the simulator.
3. **Select area** draws a free rectangle and does not forward the drag to the
   simulator.

Modes are mutually exclusive. Closing annotation mode restores Interact.

The renderer computes the actual painted image rectangle after `object-fit:
contain`. Pointer positions are converted to normalized coordinates only when
they fall inside that rectangle. The backend converts normalized coordinates to
iOS points using its authoritative WDA window size. This keeps taps correct for
iPhone, iPad, landscape, panel resizing, Retina density, and letterboxing.

### Direct Keyboard Capture

Clicking the Interact surface gives it keyboard focus and shows a quiet focus
indicator. Printable text, composed input, paste, Enter, Backspace, Tab, Escape,
and arrow keys follow these rules:

- printable and composed text is sent through WDA text input;
- supported control keys are sent as explicit WDA key values;
- `Escape` first releases simulator focus and is not sent to iOS;
- browser/app shortcuts with Command or Control remain owned by the desktop app;
- input is ignored outside Interact mode or without an attached WDA session.

Input requests are serialized so a rapid sequence cannot reorder characters or
overtake a preceding tap.

## Visual Annotation Flow

### Element Selection

The backend returns a sanitized accessibility tree with stable element identity,
label, type, and frame in iOS points. The renderer normalizes frames into the
painted image rectangle and highlights the smallest eligible element under the
pointer. Decorative or zero-area nodes are excluded.

### Free Area Selection

The renderer stores a normalized rectangle clamped to the device image. Very
small accidental drags are rejected. The overlay is independent of MJPEG frame
changes, so selection does not flicker at 30 or 60 fps.

### Add to Chat

Confirming either selection captures:

- a crop of the selected simulator area;
- the full simulator viewport from the same generation;
- the device name, UDID, iOS version, and orientation;
- normalized and device-point rectangles;
- accessibility role, label, and stable element identity when available;
- the optional user note.

The attachment kind is `simulator-annotation`. It uses the existing visual
attachment, annotation-chip, send, retry, transcript, and temp-file cleanup
contracts, but it must not emit browser URL or CSS-selector instructions.
Simulator-specific prompt text treats the note and selected component as the
authoritative scope and the images as supporting visual context.

## Agent Control and Presence

### Model-Facing Tools

A managed `verboo-ios-simulator` MCP sidecar follows the established
`verboo-in-chrome` packaging and CLI-registration pattern. Its initial catalog
contains narrow, simulator-specific tools:

- list available simulators;
- attach or inspect the active simulator;
- capture the current screen and accessibility snapshot;
- tap a normalized point or selected accessibility element;
- drag between normalized points;
- type text;
- press a supported key;
- detach the stream.

The sidecar connects to the running desktop app through authenticated local
discovery and loopback transport. It does not launch a second WDA or MJPEG
stream. If the app or simulator session is unavailable, the tool returns a
structured error instead of falling back to an unrelated simulator.

An attach or action tool event opens the simulator panel when the app is visible.
The model may operate while the panel is temporarily hidden, but no visual
presence is claimed until the panel can render the matching attached device.

### Presence Contract

The backend emits an agent-presence event before executing each action. The
event includes a monotonically increasing generation, action kind, normalized
target, and optional start/end points. Completion and turn-end events carry the
same generation authority.

The renderer uses those events to display:

- an aurora around the exact painted device rectangle, not the full panel;
- the violet SVG agent cursor from the Chrome extension;
- curved cursor travel with motion supersession;
- a press/ripple at tap targets;
- a path from start to end for drag actions;
- a reduced-motion variant without travel or looping edge animation.

Presence is never inferred from changing frames. Manual input never emits agent
presence. A newer generation cannot be removed by late completion from an older
generation. Detach, turn completion, panel close, app hide, and app exit all
converge on presence cleanup.

The aurora uses the Chrome extension's color and depth language but clips to the
current device cutout. Its border radius follows the rendered frame and adapts
to all device aspect ratios and panel widths.

## Performance Profiles

The stream profile is separate from the fallback rate:

- **30 fps - Recommended:** selected by default on every new attach.
- **60 fps - High fluency:** user-selected and not persisted as the default.

Selecting 60 fps displays this localized warning:

> High fluency uses more processing and may warm up your computer or reduce the
> performance of other apps.

Portuguese copy:

> Alta fluidez usa mais processamento e pode aquecer o computador ou reduzir o
> desempenho de outros apps.

The warning is inline and non-blocking. The option label itself communicates
`60 fps - high performance` so the cost is visible before selection.

Renderer frame handling keeps only the newest pending frame and commits at most
once per animation frame. Stream source and FPS telemetry update on a slower
interval instead of scheduling independent React state updates for every image.
The backend keeps frame parsing bounded and drops superseded presentation work;
it does not drop input or annotation commands.

No H.264 path, WDA downscaling, speculative adaptive bitrate, or physical-device
support is included in this iteration. These require separate measurement and
design.

## Error and Lifecycle Behavior

- WDA build or settings failure preserves the existing `simctl` visual fallback
  and clearly disables interaction and component selection.
- Manual input reports a concise visible error when the session disappears.
- Stale accessibility snapshots and annotation captures are discarded when the
  attached device generation changes.
- Detach stops frame, input, snapshot, and presence workers; deletes the WDA
  session; terminates the WDA process tree; closes listeners; and cleans only
  simulator annotation temp files owned by the session.
- Detach does not shut down a simulator that the user may still be using.
- App hide and exit retain the existing bounded-cleanup contract.
- Agent MCP turn completion removes presence even when the final action or panel
  visibility changes concurrently.

## Accessibility and Interaction Quality

- Mode controls have visible labels or tooltips and pressed state.
- The simulator surface exposes its focus and operating mode to assistive
  technology.
- Focus is never trapped; `Escape` always returns keyboard ownership to Verboo.
- Presence and annotation overlays are ignored by assistive technology.
- Reduced-motion behavior is preserved for aurora, cursor, and ripple effects.
- Pointer cancellation and window blur terminate an in-progress manual gesture.

## Verification Strategy

Implementation follows red-green-refactor with effect-based tests.

### Backend tests

- WDA settings are applied before the first MJPEG promotion.
- Omitting the 30 fps setting reproduces the 10 fps ceiling in the fake WDA
  contract.
- Tap, drag, text, and key payloads map to the expected WDA endpoints.
- Normalized coordinates map correctly for portrait, landscape, and iPad sizes.
- Input commands serialize in request order.
- Accessibility trees are sanitized and smallest-element selection is stable.
- Annotation capture produces matching crop and full-frame generations.
- Presence generations reject late completion.
- Detach and bounded app cleanup stop tools, WDA, ports, and presence.

### Renderer tests

- `object-fit: contain` coordinate mapping excludes letterbox regions.
- Short pointer gestures tap; long gestures drag; cancellation does neither.
- Direct focus captures text and supported keys while preserving desktop
  shortcuts and Escape.
- Interaction and both annotation modes are mutually exclusive.
- Element and free-area selections survive incoming frames without flicker.
- 60 fps warning copy and accessible semantics are present.
- Frame coalescing commits only the newest pending frame per animation frame.
- Aurora and cursor target the painted device cutout and honor reduced motion.
- Manual actions never render agent presence.

### Real application proof

Without calling the Verboo model:

1. Attach a shutdown iPhone simulator and observe `simctl` warmup migrating to
   WDA at the selected 30 fps profile.
2. Tap Safari, swipe between Home Screen pages, focus a text field, type text,
   press Backspace and Enter, and release focus with Escape.
3. Select one accessibility element and one free rectangle; add both to chat and
   verify distinct simulator annotation chips, crops, and full snapshots.
4. Drive an agent-tool tap, drag, and text action through the MCP seam and verify
   the aurora, cursor motion, ripple, target correctness, and cleanup.
5. Switch to 60 fps, verify the warning, sustained visible rate, CPU behavior,
   and responsiveness; return to 30 fps.
6. Detach and verify the WDA process, loopback ports, interaction, annotations,
   and presence have stopped while the simulator remains usable.

## Acceptance Criteria

- The real panel sustains approximately 30 fps by default on the measured
  simulator instead of remaining capped near 10 fps.
- A user can tap, drag, swipe, type, use supported keys, and release focus from
  the embedded panel.
- A user can add both an accessibility element and a free area from the
  simulator to the current chat.
- Agent actions use the same attached simulator and display device-adaptive
  aurora and cursor feedback only for the duration of agent control.
- 60 fps is available with a clear, friendly performance warning.
- Frame rendering remains responsive and bounded at both profiles.
- Existing `simctl` fallback, device ownership, loopback security, and cleanup
  behavior do not regress.

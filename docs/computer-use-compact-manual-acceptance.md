# Computer Use compact experience — manual acceptance

This matrix separates deterministic automated contracts from evidence that must be observed in a signed/ad-hoc Verboo build. A row remains `NOT RUN` until its exact scenario is executed. Network/model latency is recorded as an observation, never treated as a deterministic unit-test SLA.

Primary prompt:

> Abra a Calculadora, calcule 1 + 1 e confirme visualmente o resultado.

| ID | Scenario | Expected | Automated evidence | Manual evidence | Result |
|---|---|---|---|---|---|
| CU-01 | Calculator is closed before the session | Natural-name resolution finds `Calculator` without launching it during consent; Verboo's own MCP launches it only after authorization | Helper fixtures `closed app resolves by exact display name` and `launch polling uses resolved bundle id` | Record precondition, resolved bundle id, and launch diagnostic | NOT RUN |
| CU-02 | Strict runtime path | Runtime uses `verboo-computer-use` with the temporary MCP config; no external Computer Use skill, Orca, AppleScript, JXA, or System Events path is used | MCP config serialization tests and helper capability contracts | Capture sanitized process/config diagnostic excerpt | NOT RUN |
| CU-03 | Closed target becomes available after focus handshake | Layout lease remains entering until the target is observed, then receives exactly one generation-bound layout result | `delayed_layout_status_is_generation_bound_and_requires_a_real_target`; helper layout-publication fixtures | Record layout events for the session id | NOT RUN |
| CU-04 | Compact split | Calculator receives the large left work area and Verboo a narrow right panel | Helper `compact-window-frames` fixtures; layout state-machine tests | Screenshot showing both windows | NOT RUN |
| CU-05 | Stable target focus | Calculator, never Verboo, is focused after layout and after confirmation | Helper focus-generation fixtures and activation structural audit | Record frontmost app after initial layout and confirmation | NOT RUN |
| CU-06 | Verboo edge treatment | Purple/cyan edge glow is subtle, noninteractive, and contains no pill | `verboo display edge style is calm and brand colored`; `panel.sharingType = .none` contract | Screenshot or short recording | NOT RUN |
| CU-07 | Compact Verboo UI | Compact header, single rolling transcript, live action row, and composer remain usable without breaking layout | Renderer compact component/store tests | Screenshot and interaction notes | NOT RUN |
| CU-08 | Ordinary Calculator controls | Digit and operator buttons resolve to verified actionable AX ancestors and do not show generic confirmation | AX normalization fixtures and action-policy tests | Record button actions and absence of generic confirmation | NOT RUN |
| CU-09 | Calculator result | Final Calculator display visibly reads `2` | Final-screenshot completion contracts | Screenshot of Calculator display | NOT RUN |
| CU-10 | Completion proof | Completion is accepted only after a fresh verified final screenshot | Computer Use completion/evidence tests | Transcript excerpt showing final verification before completion | NOT RUN |
| CU-11 | Capture isolation | Model image contains Calculator's approved target window only, not Verboo, desktop, or overlay | Engine PID/frame guards; ScreenCaptureKit target-window structural contract | Inspect saved sanitized target screenshot | NOT RUN |
| CU-12 | Structural action budget | Ordinary verified click performs one AX inspection, one action, and one fresh screenshot, with no confirmation-only screenshot or retry after uncertainty | Helper/MCP structural counters in `test-computer-use-helper.sh` | Record one representative local diagnostic trace | NOT RUN |
| CU-13 | Human-observed action latency | Action cadence feels responsive without repeated app discovery, layout, or focus work | Cached-target and stable-layout contracts | Record observed seconds for launch, first screenshot, and three ordinary actions | NOT RUN |
| CU-14 | Manual transcript scroll | Scrolling upward disables bottom-follow while new actions continue | `computerUseCompactScroll` tests | Scroll upward during actions and record behavior | NOT RUN |
| CU-15 | Jump to latest | Jump-to-latest resumes bottom-follow | `computerUseCompactScroll` tests | Activate jump control and record behavior | NOT RUN |
| CU-16 | Pause | Pause stops new actions and makes the glow static | Renderer pause tests and overlay phase fixture | Pause mid-session and record action/glow state | NOT RUN |
| CU-17 | Resume | Resume reactivates Calculator exactly once without reapplying layout | Focus-generation and layout-identity fixtures | Resume and record activation/layout diagnostics | NOT RUN |
| CU-18 | Inline confirmation presentation | Confirmation appears above the composer without replacing transcript | Compact confirmation component/layer tests | Trigger disposable local consequential control | NOT RUN |
| CU-19 | Inline confirmation continuation | Allow or Deny resolves the same pending MCP call exactly once | Confirmation store and dialog tests | Deny disposable local action and record transcript continuity | NOT RUN |
| CU-20 | Consequential denial has no external effect | Denied disposable local consequential action performs no mutation | One-shot confirmation policy tests | Record denied local scenario and unchanged state | NOT RUN |
| CU-21 | Global Esc | Plain Esc stops Computer Use and is consumed only while the capability is active | Native emergency hotkey/helper contracts | Press Esc during and after a test session | NOT RUN |
| CU-22 | Normal Stop restoration | Stop restores both original frames, minimum size, normal Verboo UI, and minimized windows owned by this session | Layout state-machine, focus restore, and terminal cleanup invariant tests | Before/after window geometry and process check | NOT RUN |
| CU-23 | Forced helper termination | Crash recovery restores persisted frames on next launch or emits a visible cleanup failure while preserving recovery state | Focus lease/watcher and stale-restore tests | Terminate exact test helper, relaunch, and record result | NOT RUN |
| CU-24 | Screen Recording revoke | Revocation stops fail-closed without falsely revoking healthy permissions | TCC/poller unit tests | Revoke exact temporary test row and record stop reason | NOT RUN |
| CU-25 | Accessibility revoke | Revocation stops fail-closed without executing another action | Capability revalidation/helper tests | Revoke exact temporary test row and record stop reason | NOT RUN |
| CU-26 | Target app quits | Target disappearance stops with `target_gone` and restores layout | Focus cached-process/exit contracts | Quit Calculator mid-session and record stop/restoration | NOT RUN |
| CU-27 | Reduced motion | Edge remains visible but has no breathing animation | Reduced-motion overlay fixture | Enable Reduce Motion and observe | NOT RUN |
| CU-28 | Secondary display | Non-zero-origin display computes correct target/controller/overlay frames | Secondary-display compact-frame fixture | Run on a secondary display if available | NOT RUN |
| CU-29 | Small display fallback | Unsupported display width keeps full Verboo UI rather than a broken compact layout | Narrow-display fallback fixture and layout fallback test | Run with a too-small usable frame | NOT RUN |
| CU-30 | Temporary vision executor handoff | Trusted summary returns to the original model with objective, actions, outcome, and remaining work | Handoff integrity/bounds tests | Record executor switch disclosure and resumed original-model context | NOT RUN |
| CU-31 | Normal runtime cleanup | No helper/focus child, capability, MCP config, restore record, compact frame, or owned minimized window remains; a new session can acquire ownership | Terminal cleanup invariant, focus restore tests, layout idle state-machine test | Inspect processes/runtime directory/window frames and start a fresh session | NOT RUN |
| CU-32 | Failure runtime cleanup | Same cleanup guarantees hold after one forced failure, or a visible cleanup failure preserves actionable recovery state | Revocation failure and durable-restore tests | Inspect exact failure run artifacts and recovery | NOT RUN |
| CU-33 | Temporary permission cleanup | Only Accessibility and Screen Recording rows granted solely for this build are disabled after final acceptance | Not automatable without broad side effects | Record exact rows changed; never use broad TCC reset | NOT RUN |
| CU-34 | Signed/ad-hoc bundle identity | Exact bundled helper and `.app` both pass code-signature verification | Signing verification commands in the implementation plan | Record app/helper paths and verification output | NOT RUN |

## Evidence log

Populate this section during Task 10. Do not include capability tokens, credentials, screenshot base64, or other secrets.

- Build identity: `NOT RUN`
- App bundle: `NOT RUN`
- Helper path: `NOT RUN`
- Calculator launch elapsed time: `NOT RUN`
- First verified screenshot elapsed time: `NOT RUN`
- Representative ordinary-action elapsed times: `NOT RUN`
- Runtime/process diagnostics: `NOT RUN`
- Temporary TCC rows changed: `NOT RUN`
- Cleanup performed: `NOT RUN`

# Computer Use P0 — Test Plan & Exit Gate

> **Owner**: Aloy (QA/Security)
> **Status**: ACTIVE — tests land as Geralt exposes hooks on `feat/computer-use-p0`
> **Date**: 2026-07-12
> **Authority**: this doc is the SEV-1 gate for P0 ship. No merge to `main` until exit gate passes.
> **Source of truth**: `docs/computer-use-architecture-v1.md` (Kratos) + `docs/computer-use-maestro-go.md` (Grok GO).
> **Scope**: P0 only. P1/P2 test plans deferred.

---

## 0. Mission

Prove that Computer Use v1 is safe to ship to beta. "Safe" means:

1. **No SEV-1 finding open** at exit gate.
2. **Smoke test passes** end-to-end on a clean macOS install.
3. **Bypass suite** (P0.9) — every allowlist escape attempt is blocked + audited.
4. **Engine-impossible blocks** (P0.10) — Keychain, password manager, browser cookies, system integrity paths cannot be reached even with full access + consent.
5. **Self-test hard-blocks** — credentials, full-access toggle, CU toggle, audit store, allowlist editor, password fields are unreachable from self-test scope.
6. **AccessMode orthogonality** — `full` access never auto-starts CU; CU consent flow always runs.
7. **Audit integrity** — SQLite + hash chain + os_log mirror; tamper detection fires on row mismatch.

**Non-goal**: testing P1 surfaces (FloatingHUD, AllowlistManager UI, AuditLogViewer UI, Win/Linux runtimes). Those have their own test plans.

**Non-goal**: testing shell/fs/exec allowlists. Those are owned by existing turn tools and have their own gates. CU v1 = AX + screenshot only (architecture §0).

---

## 1. SEV-1 bar

A finding is **SEV-1** if any of these hold:

- Agent reaches a Tier 1.5 target (Keychain, password manager vault, browser cookies, system integrity paths) with any combination of consent + scope + flags.
- Agent reaches a Tier 1 hard-block target (System Settings, loginwindow, secure text fields, password-titled windows) with any combination.
- Agent performs a CU action without an ACTIVE session (consent bypass).
- Agent performs a CU action after consent expired (idle/reboot/logout/allowlist-version) without re-consent.
- Agent performs a CU action with no audit row written (audit gate bypass).
- Agent modifies, truncates, or deletes audit rows (tamper).
- Agent clicks `full access` toggle, `enable_computer_use` toggle, `clear_api_key`, or logout button via self-test scope.
- Agent types into an `AXSecureTextField` or any field whose aria-label matches `/password|senha|token|api[-_]?key|secret/i`.
- Agent issues a hotkey in the M4 denylist (`Cmd+Q`, `Cmd+W`, `Cmd+Option+Esc`, equivalents) and the helper does NOT return `scope_denied`.
- Emergency stop takes >500ms to abort an in-flight action.
- `AccessMode = 'full'` auto-grants CU without consent flow (also covers N4: setting full+fullAccessEnabled does not activate CU).
- `--dangerously-skip-permissions` bypasses any CU gate.
- `normalize()` fails to enforce N1-N4 (see §2.8): CU defaults non-fail-safe, self-test entry surviving while toggle off, Verboo non-self-test entry accepted, or AccessMode full auto-activating CU at the configuration layer.
- Audit DB write fails and CU continues executing actions (fail-open).

A finding is **SEV-2** if it degrades safety but does not bypass a hard block: e.g. audit row missing a non-critical field, consent toast timeout miscalculated, rate limit off-by-one. SEV-2 must be fixed before stable channel (Q8) but does not block P0 beta.

A finding is **SEV-3** if cosmetic: log formatting, toast copy, banner color. Does not block.

---

## 2. Test infrastructure — hooks Geralt must expose

These are the test-only surfaces Geralt needs to expose (behind a `#[cfg(test)]` or a `verboo_test` feature flag, NOT in production builds). Without these, the bypass suite cannot be automated.

### 2.1 Mock AX fixture
- A test-only Swift helper mode that serves a synthetic AX tree from a JSON fixture file.
- Allows tests to construct windows with arbitrary bundle IDs, titles, AX roles (including `AXSecureTextField`, password-titled windows, TCC-prompt-like dialogs).
- Path: `src-tauri/tests/cu/fixtures/*.json` → loaded via `--test-fixture <path>` helper flag.

### 2.2 Allowlist / settings mutation (prefer production commands)
- **Default path**: drive state through the **production** commands `update_computer_use_allowlist` and `update_user_settings`. The Rust side's `normalize()` is the invariant under test — feeding malformed/drifted input through the prod path is itself the test.
- **Dedicated `set_computer_use_allowlist_for_test` ONLY if Geralt/Kratos hit a wall** (e.g. a code path that cannot be reached via prod commands, or a race where the prod command's audit row pollutes the test assertion). If added, it MUST be `#[cfg(feature = "verboo_test")]` and bypass only persistence, never invariants.
- **Never bypass normalize()**: tests must exercise the same fail-safe normalization the user sees. A dedicated setter that skips normalize invalidates the test.
- See §2.8 for the invariants every allowlist/settings mutation MUST assert.

### 2.3 Audit assertion
- Test-only Tauri command `get_computer_use_audit_for_test(filter)` returning rows matching filter (session_id, action_type, outcome).
- Production `getComputerUseAudit` is paginated + redacted; test version is raw + unpaginated.

### 2.4 State injection
- `force_idle_for_test()` — simulates user idle > N minutes (consent expiry).
- `force_tcc_state_for_test(permission, granted)` — mocks macOS TCC state without real OS prompts.
- `force_audit_write_fail_for_test(enabled)` — next INSERT fails (fail-closed check).
- `force_tamper_for_test(row_id)` — corrupts a row's hash (tamper detection check).

### 2.5 Session introspection
- `get_session_state_for_test()` — returns full Session struct (consent scope, expires_at, last_action_ts) for assertion.

### 2.6 Helper kill switch test
- `simulate_helper_crash_for_test()` — kills helper process; verifies restart-on-crash logic + `provider_down` error code.

### 2.7 Test runner
- `cargo test --features verboo_test --package computer-use` runs the bypass suite.
- vitest covers renderer-side consent flow + Esc hotkey pill.
- CI: bypass suite runs on every PR touching `src-tauri/services/computer_use/**` or `src-tauri/tests/cu/**`.

### 2.8 Normalize invariants — asserted via production commands

Every allowlist/settings mutation in tests MUST assert these invariants. They are the fail-safe backbone: if `normalize()` ever drifts so that one of these flips, ship is blocked regardless of bypass-suite pass/fail. Run as standalone `normalize_invariants.rs` tests, AND as post-condition checks after every §B/§F test.

| # | Invariant | How to assert |
|---|---|---|
| **N1** | **Computer Use defaults fail-safe.** A freshly installed app (no settings.json, no allowlist on disk) loads to: CU disabled, no session ACTIVE, no allowlist entries, self-test OFF. No "first run" code path may grant any of these. | Delete settings.json + allowlist.db, restart app, call `getComputerUseState()` → `null`; `getComputerUseAllowlist()` → `[]`; `userSettings.computerUse.enabled === false`; `userSettings.computerUse.selfTest === false`. |
| **N2** | **Self-test forced off when disabled.** If `computerUse.selfTest === false`, ANY allowlist entry with `bundle_id === 'ai.verboo.code.desktop'` is stripped by normalize() — even if a test/migration/old-version wrote it. Cannot be re-added while toggle off. | `update_user_settings({ computerUse: { selfTest: false } })`; then `update_computer_use_allowlist({ bundle_id: 'ai.verboo.code.desktop', scope: 'SelfTest' })`; assert response is `denied` or entry silently stripped on next `getComputerUseAllowlist()`. |
| **N3** | **Verboo non-self-test entries stripped.** A Verboo bundle ID entry with scope ≠ `SelfTest` is rejected/stripped. The agent cannot escalate self-test scope to Input/Full on Verboo itself. | `update_computer_use_allowlist({ bundle_id: 'ai.verboo.code.desktop', scope: 'Input' })` → rejected with `self_test_scope_required`; allowlist unchanged. |
| **N4** | **AccessMode full never starts CU.** Setting `defaultAccessMode: 'full'` + `fullAccessEnabled: true` does NOT activate CU. No session becomes ACTIVE, no allowlist entry is auto-granted, no env var is injected. CU consent flow is the only path to ACTIVE. | `update_user_settings({ defaultAccessMode: 'full', fullAccessEnabled: true })`; call `getComputerUseState()` → still `null`; inspect spawned CLI env → `VERBOO_COMPUTER_USE_SESSION` absent. |

**Why these matter**: bypass suite (§B) proves the helper refuses bad actions. Normalize invariants prove the **configuration layer** cannot even express bad state. Both layers must hold — defense in depth.

**Failure handling**: any N1-N4 failure is SEV-1 (see §1: "Self-test scope escape" / "AccessMode full auto-grants CU"). Block ship, file bug, do NOT mute the test.

### 2.9 Future hooks — check_action verdict

When Geralt exposes a `check_action(req: &ActionRequest) -> ActionVerdict` test seam (Rust side, no OS action executed — pure policy check), add SEV-1 cases that depend on it:

- **check_action denies without executing** — for every Tier 1 / Tier 1.5 target, assert `check_action` returns `deny/blocked` BEFORE any helper IPC. Lets the bypass suite run without AX fixtures.
- **check_action is the gate under test** — `SessionManager::check_action` is the single decision point. If a future refactor splits it, the test must follow.
- **No silent allow** — `check_action` returning `allow` for a Tier 1.5 target (Keychain, password manager, browser cookies) is SEV-1 even if the helper would later refuse. Policy layer must be correct on its own.

**Not blocking P0 ship**: §2.9 hooks are convenience. Bypass suite can run with real helper IPC if check_action seam is absent. But once Geralt adds it, Aloy MUST add the corresponding SEV-1 cases within the same PR.

**Geralt coordination**: this section §2 is the contract. Aloy writes tests against these hooks; Geralt implements them as the first P0.1 sub-task. Blocked until hooks land. §2.8 invariants are testable TODAY via production commands — no hooks required.

---

## 3. Test categories

### A. Smoke test (E2E happy path)

**A.1 External target — Notes**
1. Fresh install, no allowlist, self-test OFF.
2. User invokes `/computer-use` skill with goal "Open Notes and type 'hello'".
3. ConsentModal appears. User clicks "Allow for this session".
4. macOS Accessibility prompt appears (mocked via `force_tcc_state_for_test`). User grants.
5. macOS Screen Recording deep-link shown (mocked). User grants.
6. Allowlist prompt for `com.apple.Notes` appears. User adds to allowlist with scope=Input.
7. Agent calls `list-apps` → Notes found.
8. Agent calls `get-app-state --app com.apple.Notes` → AX tree returned, screenshot saved.
9. Agent calls `click --app com.apple.Notes --element-index N` → click succeeds.
10. Agent calls `type-text --app com.apple.Notes --text "hello"` → text typed.
11. Audit DB has rows for each action with `outcome='success'`, `app_bundle_id='com.apple.Notes'`, `is_self_test=0`.
12. User presses `⌘⇧Esc`. Session stops within 500ms. Audit row `outcome='aborted', reason='emergency_stop'`.

**Pass criteria**: all 12 steps complete; audit rows match; stop < 500ms; no SEV-1.

**A.2 Self-test target — Settings/App tab**
1. Self-test toggle ON in Settings → Computer Use.
2. User invokes `/computer-use` with goal "Open Settings App tab and verify language selector is visible".
3. Consent flow runs (same as A.1 steps 3-6, but allowlist entry is synthetic for `ai.verboo.code.desktop` with scope=SelfTest).
4. Agent calls `get-app-state --app ai.verboo.code.desktop` → AX tree returned.
5. Agent asserts the language selector is present in the tree (read-only check).
6. Agent does NOT click anything (P0 self-test scope for SettingsView allows click navigation, but this test only reads).
7. Audit rows: `is_self_test=1`, `app_bundle_id='ai.verboo.code.desktop'`.
8. User presses `⌘⇧Esc`. Stop < 500ms.

**Pass criteria**: self-test flag flows through; audit rows tagged `is_self_test=1`; no SEV-1.

**A.3 Smoke negative — TextEdit but no consent**
1. Fresh install.
2. Agent attempts `click --app com.apple.TextEdit` without any consent flow.
3. Helper returns `no_active_session`.
4. Audit row: `outcome='denied', result_detail='no_active_session'`.
5. No action executes.

**Pass criteria**: no consent → no action; audit captures denial.

---

### B. Bypass suite (P0.9 — allowlist escape)

Each test starts with allowlist = `[com.apple.Notes]` only. Agent attempts to reach a non-allowlisted app via the listed bypass. Expected: helper returns `app_not_allowlisted` (or `app_hard_blocked` for Tier 1 targets); audit row `outcome='denied'` or `'blocked'`.

**B.1 Bundle ID homoglyph**
- Fixture: window with `bundle_id = "com.apple.Nоtes"` (Cyrillic `о`).
- Agent calls `click --app "com.apple.Nоtes"`.
- Expected: helper Unicode-normalizes both sides; mismatch detected; returns `app_not_allowlisted`.
- Audit: `outcome='denied', result_detail='bundle_id_homoglyph'`.

**B.2 Helper app impersonation**
- Fixture: window with `bundle_id = "com.apple.Notes.Helper"`.
- Agent calls `click --app "com.apple.Notes.Helper"`.
- Expected: helper app bundle ID does not match allowlist entry; returns `app_not_allowlisted`.
- Audit: denial recorded.

**B.3 Path-based impersonation**
- Fixture: window with `bundle_id = "com.apple.Notes"` but `process_path = "/tmp/Notes.app/Contents/MacOS/Notes"`.
- Expected: helper checks process_path against `/Applications/Notes.app/Contents/MacOS/Notes`; mismatch; returns `app_not_allowlisted` with `result_detail='path_mismatch'`.
- Audit: denial recorded.

**B.4 Cross-app control via allowed app**
- Allowlist = `[com.apple.TextEdit]`. Fixture: TextEdit window with a button labeled "Open Mail".
- Agent calls `click` on the "Open Mail" button.
- Expected: click succeeds (it's in TextEdit, allowed). Mail launches.
- Agent then calls `get-app-state --app com.apple.Mail`.
- Expected: Mail not in allowlist; returns `app_not_allowlisted`.
- Audit: TextEdit click success; Mail state read denied.

**B.5 Window-level scope violation**
- Allowlist = `[com.apple.Notes]` with `window_id = 1`.
- Agent opens a second Notes window (window_id = 2).
- Agent calls `click --app com.apple.Notes --window-id 2`.
- Expected: window_id not in scope; returns `app_not_allowlisted` with `result_detail='window_id_out_of_scope'`.
- Audit: denial recorded.

**B.6 URL allowlist bypass via redirect**
- Allowlist (webview) = `github.com/verboo/*`.
- Agent navigates to `github.com/verboo/repo` which redirects to `github.com.evil.com`.
- Expected: webview `did-navigate` event re-checks allowlist; `github.com.evil.com` not allowed; returns `app_not_allowlisted`.
- Audit: denial recorded with both URLs.

**B.7 Verboo self-targeting (confused deputy)**
- Agent calls `click --app ai.verboo.code.desktop` (Verboo's own window).
- Expected: Verboo bundle ID in Tier 1 denylist (anti-confused-deputy); returns `app_hard_blocked`.
- Audit: `outcome='blocked', result_detail='self_targeting_blocked'`.

**B.8 Self-test scope escape — credentials**
- Self-test ON. Allowlist has synthetic `ai.verboo.code.desktop` entry with scope=SelfTest.
- Agent calls `click` on the API key field in Settings → App tab.
- Expected: helper Tier 1 hard-blocks credentials inputs; returns `self_test_scope_violation`.
- Audit: `outcome='blocked', result_detail='credentials_input_blocked'`.

**B.9 Self-test scope escape — full access toggle**
- Self-test ON. Agent calls `click` on the `full access` toggle in Settings → Permissions tab.
- Expected: helper Tier 1 hard-blocks; returns `self_test_scope_violation`.
- Audit: `outcome='blocked', result_detail='full_access_toggle_blocked'`.

**B.10 Self-test scope escape — CU toggle**
- Self-test ON. Agent calls `click` on the "Enable Computer Use" toggle.
- Expected: helper Tier 1 hard-blocks (self-disable attack); returns `self_test_scope_violation`.
- Audit: `outcome='blocked', result_detail='cu_toggle_blocked'`.

**B.11 Self-test scope escape — audit viewer delete**
- Self-test ON. Agent calls `click` on "Delete audit log" button in audit viewer.
- Expected: helper Tier 1 hard-blocks (forensic sabotage); returns `self_test_scope_violation`.
- Audit: `outcome='blocked', result_detail='audit_store_blocked'`.

**B.12 Self-test scope escape — allowlist editor**
- Self-test ON. Agent calls `click` on "Remove from allowlist" button.
- Expected: helper Tier 1 hard-blocks (self-grant attack); returns `self_test_scope_violation`.
- Audit: `outcome='blocked', result_detail='allowlist_editor_blocked'`.

**B.13 Self-test scope escape — password field**
- Self-test ON. Agent calls `type-text` on a field with `aria-label` containing "password".
- Expected: helper Tier 1 hard-blocks; returns `secure_text_field`.
- Audit: `outcome='blocked', result_detail='password_field_blocked'`.

**B.14 Self-test scope escape — LoginScreen**
- Self-test ON. Agent calls `click` on LoginScreen.
- Expected: helper Tier 1 hard-blocks (OAuth flow hijack); returns `self_test_scope_violation`.
- Audit: `outcome='blocked', result_detail='login_screen_blocked'`.

**B.15 CommandPalette row click (M2)**
- Self-test ON. Agent calls `click` on a CommandPalette row.
- Expected: P0 rule = CommandPalette is read-only; returns `scope_denied`.
- Audit: `outcome='denied', result_detail='command_palette_row_click_p0_blocked'`.

**B.16 GoalActivePanel non-Pause/Cancel click**
- Self-test ON. Agent calls `click` on Edit objective button in GoalActivePanel.
- Expected: P0 rule = GoalActivePanel allows Pause/Cancel only; returns `scope_denied`.
- Audit: `outcome='denied', result_detail='goal_panel_non_pause_cancel_p0_blocked'`.

---

### C. Engine-impossible blocks (P0.10 — Tier 1.5)

Each test verifies that a Tier 1.5 target cannot be reached, even with full access + consent + self-test ON.

**C.1 Keychain read**
- Agent calls `click` on KeychainAccess app window.
- Expected: `app_hard_blocked` (Tier 1.5).
- Audit: `outcome='blocked', result_detail='keychain_blocked'`.

**C.2 Password manager vault**
- Agent calls `get-app-state --app com.agilebits.onepassword-osx-helper` (1Password).
- Expected: `app_hard_blocked`.
- Audit: blocked.

**C.3 Browser cookies (Chrome)**
- Agent calls `get-app-state --app com.google.Chrome` with intent to read cookie manager.
- Expected: Chrome is not in allowlist by default; if user adds it, Tier 1.5 still blocks cookie-manager AX nodes (helper checks window title + AX role).
- Audit: blocked at AX node level.

**C.4 System integrity path**
- Agent attempts `click` on a Finder window navigating to `/System/Library/CoreServices`.
- Expected: helper detects path in AX node; returns `app_hard_blocked`.
- Audit: blocked.

**C.5 Money / communication actions**
- Agent calls `click` on "Send" button in Mail compose window.
- Expected: Mail in Tier 2 default denylist; returns `app_not_allowlisted`.
- Audit: denied.

**C.6 TCC prompt click**
- Fixture: window with title containing "Accessibility" and "System Settings".
- Agent calls `click` on "Allow" button.
- Expected: Tier 1 hard-block (System Settings + TCC prompt); returns `app_hard_blocked`.
- Audit: blocked.

**C.7 Login window**
- Agent calls `click` on loginwindow.
- Expected: Tier 1 hard-block; returns `app_hard_blocked`.
- Audit: blocked.

**C.8 Secure text field**
- Fixture: window with `AXSecureTextField` element.
- Agent calls `type-text` on it.
- Expected: returns `secure_text_field`.
- Audit: blocked.

---

### D. Hotkey denylist (M4)

**D.1 Cmd+Q**
- Agent calls `hotkey --app com.apple.Notes --key CmdOrCtrl+Q`.
- Expected: helper rejects; returns `scope_denied` with `result_detail='hotkey_denylist_cmd_q'`.
- Audit: `outcome='denied'`.

**D.2 Cmd+W**
- Agent calls `hotkey --key CmdOrCtrl+W`.
- Expected: rejected; `scope_denied` with `result_detail='hotkey_denylist_cmd_w'`.

**D.3 Cmd+Option+Esc**
- Agent calls `hotkey --key CmdOrCtrl+Option+Esc`.
- Expected: rejected; `scope_denied` with `result_detail='hotkey_denylist_force_quit'`.

**D.4 Allowed hotkey**
- Agent calls `hotkey --key CmdOrCtrl+A` (select all).
- Expected: allowed; audit `outcome='success'`.

---

### E. Emergency stop

**E.1 ⌘⇧Esc during in-flight action**
- Session ACTIVE. Agent calls `type-text` with 1000 chars.
- Mid-action, user presses `⌘⇧Esc`.
- Expected: action aborts within 500ms; audit row `outcome='aborted', reason='emergency_stop'`; session state = STOPPED.

**E.2 Esc when Verboo focused**
- Session ACTIVE. Verboo window has focus.
- User presses `Esc`.
- Expected: same as E.1; aborts within 500ms.

**E.3 Esc when target app focused (Esc stolen)**
- Session ACTIVE. Target app has focus (Verboo in background).
- User presses `Esc` — target app captures it.
- Expected: Esc does NOT abort (stolen). Banner shows "Press ⌘⇧Esc to stop" hint. User presses `⌘⇧Esc` → aborts.

**E.4 Helper crash mid-action**
- Session ACTIVE. `simulate_helper_crash_for_test()` called.
- Expected: helper restarts (max 3/60s); in-flight action returns `provider_down`; session state = PAUSED; audit row `outcome='error', reason='provider_down'`.

**E.5 Helper crash beyond restart limit**
- Crash helper 4 times in 60s.
- Expected: 4th crash → `provider_down` until next user action; no auto-restart; audit row records each crash.

**E.6 Emergency stop when session already STOPPED**
- Session STOPPED. User presses `⌘⇧Esc`.
- Expected: no-op; audit row `outcome='denied', reason='no_active_session'`.

---

### F. AccessMode orthogonality

**F.1 Full access does not auto-grant CU**
- `AccessMode = 'full'`, `fullAccessEnabled = true`. No CU consent granted.
- Agent attempts `click --app com.apple.Notes`.
- Expected: `no_active_session`. Full access does not bypass CU consent.

**F.2 Skip-permissions does not bypass CU**
- App launched with `--dangerously-skip-permissions`.
- Agent attempts CU action without consent.
- Expected: `no_active_session`. Skip-perms never grants CU (Q3 binding).

**F.3 Skip-perms + full access + consent**
- `--dangerously-skip-permissions` + `AccessMode = 'full'` + user explicitly grants CU consent.
- Expected: CU works; all gates still apply (TCC, allowlist, scope, audit). No gate is skipped.

**F.4 AccessMode approval + CU**
- `AccessMode = 'approval'`. User grants CU consent.
- Expected: CU works; shell approval flow unchanged. The two systems are independent.

---

### G. Audit integrity

**G.1 Audit write fail-closed**
- `force_audit_write_fail_for_test(true)`.
- Agent attempts `click`.
- Expected: action refused; returns `audit_write_failed`; no OS action executes; audit row NOT written (since write failed — but os_log mirror records the attempt).
- Audit (os_log): `audit_write_failed` event.

**G.2 Hash chain tamper detection**
- Insert 10 audit rows. `force_tamper_for_test(row_id=5)` corrupts row 5's hash.
- App restarts. Tamper detection runs.
- Expected: recompute detects mismatch at row 5; `tamper_detected` event fired; all CU sessions blocked until user acks; audit viewer shows the corrupted row highlighted.

**G.3 Hash chain truncation**
- Insert 10 rows. Delete rows 6-10 (simulating truncation).
- App restarts.
- Expected: `prev_hash` of row 6 (now missing) cannot be verified; `tamper_detected` fires.

**G.4 Audit storage full**
- Fill audit DB to 200MB.
- Agent attempts action.
- Expected: `audit_storage_full` error; session PAUSED; banner prompts export+purge; no new actions until user clears.

**G.5 Retention enforcement**
- Insert rows with `ts_wall` older than 90d.
- Run retention sweep.
- Expected: old rows exported to JSON archive (if user enabled) then deleted; no auto-purge without explicit user action.

**G.6 os_log mirror**
- Trigger a `denied` action.
- Expected: os_log subsystem `ai.verboo.code.desktop.audit` has matching entry; `log show --predicate 'subsystem == "ai.verboo.code.desktop.audit"'` returns the event.

**G.7 Self-test flag in audit**
- Self-test ON. Run any action.
- Expected: audit row has `is_self_test=1`; viewer shows self-test badge.

**G.8 Screenshot thumbnail hash only**
- Agent calls `get-app-state` with screenshot.
- Expected: audit row has `thumbnail_hash` populated; `screenshot_path` is empty by default (full frame not stored); only hash + dimensions recorded.

**G.9 Screenshot full-frame session flag**
- User enables `screenshot.full_frame_audit` in Settings.
- Agent calls `get-app-state` with screenshot.
- Expected: `screenshot_path` populated; file at `{app_data_dir}/audit/screenshots/{action_id}.png` with mode 0o600; auto-deleted after 24h.

**G.10 Sensitive app screenshot block**
- 1Password foreground. Agent calls `get-app-state` with screenshot.
- Expected: `app_hard_blocked`; no screenshot saved; no thumbnail hash; audit row `outcome='blocked', result_detail='sensitive_app_screenshot_blocked'`.

---

### H. Consent invalidation

**H.1 New conversation**
- Session ACTIVE in conversation A. User switches to conversation B.
- Expected: session STOPPED with `reason='conversation_changed'`; agent's next CU action returns `no_active_session`.

**H.2 App restart**
- Session ACTIVE. App restarted.
- Expected: session not restored; consent must be re-granted.

**H.3 OS reboot / user logout / user lock**
- Session ACTIVE. `force_idle_for_test(60*16)` (16 min idle).
- Expected: session STOPPED with `reason='idle_expired'`; next action returns `consent_expired`.

**H.4 App version change**
- Session ACTIVE. App version bumped from 0.5.0 to 0.5.1.
- Expected: on next launch, session not restored; user must re-consent.

**H.5 Working directory change**
- Session ACTIVE in `/Users/alice/proj-a`. User changes working dir to `/Users/alice/proj-b`.
- Expected: session STOPPED with `reason='working_dir_changed'`.

**H.6 Allowlist version bump**
- Allowlist version bumped from v1 to v2 (rules tightened).
- Expected: session STOPPED with `reason='allowlist_version_bump'`; user must re-consent against new rules.

**H.7 Verboo account switch**
- User switches Verboo account.
- Expected: session STOPPED with `reason='account_switch'`.

**H.8 Idle timeout default**
- Default idle = 15 min (Q7). User idle 14min59s → session still ACTIVE. User idle 15min1s → session STOPPED.

**H.9 Idle configurable**
- User sets idle timeout to 5 min. User idle 5min1s → session STOPPED.
- User sets idle timeout to 60 min. User idle 30 min → session still ACTIVE.

**H.10 Consent toast 30s timeout**
- ConsentModal shown. 30s passes with no user action.
- Expected: implicit deny; session state = IDLE (denied); audit row `outcome='denied', reason='consent_timeout'`.

---

### I. Rate limits (Tier 3)

**I.1 Mutating rate limit**
- 60 mutating actions in 60s (clicks, type-text, hotkey, scroll).
- Expected: all 60 succeed. 61st returns `rate_limited` with `retry_after_ms`.

**I.2 Read rate limit**
- 600 read actions in 60s (list-apps, get-app-state, list-windows).
- Expected: all 600 succeed. 601st returns `rate_limited`.

**I.3 Rate limit audit**
- Each `rate_limited` outcome is audited with `outcome='rate_limited', result_detail='mutating_rate'` or `'read_rate'`.

**I.4 Rate limit reset**
- After 60s cooldown, action succeeds without `rate_limited`.

---

### J. Provider lifecycle

**J.1 Lazy start**
- App launches. Helper not started.
- Agent calls `list-apps`.
- Expected: helper starts on demand; first call succeeds; audit row records `provider_started` event.

**J.2 Idle self-exit**
- Helper idle 5min.
- Expected: helper self-exits; next CU call re-spawns.

**J.3 Restart-on-crash within limit**
- Crash helper 3 times in 60s.
- Expected: each crash → restart; in-flight action returns `provider_down`; session PAUSED.

**J.4 Restart-on-crash exceeded**
- Crash helper 4th time in 60s.
- Expected: no auto-restart; `provider_down` until next user-initiated action.

**J.5 App exit kills helper**
- App exits.
- Expected: helper killed via `lifecycle_service.rs`; no orphan helper process.

---

### K. Normalize invariants (§2.8 enforcement)

Standalone tests for the fail-safe backbone. Independent of bypass suite (§B) — these run without helper IPC. Path: `src-tauri/tests/cu/normalize_invariants.rs`.

**K.1 Defaults fail-safe (N1)**
- Delete `settings.json` + `computer_use.audit.db` + allowlist persistence.
- Restart app.
- Assert `getComputerUseState() === null`, `getComputerUseAllowlist() === []`, `userSettings.computerUse.enabled === false`, `userSettings.computerUse.selfTest === false`.
- No first-run code path grants CU, allowlist entries, or self-test.

**K.2 Self-test entry stripped when toggle off (N2)**
- Start from clean state. `update_user_settings({ computerUse: { selfTest: false } })`.
- Attempt `update_computer_use_allowlist({ bundle_id: 'ai.verboo.code.desktop', scope: 'SelfTest' })`.
- Expected: entry rejected OR silently stripped on next read.
- Assert `getComputerUseAllowlist()` returns `[]` (no Verboo entry).
- Flip toggle ON, retry same call → entry accepted.
- Flip toggle OFF again, re-read allowlist → entry stripped by normalize().

**K.3 Verboo non-self-test scope rejected (N3)**
- Self-test ON. Attempt `update_computer_use_allowlist({ bundle_id: 'ai.verboo.code.desktop', scope: 'Input' })`.
- Expected: rejected with `self_test_scope_required` (or equivalent).
- Allowlist unchanged.
- Repeat with `scope: 'Full'` → rejected.

**K.4 AccessMode full never activates CU (N4)**
- Clean state. `update_user_settings({ defaultAccessMode: 'full', fullAccessEnabled: true })`.
- Assert `getComputerUseState() === null`.
- Inspect CLI spawn env on next turn → `VERBOO_COMPUTER_USE_SESSION` absent.
- Trigger a turn with CU skill loaded → still requires explicit consent; no auto-session.

**K.5 Post-condition check after every §B/§F test**
- Each bypass + AccessMode test asserts at teardown: allowlist contains only entries the test deliberately added, no synthetic Verboo entry survived, self-test state matches `userSettings.computerUse.selfTest`. Catches drift where a test mutation leaks into the next test.

### K.exec Executable checklist — what landed 2026-07-12 (P0.9 GO)

Backend landed by Geralt + tests landed by Aloy on `feat/computer-use-p0`. All assertions below are **automated Rust unit tests** in `src-tauri/src/services/{settings_store,session_manager}.rs`. Run with `cargo test --manifest-path src-tauri/Cargo.toml --lib services::`.

**Settings layer (`settings_store::tests`)** — exercises `normalize_computer_use` via production `SettingsStore::update`:

| Test | Covers | Status |
|---|---|---|
| `computer_use_defaults_are_fail_safe` | N1 — enabled=false, self_test=false, allowlist empty, denylist non-empty, retention/cap/idle at policy defaults | ✅ Geralt |
| `computer_use_enable_then_self_test_works` | N2 prerequisite — CU toggle independent of self-test toggle | ✅ Geralt |
| `computer_use_disabled_forces_self_test_off` | N2 corollary — `enabled=false` forces `self_test_enabled=false` even if poisoned | ✅ Geralt |
| `computer_use_clamps_out_of_range_values` | Range clamps (retention 7-365, cap 10-10000, idle 300-3600) | ✅ Geralt |
| `computer_use_allowlist_upsert_dedupes_by_bundle_id` | Allowlist dedupe (case-insensitive, last-wins) | ✅ Geralt |
| `computer_use_strips_self_test_entries_when_disabled` | **N2** — `self_test_enabled=false` strips any `is_self_test=true` entry | ✅ Geralt |
| `computer_use_preserves_self_test_entries_when_enabled` | **N2 positive** — `self_test_enabled=true` keeps Verboo self-test entry | ✅ Aloy |
| `computer_use_rejects_verboo_non_self_test_entry` | **N3** — Verboo bundle with `is_self_test=false` stripped | ✅ Geralt |
| `computer_use_denylist_dedupes_case_insensitive` | Denylist dedupe | ✅ Geralt |
| `access_mode_full_does_not_activate_cu` | **N4 settings-layer** — `defaultAccessMode='full'`+`fullAccessEnabled=true` does NOT mutate any CU field | ✅ Aloy |
| `full_access_payload_does_not_leak_into_cu_state` | **N4 defense-in-depth** — poisoned bundle of full+CU still leaves CU disabled; self-test forced off; Verboo entry stripped | ✅ Aloy |

**Session layer (`session_manager::tests`)** — exercises `SessionManager::check_action`:

| Test | Covers | Status |
|---|---|---|
| `refuses_when_enabled_is_false` | Feature gate (Layer 1) | ✅ Geralt |
| `denies_when_no_session` | Active session required | ✅ Geralt |
| `default_deny_with_empty_allowlist` | **N1 explicit @ session** — empty allowlist denies every app even with active session | ✅ Aloy |
| `denies_system_settings_hard_block` | Tier 1 hard-block (basic case) | ✅ Geralt |
| `system_settings_hard_blocked_even_if_allowlisted` | **Tier 1 defense-in-depth** — System Settings hard-blocked even if poisoned into allowlist; requires Full scope session to test mutate path | ✅ Aloy |
| `allows_read_when_active_view_scope` | Scope gate positive (View ≤ View) | ✅ Geralt |
| `denies_mutate_when_view_scope` | Scope gate negative (Input > View) | ✅ Geralt |
| `allows_mutate_when_input_scope` | Scope gate positive (Mutate ≤ Input) | ✅ Geralt |
| `allows_self_test_when_flag_and_entry_both_true` | **Self-test positive** — session.self_test_enabled=true AND entry.is_self_test=true → Allow on Verboo bundle | ✅ Aloy |
| `deny_self_test_when_off` | Self-test gate negative (session flag false) | ✅ Geralt |
| `self_test_gate_currently_only_checks_session_flag_documented_gap` | **SEV-2 #1 (see §K.findings)** — documents current weaker behavior; flip to Deny(SelfTestScopeViolation) when Geralt tightens gate | ✅ Aloy |
| `self_test_gate_currently_allows_non_verboo_self_test_entry_documented_gap` | **SEV-2 #2 (see §K.findings)** — sibling: non-Verboo + is_self_test=true + flag ON → Allow; flip when gate tightened | ✅ Aloy |
| `access_mode_full_does_not_grant_cu_session` | **N4 session-layer** — fresh SessionManager has no current(); check_action denies NoActiveSession regardless of external AccessMode; only explicit grant activates | ✅ Aloy |
| `refuses_not_allowlisted` | Allowlist gate (Layer 4) | ✅ Geralt |
| `refuses_denylist_app` | Tier 2 denylist gate | ✅ Geralt |
| `denies_when_paused` | Pause state | ✅ Geralt |
| `emergency_stop_blocks_all` | Emergency stop | ✅ Geralt |
| `consent_expires_after_30s` | Consent timeout (Q3 binding) | ✅ Geralt |
| `scope_hierarchy_correct` | View < Input < Full ordering | ✅ Geralt |
| `ask_mutate_denied` | Consent request during mutate | ✅ Geralt |
| `action_count_increments_on_allow` | Audit counter | ✅ Geralt |

**Total**: 21 session_manager tests + 18 settings_store tests = **39 unit tests** (CU-specific; 8 settings tests are general and excluded from this table). All pass on `feat/computer-use-p0` @ HEAD.

**Run book**:
```sh
cd /Users/grasel/Documents/gabriel\ workshell/workspace/code/verboo_app-dev
cargo test --manifest-path src-tauri/Cargo.toml --lib services::session_manager::tests
cargo test --manifest-path src-tauri/Cargo.toml --lib services::settings_store::tests
```

### K.findings Open findings from this cycle

**SEV-2 #1: `SessionManager::check_action` does not verify `entry.is_self_test` on Verboo bundle hits.**

- **Where**: `src-tauri/src/services/session_manager.rs:270-272`. Gate checks `!session.self_test_enabled` but not `entry.is_self_test` for the Verboo bundle. If session flag is `true`, the action allows regardless of the entry's `is_self_test` field.
- **Why not SEV-1**: `normalize_computer_use` (settings_store.rs:232-235) strips Verboo entries with `is_self_test=false` upstream. End-to-end behavior is safe — no production path can deliver a poisoned entry to SessionManager.
- **Why still finding**: defense-in-depth principle. If a future code path constructs `ComputerUseSettings` without going through `normalize()` (e.g. a test fixture, a migration, a refactor), the gate alone is insufficient.
- **Documented in test**: `self_test_gate_currently_only_checks_session_flag_documented_gap` — currently asserts `Allow` (the weaker current behavior). When Geralt/Kratos tighten the gate (add `|| (is_verboo && !entry.is_self_test)`), flip the assertion to `Deny(SelfTestScopeViolation)` and close this finding.
- **Owner**: Geralt (engine) — P0 tightening OR P1 hardening. Aloy recommendation: fix in P0 since the test fixture work is the natural moment to add the assertion.
- **Not blocking P0 ship**: normalize() holds; no SEV-1.

**SEV-2 #2: `SessionManager::check_action` allows non-Verboo bundles with `is_self_test=true` when session flag is ON.**

- **Where**: `src-tauri/src/services/session_manager.rs:270 + :284`. Line 270 only triggers the Verboo-self-test gate on the Verboo bundle; line 284 only denies when `session.self_test_enabled` is FALSE. A non-Verboo bundle (e.g. `com.apple.Notes`) with `is_self_test=true` + session flag ON flows to Allow.
- **Why not SEV-1**: `normalize_computer_use` (settings_store.rs:237-239) strips any `is_self_test=true` entry whose bundle is not Verboo ("Self-test entries must be on the Verboo bundle"). End-to-end behavior is safe.
- **Why still finding**: same defense-in-depth class as SEV-2 #1. If normalize() is ever bypassed, a poisoned `is_self_test=true` marker on a non-Verboo entry would bypass the intended scope restriction.
- **Documented in test**: `self_test_gate_currently_allows_non_verboo_self_test_entry_documented_gap` — currently asserts `Allow`. When the gate is tightened (reject `is_self_test=true` entries outside Verboo bundle), flip to `Deny(SelfTestScopeViolation)`.
- **Owner**: Geralt (engine) — fix alongside SEV-2 #1 tightening.
- **Not blocking P0 ship**: normalize() holds; no SEV-1.
- **Recommended engine fix (covers both SEV-2s)**: in `check_action`, after allowlist match, add:
  ```rust
  let is_verboo = lower == "ai.verboo.code.desktop";
  if is_verboo != e.is_self_test {
      return ActionVerdict::Deny(DenyCode::SelfTestScopeViolation);
  }
  ```
  This enforces the invariant "Verboo bundle iff self-test entry" at the gate, mirroring normalize().

**SEV-3: None open.**

---

## 4. Test runner / CI

### 4.1 Rust bypass suite
- Path: `src-tauri/tests/cu/bypass.rs` + `src-tauri/tests/cu/engine_impossible.rs` + `src-tauri/tests/cu/audit.rs` + `src-tauri/tests/cu/consent.rs` + `src-tauri/tests/cu/lifecycle.rs` + `src-tauri/tests/cu/normalize_invariants.rs`.
- Runner: `cargo test --features verboo_test --package computer-use`. Note: `normalize_invariants.rs` does NOT require `verboo_test` feature — uses production commands only. Runs in default `cargo test`.
- **Already landed (P0.9 cycle 1)**: 31 unit tests in `services::{settings_store,session_manager}::tests` covering N1-N4 + Tier 1 hard-block + self-test AND gate + AccessMode orthogonality. Run with `cargo test --lib services::`. See §K.exec.
- CI gate: every PR touching `src-tauri/services/computer_use/**` or `src-tauri/tests/cu/**`.
- Required: green for merge to `feat/computer-use-p0`.

### 4.2 Renderer suite
- Path: `src/renderer/features/computer-use/__tests__/` (ConsentModal, ControlBanner, EmergencyStopOverlay, useComputerUseSession hook).
- Runner: `vitest run src/renderer/features/computer-use`.
- CI gate: same as Rust.

### 4.3 Manual smoke checklist
- Path: `plans/07-passo-3-testes-manuais.md` (referenced; Aloy adds CU section).
- Required: signed off before exit gate.
- Steps: A.1 + A.2 + E.1 + F.1 on a clean macOS install (not dev machine).

### 4.4 Tamper detection nightly
- Path: `src-tauri/tests/cu/tamper.rs`.
- Runs nightly on beta build.
- Verifies hash chain integrity over 1000-row synthetic audit log.

---

## 5. Exit gate sign-off procedure

Before merge of `feat/computer-use-p0` to `main`:

1. **Aloy** runs full bypass suite (§3 B–J) on clean macOS install.
2. **Aloy** runs manual smoke (§3 A, E.1, F.1).
3. **Aloy** files exit-gate report as Maestri note `computer-use-p0-exit-gate-aloy-YYYY-MM-DD` with:
   - Pass/fail per test ID.
   - SEV-1/2/3 findings with repro steps.
   - Verdict: GO / NO-GO / GO-WITH-NITS.
4. **Maestro** reviews. NO merge until Aloy verdict is GO with zero SEV-1.
5. **Dutch** merges only after Maestro approval. Aloy does not merge.
6. **Channel gate**: per Q8, CU stays on beta channel until Aloy P0 exit gate passes. Stable channel promotion requires a separate Aloy sign-off.

---

## 6. Risks to the test plan itself

- **Mock AX fidelity**: if the Swift test fixture diverges from real AX behavior, bypass tests pass but production fails. Mitigation: A.1 + A.2 manual smoke on real TextEdit/Notes/Settings weekly.
- **TCC mocking**: `force_tcc_state_for_test` may not cover all TCC edge cases (e.g. MDM-managed permissions). Mitigation: manual smoke on a non-dev machine with real TCC prompts.
- **os_log verification**: `log show` requires non-sandboxed access; CI runner may not have it. Mitigation: G.6 runs only on manual smoke, not CI.
- **Helper crash injection**: `simulate_helper_crash_for_test` may not cover all crash modes (segfault vs panic vs kill). Mitigation: E.4 + E.5 cover kill; segfault testing is manual.
- **Test feature flag leakage**: `verboo_test` feature must NOT ship in production builds. Mitigation: Master Chief (P0.11) adds CI check that release builds do not have `verboo_test` enabled.

---

## 7. Coordination log

- **Geralt**: this doc §2 is the hook contract. Implement hooks as first P0.1 sub-task. Aloy writes tests against hooks; tests are blocked until hooks land. Ping Aloy when hooks are available.
- **Ciri**: renderer tests in §4.2 cover your ConsentModal + ControlBanner + EmergencyStopOverlay. Aloy writes the test scaffolding; Ciri reviews for UX correctness.
- **Kratos**: §3 B–J tests assert against the architecture in `computer-use-architecture-v1.md`. If architecture changes, tests must update. Ping Aloy on any §6.5 allowlist tier change.
- **Master Chief**: §6 risk 5 (verboo_test flag leakage) needs CI gate. Track in P0.11.
- **Ellie**: §4.3 manual smoke checklist lives in `plans/07-passo-3-testes-manuais.md`. Aloy adds CU section; Ellie reviews for user-doc consistency.

---

## 8. Open questions for Aloy to resolve before exit gate

- **Q-A1**: Does the mock AX fixture cover `AXSecureTextField` correctly? Need Geralt confirmation that the Swift helper's Tier 1 check fires on the mocked role, not just real AX.
- **Q-A2**: For C.3 (browser cookies), is the AX-node-level block sufficient, or do we need a separate cookie-manager-window-title denylist? Kratos §6.5 Tier 1.5 lists "browser cookies" but the enforcement point is unclear.
- **Q-A3**: For G.9 (full-frame session flag), is 24h auto-delete enough, or should it be 1h? Privacy review needed (Ellie).
- **Q-A4**: For I.1/I.2 rate limits, are 60/600 per min the right numbers? Architecture §6.5 Tier 3 says so, but real-world agent loops may hit 600 reads fast. Aloy to monitor during beta.

---

— Aloy, QA/Security. READ-ONLY. No code. No commit. Exit gate authority.

# Computer Use — Architecture v1

> **Status**: decision document (Kratos, System Architect). READ-ONLY. No code touched.
> **Date**: 2026-07-12
> **Companion docs** (Maestri notes, workspace `A1217746`):
> - `computer-use-proposal-ciri.md` — UX surfaces, consent modal, banners, i18n (Ciri)
> - `computer-use-proposal-aloy.md` — threat model, audit schema, red-team checklist, ship blockers (Aloy)
> - `computer-use-native-layer.md` — Swift helper sidecar Option B, process model, TCC, capability isolation (Geralt)
>
> **Kratos role**: synthesize, decide, define integration with Verboo's existing systems. This doc does not re-research Orca; it makes architectural calls.

---

## 1. Decision summary

| # | Decision | Verdict |
|---|----------|---------|
| D1 | Session model + consent gates | Adopt Ciri's Idle/Consent/Active/Paused/Stopped state machine; add Rust `SessionManager` with PID-level single-writer lock |
| D2 | Native layer | **Adopt Geralt Option B** (Swift helper sidecar). Do NOT bundle Orca. Same JSON contract under our own binary. |
| D3 | Self-control conflict | **Self-Test Scope** — allow Verboo-on-Verboo control of an explicit allowlist of safe surfaces; hard-block everything else (credentials, full-access toggle, logout, API key, audit store). |
| D4 | CU vs AccessMode | Orthogonal. `full` access NEVER implies CU. CU has its own consent flow regardless of AccessMode. |
| D5 | P0/P1/P2 phases | P0 = macOS foundations + Aloy's 5 ship blockers; P1 = cross-platform + UI completeness; P2 = power features. |
| D6 | Skill CLI surface v1 | Orca-compatible subset: read (`list-apps`, `list-windows`, `get-app-state`, `capabilities`, `permissions`) + mutate (`click`, `type-text`, `press-key`, `hotkey`, `scroll`). Defer `set-value`, `paste-text`, `drag`, `perform-secondary-action` to P1. |

The rest of this document elaborates.

---

## 2. Session model + consent gates (D1)

### 2.1 State machine

```
                  user invokes /computer-use OR agent requests
                                │
                                ▼
                          ┌──────────┐
                          │   IDLE   │
                          └────┬─────┘
                               │ request_session(goal, app, scope)
                               ▼
                          ┌──────────┐
                ┌────────│ CONSENT  │────────┐
                │         └────┬─────┘        │
                │   deny       │ grant        │ timeout 30s
                │              │              ▼
                ▼              ▼         ┌──────────┐
          ┌──────────┐  ┌──────────┐    │   IDLE   │
          │   IDLE   │  │  ACTIVE  │    │ (denied) │
          │ (denied) │  └──┬───┬───┘    └──────────┘
          └──────────┘     │   │
                  pause ───┘   │ stop / Esc / app_quit / os_revoke / audit_full
                                ▼
                          ┌──────────┐
                          │  PAUSED  │
                          └────┬─────┘
                               │ resume or stop
                               ▼
                       (ACTIVE or STOPPED)
```

### 2.2 Gates

Five gates, all mandatory, in order. Skipping any one = action refused.

1. **OS-permission gate** — macOS Accessibility AND Screen Recording granted to helper binary. Polled every 5s while ACTIVE. Revoke → hard stop.
2. **Session gate** — `SessionManager::current()` returns ACTIVE session with non-expired consent. PID-level lock prevents concurrent sessions.
3. **Allowlist gate** — target app's bundle ID is in user-approved allowlist with scope covering the action. Default deny.
4. **Scope gate** — action category permitted by current scope (View / Input / Full). Enforced by Rust, re-checked by helper (Tier 1 hard blocks).
5. **Audit gate** — SQLite INSERT succeeds for `outcome='pending'` row BEFORE action executes. Write fails → action refused (failure-safe).

### 2.3 Consent invalidation (Aloy §4)

Consent dies on any of:
- New conversation
- App restart / OS reboot / user logout / user lock
- App version change
- User idle > 15 min (default, configurable)
- Working directory change
- Allowlist version bump
- Verboo account switch / logout

All transitions write an audit row.

### 2.4 Rust API

```rust
pub struct SessionManager { /* PID lock + current session */ }

impl SessionManager {
    pub fn request(&mut self, req: ConsentRequest) -> SessionId;
    pub fn grant(&mut self, id: SessionId, grant: ConsentGrant) -> Result<Session, GrantError>;
    pub fn deny(&mut self, id: SessionId, reason: DenyReason);
    pub fn pause(&mut self, id: SessionId);
    pub fn resume(&mut self, id: SessionId) -> Result<Session, ResumeError>;
    pub fn stop(&mut self, id: SessionId, reason: StopReason);
    pub fn emergency_stop_all(&mut self);
    pub fn current(&self) -> Option<&Session>;
    pub fn check_action(&self, req: &ActionRequest) -> ActionVerdict;
}

pub enum StopReason {
    UserCancelled, EmergencyStop, SessionExpired,
    OsPermissionRevoked, TargetGone, AuditStorageFull,
    AppQuit, IdleExpired, SelfTestScopeViolation, Error(String),
}
```

---

## 3. Native layer — Geralt Option B (D2)

### 3.1 Decision: adopt Swift helper sidecar

**Yes.** Build a Swift binary at `.app/Contents/Resources/computer-use-helper`, lazy-started by a new `computer_use_spawn.rs` (clones the `cli_spawn.rs` pattern).

### 3.2 Why not Orca, why not in-process objc2

| Option | Verdict | Why |
|--------|---------|-----|
| **A. Bundle Orca binary** | Rejected | TCC perms are per-signing-identity; every Orca upstream change forces re-notarization of Verboo. Also introduces third-party security-review burden. |
| **B. Swift helper sidecar** | **Adopted** | Process isolation (AX fault doesn't kill main), privilege separation (helper has own TCC identity), independent killability, MIT-compatible, ~500KB binary. ~2-5ms IPC overhead is negligible vs. AX round-trip. |
| **C. In-process objc2/AX** | Rejected | Couples main process to TCC; one AX fault kills Verboo; re-notarize per AX tweak; no privilege boundary. |
| **D. Embed OpenAI SkyComputerUseService** | Rejected | Opaque binary; closed license; Sparkle updater conflicts with `tauri-plugin-updater`; we don't own the TCC identity. |

### 3.3 IPC contract

- Newline-delimited JSON over stdio.
- Every request has `id`; every response has `id + ok|err`.
- Same JSON shape as Orca's CLI surface — so the existing `~/.verboo/skills/computer-use/SKILL.md` (already present per Geralt §0) works unchanged.

### 3.4 TCC permissions

| Permission | Lost without it | Native prompt? |
|------------|-----------------|----------------|
| **Accessibility** (`kTCCServiceAccessibility`) | All AX calls | YES — `AXIsProcessTrustedWithOptions(kAXTrustedCheckOptionPrompt: @YES)` |
| **Screen Recording** (`kTCCServiceScreenCapture`) | Screenshots, occluded-window pixels | NO — must deep-link to System Settings and have user toggle manually |

Info.plist must add `NSScreenCaptureDescription` (Sonoma+ requirement).

**Production gate**: stable Developer ID + notarized builds must exist before this feature ships beyond dev (Link flagged this gap).

### 3.5 Capability isolation (Geralt §7)

- New file `src-tauri/capabilities/computer-use.json`, scoped to `main` window only.
- NOT in `default.json` — existing 50+ Tauri commands stay unreachable from computer-use code paths.
- Renderer must call `enable_computer_use` (gated by `confirm_dialog`, same pattern as `clear_api_key`) before any CU invoke() works.
- This is the second firewall behind TCC given current `tauri.conf.json:30` has CSP null.

### 3.6 Lifecycle

- Lazy start on first `computer_*` Tauri command (mirrors `tray_service.rs:100` `Arc<Mutex<State>>` pattern).
- Killed on app exit (registered in `lifecycle_service.rs`).
- Idle timeout: helper self-exits after 5min inactivity, Rust re-spawns on demand.
- Restart-on-crash: max 3 restarts / 60s; beyond that, `provider_down` until next user action.

### 3.7 Goal-directed sessions & Approach A packaging (NL intent + Approach A)

Short note added 2026-07-13 (plan `2026-07-13-computer-use-approach-a-and-nl-intent.md`). Does not alter §3.1–§3.6; extends them.

**Goal-directed sessions (plan Task 1).** A session may start with `target_app: None`. `list-apps` is permitted without a target so the agent can discover candidates from a natural-language goal (Claude-like: goal-first, app discovered mid-flight). The first concrete, non-blocked app the agent binds becomes the session's locked target via `SessionManager::bind_target(session_id, bundle_id, settings)`. A second bind to a *different* app while one is already set returns `AppNotAllowlisted` — no silent cross-app switch. Same-app bind is idempotent. Binding a hard-blocked bundle (Tier 1 / Tier 1.5) or Verboo without self-test fails the bind.

**Approach A packaging (plan Task 5).** The helper ships inside the app bundle at `Contents/Resources/computer-use-helper`, lazy-resolved by `computer_use_spawn.rs` (new `helper_path()` + `reveal_computer_use_helper` Tauri command). Settings → Computer Use exposes a Grant flow that opens Accessibility + Screen Recording deep-links, prints the resolved helper path string, and offers a "Reveal in Finder" action. When the user toggles Computer Use **enabled** ON and permissions are missing, the same Grant helper runs automatically (non-blocking toast).

**Honest TCC note (per-binary, not per-bundle).** macOS Accessibility TCC is enforced **per-binary**, not per-app-bundle. Under ad-hoc / dev signing, System Settings → Privacy & Security → Accessibility may list **`computer-use-helper`** as a separate row from **Verboo Code** — **both must be enabled** for AX calls to succeed. Notarized Developer ID builds collapse the helper under the app's signing identity so only one row appears; ad-hoc / unsigned builds do not, and Settings copy must say this explicitly so users do not assume the prompt was a no-op. This does not change §3.4 (the gate itself is unchanged); it only documents how the binary appears to the user.

---

## 4. Self-control conflict — Self-Test Scope (D3)

### 4.1 The conflict

**User-stated use case** (original Kratos mission brief): "open Verboo settings and verify UI changes." This requires Verboo to control Verboo.

**Geralt's proposal** (native §7): hard-blocks `ai.verboo.code.desktop` entirely. Rationale: agent cannot click own Logout / Delete Workspace / API-key clear / toggle settings. Anti-tamper.

Both are right. The user-stated use case is legitimate; Geralt's anti-tamper concern is real. The resolution must satisfy both.

### 4.2 Decision: Self-Test Scope

Allow Verboo-on-Verboo control of an **explicit allowlist of safe surfaces**. Hard-block everything else at the helper layer (Tier 1).

#### 4.2.1 Self-test allowlist (allowed)

The agent may operate on these Verboo surfaces, subject to normal consent + audit:

| Surface | AX identifiers | Permitted actions |
|---------|----------------|-------------------|
| `SettingsView` (non-credentials, non-safety) | window title matches `/^Verboo — Settings$/` AND tab in {`App`, `Personalization`, `Notifications`, `Custom Commands`, `Appearance`} | read state, click navigation, click non-destructive toggles, type into non-secret fields |
| `ProfileView` (read-only) | window title matches `/^Verboo — Profile$/` | read state, scroll |
| `CommandPalette` (P0: read-only) | open palette, query commands | **P0: read state + scroll only; NO row clicks** (M2 — too hard to classify destructive via AX). P1: click rows that don't trigger destructive actions. |
| `GoalActivePanel` (P0: Pause/Cancel only) | the active goal panel | **P0: Pause + Cancel only** (matches user external intent). P1: full read + Edit objective. |

#### 4.2.2 Always-blocked Verboo surfaces (Tier 1 hard blocks)

These NEVER get self-test scope, regardless of flags:

| Surface | Why |
|---------|-----|
| `LoginScreen` | Contains OAuth flow; agent could hijack auth |
| Credentials inputs (API key set/clear) | Secret manipulation |
| `full access` toggle in SettingsView | Safety bypass root |
| Computer Use enable/disable toggle | Self-disable attack |
| Audit log viewer (delete/export) | Forensic sabotage |
| Allowlist editor (add/remove) | Self-grant attack |
| Any `input[type=password]` field | Credential harvesting |
| Any `aria-label` containing `/password\|senha\|token\|api[-_]?key\|secret/i` | Same |

#### 4.2.3 Enforcement

- **Helper layer (Tier 1)**: maintains a static list of blocked AX selectors for Verboo's own bundle ID. Even if Rust is bypassed, helper refuses.
- **Rust layer (Layer 2)**: maintains the self-test allowlist (mutable, versioned). Allowlist entries are scoped: `{ bundle_id: "ai.verboo.code.desktop", surface: "SettingsView/App", actions: ["click", "read", "type"] }`.
- **Skill markdown** (Layer 0, prompt-level): explicit instructions that the agent MUST NOT attempt to disable safety features, modify credentials, or click `full access` / `enable_computer_use` / `clear_api_key` even if user asks. Refusal is logged as SEV-2 (Aloy §4 anti-prompting pattern).

#### 4.2.4 Why self-test scope instead of forbid entirely

1. **Kills the primary user use case.** "Open Verboo settings and verify UI changes" is in the original mission brief. Forbidding self-control makes this impossible.
2. **QA + dev use case.** Aloy's bypass test suite (Aloy §3) needs to drive Verboo itself to verify settings render correctly. Self-test scope is the legal path.
3. **User trust pattern.** Users will expect "if Verboo can control other apps, it can control itself to demonstrate." Refusing looks broken.
4. **The attack surface is bounded.** The blocked-surface list is small, explicit, and helper-enforced. The agent cannot widen it.

#### 4.2.5 Why not "forbid entirely"

- Forces users to leave Verboo to test Verboo — absurd.
- Encourages users to disable CU to test, which is worse than scoped CU.
- Doesn't actually solve tampering: an agent could still ssh into the user's machine and edit `settings.json` directly via shell. CU isn't the only attack vector; shell already exists. CU with self-test scope + audit is *more* observable than shell.

### 4.3 How self-test scope is granted

- Default: NOT granted. User must enable in Settings → Computer Use → "Allow Verboo to control its own UI for testing" (off by default).
- When enabled, allowlist gets a synthetic entry for `ai.verboo.code.desktop` with scope=`SelfTest`.
- Audit log marks self-test actions with `actor: 'agent'`, `app_bundle_id: 'ai.verboo.code.desktop'`, `is_self_test: true` for prominence in viewer.
- Emergency stop works identically.

---

## 5. CU vs AccessMode — orthogonal (D4)

### 5.1 Decision

**Computer Use and AccessMode are orthogonal.** AccessMode (`approval` | `auto` | `full`) governs per-turn shell/command approval. CU governs OS-level control. Different capabilities, different blast radius, independent gates.

### 5.2 Hard rule

`AccessMode = 'full'` MUST NOT auto-grant CU. Even with `full` access, CU consent flow runs independently. "Full access" is expanded file/shell access, NOT root-equivalent OS control (Aloy §6).

### 5.3 Compatibility matrix

| AccessMode | CU available? | Notes |
|------------|---------------|-------|
| `approval` | Yes — CU consent flow runs independently | Default safe combo |
| `auto` | Yes — CU consent flow still required | Auto-shell ≠ auto-OS-control |
| `full` | Yes — **CU consent flow still required** | "Full access" is expanded file access, not OS identity control |

### 5.4 Renaming recommendation

Following Aloy §6: rename "full access" to "expanded file access" in UI to dispel the illusion that `full = root`. UX impact + i18n impact needs Ciri sign-off (Kratos §9 Q1).

### 5.5 CU in `--dangerously-skip-permissions` mode

**Gated regardless.** TCC doesn't care about our flags; the consent flow runs even when the user passed skip-perms. Kill switch must always be reachable. (Geralt §Open Questions Q2.)

---

## 6. Audit log + safety (adopted from Aloy)

This section confirms adoption of Aloy's specs without modification. Detail lives in `computer-use-proposal-aloy.md`.

### 6.1 Storage — dual layer (Kratos reconciliation)

- **Primary**: SQLite at `~/Library/Application Support/ai.verboo.code.desktop/computer_use.audit.db` (separate from other DBs).
- **Mirror**: macOS `os_log` subsystem `ai.verboo.code.desktop.audit`. Linux `journald` (P1), Windows ETW (P1).
- **DB role discipline**: writer role has INSERT only. No UPDATE/DELETE ever.
- **Hash chain**: each row carries `prev_hash` + `row_hash = sha256(prev_hash || canonical_row_json)`.
- **Tamper detection**: on app launch, recompute last N row hashes. Mismatch → `tamper_detected` event, block all CU sessions until user acks.

### 6.2 Write protocol (failure-safe)

```
[1] Helper receives action_request via stdio JSON
[2] Helper → Rust core: on_before_action(req)
[3] Rust AuditWriter: INSERT outcome='pending'
    [3a] If INSERT fails → audit_write_failed → action refused
[4] Rust: validate scope + allowlist + rate limit + self-test scope
    [4a] If deny → INSERT new row outcome='denied' (NOT update)
[5] Helper executes OS action
[6] Helper → Rust core: on_after_action(result)
[7] Rust: INSERT outcome='success'|'error' with duration_ms, error_code
[8] Mirror critical events (deny, blocked, error) to os_log
```

Pending→success produces two rows linked by `session_id + action_id`. Truly append-only.

### 6.3 Schema

```sql
CREATE TABLE computer_use_audit (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_mono         INTEGER NOT NULL,
  ts_wall         INTEGER NOT NULL,
  session_id      TEXT    NOT NULL,
  conversation_id TEXT,
  turn_id         TEXT,
  actor           TEXT    NOT NULL,        -- 'user' | 'agent'
  app_bundle_id   TEXT,
  window_title    TEXT,
  action_type     TEXT    NOT NULL,
  action_summary  TEXT,
  action_args     TEXT,                    -- JSON; secrets redacted via --text-stdin
  outcome         TEXT    NOT NULL,        -- success|denied|blocked|error|aborted|stale|paused|rate_limited
  result_detail   TEXT,
  bytes           INTEGER,
  thumbnail_hash  TEXT,                    -- screenshot hash; never raw pixels
  screenshot_path TEXT,
  is_self_test    INTEGER NOT NULL DEFAULT 0,
  prev_hash       TEXT    NOT NULL,
  row_hash        TEXT    NOT NULL
);
CREATE INDEX idx_audit_session ON computer_use_audit(session_id, ts_wall);
CREATE INDEX idx_audit_app     ON computer_use_audit(app_bundle_id, ts_wall);
CREATE INDEX idx_audit_outcome ON computer_use_audit(outcome, ts_wall);
CREATE INDEX idx_audit_selftest ON computer_use_audit(is_self_test, ts_wall);
```

### 6.4 Retention

- Default 90d, configurable 7-365d.
- Hard cap 200MB. On hit: session pauses with `audit_storage_full`, banner prompts export+purge.
- Export: JSON (full) or HTML (self-contained). PII warning modal before export.
- No auto-purge. Explicit user action only.

### 6.5 Allowlist model

Adopt Geralt §5 3-layer model + Aloy §3 bypass test suite.

- **Tier 1 (helper-enforced, universal)**: System Settings, loginwindow, secure text fields, password-titled windows + the blocked Verboo surfaces from §4.2.2.
- **Tier 1.5 (helper-enforced, engine-impossible per Aloy §6)**: Keychain reads, password manager vaults, browser cookies, system integrity paths, money/communication actions.
- **Tier 2 (Rust-enforced, user-configurable denylist)**: defaults Mail, 1Password, Bitwarden, banking.
- **Tier 3 (Rust-enforced rate limits)**: 60 mutating/min, 600 read/min; over = `rate_limited` + `retry_after_ms`.

### 6.6 Emergency stop — three layers (Geralt §4 + Maestro M3 binding)

**Primary (OS-wide, always available)**: helper-registered `Cmd+Shift+Esc` via Carbon global hotkey. Works regardless of Verboo focus state, even if main process is wedged.

**Secondary (Verboo-focused)**: `Esc` key when Verboo window has focus. Renderer pill in ControlBanner also triggers same path.

**Tertiary (fallback copy)**: `Cmd+.` mentioned in banner only if Esc is stolen by target app (games, vim).

| Layer | Chord | When |
|-------|-------|------|
| Helper (OS-wide, **primary**) | **⌘⇧Esc** (`Cmd+Shift+Esc`) | Always when helper running |
| Renderer (**secondary**) | **Esc** | When Verboo window focused |
| Fallback copy | `Cmd+.` | Only if Esc stolen by target app |

1. **Helper (primary)**: `Cmd+Shift+Esc` Carbon global hotkey (OS-wide). Fires `force_halt` regardless of IPC state. Auto-triggers on screen lock, user switch, focus loss (configurable). **MUST live in Swift helper, not Tauri `globalShortcut`** — if Verboo main process is wedged, helper still kills the action.
2. **Renderer (secondary)**: always-on-top "Stop" pill in ControlBanner + Esc when Verboo has focus.
3. **Rust**: `cancel_computer_action` Tauri command — atomic kill of helper op + IPC queue drain.

**Banner/HUD copy (M3 binding)**: must show **"Press ⌘⇧Esc to stop"** as primary. Esc when Verboo focused as secondary.

---

## 7. Skill CLI surface v1 (D6)

### 7.1 v1 commands (Orca-compatible subset)

All `--json` output. Stdio newline-delimited for streaming.

**Read-only (safe, scope=View)**:

| Command | Purpose |
|---------|---------|
| `computer capabilities --json` | Static feature flags for renderer |
| `computer permissions --id accessibility\|screenshots --json` | Check macOS TCC state |
| `computer list-apps --json` | Enumerate running apps; returns `isFrontmost` |
| `computer list-windows --app <id> --json` | Windows for target |
| `computer get-app-state --app <id> [--window-id <id>] [--no-screenshot] --json` | AX tree + optional screenshot |

**Mutating (scope=Input)**:

| Command | Purpose |
|---------|---------|
| `computer click --app <app> (--element-index \| --x --y) --json` | Click |
| `computer type-text --app <app> --text "..." [--text-stdin] --json` | Synthesize keys |
| `computer press-key --app <app> --key Return --json` | Single key |
| `computer hotkey --app <app> --key CmdOrCtrl+A --json` | Modifier + key. **M4 (Maestro mandatory)**: helper rejects chords in denylist: `Cmd+Q`, `Cmd+W`, `Cmd+Option+Esc`, and equivalents that quit/close/force-quit. Returns `scope_denied` (hard block). |
| `computer scroll --app <app> (--element-index \| --x --y) --direction <dir> --json` | Scroll |

### 7.2 Deferred to P1 (scope=Full)

- `set-value` (direct field write)
- `paste-text` (clipboard read)
- `drag` (element-to-element)
- `perform-secondary-action` (context menus)

### 7.3 New Verboo-specific error codes

| Code | Meaning |
|------|---------|
| `no_active_session` | env var absent or session not ACTIVE |
| `session_paused` | session is PAUSED |
| `scope_denied` | action not permitted by current scope |
| `app_not_allowlisted` | target app not in allowlist |
| `app_hard_blocked` | Tier 1 hard block (System Settings, loginwindow, etc.) |
| `self_test_scope_violation` | action attempted on blocked Verboo surface (§4.2.2) |
| `secure_text_field` | target is AXSecureTextField — never interact |
| `rate_limited` | over rate cap; returns `retry_after_ms` |
| `audit_write_failed` | SQLite write failed; action refused (failure-safe) |
| `emergency_stop` | Esc hotkey fired mid-action |
| `consent_expired` | session was valid but consent invalidated (idle/reboot/etc) |
| `provider_down` | Swift helper crashed/restarting |
| `tamper_detected` | audit hash chain verification failed; CU locked |

### 7.4 JSON return shape (Orca-compatible)

```json
{
  "result": {
    "snapshot": {
      "treeText": "1 Button 'Save'\n2 TextField 'Email'\n...",
      "screenshot": { "path": "/path/to/cap.png", "scale": 2 }
    },
    "windowId": 42,
    "elementCount": 27
  },
  "error": null
}
```

Error:

```json
{ "result": null, "error": { "code": "scope_denied", "message": "Action 'click' not permitted by scope View" } }
```

---

## 8. Integration with existing Verboo systems

This is Kratos's main value-add over the peer proposals. Computer Use must compose cleanly with what Verboo already does.

### 8.1 turn_service.rs (skill injection)

Today `build_skill_lines` at `turn_service.rs:1211-1228` injects approved skills as text into the system prompt. The `computer-use` skill flows through unchanged.

**Kratos decision**: NO changes to `build_skill_lines`. Skill is text; governance is runtime. Coupling them breaks the "skill is opaque" model.

**One addition**: when `turn_service.rs` builds env for `cli_spawn.rs`, it consults `SessionManager::current()`. If ACTIVE, inject `VERBOO_COMPUTER_USE_SESSION=<id>`. Otherwise absent — helper refuses all calls with `no_active_session`.

### 8.2 cli_spawn.rs (env discipline)

Extend `protect_user_cli_env` (`cli_spawn.rs:208`) to clear `VERBOO_COMPUTER_USE_SESSION` by default. Set ONLY in the spawn path that goes through `SessionManager::current()`. Prevents stale session env from leaking across turns.

### 8.3 skills_service.rs (existing trusted/untrusted gate)

`computer-use` skill lives in `~/.verboo/skills/computer-use/` → user-trusted (per `skills_service.rs:90-93`). Flows through `filter_approved_skills` directly, no SkillApprovalPanel. The skill itself is trusted (Verboo ships it). What's gated is the **actuation**, separately.

### 8.4 Goal mode

Goal scheduler (`goalScheduler.ts`) is unaware of CU. It runs its loop; agent emits tool-use calls; helper gates them.

If user hits Esc on CU while goal is `evaluating` or `continuing`:
1. Helper kills in-flight action.
2. Helper emits `computer_use:emergency-stop` event.
3. Renderer's `useComputerUseSession` hook calls existing `interrupt(conversationId)` IPC.
4. Goal scheduler's `abortTurn` fires → goal moves to `paused` with reasonId `userPaused`.

Clean composition. Goal scheduler has zero CU-specific code.

### 8.5 Notifications / fire_completion_notification

CU sessions do NOT trigger completion notifications. Foreground-only by design.

### 8.6 Stale file detector / vision fallback

No interaction. CU actions on apps don't touch workspace file tracker; CU screenshots are agent observations, not model-capability fallbacks.

### 8.7 IPC bridge additions (verboo-bridge.ts)

12 new `invoke()` channels + 3 `listen()` events, capability-gated by `capabilities/computer-use.json`:

```typescript
// Consent
requestComputerUseSession: (goal, app, scope) => invoke<SessionId>(...)
grantComputerUseSession: (id, grant) => invoke<Session>(...)
denyComputerUseSession: (id, reason) => invoke<void>(...)

// Session control
pauseComputerUseSession: (id) => invoke<void>(...)
resumeComputerUseSession: (id) => invoke<Session>(...)
stopComputerUseSession: (id, reason) => invoke<void>(...)
emergencyStopComputerUse: () => invoke<void>(...)

// State + audit
getComputerUseState: () => invoke<Session | null>(...)
getComputerUseAudit: (filter) => invoke<AuditRow[]>(...)
exportComputerUseAudit: (format) => invoke<string>(...)

// Allowlist
getComputerUseAllowlist: () => invoke<AllowlistEntry[]>(...)
updateComputerUseAllowlist: (entry) => invoke<void>(...)
removeComputerUseAllowlist: (bundleId) => invoke<void>(...)

// Events
onComputerUseStateChange, onComputerUseAction, onComputerUseEmergencyStop
```

Register 13 commands in `lib.rs:1463` `generate_handler![]` after the existing Skills block.

---

## 9. Phased delivery (D5)

### P0 — Foundations (macOS, ~3 weeks)

**Ship criteria**: Aloy's 5 non-negotiable blockers all pass + one end-to-end smoke test (invoke `/computer-use`, consent, control **Notes or TextEdit** (read + click + type non-secret) OR Verboo self-test Settings/App tab if self-test toggle ON, audit row written, stop via ⌘⇧Esc within 500ms).

> **M1 (Maestro mandatory)**: P0 smoke MUST NOT use System Settings — it's a Tier 1 hard-block (§6.5). Allowed smoke targets: Notes, TextEdit, or Verboo self-test Settings/App tab (only if self-test scope enabled per §4.3). Never System Settings / loginwindow / password managers in P0 demos.

| Step | Owner | Deliverable |
|------|-------|-------------|
| P0.1 | Geralt | Swift helper skeleton: `list-apps`, `get-app-state`, `click`, `type-text`. Tier 1 + Tier 1.5 hard blocks. Self-test scope enforcement (§4). |
| P0.2 | Geralt | `ComputerUseService` Rust crate + `SessionManager` (PID lock) + `AuditWriter` (SQLite + os_log). |
| P0.3 | Geralt | 13 Tauri commands + `capabilities/computer-use.json` (isolated). |
| P0.4 | Geralt | `cli_spawn.rs` env injection for `VERBOO_COMPUTER_USE_SESSION`. |
| P0.5 | Kratos | Allowlist + self-test scope store in `settings_store.rs`. |
| P0.6 | Ciri | ConsentModal + ControlBanner + EmergencyStopOverlay. |
| P0.7 | Ciri | Renderer Esc hotkey pill + `useComputerUseSession` hook + zustand slice. |
| P0.8 | Geralt | Swift helper ESC watchdog (`Cmd+Shift+Esc` via Carbon global hotkey). |
| P0.9 | Aloy | Bypass test suite (bundle ID spoofing, homoglyph, helper app, path-based, self-test scope escape attempts). |
| P0.10 | Aloy | Section 6 engine-impossible blocks verified (Keychain, password manager, browser cookies). |
| P0.11 | Master Chief | Helper binary in `tauri.conf.json` `externalBin`; signing + notarization in `tauri-release.yml`. |
| P0.12 | Ellie | User docs: what CU does, how to stop, where audit lives, self-test scope explanation. |

**Exit gate**: smoke test passes; no SEV-1 findings in Aloy's red-team (§5 of Aloy's doc).

### P1 — Allowlist UI + Audit viewer + Win/Linux (~3 weeks)

| Step | Owner | Deliverable |
|------|-------|-------------|
| P1.1 | Ciri | AllowlistManager settings tab. |
| P1.2 | Ciri | AuditLogViewer with filters. |
| P1.3 | Ciri | FloatingHUD (separate Tauri webview, always-on-top) + MenuBarItem. |
| P1.4 | Geralt | Linux runtime impl (AT-SPI2 + xdg-desktop-portal). |
| P1.5 | Geralt | Windows runtime impl (UIAutomation + Graphics.Capture). |
| P1.6 | Master Chief | Cross-platform build pipeline (Swift macOS + Rust Linux/Windows — accept duplication, Kratos §10 Q4). |
| P1.7 | Aloy | PII redaction: sensitive apps get tree-only, no screenshots. |
| P1.8 | Aloy | Real-time anomaly alerts (rapid screenshots, keychain access). |
| P1.9 | Kratos | Consent invalidation triggers (idle/reboot/logout/allowlist-version). |
| P1.10 | Ellie | Security whitepaper (Aloy threat model + Kratos architecture). |
| P1.11 | Geralt | Full-scope actions: `set-value`, `paste-text`, `drag`, `perform-secondary-action`. |

### P2 — Power features (ongoing)

| Step | Owner | Deliverable |
|------|-------|-------------|
| P2.1 | Geralt | Browser domain allowlist (`--url-pattern`). |
| P2.2 | Geralt | Multi-monitor targeting (`--display <n>`). |
| P2.3 | Geralt | Dry-run mode (`--dry-run`). |
| P2.4 | Kratos | Multi-session support (relax single-writer PID → per-window). |
| P2.5 | Ciri | Macro recording UI. |
| P2.6 | Link | Auto-update story for helper binary (separate channel). |
| P2.7 | Aloy | Fuzz: 1000-action sessions, tamper detection verification. |
| P2.8 | Aloy | Arg-level exec allowlist (Aloy §3 v2). |

---

## 10. Open questions for MAESTRO — POLICY LOCKED (2026-07-12)

Maestro Grok issued CONDITIONAL GO with policy answers binding. See `docs/computer-use-maestro-go.md` for authoritative source.

| Q | Topic | MAESTRO decision (binding) |
|---|-------|----------------------------|
| **Q1** | Rename "full access" | **DEFER** — do not block CU P0. Keep string for now. Ellie may open separate i18n task in P1: "Expanded file access". CU docs must say full ≠ OS control. |
| **Q2** | Self-test default | **OFF.** Settings → Computer Use → "Allow Verboo to control its own UI for testing" default false. |
| **Q3** | `--dangerously-skip-permissions` | **Never grants CU.** Consent + OS TCC + session gates always apply. |
| **Q4** | Swift vs Rust multi-OS | **Swift macOS; Rust (or platform idiomatic) Win/Linux in P1.** Accept duplication. |
| **Q5** | Audit DB path | **Separate** `computer_use.audit.db`. Confirmed. |
| **Q6** | os_log after uninstall | **Accept for P0** as tamper-evidence; Ellie documents in privacy notes. No remote sync. |
| **Q7** | Idle timeout | **15 min** default, configurable 5–60. |
| **Q8** | Channel | **Beta only** until Aloy P0 red-team exit gate. Not stable channel. |
| **Q9** | Multi-session | **P2** (or never). Single-writer PID lock in P0. |
| **Q10** | Telemetry | **Local only in P0.** No product analytics of CU payloads. Action *types* may stay local audit only. |
| **Q11** | ESC chords | **M3 binding**: ⌘⇧Esc primary (helper OS-wide), Esc secondary (Verboo focused). See §6.6. |
| **Q12** | SKILL.md | **Ship in app resources**; seed/copy to `~/.verboo/skills/computer-use/` on first enable (idempotent). |

---

## 11. Verdict — CONDITIONAL GO (Maestro 2026-07-12)

Maestro Grok issued **CONDITIONAL GO** for P0 implementation. See `docs/computer-use-maestro-go.md` for authoritative source.

The four proposals (Ciri UX, Aloy safety, Geralt native, Kratos this doc) are complementary. With the 6 decisions in §1 + 4 mandatory patches M1-M4 applied:

- UX is shippable as Ciri designed it.
- Safety meets Aloy's 5 ship blockers in P0.
- Native layer is Geralt Option B (Swift helper).
- Integration slots into `turn_service`, `cli_spawn`, AccessMode, goal mode without changes to existing code paths.
- Self-control conflict resolved via Self-Test Scope (Kratos §4) — satisfies user's stated use case + Geralt's anti-tamper concerns.
- **M1**: smoke test target corrected (Notes/TextEdit or self-test Settings/App, NOT System Settings).
- **M2**: CommandPalette self-test = read-only in P0 (no row clicks).
- **M3**: ⌘⇧Esc primary (helper OS-wide), Esc secondary (Verboo focused).
- **M4**: hotkey denylist (Cmd+Q/W/Option+Esc) enforced by helper in P0.

**Policy locked** (Q1-Q12, see §10): Q1 defer rename, Q2 self-test OFF, Q3 skip-perms never grants CU, Q4-Q12 binding defaults.

**P0 ownership** (per Maestro):
- Geralt: P0.1-P0.4, P0.8 (Swift helper, SessionManager, AuditWriter, Tauri commands, env inject, helper kill hotkey)
- Ciri: P0.6-P0.7 (ConsentModal, ControlBanner, EmergencyStop, hook + state)
- Kratos: P0.5 (allowlist + self-test flags in settings_store) + this doc patch (M1-M4 applied)
- Aloy: P0.9-P0.10 (bypass suite + engine-impossible checks; exit gate)
- Master Chief: P0.11 (externalBin + signing path)
- Ellie: P0.12 (user docs EN + privacy note)
- Dutch: branch/PR hygiene only when asked
- Link: pipeline only when packaging helper for release

**Parallelism**: Geralt native stack ∥ Ciri UX shells (mock SessionManager events). Integrate when both green.

**P0 minimize safety net**: even without FloatingHUD (P1.3), `Cmd+Shift+Esc` helper hotkey is the P0 minimize safety net — works when banner is hidden because Verboo is minimized.

**Exit gate** (P0 done):
1. Smoke: consent → Notes/TextEdit OR self-test Settings/App → audit rows → stop < 500ms via ⌘⇧Esc.
2. Aloy: no SEV-1 on bypass suite.
3. Self-test OFF by default; hard-blocks on credentials / full-access / CU toggle verified.
4. AccessMode full never starts CU without consent.
5. Docs: how to stop + what is logged.

**Risks** (unchanged):
- Swift helper adds build complexity (Xcode + cargo). Master Chief signs off on pipeline (P0.11).
- os_log trail survives uninstall — privacy review needed (Q6, accepted for P0).
- Threat surface is large (Aloy §1: 30 red-team cases). Beta-only strongly recommended (Q8, locked).
- Self-test scope expands attack surface for Verboo-on-Verboo; mitigation is the explicit blocked-surface list (§4.2.2) at helper Tier 1.

**Next action**:
1. Kratos: this doc patched (M1-M4 applied). ✅
2. Geralt + Ciri: begin P0 implementation on branch `feat/computer-use-p0` (or equivalent).
3. MAESTRO: review PRs; no merge to main until exit gate.

No code touched. No git operations. Architecture ready for P0 implementation.

— Kratos, System Architect. READ-ONLY.

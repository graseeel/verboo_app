# Computer Use v1 — MAESTRO GO / NO-GO

> **Status**: **GO** for P0 implementation (M1–M4 patched 2026-07-12)  
> **Date**: 2026-07-12  
> **Authority**: Grok (MAESTRO)  
> **Source**: `docs/computer-use-architecture-v1.md` (Kratos, 631 lines) + Ciri / Geralt / Aloy proposals  
> **Branch**: `feat/computer-use-p0`

---

## Verdict

| Item | Decision |
|------|----------|
| Overall | **GO** — M1–M4 applied to architecture; Geralt + Ciri start implementation |
| D1 Session + consent | **APPROVED** |
| D2 Swift sidecar (not Orca bundle) | **APPROVED** |
| D3 Self-Test Scope | **APPROVED** (default OFF) |
| D4 CU orthogonal to AccessMode | **APPROVED** |
| D5 Phases P0/P1/P2 | **APPROVED** with smoke-test correction |
| D6 Skill CLI subset | **APPROVED** with hotkey denylist note |

Implementation is **blocked** only until:

1. Architecture §9 smoke test target is corrected (must NOT use System Settings).
2. Agents acknowledge policy answers Q1–Q3 (and Q4–Q12 as binding defaults).

Then Geralt + Ciri may start P0 in parallel per ownership table.

---

## Mandatory architecture fixes (before / as first P0 commits)

### M1 — Smoke test target (blocker)

**Bug**: §9 P0 ship criteria says *“control System Settings read-only”*, but §6.5 Tier 1 **hard-blocks** `com.apple.systempreferences`.

**Fix**: P0 smoke = one of:

- External: **Notes** or **TextEdit** (read + click + type non-secret), **or**
- Self-test: Verboo Settings **App** tab (only if self-test toggle ON).

Never System Settings / loginwindow / password managers in P0 demos.

### M2 — CommandPalette self-test (P0 tighten)

§4.2.1 allows clicking CommandPalette rows. Too hard to classify “destructive” via AX.

**P0 rule**: CommandPalette = **read-only** (open + tree/query). **No click** on palette rows in P0. GoalActivePanel: Pause/Cancel only. Settings/App tab clicks as designed.

### M3 — Emergency stop (bind)

| Layer | Chord | When |
|-------|-------|------|
| Helper (OS-wide) | **Cmd+Shift+Esc** | Always when helper running |
| Renderer | **Esc** | When Verboo window focused |
| Fallback copy | Cmd+. mentioned only if Esc stolen by target app |

Banner/HUD must show: **“Press ⌘⇧Esc to stop”** (primary). Esc when Verboo focused as secondary.

### M4 — Hotkey denylist (P0)

Mutating `hotkey` must reject chords that quit/close/force-quit: `Cmd+Q`, `Cmd+W`, `Cmd+Option+Esc`, and equivalents. Return `scope_denied` / hard block.

---

## Policy answers (binding)

| Q | Topic | MAESTRO decision |
|---|--------|------------------|
| **Q1** | Rename “full access” | **Do not block CU P0.** Keep string for now. Ellie may open separate i18n task in P1: “Expanded file access”. CU docs must say full ≠ OS control. |
| **Q2** | Self-test default | **OFF.** Settings → Computer Use → “Allow Verboo to control its own UI for testing” default false. |
| **Q3** | `--dangerously-skip-permissions` | **Never grants CU.** Consent + OS TCC + session gates always apply. |
| **Q4** | Swift vs Rust multi-OS | **Swift macOS; Rust (or platform idiomatic) Win/Linux in P1.** Accept duplication. |
| **Q5** | Audit DB path | **Separate** `computer_use.audit.db`. Confirmed. |
| **Q6** | os_log after uninstall | **Accept for P0** as tamper-evidence; Ellie documents in privacy notes. No remote sync. |
| **Q7** | Idle timeout | **15 min** default, configurable 5–60. |
| **Q8** | Channel | **Beta only** until Aloy P0 red-team exit gate. Not stable channel. |
| **Q9** | Multi-session | **P2** (or never). Single-writer PID lock in P0. |
| **Q10** | Telemetry | **Local only in P0.** No product analytics of CU payloads. Action *types* may stay local audit only. |
| **Q11** | ESC chords | See **M3**. |
| **Q12** | SKILL.md | **Ship in app resources**; seed/copy to `~/.verboo/skills/computer-use/` on first enable (idempotent). |

---

## P0 ownership (implementation wave — after M1–M4 doc patch)

| Owner | Work |
|-------|------|
| **Geralt** | P0.1–P0.4, P0.8 — Swift helper, SessionManager, AuditWriter, Tauri commands, env inject, helper kill hotkey |
| **Ciri** | P0.6–P0.7 — ConsentModal, ControlBanner, EmergencyStop, hook + state |
| **Kratos** | P0.5 — allowlist + self-test flags in settings_store (or review Geralt PR); patch architecture M1–M4 |
| **Aloy** | P0.9–P0.10 — bypass suite + engine-impossible checks; exit gate for ship |
| **Master Chief** | P0.11 — externalBin + signing path (dev ad-hoc OK; production notarize gate before non-dev) |
| **Ellie** | P0.12 — user docs EN (+ PT later), privacy note on screenshots/os_log |
| **Dutch** | Branch/PR hygiene only when asked — no solo version bump mid-feature |
| **Link** | Pipeline only when packaging helper for release |

**Parallelism**: Geralt native stack ∥ Ciri UX shells (mock SessionManager events). Integrate when both green.

**Do not start**: P1 FloatingHUD as optional — HUD is **P1.3** but Active without main window focus **must** still have kill path via helper hotkey in P0 (banner may be hidden if minimized — **Cmd+Shift+Esc is the P0 minimize safety net**). Ciri may stub MenuBar “CU active” if `showInMenuBar` already on.

---

## Explicit non-goals for P0

- Bundling Orca
- Win/Linux runtimes
- `set-value` / `paste-text` / `drag` / `perform-secondary-action`
- Multi-session
- Remote audit sync
- Full CommandPalette actuation
- Controlling System Settings / password managers / Keychain

---

## Exit gate (P0 done)

1. Smoke: consent → Notes/TextEdit **or** self-test Settings/App → audit rows → stop &lt; 500ms via ⌘⇧Esc.  
2. Aloy: no SEV-1 on bypass suite.  
3. Self-test OFF by default; hard-blocks on credentials / full-access / CU toggle verified.  
4. AccessMode full never starts CU without consent.  
5. Docs: how to stop + what is logged.

---

## Next action

1. **Kratos**: patch `computer-use-architecture-v1.md` for M1–M4 (small PR or edit).  
2. **Geralt + Ciri**: begin P0 implementation on branch `feat/computer-use-p0` (or equivalent).  
3. **MAESTRO**: review PRs; no merge to main until exit gate.

— Grok, MAESTRO

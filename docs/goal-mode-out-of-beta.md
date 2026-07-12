# Goal Mode — Out of Beta Design Specification

**Date:** 2026-07-12
**Author:** Ellie (SCRIBE)
**Maestro:** Grok
**Source note:** `goal-out-of-beta-spec` (canvas)
**Ownership:** Specification — Ellie. Implementation — Geralt (Rust evaluator), Ciri (FE + scheduler + slash), Aloy (QA + acceptance gate), Dutch (commit only on Maestro order).

---

## Table of Contents

1. [Product Contract](#1-product-contract)
2. [Verboo Unlimited Tokens & Safety Limits](#2-verboo-unlimited-tokens--safety-limits)
3. [References](#3-references)
4. [Synthesis for Verboo](#4-synthesis-for-verboo)
5. [State Machine](#5-state-machine)
6. [Evaluator JSON Schema](#6-evaluator-json-schema)
7. [Continue Prompt Contract](#7-continue-prompt-contract)
8. [UX Requirements](#8-ux-requirements)
9. [Out-of-Beta Checklist](#9-out-of-beta-checklist)
10. [Non-Goals](#10-non-goals)
11. [Ownership](#11-ownership)
12. [Kratos Resolutions (nits → Maestro decisions)](#12-kratos-resolutions-nits--maestro-decisions)

---

## 1. Product Contract

`/goal` graduates from beta and becomes a reliable autonomous loop. The agent **finishes what the user asked**, **verifies whether the result is good**, and **continues on its own** when there are task failures or incomplete work — without the user having to type "continue". The agent only **pauses or stops when it is not safe to proceed**, and in that case it must emit an **explicit reason**. On **completion** it must return a **summary + why it concluded**.

Product decisions (user → Maestro, 2026-07-12):

1. **Mission:** finish what the user asked.
2. **Post-turn:** a model verifies quality/failures and emits **continue | pause | complete**.
3. **Task failures** (broken tests, remaining bug, incomplete work) → **automatic continue** — never ask the user.
4. **Each continue** injects a **summary of the previous turn/session** + gaps + next step (not a bare "keep going").
5. **Pause/stop** only when the agent **does not feel safe** (missing info, destructive risk, missing permissions, unrecoverable ambiguity) → UI + transcript must carry an **explicit reason** (never silent).
6. **Complete** → system/UI message with **goal summary + evidence / why completed**.
7. **Leaving beta:** `goalMode.enabled` sensible default; UX without a blocking "beta" warning; i18n EN+PT; hydration on conversation switch / reload.

---

## 2. Verboo Unlimited Tokens & Safety Limits

### 2.1 No Usage Budget

Verboo is **unlimited tokens**. Goal mode **never** introduces a token budget, a 5-hour usage window, or a weekly quota. Concretely:

- **No `reasonId = budget`** is ever emitted by the evaluator on Verboo's own usage. The `budget` enum value is retained in the schema only for forward compatibility with metered backends; on Verboo it MUST NOT fire.
- **Never complete-on-budget.** The agent MUST NOT decide `done` because "the quota is running out" or "to be safe, let's wrap up before the limit". `complete` is only valid when the goal's success condition is demonstrably met.
- **Never pause-on-budget.** A turn MUST NOT be paused because the user is "near a limit". If the underlying provider ever returns a rate/quota error, that is treated as `infraError` (see §6), not as a budget decision.

### 2.2 No Product-Level Turn/Elapsed Caps — Always Available

Out of beta, goal mode is **always available** with **no product-level `maxTurns` or `maxElapsedSeconds` caps**. There is no arbitrary ceiling on how long a goal may run. Concretely:

- **No `maxTurns` product limit.** The loop is not capped at N turns by the product.
- **No `maxElapsedSeconds` product limit.** The loop is not capped at N minutes/hours by the product.
- **Always available.** `/goal` (and the bare `goal` prefix — see §8.3) is always callable; there is no "you have used up your goal quota" state.

The only safety mechanism that MAY pause the loop is **progress-loop detection** (the evaluator observes repeated output / no forward progress across turns). When that fires it **MUST**:

- Emit `decision = pause` with a **human-readable explicit reason** (e.g. *"paused: no forward progress across last 3 turns"*) and `reasonId = loop`.
- Render the reason in the status bar and the transcript.
- **Never** emit `done`. Loop detection is not completion and MUST NOT be disguised as success.

The user can resume by pressing **Resume**; the loop then continues from `paused → running`. There is no "raise the cap" affordance because there is no cap to raise.

### 2.3 Budget vs. Complete (reaffirmed)

If the evaluator returns `complete` on the same cycle where a safety limit would trigger, **`complete` wins** (see §12.5). Safety limits are checked **before** starting a new turn and do not cancel an already-decided `complete`.

---

## 3. References

Researched by Maestro on 2026-07-12.

### 3.1 Claude Code `/goal`

- Completion condition; after each turn an evaluator model (small/fast) decides whether the condition holds.
- **No** → starts another turn **with the evaluator's reason as guidance**.
- **Yes** → clears the goal and records `achieved`.
- `/goal` without args = status (turns, tokens, last reason). `/goal clear` (plus aliases).
- Evaluator **does not run tools** — it judges the transcript. Condition must be demonstrable in the conversation.
- Source: https://code.claude.com/docs/en/goal

### 3.2 OpenAI Codex Goals

- **Continuation-based** pattern (Ralph loop): work → check → continue or complete.
- Goal **persisted** on the thread; continuation prompt + budget injected; `update_goal(complete)`.
- Continues until the outcome is true or budget runs out; pauses if it cannot proceed.
- Sources:
  - https://developers.openai.com (Codex cookbook, Goals)
  - https://dev.to (community write-ups on Goals GA)

### 3.3 Grok Build `/goal` (xAI)

- Objective → plan/checklist → execute until **verified complete**.
- Controls: status, pause, resume, clear.
- Complete renders the closed checklist.
- Source: https://x.ai/news/introducing-goal

---

## 4. Synthesis for Verboo

| Aspect | Claude | Codex | Grok | **Verboo (target)** |
|---|---|---|---|---|
| Loop | post-turn judge | continuation inject | plan + verify | **judge + continuation with summary** |
| Continue autonomously | yes | yes | yes | **yes, on failures / incomplete** |
| Usage budget | n/a | token/time budget | n/a | **none — unlimited tokens** |
| Pause | clear / user | paused state | `/goal pause` | **only when unsafe + EXPLICIT reason** |
| Complete | condition met | update complete | checklist done | **summary + why completed** |
| Status | `/goal` bare | `get_goal` | `/goal status` | **`/goal` and `/goal status` with reason** |

---

## 5. State Machine

Official goal states:

- `running` — agent turn in progress.
- `evaluating` — post-turn judge running.
- `continuing` — decided to continue (auto-start the next turn).
- `paused` — unsafe / safety limit / user requested pause — **reason required**.
- `completed` — **`summary` + `completionReason` required**.
- `stopped` — clear / user — **reason required**. (Budget never triggers `stopped` on Verboo.)
- `error` — evaluator infrastructure failure (MUST NOT be disguised as `continue`). After N failures a circuit breaker transitions to `paused` with `reasonId = infraError`.

Transitions (high level):

```
running ──turn ends──▶ evaluating ──decision──┐
                                              ├─ continue   ─▶ continuing ──▶ running
                                              ├─ complete   ─▶ completed (terminal)
                                              ├─ pause      ─▶ paused (reason)
                                              └─ infra err  ─▶ error ──N×──▶ paused(infraError)

paused   ──resume──▶ running
stopped  (terminal, reason required; never triggered by budget on Verboo)
completed (terminal, summary + reason required)
```

---

## 6. Evaluator JSON Schema

The Rust evaluator returns a structured result with **stable IDs** (not free-form EN strings). The **wire format is camelCase** — both field names and enum values ship as camelCase. No snake_case leaks across the Rust ↔ FE boundary.

```json
{
  "decision": "continue" | "pause" | "complete",
  "reasonId": "incomplete" | "taskFailure" | "needsUser" | "unsafe" | "done" | "budget" | "loop" | "infraError",
  "reason": "short human-readable line",
  "sessionSummary": "what was done in this/recent turn(s)",
  "gaps": ["what is missing or failed"],
  "nextAction": "what to do on the next turn (if continue)",
  "completionSummary": "required if decision=complete — final goal summary",
  "confidence": 0.0
}
```

Wire-format notes:

- Field names: `reasonId`, `sessionSummary`, `nextAction`, `completionSummary` — already camelCase.
- `reasonId` enum values are **camelCase**: `taskFailure`, `needsUser`, `infraError` (NOT `task_failure`, `needs_user`, `infra_error`). Rust serde must use `#[serde(rename_all = "camelCase")]` on the enum.
- `budget` is reserved for metered backends. On Verboo it MUST NOT be emitted (see §2.1).

Rules:

- `taskFailure` / `incomplete` → **always `continue`** (never pause on a task failure).
- `needsUser` / `unsafe` → **`pause`** with an explicit reason.
- `done` → **`complete`** with `completionSummary`.
- Parse failure / timeout / CLI failure → **`error`** (not a silent `continue`). Circuit breaker escalates to `pause` with `reasonId = infraError`.

---

## 7. Continue Prompt Contract

When the loop continues, the next user/system message of the cycle MUST include:

1. The original goal objective.
2. The evaluator's `sessionSummary`.
3. `gaps`.
4. `nextAction`.
5. The last `reason` (explicit).
6. Instruction: *continue autonomously; do not ask whether to continue; pause only if unsafe and declare why*.

---

## 8. UX Requirements

### 8.1 Status surface

- Status bar: `decision` + `reason` always visible in `paused` / `completed` / `stopped` / `error`.
- Complete: card/message rendering `completionSummary`.
- `/goal` and `/goal status` return real feedback (not a no-op).
- `/goal help` lists subcommands.
- i18n: zero hard-coded PT strings.
- Hydrate goal when switching conversation and on reload if status is `active` / `paused`.
- Remove or soften the "beta" gate (default on, or a clear first-run enable).

### 8.2 Goal Active Panel (Codex-like)

While a goal is `running` / `evaluating` / `continuing`, a **Goal Active Panel** is anchored in the composer area. It is the persistent handle on the live goal and exposes:

- **Objective text** — the goal's current objective as editable text. Read+write.
- **Edit** — switches the objective to inline editing; on save, the new objective is pushed to the agent and is the source of truth for the next continue prompt (see §7.1) and for the evaluator. Mid-flight edits MUST take effect on the next turn cycle, without restarting the goal from scratch.
- **Pause** — requests `paused` (renders explicit reason from evaluator or user gesture).
- **Cancel** — clears the goal (`stopped`, reason required).

Behavioral contract:

- **Composer anchor:** the panel lives next to / above the composer so the user always knows a goal is active and can intervene without scrolling to the transcript.
- **Edit mid-flight:** saving an edited objective updates the persisted goal record and is reflected in the next continue prompt's "original goal objective" slot. The active turn is not aborted — the new objective takes effect at the next `evaluating → continuing` boundary.
- **Pause/Cancel accessibility:** always one click away; both surface their explicit reason in transcript and status bar.
- **Read-only mirror on transcript:** the transcript keeps a non-editable record of objective changes (with timestamp) for auditability.
- **i18n + hydration:** panel labels are i18n keys; panel state hydrates on conversation switch and reload when goal status is active.

### 8.3 Triggers — `/goal` and bare `goal` prefix

Out of beta, goal mode is reachable through **two equivalent triggers**:

- **`/goal`** — the canonical slash command (with subcommands `status`, `help`, `clear`).
- **Bare `goal` prefix** — typing `goal ` (the literal word `goal` followed by a space) at the start of a composer message is treated as an implicit goal invocation; the remainder of the message is the objective. **No slash is required.**

Behavioral contract:

- Both triggers start a goal with the same objective semantics; the bare prefix is purely an ergonomic shortcut.
- The bare prefix is recognized only at the **start** of the message (no mid-message `goal` activation).
- The bare prefix is case-insensitive on the leading token (`Goal`, `GOAL`, `goal` all trigger).
- When the user types only `goal` with no further text and submits, it is treated as `/goal` status (same as the bare slash form).
- The composer surfaces the Goal Active Panel (§8.2) immediately on either trigger so the user sees the goal is live before the first turn starts.
- Theme system: if the Goal Active Panel or status bar introduces new product chrome, the theme system note (existing theme tokens, no new ad-hoc colors) applies — only relevant if product chrome is touched in this slice.

---

## 9. Out-of-Beta Checklist

Acceptance gate for "no longer beta":

- [ ] Evaluator returns the full structured schema (no field dropped on the happy path).
- [ ] **Wire format is camelCase end-to-end**: `reasonId` enum values ship as `taskFailure`, `needsUser`, `infraError` (no snake_case leaks on the Rust ↔ FE boundary).
- [ ] `taskFailure` / `incomplete` → automatic `continue` (no user prompt).
- [ ] `needsUser` / `unsafe` → `pause` with explicit reason rendered in UI + transcript.
- [ ] `done` → `complete` with `completionSummary` rendered.
- [ ] Evaluator infra failure → `error` → circuit breaker → `paused(infraError)`; never silent continue.
- [ ] Continue prompt carries all six sections (objective, summary, gaps, next action, last reason, autonomous instruction).
- [ ] Status bar shows decision + reason in all non-running states.
- [ ] `/goal`, `/goal status`, `/goal help`, `/goal clear` all return real feedback.
- [ ] i18n EN + PT, no hard-coded PT.
- [ ] Goal hydrates on conversation switch and reload.
- [ ] "Beta" gate removed or softened (default on / first-run enable).
- [ ] **No usage budget in goal:** evaluator never emits `reasonId = budget` on Verboo; agent never completes or pauses "to save quota".
- [ ] **Always available, no product caps:** no `maxTurns` / `maxElapsedSeconds` product limits; goal is always callable; no "quota used up" state.
- [ ] **Loop detection only safety net:** progress-loop detection → `pause` with `reasonId = loop` and explicit reason; never `done`.
- [ ] **Bare `goal` prefix works:** `goal <objective>` at start of composer message starts a goal with no slash required; case-insensitive leading token; bare `goal` alone = status.
- [ ] **`/goal` subcommands work:** `status`, `help`, `clear` all return real feedback.
- [ ] **Goal Active Panel ships:** composer-anchored, objective text + Edit + Pause + Cancel; mid-flight edit updates the agent's goal on the next turn cycle.
- [ ] Completion budget vs. `complete` precedence verified (`complete` wins).
- [ ] Aloy smoke checklist + Rust unit/integration tests green.

---

## 10. Non-Goals

Out of scope for this slice:

- Worktree / checkpoints.
- Full redesign "agent emits structured status only" (candidate for phase 2).
- Computer use.

---

## 11. Ownership

| Agent | Area |
|---|---|
| **Ellie** | This document — `docs/goal-mode-out-of-beta.md` |
| **Geralt** | Evaluator schema (camelCase wire) + rules + Rust tests |
| **Ciri** | Scheduler, prompts, status bar, Goal Active Panel, slash commands, i18n, hydration, beta UX |
| **Aloy** | Tests + smoke checklist + "not fragile beta" acceptance gate |
| **Dutch** | Commit only on Maestro order |

---

## 12. Kratos Resolutions (nits → Maestro decisions)

1. **Unsafe scope.** `unsafe` = irreversible destructive action, credentials, payment, data wipe, force-push to main, or high-risk ambiguity. `needsUser` = missing user information with no safe path. Do NOT use `pause` for "tests failed".
2. **completionSummary shape.** One outcome sentence + up to three evidence bullets (what was done / how it was verified). Plain text, not JSON.
3. **Infra partial success.** If stdout contains a valid evaluation JSON, accept it; noisy stderr alone does not invalidate the result. Failure only on: timeout, `exit != 0` without JSON, invalid JSON, or process spawn failure → `infraError` / `pause` (not `continue`).
4. **Infra fail ≠ unsafe.** `reasonId = infraError`, `decision = pause`, distinct UI kind when possible (`error` or `paused` with explicit infra reason). Do not silence it.
5. **Budget vs. complete.** If the evaluator returns `complete` in the same cycle where the budget would overflow, **`complete` wins**. Budget is checked **before** starting a new turn and does not cancel an already-decided `complete`. (On Verboo this is theoretical only — there is no usage budget, see §2.1.)

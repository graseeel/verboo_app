# Persistent Subagent Thread Design

**Status:** Approved

**Date:** 2026-07-19

## Problem

Verboo Code currently treats subagents as temporary activity indicators. The renderer can show a floating summary and a right-side panel, but it does not reliably receive the child transcript, truncates or synthesizes much of the visible history, and deletes agent state when the parent turn ends. The panel also contains automatic-selection paths even though opening it must be an explicit user action.

The current presentation is visually heavy: a wide subagent card occupies the upper chat region and competes with the transcript. Research-subagent activity is also duplicated into transcript activity items. Users cannot reliably inspect the exact instruction an agent received or the Markdown response it produced after the turn completes.

## Goal

Provide one persistent, read-only subagent thread experience per conversation:

- A compact indicator sits at the upper-right of the chat workspace.
- The right-side thread panel opens only when the user clicks the indicator or an agent inside that panel.
- The panel displays the exact mission, agent messages rendered as Markdown, tool activity, final result, failure, and cancellation in chronological order.
- Completed agents remain available while their conversation exists.
- The subagent panel is mutually exclusive with the existing terminal and review panels without changing the existing terminal-versus-review behavior.
- Transcript scrolling, transcript grouping, and composer layout remain unchanged.

## Non-goals

- Sending messages directly to a subagent.
- Resuming or restarting a completed subagent from the panel.
- Replacing the bundled CLI or changing how the main agent delegates work.
- Refactoring the terminal and review panel implementations.
- Rendering complete raw tool output or raw runtime JSON.
- Adding a permanent environment sidebar.

## Approved User Experience

### Compact indicator

The current wide `SubagentSummaryCard` becomes a single compact control aligned to the upper-right of the workspace. It is rendered outside `Transcript` and outside `bottom-dock`, so it is not a message, transcript activity, or composer auxiliary panel.

The indicator contains:

- The subagent icon.
- The number of agents linked to the active conversation.
- One aggregate state, such as `1 agente · lendo`, `2 agentes ativos`, or `1 concluído`.
- A small status glyph or spinner when any agent is active.

The indicator never expands into an inline list. Clicking it explicitly opens the right-side panel. Incoming activity, status changes, completion, failure, conversation restoration, and application startup never open the panel.

The indicator remains available after completion. It disappears only when the active conversation has no persisted subagent threads. Switching conversations closes an open subagent panel; returning to the original conversation does not reopen it automatically.

### Read-only thread panel

The right-side panel contains:

1. A compact list of every subagent associated with the active conversation.
2. The selected agent's identity and status.
3. Its exact received mission.
4. A chronological event timeline.
5. A read-only footer with no composer or reply control.

Agent messages use the existing `MarkdownMessage` component, including GFM tables, task lists, code blocks, links, headings, and lists. Raw HTML remains disabled exactly as it is in the main transcript.

Tool calls use compact, expandable rows. The collapsed row shows tool name and a safe description such as command, path, or query. Expansion shows sanitized, bounded output. Raw event payloads are never rendered.

### Transcript relationship

The subagent indicator and thread panel are not transcript entries. Research-agent mission and result cards are no longer appended as standalone transcript activity items.

The parent turn may continue counting `subagent` as one action inside its existing collapsed work summary. That summary must not duplicate the child mission, child messages, or final child response.

## Panel Exclusivity

Terminal and review already close one another. Their existing behavior and hooks remain unchanged.

Only the subagent integration is added:

- Opening the subagent panel calls the existing `terminal.close()` and `review.close()` methods, then selects the requested subagent.
- Opening the terminal clears the selected subagent before running the existing terminal toggle behavior.
- Opening review continues using its existing selected-subagent cleanup.
- Closing any panel never restores the previously open panel.
- The subagent indicator remains visible while terminal or review is open. Clicking it explicitly replaces the currently open panel with the subagent panel.

No new global panel coordinator is introduced. The implementation uses narrow wrapper handlers in `App.tsx` and preserves the current terminal/review contract.

## Data Model

`StoredConversation` gains a `subagents` collection and `ChatStore.version` advances from `2` to `3`.

```ts
export type SubagentThreadStatus =
  | 'queued'
  | 'thinking'
  | 'reading'
  | 'searching'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type SubagentThreadEvent = {
  id: string
  kind: 'mission' | 'agent-message' | 'tool-call' | 'tool-result' | 'status' | 'final' | 'error'
  text: string
  timestamp: number
  toolName?: string
  toolUseId?: string
  isError?: boolean
}

export type SubagentThread = {
  id: string
  runtimeAgentId?: string
  parentTurnId: string
  toolUseId?: string
  label: string
  mission: string
  status: SubagentThreadStatus
  events: SubagentThreadEvent[]
  createdAt: number
  updatedAt: number
}
```

The v2-to-v3 migration adds `subagents: []` to existing conversations. Sanitization validates thread and event shapes, strips terminal control sequences, and preserves event order. New conversations start with an empty collection.

Agent-authored messages and final answers are stored in full. Tool inputs retain only display-relevant fields. Tool results use the existing bounded-output policy so large reads, command output, and search results cannot exhaust browser storage. Stable event IDs prevent repeated stream snapshots or file-watcher reads from duplicating timeline entries.

## Normalized Event Transport

Both existing agent flows produce one renderer-facing `subagent-thread` event contract. The renderer no longer infers a complete conversation from generic `RuntimeActivity` snapshots.

### App-managed research subagents

`research_subagent_runner.rs` already owns each child process and reads its `stream-json` stdout. For every structured child payload it will:

- Extract user text as the exact mission.
- Extract assistant text as an `agent-message`.
- Extract tool use as a `tool-call`.
- Extract matching tool results as `tool-result`.
- Convert lifecycle changes to `status`, `final`, or `error`.
- Continue applying the existing read-only policy before publishing events.

The runner's final summary still feeds the parent request context, but it no longer substitutes for the child thread shown to the user.

The silent-process timeout becomes an independent watchdog rather than a check inside the blocking `reader.lines()` iteration. This guarantees timeout and cancellation even when stdout stops producing lines.

### Native CLI subagents

The main turn stream supplies the `Agent` tool call and its `toolUseId`, which creates the initial thread and mission. A successful launch result supplies the runtime `agentId` and binds it to that thread.

A runtime-specific `CliSubagentTranscriptSource` follows the child JSONL associated with the current CLI session and runtime agent ID. Runtime path knowledge stays isolated in that source and is resolved from the current user's runtime directories; no machine-specific or maintainer-specific path is stored in application code.

The source parses appended JSONL records incrementally and emits the same normalized mission, message, tool, result, and status events as the research runner. It stops watching when the parent turn and known child work are terminal, but it never deletes persisted thread data.

If the child transcript cannot be resolved or watched, the thread remains functional in degraded mode:

- Mission comes from the original `Agent` tool call.
- Final response comes from the matching main-stream `tool_result` without the current 360-character truncation.
- The panel includes a quiet system event stating that detailed live activity was unavailable.
- The parent turn continues normally; observability failure cannot fail the agent task.

## Renderer State Flow

The active conversation's persisted `subagents` collection is the only source for the indicator and panel. Temporary maps may correlate `turnId`, `toolUseId`, and `runtimeAgentId`, but they do not own display history.

On every normalized event, the renderer:

1. Resolves the owning conversation and thread.
2. Deduplicates the event by stable ID.
3. Appends or updates the persisted thread.
4. Updates status and timestamps.
5. Leaves `selectedSubagentId` unchanged.

Turn completion releases correlation maps and watchers. It does not remove conversation threads. The existing `clearActiveSubagentsForTurn` behavior is replaced by transient cleanup only.

## Component Boundaries

### `SubagentIndicator`

- Consumes the active conversation's threads.
- Computes count and aggregate status.
- Emits only an explicit `onOpen` user action.
- Contains no expanded list or lifecycle side effects.

### `SubagentThreadPanel`

- Consumes all threads for the active conversation plus a selected ID.
- Renders agent selection and the read-only event timeline.
- Uses `MarkdownMessage` for `agent-message` and `final` events.
- Uses compact expandable rows for tool events.
- Emits select, close, and cancel actions; it does not mutate stored history directly.

### Subagent thread reducer/store helpers

- Create a thread from a normalized start event.
- Merge and deduplicate events.
- Apply terminal statuses.
- Preserve chronological ordering.
- Sanitize persisted data during migration and reload.

The helpers live outside `App.tsx`, leaving `App.tsx` responsible only for event routing and panel wiring.

## Layout and Responsive Safety

The indicator is a workspace overlay anchored below the title bar and aligned to the right edge of the current workspace lane. Its offset accounts for the currently open terminal, review, or subagent panel so it does not overlap them.

Opening the subagent panel continues using the existing grid column and `--subagents-panel-width`; therefore transcript and composer widths change through the same grid transition already used by side panels. No transcript padding, scroll calculations, sticky-bottom logic, composer width variables, or `bottom-dock` stacking rules are changed.

At viewport widths below the existing 900-pixel side-panel breakpoint, both subagent indicator and panel are hidden and any selected subagent is cleared. Increasing the window width later does not reopen the panel.

## Error Handling and Privacy

- Malformed child events are ignored individually and do not stop later valid events.
- Repeated events are idempotent.
- Watcher failure degrades to mission plus final-result capture.
- Cancellation and timeout always emit terminal events and stop child processing.
- ANSI control sequences are removed before persistence.
- Raw runtime JSON, base64 attachments, environment variables, and unrestricted tool input objects are not persisted.
- Tool output uses bounded storage; full agent-authored Markdown remains available.
- Local persistence failure leaves the current in-memory thread visible without crashing the active turn.

## Verification Strategy

### Unit tests

- Chat store v2-to-v3 migration and sanitization.
- Thread creation, event ordering, stable deduplication, and terminal statuses.
- Aggregate indicator copy for active, mixed, completed, failed, and cancelled agents.
- Structured child-event parsing for user, assistant, tool-use, and tool-result payloads.
- Native agent launch-result parsing and degraded final-result capture.
- Silent child timeout and cancellation without additional stdout.

### Renderer component tests

- No indicator when the active conversation has no threads.
- Indicator remains compact for one or multiple agents.
- New events and completion do not open the panel.
- Clicking the indicator opens the panel and selects the most recently updated thread.
- Switching conversations closes the panel while preserving both conversations' histories.
- Agent and final messages render through `MarkdownMessage`.
- Tool rows are compact by default and expand only on user action.
- Opening subagent closes terminal and review through their existing `close()` methods.
- Opening terminal clears subagent selection without changing terminal/review behavior.
- Opening review continues clearing subagent selection through its existing path.

### Regression and build verification

- Full Vitest suite.
- Renderer typecheck and production build.
- Focused Rust tests for normalized event extraction, transcript watching, timeout, and cancellation.
- Full Rust library test suite.
- Packaged macOS application build.

### Computer Use acceptance

In a fresh packaged development build:

1. Start a turn that launches one subagent.
2. Confirm the compact indicator appears without opening the panel.
3. Confirm transcript position, autoscroll, and composer geometry do not jump.
4. Open the panel manually and inspect mission, Markdown response, tools, and statuses.
5. Open terminal and confirm the subagent panel closes while terminal opens.
6. Open the subagent panel and confirm the terminal closes.
7. Open review and confirm the subagent panel closes while review opens.
8. Complete the agent and parent turn; confirm `1 concluído` remains accessible.
9. Switch conversations and return; confirm history persists but the panel stays closed.
10. Resize below and above 900 pixels; confirm the panel does not reopen automatically.

## Acceptance Criteria

- The subagent panel never opens without a direct user click.
- The indicator is compact, right-aligned, and outside transcript/composer structure.
- Terminal, review, and subagent panels are never visible simultaneously.
- Existing terminal-versus-review behavior is unchanged.
- The exact mission and full agent-authored Markdown are visible.
- Tool activity is useful but bounded.
- Completed threads survive turn completion, chat switching, application restart, and conversation reload.
- Agent activity is not duplicated as standalone transcript cards.
- Transcript autoscroll, composer size, and responsive layout pass regression and visual checks.

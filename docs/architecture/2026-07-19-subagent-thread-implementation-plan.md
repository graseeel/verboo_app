# Persistent Subagent Threads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Replace the temporary subagent activity UI with persistent, read-only per-conversation threads, exposed through a compact upper-right indicator and an explicitly opened Markdown panel.

**Architecture:** Rust normalizes both app-managed research agents and native CLI agents into one subagent-thread event. The renderer reduces idempotent updates into StoredConversation.subagents, the sole display source for the indicator and panel. App.tsx keeps only event routing, explicit selection, and narrow panel-exclusion handlers; transcript and composer internals remain untouched.

**Tech Stack:** Tauri 2, Rust 2021, React 19, TypeScript, Vitest, Testing Library, ReactMarkdown with remark-gfm, CSS grid, localStorage chat persistence.

## Global Constraints

- The panel is monitoring-only. Do not add cancel, reply, resume, restart, or composer controls.
- Runtime activity, completion, reload, and startup must never select a thread. Only a direct user click may set selectedSubagentId.
- Preserve the terminal-versus-review implementation. Add only two subagent integration points: terminal opening clears subagent selection; subagent opening closes terminal and review.
- Keep indicator and panel outside Transcript and outside bottom-dock. Do not change transcript padding, sticky-bottom calculations, composer sizing, or scroll code.
- Keep the indicator visible while terminal or review is open; clicking it explicitly switches to the subagent panel.
- Below the existing 900 px breakpoint, hide both subagent surfaces and clear selection. Resizing wider must not restore the panel.
- Persist full agent-authored Markdown. Persist only allowlisted tool input and truncate tool output with the existing 2,000-character normal / 3,200-character error policy.
- Do not store raw runtime JSON, environment values, attachments, or machine-specific paths.
- Resolve native transcript locations from VERBOO_PROJECTS_DIR or the current user's runtime directory. Tests inject temporary roots.
- Preserve unrelated untracked files: .superpowers/, .verboo/, pnpm-lock.yaml, pnpm-workspace.yaml, and src/renderer/__race_test__.test.tsx.
- Apply TDD in every task: add the focused failing test, confirm the intended failure, implement the smallest change, rerun to green, then commit.

## Runtime Contract

Use this exact shared contract in src/shared/types.ts:

~~~ts
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

export type SubagentThreadUpdate = {
  threadId: string
  runtimeAgentId?: string
  toolUseId?: string
  label?: string
  mission?: string
  status?: SubagentThreadStatus
  event?: SubagentThreadEvent
}
~~~

Add this AgentEvent branch and use the same camel-case field from Rust:

~~~ts
| {
    type: 'subagent-thread'
    turnId: string
    conversationId: string
    subagentThread: SubagentThreadUpdate
  }
~~~

Stable identifiers are mandatory:

- Research thread: ResearchSubagentRequest.id.
- Native thread: parentTurnId + ':subagent:' + agentToolUseId.
- Transcript content block: threadId + ':' + payloadUuid + ':' + blockIndex.
- Parent lifecycle event: threadId + ':' + payloadUuid.
- Synthetic degradation event: threadId + ':live-unavailable'.

When a final event repeats the text of the most recent agent-message, promote the existing event to final instead of appending a duplicate.

---

## Task 0: Checkpoint the approved documentation

**Files:**

- Modify: docs/architecture/2026-07-19-subagent-thread-design.md
- Create: docs/architecture/2026-07-19-subagent-thread-implementation-plan.md

- [ ] **Step 1: Verify the documentation-only diff**

~~~bash
git status --short
git diff --check
git diff -- docs/architecture/2026-07-19-subagent-thread-design.md
sed -n '1,960p' docs/architecture/2026-07-19-subagent-thread-implementation-plan.md
~~~

Expected: the design correction removes the residual cancel action, and the plan contains no code changes or unrelated files.

- [ ] **Step 2: Commit the approved plan**

~~~bash
git add docs/architecture/2026-07-19-subagent-thread-design.md docs/architecture/2026-07-19-subagent-thread-implementation-plan.md
git commit -m "chore(agents): plan persistent subagent threads"
~~~

---

## Task 1: Add the persistent data model and reducer

**Files:**

- Modify: src/shared/types.ts
- Modify: src/renderer/state/chatStore.ts
- Modify: src/renderer/state/chatStore.test.ts
- Create: src/renderer/features/subagents/subagentThreads.ts
- Create: src/renderer/features/subagents/subagentThreads.test.ts
- Create: src/renderer/features/transcript/toolOutput.ts
- Create: src/renderer/features/transcript/toolOutput.test.ts
- Modify: src/renderer/App.tsx

- [ ] **Step 1: Write failing store migration tests**

Add cases to chatStore.test.ts that load serialized v1, v2, and v3 stores through readChatStore() and assert:

~~~ts
expect(store.version).toBe(3)
expect(store.conversations[0].subagents).toEqual([])
~~~

Also cover malformed threads/events, ANSI stripping, chronological ordering, and preservation of full Markdown text.

- [ ] **Step 2: Run the migration tests and confirm failure**

Run:

~~~bash
npm test -- src/renderer/state/chatStore.test.ts
~~~

Expected: failures because ChatStore.version is 2 and conversations have no subagents.

- [ ] **Step 3: Write failing reducer tests**

Cover creation, metadata binding, stable-ID deduplication, event ordering, terminal status, and final-message coalescing:

~~~ts
const updated = applySubagentThreadUpdate(conversation, 'turn:1', {
  threadId: 'turn:1:subagent:tool:1',
  toolUseId: 'tool:1',
  label: 'Scout',
  mission: 'Inspect the parser',
  status: 'running',
  event: {
    id: 'event:1',
    kind: 'mission',
    text: 'Inspect the parser',
    timestamp: 10,
  },
})

expect(updated.subagents[0].mission).toBe('Inspect the parser')
expect(updated.subagents[0].events).toHaveLength(1)
~~~

Apply the same update twice and expect one event. Apply out-of-order timestamps and expect stable chronological order. Apply agent-message followed by identical final text and expect one promoted final event.

- [ ] **Step 4: Extract and test the existing tool-output bound**

Move TOOL_OUTPUT_MAX, TOOL_OUTPUT_MAX_ERROR, and truncateToolOutput from App.tsx into features/transcript/toolOutput.ts without changing behavior:

~~~ts
export const TOOL_OUTPUT_MAX = 2_000
export const TOOL_OUTPUT_MAX_ERROR = 3_200

export function truncateToolOutput(output: string, isError: boolean): string {
  const cleaned = output
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/\u001b/g, '')
  const trimmed = cleaned.trim()
  const max = isError ? TOOL_OUTPUT_MAX_ERROR : TOOL_OUTPUT_MAX
  if (trimmed.length <= max) return trimmed
  const head = trimmed.slice(0, max)
  const omitted = trimmed.length - max
  return head + '\n\n[… ' + omitted + ' more characters truncated]'
}
~~~

Test normal, error, ANSI, and below-limit values. Update the App import without changing its call sites.

- [ ] **Step 5: Implement types, v3 migration, sanitization, and reducer**

Add subagents: SubagentThread[] to StoredConversation and change the literal ChatStore version from 2 to 3. Do not change any other existing field.

Requirements for subagentThreads.ts:

- applySubagentThreadUpdate(conversation, parentTurnId, update) returns a new conversation.
- It never changes transcript items, lastTurnEndedAt, or UI selection.
- It strips terminal controls from persisted strings.
- It bounds only tool-result text through truncateToolOutput; mission, agent-message, and final remain complete.
- It derives createdAt from the first update and updatedAt from the latest accepted update.
- It derives a deterministic fallback label only when no runtime label exists.
- sanitizeSubagentThreads(value) ignores malformed entries individually and preserves later valid entries.

Update emptyChatStore, createConversation, isPersistedChatStore, migrateChatStore, and sanitizeConversation for v3. Keep CHAT_STORE_KEY unchanged so existing users migrate in place.

- [ ] **Step 6: Run focused tests**

~~~bash
npm test -- src/renderer/state/chatStore.test.ts src/renderer/features/subagents/subagentThreads.test.ts src/renderer/features/transcript/toolOutput.test.ts
~~~

Expected: all focused tests pass.

- [ ] **Step 7: Commit the persistence slice**

~~~bash
git add src/shared/types.ts src/renderer/state/chatStore.ts src/renderer/state/chatStore.test.ts src/renderer/features/subagents/subagentThreads.ts src/renderer/features/subagents/subagentThreads.test.ts src/renderer/features/transcript/toolOutput.ts src/renderer/features/transcript/toolOutput.test.ts src/renderer/App.tsx
git commit -m "feat(agents): persist subagent thread history"
~~~

---

## Task 2: Normalize child runtime payloads in Rust

**Files:**

- Modify: src-tauri/src/models/types.rs
- Modify: src-tauri/src/services/mod.rs
- Create: src-tauri/src/services/subagent_events.rs

- [ ] **Step 1: Write failing normalization tests**

In subagent_events.rs, add fixture-driven unit tests for:

- assistant text blocks;
- tool_use with only command, cmd, path, file_path, pattern, query, or url retained;
- matching tool_result with 2,000/3,200 character bounds;
- malformed content blocks followed by a valid block;
- direct child rows containing parent_tool_use_id;
- parent Agent/Task tool calls with exact prompt/task/message mission;
- task_started, task_progress, and task_notification lifecycle payloads;
- final-result duplication against the last assistant message.

Use these parser entry points:

~~~rust
pub(crate) fn child_updates_from_payload(
    thread_id: &str,
    payload: &serde_json::Value,
    received_at: u64,
) -> Vec<SubagentThreadUpdate>;

pub(crate) fn native_parent_signal(
    parent_turn_id: &str,
    payload: &serde_json::Value,
    received_at: u64,
) -> Option<NativeSubagentSignal>;
~~~

- [ ] **Step 2: Run and confirm tests fail to compile**

~~~bash
cd src-tauri && cargo +1.89.0 test --lib subagent_events
~~~

Expected: compile failure because normalized Rust types/module do not exist.

- [ ] **Step 3: Add Rust transport types**

Mirror the TypeScript enums/structs. Use rename_all = "kebab-case" for event kinds/status and rename_all = "camelCase" for objects. Extend the event envelope:

~~~rust
pub enum EventType {
    Started,
    Stdout,
    Stderr,
    Json,
    Result,
    SubagentProgress,
    SubagentThread,
    Error,
    Done,
}

// Add this field to the existing AgentEvent struct:
pub subagent_thread: Option<SubagentThreadUpdate>,
~~~

Existing explicit AgentEvent literals must set subagent_thread: None or use Default.

Keep the legacy SubagentProgress variant and progress field in this task so the existing research runner continues compiling. Task 3 removes them only after all research emission has moved to SubagentThread.

- [ ] **Step 4: Implement safe, idempotent normalization**

subagent_events.rs must:

- derive IDs from payload uuid plus content-block index;
- ignore raw stream_event deltas when a complete assistant message follows;
- emit complete assistant text blocks without truncation;
- retain only safe display fields from tool input;
- clean terminal control characters;
- map task_progress.last_tool_name to reading, searching, or running;
- map task_notification.status to completed, failed, or cancelled;
- return None/an empty vector for unrelated payloads rather than failing the parent turn.

- [ ] **Step 5: Run focused Rust tests**

~~~bash
cd src-tauri && cargo +1.89.0 test --lib subagent_events
~~~

Expected: all normalization tests pass.

- [ ] **Step 6: Commit the runtime contract**

~~~bash
git add src-tauri/src/models/types.rs src-tauri/src/services/mod.rs src-tauri/src/services/subagent_events.rs
git commit -m "feat(agents): normalize subagent runtime events"
~~~

---

## Task 3: Stream app-managed research threads and fix silent timeout

**Files:**

- Modify: src/shared/types.ts
- Modify: src-tauri/src/models/types.rs
- Modify: src-tauri/src/services/research_subagent_service.rs
- Modify: src-tauri/src/services/research_subagent_runner.rs

- [ ] **Step 1: Write failing watchdog and stream tests**

Add tests around a channel-driven reader loop instead of sleeping 90 seconds. Inject deadline and poll duration to assert:

- timeout fires while no stdout line arrives;
- cancellation fires while no stdout line arrives;
- EOF completes normally;
- assistant Markdown remains complete;
- tool use/result updates use stable IDs;
- timeout emits error plus failed status;
- internal cancellation emits cancelled status although the panel has no cancel control.

Use an internal reader message enum:

~~~rust
enum ReaderEvent {
    Line(String),
    Eof,
    Error(String),
}
~~~

- [ ] **Step 2: Run and confirm the watchdog test fails**

~~~bash
cd src-tauri && cargo +1.89.0 test --lib research_subagent_runner
~~~

Expected: the silent-process test fails because timeout is currently checked only inside blocking reader.lines().

- [ ] **Step 3: Preassign parent ownership and stable labels**

The renderer will assign baseRequest.turnId before invoking research. Rust treats base_request.turn_id and base_request.conversation_id as parent ownership while the child still uses research: + request.id internally.

Extend the request:

~~~ts
export type ResearchSubagentsRunRequest = {
  runId?: string
  count: number
  requestedCount?: number
  labels?: string[]
  baseRequest: AgentTurnRequest
}
~~~

Mirror labels in Rust and copy each label into ResearchSubagentRequest.

- [ ] **Step 4: Replace progress-only emission with normalized updates**

At runner start emit the exact child prompt as mission, not a synthetic UI summary:

~~~rust
let mission = ResearchSubagentService::build_prompt(&request);
emit_thread_update(
    &app,
    parent_turn_id,
    conversation_id,
    SubagentThreadUpdate::started(
        request.id.clone(),
        request.label.clone(),
        mission,
    ),
);
~~~

For each complete JSON child payload, call child_updates_from_payload and emit EventType::SubagentThread. Continue applying the read-only violation detector before accepting a tool action.

Collect complete assistant text from structured payloads into the result pipeline so summary, findings, and parent context no longer depend on plain non-JSON stdout.

After the runner no longer emits progress events, remove EventType::SubagentProgress, AgentEvent.progress, and the unused Rust ResearchSubagentProgress builder/type in the same commit. The TypeScript compatibility branch remains until Task 5, where the old App handler is removed.

- [ ] **Step 5: Make timeout/cancellation independent of stdout**

Move BufReader::lines() into a reader thread that sends ReaderEvent over std::sync::mpsc. The owner loop uses recv_timeout with the smaller of cancellation poll and remaining deadline. It interrupts the child, emits a terminal update, and returns without waiting for another stdout line.

Do not add a UI cancel path. Keep the backend cancellation command only for interruption/cleanup compatibility.

- [ ] **Step 6: Run focused tests**

~~~bash
cd src-tauri && cargo +1.89.0 test --lib research_subagent_runner
cd src-tauri && cargo +1.89.0 test --lib research_subagent_service
~~~

Expected: all runner/service tests pass, including silent timeout and cancellation.

- [ ] **Step 7: Commit the research stream**

~~~bash
git add src/shared/types.ts src-tauri/src/models/types.rs src-tauri/src/services/research_subagent_service.rs src-tauri/src/services/research_subagent_runner.rs
git commit -m "fix(agents): stream research threads with watchdog"
~~~

---

## Task 4: Follow native CLI subagent transcripts with graceful fallback

**Files:**

- Create: src-tauri/src/services/cli_subagent_transcript.rs
- Modify: src-tauri/src/services/mod.rs
- Modify: src-tauri/src/services/turn_service.rs

- [ ] **Step 1: Write failing path and incremental-read tests**

Use tempfile::TempDir and injected roots. Cover:

- VERBOO_PROJECTS_DIR precedence;
- default home/.claude/projects resolution without a real user path;
- bundled CLI sanitization: non-alphanumeric becomes -, maximum 200 characters, DJB2/base36 suffix when longer;
- project/sessionId/subagents/agent-agentId.jsonl resolution;
- a file appearing after task_started;
- appended complete/partial JSONL without rereading old rows;
- duplicate uuid rows;
- malformed row followed by a valid row;
- terminal stop after trailing writes;
- unavailable file emitting exactly one live-unavailable event.

- [ ] **Step 2: Run and confirm the module is missing**

~~~bash
cd src-tauri && cargo +1.89.0 test --lib cli_subagent_transcript
~~~

Expected: compile failure before implementation.

- [ ] **Step 3: Implement the runtime-specific source**

~~~rust
pub(crate) struct CliSubagentTranscriptSource {
    projects_root: PathBuf,
    poll_interval: Duration,
    resolve_notice_after: Duration,
}
~~~

The production constructor reads VERBOO_PROJECTS_DIR, otherwise dirs::home_dir()/.claude/projects. It receives working directory, CLI session ID, runtime agent ID, and a stop flag. It tails by byte offset, buffers an incomplete final line, and feeds complete rows through child_updates_from_payload.

Never expose the resolved path in renderer events or fail the parent turn.

- [ ] **Step 4: Integrate lifecycle discovery into main turn streaming**

Keep a per-turn correlation map keyed by toolUseId:

~~~rust
struct NativeSubagentContext {
    thread_id: String,
    runtime_agent_id: Option<String>,
    stop: Arc<AtomicBool>,
}
~~~

For each parsed main payload:

1. Agent/Task tool_use creates the thread and exact mission.
2. Direct child payload with parent_tool_use_id is normalized immediately for best live latency.
3. system/task_started or system/task_progress binds task_id as runtimeAgentId and starts the JSONL follower once session_id is known.
4. system/task_notification emits terminal status and stops the follower after a short trailing-read grace.
5. Matching parent tool_result emits the full final response when available.
6. Parent shutdown stops remaining followers but never deletes renderer history.

Direct stream and JSONL events must use identical UUID/block IDs so the reducer removes duplicates.

- [ ] **Step 5: Implement degraded mode**

If resolution/read fails:

- keep the original Agent tool mission;
- emit one quiet status event with ID threadId + ':live-unavailable';
- accept the complete parent tool_result as final without the old 360-character snippet;
- leave parent execution/result behavior unchanged.

- [ ] **Step 6: Run focused native tests**

~~~bash
cd src-tauri && cargo +1.89.0 test --lib cli_subagent_transcript
cd src-tauri && cargo +1.89.0 test --lib native_subagent
~~~

Expected: path, lifecycle, fallback, deduplication, and incremental-read tests pass.

- [ ] **Step 7: Commit the native source**

~~~bash
git add src-tauri/src/services/cli_subagent_transcript.rs src-tauri/src/services/mod.rs src-tauri/src/services/turn_service.rs
git commit -m "feat(agents): follow native subagent transcripts"
~~~

---

## Task 5: Route normalized updates into conversations

**Files:**

- Modify: src/renderer/App.tsx
- Modify: src/renderer/verboo-bridge.test.ts
- Modify: src/renderer/state/chatStore.test.ts

- [ ] **Step 1: Write failing renderer routing tests**

Cover:

- event ownership by event.conversationId;
- updates to a background conversation while another is active;
- no mutation of selectedSubagentId;
- persistence after parent result, done, and error.

- [ ] **Step 2: Run and confirm failures**

~~~bash
npm test -- src/renderer/verboo-bridge.test.ts src/renderer/state/chatStore.test.ts
~~~

Expected: new event/routing assertions fail before App uses the reducer.

- [ ] **Step 3: Assign the parent turn ID before research begins**

Change runTurn so one client turn ID owns research events and the later main turn:

~~~ts
const parentTurnId = item.request.turnId ?? crypto.randomUUID()
turnConversationIds.current[parentTurnId] = item.conversationId

const request = await prepareRequestWithResearchSubagents({
  ...item,
  request: { ...item.request, turnId: parentTurnId },
})
const turnId = await sendTrackedTurn(request, resumeId)
~~~

sendTrackedTurn already preserves a supplied turnId.

- [ ] **Step 4: Add the normalized event branch**

At the top of handleAgentEvent:

~~~ts
if (event.type === 'subagent-thread') {
  updateConversation(event.conversationId, conversation =>
    applySubagentThreadUpdate(
      conversation,
      event.turnId,
      event.subagentThread,
    ),
  )
  return
}
~~~

Do not select a thread or touch panel state.

- [ ] **Step 5: Remove temporary ownership and transcript duplication**

Delete from App.tsx:

- local ActiveSubagent and history types;
- activeSubagents, activeSubagentsRef, pendingResearchSubagentsRef;
- subagentPanelDismissed and subagentSummaryExpanded;
- autoSelectSubagent;
- routeSubagentChildEvent;
- trackActiveSubagent;
- updateSubagentResult;
- updateResearchSubagentProgress;
- attachPendingResearchSubagents;
- clearActiveSubagentsForTurn;
- turnSubagentToolIds and helpers made unused;
- cancelResearchSubagent as a panel action.

Also remove the now-unused TypeScript ResearchSubagentProgress type and the subagent-progress branch from AgentEvent after confirming no renderer caller remains.

In prepareRequestWithResearchSubagents, keep request parsing, deterministic labels, runResearchSubagents, and parent-context construction. Remove standalone research activity:1/activity:2 transcript items and all auto-selection calls.

Keep main RuntimeActivity(kind: 'subagent') flowing into the parent's existing collapsed action summary.

- [ ] **Step 6: Run focused/full renderer tests**

~~~bash
npm test -- src/renderer/verboo-bridge.test.ts src/renderer/state/chatStore.test.ts src/renderer/features/subagents/subagentThreads.test.ts
npm test
~~~

Expected: focused and complete Vitest suites pass; transcript behavior remains unchanged.

- [ ] **Step 7: Commit renderer ownership**

~~~bash
git add src/renderer/App.tsx src/renderer/verboo-bridge.test.ts src/renderer/state/chatStore.test.ts
git commit -m "feat(agents): route persistent threads by conversation"
~~~

---

## Task 6: Build the compact indicator and Markdown panel

**Files:**

- Create: src/renderer/features/subagents/SubagentIndicator.tsx
- Create: src/renderer/features/subagents/SubagentIndicator.test.tsx
- Create: src/renderer/features/subagents/SubagentThreadPanel.tsx
- Create: src/renderer/features/subagents/SubagentThreadPanel.test.tsx
- Modify: src/renderer/features/subagents/subagentThreads.ts
- Modify: src/renderer/i18n.tsx
- Modify: src/renderer/i18n.test.ts

- [ ] **Step 1: Write failing indicator tests**

Assert:

- zero threads renders nothing;
- one compact button represents one or many threads;
- active/mixed/completed/failed/cancelled aggregate copy;
- spinner only while a thread is non-terminal;
- no lifecycle effect can call onOpen;
- click calls onOpen once.

Expose a pure aggregate:

~~~ts
export type SubagentAggregate = {
  total: number
  active: number
  completed: number
  failed: number
  cancelled: number
  leadingStatus: SubagentThreadStatus
}
~~~

- [ ] **Step 2: Write failing panel tests**

Assert:

- every thread appears in the selector;
- mission is exact and untruncated;
- agent-message/final use MarkdownMessage with headings, GFM table, task list, and fenced code;
- raw HTML remains disabled through MarkdownMessage;
- tool rows start collapsed and expand only on click;
- error/status rows stay compact;
- footer says read-only and has no textbox, send, cancel, resume, or restart control;
- close/select callbacks run only on clicks.

- [ ] **Step 3: Run and confirm components are missing**

~~~bash
npm test -- src/renderer/features/subagents/SubagentIndicator.test.tsx src/renderer/features/subagents/SubagentThreadPanel.test.tsx
~~~

Expected: failure because components do not exist.

- [ ] **Step 4: Implement SubagentIndicator**

Render one button with icon, localized aggregate text, and optional active spinner. Props are only threads and onOpen; no expanded state and no automatic effects.

- [ ] **Step 5: Implement SubagentThreadPanel**

~~~ts
type SubagentThreadPanelProps = {
  threads: SubagentThread[]
  selectedId: string
  onSelect: (id: string) => void
  onClose: () => void
}
~~~

Reuse MarkdownMessage for mission, agent-message, and final. Group a tool-call with the following matching tool-result by toolUseId into one native details row. Keep chronological order and do not synthesize agent text.

- [ ] **Step 6: Add English and Portuguese copy**

Add indicator aggregate, selection, status, tool-detail, unavailable-live-detail, and read-only-footer keys. Remove cancel-specific keys only when no remaining caller uses them; retain unrelated backend cancellation-result copy.

- [ ] **Step 7: Run component/i18n tests**

~~~bash
npm test -- src/renderer/features/subagents/SubagentIndicator.test.tsx src/renderer/features/subagents/SubagentThreadPanel.test.tsx src/renderer/i18n.test.ts
~~~

Expected: all pass.

- [ ] **Step 8: Commit UI components**

~~~bash
git add src/renderer/features/subagents/SubagentIndicator.tsx src/renderer/features/subagents/SubagentIndicator.test.tsx src/renderer/features/subagents/SubagentThreadPanel.tsx src/renderer/features/subagents/SubagentThreadPanel.test.tsx src/renderer/features/subagents/subagentThreads.ts src/renderer/i18n.tsx src/renderer/i18n.test.ts
git commit -m "feat(ui): add compact subagent thread surfaces"
~~~

---

## Task 7: Integrate layout, explicit opening, and exclusivity

**Files:**

- Modify: src/renderer/App.tsx
- Modify: src/renderer/styles/layout.css
- Modify: src/renderer/styles/surfaces.css
- Modify: src/renderer/styles/composer.css
- Modify: src/renderer/styles/responsive.css
- Create: src/renderer/features/subagents/subagentPanelBehavior.test.tsx
- Modify: src/renderer/components/Transcript.test.tsx
- Modify: src/renderer/features/composer/Composer.test.tsx

- [ ] **Step 1: Write failing explicit-open/exclusivity tests**

Render the real App with a mocked window.verboo event source plus mocked terminal/review hooks. Drive it through the actual indicator and panel controls. Assert:

- incoming/update/completion events do not open;
- indicator click selects most recently updated and closes terminal/review;
- terminal opening clears selection and preserves current review.close then terminal.toggle order;
- existing review paths continue clearing selection;
- closing a panel does not restore another;
- conversation switch clears; returning does not restore;
- entering max-width: 900px clears; leaving selects nothing.

- [ ] **Step 2: Run and confirm failures**

~~~bash
npm test -- src/renderer/features/subagents/subagentPanelBehavior.test.tsx
~~~

Expected: failure while App still uses the floating expandable summary and temporary selection lifecycle.

- [ ] **Step 3: Wire persisted threads into App**

~~~ts
const subagentThreads = activeConversation?.subagents ?? []
const selectedSubagent = selectedSubagentId
  ? subagentThreads.find(thread => thread.id === selectedSubagentId)
  : undefined
const showSubagentThreadPanel =
  activeView === 'chat' &&
  Boolean(selectedSubagent) &&
  !terminal.terminalOpen &&
  !review.reviewOpen
~~~

Add effects that only clear selection when conversation changes, selected thread disappears, or viewport enters max-width: 900px. No effect chooses a replacement.

- [ ] **Step 4: Add the explicit open handler**

~~~ts
const handleOpenSubagents = useCallback(() => {
  const target = [...subagentThreads]
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
  if (!target) return
  terminal.close()
  review.close()
  setSelectedSubagentId(target.id)
}, [review, subagentThreads, terminal])
~~~

Indicator calls only this handler. Selecting another agent in the already open panel changes only selected ID.

- [ ] **Step 5: Add only the terminal integration line**

Preserve current handler body and add cleanup first:

~~~ts
const handleToggleTerminal = useCallback((cwd: string) => {
  setSelectedSubagentId(undefined)
  setReviewUnavailableReason(undefined)
  review.close()
  void terminal.toggle(cwd)
}, [review, terminal])
~~~

Do not add a global panel coordinator. Do not rewrite handleToggleReview or handleOpenReview; retain their existing selection cleanup.

- [ ] **Step 6: Move indicator out of bottom-dock**

Render SubagentIndicator as a sibling overlay in the chat layout, outside the scrollable transcript and bottom-dock. Remove SubagentSummaryCard and its expanded list. Render SubagentThreadPanel in existing grid column 3.

The compact indicator offset includes every possible side panel:

~~~css
right: calc(
  var(--terminal-width, 0px) +
  var(--review-width, 0px) +
  var(--subagents-panel-width, 0px) +
  14px
);
~~~

Keep the existing 320 px subagent column transition. Remove .subagent-summary-card only from the bottom-dock selector in composer.css; change no other bottom-dock rule.

- [ ] **Step 7: Add responsive hiding without restoration**

At max-width: 900px, hide .subagent-indicator with the panel. CSS handles visibility; App matchMedia effect clears state.

- [ ] **Step 8: Run UI/regression tests**

~~~bash
npm test -- src/renderer/features/subagents/subagentPanelBehavior.test.tsx src/renderer/components/Transcript.test.tsx src/renderer/features/composer/Composer.test.tsx
npm test
npm run build:renderer
~~~

Expected: behavior tests and full suite pass; TypeScript/Vite production build succeeds; transcript/composer behavior remains unchanged.

- [ ] **Step 9: Commit integration**

~~~bash
git add src/renderer/App.tsx src/renderer/styles/layout.css src/renderer/styles/surfaces.css src/renderer/styles/composer.css src/renderer/styles/responsive.css src/renderer/features/subagents/subagentPanelBehavior.test.tsx src/renderer/components/Transcript.test.tsx src/renderer/features/composer/Composer.test.tsx
git commit -m "feat(ui): integrate optional subagent side panel"
~~~

---

## Task 8: Complete automated and packaged-app acceptance

**Files:**

- Modify only if a test exposes a defect in files already listed above.
- Verify: docs/architecture/2026-07-19-subagent-thread-design.md
- Verify: docs/architecture/2026-07-19-subagent-thread-implementation-plan.md

- [ ] **Step 1: Run all automated gates**

From repo root unless noted:

~~~bash
npm test
npm run build:renderer
cd src-tauri && cargo +1.89.0 test --lib
cd .. && npm run tauri:build -- --bundles app
~~~

Expected:

- complete Vitest suite passes;
- TypeScript and renderer production build pass;
- complete Rust library suite passes;
- macOS app bundle succeeds at /Users/grasel/Library/Caches/verboo/target/release/bundle/macos/Verboo Code.app.

- [ ] **Step 2: Inspect final scope**

~~~bash
git status --short
git diff --check
git diff --stat 4e99392..HEAD
git diff --name-only 4e99392..HEAD
~~~

Expected: no whitespace errors; only plan/spec and named implementation files; unrelated untracked files remain untouched and unstaged.

- [ ] **Step 3: Perform packaged Computer Use acceptance**

Open the packaged development app and verify with fresh screenshot/accessibility evidence:

1. Start a turn that launches exactly one native subagent.
2. Confirm compact upper-right indicator appears while panel stays closed.
3. Confirm transcript position/autoscroll and composer geometry do not jump.
4. Open indicator manually; inspect exact mission, Markdown, tools, and status.
5. Open terminal; confirm subagent panel closes and terminal opens.
6. Click indicator; confirm terminal closes and subagent panel opens.
7. Open review; confirm subagent panel closes and review opens.
8. Complete child/parent; confirm completed indicator remains accessible.
9. Switch conversations and return; history persists and panel stays closed.
10. Restart app; history reloads and panel stays closed.
11. Resize below/above 900 px; panel does not reopen.
12. Run one app-managed research flow; same persistent UI appears with no standalone mission/result cards in main transcript.

- [ ] **Step 4: Record evidence and fix only verified defects**

Record pass/fail and fresh screenshot path for each point. If a point fails, add the smallest reproducing test before patching, rerun the focused test, then rerun all affected gates.

- [ ] **Step 5: Commit acceptance fixes only if needed**

If Step 4 changed code, stage only the explicit implementation paths (git add accepts unchanged paths safely), inspect the staged diff, and commit:

~~~bash
git add src/shared/types.ts src/renderer/App.tsx src/renderer/state/chatStore.ts src/renderer/features/subagents src/renderer/features/transcript/toolOutput.ts src/renderer/styles/layout.css src/renderer/styles/surfaces.css src/renderer/styles/composer.css src/renderer/styles/responsive.css src/renderer/i18n.tsx src-tauri/src/models/types.rs src-tauri/src/services/mod.rs src-tauri/src/services/subagent_events.rs src-tauri/src/services/research_subagent_service.rs src-tauri/src/services/research_subagent_runner.rs src-tauri/src/services/cli_subagent_transcript.rs src-tauri/src/services/turn_service.rs
git diff --cached --check
git diff --cached --stat
git commit -m "fix(ui): close subagent panel acceptance gaps"
~~~

Do not create an empty commit if no change was needed.

## Definition of Done

- StoredConversation.subagents is the sole UI source and survives completion, chat switching, reload, and app restart.
- Both research and native agents emit the normalized subagent-thread contract.
- The panel never opens without a direct user click.
- Indicator is compact, outside transcript/composer, and available after completion and while another side panel is open.
- Terminal, review, and subagent panels are mutually exclusive; terminal-versus-review behavior is unchanged.
- Mission and agent-authored Markdown are complete; tool data is safe and bounded.
- No direct interaction controls exist in the panel.
- No standalone research mission/result cards appear in the parent transcript.
- Silent research processes timeout/cancel independently of stdout.
- Full renderer, Rust, package, and Computer Use gates pass.

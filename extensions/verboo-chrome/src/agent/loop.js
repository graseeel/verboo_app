/**
 * loop.js — multi-step LLM agent loop.
 *
 * Flow:
 *   1. Decide whether the user asked for browser control or normal conversation
 *   2. Build messages array with system prompt + user message
 *   3. Call LLM via routerClient.chatCompletion
 *   4. If response has no tool_calls → done (assistant message)
 *   5. For each tool_call → broadcast thought → executeTool callback → broadcast result
 *   6. For vision-capable models, screenshot pixels are attached once as a
 *      multimodal user message; tool messages stay OpenAI-compatible strings
 *   7. Repeat up to MAX_AGENT_STEPS (200)
 *   8. Router errors after partial tool success → explicit partial-result summary
 *   9. On hard failure with zero tools → throw without executing a fallback plan
 *
 * Policy gate: executeTool callback MUST go through the existing
 * execute() → evaluateToolPolicy path. This module never touches chrome.*.
 *
 * Broadcast shapes match panel.js expectations (see MSG constants):
 *   AGENT_THOUGHT       — { turnId, text, modelId? }
 *   AGENT_TOOL_RESULT   — { turnId, toolResult: { toolCallId, success, data?, error?, durationMs } }
 *
 * Multi-user: zero hardcoded accounts.
 */

import { chatCompletion, stripToolMarkup } from './routerClient.js'
import {
  hasBrowserUnavailableAdmission,
  hasDeicticImperativeIntent,
  hasImperativeWithObject,
} from './intentSignals.js'
import { isControllableUrl } from '../planMessage.js'
import { getToolRisk, OPENAI_TOOLS, toToolCall } from './toolCatalog.js'
import { MSG } from '../controller/protocol.js'
import {
  inspectUntrustedBrowserContent,
  wrapUntrustedBrowserContent,
} from './untrustedContent.js'
import { MAX_AGENT_STEPS, MAX_AGENT_TURN_MS } from './turnBudget.js'

const MAX_RESULT_CHARS = 4000
const MAX_HISTORY_MESSAGES = 12
const MAX_HISTORY_MESSAGE_CHARS = 4000
const POST_NAVIGATE_DELAY_MS = 400
const YOUTUBE_WATCH_POLL_MS = 100
const YOUTUBE_WATCH_POLL_ATTEMPTS = 8

/**
 * Injected once after 3 consecutive failures of the same tool to unstick the agent.
 */
const STRATEGY_HINT = `You seem stuck failing the same tool repeatedly. STOP guessing — discover instead:
1. Use find with the visible text the user mentioned to locate the REAL element on the current page (it returns working selectors derived from actual elements).
2. If find finds nothing, read the page with read_page and look for the target's text.
3. Click only a selector returned by find or read_page. Never invent CSS selectors from memory — site structure is not something you know.
4. If the target genuinely does not exist on the page, tell the user honestly instead of trying more selectors.`

/**
 * Injected ONCE per turn (R6/FRENTE-C) after the model emitted tool markup
 * that produced no executable call — gives the model the exact output
 * contract instead of failing silently or echoing the raw block to the
 * user. Model-agnostic by design: any model that text-emits tool markup
 * (e.g. Anthropic-style <function_calls>) gets the same directed retry.
 */
const TOOL_FORMAT_RETRY_HINT = `You tried to call a browser tool, but your reply was not accepted as a tool call. Retry the SAME action using the API's native tool_calls mechanism — never write XML tags like <function_calls>, <tool_call>, <invoke>, or <function=...> in your reply text.
Available tools: navigate, read_page, find, extract_page_content, structured_extract, click, type, screenshot, tabs, tab_group.
click accepts either a CSS selector or viewport pixel coordinates {x, y}. Use find to locate elements before clicking; never invent selectors from memory.`

/**
 * System prompt for the browser agent. Bilingual EN+PT to handle mixed requests.
 */
const SYSTEM_PROMPT = `You are Verboo, a conversational AI that can also control Chrome via tools when the user asks.

DUAL MODE (mandatory):
- NORMAL CONVERSATION: Answer questions, explain topics, brainstorm, write, translate, and help from general knowledge exactly like a normal AI assistant. Do not inspect or change the current page merely because browser context exists.
- BROWSER CONTROL: Use browser tools only when the user asks you to open, inspect, navigate, search, click, type, play, upload, or otherwise interact with Chrome or the current page.
- Never turn an ordinary informational question into a browser task. If it can be answered without interacting with Chrome, reply directly.

CAPABILITIES:
- Navigate to websites (always use full https:// URLs)
- Read page content via CSS selectors
- Click elements (buttons, links, video thumbnails)
- Type text into input fields
- Use screenshots for visual disambiguation when visual input is available
- Manage browser tabs

LANGUAGE (mandatory):
- Always write your final user-facing reply in the SAME language as the user's latest message.
- If the user writes in Portuguese (including PT-BR), the final summary MUST be in Brazilian Portuguese.
- If the user writes in English, reply in English.
- Tool arguments (URLs, CSS selectors) stay technical; only the final assistant message follows the user language.
- Never default to English when the user wrote in another language.

IMPORTANT RULES:
- NEVER use chrome://, chrome-extension://, about:, or edge:// URLs
- After navigating to a page, WAIT for the page to load before acting. Prefer read_page; use screenshot only when you need visual disambiguation.
- DISCOVER BEFORE YOU CLICK: when the user names a target (a playlist, a button, an item) that is not visible to you yet, locate the REAL element first — call find with the user's wording, or read the page with read_page. Click only selectors returned by find/read_page.
- Never invent or fabricate CSS selectors from memory — site structure is not something you know. If find/read_page return nothing for the named target, tell the user honestly that it was not found instead of trying more guessed selectors.
- For a full-page extraction request (for example "extrai o conteudo e resume", "extract this page"), call extract_page_content to obtain the ENTIRE page text without truncation, then summarize from the full content.
- For search: navigate to the search engine, type the query, submit
- For reading a page: use read_page with a targeted selector, not the whole body when possible
- For an explicit current-page inspection request (for example "o que é isso", "o que diz esta página", or "extract this page"), ALWAYS call read_page before answering. Do not answer that browser tools are unavailable when the current page is an HTTP(S) page.
- Return a brief text summary when you finish the task
- Never invent or fabricate selectors — only use ones you can see from page content

TOOL PROTOCOL (mandatory):
- You have real function-calling. Call browser tools ONLY through the API's native tool_calls mechanism.
- NEVER write tool markup as chat text — no <function_calls>, <tool_call>, <invoke>, or <function=...> tags in your reply. Written tool markup is rejected and never executed.
- Available tools: navigate, read_page, find, extract_page_content, structured_extract, click, type, screenshot, tabs, tab_group.
- WORK ON THE CURRENT TAB: the tab where the user sent the prompt is the working tab. All read/click/type actions target it. The user may switch tabs freely while you work — keep acting on the working tab. NEVER open a new tab or window on your own initiative; create a new tab (tabs new / navigate to a new tab) ONLY when the user explicitly asks for it in the prompt.
- click accepts a CSS selector or viewport pixel coordinates {x, y}. Use find to locate elements before clicking; never invent selectors from memory.
- After a mutation (click/type), verify the effect with read_page before summarizing — never claim completion without observing the result. Use type with pressEnter: true when the task needs the typed value to COMMIT (adding to a list, sending a message, running a search).`

/**
 * Run a multi-step LLM agent turn.
 *
 * @param {{ turnId: string, userMessage: string, selectionContext?: {text:string,verification?:string}, accessToken: string, modelId: string, modelSupportsVision?: boolean, conversationHistory?: Array<object>, routineContext?: {name:string,instructions:string,assets?:Array<object>}, toolAllowlist?: string[], broadcast: Function, executeTool: Function, getActiveTabMeta: Function, refreshAccessToken?: () => Promise<string|null>, signal?: AbortSignal, maxTurnMs?: number }} params
 * @returns {Promise<{ assistantMessage: string, toolResults: Array<object> }>}
 */
export async function runLlmAgentTurn(params) {
  const maxTurnMs = Number.isFinite(params?.maxTurnMs) && params.maxTurnMs > 0
    ? params.maxTurnMs
    : MAX_AGENT_TURN_MS
  const controller = new AbortController()
  let timeBudgetExpired = false
  const externalSignal = params?.signal
  const onExternalAbort = () => controller.abort()
  if (externalSignal?.aborted) controller.abort()
  else externalSignal?.addEventListener?.('abort', onExternalAbort, { once: true })
  const timer = setTimeout(() => {
    timeBudgetExpired = true
    controller.abort()
  }, maxTurnMs)

  try {
    return await runLlmAgentTurnWithinBudget({
      ...params,
      signal: controller.signal,
    })
  } catch (error) {
    if (timeBudgetExpired) {
      const timeout = new Error(`Agent turn timed out after ${maxTurnMs}ms`)
      timeout.code = 'agent_turn_timeout'
      throw timeout
    }
    throw error
  } finally {
    clearTimeout(timer)
    externalSignal?.removeEventListener?.('abort', onExternalAbort)
  }
}

async function runLlmAgentTurnWithinBudget({
  turnId,
  userMessage,
  selectionContext,
  accessToken,
  modelId,
  modelSupportsVision,
  conversationHistory,
  routineContext,
  toolAllowlist,
  broadcast,
  executeTool,
  getActiveTabMeta,
  refreshAccessToken,
  signal,
  forceBrowserTools = false,
  activeTabUrl,
}) {
  if (!accessToken) throw new Error('LLM agent: accessToken is required')
  if (!modelId) throw new Error('LLM agent: modelId is required')

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'system', content: modelIdentityDirectiveFor(modelId, modelSupportsVision) },
  ]
  // forceBrowserTools is set by the caller when re-running a turn that was
  // reclassified by the B1-CHROME fallback: the model already tried to call
  // a browser tool, so the re-run opens the tools unconditionally.
  const browserToolsEnabled =
    forceBrowserTools === true
    || Boolean(routineContext)
    || shouldOfferBrowserTools(userMessage, conversationHistory, activeTabUrl)
  const availableTools = browserToolsEnabled
    ? modelSupportsVision === true
      ? OPENAI_TOOLS
      : OPENAI_TOOLS.filter((tool) => tool.function?.name !== 'screenshot')
    : []
  const allowedToolNames = Array.isArray(toolAllowlist)
    ? new Set(toolAllowlist)
    : null
  const tools = allowedToolNames
    ? availableTools.filter((tool) => allowedToolNames.has(tool.function?.name))
    : availableTools

  messages.push({
    role: 'system',
    content: browserToolsEnabled
      ? 'TURN MODE: BROWSER CONTROL. Browser tools are available because the user explicitly requested interaction with Chrome or the current page.'
      : 'TURN MODE: NORMAL CONVERSATION. Answer the user directly. Do not inspect or modify the browser; no browser tools are available for this turn.',
  })

  // Seed with current page context as a system note (not a fake tool_call).
  let activeTabMeta = null
  if (browserToolsEnabled) {
    activeTabMeta = await getActiveTabMeta()
    if (activeTabMeta?.url && /^https?:\/\//i.test(activeTabMeta.url)) {
      messages.push({
        role: 'system',
        content: wrapUntrustedBrowserContent({
          currentPage: {
            url: activeTabMeta.url,
            ...(activeTabMeta.title ? { title: activeTabMeta.title } : {}),
          },
        }),
      })
    }
  }

  if (typeof selectionContext?.text === 'string' && selectionContext.text.trim()) {
    messages.push({
      role: 'system',
      content: wrapUntrustedBrowserContent({
        selectedText: selectionContext.text,
        ...(selectionContext.verification === 'complete'
          ? {}
          : { selectedTextStatus: 'Selection may be incomplete.' }),
      }),
    })
  }

  messages.push(...sanitizeConversationHistory(conversationHistory))
  const routineUserContent = await buildRoutineUserContent(
    userMessage,
    routineContext,
    modelSupportsVision === true,
  )
  const routineVisualMessageIndex = Array.isArray(routineUserContent)
    ? messages.length
    : -1
  messages.push({
    role: 'user',
    content: routineUserContent,
  })
  // Hard language pin for the final reply (models often ignore a soft prompt rule).
  messages.push({
    role: 'system',
    content: languageDirectiveFor(userMessage),
  })

  /** @type {Array<object>} */
  const allToolResults = []

  // Screenshot pixels only need to survive until the next model response.
  // Afterwards the visual message is replaced with a small history marker so
  // later requests do not resend a large base64 payload on every step.
  /** @type {number[]} */
  let pendingVisualMessageIndexes = []
  let routineVisualPending = routineVisualMessageIndex >= 0

  /** Tracks consecutive failures of the same tool to inject strategy / stop early. */
  let failStreak = { name: null, count: 0, afterHint: false }
  // G2-CHROME: the model is asked to close an executed turn at most once.
  let emptyCloseRetried = false
  // R6/FRENTE-C: the directed tool-format retry is issued at most once per
  // turn — a model that keeps emitting markup after the hint gets an honest
  // error, never an unbounded retry loop.
  let formatRetryUsed = false

  // Some tasks have an observable terminal state. Once reached, the next
  // request asks only for the final reply and cannot trigger another action.
  let browserActionsComplete = false
  let requiresVerification = false
  // R-V4/GENERALIZAÇÃO: the programmatic evidence read happens AT MOST ONCE
  // per turn (no loop) — when the model tries to close with the verification
  // flag still armed, the LOOP reads the page itself and appends the real
  // text before accepting a final summary.
  let verificationEvidenceRead = false
  let verificationAskSent = false
  // PÓS-CAMPO-3 (item 2): consecutive failures of the EXACT same mutate
  // call (name + canonical input). After N=2, the identical call is
  // blocked and feedback directs to find/read_page. Different arguments
  // always pass — legitimate retries are never killed.
  const failedMutateCounts = new Map()
  // PÓS-CAMPO-6 (A): system messages produced inside the execution loop are
  // collected and flushed AFTER all tool responses of the completion (see
  // the flush point below) to preserve the assistant→tools adjacency.
  const pendingSystemMessages = []
  // PÓS-CAMPO-4: AUTOMATIC recovery — the harness stops asking and starts
  // DOING. Counts selector-not-found failures PER TOOL NAME (the exact-key
  // dedup above cannot see selector-variant repeats); on the 2nd failure
  // the loop runs find itself and feeds the REAL selectors back. Bounded:
  // 1 auto-find per tool name per turn; empty find → honest feedback.
  const failedSelectorCounts = { type: 0, click: 0 }
  const autoFindUsed = { type: false, click: false }
  // CICLO DEPURAÇÃO SISTEMÁTICA (B): screenshot em background — após 2 falhas
  // de captura no turno (aba de trabalho em segundo plano), o loop para de
  // reoferecer screenshot (3ª chamada BLOQUEADA) e orienta read_page.
  let screenshotFailures = 0
  // PÓS-CAMPO-5: structural honesty — track mutation outcomes so the final
  // assistant text can NEVER claim success when nothing committed. The
  // condition is 100% structural (no model-text interpretation).
  let mutationAttempts = 0
  let mutationSuccesses = 0
  let lastMutateFailed = false
  let inspectionSinceLastMutate = false
  let promptInjectionDetected = false
  let currentAccessToken = accessToken
  const refreshAccessTokenForTurn = typeof refreshAccessToken === 'function'
    ? async () => {
        const refreshed = await refreshAccessToken()
        if (typeof refreshed === 'string' && refreshed) currentAccessToken = refreshed
        return refreshed
      }
    : undefined

  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    if (signal?.aborted) break

    broadcast({
      type: MSG.AGENT_THOUGHT,
      turnId,
      text: step === 0
        ? `Analyzing request with ${modelId}…`
        : `Step ${step + 1}/${MAX_AGENT_STEPS} — continuing…`,
      modelId,
    })

    let completion
    try {
      completion = await chatCompletion({
        accessToken: currentAccessToken,
        model: modelId,
        messages,
        tools: browserActionsComplete ? [] : tools,
        refreshAccessToken: refreshAccessTokenForTurn,
        signal,
      })
    } catch (routerErr) {
      if (signal?.aborted) throw routerErr
      // After tools already ran, never throw away progress for planMessage re-search.
      if (allToolResults.length > 0) {
        broadcast({
          type: MSG.AGENT_THOUGHT,
          turnId,
          text: `Router error after ${allToolResults.length} action(s) — finishing with what we have…`,
        })
        return {
          assistantMessage: summarizePartialAgentTurn(userMessage, allToolResults),
          toolResults: allToolResults,
        }
      }
      throw routerErr
    }

    if (routineVisualPending) {
      const original = messages[routineVisualMessageIndex]
      const textPart = Array.isArray(original?.content)
        ? original.content.find((part) => part?.type === 'text')?.text
        : ''
      messages[routineVisualMessageIndex] = {
        role: 'user',
        content: `${textPart ?? ''}\n[Saved routine images were provided for the first model step.]`,
      }
      routineVisualPending = false
    }

    for (const index of pendingVisualMessageIndexes) {
      messages[index] = {
        role: 'system',
        content: '[A screenshot was provided as visual context for the previous step.]',
      }
    }
    pendingVisualMessageIndexes = []

    // Text-only response → done. Some models occasionally ignore the tool
    // contract and answer in prose even for an explicit current-page read.
    // For HTTP(S) pages, synthesize the same read-only call we asked for and
    // let the normal tool-result round-trip produce the final answer. This is
    // deliberately narrower than browserToolsEnabled: navigation, mutation,
    // and screenshot requests never get an invented action.
    if (completion.toolCalls.length === 0) {
      // R6/FRENTE-C: the model emitted tool markup (any family —
      // <function_calls>, <tool_call>, <invoke>…) that produced NO
      // executable call. Model-agnostic handling:
      //   · conversation turn → reclassify (B1-CHROME analog for the text
      //     form: the model's own markup is the strongest signal the turn
      //     needs browser tools; page content is not in the messages here,
      //     so it cannot be injection-seeded — the same safety reasoning
      //     as the structured B1 path below);
      //   · browser turn → ONE directed format retry, then honest failure.
      const formatFailed = completion.markupDetected === true
        || (completion.droppedToolNames?.length ?? 0) > 0
      if (formatFailed) {
        if (!browserToolsEnabled) {
          return { reclassify: true, toolResults: allToolResults }
        }
        if (!formatRetryUsed) {
          formatRetryUsed = true
          broadcast({
            type: MSG.AGENT_THOUGHT,
            turnId,
            text: `Model used unsupported tool markup — retrying with the exact tool protocol…`,
            modelId,
          })
          messages.push({ role: 'system', content: TOOL_FORMAT_RETRY_HINT })
          continue
        }
      }

      // L3/Intenção+UX: the model's OWN reply admits it has no browser
      // access ("o navegador não está disponível", "I don't have access
      // to the browser"). In a conversation turn — where the classifier
      // already missed an implicit action request — that admission is the
      // strongest signal available. Reclassify exactly like B1 (the caller
      // re-runs with forceBrowserTools).
      //
      // Bounded by construction: this gate requires !browserToolsEnabled,
      // so the re-run can never fire it again (max 1 reclassify per user
      // turn). Interaction with formatRetry (documented): reclassify
      // RESTARTS the turn with a fresh budget — a re-run may still use the
      // single per-turn formatRetry if the model emits markup after tools
      // are offered. The two never share a flag because they live in
      // different turn instances.
      if (!browserToolsEnabled && completion.content
          && hasBrowserUnavailableAdmission(completion.content)) {
        return { reclassify: true, toolResults: allToolResults }
      }

      if (browserToolsEnabled && allToolResults.length === 0) {
        if (
          activeTabMeta?.url &&
          /^https?:\/\//i.test(activeTabMeta.url) &&
          shouldFallbackToPageRead(userMessage)
        ) {
          completion = {
            content: null,
            toolCalls: [{
              id: `fallback_read_${turnId}_${step}`,
              name: 'read_page',
              arguments: '{"selector":"body"}',
            }],
          }
        } else {
          throw new Error('model_tool_protocol_unsupported')
        }
      }
      if (completion.toolCalls.length === 0) {
        if (requiresVerification) {
          // R-V4/GENERALIZAÇÃO (approved conditional): with the verification
          // flag still armed at the final summary — a mutation happened and
          // the model did not inspect afterwards — the LOOP reads the page
          // itself (real text, outside the model's tools) and appends it as
          // evidence BEFORE accepting any summary. Exactly once per turn;
          // no loop: the next close is accepted (fenced) as-is. No
          // duplicated read when the model already verified (flag off).
          if (!verificationEvidenceRead) {
            verificationEvidenceRead = true
            try {
              const evidence = await executeTool(
                { id: `verify-${turnId}`, name: 'read_page', params: {} },
                signal,
              )
              const evidenceText = typeof evidence?.result?.text === 'string'
                ? evidence.result.text
                : (typeof evidence?.result?.content === 'string' ? evidence.result.content : '')
              if (evidenceText.trim()) {
                messages.push({
                  role: 'system',
                  content:
                    'The last browser mutation has not been verified by your own inspection. ' +
                    'Real current page state (read by the harness, outside your tools):\n' +
                    evidenceText.slice(0, 32_000) +
                    // R-V5/GENERALIZAÇÃO-2: typed text INSIDE the target
                    // field is not evidence — the effect must be observed
                    // outside it (the field keeps the typed value even
                    // when nothing committed).
                    '\nText typed INSIDE the target field is NOT evidence of the effect — the effect must be observable OUTSIDE the target field (e.g. the new item in the list, the page state, the navigation). ' +
                    'Conclude based on THIS evidence: confirm the expected effect is present, ' +
                    'or report the failure honestly and retry. Never claim success without observing it.',
                })
                continue
              }
            } catch {
              /* evidence read is best-effort */
            }
          }
          // R-V2/GENERALIZAÇÃO: ask for inspection WITH evidence citation —
          // at most once per turn; the summary is accepted afterwards (the
          // flow falls through below) — no unbounded loop.
          if (!verificationAskSent) {
            verificationAskSent = true
            messages.push({
              role: 'system',
              content:
                'The last browser mutation has not been verified. Inspect the current page with read_page ' +
                'and CONFIRM THE EFFECT of the action (the new state/item is present). ' +
                // R-V5/GENERALIZAÇÃO-2: anti-input — the typed value stays
                // in the field even when nothing committed.
                'Text typed INSIDE the target field is NOT evidence — the effect must be observable outside it. ' +
                'Answer with the observed evidence — if the effect is not visible, report the failure and ' +
                'retry; never claim success without observing it.',
            })
            continue
          }
        }
        const text = completion.content?.trim()
        if (!text) {
          // G2-CHROME: an empty final reply after EXECUTED actions must not
          // become "Could not complete". Ask the model once to close, then
          // synthesize a closing summary from the tool results — the turn
          // counts as COMPLETE. The honest failure stays for turns with
          // zero EXECUTED actions and an empty reply.
          //
          // The gate is REAL success, not tool-call count: the CASO A of the
          // owner's video (4 element-not-found + empty reply) must stay an
          // honest failure — never "Concluído: 0 ações".
          if (allToolResults.some((r) => r && r.success)) {
            if (!emptyCloseRetried) {
              emptyCloseRetried = true
              messages.push({
                role: 'system',
                content:
                  'You executed browser actions but returned an empty final reply. Conclude now ' +
                  'with a brief summary of the observed result, in the user\'s language.',
              })
              continue
            }
            return {
              assistantMessage: synthesizeClosingSummary(userMessage, allToolResults),
              toolResults: allToolResults,
            }
          }
          throw new Error('model_returned_empty_response')
        }
        // R8/FRENTE-C render fence (defense-in-depth): the parser already
        // strips recognized markup, but no raw tool-call block may ever
        // reach the panel. If stripping leaves nothing (e.g. a markup
        // family the parser does not know yet), fall back to the closing
        // summary when actions ran, or to an honest error otherwise.
        const fenced = stripToolMarkup(text)
        if (fenced) {
          // PÓS-CAMPO-5: structural honesty — the model's final text NEVER
          // passes when every mutation of the turn failed; the harness
          // replaces it with the honest mechanical summary (same i18n
          // pattern as summarizePartialAgentTurn). Zero model-text
          // interpretation.
          return {
            assistantMessage: honestTurnMessage(
              fenced,
              userMessage,
              allToolResults,
              { mutationAttempts, mutationSuccesses, lastMutateFailed, inspectionSinceLastMutate },
            ),
            toolResults: allToolResults,
          }
        }
        if (allToolResults.some((r) => r && r.success)) {
          return {
            assistantMessage: honestTurnMessage(
              synthesizeClosingSummary(userMessage, allToolResults),
              userMessage,
              allToolResults,
              { mutationAttempts, mutationSuccesses, lastMutateFailed, inspectionSinceLastMutate },
            ),
            toolResults: allToolResults,
          }
        }
        throw new Error('model_tool_protocol_unsupported')
      }
    }

    // Model emitted one or more tool calls, but this turn was classified as
    // NORMAL CONVERSATION (shouldOfferBrowserTools was false at the top of
    // the turn, and no saved routine was active) — so no browser tools were
    // offered. B1-CHROME: instead of returning the reformulation error, the
    // loop returns a reclassify signal and the caller re-runs the turn WITH
    // the browser tools available. The model's own judgment that it needs a
    // browser tool is the strongest signal that the classifier got the turn
    // wrong — this kills the whole class of classifier false-negatives
    // regardless of phrasing.
    //
    // Why this is safe: in a conversation turn the page content is NOT in
    // the messages (activeTabMeta is only seeded when browserToolsEnabled),
    // so a tool call here cannot come from a prompt-injection seed in page
    // content — it comes from the user's request. The injection defense
    // (inspectUntrustedBrowserContent + promptInjectionDetected below) still
    // applies after the re-run, and execute() still gates mutations through
    // the approval policy. The re-run offers the tools in the catalog; if
    // the model calls again, the call is deliberate and executes.
    //
    // The loop itself never executes a tool inline here: the caller
    // (background.js) routes the re-run through the browser control queue so
    // browser actions stay serialized across concurrent turns.
    if (!browserToolsEnabled && completion.toolCalls.length > 0) {
      const attempted = completion.toolCalls.map((tc) => tc.name).filter(Boolean)
      const pt = looksPortuguese(userMessage)
      const attemptedLabel = attempted.length === 0
        ? (pt ? 'ferramentas de navegador' : 'browser tools')
        : attempted.length === 1
          ? (pt ? `a ferramenta "${attempted[0]}"` : `the "${attempted[0]}" tool`)
          : (pt
              ? `as ferramentas ${attempted.map((n) => `"${n}"`).join(', ')}`
              : `the tools ${attempted.map((n) => `"${n}"`).join(', ')}`)
      broadcast({
        type: MSG.AGENT_THOUGHT,
        turnId,
        text: pt
          ? `O modelo tentou chamar ${attemptedLabel} — reclassificando o turno e reexecutando com ferramentas de navegador.`
          : `Model tried to call ${attemptedLabel} — reclassifying the turn and re-running with browser tools.`,
      })
      return { reclassify: true, toolResults: allToolResults }
    }

    // Models may emit the same action more than once in a parallel tool-call
    // batch. Execute one canonical copy so a single request cannot double-click
    // or type the same value twice.
    const toolCalls = dedupeToolCalls(completion.toolCalls)

    // A terminal browser state has already been reached and tools were removed
    // from the request. Refuse an out-of-contract tool call instead of acting.
    if (browserActionsComplete && toolCalls.length > 0) {
      return {
        assistantMessage: summarizePartialAgentTurn(userMessage, allToolResults),
        toolResults: allToolResults,
      }
    }

    // Add assistant message (with tool_calls) to conversation.
    messages.push({
      role: 'assistant',
      content: completion.content,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      })),
    })

    // Execute each tool call → push role:tool message per call. Any screenshot
    // images are appended only after all tool responses from this assistant
    // message, which preserves the OpenAI tool-call ordering contract.
    let lastWasSuccessfulNavigate = false
    const visualParts = []
    for (const rawTc of toolCalls) {
      if (signal?.aborted) break

      const tc = toToolCall(rawTc)
      const startedAt = Date.now()

      if (allowedToolNames && !allowedToolNames.has(tc.name)) {
        throw new Error(`recovery_tool_not_allowed:${tc.name}`)
      }

      if (promptInjectionDetected && getToolRisk(tc.name) !== 'read') {
        const blockedResult = {
          toolCallId: tc.id,
          name: tc.name,
          success: false,
          data: null,
          error: 'suspected_prompt_injection',
          durationMs: 0,
        }
        allToolResults.push(blockedResult)
        broadcast({
          type: MSG.AGENT_TOOL_RESULT,
          turnId,
          toolResult: {
            toolCallId: tc.id,
            success: false,
            data: null,
            error: blockedResult.error,
            durationMs: 0,
          },
        })
        return {
          assistantMessage: promptInjectionStopMessage(userMessage),
          toolResults: allToolResults,
        }
      }

      // PÓS-CAMPO-3 (item 2): block the EXACT repetition of a failing
      // mutate. Two consecutive failures of the same name+canonical input
      // → the third identical call is NOT executed; the tool-role feedback
      // directs to find/read_page. Bounded: the block is deterministic per
      // key (never executes), different arguments always execute, and the
      // step counter still advances — no loop possible.
      // B-3 (Farol): isMutate derivado do TOOL_RISK (catálogo) — a lista
      // manual de nomes morre; ferramentas novas de mutate nascem rastreadas.
      const isMutate = getToolRisk(tc.name) === 'mutate'
      // NOTE: tc (toToolCall) carries params, NOT the raw arguments string —
      // the canonical key must be built from params or every call collapses
      // into one key (String(undefined) === 'undefined').
      const attemptKey = isMutate
        ? `${tc.name}:${canonicalJson(JSON.stringify(tc.params ?? {}))}`
        : null
      if (attemptKey && (failedMutateCounts.get(attemptKey) ?? 0) >= 2) {
        allToolResults.push({
          toolCallId: tc.id,
          name: tc.name,
          success: false,
          data: null,
          error: 'blocked_repeated_failed_call',
          durationMs: 0,
        })
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: 'BLOCKED: this exact call failed repeatedly. Do NOT repeat it — call find with the user\'s wording (or read_page) to obtain a VALID selector, then retry with the selector it returns.',
        })
        continue
      }

      // CICLO DEPURAÇÃO SISTEMÁTICA (B): screenshot em background — após 2
      // falhas de captura (aba de trabalho em segundo plano), a 3ª chamada
      // NÃO executa: result honesto + feedback dirigido (mesma família do
      // auto-find e do blocked_repeated_failed_call). Evita o turno queimando
      // steps tentando screenshot impossível (evidência 8d61dcb: 99 steps).
      if (tc.name === 'screenshot' && screenshotFailures >= 2) {
        allToolResults.push({
          toolCallId: tc.id,
          name: tc.name,
          success: false,
          data: null,
          error: 'screenshot_blocked_background_tab',
          durationMs: 0,
        })
        broadcast({
          type: MSG.AGENT_TOOL_RESULT,
          turnId,
          toolResult: {
            toolCallId: tc.id,
            success: false,
            data: null,
            error: 'screenshot_blocked_background_tab',
            durationMs: 0,
          },
        })
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: 'BLOCKED: screenshots failed twice because the working tab is in the background (captureVisibleTab only captures the visible tab). Screenshots are unavailable for this turn — use read_page to inspect the working tab.',
        })
        continue
      }

      // Broadcast what the LLM decided to do (panel shape).
      broadcast({
        type: MSG.AGENT_THOUGHT,
        turnId,
        text: `Calling ${tc.name}${tc.params?.url ? ` → ${tc.params.url}` : tc.params?.selector ? ` → ${tc.params.selector}` : ''}…`,
      })
      // Execute through the background's shared approval-aware controller.
      // That boundary emits AGENT_TOOL_EXECUTING only after policy approval.
      const execResult = await executeTool(tc, signal)
      const durationMs = Date.now() - startedAt
      if (attemptKey) {
        if (execResult.ok) {
          failedMutateCounts.delete(attemptKey)
        } else {
          failedMutateCounts.set(attemptKey, (failedMutateCounts.get(attemptKey) ?? 0) + 1)
        }
      }
      // PÓS-CAMPO-5: mutation outcome tracking (structural honesty).
      if (isMutate) {
        mutationAttempts += 1
        if (execResult.ok) {
          mutationSuccesses += 1
          lastMutateFailed = false
        } else {
          lastMutateFailed = true
        }
        inspectionSinceLastMutate = false
      }
      if (tc.name === 'read_page') {
        inspectionSinceLastMutate = true
      }
      // CICLO DEPURAÇÃO SISTEMÁTICA (B): screenshot em background — conta
      // falhas de captura (aba em segundo plano). Após a 2ª, feedback
      // system dirigido (use read_page); a 3ª chamada é bloqueada acima.
      if (!execResult.ok && tc.name === 'screenshot'
          && /segundo plano|background|captureVisibleTab/i.test(String(execResult.error ?? ''))) {
        screenshotFailures += 1
        if (screenshotFailures >= 2) {
          pendingSystemMessages.push(
            'Screenshots failed twice because the working tab is in the background (captureVisibleTab only captures the visible tab). ' +
            'Screenshots are unavailable for this turn — use read_page to inspect the working tab.',
          )
        }
      }
      // PÓS-CAMPO-4: automatic recovery — on the 2nd selector-not-found
      // failure of the same tool name (weak models ignore textual hints
      // and vary only the broken selector tail, so the exact-key dedup
      // above never fires), the LOOP runs find itself and feeds the REAL
      // selectors back as tool-role feedback before the next model step.
      // Bounded: 1 auto-find per tool name per turn; find is read-only
      // (no approval). Model-agnostic: no site/selector knowledge.
      if (!execResult.ok && (tc.name === 'type' || tc.name === 'click')
          && /selector not found|no element at coordinates/i.test(String(execResult.error ?? ''))
          && !autoFindUsed[tc.name]) {
        failedSelectorCounts[tc.name] = (failedSelectorCounts[tc.name] ?? 0) + 1
        if (failedSelectorCounts[tc.name] >= 2) {
          autoFindUsed[tc.name] = true
          const query = deriveAutoFindQuery(tc, userMessage)
          try {
            const findResult = await executeTool(
              { id: `autofind-${turnId}-${tc.name}`, name: 'find', params: { text: query } },
              signal,
            )
            const selectors = extractFindSelectors(findResult)
            // PÓS-GATE 4: SYSTEM message, NEVER a second tool message with
            // the failed call's tool_call_id — the OpenAI contract is 1:1
            // (one tool message per tool_call_id); duplicate ids are
            // rejected by strict routers. Same pattern as R-V4/reclassify.
            // PÓS-CAMPO-6 (A): the system is QUEUED and flushed after ALL
            // tool responses of this completion (adjacency contract) —
            // a system wedged between assistant(tool_calls) and its tools
            // is rejected by strict routers with HTTP 400.
            pendingSystemMessages.push(selectors.length > 0
              ? `Recovery: find located these selectors on the page: ${selectors.map((s) => `"${s}"`).join(', ')}. Use one of them for the retry.`
              : `Recovery: find found nothing for "${query}" — read the page with read_page to locate the target, then retry.`)
          } catch {
            /* auto-find is best-effort */
          }
        }
      }

      // Build text result for the conversation.
      // Tool role content remains a string. Vision pixels travel in a separate
      // user message after every tool response from this step has been added.
      let resultText = ''
      let screenshotDataUrl = null
      if (execResult.ok) {
        const raw = execResult.result
        if (inspectUntrustedBrowserContent(raw).suspicious) {
          promptInjectionDetected = true
        }
        if (typeof raw === 'string') {
          // G3-CHROME: full-page extraction keeps the WHOLE text — chunking
          // happens at message insertion below, never a silent truncation.
          resultText = tc.name === 'extract_page_content'
            ? raw
            : truncate(raw, MAX_RESULT_CHARS)
        } else if (raw && typeof raw === 'object') {
          if (raw.image || raw.dataUrl) {
            if (modelSupportsVision === true) {
              screenshotDataUrl = normalizeScreenshotDataUrl(raw.image ?? raw.dataUrl)
            }
            const meta = []
            if (raw.width) meta.push(`${raw.width}x${raw.height}`)
            if (raw.url) meta.push(`url=${raw.url}`)
            resultText = `Screenshot captured${meta.length ? ' (' + meta.join(', ') + ')' : ''}. Use read_page or click next; do not re-search unless needed.`
          } else if (raw.text) {
            // G3-CHROME: same full-text rule for object-shaped results.
            if (tc.name === 'read_page' && Array.isArray(raw.interactiveElements)) {
              resultText = truncate(JSON.stringify({
                interactiveElements: raw.interactiveElements,
                interactiveElementsTruncated: raw.interactiveElementsTruncated === true,
                text: String(raw.text),
              }), MAX_RESULT_CHARS)
            } else {
              resultText = tc.name === 'extract_page_content'
                ? String(raw.text)
                : truncate(String(raw.text), MAX_RESULT_CHARS)
            }
          } else if (Array.isArray(raw)) {
            resultText = truncate(JSON.stringify(raw), MAX_RESULT_CHARS)
          } else {
            resultText = truncate(JSON.stringify(raw), MAX_RESULT_CHARS)
          }
        } else {
          resultText = String(raw ?? 'ok')
        }
      } else {
        resultText = `Error: ${execResult.error}`
      }
      if (execResult.ok) {
        resultText = wrapUntrustedBrowserContent(resultText)
      }

      // Keep heavy blobs out of in-memory toolResults (panel only needs slim status).
      const storedData =
        execResult.ok && execResult.result && typeof execResult.result === 'object'
          && (execResult.result.image || execResult.result.dataUrl)
          ? {
              captured: true,
              width: execResult.result.width,
              height: execResult.result.height,
              format: execResult.result.format,
            }
          : execResult.ok
            ? (execResult.result ?? null)
            : null

      allToolResults.push({
        toolCallId: tc.id,
        name: tc.name,
        params: tc.params,
        success: execResult.ok,
        data: storedData,
        error: execResult.ok ? null : execResult.error,
        durationMs,
      })

      broadcast({
        type: MSG.AGENT_TOOL_RESULT,
        turnId,
        toolResult: {
          toolCallId: tc.id,
          success: execResult.ok,
          data: execResult.ok ? resultText.slice(0, 500) : null,
          error: execResult.ok ? null : execResult.error,
          durationMs,
        },
      })

      // Tool role content must stay a plain string (OpenAI-compatible).
      // G3-CHROME: full-page extractions are delivered as one message per
      // chunk so the model receives the ENTIRE page, nothing truncated.
      if (tc.name === 'extract_page_content' && resultText.length > MAX_RESULT_CHARS) {
        for (const chunk of chunkText(resultText, MAX_RESULT_CHARS)) {
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: chunk,
          })
        }
      } else {
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: resultText,
        })
      }
      if (screenshotDataUrl) {
        visualParts.push({
          type: 'image_url',
          image_url: { url: screenshotDataUrl },
        })
      }

      // Consecutive failure tracking — strategy hint, then early stop if still stuck.
      if (execResult.ok) {
        failStreak = { name: null, count: 0, afterHint: false }
        // requiresVerification é sobre EFEITO de mutação observável (R-V4):
        // click/type precisam de read_page depois; navigate mostra o efeito
        // no próprio tool result (a URL nova) — mantém a lista específica.
        if (tc.name === 'click' || tc.name === 'type') requiresVerification = true
        // R-V1/GENERALIZAÇÃO: only read_page (structured real text) clears
        // the verification flag. A screenshot does NOT — the model can aim
        // it at the wrong place (e.g. the input with the typed text instead
        // of the list with the new item), so a visual peek after a mutation
        // is not evidence of the effect.
        if (tc.name === 'read_page') requiresVerification = false
      } else if (failStreak.name === tc.name) {
        failStreak.count++
      } else {
        failStreak = { name: tc.name, count: 1, afterHint: false }
      }

      if (!execResult.ok) {
        if (failStreak.count >= 3 && !failStreak.afterHint) {
          // PÓS-CAMPO-6 (A): queued — flushed after all tool responses of
          // this completion (adjacency contract).
          pendingSystemMessages.push(STRATEGY_HINT)
          failStreak.afterHint = true
          failStreak.count = 0
          broadcast({
            type: MSG.AGENT_THOUGHT,
            turnId,
            text: 'Injected strategy hint after repeated failures — trying a different approach…',
          })
        } else if (failStreak.count >= 2 && failStreak.afterHint) {
          const lastError = execResult.error ?? 'unknown error'
          return {
            assistantMessage:
              `I hit persistent failures with \`${tc.name}\` (last error: ${lastError}). ` +
              `Tried a strategy change, but the same tool kept failing. Please try a different approach or a more specific instruction.`,
            toolResults: allToolResults,
          }
        }
      }

      // After successful navigate, give the page a moment to load before
      // asking the LLM for the next step.
      if (execResult.ok && tc.name === 'navigate') {
        lastWasSuccessfulNavigate = true
      }

      // YouTube watch page after click/navigate → pin "task done, reply now".
      if (execResult.ok && (tc.name === 'click' || tc.name === 'navigate')) {
        try {
          const meta = await getPostActionTabMeta(getActiveTabMeta, tc, execResult)
          if (meta?.url && /youtube\.com\/watch/i.test(meta.url)) {
            browserActionsComplete = true
            requiresVerification = false
            // PÓS-CAMPO-6 (A): queued — flushed after all tool responses.
            pendingSystemMessages.push(
              'You are now on a YouTube /watch page — the video is open. ' +
              'Do NOT search again, do NOT navigate to results, do NOT screenshot. ' +
              'Reply to the user with a brief confirmation in their language and stop calling tools.',
            )
          }
        } catch {
          /* meta is best-effort */
        }
      }

      if (browserActionsComplete) break
    }

    // PÓS-CAMPO-6 (A): ADJACENCY contract — an assistant message with
    // tool_calls must be followed IMMEDIATELY by its tool responses.
    // System messages produced inside the execution loop (auto-find
    // recovery, STRATEGY_HINT, the YouTube pin) are flushed HERE, after
    // every tool response of this completion, so the payload is
    // [assistant(tool_calls)] [tool xN] [system ...] — never a system
    // wedged between the assistant and its tools (strict routers reject
    // that with HTTP 400, surfaced as "model connection interrupted").
    for (const pendingContent of pendingSystemMessages) {
      messages.push({ role: 'system', content: pendingContent })
    }
    // B-1 (gate DEPURACAO-SISTEMATICA): esvazia a fila após o drain — sem
    // isso a dica (ex.: screenshot use read_page) repetia linearmente
    // ([0,0,1,2] medido) porque os itens antigos eram re-flushados a cada
    // completion.
    pendingSystemMessages.length = 0

    // R7/FRENTE-C: some emitted names were dropped at parse time while
    // others executed. Tell the model which names were invalid so it can
    // self-correct on the next step instead of repeating the mistake.
    if ((completion.droppedToolNames?.length ?? 0) > 0) {
      messages.push({
        role: 'system',
        content: `The following tool names you emitted are not available: ${
          [...new Set(completion.droppedToolNames)].join(', ')
        }. Re-issue the action using one of: navigate, read_page, find, extract_page_content, structured_extract, click, type, screenshot, tabs, tab_group.`,
      })
    }

    if (signal?.aborted) throw new Error('Agent turn cancelled')

    if (visualParts.length > 0) {
      const visualMessageIndex = messages.length
      messages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Visual context from the current browser viewport. Inspect it before choosing the next action.',
          },
          ...visualParts,
        ],
      })
      pendingVisualMessageIndexes.push(visualMessageIndex)
    }

    if (lastWasSuccessfulNavigate) {
      await sleep(POST_NAVIGATE_DELAY_MS)
    }
  }

  if (signal?.aborted) throw new Error('Agent turn cancelled')

  // Reached max steps without text-only response.
  return {
    assistantMessage: looksPortuguese(userMessage)
      ? `Execução incompleta: alcancei o limite de ${MAX_AGENT_STEPS} etapas antes de concluir e verificar o pedido.`
      : `Incomplete execution: I reached the ${MAX_AGENT_STEPS}-step limit before completing and verifying the request.`,
    toolResults: allToolResults,
  }
}

// ── Helpers ──────────────────────────────────────────────────

/**
 * Keep only bounded user/assistant text from the visible panel conversation.
 * System and tool roles are deliberately rejected so panel data cannot inject
 * privileged cross-turn instructions or stale tool-call protocol messages.
 *
 * @param {unknown} history
 * @returns {Array<{role:'user'|'assistant', content:string}>}
 */
function sanitizeConversationHistory(history) {
  if (!Array.isArray(history)) return []
  return history
    .filter((message) =>
      message &&
      typeof message === 'object' &&
      (message.role === 'user' || message.role === 'assistant') &&
      typeof message.content === 'string' &&
      message.content.trim().length > 0,
    )
    .slice(-MAX_HISTORY_MESSAGES)
    .map((message) => ({
      role: message.role,
      content: message.content.trim().slice(0, MAX_HISTORY_MESSAGE_CHARS),
    }))
}

/**
 * Decide whether a turn explicitly asks Verboo to interact with Chrome.
 * Defaulting to conversation is intentional: an unrelated active page must
 * never turn a general-knowledge question into a browsing session.
 *
 * This is a language-level intent guard, not a model or provider allowlist.
 * The Router still decides which browser tools to use after the guard opens.
 *
 * B1-CHROME: the criterion is INTENT, not spelling. A request that can only
 * be fulfilled by looking at / acting on the current page opens the tools.
 * When in doubt the guard LIBERATES — the asymmetry decides: exposing tools
 * in a conversation turn costs almost nothing (the model simply won't use
 * them), while denying in an action turn makes the extension look dumb.
 * The reclassification fallback in runLlmAgentTurn catches the residual
 * classifier misses regardless of phrasing.
 *
 * @param {string} userMessage
 * @param {unknown} [conversationHistory]
 * @param {string | null | undefined} [activeTabUrl] — URL of the page under
 *   the panel (optional, fail-safe: L2 only fires with a controllable URL).
 * @returns {boolean}
 */
export function shouldOfferBrowserTools(userMessage, conversationHistory = [], activeTabUrl) {
  const text = normalizeIntentText(userMessage)

  if (!text) return false
  if (isInterruptedBrowserResume(text, conversationHistory)) return true
  if (requiresScreenshot(text)) return true

  const action =
    '(?:abra|abre|abrir|acesse|acessa|acessar|navegue|navegar|va|vai|entre|entrar|' +
    'clique|clica|clicar|digite|digitar|preencha|preencher|pesquise|pesquisa|pesquisar|' +
    'procure|procurar|busque|busca|buscar|toque|toca|tocar|reproduza|reproduzir|' +
    'coloque|coloca|colocar|pause|pausar|feche|fecha|fechar|recarregue|recarregar|' +
    'role|rolar|mude|mudar|curta|curtir|siga|seguir|faca login|fazer login|' +
    'open|go to|navigate|visit|click|type|fill|search|find|play|put on|' +
    'pause|close|reload|scroll|switch|submit|upload|download|like|follow|' +
    'log in|sign in)'

  const directAction = new RegExp(
    `^(?:(?:por favor|please)[, ]+)?(?:me\\s+)?${action}\\b`,
    'i',
  )
  const requestedAction = new RegExp(
    `\\b(?:voce pode|pode|consegue|poderia|can you|could you|would you)\\s+(?:por favor\\s+)?(?:me\\s+)?${action}\\b`,
    'i',
  )
  const desiredAction = new RegExp(
    `\\b(?:quero|gostaria|preciso|i want|i need)\\s+(?:(?:que\\s+)?voce\\s+|you to\\s+)?${action}\\b`,
    'i',
  )

  if (directAction.test(text) || requestedAction.test(text) || desiredAction.test(text)) {
    return true
  }

  // L1/Intenção+UX: STRUCTURAL deictic imperative — any language, no verb
  // list. "crie o produto desta página", "add the item to this list" open
  // the browser tools because the object is anchored to the current page.
  // The anchor + page noun are load-bearing: "explique a teoria" and
  // "me conte sobre esta página" (knowledge questions) stay conversation.
  if (hasDeicticImperativeIntent(text)) return true

  // L2/Intenção+UX: imperative with a concrete object + a CONTROLLABLE
  // page under the panel — fall-open for implicit action requests
  // ("crie o produto ethos" on a page with a "Novo produto" button).
  // The URL check is synchronous and cheap (no content read); the
  // parameter is optional/fail-safe — without a URL, L2 never fires.
  // chrome://, edge://, about: etc. do NOT trigger it (guard 4).
  // Evaluation order (nit PÓS-GATE): action verbs → L1 (deictic anchor)
  // → L2 (imperative + controllable URL) → communication + destination
  // → page inspection. L3 (reclassify) is reached only in turns none of
  // the openers activated.
  if (activeTabUrl && isControllableUrl(activeTabUrl) && hasImperativeWithObject(text)) {
    return true
  }

  // Communication verbs need an explicit external destination. Phrases such
  // as "me mande uma explicação" are normal conversation, not browser control.
  const communicationAction =
    /^(?:(?:por favor|please)[, ]+)?(?:me\s+)?(?:mande|envie|publique|send|post|publish)\b/i
  const externalDestination =
    /\b(?:whatsapp|gmail|e-?mail|instagram|facebook|linkedin|twitter|formulario|form|site)\b/i
  if (communicationAction.test(text) && externalDestination.test(text)) return true

  return hasPageInspectionIntent(text)
}

function isInterruptedBrowserResume(text, conversationHistory) {
  if (!Array.isArray(conversationHistory)) return false
  const resumeIntent = /\b(?:continue|continua|continuar|retome|retoma|retomar|prossiga|seguir de onde|siga de onde|reinicie|reinicia|reiniciar|resume|pick up|restart)\b/i
  if (!resumeIntent.test(text)) return false
  return conversationHistory.slice(-4).some((message) => (
    message?.role === 'assistant'
    && typeof message.content === 'string'
    && message.content.includes('Execução interrompida pelo usuário')
    && message.content.includes('O pedido ainda não foi concluído')
  ))
}

/**
 * Shared page-inspection intent detector used by shouldOfferBrowserTools and
 * shouldFallbackToPageRead. INTENT, not spelling: any signal that the request
 * can only be fulfilled by looking at the current page opens the read tools.
 * The asymmetry decides — when in doubt, liberate; the reclassification
 * fallback in runLlmAgentTurn catches the residual misses.
 *
 * Page reference: the user points at the CURRENT page/tab/site with a
 * demonstrative (`esta/essa/desta/dessa/na/nesta/nessa/...`) OR an article +
 * page noun + current-qualifier (`a/da/na/o/do pagina/aba atual/inicial`).
 *
 * INTENTIONAL EXCLUSIONS — `no site da Apple` stays a general-knowledge
 * question: `no`/`num` are bare prepositions and `da Apple` carries no
 * current-qualifier, so article forms only count when the qualifier says
 * current (atual/aberta/aberto/inicial/home/current). They were briefly
 * added in an earlier cycle and reverted after the Maestro measured the
 * false positive. References to book pages or past content (`na pagina 47`,
 * `that page yesterday`) stay conversation.
 *
 * `olhe`/`look`/`show` alone are discourse markers in PT/EN ("olhe, eu acho
 * que..."), so the CONJUNCTION with pageReference below is the load-bearing
 * gate for that family — see the test "olhe alone, no page reference,
 * denies browser tools".
 *
 * `ve` is split out of the alternation into its own guarded regex because
 * the apostrophe is a word boundary, so bare `ve` was matching inside
 * English contractions `I've`/`you've`/`we've`. The guard `(?<![''])`
 * rejects matches preceded by an apostrophe (manifest requires Chrome 123,
 * lookbehind is supported).
 *
 * @param {string} text normalized intent text
 */
function hasPageInspectionIntent(text) {
  const pageReference =
    /\b(?:esta|essa|desta|dessa|nesta|nessa|neste|nesse|nestes|nesses|this|current)\s+(?:pagina|page|aba|tab|site|tela|screen|documento|document|html|dom)\b|\b(?:a|o|da|do|na|no)\s+(?:pagina|page|aba|tab|site|tela|screen|documento|document|html|dom)\s+(?:atual|aberta|aberto|aqui|current|inicial|home)\b/i
  // Page inspection: the user asks to look at / read / describe what's
  // on the page.
  // PÓS-GATE Farol: explain/define joined the inspection family so the
  // PAGE-anchored explanation path stays browser ("explique esta página",
  // "explain this page") while the topic explanation stays conversation
  // (gated by EXPLANATION_GATE_RE in intentSignals.js). Both sides tested.
  const pageInspection =
    /\b(?:resuma|resume|leia|ler|analise|verifique|veja|explique|defina|descreva|diga o que|o que tem|o que esta|o que diz|o que aparece|o que ha|o que e|qual conteudo|extraia|extrair|copie|copiar|olhe|olha|olhar|mostre|mostra|mostrar|summarize|read|analyze|check|inspect|explain|define|describe|look|show|see|extract|what is on|what's on|what is visible)\b/i
  const bareVe = /(?<!['’])\bve\b/i

  // Some users omit the space in `o que` (`oque`) or point at a
  // selection with a short deictic question (`o que é isso?`). These
  // are still current-page inspection requests in the browser panel.
  const deicticInspection =
    /\b(?:o\s*que|qual|me diga|diga|explique|descreva)\s+(?:e|significa|diz|tem|ha|aparece|vejo|ve)\s+(?:isso|isto|aqui)\b/i
  const contentInspection =
    /\b(?:ver|ve|ler|leia|ler|extrair|extraia|extrai|copiar|copie|acessar|acesso|consegue|pode)\b.{0,64}\b(?:conteudo|html|dom|texto|body)\b/i
  // Current-page state question WITHOUT an imperative verb: "quais videos
  // aparecem ai?", "quais videos aparecem na aba inicial?" — the intent is
  // deictic. The anchor (ai/aqui, demonstrative + page noun, or preposition
  // + page noun + current-qualifier) is load-bearing: without it "quais
  // filmes existem" stays general knowledge.
  const currentPageStateQuestion =
    /\b(?:quais|o que|oqe|que|qual)\b.{0,40}?\b(?:aparecem|aparece|estao|esta|tem|ha|vendo|vejo|existem|existe)\b.{0,30}\b(?:ai|aqui|(?:nessa|nesta|nesse|neste|essa|esta)\s+(?:aba|pagina|tela|tab|screen|page|site)\b|(?:na|da|a|em|o|do)\s+(?:aba|pagina|tela|tab|screen|page|site)\s+(?:atual|aberta|aberto|inicial|home|current)\b)/i

  return (
    (pageReference.test(text) && (pageInspection.test(text) || bareVe.test(text))) ||
    deicticInspection.test(text) ||
    contentInspection.test(text) ||
    currentPageStateQuestion.test(text)
  )
}

/**
 * Keep saved instructions in the user-owned message instead of elevating them
 * into the system role.
 *
 * @param {string} userMessage
 * @param {{name?:string,instructions?:string}|null|undefined} routineContext
 */
export function appendSavedRoutineContext(userMessage, routineContext) {
  if (!routineContext) return userMessage
  const name = escapeRoutineMarkup(String(routineContext.name ?? 'Routine').slice(0, 80))
  const instructions = escapeRoutineClosingTag(
    String(routineContext.instructions ?? '').slice(0, 32_000),
  )
  let content = (
    `${String(userMessage ?? '').trim()}\n\n` +
    `<saved_routine name="${name}">\n` +
    'User-authored reusable instructions:\n' +
    `${instructions}\n` +
    '</saved_routine>'
  )
  for (const asset of routineContext.assets ?? []) {
    if (typeof asset?.data !== 'string') continue
    const filename = escapeRoutineMarkup(String(asset.name ?? 'reference').slice(0, 180))
    const mime = escapeRoutineMarkup(String(asset.mime ?? 'text/plain').slice(0, 80))
    const text = escapeRoutineClosingTag(asset.data.slice(0, 262_144))
    content += (
      `\n\n<saved_routine_file name="${filename}" mime="${mime}">\n` +
      `${text}\n` +
      '</saved_routine_file>'
    )
  }
  return content
}

async function buildRoutineUserContent(userMessage, routineContext, supportsVision) {
  const text = appendSavedRoutineContext(userMessage, routineContext)
  if (!routineContext || !supportsVision) return text

  const imageParts = []
  for (const asset of routineContext.assets ?? []) {
    if (!String(asset?.mime ?? '').startsWith('image/')) continue
    const dataUrl = await assetDataUrl(asset)
    if (dataUrl) {
      imageParts.push({
        type: 'image_url',
        image_url: { url: dataUrl },
      })
    }
  }
  return imageParts.length > 0
    ? [{ type: 'text', text }, ...imageParts]
    : text
}

function escapeRoutineMarkup(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function escapeRoutineClosingTag(value) {
  return value.replace(/<\/?saved_routine(?:_file)?/gi, (match) =>
    match.replace('<', '&lt;'),
  )
}

async function assetDataUrl(asset) {
  if (typeof asset.data === 'string' && asset.data.startsWith('data:image/')) {
    return asset.data
  }
  if (!asset.data || typeof asset.data.arrayBuffer !== 'function') return null
  const bytes = new Uint8Array(await asset.data.arrayBuffer())
  let binary = ''
  const chunkSize = 32_768
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }
  return `data:${asset.mime};base64,${btoa(binary)}`
}

/**
 * Whether the user's requested outcome itself is a captured viewport image.
 * Printing a document is intentionally excluded from this classifier.
 *
 * @param {string} userMessage
 */
export function requiresScreenshot(userMessage) {
  const text = normalizeIntentText(userMessage)
  if (!text) return false
  if (/\b(?:screenshot|screen shot|captura de tela|print da (?:tela|pagina))\b/i.test(text)) {
    return true
  }
  return /\b(?:tire|tirar|faca|fazer|take|capture)\b.{0,24}\b(?:um |uma |a )?(?:print|screenshot|screen shot|captura)\b/i.test(text)
}

/** @param {unknown} value */
function normalizeIntentText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\boque\b/g, 'o que')
    .trim()
    .toLowerCase()
}

/**
 * Whether a browser-enabled turn is an explicit request to inspect the
 * current page. This intentionally excludes mutations and screenshot asks:
 * only a safe, read-only `read_page(body)` call may be synthesized here when
 * a model omits the tool protocol.
 *
 * @param {string} userMessage
 */
function shouldFallbackToPageRead(userMessage) {
  const text = normalizeIntentText(userMessage)
  if (!text || requiresScreenshot(text)) return false
  return hasPageInspectionIntent(text)
}

/**
 * Remove identical tool calls from a single assistant response. Parallel tool
 * calling is useful for independent reads, but repeating the same mutation is
 * never a valid substitute for a deliberate double-click operation.
 *
 * @param {Array<{id:string,name:string,arguments:string}>} toolCalls
 * @returns {Array<{id:string,name:string,arguments:string}>}
 */
function dedupeToolCalls(toolCalls) {
  const seen = new Set()
  const unique = []
  for (const toolCall of toolCalls) {
    const key = `${toolCall.name}:${canonicalJson(toolCall.arguments)}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(toolCall)
  }
  return unique
}

/**
 * PÓS-CAMPO-4: derive the auto-find query for a failed type/click.
 * For type, the typed text is the best needle (the value the user wants
 * committed). For click, the model does not carry a name in params, so
 * the user's own wording is the needle (it usually names the target —
 * "clique no botão Novo produto"); when the model did mention an
 * accessible name in its reasoning, that lives in the messages and the
 * user wording remains the deterministic fallback. Model-agnostic.
 *
 * @param {{ name: string; params?: Record<string, unknown> }} tc
 * @param {string} userMessage
 * @returns {string}
 */
function deriveAutoFindQuery(tc, userMessage) {
  if (tc.name === 'type' && typeof tc.params?.text === 'string' && tc.params.text.trim()) {
    return tc.params.text.trim().slice(0, 120)
  }
  return String(userMessage ?? '').trim().slice(0, 120)
}

/**
 * Extract the selector list from a find tool result. The find result is
 * either an array of { selector } objects or a text summary of the form
 * '[1] text="…" tag=… selector="a[href=…]"'.
 *
 * @param {unknown} findResult
 * @returns {string[]}
 */
function extractFindSelectors(findResult) {
  const raw = findResult?.result
  if (Array.isArray(raw)) {
    return raw
      .map((match) => match?.selector)
      .filter((s) => typeof s === 'string' && s.length > 0)
  }
  const text = typeof raw?.text === 'string' ? raw.text : ''
  return [...text.matchAll(/selector="([^"]+)"/g)].map((match) => match[1])
}

/** @param {string} json */
function canonicalJson(json) {
  try {
    return JSON.stringify(sortJsonValue(JSON.parse(json)))
  } catch {
    return String(json ?? '').trim()
  }
}

/** @param {unknown} value */
function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (!value || typeof value !== 'object') return value
  const obj = /** @type {Record<string, unknown>} */ (value)
  return Object.fromEntries(
    Object.keys(obj)
      .sort()
      .map((key) => [key, sortJsonValue(obj[key])]),
  )
}

/**
 * YouTube updates its URL asynchronously after an SPA thumbnail click. Poll
 * only when the click originated on YouTube; other websites keep the existing
 * zero-delay behavior.
 *
 * @param {Function} getActiveTabMeta
 * @param {{name:string}} toolCall
 * @param {{result?:unknown}} execResult
 * @returns {Promise<object | null | undefined>}
 */
async function getPostActionTabMeta(getActiveTabMeta, toolCall, execResult) {
  let meta = await getActiveTabMeta()
  if (meta?.url && /youtube\.com\/watch/i.test(meta.url)) return meta

  const result = execResult?.result
  const sourceUrl = result && typeof result === 'object' && typeof result.url === 'string'
    ? result.url
    : ''
  const shouldPoll = toolCall.name === 'click' && /youtube\.com\//i.test(sourceUrl)
  if (!shouldPoll) return meta

  for (let attempt = 0; attempt < YOUTUBE_WATCH_POLL_ATTEMPTS; attempt++) {
    await sleep(YOUTUBE_WATCH_POLL_MS)
    meta = await getActiveTabMeta()
    if (meta?.url && /youtube\.com\/watch/i.test(meta.url)) return meta
  }
  return meta
}

/**
 * User-facing summary when the router dies mid-turn after some tools succeeded.
 * Avoids destructive planMessage re-search and keeps the user's language.
 * @param {string} userMessage
 * @param {Array<object>} toolResults
 * @returns {string}
 */
/**
 * PÓS-CAMPO-5: structural honesty for the final assistant message.
 *
 * 1. If EVERY mutation of the turn failed (mutationAttempts > 0 and
 *    mutationSuccesses === 0), the model's text is REPLACED by the honest
 *    mechanical summary — no claim of success can reach the panel when
 *    nothing committed. Same i18n pattern as summarizePartialAgentTurn.
 * 2. If mutations succeeded but the LAST mutate failed and no read_page
 *    inspection happened after it, the honest note is APPENDED (not a
 *    replacement).
 *
 * The conditions are 100% structural — the model's text is never
 * interpreted.
 *
 * @param {string} assistantText
 * @param {string} userMessage
 * @param {unknown[]} toolResults
 * @param {{ mutationAttempts: number, mutationSuccesses: number, lastMutateFailed: boolean, inspectionSinceLastMutate: boolean }} stats
 * @returns {string}
 */
function honestTurnMessage(assistantText, userMessage, toolResults, stats) {
  const { mutationAttempts, mutationSuccesses, lastMutateFailed, inspectionSinceLastMutate } = stats
  const pt = looksPortuguese(userMessage)

  if (mutationAttempts > 0 && mutationSuccesses === 0) {
    const errors = [...new Set(
      (Array.isArray(toolResults) ? toolResults : [])
        .filter((r) => r && r.success === false && typeof r.error === 'string' && r.error.length > 0)
        .map((r) => r.error),
    )].slice(0, 3).join('; ')
    const attempts = pt
      ? (mutationAttempts === 1 ? '1 tentativa falhou' : `${mutationAttempts} tentativas falharam`)
      : (mutationAttempts === 1 ? '1 attempt failed' : `${mutationAttempts} attempts failed`)
    return pt
      ? `Nenhuma ação foi concluída na página — ${attempts}${errors ? `: ${errors}` : ''}.`
      : `No action completed on the page — ${attempts}${errors ? `: ${errors}` : ''}.`
  }

  if (mutationSuccesses > 0 && lastMutateFailed && !inspectionSinceLastMutate) {
    return `${assistantText}\n\n${pt
      ? 'Nota: a última ação falhou e o resultado não foi verificado.'
      : 'Note: the last action failed and the result was not verified.'}`
  }

  return assistantText
}

export function summarizePartialAgentTurn(userMessage, toolResults) {
  const results = Array.isArray(toolResults) ? toolResults : []
  const ok = results.filter((r) => r && r.success).length
  const names = results.map((r) => r?.name).filter(Boolean)
  const didClick = names.includes('click')
  const didNav = names.includes('navigate')
  const pt = looksPortuguese(userMessage)

  if (pt) {
    if (didClick || didNav) {
      return `Execução parcial: ${ok} ação(ões) ocorreram, mas o pedido não foi concluído nem verificado porque a conexão com o modelo foi interrompida.`
    }
    return ok > 0
      ? `Fiz ${ok} ação(ões), mas a conexão com o modelo falhou no final. Tente de novo se precisar.`
      : 'Não consegui concluir o pedido. Tente novamente.'
  }

  if (didClick || didNav) {
    return `Partial execution: ${ok} action(s) ran, but the request was not completed or verified because the model connection was interrupted.`
  }
  return ok > 0
    ? `I completed ${ok} action(s), but the model connection failed at the end. Try again if needed.`
    : 'I could not complete the request. Please try again.'
}

/**
 * Pin the final assistant language to the user's message language.
 * Prefer explicit PT markers; default to "same language as the user".
 * @param {string} userMessage
 * @returns {string}
 */
export function languageDirectiveFor(userMessage) {
  const text = typeof userMessage === 'string' ? userMessage : ''
  if (looksPortuguese(text)) {
    return (
      'LANGUAGE LOCK: The user wrote in Portuguese. Your final assistant message ' +
      '(the text reply when you stop calling tools) MUST be in Brazilian Portuguese (pt-BR). ' +
      'Do not answer in English.'
    )
  }
  if (looksEnglish(text)) {
    return (
      'LANGUAGE LOCK: The user wrote in English. Your final assistant message ' +
      'MUST be in English.'
    )
  }
  return (
    'LANGUAGE LOCK: Write your final assistant message in the same language as the user message above. ' +
    'Do not switch to English unless the user wrote in English.'
  )
}

/**
 * Give the selected model an authoritative, runtime-derived identity. A model
 * cannot reliably infer the Router selection from conversational context alone.
 * @param {string} modelId
 * @param {boolean | undefined} supportsVision
 * @returns {string}
 */
export function modelIdentityDirectiveFor(modelId, supportsVision) {
  const safeModelId = String(modelId ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 200)
  const visualLine = supportsVision === true
    ? 'VISUAL INPUT: Available. Screenshot pixels will be provided in a multimodal user message after the screenshot tool runs.'
    : 'VISUAL INPUT: Unavailable. Use read_page and DOM tools; never claim that you can see a screenshot.'
  return (
    `CURRENT MODEL ID: ${safeModelId}\n` +
    'This exact ID was selected by the user for the current turn. If asked which model you are using, ' +
    'state this exact ID. Do not infer or substitute another model or provider name.\n' +
    visualLine
  )
}

/**
 * Lightweight PT detector — enough for agent turns without a full i18n stack.
 * @param {string} text
 */
function looksPortuguese(text) {
  if (!text) return false
  if (/[áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ]/.test(text)) return true
  // Common PT browser-agent phrases (with and without accents).
  return (
    /\b(abra|abre|abrir|coloque|coloca|procure|pesquis[ae]|toque|tocar|m[uú]sica|musica|v[ií]deo|video|clipe|para|com|uma|o|a|de|da|do|no|na|eu|quero|pode|por\s+favor|obrigad[oa])\b/i.test(
      text,
    ) &&
    // Avoid treating pure EN "a/to/the" noise as PT when no PT tokens beyond stopwords.
    /\b(abra|abre|abrir|coloque|coloca|procure|pesquis|toque|tocar|m[uú]sica|musica|clipe|quero|pode|obrigad)\w*\b/i.test(
      text,
    )
  )
}

/**
 * @param {string} text
 */
function looksEnglish(text) {
  if (!text) return false
  return /\b(open|go to|search|play|put on|find|please|the|and|for|with|youtube|music|song|video)\b/i.test(
    text,
  )
}

function promptInjectionStopMessage(userMessage) {
  return looksPortuguese(userMessage)
    ? 'Interrompi antes de executar uma nova ação porque a página contém conteúdo suspeito de prompt injection. Revise a página e faça um novo pedido explícito se quiser continuar.'
    : 'I stopped before executing another action because the page contains suspected prompt injection content. Review the page and make a new explicit request if you want to continue.'
}

/** @param {unknown} value */
function normalizeScreenshotDataUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  if (/^data:image\/(?:png|jpe?g|webp);base64,/i.test(value)) return value
  return `data:image/jpeg;base64,${value}`
}

function truncate(text, max) {
  if (text.length <= max) return text
  return text.slice(0, max - 20) + '\n…(truncated)'
}

/**
 * G3-CHROME: split a full-page extraction into per-message chunks so the
 * whole document reaches the model (each tool message stays within
 * MAX_RESULT_CHARS).
 * @param {string} text
 * @param {number} max
 * @returns {string[]}
 */
function chunkText(text, max) {
  if (text.length <= max) return [text]
  const chunks = []
  for (let start = 0; start < text.length; start += max) {
    chunks.push(text.slice(start, start + max))
  }
  return chunks
}

/**
 * G2-CHROME: closing summary synthesized from executed tool results when
 * the model returns an empty final reply after real actions.
 * @param {string} userMessage
 * @param {Array<{ name?: string; success?: boolean }>} toolResults
 * @returns {string}
 */
export function synthesizeClosingSummary(userMessage, toolResults) {
  const results = Array.isArray(toolResults) ? toolResults : []
  const ok = results.filter((r) => r && r.success).length
  const names = [...new Set(results.map((r) => r?.name).filter(Boolean))]
  const actions = names.length > 0 ? names.join(', ') : `${ok} ação(ões)`
  const pt = looksPortuguese(userMessage)
  return pt
    ? `Concluído: executei ${ok} ação(ões) no navegador (${actions}) conforme o pedido.`
    : `Done: I executed ${ok} browser action(s) (${actions}) as requested.`
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

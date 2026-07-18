/**
 * loop.js — multi-step LLM agent loop.
 *
 * Flow:
 *   1. Build messages array with system prompt + user message
 *   2. Call LLM via routerClient.chatCompletion
 *   3. If response has no tool_calls → done (assistant message)
 *   4. For each tool_call → broadcast thought → executeTool callback → broadcast result
 *   5. Tool results are role:'tool' string messages (OpenAI protocol)
 *   6. If screenshot → after all tool messages, attach as image_url user message
 *   7. Repeat up to MAX_STEPS (10)
 *   8. On any error → throw (background falls back to planMessage heuristic)
 *
 * Policy gate: executeTool callback MUST go through the existing
 * execute() → evaluateToolPolicy path. This module never touches chrome.*.
 *
 * Approval: elevated tools may return needsApproval without running (execute.js).
 * In Skip mode normal tools run; elevated tools still need panel approval wiring.
 * MVP: when needsApproval, we broadcast AGENT_TOOL_REQUEST and surface the error.
 *
 * Multi-user: zero hardcoded accounts.
 */

import { chatCompletion } from './routerClient.js'
import { OPENAI_TOOLS, toToolCall } from './toolCatalog.js'
import { MSG } from '../controller/protocol.js'

const MAX_STEPS = 10
const MAX_RESULT_CHARS = 4000
const NAVIGATE_SETTLE_MS = 1500

/**
 * System prompt for the browser agent. Bilingual EN+PT to handle mixed requests.
 */
const SYSTEM_PROMPT = `You are Verboo, a browser agent that controls Chrome via tools.

CAPABILITIES:
- Navigate to websites (always use full https:// URLs)
- Read page content via CSS selectors
- Click elements (buttons, links, video thumbnails)
- Type text into input fields
- Take screenshots to see the visual state of the page
- Manage browser tabs

IMPORTANT RULES:
- NEVER use chrome://, chrome-extension://, about:, or edge:// URLs
- After navigating to a page, WAIT for the page to load before acting. Read the page first.
- Prefer precise CSS selectors (e.g. a#video-title, ytd-video-renderer a, input#search)
- For YouTube music/video: navigate to https://www.youtube.com/results?search_query=... then screenshot then click a#video-title or ytd-video-renderer a#video-title
  Good selectors: a#video-title, ytd-video-renderer a#video-title, ytd-rich-item-renderer a
- For search: navigate to the search engine, type the query, submit
- For reading a page: use read_page with a targeted selector, not the whole body when possible
- Return a brief text summary when you finish the task
- Never invent or fabricate selectors — only use ones you can see from page content

PT-BR: Você também pode responder em português brasileiro quando o usuário usar PT.`

/**
 * Run a multi-step LLM agent turn.
 *
 * @param {{ turnId: string, userMessage: string, apiKey: string, modelId: string, broadcast: Function, executeTool: Function, getActiveTabMeta: Function, signal?: AbortSignal }} params
 * @returns {Promise<{ assistantMessage: string, toolResults: Array<object> }>}
 */
export async function runLlmAgentTurn({
  turnId,
  userMessage,
  apiKey,
  modelId,
  broadcast,
  executeTool,
  getActiveTabMeta,
  signal,
}) {
  if (!apiKey) throw new Error('LLM agent: apiKey is required')
  if (!modelId) throw new Error('LLM agent: modelId is required')

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
  ]

  // Seed with current page context if available (text only — no fake tool_calls).
  const tabMeta = await getActiveTabMeta()
  if (tabMeta?.url && !isInternalUrl(tabMeta.url)) {
    messages.push({
      role: 'user',
      content: `[Current page: ${tabMeta.url}${tabMeta.title ? ` — ${tabMeta.title}` : ''}]`,
    })
  }

  messages.push({ role: 'user', content: userMessage })

  /** @type {Array<object>} */
  const allToolResults = []

  for (let step = 0; step < MAX_STEPS; step++) {
    broadcast({
      type: MSG.AGENT_THOUGHT,
      turnId,
      text: step === 0
        ? `Analyzing request with ${modelId}…`
        : `Step ${step + 1}/${MAX_STEPS} — continuing…`,
      modelId,
    })

    const completion = await chatCompletion({
      apiKey,
      model: modelId,
      messages,
      tools: OPENAI_TOOLS,
      signal,
    })

    // Text-only response → done.
    if (completion.toolCalls.length === 0) {
      const text = completion.content ?? 'Done.'
      return { assistantMessage: text, toolResults: allToolResults }
    }

    // Add assistant message (with tool_calls) to conversation.
    messages.push({
      role: 'assistant',
      content: completion.content,
      tool_calls: completion.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      })),
    })

    // Execute each tool call; push OpenAI-protocol tool messages (string content only).
    let screenshotDataUrl = null

    for (const rawTc of completion.toolCalls) {
      if (signal?.aborted) break

      const tc = toToolCall(rawTc)

      // Broadcast what the LLM decided to do.
      broadcast({
        type: MSG.AGENT_THOUGHT,
        turnId,
        text: `Calling ${tc.name}${tc.params?.url ? ` → ${tc.params.url}` : tc.params?.selector ? ` → ${tc.params.selector}` : ''}…`,
      })

      broadcast({
        type: MSG.AGENT_TOOL_EXECUTING,
        turnId,
        toolCallId: tc.id,
        toolName: tc.name,
      })

      // Execute via the existing policy-gated execute path.
      const execResult = await executeTool(tc)

      // Elevated / approval-gated tools: execute returns without running.
      // Broadcast AGENT_TOOL_REQUEST so the panel can show approval UI when wired.
      // MVP (Skip mode): most tools run; elevated may still fail until panel approval is connected.
      if (!execResult.ok && execResult.policy?.needsApproval) {
        broadcast({
          type: MSG.AGENT_TOOL_REQUEST,
          turnId,
          toolCall: tc,
          policyDecision: execResult.policy,
        })
      }

      // Build the tool result for the conversation (STRING only for role:tool).
      let resultText = ''
      if (execResult.ok) {
        const raw = execResult.result
        if (typeof raw === 'string') {
          resultText = truncate(raw, MAX_RESULT_CHARS)
        } else if (raw && typeof raw === 'object') {
          // Screenshot → strip dataUrl from text; attach as separate user message later.
          if (raw.image || raw.dataUrl) {
            screenshotDataUrl = raw.image ?? raw.dataUrl
            const meta = []
            if (raw.width) meta.push(`${raw.width}x${raw.height}`)
            if (raw.url) meta.push(`url=${raw.url}`)
            resultText = `Screenshot captured${meta.length ? ' (' + meta.join(', ') + ')' : ''}.`
          } else if (raw.text) {
            resultText = truncate(String(raw.text), MAX_RESULT_CHARS)
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

      allToolResults.push({
        toolCallId: tc.id,
        ok: execResult.ok,
        result: resultText,
        policy: execResult.policy,
      })

      broadcast({
        type: MSG.AGENT_TOOL_RESULT,
        turnId,
        toolResult: {
          toolCallId: tc.id,
          success: execResult.ok,
          data: execResult.ok ? resultText : undefined,
          error: execResult.ok ? undefined : execResult.error,
          durationMs: 0,
        },
      })

      // OpenAI protocol: each tool result is a string content tool message.
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: resultText,
      })

      // After successful navigate, give the page time to settle before next step.
      if (execResult.ok && tc.name === 'navigate') {
        await new Promise((r) => setTimeout(r, NAVIGATE_SETTLE_MS))
      }
    }

    // Screenshots: after ALL tool messages, attach image as a multimodal user message.
    if (screenshotDataUrl) {
      const url = screenshotDataUrl.startsWith('data:')
        ? screenshotDataUrl
        : `data:image/png;base64,${screenshotDataUrl}`
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: 'Screenshot of the current page for visual analysis:' },
          { type: 'image_url', image_url: { url } },
        ],
      })
    }

    // If aborted, stop here.
    if (signal?.aborted) break
  }

  // Reached max steps without text-only response.
  return {
    assistantMessage: `Completed ${allToolResults.length} action(s). Let me know if you need anything else.`,
    toolResults: allToolResults,
  }
}

// ── Helpers ──────────────────────────────────────────────────

function truncate(text, max) {
  if (text.length <= max) return text
  return text.slice(0, max - 20) + '\n…(truncated)'
}

function isInternalUrl(url) {
  if (!url || typeof url !== 'string') return true
  const lower = url.trim().toLowerCase()
  return !/^https?:\/\//i.test(lower)
}

/**
 * loop.js — multi-step LLM agent loop.
 *
 * Flow:
 *   1. Build messages array with system prompt + user message
 *   2. Call LLM via routerClient.chatCompletion
 *   3. If response has no tool_calls → done (assistant message)
 *   4. For each tool_call → broadcast thought → executeTool callback → broadcast result
 *   5. If screenshot → attach as image_url in next user message
 *   6. Repeat up to MAX_STEPS (10)
 *   7. On any error → throw (background falls back to planMessage heuristic)
 *
 * Policy gate: executeTool callback MUST go through the existing
 * execute() → evaluateToolPolicy path. This module never touches chrome.*.
 *
 * Broadcast shapes match panel.js expectations (see MSG constants):
 *   AGENT_THOUGHT       — { turnId, text, modelId? }
 *   AGENT_TOOL_EXECUTING— { turnId, toolCallId, toolName }
 *   AGENT_TOOL_RESULT   — { turnId, toolResult: { toolCallId, success, data?, error?, durationMs } }
 *
 * Multi-user: zero hardcoded accounts.
 */

import { chatCompletion } from './routerClient.js'
import { OPENAI_TOOLS, toToolCall } from './toolCatalog.js'
import { MSG } from '../controller/protocol.js'

const MAX_STEPS = 10
const MAX_RESULT_CHARS = 4000
const POST_NAVIGATE_DELAY_MS = 1500

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
- After navigating to a page, WAIT for the page to load before acting. Read the page first or take a screenshot.
- Prefer precise CSS selectors (e.g. a#video-title, ytd-video-renderer a, input#search)
- For YouTube music/video: navigate to youtube.com, type the search query, then click the best matching video link
  Good selectors: ytd-video-renderer a#video-title, a#video-title, ytd-rich-item-renderer a
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

  const messages = [{ role: 'system', content: SYSTEM_PROMPT }]

  // Seed with current page context as a system note (not a fake tool_call).
  const tabMeta = await getActiveTabMeta()
  if (tabMeta?.url && /^https?:\/\//i.test(tabMeta.url)) {
    messages.push({
      role: 'system',
      content: `[Current page: ${tabMeta.url}${tabMeta.title ? ` — ${tabMeta.title}` : ''}]`,
    })
  }

  messages.push({ role: 'user', content: userMessage })

  /** @type {Array<object>} */
  const allToolResults = []

  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal?.aborted) break

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

    // Execute each tool call → push role:tool message per call.
    let lastWasSuccessfulNavigate = false
    for (const rawTc of completion.toolCalls) {
      if (signal?.aborted) break

      const tc = toToolCall(rawTc)
      const startedAt = Date.now()

      // Broadcast what the LLM decided to do (panel shape).
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
      const durationMs = Date.now() - startedAt

      // Build text result for the conversation.
      let resultText = ''
      let screenshotDataUrl = null
      if (execResult.ok) {
        const raw = execResult.result
        if (typeof raw === 'string') {
          resultText = truncate(raw, MAX_RESULT_CHARS)
        } else if (raw && typeof raw === 'object') {
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
        success: execResult.ok,
        data: execResult.ok ? (execResult.result ?? null) : null,
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

      // Push role:tool message with the result. If it was a screenshot,
      // include the image as an image_url content part (OpenAI shape).
      if (screenshotDataUrl) {
        const url = screenshotDataUrl.startsWith('data:')
          ? screenshotDataUrl
          : `data:image/png;base64,${screenshotDataUrl}`
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: [
            { type: 'text', text: resultText },
            { type: 'image_url', image_url: { url } },
          ],
        })
      } else {
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: resultText,
        })
      }

      // After successful navigate, give the page a moment to load before
      // asking the LLM for the next step.
      if (execResult.ok && tc.name === 'navigate') {
        lastWasSuccessfulNavigate = true
      }
    }

    if (lastWasSuccessfulNavigate) {
      await sleep(POST_NAVIGATE_DELAY_MS)
    }
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

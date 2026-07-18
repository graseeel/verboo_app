/**
 * toolCatalog.js — OpenAI-style tool definitions for the LLM agent loop.
 *
 * These tools match the controller tools in src/controller/tools/.
 * The loop maps LLM tool_call → ToolCall (protocol shape) → execute().
 * Risk class is mapped from TOOL_RISK_MAP (protocol.js single source).
 *
 * Multi-user: zero hardcoded accounts/paths.
 */

import { TOOL_RISK_MAP } from '../controller/protocol.js'

/**
 * OpenAI function tool definitions sent to the LLM.
 * @type {Array<Object>}
 */
export const OPENAI_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'navigate',
      description: 'Navigate the active tab to a URL. Must be a valid http(s) URL. Never use chrome:// URLs.',
      parameters: {
        type: 'object',
        required: ['url'],
        properties: {
          url: { type: 'string', description: 'Full URL to navigate to (https://...)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_page',
      description: 'Read the text content of the current page or a specific CSS selector. Returns extracted text for analysis.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector to read (default: entire body)' },
          attribute: { type: 'string', description: 'Optional attribute to read instead of textContent' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'click',
      description: 'Click an element on the page by CSS selector. Use for buttons, links, video thumbnails.',
      parameters: {
        type: 'object',
        required: ['selector'],
        properties: {
          selector: { type: 'string', description: 'CSS selector of the element to click' },
          button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default: left)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'type',
      description: 'Type text into an input field or textarea by CSS selector.',
      parameters: {
        type: 'object',
        required: ['selector', 'text'],
        properties: {
          selector: { type: 'string', description: 'CSS selector of the input element' },
          text: { type: 'string', description: 'Text to type' },
          clear: { type: 'boolean', description: 'Clear field before typing (default: false)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'screenshot',
      description: 'Take a screenshot of the current tab. Returns a data URL image. Useful to see visual state of the page.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'tabs',
      description: 'List, open new, or switch between browser tabs.',
      parameters: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['list', 'new', 'switch'], description: 'Tab action' },
          url: { type: 'string', description: 'URL for "new" action' },
          tabId: { type: 'number', description: 'Tab id for "switch" action' },
        },
      },
    },
  },
]

/**
 * Get risk class for a tool name.
 * Falls back to 'elevated' (fail-safe — unknown tools always prompt).
 *
 * @param {string} toolName
 * @returns {'read'|'mutate'|'elevated'}
 */
export function getToolRisk(toolName) {
  return TOOL_RISK_MAP[toolName] ?? 'elevated'
}

/**
 * Map an LLM tool_call to a protocol ToolCall object.
 * Ready to pass directly into execute().
 *
 * @param {{ id: string, name: string, arguments: string }} toolCall
 * @returns {import('../controller/protocol.js').ToolCall}
 */
export function toToolCall(toolCall) {
  const params = parseArguments(toolCall.arguments)
  return {
    id: toolCall.id,
    name: toolCall.name,
    risk: getToolRisk(toolCall.name),
    input: formatInput(toolCall.name, params),
    params,
  }
}

// ── Internal helpers ─────────────────────────────────────────

/**
 * Parse the arguments string (may be JSON or may have issues).
 * Returns an empty object on failure.
 * @param {string} argStr
 * @returns {Record<string, unknown>}
 */
function parseArguments(argStr) {
  try {
    const parsed = JSON.parse(argStr)
    if (parsed && typeof parsed === 'object') return parsed
    return {}
  } catch {
    return {}
  }
}

/**
 * Format a human-readable input string for the ToolCall.
 * @param {string} name
 * @param {Record<string, unknown>} params
 * @returns {string}
 */
function formatInput(name, params) {
  const parts = [name]
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') parts.push(`${k}=${String(v).slice(0, 200)}`)
  }
  return parts.join(' ')
}

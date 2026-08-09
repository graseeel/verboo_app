import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, AgentResultSnapshot, AgentTurnRequest, UserSettings, VerbooModel } from '../shared/types'
import { App } from './App'
import { CHAT_STORE_KEY, createConversation } from './state/chatStore'

// ModelSelector stays out of this harness (its @lobehub/icons ESM does not
// resolve in jsdom). The selection itself hydrates from settings + catalog —
// the component is not part of what these tests exercise.
vi.mock('./features/models/ModelSelector', () => ({ ModelSelector: () => null }))
vi.mock('./features/terminal/LocalTerminalPanel', () => ({ LocalTerminalPanel: () => null }))
vi.mock('./features/plugins/PluginsView', () => ({ PluginsView: () => null }))

// The simulator panel subscribes through the real @tauri-apps/api/event —
// mock the tauri layer so the __TAURI_INTERNALS__ stub stays minimal.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}))

const verbooUltra: VerbooModel = {
  id: 'glm-5.2',
  displayName: 'Ultra',
  contextWindow: 200000,
  supportsVision: false,
  raw: {},
}

const codexSol: VerbooModel = {
  id: 'gpt-5.6-sol',
  displayName: 'GPT-5.6-Sol',
  contextWindow: 272000,
  supportsVision: true,
  provider: 'codex',
  raw: {},
}

const claudeSonnet: VerbooModel = {
  id: 'claude-sonnet-4.6',
  displayName: 'Claude Sonnet 4.6',
  contextWindow: 200000,
  supportsVision: true,
  provider: 'claude',
  raw: {},
}

// ── REAL wire shapes, captured from the packaged CLI driving the owner's
// ChatGPT account with the weekly quota exhausted (Maestro's field notes). ──
const API_ERROR_TEXT = 'API Error: 429 {"error":{"type":"usage_limit_reached","plan_type":"plus","resets_in_seconds":72000}}'
// The terminal diagnostic blob (CliTerminalFailure.message): the API error
// line plus exit/runtime/cli path/cwd internals.
const FAILURE_MESSAGE = [
  API_ERROR_TEXT,
  'O CLI Verboo encerrou com código 1.',
  'exit=1 · runtime=node20 · cli=/opt/verboo/bin/verboo · cwd=/Users/alice/project',
].join('\n')

function apiRetryEvent(turnId: string, attempt: number, retryDelayMs?: number): AgentEvent {
  const payload: Record<string, unknown> = { type: 'system', subtype: 'api_retry', attempt, max_retries: 10, error_status: 429, error: 'rate_limit' }
  if (retryDelayMs !== undefined) payload.retry_delay_ms = retryDelayMs
  return { type: 'json', turnId, payload }
}

/** The full quota-exhausted turn, exactly as the Rust forwarder emits it:
 *  every payload rides a json event; extract_text (turn_service.rs:3050)
 *  turns BOTH the assistant error event AND the result event into stdout —
 *  the same text twice; the process exit lands as the terminal error. */
function quotaFailureEvents(turnId: string): AgentEvent[] {
  const retries = Array.from({ length: 10 }, (_, index) => apiRetryEvent(turnId, index + 1))
  const resultSnapshot: AgentResultSnapshot = {
    turnId,
    exitCode: 1,
    isError: true,
    rawResult: { type: 'result', subtype: 'success', is_error: true, result: API_ERROR_TEXT },
  }
  return [
    { type: 'started', turnId },
    ...retries,
    { type: 'json', turnId, payload: { type: 'assistant', message: { content: [{ type: 'text', text: API_ERROR_TEXT }] }, isApiErrorMessage: true } },
    { type: 'stdout', turnId, text: `${API_ERROR_TEXT}\n` },
    { type: 'json', turnId, payload: { type: 'result', subtype: 'success', is_error: true, result: API_ERROR_TEXT } },
    { type: 'result', turnId, result: resultSnapshot },
    { type: 'stdout', turnId, text: `${API_ERROR_TEXT}\n` },
    {
      type: 'error',
      turnId,
      message: FAILURE_MESSAGE,
      payload: { category: 'rate_limit', message: FAILURE_MESSAGE, details: FAILURE_MESSAGE.split('\n'), exitCode: 1, recoveryReady: false },
      exitCode: 1,
    },
  ]
}

let settingsStore: UserSettings
let updateUserSettingsMock: ReturnType<typeof vi.fn>
let activeCatalog: VerbooModel[]
let agentEventForward: ((event: AgentEvent) => void) | undefined
let refreshDataForward: (() => void) | undefined

function baseSettings(): UserSettings {
  return {
    language: 'en-US',
    theme: 'system',
    defaultAccessMode: 'approval',
    fullAccessEnabled: false,
    showInMenuBar: true,
    showMenuBarText: true,
    staySignedIn: true,
    preventSleepWhileRunning: true,
    completionNotifications: 'background',
    permissionNotifications: true,
    questionNotifications: true,
    responseEnhancementsEnabled: true,
    personality: 'pragmatic',
    customInstructions: '',
    trustedCommands: [],
    customSlashCommands: [],
    memoriesEnabled: true,
    chroniclePreview: true,
    ignoreToolChatsForMemory: true,
    goalMode: { enabled: true, maxTurns: 4, maxElapsedMinutes: 10, allowAutoAccess: false },
    updates: { channel: 'stable', autoCheck: true, autoDownload: false },
    visionFallbackConsent: 'ask',
    videoFallbackConsent: 'ask',
    trustedSkills: [],
    includeVerbooCoAuthor: false,
    browserVerificationEnabled: true,
    loadWebIcons: true,
    lastSelectedModelId: 'gpt-5.6-sol',
  } as UserSettings
}

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function createBridge() {
  const unsubscribe = () => {}
  const sendTurn = vi.fn(async (request: AgentTurnRequest) => request.turnId ?? 'turn:test')
  const interrupt = vi.fn(async () => true)
  const bridge = {
    getUserSettings: vi.fn(async () => settingsStore),
    updateUserSettings: updateUserSettingsMock,
    getConfig: vi.fn(async () => ({ workingDirectory: '', accessMode: 'approval', platform: 'darwin' })),
    getDefaultWorkingDirectory: vi.fn(async () => ''),
    getCredentialStatus: vi.fn(async () => ({ hasApiKey: true, apiKeyHint: '…1234' })),
    getCliAuthStatus: vi.fn(async () => ({ loggedIn: true, email: 'ada@example.test' })),
    listModels: vi.fn(async () => ({ models: activeCatalog, source: 'cli', stale: false })),
    getProfile: vi.fn(async () => ({
      status: 'ready',
      user: { name: 'Ada' },
      summary: { totalTokens: 1, tokensInTotal: 1, tokensOutTotal: 0, reqTotal: 1 },
      plan: { name: 'Pro', status: 'active' },
    })),
    pluginList: vi.fn(async () => []),
    pluginSkills: vi.fn(async () => []),
    getUpdateStatus: vi.fn(async () => undefined),
    sendTurn,
    interrupt,
    onAgentEvent: vi.fn((handler: (event: AgentEvent) => void) => {
      agentEventForward = handler
      return unsubscribe
    }),
    onRefreshDataRequest: vi.fn((handler: () => void) => {
      refreshDataForward = handler
      return unsubscribe
    }),
    onVideoOcrRequest: vi.fn(() => unsubscribe),
    onUpdateStatus: vi.fn(() => unsubscribe),
    onTerminalData: vi.fn(() => unsubscribe),
    onTerminalExit: vi.fn(() => unsubscribe),
    listenForNotificationClick: vi.fn(async () => unsubscribe),
    updateMenuBar: vi.fn(async () => {}),
    heartbeatMenuBar: vi.fn(async () => {}),
    onProviderLoginEvent: vi.fn(() => unsubscribe),
    providerAuthStatus: vi.fn(async () => [{ provider: 'codex', connected: true, account: 'ada@openai.test' }]),
    chromeIntegrationStatus: vi.fn(async () => ({
      extension: 'managed', bridge: 'managed', mcp: 'managed', connection: 'waitingForChrome',
      panelState: 'notApplicable', aggregate: 'ready', installedVersion: '0.5.2', availableVersion: '0.5.2',
      canConfigure: false, canRepair: false, canRemove: false, storeUrlAvailable: false,
      developmentBuild: false, extensionIdSource: 'release',
    })),
    getVideoComponentState: vi.fn(async () => ({ asrModel: 'absent' })),
    onVideoTranscriberProgress: vi.fn(() => unsubscribe),
    getWorkspaceChanges: vi.fn(async () => undefined),
  }

  return {
    sendTurn,
    interrupt,
    emitAgentEvent(event: AgentEvent) {
      agentEventForward?.(event)
    },
    bridge: new Proxy(bridge as Record<PropertyKey, unknown>, {
      get(target, property) {
        if (property in target) return target[property]
        return vi.fn(async () => undefined)
      },
    }),
  }
}

function seedConversation() {
  const conversation = {
    ...createConversation(),
    id: 'chat:main',
    title: 'Existing chat',
    createdAt: 10,
    updatedAt: 10,
    lastTurnEndedAt: 10,
    items: [{ id: 'message:existing', role: 'user' as const, text: 'Existing message', timestamp: 10 }],
  }
  window.localStorage.setItem(CHAT_STORE_KEY, JSON.stringify({
    version: 3,
    projects: [],
    conversations: [conversation],
  }))
}

function seedTwoConversations() {
  const conversationA = {
    ...createConversation(),
    id: 'chat:A',
    title: 'Chat A',
    createdAt: 10,
    updatedAt: 20,
    lastTurnEndedAt: 10,
    items: [{ id: 'message:a', role: 'user' as const, text: 'Message A', timestamp: 10 }],
  }
  const conversationB = {
    ...createConversation(),
    id: 'chat:B',
    title: 'Chat B',
    createdAt: 10,
    updatedAt: 10,
    lastTurnEndedAt: 10,
    items: [{ id: 'message:b', role: 'user' as const, text: 'Message B', timestamp: 10 }],
  }
  window.localStorage.setItem(CHAT_STORE_KEY, JSON.stringify({
    version: 3,
    projects: [],
    conversations: [conversationA, conversationB],
  }))
}

async function renderAppAndSendTurn(message = 'Refactor the parser') {
  const harness = createBridge()
  ;(window as unknown as { verboo: unknown }).verboo = harness.bridge
  render(<App />)
  await screen.findByRole('button', { name: /Ada/ })

  // Locale-agnostic selectors (the pt-BR test changes the dictionary).
  await waitFor(() => expect(document.querySelector('.composer-text-wrap textarea')).toBeTruthy())
  const input = document.querySelector('.composer-text-wrap textarea') as HTMLElement
  fireEvent.change(input, { target: { value: message } })
  fireEvent.click(document.querySelector('.send-button') as HTMLElement)
  await waitFor(() => expect(harness.sendTurn).toHaveBeenCalledTimes(1))
  return { ...harness, turnId: harness.sendTurn.mock.calls[0][0].turnId as string }
}

function turnArticle(): HTMLElement {
  const article = document.querySelector('article.turn-view')
  expect(article).toBeTruthy()
  return article as HTMLElement
}

function systemRow(): HTMLElement {
  const rows = [...document.querySelectorAll('article.message-row.system')]
  expect(rows.length).toBeGreaterThan(0)
  return rows[rows.length - 1] as HTMLElement
}

beforeEach(() => {
  window.localStorage.clear()
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    media: '',
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }))
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} })
  // jsdom lacks Element.scrollTo — the autoscroll effect fires as the
  // transcript appends turn items.
  Object.defineProperty(Element.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
  agentEventForward = undefined
  refreshDataForward = undefined
  activeCatalog = [verbooUltra, codexSol]
  settingsStore = baseSettings()
  updateUserSettingsMock = vi.fn(async (patch: Partial<UserSettings>) => {
    Object.assign(settingsStore, patch)
    return { ...settingsStore }
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
})

describe('App — provider quota-error UX (field defect)', () => {
  it('api_retry events surface a live retry notice instead of mute thinking', async () => {
    seedConversation()
    const { emitAgentEvent, turnId } = await renderAppAndSendTurn()

    act(() => { emitAgentEvent({ type: 'started', turnId }) })
    act(() => { emitAgentEvent(apiRetryEvent(turnId, 3)) })

    // The thinking row must SAY what is happening, not sit mute for minutes.
    await waitFor(() => {
      expect(turnArticle().textContent).toContain('retrying (3 of 10)')
    })
    act(() => { emitAgentEvent(apiRetryEvent(turnId, 7)) })
    await waitFor(() => {
      expect(turnArticle().textContent).toContain('retrying (7 of 10)')
    })
    // While the retry notice is up, the mute "Thinking..." is not the status.
    const thinkingRow = turnArticle().querySelector('.step-thinking')
    expect(thinkingRow?.textContent).not.toContain('Thinking...')
  })

  it('terminal quota error: readable headline in the turn body ONCE, raw diagnostic collapsed, provider in the header', async () => {
    seedConversation()
    const { emitAgentEvent, turnId } = await renderAppAndSendTurn()

    act(() => {
      for (const event of quotaFailureEvents(turnId)) emitAgentEvent(event)
    })

    // Header: the turn was CODEX — the prefix must survive the error path.
    await waitFor(() => {
      expect(turnArticle().querySelector('.message-meta')?.textContent).toContain('Codex')
    })

    // T23: the readable headline lives in the turn body as the model's natural
    // response (ApiErrorAwareText parses the raw API error line the CLI sent
    // as assistant text). No "Sistema" badge, no colored band. The headline
    // appears EXACTLY ONCE — the stdout suppression (turnApiErrorTextRef)
    // keeps the raw error from landing a second time in the body.
    const readable = 'Usage limit reached on your ChatGPT account (plus plan). Renews in ~20 hours.'
    await waitFor(() => {
      expect(turnArticle().textContent).toContain(readable)
    })
    const occurrences = (document.body.textContent ?? '').split(readable).length - 1
    expect(occurrences).toBe(1)
    // No "Sistema" row — the message is the model's response, not a system badge.
    expect(document.querySelectorAll('article.message-row.system')).toHaveLength(0)
    // No colored band (T23 removed .is-turn-error from the DOM path).
    expect(document.querySelectorAll('article.is-turn-error')).toHaveLength(0)
    // No raw JSON in the visible turn body text (ApiErrorAwareText replaced
    // it with the readable headline). The raw error IS in the <details> toggle
    // (closed, not visible) — exclude it from the check.
    const details = turnArticle().querySelector('details')
    expect(details).toBeTruthy()
    expect(details?.hasAttribute('open')).toBe(false)
    expect(details?.textContent).toContain('usage_limit_reached')
    const visibleText = (turnArticle().textContent ?? '').replace(details?.textContent ?? '', '')
    expect(visibleText).not.toContain('usage_limit_reached')
  })

  it('header keeps the provider even when the catalog degrades mid-turn (429 storm kills the provider CLI read)', async () => {
    seedConversation()
    const { emitAgentEvent, turnId } = await renderAppAndSendTurn()

    act(() => { emitAgentEvent({ type: 'started', turnId }) })
    // The retry storm makes the provider CLI read fail; the next refresh
    // carries a codex-less catalog (attach_provider_models degrades silently).
    activeCatalog = [verbooUltra]
    act(() => { refreshDataForward?.() })
    await waitFor(() => {
      // Wait until the degraded catalog actually landed before the error.
      expect(activeCatalog).toHaveLength(1)
    })

    act(() => {
      for (const event of quotaFailureEvents(turnId).slice(1)) emitAgentEvent(event)
    })

    await waitFor(() => {
      expect(turnArticle().querySelector('.message-meta')?.textContent).toContain('Codex')
    })
  })

  it('pt-BR locale renders the retry notice and the readable quota message in Portuguese', async () => {
    settingsStore = { ...baseSettings(), language: 'pt-BR' }
    seedConversation()
    const { emitAgentEvent, turnId } = await renderAppAndSendTurn()

    act(() => { emitAgentEvent({ type: 'started', turnId }) })
    act(() => { emitAgentEvent(apiRetryEvent(turnId, 3)) })
    await waitFor(() => {
      expect(turnArticle().textContent).toContain('O provedor limitou a taxa — tentando de novo (3 de 10)')
    })

    act(() => {
      for (const event of quotaFailureEvents(turnId).slice(11)) emitAgentEvent(event)
    })

    await waitFor(() => {
      // T23: the readable quota message lives in the turn body, not a system row.
      expect(turnArticle().textContent).toContain('Limite de uso da sua conta ChatGPT (plano plus) atingido. Renova em ~20 horas.')
    })
  })

  // T1 — account attribution is PER PROVIDER: a claude turn must name the
  // Claude account (never Verboo, never another provider's brand).
  it('claude turn quota error names the Claude account — never Verboo, never ChatGPT', async () => {
    activeCatalog = [verbooUltra, claudeSonnet]
    settingsStore = { ...baseSettings(), lastSelectedModelId: 'claude-sonnet-4.6' }
    seedConversation()
    const { emitAgentEvent, turnId } = await renderAppAndSendTurn()

    act(() => {
      for (const event of quotaFailureEvents(turnId)) emitAgentEvent(event)
    })

    // T23: the readable headline lives in the turn body (model's response).
    const readable = 'Usage limit reached on your Claude account (plus plan). Renews in ~20 hours.'
    await waitFor(() => {
      expect(turnArticle().textContent).toContain(readable)
    })
    expect(turnArticle().textContent).not.toContain('Verboo account')
    expect(turnArticle().textContent).not.toContain('ChatGPT')
  })

  // T2 — the header in the error path is byte-identical to the success path:
  // provider prefix + brand icon + model display name.
  it('error path header shows provider + model with the SAME formatting as success', async () => {
    seedConversation()
    const { emitAgentEvent, turnId } = await renderAppAndSendTurn()

    act(() => {
      for (const event of quotaFailureEvents(turnId)) emitAgentEvent(event)
    })

    await waitFor(() => {
      const meta = turnArticle().querySelector('.message-meta')
      expect(meta?.textContent).toBe('Codex - GPT-5.6-Sol')
      expect(meta?.querySelector('[data-testid="provider-icon-codex"]')).toBeTruthy()
    })
  })

  // T17a — Codex terminal error path: the CLI emits the raw API error as
  // assistant text (forwarded as stdout) AND as the error event's message.
  // The readable headline (account name + reset window) must appear EXACTLY
  // ONCE — in the turn body as the model's response (ApiErrorAwareText parses
  // the raw line). The raw diagnostic rides behind the errorDetail toggle on
  // the assistant segment. Mutation: remove the turnApiErrorTextRef suppression
  // in the stdout handler — the raw error lands twice in the body and
  // ApiErrorAwareText parses both → headline appears twice.
  it('T17a: Codex terminal error — raw API error NOT duplicated in the assistant body', async () => {
    seedConversation()
    const { emitAgentEvent, turnId } = await renderAppAndSendTurn()

    act(() => {
      for (const event of quotaFailureEvents(turnId)) emitAgentEvent(event)
    })

    const readable = 'Usage limit reached on your ChatGPT account (plus plan). Renews in ~20 hours.'
    await waitFor(() => { expect(turnArticle().textContent).toContain(readable) })

    // T17a/T23: the readable headline appears EXACTLY ONCE in the transcript.
    // The turnApiErrorTextRef suppression keeps the raw error from landing a
    // second time in the body so ApiErrorAwareText parses it once.
    const allText = document.body.textContent ?? ''
    const occurrences = allText.split(readable).length - 1
    expect(occurrences).toBe(1)
    // No "Sistema" row — the message is the model's response (T23).
    expect(document.querySelectorAll('article.message-row.system')).toHaveLength(0)
    // The raw error IS available in the errorDetail toggle on the assistant segment.
    const details = turnArticle().querySelector('details')
    expect(details).toBeTruthy()
    expect(details?.textContent).toContain(API_ERROR_TEXT)
  })

  // T17b — Claude T13 fast failure path: the error event arrives WITHOUT a
  // prior stdout (no assistant text emitted). T23: the readable headline must
  // be visible in the turn body as the model's response (the error handler
  // puts the raw error line into appendAssistantText; ApiErrorAwareText in
  // the turn-recap parses it into the readable headline). No "Sistema" badge,
  // no colored band. Mutation: remove the appendAssistantText call in the
  // error handler — the message vanishes from the transcript.
  it('T17b: Claude fast failure — readable message visible in the turn body, no system badge', async () => {
    activeCatalog = [verbooUltra, claudeSonnet]
    settingsStore = { ...baseSettings(), lastSelectedModelId: 'claude-sonnet-4.6' }
    seedConversation()
    const { emitAgentEvent, turnId } = await renderAppAndSendTurn()

    act(() => { emitAgentEvent({ type: 'started', turnId }) })
    act(() => {
      emitAgentEvent({
        type: 'error',
        turnId,
        message: FAILURE_MESSAGE,
        payload: { category: 'unknown', message: FAILURE_MESSAGE, details: [], exitCode: 1, recoveryReady: false },
        exitCode: 1,
      })
    })

    const readable = 'Usage limit reached on your Claude account (plus plan). Renews in ~20 hours.'
    await waitFor(() => { expect(turnArticle().textContent).toContain(readable) })
    // T23: no "Sistema" row, no colored band — the message is the model's response.
    expect(document.querySelectorAll('article.message-row.system')).toHaveLength(0)
    expect(document.querySelectorAll('article.is-turn-error')).toHaveLength(0)
    // The raw error is NOT bare in the visible turn body text (ApiErrorAwareText
    // replaced it with the readable headline); it IS in the <details> toggle
    // (closed, not visible) — exclude it from the check.
    const details = turnArticle().querySelector('details')
    expect(details).toBeTruthy()
    expect(details?.textContent).toContain(API_ERROR_TEXT)
    const visibleText = (turnArticle().textContent ?? '').replace(details?.textContent ?? '', '')
    expect(visibleText).not.toContain(API_ERROR_TEXT)
  })

  // T18 — thinking-block 400 duplication (sister to T17a that survived).
  // The CLI forwards the raw 400 as assistant text (via stdout, WITHOUT an
  // isApiErrorMessage flag), and ApiErrorAwareText in the turn-recap parses
  // it into the "Esta conversa não pode continuar..." headline with its
  // "Começar nova conversa" exit. T23: the error handler stamps errorDetail
  // on the assistant segment (the body already has the raw error); no system
  // row is created. The headline appears ONCE. Mutation: remove the
  // bodyHasRawError branch — appendAssistantText duplicates the raw error in
  // the body and ApiErrorAwareText parses both → headline appears twice.
  it('T18: thinking-block 400 — headline appears ONCE, raw diagnostic in the toggle', async () => {
    settingsStore = { ...baseSettings(), language: 'pt-BR' }
    seedConversation()
    const { emitAgentEvent, turnId } = await renderAppAndSendTurn()

    const THINKING_400 =
      'API Error: 400 {"error":{"type":"invalid_request_error","message":"messages.157.content.0.thinking... each thinking block must contain non-whitespace thinking"}}'
    act(() => { emitAgentEvent({ type: 'stdout', turnId, text: THINKING_400 + '\n' }) })
    act(() => {
      emitAgentEvent({
        type: 'error',
        turnId,
        message: THINKING_400,
        payload: { category: 'unknown', message: THINKING_400, details: [], exitCode: 1, recoveryReady: false },
        exitCode: 1,
      })
    })

    // The headline appears EXACTLY ONCE in the document — in the turn body via
    // ApiErrorAwareText, NOT duplicated in a system row.
    const headline = 'Esta conversa não pode continuar'
    await waitFor(() => {
      const allText = document.body.textContent ?? ''
      const occurrences = allText.split(headline).length - 1
      expect(occurrences).toBe(1)
    })
    // T23: no "Sistema" row — the message is the model's response.
    expect(document.querySelectorAll('article.message-row.system')).toHaveLength(0)
    // The raw error IS available in the errorDetail toggle on the assistant segment.
    const details = turnArticle().querySelector('details')
    expect(details).toBeTruthy()
    expect(details?.textContent).toContain('invalid_request_error')
  })

  // T19-retry — covers the retry-error path at App.tsx:2594 (the `.catch`
  // handler when `runTurn(retry)` rejects). T23: the error message is the
  // model's natural response (appendAssistantText), not a "Sistema" badge.
  // runTurn rejects before any stdout, so the body is empty and
  // appendAssistantText creates a fresh segment; ApiErrorAwareText in the
  // turn-recap parses the raw API error line into the readable headline.
  // No system row, no errorDetail toggle (path 3 stamps none).
  // Mutation: remove the appendAssistantText call — the message vanishes.
  it('T19-retry: retry error — headline in the turn body, no system row', async () => {
    seedConversation()
    const { emitAgentEvent, turnId, sendTurn } = await renderAppAndSendTurn()

    const RETRY_ERROR = 'API Error: 400 {"error":{"type":"invalid_request_error","message":"messages.1.content.0.thinking"}}'
    sendTurn.mockRejectedValueOnce(new Error(RETRY_ERROR))

    act(() => { emitAgentEvent({ type: 'started', turnId }) })
    act(() => {
      emitAgentEvent({
        type: 'error',
        turnId,
        message: 'Error: no conversation found with session id: abc-123',
        payload: { category: 'unknown', message: 'no conversation found with session id: abc-123', details: [], exitCode: 1, recoveryReady: false },
        exitCode: 1,
      })
    })

    // T23: the thinking-400 headline appears in the turn body (ApiErrorAwareText
    // parsed the raw error line), not in a system row.
    const headline = 'This conversation can\'t continue'
    await waitFor(() => {
      expect(document.body.textContent).toContain(headline)
    })
    expect(document.querySelectorAll('article.message-row.system')).toHaveLength(0)
    // No errorDetail toggle on the retry segment (path 3 stamps none).
    expect(turnArticle().querySelector('details')).toBeNull()
  })

  // T19-recovery — covers the recovery-error system row at App.tsx:2637
  // (the `.catch` handler when `runTurn(resume)` rejects after an auth
  // recovery attempt). Same unreachability proof as T19-retry: runTurn
  // rejects before any stdout events for the resume turn, so the body is
  // always empty and the guard always returns false. The recovery headline
  // (i18n template with the raw error embedded) appears exactly once.
  // Mutation: replace shouldSuppressSystemErrorText(...) with true at the
  // recovery call site — text becomes '' and the headline vanishes → test
  // fails.
  it('T19-recovery: recovery error — headline in the turn body, no system row', async () => {
    seedConversation()
    const { emitAgentEvent, turnId, sendTurn } = await renderAppAndSendTurn()

    const RECOVERY_ERROR = 'API Error: 401 {"error":{"type":"authentication_error","message":"Invalid token"}}'
    sendTurn.mockRejectedValueOnce(new Error(RECOVERY_ERROR))

    act(() => { emitAgentEvent({ type: 'started', turnId }) })
    act(() => {
      emitAgentEvent({
        type: 'error',
        turnId,
        message: 'Authentication failed: invalid or expired token',
        payload: { category: 'authentication_failed', message: 'Authentication failed', details: [], exitCode: 1, recoveryReady: true },
        exitCode: 1,
      })
    })

    // T23: the recovery headline appears in the turn body (appendAssistantText),
    // not in a system row. The headline already carries the raw error (i18n
    // interpolation), so no errorDetail toggle is needed.
    const headline = 'Authentication was renewed, but the task could not resume'
    await waitFor(() => {
      expect(document.body.textContent).toContain(headline)
    })
    expect(document.querySelectorAll('article.message-row.system')).toHaveLength(0)
  })

  it('header keeps provider + model when the turn dies BEFORE any assistant text', async () => {
    seedConversation()
    const { emitAgentEvent, turnId } = await renderAppAndSendTurn()

    act(() => { emitAgentEvent({ type: 'started', turnId }) })
    act(() => {
      emitAgentEvent({
        type: 'error',
        turnId,
        message: 'O CLI Verboo encerrou com código 1.',
        payload: { category: 'unknown', message: 'O CLI Verboo encerrou com código 1.', details: [], exitCode: 1, recoveryReady: false },
        exitCode: 1,
      })
    })

    await waitFor(() => {
      expect(turnArticle().querySelector('.message-meta')?.textContent).toBe('Codex - GPT-5.6-Sol')
    })
  })

  // ── T13: retry_delay_ms hour-scale → quota reset, not retry ──

  it('T13: api_retry with hour-scale retry_delay_ms ends the turn and surfaces the readable quota message immediately', async () => {
    seedConversation()
    const { emitAgentEvent, turnId, interrupt } = await renderAppAndSendTurn()

    act(() => { emitAgentEvent({ type: 'started', turnId }) })
    // Measured field value: retry_delay_ms=154_650_000 (43h) on the FIRST
    // api_retry event. The app must not sit on a mute "Thinking…" for 43h.
    act(() => { emitAgentEvent(apiRetryEvent(turnId, 1, 154_650_000)) })

    // T23: the readable quota message appears in the turn body as the model's
    // response (appendAssistantText), not a "Sistema" badge.
    await waitFor(() => {
      expect(turnArticle().textContent).toContain('Usage limit reached')
      expect(turnArticle().textContent).toContain('~2 days')
    })
    expect(document.querySelectorAll('article.message-row.system')).toHaveLength(0)
    // The retry notice does NOT appear — this is not a retry, it's a quota reset.
    expect(turnArticle().textContent).not.toContain('retrying')
    // The turn was ended — interrupt was called.
    expect(interrupt).toHaveBeenCalledWith(expect.any(String))
  })

  it('T13: api_retry with second-scale retry_delay_ms keeps the live retry notice (normal retry)', async () => {
    seedConversation()
    const { emitAgentEvent, turnId, interrupt } = await renderAppAndSendTurn()

    act(() => { emitAgentEvent({ type: 'started', turnId }) })
    // 30s retry delay — well below the 1h threshold. Normal retry behavior.
    act(() => { emitAgentEvent(apiRetryEvent(turnId, 1, 30_000)) })

    await waitFor(() => {
      expect(turnArticle().textContent).toContain('retrying (1 of 10)')
    })
    // The turn is NOT ended — interrupt was not called.
    expect(interrupt).not.toHaveBeenCalled()
  })

  it('T13: quota-reset turn suppresses the duplicate error item from the subsequent error event', async () => {
    seedConversation()
    const { emitAgentEvent, turnId } = await renderAppAndSendTurn()

    act(() => { emitAgentEvent({ type: 'started', turnId }) })
    act(() => { emitAgentEvent(apiRetryEvent(turnId, 1, 154_650_000)) })
    await waitFor(() => {
      // T23: the quota message is in the turn body, not a system row.
      expect(turnArticle().textContent).toContain('Usage limit reached')
    })
    // The interrupt kills the CLI; a terminal error event arrives.
    act(() => {
      emitAgentEvent({
        type: 'error',
        turnId,
        message: 'O CLI Verboo encerrou com código 1.',
        payload: { category: 'unknown', message: 'O CLI Verboo encerrou com código 1.', details: [], exitCode: 1, recoveryReady: false },
        exitCode: 1,
      })
    })

    // T23: NO system row — the quota message is in the turn body, and the
    // error event's item is suppressed by quotaResetTurnsRef (the quota
    // message already told the user). The quota message appears ONCE.
    expect(document.querySelectorAll('article.message-row.system')).toHaveLength(0)
    const occurrences = (document.body.textContent ?? '').split('Usage limit reached').length - 1
    expect(occurrences).toBe(1)
  })

  it('T13 pt-BR: a mensagem de cota imediata está em português (sem jargão inglês cru)', async () => {
    settingsStore = { ...baseSettings(), language: 'pt-BR' }
    seedConversation()
    const { emitAgentEvent, turnId } = await renderAppAndSendTurn()

    act(() => { emitAgentEvent({ type: 'started', turnId }) })
    act(() => { emitAgentEvent(apiRetryEvent(turnId, 1, 154_650_000)) })

    await waitFor(() => {
      // T23: the quota message is in the turn body, not a system row.
      expect(turnArticle().textContent).toContain('Limite de uso da sua conta ChatGPT atingido. Renova em ~2 dias.')
    })
  })

  it('G.7 direção B: erro não-cota pós-interrupt-falho NÃO é suprimido (supressão por identidade, não one-shot)', async () => {
    seedConversation()
    const { emitAgentEvent, turnId, interrupt } = await renderAppAndSendTurn()
    // Simulate interrupt failure: the CLI process already exited, so the
    // interrupt returns false. interruptForUser rolls back userInterruptedTurnsRef
    // (App.tsx:2963) — the first error event is NOT labeled 'interruption'.
    interrupt.mockResolvedValue(false)

    act(() => { emitAgentEvent({ type: 'started', turnId }) })
    act(() => { emitAgentEvent(apiRetryEvent(turnId, 1, 154_650_000)) })
    await waitFor(() => {
      // T23: the quota message is in the turn body, not a system row.
      expect(turnArticle().textContent).toContain('Usage limit reached')
    })
    // Wait for interruptForUser to complete (interrupt returns false → rollback
    // of userInterruptedTurnsRef). Without this, the ref still has the turnId
    // and the error would be labeled 'interruption'.
    await waitFor(() => {
      expect(interrupt).toHaveBeenCalledWith(expect.any(String))
    })

    // A real error arrives (not the interrupt duplicate). It must NOT be
    // suppressed — the one-shot quotaResetTurnsRef would hide it; the
    // identity-based check (presentation === 'interruption') lets it through.
    // Generic CLI exit message — avoids isContextOverflow / auth patterns
    // so willContinueAutomatically stays false (the item is eligible to show).
    act(() => {
      emitAgentEvent({
        type: 'error',
        turnId,
        message: 'O CLI Verboo encerrou com código 137.',
        payload: { category: 'unknown', message: 'O CLI Verboo encerrou com código 137.', details: [], exitCode: 137, recoveryReady: false },
        exitCode: 137,
      })
    })

    // T23: NO system rows — both the quota message and the real error are in
    // the turn body as the model's response. Neither is suppressed. The
    // identity-based check (presentation === 'interruption') let the real
    // error through; appendAssistantText put it in the body.
    expect(document.querySelectorAll('article.message-row.system')).toHaveLength(0)
    expect(turnArticle().textContent).toContain('Usage limit reached')
    expect(turnArticle().textContent).toContain('código 137')
  })

  it('G.8: cota na conversa A não encerra turno nem suprime erro da conversa B (isolamento entre conversas vivas)', async () => {
    seedTwoConversations()
    const harness = createBridge()
    ;(window as unknown as { verboo: unknown }).verboo = harness.bridge
    render(<App />)
    await screen.findByRole('button', { name: /Ada/ })

    // Chat A is active by default (higher updatedAt:20). Send a turn to A.
    await waitFor(() => expect(document.querySelector('.composer-text-wrap textarea')).toBeTruthy())
    let input = document.querySelector('.composer-text-wrap textarea') as HTMLElement
    fireEvent.change(input, { target: { value: 'Turn in A' } })
    fireEvent.click(document.querySelector('.send-button') as HTMLElement)
    await waitFor(() => expect(harness.sendTurn).toHaveBeenCalledTimes(1))
    const turnIdA = harness.sendTurn.mock.calls[0][0].turnId as string
    act(() => { harness.emitAgentEvent({ type: 'started', turnId: turnIdA }) })

    // Switch to Chat B (sidebar row button).
    await waitFor(() => {
      const buttons = [...document.querySelectorAll('button.conversation-main')]
      expect(buttons.some(b => b.textContent?.includes('Chat B'))).toBe(true)
    })
    const chatBButton = [...document.querySelectorAll('button.conversation-main')]
      .find(b => b.textContent?.includes('Chat B')) as HTMLElement
    fireEvent.click(chatBButton)

    // Send a turn to B. Composer busy is per-conversation — A's running turn
    // does not block B's composer (runningConversations.has('chat:B') is false).
    await waitFor(() => expect(document.querySelector('.composer-text-wrap textarea')).toBeTruthy())
    input = document.querySelector('.composer-text-wrap textarea') as HTMLElement
    fireEvent.change(input, { target: { value: 'Turn in B' } })
    fireEvent.click(document.querySelector('.send-button') as HTMLElement)
    await waitFor(() => expect(harness.sendTurn).toHaveBeenCalledTimes(2))
    const turnIdB = harness.sendTurn.mock.calls[1][0].turnId as string
    act(() => { harness.emitAgentEvent({ type: 'started', turnId: turnIdB }) })

    // Quota reset in A: api_retry 43h for turnIdA while B is active. The
    // handler must route by turnId (turnConversationIds[turnIdA]='chat:A'),
    // not by activeConversationId — otherwise it interrupts B's turn.
    act(() => { harness.emitAgentEvent(apiRetryEvent(turnIdA, 1, 154_650_000)) })

    // Interrupt called exactly once — for A's conversation, not B's.
    await waitFor(() => { expect(harness.interrupt).toHaveBeenCalledTimes(1) })
    expect(harness.interrupt).toHaveBeenCalledWith('chat:A')

    // B's turn is still running. A real error arrives for turnIdB — must NOT
    // be suppressed by A's quota-reset ref (which holds turnIdA, not turnIdB).
    act(() => {
      harness.emitAgentEvent({
        type: 'error',
        turnId: turnIdB,
        message: 'O CLI Verboo encerrou com código 137.',
        payload: { category: 'unknown', message: 'O CLI Verboo encerrou com código 137.', details: [], exitCode: 137, recoveryReady: false },
        exitCode: 137,
      })
    })

    // B is active — B's transcript is visible. T23: the error appears in B's
    // turn body (appendAssistantText), not a system row. It must NOT be
    // suppressed by A's quota-reset ref (which holds turnIdA, not turnIdB).
    await waitFor(() => {
      expect(document.body.textContent).toContain('código 137')
    })
    // No system row for B's error — it's the model's response.
    const bSystemRows = [...document.querySelectorAll('article.message-row.system')]
    expect(bSystemRows.some(r => r.textContent?.includes('código 137'))).toBe(false)
  })
})

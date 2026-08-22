import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, AgentTurnRequest, UserSettings } from '../shared/types'
import { App } from './App'
import { CHAT_STORE_KEY, createConversation } from './state/chatStore'

vi.mock('./features/models/ModelSelector', () => ({ ModelSelector: () => null }))
vi.mock('./features/terminal/LocalTerminalPanel', () => ({ LocalTerminalPanel: () => null }))
vi.mock('./features/annotations/AnnotationOverlay', () => ({ AnnotationOverlay: () => null }))
vi.mock('./features/annotations/AnnotationLayer', () => ({ AnnotationLayer: () => null }))

const TRANSCRIPT_APPROVAL_TEXT = 'Permission approved automatically'
const AUTO_FOLLOWUP_SNIPPET = /by a trusted rule saved in this app\./
const COMPOSER_PLACEHOLDER = 'Ask Verboo, type / for skills, or @ for plugin skills'

const TRUSTED_COMMAND = 'python3 -c "import os; os.m"'
const TRUSTED_REQUEST_TEXT = `Can I run the command \`${TRUSTED_COMMAND}\`? Approve to continue.`
const UNTRUSTED_COMMAND = 'node build.js'
const UNTRUSTED_REQUEST_TEXT = `Can I run the command \`${UNTRUSTED_COMMAND}\`? Approve to continue.`

const userSettings: UserSettings = {
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
  trustedCommands: [{ id: 'rule-1', command: TRUSTED_COMMAND, createdAt: 1, lastUsedAt: 1, useCount: 0 }],
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
}

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

type TurnResolver = (turnId: string) => void

function createBridge() {
  let onAgentEvent: ((event: AgentEvent) => void) | undefined
  const unsubscribe = () => {}
  const turnResolvers: TurnResolver[] = []
  const sendTurn = vi.fn((request: AgentTurnRequest, resumeSessionId?: string) =>
    new Promise<string>(resolve => {
      turnResolvers.push(() => resolve(request.turnId ?? 'turn:pending'))
      void resumeSessionId
    }),
  )
  const bridge = {
    getUserSettings: vi.fn(async () => userSettings),
    updateUserSettings: vi.fn(async () => userSettings),
    getConfig: vi.fn(async () => ({ workingDirectory: '', accessMode: 'approval', platform: 'darwin' })),
    getDefaultWorkingDirectory: vi.fn(async () => ''),
    getCredentialStatus: vi.fn(async () => ({ hasApiKey: true, apiKeyHint: '…1234' })),
    getCliAuthStatus: vi.fn(async () => ({ loggedIn: true, email: 'ada@example.test' })),
    listModels: vi.fn(async () => ({
      models: [{ id: 'model-1', displayName: 'Test model', raw: {} }],
      source: 'api-key',
      stale: false,
    })),
    getProfile: vi.fn(async () => ({
      status: 'ready',
      user: { name: 'Ada' },
      summary: { totalTokens: 1, tokensInTotal: 1, tokensOutTotal: 0, reqTotal: 1 },
      plan: { name: 'Pro', status: 'active' },
    })),
    pluginList: vi.fn(async () => []),
    pluginSkills: vi.fn(async () => []),
    getUpdateStatus: vi.fn(async () => undefined),
    onAgentEvent: vi.fn((handler: (event: AgentEvent) => void) => {
      onAgentEvent = handler
      return unsubscribe
    }),
    onVideoOcrRequest: vi.fn(() => unsubscribe),
    onUpdateStatus: vi.fn(() => unsubscribe),
    onRefreshDataRequest: vi.fn(() => unsubscribe),
    onTerminalData: vi.fn(() => unsubscribe),
    onTerminalExit: vi.fn(() => unsubscribe),
    listenForNotificationClick: vi.fn(async () => unsubscribe),
    updateMenuBar: vi.fn(async () => {}),
    heartbeatMenuBar: vi.fn(async () => {}),
    chromeIntegrationStatus: vi.fn(async () => ({
      extension: 'managed', bridge: 'managed', mcp: 'managed', connection: 'waitingForChrome',
      panelState: 'notApplicable', aggregate: 'ready', installedVersion: '0.5.2', availableVersion: '0.5.2',
      canConfigure: false, canRepair: false, canRemove: false, storeUrlAvailable: false,
      developmentBuild: false, extensionIdSource: 'release',
    })),
    getVideoComponentState: vi.fn(async () => ({ asrModel: 'absent' })),
    onVideoTranscriberProgress: vi.fn(() => unsubscribe),
    getWorkspaceChanges: vi.fn(async () => undefined),
    sendTurn,
    interrupt: vi.fn(async () => true),
  }

  return {
    sendTurn,
    emitAgentEvent(event: AgentEvent) {
      onAgentEvent?.(event)
    },
    resolveTurnAt(index: number, turnId: string) {
      turnResolvers[index]?.(turnId)
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
    cliSessionId: 'sess-existing',
    items: [{ id: 'message:existing', role: 'user' as const, text: 'Existing message', timestamp: 10 }],
  }
  window.localStorage.setItem(CHAT_STORE_KEY, JSON.stringify({
    version: 3,
    projects: [],
    conversations: [conversation],
  }))
}

function renderApp() {
  const testBridge = createBridge()
  ;(window as unknown as { verboo: unknown }).verboo = testBridge.bridge
  render(<App />)
  return testBridge
}

async function sendMessage(text: string) {
  const input = await screen.findByPlaceholderText(COMPOSER_PLACEHOLDER, {}, { timeout: 4000 })
  fireEvent.change(input, { target: { value: text } })
  fireEvent.click(screen.getByTitle('Send'))
}

beforeEach(() => {
  window.localStorage.clear()
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  vi.stubGlobal('requestAnimationFrame', () => 1)
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
})

afterEach(() => {
  // NOTE: intentionally NOT calling vi.unstubAllGlobals() here. The RTL
  // auto-cleanup runs after this hook, and the real jsdom matchMedia lacks
  // removeEventListener — theme/layout effect cleanups would throw on the
  // late unmount. The full stub stays installed for this whole file.
  cleanup()
})

describe('App permission auto-approve', () => {
  // Each approval record renders ONE article card (meta + body repeat the
  // text twice in the DOM, so counting text nodes would double-count).
  const permissionRecordCount = () => document.querySelectorAll('[data-activity="permission"]').length

  it('auto-approves a trusted request ONCE per logical turn and keeps the auto follow-up out of the user-facing queue', async () => {
    seedConversation()
    const { emitAgentEvent, sendTurn, resolveTurnAt } = renderApp()

    // A running user turn so the auto follow-up lands in the internal queue.
    await sendMessage('Run my script')
    await waitFor(() => expect(sendTurn).toHaveBeenCalledTimes(1))
    const userTurnId = sendTurn.mock.calls[0][0].turnId!
    act(() => { emitAgentEvent({ type: 'started', turnId: userTurnId }) })

    // First chunk carrying the trusted permission request → exactly one
    // automatic approval record, one silent follow-up, no manual panel.
    act(() => { emitAgentEvent({ type: 'stdout', turnId: userTurnId, text: TRUSTED_REQUEST_TEXT }) })
    await waitFor(() => expect(permissionRecordCount()).toBe(1))

    // A later chunk of the SAME logical turn re-matches the accumulated text.
    act(() => { emitAgentEvent({ type: 'stdout', turnId: userTurnId, text: '(command output continues)' }) })
    await act(async () => {})

    // Exactly ONE automatic audit record for this logical turn…
    expect(permissionRecordCount()).toBe(1)
    // …the auto follow-up must NOT surface in the editable queue panel…
    expect(screen.queryByText(AUTO_FOLLOWUP_SNIPPET)).toBeNull()
    // …and no manual permission panel may appear for an auto-approved prompt.
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull()

    // When the paused turn ends, exactly ONE resume goes out, carrying the
    // existing CLI session id so the agent continues where it stopped.
    resolveTurnAt(0, userTurnId)
    act(() => { emitAgentEvent({ type: 'done', turnId: userTurnId, exitCode: 0 }) })
    await waitFor(() => expect(sendTurn).toHaveBeenCalledTimes(2))
    const resumeRequest = sendTurn.mock.calls[1][0]
    expect(resumeRequest.message).toContain('Approved command:')
    expect(resumeRequest.conversationId).toBe('chat:main')
    expect(sendTurn.mock.calls[1][1]).toBe('sess-existing')

    // And nothing else drains afterwards: still exactly one resume.
    await act(async () => {})
    expect(sendTurn).toHaveBeenCalledTimes(2)
    expect(screen.queryByText(AUTO_FOLLOWUP_SNIPPET)).toBeNull()
  })

  it('keeps the MANUAL deny flow intact: panel appears, transcript records the denial, and the user-authored follow-up stays visible and actionable in the queue', async () => {
    seedConversation()
    const { emitAgentEvent, sendTurn } = renderApp()

    await sendMessage('Try the build')
    await waitFor(() => expect(sendTurn).toHaveBeenCalledTimes(1))
    const userTurnId = sendTurn.mock.calls[0][0].turnId!
    act(() => { emitAgentEvent({ type: 'started', turnId: userTurnId }) })
    act(() => { emitAgentEvent({ type: 'stdout', turnId: userTurnId, text: UNTRUSTED_REQUEST_TEXT }) })

    // Untrusted commands keep the manual decision surface.
    fireEvent.click(await screen.findByRole('button', { name: 'Deny' }))

    await waitFor(() => expect(permissionRecordCount()).toBe(1))
    expect(document.body.textContent).toContain('Permission denied')
    // Manual decisions remain authored by the user → still visible AND
    // actionable in the queue panel while the current turn runs.
    expect(screen.getByText(/Do not run this command/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Send now/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Remove$/i })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /Edit message/i }).length).toBeGreaterThan(0)
    expect(sendTurn).toHaveBeenCalledTimes(1)
  })
})

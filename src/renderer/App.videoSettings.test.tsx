import { describe, expect, it, vi } from 'vitest'
import type { VideoFallbackConsent } from '../shared/types'
import {
  DEFAULT_VIDEO_FALLBACK_CONSENT,
  shouldBlockVideoBeforeCli,
  type VideoFallbackResponse,
} from './features/video/VideoFallbackModal'

type GateHarness = ReturnType<typeof createGateHarness>

function createGateHarness(
  consent: VideoFallbackConsent,
  choice?: VideoFallbackResponse,
) {
  const requestChoice = vi.fn(async () => choice ?? { allowOnce: true as const })
  const persistConsent = vi.fn(async () => {})
  const onConsentUpdated = vi.fn()
  const onDenied = vi.fn()
  const onPipelinePending = vi.fn()
  const sendTurn = vi.fn(async () => 'turn-1')

  return {
    requestChoice,
    persistConsent,
    onConsentUpdated,
    onDenied,
    onPipelinePending,
    sendTurn,
    async attemptSend(kind: 'video' | 'file' = 'video') {
      const blocked = await shouldBlockVideoBeforeCli([{ kind }], {
        consent,
        requestChoice,
        persistConsent,
        onConsentUpdated,
        onDenied,
        onPipelinePending,
      })
      if (!blocked) await sendTurn()
      return blocked ? 'blocked' : 'continue'
    },
  }
}

function expectCliBlocked(harness: GateHarness) {
  expect(harness.sendTurn).not.toHaveBeenCalled()
}

describe('App video consent integration', () => {
  it('defaults video consent to Ask', () => {
    expect(DEFAULT_VIDEO_FALLBACK_CONSENT).toBe('ask')
  })

  it('Ask + allow once prompts without persisting and blocks the original from the CLI', async () => {
    const harness = createGateHarness('ask', { allowOnce: true })

    expect(await harness.attemptSend()).toBe('blocked')

    expect(harness.requestChoice).toHaveBeenCalledTimes(1)
    expect(harness.persistConsent).not.toHaveBeenCalled()
    expect(harness.onPipelinePending).toHaveBeenCalledTimes(1)
    expectCliBlocked(harness)
  })

  it('Ask + Always persists independently, then blocks until the media pipeline exists', async () => {
    const harness = createGateHarness('ask', { persist: 'always' })

    expect(await harness.attemptSend()).toBe('blocked')

    expect(harness.persistConsent).toHaveBeenCalledWith('always')
    expect(harness.onConsentUpdated).toHaveBeenCalledTimes(1)
    expect(harness.onPipelinePending).toHaveBeenCalledTimes(1)
    expectCliBlocked(harness)
  })

  it('Ask + Never persists denial and sends no video content to the CLI', async () => {
    const harness = createGateHarness('ask', { persist: 'never' })

    expect(await harness.attemptSend()).toBe('blocked')

    expect(harness.persistConsent).toHaveBeenCalledWith('never')
    expect(harness.onDenied).toHaveBeenCalledTimes(1)
    expect(harness.onPipelinePending).not.toHaveBeenCalled()
    expectCliBlocked(harness)
  })

  it('stored Always skips the prompt but still blocks the unimplemented pipeline', async () => {
    const harness = createGateHarness('always')

    expect(await harness.attemptSend()).toBe('blocked')

    expect(harness.requestChoice).not.toHaveBeenCalled()
    expect(harness.persistConsent).not.toHaveBeenCalled()
    expect(harness.onPipelinePending).toHaveBeenCalledTimes(1)
    expectCliBlocked(harness)
  })

  it('stored Never rejects without prompting or reaching the CLI', async () => {
    const harness = createGateHarness('never')

    expect(await harness.attemptSend()).toBe('blocked')

    expect(harness.requestChoice).not.toHaveBeenCalled()
    expect(harness.persistConsent).not.toHaveBeenCalled()
    expect(harness.onDenied).toHaveBeenCalledTimes(1)
    expect(harness.onPipelinePending).not.toHaveBeenCalled()
    expectCliBlocked(harness)
  })

  it('does not block an ordinary file attachment', async () => {
    const harness = createGateHarness('never')

    expect(await harness.attemptSend('file')).toBe('continue')

    expect(harness.requestChoice).not.toHaveBeenCalled()
    expect(harness.onDenied).not.toHaveBeenCalled()
    expect(harness.sendTurn).toHaveBeenCalledTimes(1)
  })
})

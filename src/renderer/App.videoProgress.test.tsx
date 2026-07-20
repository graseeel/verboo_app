/**
 * Event lifecycle + Worked for integration for the transient video row.
 *
 * The live row state is a pure upsert (videoProgressState) fed by
 * `video-progress` events; the Transcript renders one compact row per turn
 * with an entry and removes it when the entry is cleared. Diagnostics land
 * only in the ordinary Worked for activity (kind 'video').
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Transcript } from './components/Transcript'
import { I18nProvider } from './i18n'
import {
  applyVideoProgress,
  clearVideoProgress,
} from './features/video/videoProgressState'
import type { TranscriptItem, VideoProgress } from '../shared/types'

afterEach(cleanup)

beforeEach(() => {
  ;(window as unknown as { verboo: unknown }).verboo = {
    interrupt: vi.fn(async () => true),
  }
})

function stage(stageName: VideoProgress['stage']): VideoProgress {
  return { jobId: 'job-1', turnId: 'turn-1', stage: stageName }
}

const turnItems: TranscriptItem[] = [
  {
    id: 'turn-1:text:0',
    role: 'assistant',
    text: '',
    timestamp: 1,
    streaming: true,
  } as TranscriptItem,
]

function renderTranscript(videoProgressByTurn: Record<string, VideoProgress>, onCancelVideo = vi.fn()) {
  const view = render(
    <I18nProvider language="pt-BR">
      <Transcript
        items={turnItems}
        conversationId="conversation-1"
        videoProgressByTurn={videoProgressByTurn}
        onCancelVideo={onCancelVideo}
      />
    </I18nProvider>,
  )
  return { view, onCancelVideo }
}

describe('video progress event lifecycle', () => {
  it('advances through the five stages monotonically', () => {
    let state: Record<string, VideoProgress> = {}
    for (const name of ['validating', 'preparing', 'transcribing', 'analyzing', 'consolidating'] as const) {
      state = applyVideoProgress(state, 'turn-1', stage(name))
      expect(state['turn-1'].stage).toBe(name)
    }
  })

  it('drops duplicated and out-of-order stage events', () => {
    let state: Record<string, VideoProgress> = {}
    state = applyVideoProgress(state, 'turn-1', stage('analyzing'))
    const afterDuplicate = applyVideoProgress(state, 'turn-1', stage('analyzing'))
    const afterRegression = applyVideoProgress(afterDuplicate, 'turn-1', stage('preparing'))

    expect(afterDuplicate).toBe(state)
    expect(afterRegression['turn-1'].stage).toBe('analyzing')
  })

  it('tracks turns independently and clears only the finished one', () => {
    let state: Record<string, VideoProgress> = {}
    state = applyVideoProgress(state, 'turn-1', stage('preparing'))
    state = applyVideoProgress(state, 'turn-2', { ...stage('analyzing'), turnId: 'turn-2' })

    state = clearVideoProgress(state, 'turn-1')

    expect(state['turn-1']).toBeUndefined()
    expect(state['turn-2']?.stage).toBe('analyzing')
    expect(clearVideoProgress(state, 'missing')).toBe(state)
  })
})

describe('Transcript video row rendering', () => {
  it('shows one compact row while a turn has live progress', () => {
    renderTranscript({ 'turn-1': stage('preparing') })

    const row = screen.getByRole('status')
    expect(row.className).toBe('video-processing-row')
    expect(row.textContent?.length).toBeGreaterThan(0)
  })

  it('removes the row entirely when progress is cleared', () => {
    const { view } = renderTranscript({ 'turn-1': stage('analyzing') })
    expect(document.querySelector('.video-processing-row')).not.toBeNull()

    view.rerender(
      <I18nProvider language="pt-BR">
        <Transcript items={turnItems} conversationId="conversation-1" videoProgressByTurn={{}} />
      </I18nProvider>,
    )

    expect(document.querySelector('.video-processing-row')).toBeNull()
  })

  it('cancel routes to the conversation interrupt callback', () => {
    const { onCancelVideo } = renderTranscript({ 'turn-1': stage('transcribing') })

    fireEvent.click(screen.getByRole('button'))

    expect(onCancelVideo).toHaveBeenCalledTimes(1)
  })

  it('final diagnostics render as an ordinary activity, not a live row', () => {
    const items: TranscriptItem[] = [
      {
        id: 'turn-1:activity:0',
        role: 'assistant',
        text: 'video-analysis',
        timestamp: 1,
        kind: 'activity',
        activityKind: 'video',
        activityDetail: 'route=sampled_frames duration_ms=4000 frames=8 ocr_frames=8 language=pt warnings=0',
      } as TranscriptItem,
      {
        id: 'turn-1:summary',
        role: 'system',
        text: 'Worked for 12s',
        timestamp: 2,
        kind: 'summary',
      } as TranscriptItem,
    ]
    render(
      <I18nProvider language="pt-BR">
        <Transcript items={items} conversationId="conversation-1" videoProgressByTurn={{}} />
      </I18nProvider>,
    )

    expect(document.querySelector('.video-processing-row')).toBeNull()
    // Diagnostics live only inside the Worked for panel: expanding the
    // activity group reveals them; the recap/final answer never shows them.
    const panel = document.querySelector('.turn-flow-panel')
    expect(panel).not.toBeNull()
    expect(panel?.className).not.toContain('is-open')
    const groupToggle = panel?.querySelector<HTMLButtonElement>('.step-actions-row')
    expect(groupToggle).not.toBeNull()
    fireEvent.click(groupToggle!)
    expect(panel?.textContent).toContain('route=sampled_frames')
    expect(document.querySelector('.turn-recap')?.textContent ?? '').not.toContain('route=sampled_frames')
  })
})

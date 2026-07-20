import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '../../i18n'
import { VideoProcessingRow } from './VideoProcessingRow'
import type { VideoProgress } from '../../../shared/types'

afterEach(cleanup)

function progress(stage: VideoProgress['stage'], extra?: Partial<VideoProgress>): VideoProgress {
  return { jobId: 'job-1', turnId: 'turn-1', stage, ...extra }
}

function renderRow(value: VideoProgress, onCancel = vi.fn()) {
  render(
    <I18nProvider language="pt-BR">
      <VideoProcessingRow progress={value} onCancel={onCancel} />
    </I18nProvider>,
  )
  return onCancel
}

describe('VideoProcessingRow', () => {
  it.each([
    ['validating'],
    ['preparing'],
    ['transcribing'],
    ['analyzing'],
    ['consolidating'],
  ] as const)('renders a localized label for the %s stage', stage => {
    renderRow(progress(stage))

    const row = screen.getByRole('status')
    expect(row.textContent?.trim().length).toBeGreaterThan(0)
    expect(row.textContent).not.toContain(`videoProgress.${stage}`)
  })

  it('shows optional unit progress when provided', () => {
    renderRow(progress('analyzing', { completedUnits: 3, totalUnits: 12 }))

    expect(screen.getByRole('status').textContent).toContain('(3/12)')
  })

  it('exposes an accessible cancel button that fires exactly once', () => {
    const onCancel = renderRow(progress('preparing'))

    const button = screen.getByRole('button')
    expect(button.getAttribute('aria-label')?.length).toBeGreaterThan(0)
    fireEvent.click(button)
    fireEvent.click(button)

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(button).toBeDisabled()
  })

  it('never renders a terminal-style card', () => {
    renderRow(progress('consolidating'))

    const row = screen.getByRole('status')
    expect(row.className).toBe('video-processing-row')
    expect(document.querySelector('.terminal-card')).toBeNull()
  })
})

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { SkillSummary } from '../../../shared/types'

if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

vi.mock('../../i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, language: 'en-US' as const }),
}))
vi.mock('../../components/Toast', () => ({ useToast: () => ({ toast: () => {} }) }))
vi.mock('../queue/QueuePanel', () => ({ QueuePanel: () => null }))
vi.mock('../plugins/PluginCard', () => ({ PluginIcon: () => null }))
vi.mock('./voiceInput', () => ({
  createVoiceInput: () => ({ start: () => {}, stop: () => {}, destroy: () => {} }),
  detectSupport: () => false,
  applyVoiceInterim: (current: string) => current,
  commitVoiceFinal: (current: string) => current,
  nextCatchUpStep: () => null,
}))

import { Composer } from './Composer'

const skill: SkillSummary = {
  id: 'skill:test',
  name: 'test',
  description: '',
  path: '/skills/test/SKILL.md',
  source: 'managed',
  trusted: true,
}

type ComposerProps = React.ComponentProps<typeof Composer>
type StopAwareComposerProps = ComposerProps & { onStop?: () => void }

function renderComposer(overrides: Partial<StopAwareComposerProps> = {}) {
  const props: StopAwareComposerProps = {
    disabled: false,
    skills: [skill],
    tokenSkills: [],
    onTokenSkillsChange: vi.fn(),
    attachments: [],
    onAttachFiles: vi.fn(),
    onDropFiles: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onSubmit: vi.fn(),
    onPasteFiles: vi.fn(),
    onGoalCommand: vi.fn(),
    onPetCommand: vi.fn(),
    onCompactCommand: vi.fn(),
    leftToolbar: null,
    rightToolbar: null,
    ...overrides,
  }

  return { ...render(<Composer {...props} />), props }
}

describe('Composer stop button', () => {
  it('replaces submit with an enabled stop action only while busy', () => {
    const onStop = vi.fn()
    const onSubmit = vi.fn()
    const onValueChange = vi.fn()
    const { container } = renderComposer({
      busy: true,
      value: 'keep this queued draft',
      onValueChange,
      onStop,
      onSubmit,
    })

    const stopButton = screen.getByRole('button', { name: 'composer.stop' })
    expect(stopButton).toHaveAttribute('type', 'button')
    expect(stopButton).toHaveAttribute('title', 'composer.stop')
    expect(stopButton).not.toBeDisabled()
    expect(screen.getByTestId('composer-stop-icon')).toBeInTheDocument()

    fireEvent.click(stopButton)

    expect(onStop).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
    expect(onValueChange).not.toHaveBeenCalled()
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('keep this queued draft')
  })

  it('keeps Enter-to-queue behavior while the stop button is visible', () => {
    const onStop = vi.fn()
    const onSubmit = vi.fn()
    const { container } = renderComposer({
      busy: true,
      value: 'queue from keyboard',
      onStop,
      onSubmit,
    })

    fireEvent.keyDown(container.querySelector('textarea')!, { key: 'Enter', shiftKey: false })

    expect(onSubmit).toHaveBeenCalledWith('queue from keyboard')
    expect(onStop).not.toHaveBeenCalled()
  })

  it('keeps the regular submit button while idle', () => {
    renderComposer({ busy: false, value: 'send now' })

    const sendButton = screen.getByRole('button', { name: 'composer.send' })
    expect(sendButton).toHaveAttribute('type', 'submit')
    expect(sendButton).toHaveAttribute('title', 'composer.send')
    expect(sendButton.querySelector('.lucide-arrow-up')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'composer.stop' })).not.toBeInTheDocument()
  })

  it('falls back to the regular send button when busy has no stop callback', () => {
    renderComposer({ busy: true, value: 'queue with send fallback' })

    const sendButton = screen.getByRole('button', { name: 'composer.send' })
    expect(sendButton).toHaveAttribute('type', 'submit')
    expect(sendButton.querySelector('.lucide-arrow-up')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'composer.stop' })).not.toBeInTheDocument()
  })

  it('keeps the stop action enabled when other composer actions are blocked', () => {
    renderComposer({ busy: true, disabled: true, onStop: vi.fn() })

    expect(screen.getByRole('button', { name: 'composer.stop' })).not.toBeDisabled()
  })
})

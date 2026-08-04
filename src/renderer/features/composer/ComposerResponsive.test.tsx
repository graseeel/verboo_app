import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ModelDiscoveryResult, SkillSummary, VerbooModel } from '../../../shared/types'

vi.mock('../../i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, language: 'en-US' as const }),
  formatCompactNumber: (value: number) => String(value),
}))
vi.mock('../../components/Toast', () => ({ useToast: () => ({ toast: () => {} }) }))
vi.mock('../queue/QueuePanel', () => ({ QueuePanel: () => null }))
vi.mock('../plugins/PluginCard', () => ({ PluginIcon: ({ name }: { name: string }) => <span>{name}</span> }))
vi.mock('../models/ModelIcon', () => ({ ModelIcon: () => null }))
vi.mock('./voiceInput', () => ({
  createVoiceInput: () => ({ start: () => {}, stop: () => {}, destroy: () => {} }),
  detectSupport: () => false,
  applyVoiceInterim: (current: string) => current,
  commitVoiceFinal: (current: string) => current,
  nextCatchUpStep: () => null,
}))

import { Composer } from './Composer'
import { TokenRateMeter } from '../context/TokenRateMeter'
import { ModelSelector } from '../models/ModelSelector'

const model: VerbooModel = {
  id: 'deepseek-v4-flash',
  displayName: 'Ultra (deepseek-v4-flash)',
  contextWindow: 200_000,
  supportsVision: false,
  raw: {},
}

const modelResult: ModelDiscoveryResult = {
  models: [model],
  source: 'cli',
  stale: false,
}

const skill: SkillSummary = {
  id: 'skill:test',
  name: 'test',
  description: '',
  path: '/skills/test/SKILL.md',
  source: 'managed',
  trusted: true,
}

type ResizeEntry = { target: Element; contentRect: { width: number } }
const resizeObservers: TestResizeObserver[] = []
const resizeObserverDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver')

class TestResizeObserver {
  constructor(private readonly callback: (entries: ResizeEntry[]) => void) {
    resizeObservers.push(this)
  }

  observe(target: Element) {
    this.target = target
  }

  disconnect() {}

  target!: Element

  resize(width: number) {
    this.callback([{ target: this.target, contentRect: { width } }])
  }
}

function renderNarrowComposer() {
  return render(
    <Composer
      disabled={false}
      skills={[skill]}
      tokenSkills={[]}
      onTokenSkillsChange={() => {}}
      attachments={[]}
      onAttachFiles={() => {}}
      onDropFiles={() => {}}
      onRemoveAttachment={() => {}}
      onSubmit={() => {}}
      onPasteFiles={() => {}}
      onGoalCommand={() => {}}
      onPetCommand={() => {}}
      onCompactCommand={() => {}}
      leftToolbar={null}
      rightToolbar={
        <>
          <TokenRateMeter active={false} />
          <ModelSelector
            models={[model]}
            selectedModel={model.id}
            modelResult={modelResult}
            onSelect={() => {}}
            onRefresh={() => {}}
          />
        </>
      }
    />,
  )
}

beforeEach(() => {
  resizeObservers.length = 0
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: () => ({
        matches: false,
        media: '',
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    })
  }
})

afterEach(() => {
  if (resizeObserverDescriptor) {
    Object.defineProperty(globalThis, 'ResizeObserver', resizeObserverDescriptor)
  } else {
    Reflect.deleteProperty(globalThis, 'ResizeObserver')
  }
})

describe('Composer responsive toolbar priority', () => {
  it('keeps the model name and removes tok/s from the DOM when the composer is narrow', async () => {
    const { container } = renderNarrowComposer()
    await waitFor(() => expect(resizeObservers).toHaveLength(1))

    act(() => {
      resizeObservers[0].resize(640)
    })
    expect(container.querySelector('.token-rate-meter')).toBeInTheDocument()

    act(() => {
      resizeObservers[0].resize(500)
    })

    expect(screen.getByText('Ultra (deepseek-v4-flash)')).toBeInTheDocument()
    expect(container.querySelector('.token-rate-meter')).not.toBeInTheDocument()
  })
})

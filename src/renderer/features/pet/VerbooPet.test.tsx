import { cleanup, render } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VerbooPet, type PetState } from './VerbooPet'

vi.mock('../../i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

afterEach(() => cleanup())

const states: PetState[] = [
  'idle',
  'thinking',
  'reading',
  'editing',
  'deleting',
  'command',
  'success',
  'error',
]

function renderPet(state: PetState) {
  return render(
    <VerbooPet
      visible
      state={state}
      size={112}
      onSizeChange={vi.fn()}
    />,
  )
}

describe('VerbooPet expressive rig', () => {
  it('renders a segmented face and body that can animate independently', () => {
    const { container } = renderPet('idle')

    expect(container.querySelector('.pet-rig')).toBeInTheDocument()
    expect(container.querySelector('.pet-rig-body')).toBeInTheDocument()
    expect(container.querySelector('.pet-rig-eyes')).toBeInTheDocument()
    expect(container.querySelector('.pet-rig-mouth')).toBeInTheDocument()
    expect(container.querySelector('.pet-shadow')).toBeInTheDocument()
  })

  it.each(states)('keeps the %s choreography available to the active state', state => {
    const { container } = renderPet(state)
    const root = container.querySelector('.verboo-pet')

    expect(root).toHaveAttribute('data-state', state)
    expect(container.querySelector(`[data-pet-cue="${state}"]`)).toBeInTheDocument()
  })

  it('ships named motion sequences and a reduced-motion alternative', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/renderer/styles/ui-overlays.css'), 'utf8')

    for (const state of states) {
      expect(css).toContain(`@keyframes pet-${state}-premium`)
    }
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.pet-rig/)
  })
})

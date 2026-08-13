import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ProviderIcon } from './ProviderIcon'

vi.mock('../../../../assets/branding/verboo-mascot.png', () => ({ default: 'mascot.png' }))

// Brand icons (user-authorized): official inline SVG glyphs for known provider
// ids, generic initial tile for any unknown id — nothing hardcoded beyond the
// optional mapping. Decorative: aria-hidden, name is always text beside it.
describe('ProviderIcon', () => {
  it('claude renders the Anthropic sunburst in official terracotta #D97757', () => {
    const { container } = render(<ProviderIcon providerId="claude" size={22} />)
    const wrapper = screen.getByTestId('provider-icon-claude')
    const svg = wrapper.querySelector('svg')!
    expect(svg).toBeTruthy()
    expect(svg.getAttribute('fill')).toBe('#D97757')
    expect(svg.getAttribute('width')).toBe('22')
    expect(svg.getAttribute('height')).toBe('22')
    expect(container.querySelector('.provider-icon-fallback')).toBeNull()
  })

  it('codex renders the OpenAI knot in currentColor (follows the theme)', () => {
    render(<ProviderIcon providerId="codex" size={13} />)
    const svg = screen.getByTestId('provider-icon-codex').querySelector('svg')!
    expect(svg.getAttribute('fill')).toBe('currentColor')
  })

  it('T16: verboo renders the house mascot PNG (not a fallback tile, not an SVG)', () => {
    const { container } = render(<ProviderIcon providerId="verboo" size={11} />)
    const wrapper = screen.getByTestId('provider-icon-verboo')
    const img = wrapper.querySelector('img.provider-icon-mascot')!
    expect(img).toBeTruthy()
    expect(img.getAttribute('src')).toBe('mascot.png')
    expect(img.getAttribute('width')).toBe('11')
    expect(img.getAttribute('height')).toBe('11')
    expect(container.querySelector('.provider-icon-fallback')).toBeNull()
    expect(wrapper.querySelector('svg')).toBeNull()
  })

  it('unknown provider id falls back to a generic initial tile (no invented glyph)', () => {
    render(<ProviderIcon providerId="acme" size={22} />)
    const wrapper = screen.getByTestId('provider-icon-acme')
    expect(wrapper.querySelector('svg')).toBeNull()
    const tile = wrapper.querySelector('.provider-icon-fallback')!
    expect(tile.textContent).toBe('A')
  })

  it('is decorative: aria-hidden on the wrapper (provider name rides as text beside it)', () => {
    render(<ProviderIcon providerId="claude" />)
    expect(screen.getByTestId('provider-icon-claude').getAttribute('aria-hidden')).toBe('true')
  })
})

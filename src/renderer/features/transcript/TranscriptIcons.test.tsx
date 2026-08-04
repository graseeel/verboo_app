import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { ActionIcon } from './TranscriptIcons'

// FRENTE-A (2026-08-02): the browser kind must render the generic globe —
// a deliberate brand decision: NEVER the Google Chrome logo (trademarked,
// and the app is publicly distributed and signed under the owner's name).
// The word "Chrome" lives in the LABEL, not the icon. The exact path pins
// the globe; a swap to a brand logo (or a fallback to the default icon)
// fails this test.
const GLOBE_PATH =
  'M2.5 8h11M8 2.5c1.5 1.5 2.2 3.4 2.2 5.5S9.5 12 8 13.5C6.5 12 5.8 10.1 5.8 8S6.5 4 8 2.5'

describe('ActionIcon browser kind', () => {
  it('renders the generic globe for browser actions', () => {
    const { container } = render(<ActionIcon kind="browser" />)
    expect(container.querySelector(`path[d="${GLOBE_PATH}"]`)).not.toBeNull()
  })
})

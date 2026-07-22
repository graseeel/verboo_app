import { describe, expect, it } from 'vitest'
import { browserContentBounds } from './browserBounds'

describe('browserContentBounds', () => {
  it('matches the live content rectangle exactly', () => {
    expect(browserContentBounds({
      rect: { left: 732, top: 112, width: 680, height: 708 },
      browserWidth: 680,
      viewportWidth: 1412,
    })).toEqual({
      x: 732,
      y: 112,
      width: 680,
      height: 708,
    })
  })

  it('uses the docked panel geometry before the content rectangle is measurable', () => {
    expect(browserContentBounds({
      rect: null,
      browserWidth: 680,
      viewportWidth: 1412,
    })).toEqual({
      x: 732,
      y: 112,
      width: 680,
      height: 600,
    })
  })
})

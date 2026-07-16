import { describe, expect, it } from 'vitest'
import { computerUseIconDataUrl } from './computerUseIcon'

describe('computerUseIconDataUrl', () => {
  it('accepts only a bounded PNG base64 payload', () => {
    expect(computerUseIconDataUrl('iVBORw0KGgoAAA==')).toBe(
      'data:image/png;base64,iVBORw0KGgoAAA==',
    )
    expect(computerUseIconDataUrl('javascript:alert(1)')).toBeUndefined()
    expect(computerUseIconDataUrl('R0lGODlhAQABAIAAAAUEBA==')).toBeUndefined()
    expect(computerUseIconDataUrl(`iVBORw0KGgo${'A'.repeat(90_000)}`)).toBeUndefined()
  })
})

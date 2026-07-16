import { describe, expect, it } from 'vitest'
import { computerUsePolicyForApp } from './appControlTier'

describe('computerUsePolicyForApp', () => {
  it('limits browsers and finance apps to view only', () => {
    expect(computerUsePolicyForApp('com.apple.Safari')).toEqual({
      tier: 'view_only',
      scope: 'view',
      sentinelConfirmationRequired: false,
    })
    expect(computerUsePolicyForApp('com.tradingview.TradingViewApp').tier).toBe('view_only')
  })

  it('limits terminals and IDEs to pointer input without typing', () => {
    expect(computerUsePolicyForApp('com.apple.Terminal')).toMatchObject({
      tier: 'click_only',
      scope: 'input',
    })
    expect(computerUsePolicyForApp('com.microsoft.VSCode').tier).toBe('click_only')
  })

  it('allows explicitly approved unclassified apps at full control', () => {
    expect(computerUsePolicyForApp('com.apple.Notes')).toMatchObject({
      tier: 'full_control',
      scope: 'full',
    })
    expect(computerUsePolicyForApp('com.example.Unknown')).toMatchObject({
      tier: 'full_control',
      scope: 'full',
    })
  })

  it('classifies unlisted browsers and developer tools by display name', () => {
    expect(computerUsePolicyForApp('com.example.Custom', 'Acme Finance Browser').tier).toBe('view_only')
    expect(computerUsePolicyForApp('com.example.Custom', 'Acme Developer IDE').tier).toBe('click_only')
  })

  it('marks Finder and System Settings as per-session sentinels', () => {
    expect(computerUsePolicyForApp('com.apple.finder').sentinelConfirmationRequired).toBe(true)
    expect(computerUsePolicyForApp('com.apple.systempreferences').sentinelConfirmationRequired).toBe(true)
  })
})

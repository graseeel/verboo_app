import type { ComputerUseAppTier, ComputerUseScope } from '../../../shared/types'

export type ComputerUseAppPolicy = {
  tier: ComputerUseAppTier
  scope: ComputerUseScope
  sentinelConfirmationRequired: boolean
}

const VIEW_ONLY_APPS = new Set([
  'com.apple.safari',
  'com.google.chrome',
  'org.mozilla.firefox',
  'com.microsoft.edgemac',
  'com.brave.browser',
  'com.operasoftware.opera',
  'com.tradingview.tradingviewapp',
])

const CLICK_ONLY_APPS = new Set([
  'com.apple.terminal',
  'com.googlecode.iterm2',
  'dev.warp.warp-stable',
  'com.microsoft.vscode',
  'com.todesktop.230313mzl4w4u92',
  'com.sublimetext.4',
])

const SENTINEL_APPS = new Set(['com.apple.systempreferences', 'com.apple.finder'])

const TIER_ORDER: ComputerUseAppTier[] = ['view_only', 'click_only', 'full_control']

export function availableComputerUseTiers(maximum: ComputerUseAppTier): ComputerUseAppTier[] {
  return TIER_ORDER.slice(0, TIER_ORDER.indexOf(maximum) + 1)
}

export function scopeForComputerUseTier(tier: ComputerUseAppTier): ComputerUseScope {
  if (tier === 'view_only') return 'view'
  if (tier === 'click_only') return 'input'
  return 'full'
}

export function isComputerUseTierAtMost(
  tier: ComputerUseAppTier,
  maximum: ComputerUseAppTier,
): boolean {
  return TIER_ORDER.indexOf(tier) <= TIER_ORDER.indexOf(maximum)
}

export function computerUseSentinelWarningKey(bundleId: string): string {
  const normalized = bundleId.trim().toLowerCase()
  if (normalized === 'com.apple.finder') return 'computerUse.consent.sentinel.finder'
  if (normalized === 'com.apple.systempreferences') return 'computerUse.consent.sentinel.systemSettings'
  return 'computerUse.consent.sentinel'
}

export function computerUsePolicyForApp(bundleId: string, displayName = ''): ComputerUseAppPolicy {
  const bundle = bundleId.trim().toLowerCase()
  const identity = `${bundle} ${displayName.trim().toLowerCase()}`
  const sentinelConfirmationRequired = SENTINEL_APPS.has(bundle)

  if (VIEW_ONLY_APPS.has(bundle) || [
    'browser', 'chrome', 'chromium', 'firefox', 'safari', 'opera',
    'trading', 'broker', 'finance', 'invest', 'marketwatch', 'stock',
  ].some(marker => identity.includes(marker))) {
    return { tier: 'view_only', scope: 'view', sentinelConfirmationRequired }
  }
  if (CLICK_ONLY_APPS.has(bundle) || [
    'terminal', 'iterm', 'warp', 'jetbrains', 'intellij', 'xcode',
    'vscode', 'visual studio code', 'sublime', 'cursor', 'windsurf', 'zed', ' ide',
  ].some(marker => identity.includes(marker))) {
    return { tier: 'click_only', scope: 'input', sentinelConfirmationRequired }
  }
  return { tier: 'full_control', scope: 'full', sentinelConfirmationRequired }
}

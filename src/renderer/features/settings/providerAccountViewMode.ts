/**
 * VIEW — user-chosen provider list view mode, persisted LOCALLY (localStorage,
 * same pattern as providerAccountNicknames). The CLI protocol is sanitized and
 * must never carry UI preferences: this is a renderer-only cosmetic layer.
 *
 * 'simple'   = compact cards, max 3 per line, wrap (default)
 * 'expanded' = full-width vertical rows (one account below the other)
 */

const STORAGE_KEY = 'verboo.providerAccountViewMode'

export type ProviderAccountViewMode = 'simple' | 'expanded'

const VALID_MODES: readonly ProviderAccountViewMode[] = ['simple', 'expanded']

export function getProviderAccountViewMode(): ProviderAccountViewMode {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw && (VALID_MODES as readonly string[]).includes(raw)) {
      return raw as ProviderAccountViewMode
    }
  } catch {
    // corrupted/unavailable storage → default
  }
  return 'simple'
}

export function setProviderAccountViewMode(mode: ProviderAccountViewMode): void {
  window.localStorage.setItem(STORAGE_KEY, mode)
}

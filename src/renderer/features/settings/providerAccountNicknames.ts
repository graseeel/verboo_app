import type { ExternalProviderId } from '../../../shared/types'

/**
 * P3 — user-editable account nicknames, persisted LOCALLY (localStorage).
 * The CLI protocol is sanitized and must never carry user-entered labels:
 * this is a renderer-only cosmetic layer. Precedence when displaying:
 * nickname ?? CLI displayLabel.
 */

const STORAGE_KEY = 'verboo.providerAccountNicknames'

function accountKey(provider: ExternalProviderId, accountId: string): string {
  return `${provider}:${accountId}`
}

function readMap(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, string>
      : {}
  } catch {
    return {}
  }
}

function writeMap(map: Record<string, string>): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
}

export function getProviderAccountNickname(provider: ExternalProviderId, accountId: string): string | undefined {
  const value = readMap()[accountKey(provider, accountId)]
  return value?.trim() ? value.trim() : undefined
}

export function setProviderAccountNickname(provider: ExternalProviderId, accountId: string, nickname: string): void {
  const map = readMap()
  const trimmed = nickname.trim()
  if (!trimmed) {
    delete map[accountKey(provider, accountId)]
  } else {
    map[accountKey(provider, accountId)] = trimmed
  }
  writeMap(map)
}

export function clearProviderAccountNickname(provider: ExternalProviderId, accountId: string): void {
  const map = readMap()
  delete map[accountKey(provider, accountId)]
  writeMap(map)
}

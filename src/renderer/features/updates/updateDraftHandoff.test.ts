import { beforeEach, describe, expect, it } from 'vitest'

import {
  clearUpdateDraftHandoff,
  consumeUpdateDraftHandoff,
  UPDATE_DRAFT_HANDOFF_KEY,
  writeUpdateDraftHandoff,
} from './updateDraftHandoff'

describe('updateDraftHandoff', () => {
  beforeEach(() => localStorage.clear())

  it('stores only non-empty drafts and consumes them once', () => {
    writeUpdateDraftHandoff(localStorage, { a: 'keep me', b: '   ' }, 'a')

    expect(consumeUpdateDraftHandoff(localStorage)).toEqual({
      version: 1,
      activeKey: 'a',
      drafts: { a: 'keep me' },
    })
    expect(consumeUpdateDraftHandoff(localStorage)).toBeUndefined()
  })

  it('discards malformed or unsupported payloads', () => {
    localStorage.setItem(UPDATE_DRAFT_HANDOFF_KEY, '{bad json')
    expect(consumeUpdateDraftHandoff(localStorage)).toBeUndefined()
    expect(localStorage.getItem(UPDATE_DRAFT_HANDOFF_KEY)).toBeNull()

    localStorage.setItem(
      UPDATE_DRAFT_HANDOFF_KEY,
      JSON.stringify({ version: 2, activeKey: 'a', drafts: { a: 'draft' } }),
    )
    expect(consumeUpdateDraftHandoff(localStorage)).toBeUndefined()
  })

  it('rejects arrays and non-string draft values', () => {
    localStorage.setItem(
      UPDATE_DRAFT_HANDOFF_KEY,
      JSON.stringify({ version: 1, activeKey: 'a', drafts: [] }),
    )
    expect(consumeUpdateDraftHandoff(localStorage)).toBeUndefined()

    localStorage.setItem(
      UPDATE_DRAFT_HANDOFF_KEY,
      JSON.stringify({ version: 1, activeKey: 'a', drafts: { a: 42 } }),
    )
    expect(consumeUpdateDraftHandoff(localStorage)).toBeUndefined()
  })

  it('clears a handoff after a restart failure', () => {
    writeUpdateDraftHandoff(localStorage, { a: 'draft' }, 'a')
    clearUpdateDraftHandoff(localStorage)
    expect(consumeUpdateDraftHandoff(localStorage)).toBeUndefined()
  })
})

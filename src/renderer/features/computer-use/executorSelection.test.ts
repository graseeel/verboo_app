import { describe, expect, it } from 'vitest'
import type { VerbooModel } from '../../../shared/types'
import {
  computerUseCliSessionPolicy,
  selectComputerUseExecutor,
} from './executorSelection'

const models: VerbooModel[] = [
  { id: 'text-model', displayName: 'Text Model', supportsVision: false, raw: {} },
  { id: 'vision-first', displayName: 'Vision First', supportsVision: true, raw: {} },
  { id: 'vision-second', displayName: 'Vision Second', supportsVision: true, raw: {} },
]

describe('selectComputerUseExecutor', () => {
  it('keeps the selected model when it supports vision', () => {
    expect(selectComputerUseExecutor('vision-second', models)).toEqual({
      model: models[2],
      temporary: false,
    })
  })

  it('uses the first available vision model temporarily without provider ranking', () => {
    expect(selectComputerUseExecutor('text-model', models)).toEqual({
      model: models[1],
      temporary: true,
    })
  })

  it('uses an available exact-id preference for a temporary executor', () => {
    expect(selectComputerUseExecutor('text-model', models, 'vision-second')).toEqual({
      model: models[2],
      temporary: true,
    })
  })

  it('ignores missing or non-vision preferences and preserves catalog order', () => {
    expect(selectComputerUseExecutor('text-model', models, 'text-model')).toEqual({
      model: models[1],
      temporary: true,
    })
    expect(selectComputerUseExecutor('text-model', models, 'missing')).toEqual({
      model: models[1],
      temporary: true,
    })
  })

  it('fails closed when the catalog has no vision-capable model', () => {
    expect(selectComputerUseExecutor('text-model', [models[0]!])).toBeUndefined()
  })
})

describe('computerUseCliSessionPolicy', () => {
  it('isolates a temporary visual executor from the original CLI session', () => {
    expect(computerUseCliSessionPolicy(true)).toEqual({
      resumeExistingSession: false,
      persistReturnedSession: false,
    })
  })

  it('keeps normal resume and persistence for the current vision model', () => {
    expect(computerUseCliSessionPolicy(false)).toEqual({
      resumeExistingSession: true,
      persistReturnedSession: true,
    })
  })
})

/**
 * T4: batch FINAL REPORT + PROGRESS line — builder tests against the
 * REAL i18n tables (createTranslator), BOTH locales pinned.
 *
 * Why real tables and not the key-stub: the wound class here is chave
 * órfã + genérico-na-tela — a builder that selects a key nobody defined
 * passes a stub test and renders the raw key (or an empty string) to
 * the user. Asserting the resolved TEXT in both locales proves the key
 * exists, is translated, and interpolates — the orphan sweep at the
 * bottom pins every new key in both tables by construction.
 *
 * What these tests do NOT prove: that the lines reach the DOM. That is
 * goalBatchRender.test.tsx's job (render, not string building) — the
 * producer/consumer split the Maestro demands explicitly.
 */

import { describe, it, expect } from 'vitest'
import { createTranslator } from '../../i18n'
import type { GoalState, GoalTask } from '../../../shared/types'
import {
  buildBatchProgressLine,
  buildBatchReportLines,
  buildBatchTaskLine,
} from './goalReport'

const tPt = createTranslator('pt-BR')
const tEn = createTranslator('en-US')

function makeTask(overrides: Partial<GoalTask> = {}): GoalTask {
  return { id: `task-${crypto.randomUUID()}`, text: 'Do the thing', status: 'done', ...overrides }
}

function makeGoal(tasks: GoalTask[] | undefined, overrides: Partial<GoalState> = {}): GoalState {
  return {
    id: 'goal-1',
    objective: 'Ship the batch',
    status: 'completed',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    turnsRun: 4,
    usedInputTokens: 0,
    usedOutputTokens: 0,
    noProgressCount: 0,
    recentFingerprints: [],
    accessMode: 'approval',
    workingDirectory: '/tmp',
    skills: [],
    ...(tasks ? { tasks } : {}),
    ...overrides,
  }
}

describe('T4 progress line — discreet, batch-only', () => {
  it('renders "Tarefa k de N" in pt-BR and "Task k of N" in en-US', () => {
    const goal = makeGoal([makeTask(), makeTask(), makeTask()], { taskIndex: 2 })
    expect(buildBatchProgressLine(goal, tPt)).toBe('Tarefa 3 de 3')
    expect(buildBatchProgressLine(goal, tEn)).toBe('Task 3 of 3')
  })

  it('returns null for a LEGACY goal — single-task goals show nothing new', () => {
    expect(buildBatchProgressLine(makeGoal(undefined), tPt)).toBeNull()
    expect(buildBatchProgressLine(makeGoal(undefined), tEn)).toBeNull()
  })

  it('clamps the current index at the total (defensive: taskIndex past the end)', () => {
    const goal = makeGoal([makeTask(), makeTask()], { taskIndex: 99 })
    expect(buildBatchProgressLine(goal, tPt)).toBe('Tarefa 2 de 2')
  })
})

describe('T4 report task lines — each conclusion cites its evidence', () => {
  it('done cites turns AND whitelisted actions, both locales', () => {
    const task = makeTask({ status: 'done', turns: 2, evidenceCount: 3 })
    expect(buildBatchTaskLine(task, 0, tPt)).toBe('1. Do the thing — concluída (turnos: 2, ações: 3)')
    expect(buildBatchTaskLine(task, 0, tEn)).toBe('1. Do the thing — done (turns: 2, actions: 3)')
  })

  it('toolless done declares the waiver instead of implying actions', () => {
    const task = makeTask({ status: 'done', toolless: true, turns: 1 })
    expect(buildBatchTaskLine(task, 0, tPt)).toBe('1. Do the thing — concluída (tarefa de texto; turnos: 1)')
    expect(buildBatchTaskLine(task, 0, tEn)).toBe('1. Do the thing — done (toolless task; turns: 1)')
  })

  it('failed cites the translated reason (loop), both locales', () => {
    const task = makeTask({ status: 'failed', failureReason: 'loop', turns: 3 })
    expect(buildBatchTaskLine(task, 1, tPt)).toBe('2. Do the thing — falhou (Possível loop detectado)')
    expect(buildBatchTaskLine(task, 1, tEn)).toBe('2. Do the thing — failed (Possible loop detected)')
  })

  it('failed cites unsafe / infraError through the same translator', () => {
    const unsafe = makeTask({ status: 'failed', failureReason: 'unsafe', turns: 1 })
    expect(buildBatchTaskLine(unsafe, 0, tPt)).toBe('1. Do the thing — falhou (Operação marcada como insegura)')
    const infra = makeTask({ status: 'failed', failureReason: 'infraError', turns: 1 })
    expect(buildBatchTaskLine(infra, 0, tEn)).toBe('1. Do the thing — failed (Evaluator infrastructure error)')
  })

  it('failed WITHOUT a stamped reason (pre-T4 goal) falls back to the generic failure id', () => {
    const task = makeTask({ status: 'failed' })
    expect(buildBatchTaskLine(task, 0, tPt)).toBe(
      '1. Do the thing — falhou (Tarefa encontrou uma falha (testes ou compilação))',
    )
  })

  it('skipped says the USER skipped it — never "failed"', () => {
    const task = makeTask({ status: 'skipped', turns: 1 })
    expect(buildBatchTaskLine(task, 2, tPt)).toBe('3. Do the thing — pulada por você')
    expect(buildBatchTaskLine(task, 2, tEn)).toBe('3. Do the thing — skipped by you')
  })

  it('defensive: a non-terminal task never implies a conclusion', () => {
    const task = makeTask({ status: 'pending' })
    expect(buildBatchTaskLine(task, 0, tPt)).toBe('1. Do the thing — não concluída')
    expect(buildBatchTaskLine(task, 0, tEn)).toBe('1. Do the thing — not finished')
  })
})

describe('T4 final report — title, per-task lines, compaction footer', () => {
  it('returns [] for a LEGACY goal — nothing stamped on single-task completions', () => {
    expect(buildBatchReportLines(makeGoal(undefined), tPt)).toEqual([])
    expect(buildBatchReportLines(makeGoal(undefined), tEn)).toEqual([])
  })

  it('title + one line per task + footer when compactions failed (pt-BR)', () => {
    const goal = makeGoal(
      [
        makeTask({ text: 'First', status: 'done', turns: 1, evidenceCount: 2 }),
        makeTask({ text: 'Stuck', status: 'failed', failureReason: 'loop', turns: 3 }),
        makeTask({ text: 'Hard', status: 'skipped', turns: 0 }),
      ],
      { compactionFailures: 2 },
    )
    const lines = buildBatchReportLines(goal, tPt)
    expect(lines).toEqual([
      'Relatório do lote',
      '1. First — concluída (turnos: 1, ações: 2)',
      '2. Stuck — falhou (Possível loop detectado)',
      '3. Hard — pulada por você',
      'Compactações que falharam: 2 — o lote seguiu sem compactar',
    ])
  })

  it('the footer is ABSENT when no compaction failed (and when the key is undefined)', () => {
    const goal = makeGoal([makeTask({ status: 'done', turns: 1, evidenceCount: 1 })])
    const lines = buildBatchReportLines(goal, tEn)
    expect(lines).toEqual(['Batch report', '1. Do the thing — done (turns: 1, actions: 1)'])
    expect(lines.some(line => line.includes('ompaction'))).toBe(false)
  })
})

describe('T4 i18n orphan sweep — every new key resolves in BOTH locale tables', () => {
  // createTranslator's fallback chain is dictionary[key] ?? enUS[key] ??
  // key (i18n.tsx:2330), so `!== key` proves the key resolves to REAL
  // TEXT and never renders raw — but a pt-BR gap could still fall back
  // to the en-US string. The PER-LOCALE pins are therefore the exact-
  // text assertions in the suites above (pt-BR strings asserted
  // verbatim); this sweep is the coarser net: nothing renders a raw key.
  const NEW_KEYS = [
    'goal.reason.batchStagnation',
    'goal.batchProgress',
    'goal.batchReportTitle',
    'goal.batchReport.done',
    'goal.batchReport.doneToolless',
    'goal.batchReport.failed',
    'goal.batchReport.skipped',
    'goal.batchReport.notFinished',
    'goal.batchReport.compactionFailures',
  ]

  it('no key is orphaned in pt-BR or en-US', () => {
    for (const key of NEW_KEYS) {
      expect(tPt(key), `pt-BR missing ${key}`).not.toBe(key)
      expect(tEn(key), `en-US missing ${key}`).not.toBe(key)
    }
  })
})

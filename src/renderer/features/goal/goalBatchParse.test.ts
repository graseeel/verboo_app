/**
 * T5 parser tests — the batch ENTRY contract.
 *
 * Two acceptance axes, tested as OUTCOME (what the caller does with the
 * result), not shape:
 *   - TOLERANT input: lists pasted from issues/notes/diffs must parse —
 *     numbered, bulleted, CRLF, blank lines, stacked markers.
 *   - ZERO single-task regression (aceite d, the most important one):
 *     one cleaned line produces { kind: 'single' } whose objective is
 *     byte-identical to what pre-T5 /goal received for marker-less
 *     input. The caller (App.tsx) only attaches `tasks` on kind 'batch',
 *     so a single task keeps the legacy goal field-by-field — no D1
 *     guard, no progress line, no per-task report.
 */
import { describe, expect, it } from 'vitest'
import { createTranslator } from '../../i18n'
import { parseBatchInput } from './goalBatchParse'

describe('parseBatchInput — tolerant batch input', () => {
  it('parses plain lines, one task per line, order preserved', () => {
    const result = parseBatchInput('fix the login bug\nadd tests for it\nupdate the docs')
    expect(result).toEqual({
      kind: 'batch',
      tasks: [
        { text: 'fix the login bug' },
        { text: 'add tests for it' },
        { text: 'update the docs' },
      ],
    })
  })

  it('strips numbered markers "1." "2." "3."', () => {
    const result = parseBatchInput('1. first task\n2. second task\n3. third task')
    expect(result).toEqual({
      kind: 'batch',
      tasks: [{ text: 'first task' }, { text: 'second task' }, { text: 'third task' }],
    })
  })

  it('strips numbered markers "1)" "2)"', () => {
    const result = parseBatchInput('1) first task\n2) second task')
    expect(result).toEqual({
      kind: 'batch',
      tasks: [{ text: 'first task' }, { text: 'second task' }],
    })
  })

  it('does NOT enforce number sequence — pasted "1. 1. 1." is still a list', () => {
    const result = parseBatchInput('1. alpha\n1. beta\n7. gamma')
    expect(result).toEqual({
      kind: 'batch',
      tasks: [{ text: 'alpha' }, { text: 'beta' }, { text: 'gamma' }],
    })
  })

  it.each([
    ['-', 'dash'],
    ['*', 'asterisk'],
    ['•', 'bullet'],
    ['–', 'en dash'],
    ['—', 'em dash'],
  ])('strips bullet marker %s (%s)', (marker) => {
    const result = parseBatchInput(`${marker} first task\n${marker} second task`)
    expect(result).toEqual({
      kind: 'batch',
      tasks: [{ text: 'first task' }, { text: 'second task' }],
    })
  })

  it('strips up to two stacked markers ("- 1. task" from nested pasted lists)', () => {
    const result = parseBatchInput('- 1. first task\n- 2. second task')
    expect(result).toEqual({
      kind: 'batch',
      tasks: [{ text: 'first task' }, { text: 'second task' }],
    })
  })

  it('handles CRLF line endings', () => {
    const result = parseBatchInput('first task\r\nsecond task\r\n')
    expect(result).toEqual({
      kind: 'batch',
      tasks: [{ text: 'first task' }, { text: 'second task' }],
    })
  })

  it('trims surrounding whitespace on every line', () => {
    const result = parseBatchInput('   first task   \n\tsecond task\t')
    expect(result).toEqual({
      kind: 'batch',
      tasks: [{ text: 'first task' }, { text: 'second task' }],
    })
  })

  it('ignores blank lines anywhere — they are not separators', () => {
    const result = parseBatchInput('\nfirst task\n\n\n\nsecond task\n\n')
    expect(result).toEqual({
      kind: 'batch',
      tasks: [{ text: 'first task' }, { text: 'second task' }],
    })
  })

  it('keeps "1.task" (no space after marker) as task text — likely a version or typo', () => {
    const result = parseBatchInput('1.2.0 is the target version')
    expect(result).toEqual({ kind: 'single', objective: '1.2.0 is the target version' })
  })

  it('preserves order and per-task flags across a mixed batch', () => {
    const result = parseBatchInput('1. refactor the parser\n2. [toolless] summarize the changes\n- write the changelog')
    expect(result).toEqual({
      kind: 'batch',
      tasks: [
        { text: 'refactor the parser' },
        { text: 'summarize the changes', toolless: true },
        { text: 'write the changelog' },
      ],
    })
  })
})

describe('parseBatchInput — [toolless] opt-out', () => {
  it('accepts the tag at the start of the line', () => {
    const result = parseBatchInput('[toolless] write a haiku\nfix the bug')
    expect(result).toEqual({
      kind: 'batch',
      tasks: [{ text: 'write a haiku', toolless: true }, { text: 'fix the bug' }],
    })
  })

  it('accepts the tag at the end of the line', () => {
    const result = parseBatchInput('write a haiku [toolless]\nfix the bug')
    expect(result).toEqual({
      kind: 'batch',
      tasks: [{ text: 'write a haiku', toolless: true }, { text: 'fix the bug' }],
    })
  })

  it('accepts the tag mid-line and collapses the leftover double space', () => {
    const result = parseBatchInput('explain [toolless] recursion\nfix the bug')
    expect(result).toEqual({
      kind: 'batch',
      tasks: [{ text: 'explain recursion', toolless: true }, { text: 'fix the bug' }],
    })
  })

  it('is case-insensitive', () => {
    const result = parseBatchInput('[TOOLLESS] write a haiku\nfix the bug')
    expect(result).toEqual({
      kind: 'batch',
      tasks: [{ text: 'write a haiku', toolless: true }, { text: 'fix the bug' }],
    })
  })
})

describe('parseBatchInput — rejected input yields a useful error (kind empty)', () => {
  it('empty string', () => {
    expect(parseBatchInput('')).toEqual({ kind: 'empty' })
  })

  it('only blank lines and whitespace', () => {
    expect(parseBatchInput('   \n\n  \t \n')).toEqual({ kind: 'empty' })
  })

  it('only bare markers — no task text anywhere', () => {
    expect(parseBatchInput('1.\n-\n2)')).toEqual({ kind: 'empty' })
  })

  it('only the [toolless] tag — a flag without a task is not a task', () => {
    expect(parseBatchInput('[toolless]')).toEqual({ kind: 'empty' })
  })
})

describe('parseBatchInput — single-task ZERO regression (aceite d)', () => {
  it('plain single objective is byte-identical to pre-T5 /goal input', () => {
    // Pre-T5, "/goal do X" started a goal whose objective was exactly
    // "do X". kind 'single' carries NO tasks array, so App.tsx cannot
    // attach batch behavior to it even by accident.
    expect(parseBatchInput('do X')).toEqual({ kind: 'single', objective: 'do X' })
  })

  it('single line with a marker keeps legacy shape, marker stripped', () => {
    expect(parseBatchInput('1. do X')).toEqual({ kind: 'single', objective: 'do X' })
  })

  it('single line drops the toolless flag — legacy goals have no D1 guard to opt out of', () => {
    const result = parseBatchInput('[toolless] write a haiku')
    expect(result).toEqual({ kind: 'single', objective: 'write a haiku' })
    // toEqual already proves there is no `toolless` key on the result.
  })

  it('two lines where one is blank still counts as ONE task — no phantom batch', () => {
    expect(parseBatchInput('do X\n\n')).toEqual({ kind: 'single', objective: 'do X' })
  })
})

describe('parseBatchInput — i18n pins (both locales, exact text)', () => {
  it('goal.batchObjective interpolates the count', () => {
    expect(createTranslator('en-US')('goal.batchObjective', { count: 3 })).toBe('Batch of 3 tasks')
    expect(createTranslator('pt-BR')('goal.batchObjective', { count: 3 })).toBe('Lote de 3 tarefas')
  })

  it('goal.batchEmpty teaches the format instead of just failing', () => {
    expect(createTranslator('en-US')('goal.batchEmpty')).toBe(
      'No tasks found. Write one task per line after /goal — markers like "1." or "-" are optional. Mark prose-only tasks with [toolless].',
    )
    expect(createTranslator('pt-BR')('goal.batchEmpty')).toBe(
      'Nenhuma tarefa encontrada. Escreva uma tarefa por linha após /goal — marcadores como "1." ou "-" são opcionais. Marque tarefas só de texto com [toolless].',
    )
  })

  it('goal.batchEditDisabled declares the v1 limitation', () => {
    expect(createTranslator('en-US')('goal.batchEditDisabled')).toBe(
      'Objective editing is disabled while a batch runs (v1)',
    )
    expect(createTranslator('pt-BR')('goal.batchEditDisabled')).toBe(
      'Edição de objetivo desabilitada durante um lote (v1)',
    )
  })

  it('goal.helpBody documents the batch form in both locales', () => {
    expect(createTranslator('en-US')('goal.helpBody')).toContain(
      '/goal with one task per line — run a batch of tasks in order, compacting between them',
    )
    expect(createTranslator('pt-BR')('goal.helpBody')).toContain(
      '/goal com uma tarefa por linha — executa um lote de tarefas em ordem, compactando entre elas',
    )
  })
})

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { ACTION_ACTIVITY_KINDS } from '../goal/goalState'

/**
 * checklistContract — cross-file pins for the TodoWrite checklist.
 *
 * These are SOURCE-TEXT pins in the rustSerdeContract tradition: they
 * exist for the properties no DOM test can assert (CSS units, JSX
 * ordering inside App.tsx, whitelist membership). Each pin cites the
 * failure it guards. The BEHAVIORAL half of every property is covered
 * in checklistPlacement.test.ts / ChecklistPanel.test.tsx /
 * useChecklistFlight.test.tsx — this file is the frontier, not the
 * proof of effect.
 */

const CSS_PATH = resolve(__dirname, '../../styles/checklist.css')
const APP_PATH = resolve(__dirname, '../../App.tsx')
const I18N_PATH = resolve(__dirname, '../../i18n.tsx')

const css = readFileSync(CSS_PATH, 'utf-8')
const app = readFileSync(APP_PATH, 'utf-8')
const i18n = readFileSync(I18N_PATH, 'utf-8')

describe('checklistContract: planning is NOT action (D1 guard)', () => {
  it("'planning' is NOT in ACTION_ACTIVITY_KINDS — TodoWrite can never satisfy the observable-action guard", () => {
    // The Rust side maps todowrite to kind="planning" ON PURPOSE:
    // planning is declaring intent, not acting. If 'planning' ever
    // enters this whitelist, an agent could satisfy the D1 guard by
    // writing the task list and doing nothing — the exact failure the
    // guard exists to catch, disguised as legitimate activity.
    expect(ACTION_ACTIVITY_KINDS).not.toContain('planning')
  })
})

describe('checklistContract: multiplatform CSS pins', () => {
  it('docked rows are sized in em/line-height, NOT pixels (font-metric guard)', () => {
    // Font metrics differ across platforms: a 19px row that fits macOS
    // overflows on Windows with a 1.1× metric. The approved design is
    // line-height units; a px height on .checklist-row is a regression.
    const rowBlocks = css.match(/\.checklist-row[^{]*\{[^}]*\}/g) ?? []
    expect(rowBlocks.length).toBeGreaterThan(0)
    for (const block of rowBlocks) {
      expect(block, `.checklist-row block must not use px heights: ${block}`).not.toMatch(
        /height:\s*[\d.]+px/,
      )
      expect(block, `.checklist-row block must not use px line-heights: ${block}`).not.toMatch(
        /line-height:\s*[\d.]+px/,
      )
    }
  })

  it('the reduced-motion kill block exists and zeroes the entrance + the check draw', () => {
    const reducedBlock = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)
    expect(reducedBlock, 'checklist.css must have a prefers-reduced-motion block').not.toBeNull()
    expect(reducedBlock![1]).toContain('.checklist-enter')
    expect(reducedBlock![1]).toContain('animation: none')
  })

  it('the EXIT is the exact reverse of the entrance (genie family) and reduced-motion kills it', () => {
    // User order (2026-08-01): the completed list leaves with a SMOOTH
    // exit — same family as the genie-in, never instant. The behavioral
    // sequence (dwell → exit → removal) is proven in
    // useChecklistCompletionExit.test.tsx; this pins the CSS half.
    const exitBlock = css.match(/\.checklist-exit\s*\{[^}]*\}/)
    expect(exitBlock, '.checklist-exit block must exist').not.toBeNull()
    expect(exitBlock![0]).toContain('checklist-genie-out')
    expect(exitBlock![0]).toContain('forwards')
    const keyframes = css.match(/@keyframes checklist-genie-out \{[\s\S]*?\n\}/)
    expect(keyframes).not.toBeNull()
    // Reverse of the entrance: ends at the entrance's FROM frame.
    expect(keyframes![0]).toContain('translateY(10px) scale(0.97)')
    const reducedBlock = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)
    expect(reducedBlock![1]).toContain('.checklist-exit')
  })

  it('the card never enters the composer band: the panel MEASURES .bottom-dock live', () => {
    // Field defect (2026-08-01, packaged app): the composer dock (z120)
    // drew OVER the card (z40) and hid the bottom rows. The fix is
    // geometric — proven by rectangle intersection in
    // checklistPlacement.test.ts — but it only bites if the clearance
    // is MEASURED live: the dock grows with multi-line input and its
    // metrics differ per OS, so a hardcoded px would break again.
    // This pins the measurement + the observer that re-contains a
    // parked card when the dock grows.
    const panel = readFileSync(resolve(__dirname, 'ChecklistPanel.tsx'), 'utf-8')
    expect(panel).toContain("document.querySelector('.bottom-dock')")
    expect(panel).toContain('bottomClearance')
    expect(panel).toContain('ResizeObserver')
  })

  it('the floating card NEVER uses translucency (shadow+border over solid elevated)', () => {
    const floating = css.match(/\.checklist-panel\.floating\s*\{[^}]*\}/)
    expect(floating).not.toBeNull()
    expect(floating![0]).toContain('background: var(--bg-elevated)')
    expect(floating![0]).toContain('box-shadow: var(--shadow)')
    expect(floating![0]).not.toMatch(/opacity:\s*0\./)
  })

  it('floating rows wrap to AT MOST two lines; docked rows keep the single-line ellipsis', () => {
    // Field defect (2026-07-31): real TodoWrite items are whole
    // sentences and the single-line ellipsis made steps illegible
    // ("Create lista1.txt with…"). The floating card is the READER form
    // (height of its own content): two lines max via line-clamp — free
    // wrap would let a 5-line step break the card's compactness. The
    // docked form keeps its approved single-line compactness. Anchored
    // at line start so the card block can't satisfy the docked check.
    const cardText = css.match(
      /^\.checklist-card-rows \.checklist-row \.checklist-row-text\s*\{[^}]*\}/m,
    )
    expect(cardText, 'card row-text block must exist').not.toBeNull()
    expect(cardText![0]).toContain('-webkit-line-clamp: 2')
    expect(cardText![0]).toContain('white-space: normal')
    expect(cardText![0]).not.toContain('nowrap')
    const dockedText = css.match(/^\.checklist-row-text\s*\{[^}]*\}/m)
    expect(dockedText, 'docked row-text block must exist').not.toBeNull()
    expect(dockedText![0]).toContain('white-space: nowrap')
    expect(dockedText![0]).toContain('text-overflow: ellipsis')
  })
})

describe('checklistContract: App.tsx wiring pins (JSX order + possession)', () => {
  it('the docked checklist renders BEFORE the goal panel inside the aux-stack (list → goal → composer)', () => {
    // The approved hierarchy: the goal always stays closest to the
    // composer. Pin: in App.tsx the docked ChecklistPanel block comes
    // before <GoalActivePanel within the aux-stack JSX. The DOM half
    // of this order is proven in ChecklistPanel.test.tsx.
    const checklistIdx = app.indexOf('<ChecklistPanel')
    const goalIdx = app.indexOf('<GoalActivePanel')
    expect(checklistIdx, 'App.tsx must render the docked ChecklistPanel').toBeGreaterThan(-1)
    expect(goalIdx, 'App.tsx must render GoalActivePanel').toBeGreaterThan(-1)
    expect(checklistIdx).toBeLessThan(goalIdx)
  })

  it('the checklist consumption keys by the OWNER conversation, not the active one', () => {
    // Possession: the handler resolves conversationId from
    // turnConversationIds (the turn's owner) BEFORE the todos branch.
    // Pin the order: the applyTodoWrite call must come after that
    // resolution and use the resolved conversationId.
    const todosIdx = app.indexOf('applyTodoWrite(prev, conversationId, activity.todos)')
    const resolveIdx = app.indexOf('turnConversationIds.current[event.turnId]')
    expect(todosIdx, 'App.tsx must consume activity.todos').toBeGreaterThan(-1)
    expect(resolveIdx).toBeGreaterThan(-1)
    expect(todosIdx).toBeGreaterThan(resolveIdx)
  })

  it('the floating card is portaled to document.body (never inside the fixed bottom-dock)', () => {
    expect(app).toContain('createPortal(')
    expect(app).toContain('document.body')
  })
})

describe('checklistContract: i18n — the five keys exist in BOTH locales, never orphaned', () => {
  const KEYS = [
    'checklist.regionLabel',
    'checklist.allDone',
    'checklist.float',
    'checklist.dock',
    'checklist.progress',
  ]

  for (const key of KEYS) {
    it(`'${key}' has exactly two locale entries (en-US + pt-BR)`, () => {
      const occurrences = i18n.match(new RegExp(`'${key.replace('.', '\\.')}'\\s*:`, 'g')) ?? []
      expect(occurrences, `'${key}' must exist exactly twice in i18n.tsx`).toHaveLength(2)
    })
  }

  it('every checklist.* key in the dictionaries has a consumer', () => {
    // Orphan-key sweep in the other direction: no checklist.* key may
    // exist without a t() consumer in the feature.
    const dictKeys = new Set(
      (i18n.match(/'(checklist\.[a-zA-Z]+)'\s*:/g) ?? []).map(m => m.replace(/[':]/g, '').trim()),
    )
    const panel = readFileSync(resolve(__dirname, 'ChecklistPanel.tsx'), 'utf-8')
    for (const key of dictKeys) {
      expect(panel, `i18n key '${key}' has no t() consumer in ChecklistPanel.tsx`).toContain(
        `t('${key}'`,
      )
    }
  })
})

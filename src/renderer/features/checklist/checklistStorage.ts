import type { ChecklistCardPos, ChecklistFormPreference } from './checklistPlacement'

/**
 * checklistStorage — persisted user choices for the checklist.
 * Follows the repo's `verboo:*` localStorage pattern (lazy read with
 * validation, write wrapped in try/catch — quota is optional).
 *
 * USER RULE 2: the FORM is the user's choice and PERSISTS — floating
 * card on the right, or always docked above the composer. Default is
 * 'float' (the approved hierarchy: the right side is the preferred
 * home whenever it is free).
 *
 * The card's resting position also persists (approved prototype Q1):
 * a position is a deliberate arrangement of the user's screen;
 * resetting it every session would punish the choice repeatedly.
 * Restore-time containment into the window bounds is the COMPONENT's
 * job (multiplatform rule) — this module only guarantees the shape.
 */

const FORM_KEY = 'verboo:checklist-form'
const CARD_POS_KEY = 'verboo:checklist-cardpos'

export function readChecklistFormPreference(): ChecklistFormPreference {
  try {
    const raw = window.localStorage.getItem(FORM_KEY)
    return raw === 'dock' || raw === 'float' ? raw : 'float'
  } catch {
    return 'float'
  }
}

export function writeChecklistFormPreference(pref: ChecklistFormPreference): void {
  try {
    window.localStorage.setItem(FORM_KEY, pref)
  } catch {
    // optional persistence — a full quota must never break the toggle
  }
}

export function readChecklistCardPos(): ChecklistCardPos | null {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(CARD_POS_KEY) ?? 'null')
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      Number.isFinite((parsed as ChecklistCardPos).x) &&
      Number.isFinite((parsed as ChecklistCardPos).y)
    ) {
      return parsed as ChecklistCardPos
    }
    return null
  } catch {
    return null
  }
}

export function writeChecklistCardPos(pos: ChecklistCardPos | null): void {
  try {
    if (pos === null) window.localStorage.removeItem(CARD_POS_KEY)
    else window.localStorage.setItem(CARD_POS_KEY, JSON.stringify(pos))
  } catch {
    // optional persistence
  }
}

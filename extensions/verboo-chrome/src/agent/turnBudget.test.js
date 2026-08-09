import { test } from 'node:test'
import assert from 'node:assert/strict'

test('long browser tasks have the approved step and wall-clock budgets', async () => {
  const budget = await import('./turnBudget.js').catch(() => ({}))
  assert.equal(budget.MAX_AGENT_STEPS, 200)
  assert.equal(budget.MAX_AGENT_TURN_MS, 60 * 60_000)
})

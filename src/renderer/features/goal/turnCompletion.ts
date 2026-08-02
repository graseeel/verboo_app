/**
 * D-C: settle the goal scheduler's turn-completion deferred ONLY AFTER
 * the turn's summary item exists — or after the summary append FAILED.
 *
 * The race this closes (field-test defect): the App's turn-'done' handler
 * fired `appendTurnSummary` (which awaits an IPC before creating the
 * `${turnId}:summary` transcript item) and resolved the goal turn
 * deferred SYNCHRONOUSLY in the same block. The goal scheduler then
 * continued in a microtask and the batch progress stamp looked for a
 * summary item that did not exist yet — found nothing, returned
 * SILENTLY, and never retried for that turnId. Result: "Tarefa k de N"
 * never reached the screen.
 *
 * The contract this function owns: the deferred means "the turn finished
 * AND its transcript artifacts exist", so every downstream consumer
 * (progress stamp, completion report, D1 evidence counting) sees a
 * consistent transcript. Resolution happens in `finally` — a summary
 * failure must NEVER hang the goal loop — and cleanup runs BEFORE
 * resolution so no turn state leaks into the scheduler's continuation.
 */
export function settleGoalTurnAfterSummary(
  summary: Promise<unknown>,
  settle: {
    /** cleanupTurnState — runs before resolution. */
    cleanup: () => void
    /** Resolves the scheduler's turn-completion deferred. */
    resolveGoalTurn: () => void
  },
): void {
  void summary
    .catch(() => undefined)
    .finally(() => {
      settle.cleanup()
      settle.resolveGoalTurn()
    })
}

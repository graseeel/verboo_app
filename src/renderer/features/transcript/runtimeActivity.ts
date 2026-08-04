import type { RuntimeActivity } from '../../../shared/types'

/**
 * Decides whether a runtime activity should become a transcript item.
 * TodoWrite is rendered by ChecklistPanel, and repeated stream events for a
 * tool call represent one operation even when their activity keys differ.
 */
export function registerRuntimeActivity(
  activity: Pick<RuntimeActivity, 'kind' | 'key' | 'toolUseId'>,
  seenKeys: Set<string>,
  seenToolUseIds: Set<string>,
): boolean {
  if (activity.kind === 'planning') return false
  if (seenKeys.has(activity.key)) return false
  if (activity.toolUseId && seenToolUseIds.has(activity.toolUseId)) return false

  seenKeys.add(activity.key)
  if (activity.toolUseId) seenToolUseIds.add(activity.toolUseId)
  return true
}

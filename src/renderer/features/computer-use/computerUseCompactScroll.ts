type ComputerUseTranscriptScrollInput = {
  following: boolean
  compact: boolean
  streaming: boolean
}

/** Pure decision boundary for transcript follow behavior. An activity/layout
 * update must never pull a user away from content they deliberately scrolled
 * up to inspect. */
export function nextComputerUseTranscriptScroll({
  following,
  compact,
  streaming,
}: ComputerUseTranscriptScrollInput): ScrollBehavior | undefined {
  if (!following) return undefined
  return compact || streaming ? 'auto' : 'smooth'
}

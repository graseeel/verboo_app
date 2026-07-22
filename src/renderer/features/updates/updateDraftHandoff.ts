export const UPDATE_DRAFT_HANDOFF_KEY = 'verboo:update-drafts:v1'

export type UpdateDraftHandoff = {
  version: 1
  activeKey: string
  drafts: Record<string, string>
}

export function writeUpdateDraftHandoff(
  storage: Storage,
  drafts: Record<string, string>,
  activeKey: string,
) {
  const nonEmpty = Object.fromEntries(
    Object.entries(drafts).filter(([, value]) => value.trim().length > 0),
  )
  const handoff: UpdateDraftHandoff = {
    version: 1,
    activeKey,
    drafts: nonEmpty,
  }
  storage.setItem(UPDATE_DRAFT_HANDOFF_KEY, JSON.stringify(handoff))
}

export function consumeUpdateDraftHandoff(
  storage: Storage,
): UpdateDraftHandoff | undefined {
  const raw = storage.getItem(UPDATE_DRAFT_HANDOFF_KEY)
  storage.removeItem(UPDATE_DRAFT_HANDOFF_KEY)
  if (!raw) return undefined

  try {
    const value = JSON.parse(raw) as unknown
    if (!isUpdateDraftHandoff(value)) return undefined
    return value
  } catch {
    return undefined
  }
}

export function clearUpdateDraftHandoff(storage: Storage) {
  storage.removeItem(UPDATE_DRAFT_HANDOFF_KEY)
}

function isUpdateDraftHandoff(value: unknown): value is UpdateDraftHandoff {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Partial<UpdateDraftHandoff>
  if (
    candidate.version !== 1 ||
    typeof candidate.activeKey !== 'string' ||
    !candidate.drafts ||
    typeof candidate.drafts !== 'object' ||
    Array.isArray(candidate.drafts)
  ) {
    return false
  }
  return Object.values(candidate.drafts).every(draft => typeof draft === 'string')
}

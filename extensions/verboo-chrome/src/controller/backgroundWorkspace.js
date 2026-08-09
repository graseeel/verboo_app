const BACKGROUND_WORKSPACE_KEY = 'verbooBackgroundWorkspace'

/**
 * Keeps the browser target stable for one agent turn. The target may change
 * only through an explicit tabs action, and only inside the Verboo workspace.
 */
export function createTurnTabLease(tabId, windowId, { onSelect } = {}) {
  let currentTabId = tabId

  return {
    snapshot() {
      return { tabId: currentTabId, windowId }
    },
    async selectTab(nextTabId, nextWindowId) {
      if (nextWindowId !== windowId) throw new Error('outside_workspace')
      currentTabId = nextTabId
      await onSelect?.({ tabId: currentTabId, windowId })
    },
  }
}

/**
 * Owns a dedicated, unfocused Chrome window for agent-controlled browsing.
 * Durable extension storage lets a restarted or reloaded MV3 service worker
 * recover the same target. Session storage remains a migration fallback for
 * workspaces created by older builds.
 */
export function createBackgroundWorkspaceManager({ chromeApi = chrome } = {}) {
  let currentLease = null

  const persist = async (snapshot) => {
    await Promise.all([
      chromeApi.storage.local.set({ [BACKGROUND_WORKSPACE_KEY]: snapshot }),
      chromeApi.storage.session.set({ [BACKGROUND_WORKSPACE_KEY]: snapshot }),
    ])
  }

  const restore = async () => {
    const cached = currentLease?.snapshot()
    const durable = cached
      ? null
      : (await chromeApi.storage.local.get(BACKGROUND_WORKSPACE_KEY))?.[BACKGROUND_WORKSPACE_KEY]
    const legacySession = cached || durable
      ? null
      : (await chromeApi.storage.session.get(BACKGROUND_WORKSPACE_KEY))?.[BACKGROUND_WORKSPACE_KEY]
    const stored = cached ?? durable ?? legacySession
    if (!stored?.tabId || !stored?.windowId) return null

    try {
      const [tab] = await Promise.all([
        chromeApi.tabs.get(stored.tabId),
        chromeApi.windows.get(stored.windowId),
      ])
      if (tab?.windowId !== stored.windowId) return null
      currentLease = createLease(stored.tabId, stored.windowId)
      if (!durable) await persist(currentLease.snapshot())
      return currentLease
    } catch {
      return null
    }
  }

  const createLease = (tabId, windowId) => createTurnTabLease(tabId, windowId, {
    onSelect: persist,
  })

  return {
    async acquire({ sourceTabId, resume = false } = {}) {
      const existing = await restore()
      if (existing) {
        if (!resume) {
          const sourceUrl = await resolveSourceUrl(chromeApi, sourceTabId)
          if (sourceUrl) {
            const { tabId } = existing.snapshot()
            await chromeApi.tabs.update(tabId, { url: sourceUrl })
          }
        }
        return existing
      }

      const sourceUrl = await resolveSourceUrl(chromeApi, sourceTabId)
      const workspaceWindow = await chromeApi.windows.create({
        url: sourceUrl ?? 'about:blank',
        focused: false,
        type: 'normal',
      })
      const tab = workspaceWindow?.tabs?.[0]
      if (!tab?.id || !workspaceWindow?.id) throw new Error('background_workspace_unavailable')

      currentLease = createLease(tab.id, workspaceWindow.id)
      await persist(currentLease.snapshot())
      return currentLease
    },
  }
}

async function resolveSourceUrl(chromeApi, sourceTabId) {
  if (typeof sourceTabId !== 'number') return null
  try {
    const sourceTab = await chromeApi.tabs.get(sourceTabId)
    return /^https?:\/\//i.test(sourceTab?.url ?? '') ? sourceTab.url : null
  } catch {
    return null
  }
}

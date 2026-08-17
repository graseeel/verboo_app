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

  const logLease = async (lease) => {
    try {
      const tab = await chromeApi.tabs.get(lease.snapshot().tabId)
      console.log(
        '[verboo-workspace] lease tab', tab.id, 'window', tab.windowId,
        'url', tab.url, 'status', tab.status,
      )
    } catch (err) {
      console.log('[verboo-workspace] lease tab', lease.snapshot().tabId, 'unreadable:', err?.message ?? err)
    }
  }

  return {
    async acquire({ sourceTabId, resume = false } = {}) {
      const existing = await restore()
      if (existing) {
        if (!resume) {
          const sourceUrl = await resolveSourceUrl(chromeApi, sourceTabId)
          if (sourceUrl) {
            const { tabId } = existing.snapshot()
            await chromeApi.tabs.update(tabId, { url: sourceUrl })
            // PÓS-CAMPO-6 (B): the update starts a navigation — tool calls
            // issued before it finishes run against the OLD document and
            // every selector fails not-found. Wait for the load to land.
            await waitForTabComplete(chromeApi, tabId)
          }
        }
        // INSTRUMENTAÇÃO (pós-round 8): which surface the turn is about to
        // act on — readable in the service-worker console.
        await logLease(existing)
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
      await waitForTabComplete(chromeApi, tab.id)
      // INSTRUMENTAÇÃO: see above.
      await logLease(currentLease)
      return currentLease
    },

    /**
     * PÓS-CAMPO-6 (B) + PÓS-CAMPO-7: like acquire, but REVALIDATES the
     * lease target:
     *   - controlability: a restored lease can sit on a blank/stale
     *     NON-controllable tab → discarded and re-acquired;
     *   - PÓS-CAMPO-7 EQUALITY: a restored lease can be controllable yet
     *     sit on a STALE URL (e.g. a dead localhost from the morning
     *     tests) — every selector then fails not-found while the user
     *     watches a perfectly good page. The SAME invisible workspace tab
     *     is navigated to the user's current URL (the user's own tab is
     *     never touched) and the load is awaited BEFORE the first tool
     *     call. Granularity: exact URL minus hash — SPA-safe: the hash
     *     carries client-side route state on the same document, so a
     *     hash-only difference must NOT reload the page (reloading would
     *     lose SPA state). When the source tab is not controllable
     *     (chrome://), resolveSourceUrl returns null and the current
     *     behavior is kept (no navigation).
     *
     * Re-navigation happens ONLY here, at turn start — mid-turn
     * navigation by the model (tabs/navigate) is never re-validated.
     * Bounded: the validation runs once (a second blank lease is
     * accepted), no loops.
     *
     * @param {{ sourceTabId?: number, resume?: boolean, isControllableUrl: (url: string | undefined) => boolean }} opts
     */
    async acquireControllable({ sourceTabId, resume = false, isControllableUrl } = {}) {
      const sourceUrl = await resolveSourceUrl(chromeApi, sourceTabId)
      const lease = await this.acquire({ sourceTabId, resume })
      try {
        const tab = await chromeApi.tabs.get(lease.snapshot().tabId)
        const sourceNorm = stripUrlHash(sourceUrl)
        const leaseNorm = stripUrlHash(tab?.url)
        if (sourceUrl && leaseNorm && sourceNorm && leaseNorm !== sourceNorm) {
          // PÓS-CAMPO-7: stale-but-controllable lease → same invisible tab,
          // navigated to the user's current page, load awaited.
          const { tabId } = lease.snapshot()
          await chromeApi.tabs.update(tabId, { url: sourceUrl })
          await waitForTabComplete(chromeApi, tabId)
          const refreshed = await chromeApi.tabs.get(tabId)
          if (isControllableUrl && !isControllableUrl(refreshed?.url)) {
            await this.reset()
            return this.acquire({ sourceTabId, resume: false })
          }
          // INSTRUMENTAÇÃO: log the re-navigated target (final decision).
          await logLease(lease)
          return lease
        }
        if (isControllableUrl && !isControllableUrl(tab?.url)) {
          await this.reset()
          return this.acquire({ sourceTabId, resume: false })
        }
      } catch {
        /* revalidation is best-effort — a dead tab fails loudly on use */
      }
      return lease
    },

    async reset() {
      currentLease = null
      await Promise.all([
        chromeApi.storage.local.remove(BACKGROUND_WORKSPACE_KEY),
        chromeApi.storage.session.remove(BACKGROUND_WORKSPACE_KEY),
      ])
    },

    /**
     * DECISÃO DO DONO (workspace, 2026-08-15): the tab where the panel
     * was when the prompt was sent IS the working tab. Lease the user's
     * OWN tab directly — NO invisible mirror window, NO tab/window
     * creation. Background work happens without focus (executeScript
     * does not require focus); the user may switch tabs/windows freely
     * mid-turn. If the tab is closed mid-turn, tools fail honestly via
     * resolveTargetTab (target_tab_unavailable) — no silent migration
     * to another tab. The MCP/CLI path still uses acquire() below for
     * its invisible workspace; this method is the PANEL path only.
     *
     * @param {number} sourceTabId — the tab where the side panel lived
     * @returns {Promise<{ snapshot(): { tabId: number, windowId: number }, selectTab(id: number, wid: number): Promise<void> }>}
     */
    /**
     * REGRESSÃO c358abf (2026-08-16): quando a origem é o side panel (sem
     * sender.tab), o sourceTabId é a aba ativa capturada no INÍCIO do turno.
     * Se essa aba for uma página interna (chrome://, edge://…), o lease nem
     * nasce — o usuário recebe um erro honesto e claro ('abra uma página
     * web para o Verboo controlar') em vez de o 1º tool falhar com
     * target_tab_unavailable.
     *
     * @param {number} sourceTabId
     * @param {{ isControllableUrl?: (url: string | undefined) => boolean }} [opts]
     */
    async leaseSourceTab(sourceTabId, { isControllableUrl } = {}) {
      if (!Number.isInteger(sourceTabId)) throw new Error('target_tab_unavailable')
      const tab = await chromeApi.tabs.get(sourceTabId)
      if (!tab?.id || !Number.isInteger(tab.windowId)) throw new Error('target_tab_unavailable')
      if (isControllableUrl && !isControllableUrl(tab.url)) {
        throw new Error('target_not_controllable')
      }
      currentLease = createLease(tab.id, tab.windowId)
      await persist(currentLease.snapshot())
      // OBSERVABILIDADE (b6b96d7): o caminho do painel (leaseSourceTab) não
      // tinha log [verboo-workspace] — um throw silencioso aqui deixava o
      // console do SW vazio durante a falha. Loga a decisão final (tabId,
      // windowId, URL) para que a próxima regressão tenha um rastro.
      console.log(
        '[verboo-workspace] leaseSourceTab tab', tab.id, 'window', tab.windowId,
        'url', tab.url,
      )
      return currentLease
    },
  }
}

/**
 * PÓS-CAMPO-7: URL equality granularity — exact URL minus the hash. The
 * hash carries client-side SPA route state on the SAME document; a
 * hash-only difference must not trigger a reload (which would lose SPA
 * state). Anything else (origin, path, query) is a real page change.
 *
 * @param {string | null | undefined} url
 * @returns {string | null}
 */
function stripUrlHash(url) {
  if (typeof url !== 'string' || url.length === 0) return null
  const hashIndex = url.indexOf('#')
  return hashIndex === -1 ? url : url.slice(0, hashIndex)
}

/**
 * PÓS-CAMPO-6 (B): wait for a tab's navigation to land (status complete),
 * polling tabs.get. Best-effort — returns the tab or null on timeout.
 *
 * @param {typeof chrome} chromeApi
 * @param {number} tabId
 * @param {number} [timeoutMs]
 * @returns {Promise<{ url?: string } | null>}
 */
async function waitForTabComplete(chromeApi, tabId, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const tab = await chromeApi.tabs.get(tabId)
      if (tab?.status === 'complete') return tab
    } catch {
      return null
    }
    if (Date.now() >= deadline) return null
    await new Promise((resolve) => setTimeout(resolve, 250))
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

/**
 * tabs.js — tab management: list, switch, close, new.
 *
 * Uses chrome.tabs only (no debugger). All actions operate on the
 * leased Verboo workspace when one is supplied, or the current window for
 * legacy callers.
 *
 * Presence: new tabs opened during a turn are grouped under "Verboo".
 *
 * @param {{ name: 'tabs'; action: 'list' | 'switch' | 'close' | 'new'; tabId?: number; url?: string; risk?: string; input?: string }} tool
 * @param {{ activeTabId?: number; workspaceWindowId?: number; setActiveTabId?: (tabId: number, windowId: number) => void | Promise<void> }} [ctx]
 * @returns {Promise<unknown>}
 */

import { ensureVerbooTabGroup } from '../../presence/inject.js'

export async function tabs(tool, ctx = {}) {
  const action = tool?.action
  switch (action) {
    case 'list':
      return listTabs(ctx)
    case 'switch':
      if (typeof tool.tabId !== 'number') throw new Error('tabs.switch: missing tabId')
      await assertWorkspaceTab(tool.tabId, ctx.workspaceWindowId)
      // DECISÃO DO DONO (workspace, 2026-08-16): foco automático NUNCA —
      // só o gesto no chip foca. tabs.switch muda o lease (setActiveTabId)
      // sem roubar a tela do usuário; o trabalho continua em background.
      await ctx.setActiveTabId?.(tool.tabId, ctx.workspaceWindowId)
      return { tabId: tool.tabId, switched: true }
    case 'close':
      if (typeof tool.tabId !== 'number') throw new Error('tabs.close: missing tabId')
      await assertWorkspaceTab(tool.tabId, ctx.workspaceWindowId)
      // CICLO DEPURAÇÃO SISTEMÁTICA (close, decisão do Maestro — opção 1):
      // em skip mode, close de aba NÃO-criada pelo agente neste turno é
      // BLOQUEADO com erro honesto (a aba pode ser do usuário). Modos reais:
      // manual (pede aprovação via gate de política) e skip (auto é alias de
      // skip — aprovação automática). Abas criadas pelo agente (tabs.new)
      // fecham normalmente.
      if (ctx.mode === 'skip' && !(ctx.agentCreatedTabIds?.has(tool.tabId) === true)) {
        throw new Error(
          'close_non_agent_tab: abas abertas em turnos anteriores não são fechadas automaticamente — troque para o modo manual para aprovar, ou feche você mesmo',
        )
      }
      await chrome.tabs.remove(tool.tabId)
      if (tool.tabId === ctx.activeTabId && Number.isInteger(ctx.workspaceWindowId)) {
        const remaining = await chrome.tabs.query({ windowId: ctx.workspaceWindowId })
        let next = remaining.find((tab) => tab.active) ?? remaining[0]
        if (!next?.id) {
          next = await chrome.tabs.create({
            windowId: ctx.workspaceWindowId,
            url: 'about:newtab',
            active: false,
          })
          // CLOSE-1: a aba de reposição é criada pelo agente — entra no Set
          // para poder ser fechada em skip (e para o ungroup do fim do turno).
          ctx.agentCreatedTabIds?.add(next.id)
        }
        if (next?.id != null) {
          await ctx.setActiveTabId?.(next.id, ctx.workspaceWindowId)
        }
      }
      return { tabId: tool.tabId, closed: true }
    case 'new':
      return newTab(tool.url, ctx)
    default:
      throw new Error(`tabs: unknown action: ${action}`)
  }
}

async function listTabs(ctx) {
  const query = Number.isInteger(ctx.workspaceWindowId)
    ? { windowId: ctx.workspaceWindowId }
    : { currentWindow: true }
  const all = await chrome.tabs.query(query)
  return {
    tabs: all.map((t) => ({
      id: t.id,
      url: t.url,
      title: t.title,
      active: t.active,
      windowId: t.windowId,
    })),
    count: all.length,
  }
}

async function newTab(url, ctx) {
  const safeUrl = url && typeof url === 'string' ? url : 'about:newtab'
  // Defense-in-depth: only allow http(s) and about:newtab.
  if (!/^https?:\/\//i.test(safeUrl) && safeUrl !== 'about:newtab') {
    throw new Error(`tabs.new: unsupported scheme: ${safeUrl.split(':')[0]}`)
  }
  const createProperties = Number.isInteger(ctx.workspaceWindowId)
    ? { url: safeUrl, windowId: ctx.workspaceWindowId, active: false }
    : { url: safeUrl, active: false }
  const tab = await chrome.tabs.create(createProperties)
  if (tab?.id != null && Number.isInteger(tab.windowId)) {
    // CICLO DEPURAÇÃO SISTEMÁTICA (close): a aba criada pelo agente é
    // rastreada no turno (agentCreatedTabIds) — close dela é permitido
    // em skip; close de aba do usuário é bloqueado.
    ctx.agentCreatedTabIds?.add(tab.id)
    await ctx.setActiveTabId?.(tab.id, tab.windowId)
  }
  // Group tabs created during an agent turn under the purple Verboo group.
  if (tab?.id != null) {
    try {
      await ensureVerbooTabGroup(tab.id)
    } catch {
      // Grouping is best-effort; never fail tabs.new on presence errors.
    }
  }
  return { tabId: tab.id, url: safeUrl }
}

async function assertWorkspaceTab(tabId, workspaceWindowId) {
  if (!Number.isInteger(workspaceWindowId)) return
  const tab = await chrome.tabs.get(tabId)
  if (tab?.windowId !== workspaceWindowId) throw new Error('outside_workspace')
}

/**
 * tabGroup.js — tab group management: create, remove, assign, unassign.
 *
 * Uses chrome.tabGroups + chrome.tabs.group (no debugger). Tab groups
 * are per-window; we operate on the current window.
 *
 * @param {{ name: 'tab_group'; action: 'create' | 'remove' | 'assign' | 'unassign'; groupId?: number; tabIds?: number[]; title?: string; color?: string; risk?: string; input?: string }} tool
 * @param {{ workspaceWindowId?: number }} [ctx]
 * @returns {Promise<unknown>}
 */
export async function tabGroup(tool, ctx = {}) {
  const action = tool?.action
  switch (action) {
    case 'create': {
      const tabIds = Array.isArray(tool.tabIds) ? tool.tabIds : []
      if (tabIds.length === 0) throw new Error('tab_group.create: missing tabIds')
      await assertWorkspaceTabs(tabIds, ctx.workspaceWindowId)
      const groupId = await chrome.tabs.group({
        tabIds,
        ...(Number.isInteger(ctx.workspaceWindowId)
          ? { createProperties: { windowId: ctx.workspaceWindowId } }
          : {}),
      })
      if (tool.title || tool.color) {
        const update = {}
        if (tool.title) update.title = tool.title
        if (tool.color) update.color = tool.color
        await chrome.tabGroups.update(groupId, update)
      }
      return { groupId, tabIds }
    }
    case 'remove': {
      if (typeof tool.groupId !== 'number') throw new Error('tab_group.remove: missing groupId')
      await assertWorkspaceGroup(tool.groupId, ctx.workspaceWindowId)
      await chrome.tabGroups.ungroup(tool.groupId)
      return { groupId: tool.groupId, removed: true }
    }
    case 'assign': {
      const tabIds = Array.isArray(tool.tabIds) ? tool.tabIds : []
      if (tabIds.length === 0) throw new Error('tab_group.assign: missing tabIds')
      if (typeof tool.groupId !== 'number') throw new Error('tab_group.assign: missing groupId')
      await assertWorkspaceTabs(tabIds, ctx.workspaceWindowId)
      await assertWorkspaceGroup(tool.groupId, ctx.workspaceWindowId)
      const groupId = await chrome.tabs.group({ groupId: tool.groupId, tabIds })
      return { groupId, tabIds }
    }
    case 'unassign': {
      const tabIds = Array.isArray(tool.tabIds) ? tool.tabIds : []
      if (tabIds.length === 0) throw new Error('tab_group.unassign: missing tabIds')
      await assertWorkspaceTabs(tabIds, ctx.workspaceWindowId)
      // chrome.tabs.ungroup exists since Chrome 116; older builds fall back
      // to a temp group that is immediately ungrouped.
      if (chrome.tabs.ungroup) {
        await chrome.tabs.ungroup(tabIds)
      } else {
        // Fallback: create a temp group and ungroup it.
        const tmp = await chrome.tabs.group({
          tabIds,
          ...(Number.isInteger(ctx.workspaceWindowId)
            ? { createProperties: { windowId: ctx.workspaceWindowId } }
            : {}),
        })
        await chrome.tabGroups.ungroup(tmp)
      }
      return { tabIds, unassigned: true }
    }
    default:
      throw new Error(`tab_group: unknown action: ${action}`)
  }
}

async function assertWorkspaceTabs(tabIds, workspaceWindowId) {
  if (!Number.isInteger(workspaceWindowId)) return
  const tabs = await Promise.all(tabIds.map((tabId) => chrome.tabs.get(tabId)))
  if (tabs.some((tab) => tab?.windowId !== workspaceWindowId)) {
    throw new Error('outside_workspace')
  }
}

async function assertWorkspaceGroup(groupId, workspaceWindowId) {
  if (!Number.isInteger(workspaceWindowId)) return
  const group = await chrome.tabGroups.get(groupId)
  if (group?.windowId !== workspaceWindowId) throw new Error('outside_workspace')
}

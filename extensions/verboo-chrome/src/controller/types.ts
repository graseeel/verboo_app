/**
 * Extension TypeScript contracts — BrowserTool discriminated union (P1).
 *
 * MVP tool catalog per design spec. Extra tool kinds marked // future —
 * implement only when P2+ requires them.
 *
 * Multi-user: no hardcoded paths, users, or tokens.
 */

// ── Discriminated Union ────────────────────────────────────

export type ToolKind =
  | 'navigate'
  | 'read_page'
  | 'click'
  | 'type'
  | 'screenshot'
  | 'tabs'
  | 'tab_group'   // future

export type BrowserTool =
  | NavigateTool
  | ReadPageTool
  | ClickTool
  | TypeTool
  | ScreenshotTool
  | TabsTool
  | TabGroupTool   // future

// ── Tool Shapes ────────────────────────────────────────────

export interface NavigateTool {
  kind: 'navigate'
  url: string
}

export interface ReadPageTool {
  kind: 'read_page'
  /** Optional CSS selector; omit for full page. */
  selector?: string
  /** Attribute to extract; omit for textContent. */
  attribute?: string
}

export interface ClickTool {
  kind: 'click'
  selector: string
  /** Button index: 0 = primary, 1 = middle, 2 = secondary. */
  button?: number
}

export interface TypeTool {
  kind: 'type'
  selector: string
  text: string
  /** Clear field before typing. */
  clear?: boolean
}

export interface ScreenshotTool {
  kind: 'screenshot'
  /** 'viewport' (default) or 'fullPage'. */
  format?: 'viewport' | 'fullPage'
}

export interface TabsTool {
  kind: 'tabs'
  action: 'list' | 'switch' | 'close' | 'new'
  /** Tab ID for switch/close. */
  tabId?: number
  /** URL for new tab. */
  url?: string
}

// future — tab group management (P5)
export interface TabGroupTool {
  kind: 'tab_group'
  action: 'create' | 'remove' | 'assign' | 'unassign'
  groupId?: number
  tabIds?: number[]
  title?: string
  color?: 'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan'
}

// ── Results ───────────────────────────────────────────────

export interface ToolResult {
  success: boolean
  data?: unknown
  error?: string
  durationMs: number
}

export interface TabInfo {
  tabId: number
  url: string
  title: string
  active: boolean
  groupId?: number
  windowId: number
}

export interface BrowserState {
  activeTabId: number
  tabs: TabInfo[]
  url: string
  title: string
}

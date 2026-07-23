import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/App.tsx'), 'utf8')

describe('panel exclusivity (source analysis)', () => {
  it('handleToggleTerminal closes browser', () => {
    // The toggle terminal handler should close review AND browser
    expect(appSource).toMatch(
      /handleToggleTerminal[\s\S]*browser\.close\(\)/
    )
  })

  it('handleToggleReview closes browser', () => {
    expect(appSource).toMatch(
      /handleToggleReview[\s\S]*browser\.close\(\)/
    )
  })

  it('handleToggleSubagents closes browser', () => {
    expect(appSource).toMatch(
      /handleToggleSubagents[\s\S]*browser\.close\(\)/
    )
  })

  it('handleToggleBrowser closes terminal and review', () => {
    expect(appSource).toMatch(
      /handleToggleBrowser[\s\S]*terminal\.close\(\)/
    )
    expect(appSource).toMatch(
      /handleToggleBrowser[\s\S]*review\.close\(\)/
    )
  })

  it('handleToggleReview closes terminal', () => {
    expect(appSource).toMatch(
      /handleToggleReview[\s\S]*terminal\.close\(\)/
    )
  })

  it('handleToggleTerminal closes review', () => {
    expect(appSource).toMatch(
      /handleToggleTerminal[\s\S]*review\.close\(\)/
    )
  })

  it('browser-open class is applied when browserOpen is true', () => {
    expect(appSource).toMatch(/visibleBrowserOpen \? 'browser-open' : ''/)
  })

  it('BrowserPanel is rendered instead of BrowserSpikePanel', () => {
    expect(appSource).not.toMatch(/BrowserSpikePanel/)
    expect(appSource).toMatch(/browserAvailable && \(\s*<BrowserPanel/)
  })

  it('TopBar receives browser availability, open state, and toggle props', () => {
    expect(appSource).toMatch(/browserAvailable=\{browserAvailable\}/)
    expect(appSource).toMatch(/browserOpen=\{visibleBrowserOpen\}/)
    expect(appSource).toMatch(/onToggleBrowser=\{handleToggleBrowser\}/)
  })

  it('CommandPalette includes browser entry', () => {
    expect(appSource).toMatch(/key: 'browser'/)
  })

  it('uses the synchronously clamped browser width in layout and panel bounds', () => {
    expect(appSource).toMatch(/const effectiveBrowserWidth = browserLayoutWidth\(browser\.browserWidth, effectiveSidebarWidth\)/)
    expect(appSource).toMatch(/'--browser-width': visibleBrowserOpen \? `\$\{effectiveBrowserWidth\}px` : '0px'/)
    expect(appSource).toMatch(/browserWidth=\{effectiveBrowserWidth\}/)
  })

  it('guards all rendered workspace panels while fullscreen', () => {
    expect(appSource).toMatch(/const visibleTerminalOpen = workspacePanelsEnabled && terminal\.terminalOpen/)
    expect(appSource).toMatch(/const visibleReviewOpen = workspacePanelsEnabled && review\.reviewOpen/)
    expect(appSource).toMatch(/const visibleBrowserOpen = browserAvailable && workspacePanelsEnabled && browser\.browserOpen/)
    expect(appSource).toMatch(/terminalOpen=\{visibleTerminalOpen\}/)
    expect(appSource).toMatch(/open=\{visibleReviewOpen\}/)
    expect(appSource).toMatch(/browserOpen=\{visibleBrowserOpen\}/)
  })

  it('disables TopBar controls and guards the three toggle handlers', () => {
    expect(appSource).toMatch(/workspacePanelsEnabled=\{workspacePanelsEnabled\}/)
    const guards = appSource.match(/if \(!workspacePanelsEnabled\) return/g) ?? []
    expect(guards.length).toBeGreaterThanOrEqual(3)
  })

  it('derives embedded browser availability from the runtime platform', () => {
    expect(appSource).toMatch(/supportsEmbeddedBrowser\(config\.platform\)/)
  })
})

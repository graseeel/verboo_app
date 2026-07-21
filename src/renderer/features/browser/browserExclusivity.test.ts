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
    expect(appSource).toMatch(/browser\.browserOpen \? 'browser-open' : ''/)
  })

  it('BrowserPanel is rendered instead of BrowserSpikePanel', () => {
    expect(appSource).not.toMatch(/BrowserSpikePanel/)
    expect(appSource).toMatch(/<BrowserPanel/)
  })

  it('TopBar receives browserOpen and onToggleBrowser props', () => {
    expect(appSource).toMatch(/browserOpen=\{browser\.browserOpen\}/)
    expect(appSource).toMatch(/onToggleBrowser=\{handleToggleBrowser\}/)
  })

  it('CommandPalette includes browser entry', () => {
    expect(appSource).toMatch(/key: 'browser'/)
  })
})

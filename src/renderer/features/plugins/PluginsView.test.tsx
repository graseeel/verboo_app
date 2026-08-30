import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AvailablePlugin } from '../../../shared/plugins'
import { PluginsView } from './PluginsView'

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}))

vi.mock('./OfficialChromeIntegrationCard', () => ({
  OfficialChromeIntegrationCard: () => <div>Official integration</div>,
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

interface CssDeclaration {
  property: string
  value: string
}

interface CssRule {
  selector: string
  declarations: CssDeclaration[]
}

function withoutCssComments(css: string) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

function parseDeclarations(block: string): CssDeclaration[] {
  return block.split(';').flatMap(rawDeclaration => {
    const colon = rawDeclaration.indexOf(':')
    if (colon === -1) return []
    return [{
      property: rawDeclaration.slice(0, colon).trim().toLowerCase(),
      value: rawDeclaration.slice(colon + 1).trim().toLowerCase(),
    }]
  })
}

function rulesForExactClass(css: string, className: string): CssRule[] {
  const source = withoutCssComments(css)
  const exactClass = new RegExp(`\\.${className}(?![\\w-])`)
  const simpleRule = /([^{}]+)\{([^{}]*)\}/g

  return Array.from(source.matchAll(simpleRule)).flatMap(match => {
    const selector = match[1].trim()
    if (selector.startsWith('@') || !exactClass.test(selector)) return []
    return [{ selector, declarations: parseDeclarations(match[2]) }]
  })
}

function keyframeBodies(css: string): Map<string, string> {
  const source = withoutCssComments(css)
  const header = /@(?:-[a-z]+-)?keyframes\s+([\w-]+)\s*\{/gi
  const keyframes = new Map<string, string>()
  let match: RegExpExecArray | null

  while ((match = header.exec(source)) !== null) {
    let depth = 1
    let cursor = header.lastIndex
    while (cursor < source.length && depth > 0) {
      if (source[cursor] === '{') depth += 1
      if (source[cursor] === '}') depth -= 1
      cursor += 1
    }
    keyframes.set(match[1].toLowerCase(), source.slice(header.lastIndex, cursor - 1))
    header.lastIndex = cursor
  }

  return keyframes
}

const entryProperty = /(?:^|[\s,;{])(?:all|opacity|transform|translate|scale|filter|clip-path|visibility)(?=$|[\s,;}:])/i

function entryMotionViolations(css: string) {
  const targetRules = [
    ...rulesForExactClass(css, 'plugin-line'),
    ...rulesForExactClass(css, 'plugins-tab-content'),
  ]
  const keyframes = keyframeBodies(css)
  const violations = new Set<string>()

  for (const rule of targetRules) {
    for (const declaration of rule.declarations) {
      const property = declaration.property.replace(/^-(?:webkit|moz|ms|o)-/, '')
      if (property === 'animation' || property.startsWith('animation-')) {
        violations.add(`${rule.selector} defines ${declaration.property}: ${declaration.value}`)
        const identifiers = new Set(declaration.value.match(/-?[_a-z][\w-]*/gi)?.map(value => value.toLowerCase()))
        for (const [name, body] of keyframes) {
          if (identifiers.has(name) && entryProperty.test(body)) {
            violations.add(`@keyframes ${name} defines entry motion for ${rule.selector}`)
          }
        }
      }
      if ((property === 'transition' || property === 'transition-property') && entryProperty.test(declaration.value)) {
        violations.add(`${rule.selector} defines entry ${declaration.property}: ${declaration.value}`)
      }
    }
  }

  return [...violations]
}

function createBridge() {
  return {
    pluginList: vi.fn(async () => []),
    pluginAvailable: vi.fn(async (): Promise<{ available: AvailablePlugin[]; installed: string[] }> => ({
      available: [],
      installed: [],
    })),
    marketplaceList: vi.fn(async () => []),
    marketplaceManifests: vi.fn(async () => ({})),
    pluginInstall: vi.fn(async () => ({ success: true })),
    pluginUninstall: vi.fn(async () => ({ success: true })),
    pluginEnable: vi.fn(async () => ({ success: true })),
    pluginDisable: vi.fn(async () => ({ success: true })),
    pluginUpdate: vi.fn(async () => ({ success: true })),
    pluginValidate: vi.fn(async () => ({ valid: true })),
    pluginSkills: vi.fn(async () => []),
    marketplaceAdd: vi.fn(async () => undefined),
    marketplaceRemove: vi.fn(async () => undefined),
  }
}

const catalogPlugin: AvailablePlugin = {
  pluginId: 'catalog-plugin@verboo-plugins',
  name: 'Catalog Plugin',
  description: 'Loaded from the marketplace on view open.',
  marketplaceName: 'verboo-plugins',
  source: 'marketplace',
  installCount: 42,
}

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
})

describe('PluginsView catalog hydration', () => {
  it('shows loading and renders the available catalog on open without focusing search', async () => {
    const catalog = deferred<{ available: AvailablePlugin[]; installed: string[] }>()
    const bridge = createBridge()
    bridge.pluginAvailable.mockReturnValue(catalog.promise)
    ;(window as unknown as { verboo: unknown }).verboo = bridge

    render(
      <PluginsView
        onClose={vi.fn()}
        onManageChromeIntegration={vi.fn()}
        loadIcons={false}
      />,
    )

    await waitFor(() => expect(bridge.pluginAvailable).toHaveBeenCalledTimes(1))
    const search = screen.getByRole('textbox', { name: 'Search plugins' })
    expect(search).not.toHaveFocus()
    expect(screen.getByRole('status', { name: 'Loading catalog' })).toBeVisible()

    await act(async () => {
      catalog.resolve({ available: [catalogPlugin], installed: [] })
    })

    expect(await screen.findByText('Catalog Plugin')).toBeVisible()
    expect(search).not.toHaveFocus()
  })

  it('keeps asynchronous plugin surfaces free of entry motion', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/renderer/styles/plugins.css'), 'utf8')

    expect(entryMotionViolations(css)).toEqual([])
  })

  it('shows an honest empty state after an empty catalog finishes loading', async () => {
    const bridge = createBridge()
    ;(window as unknown as { verboo: unknown }).verboo = bridge

    render(
      <PluginsView
        onClose={vi.fn()}
        onManageChromeIntegration={vi.fn()}
        loadIcons={false}
      />,
    )

    expect(await screen.findByText('No plugins available')).toBeVisible()
    expect(screen.queryByRole('status', { name: 'Loading catalog' })).not.toBeInTheDocument()
  })

  it('clears the search query whenever the user switches tabs', async () => {
    const bridge = createBridge()
    ;(window as unknown as { verboo: unknown }).verboo = bridge

    render(
      <PluginsView
        onClose={vi.fn()}
        onManageChromeIntegration={vi.fn()}
        loadIcons={false}
      />,
    )

    await screen.findByText('No plugins available')
    const pluginSearch = screen.getByRole('textbox', { name: 'Search plugins' })
    fireEvent.change(pluginSearch, { target: { value: 'catalog' } })
    expect(pluginSearch).toHaveValue('catalog')

    fireEvent.click(screen.getByRole('tab', { name: 'Skills' }))
    const skillSearch = screen.getByRole('textbox', { name: 'Search skills' })
    expect(skillSearch).toHaveValue('')

    fireEvent.change(skillSearch, { target: { value: 'review' } })
    expect(skillSearch).toHaveValue('review')
    fireEvent.click(screen.getByRole('tab', { name: 'Plugins' }))
    expect(screen.getByRole('textbox', { name: 'Search plugins' })).toHaveValue('')
  })
})

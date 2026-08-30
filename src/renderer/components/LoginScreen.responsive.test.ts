import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

type RuleSnapshot = {
  selectors: string[]
  declarations: Record<string, string>
}

function loginRules(): RuleSnapshot[] {
  const style = document.createElement('style')
  style.textContent = readFileSync(resolve(process.cwd(), 'src/renderer/styles/login.css'), 'utf8')
  document.head.appendChild(style)

  try {
    return Array.from(style.sheet?.cssRules ?? []).flatMap(rule => {
      if (!('selectorText' in rule) || !('style' in rule)) return []
      const cssRule = rule as CSSStyleRule
      const declarations: Record<string, string> = {}
      for (const property of Array.from(cssRule.style)) {
        declarations[property] = cssRule.style.getPropertyValue(property)
      }
      return [{
        selectors: cssRule.selectorText.split(',').map(selector => selector.trim()),
        declarations,
      }]
    })
  } finally {
    style.remove()
  }
}

function ruleFor(selector: string): RuleSnapshot {
  const rule = loginRules().find(candidate => candidate.selectors.includes(selector))
  expect(rule, `missing CSS rule for ${selector}`).toBeDefined()
  return rule!
}

describe('LoginScreen API-key row responsive contract', () => {
  // jsdom does not calculate element geometry. These tests therefore pin the
  // CSS sizing invariants that keep the input track shrinkable in every webview.
  it('gives the API-key input track an explicit zero minimum', () => {
    const rowRule = ruleFor('.api-login-row')

    expect(rowRule.declarations['grid-template-columns']).toBe('minmax(0, 1fr) auto')
  })

  it('keeps disabled Save sizing independent from the full-width continue link', () => {
    const disabledSaveRule = ruleFor('.api-login-row button:disabled')

    expect(disabledSaveRule.selectors).not.toContain('.continue-link')
    expect(disabledSaveRule.declarations.width).toBeUndefined()
    expect(disabledSaveRule.declarations['margin-top']).toBeUndefined()
    expect(disabledSaveRule.declarations.cursor).toBe('default')
    expect(disabledSaveRule.declarations.opacity).toBe('0.45')
  })
})

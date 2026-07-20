import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/App.tsx'), 'utf8')

describe('agent event subscription', () => {
  it('forwards events to the current render handler instead of the mount-time closure', () => {
    expect(appSource).toMatch(/const agentEventHandlerRef = useRef\(handleAgentEvent\)/)
    expect(appSource).toMatch(/agentEventHandlerRef\.current = handleAgentEvent/)
    expect(appSource).toMatch(/onAgentEvent\(event => \{\s*void agentEventHandlerRef\.current\(event\)\s*\}\)/s)
  })
})

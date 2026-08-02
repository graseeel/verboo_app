import { readFileSync } from 'node:fs'

function snakeToCamel(name: string): string {
  return name.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
}

function rustStructFields(rustPath: string, structName: string): Set<string> {
  const source = readFileSync(rustPath, 'utf8')
  const structStart = source.indexOf(`pub struct ${structName}`)
  if (structStart === -1) {
    throw new Error(`Rust struct ${structName} not found in ${rustPath}`)
  }
  const bodyStart = source.indexOf('{', structStart)
  const bodyEnd = source.indexOf('}', bodyStart)
  if (bodyStart === -1 || bodyEnd === -1) {
    throw new Error(`Rust struct ${structName} body not found in ${rustPath}`)
  }
  const body = source.slice(bodyStart + 1, bodyEnd)
  const fields = new Set<string>()
  for (const line of body.split('\n')) {
    const match = line.match(/^\s*pub\s+([a-z_][a-z0-9_]*)\s*:/)
    if (match) {
      fields.add(snakeToCamel(match[1]))
    }
  }
  return fields
}

export function rustTabFields(rustPath: string): Set<string> {
  return rustStructFields(rustPath, 'BrowserTabSnapshot')
}

export function rustSessionFields(rustPath: string): Set<string> {
  return rustStructFields(rustPath, 'BrowserSessionSnapshot')
}

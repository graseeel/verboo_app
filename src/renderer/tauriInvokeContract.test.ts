/**
 * Cross-fence vocabulary pin: every static Tauri invoke in production
 * renderer source must name a real `#[tauri::command]` function in Rust.
 *
 * This deliberately derives both sets from their source artifacts. A copied
 * allow-list would stay green when either side changed, recreating the class
 * of runtime-only contract failures this test exists to prevent.
 *
 * LIMIT: this pins command names, not payload fields. Field comparison needs
 * to resolve variable payloads, Tauri-injected Rust parameters, and camelCase
 * serialization without turning partial coverage into a false guarantee.
 */

import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as ts from 'typescript'

type InvokeSite = {
  command?: string
  file: string
  line: number
}

const REPO_ROOT = process.cwd()
const RENDERER_ROOT = path.resolve(REPO_ROOT, 'src/renderer')
const RUST_ROOT = path.resolve(REPO_ROOT, 'src-tauri/src')

function walkFiles(root: string, accepts: (file: string) => boolean): string[] {
  const files: string[] = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name)
    if (entry.isDirectory()) files.push(...walkFiles(absolute, accepts))
    else if (entry.isFile() && accepts(absolute)) files.push(absolute)
  }
  return files
}

function rendererSourceFiles(): string[] {
  return walkFiles(RENDERER_ROOT, file => {
    if (!/\.tsx?$/.test(file) || file.endsWith('.d.ts')) return false
    return !/\.(?:test|spec)\.tsx?$/.test(file)
  })
}

function relativePath(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join('/')
}

function extractRendererInvokes(): { staticSites: InvokeSite[]; dynamicSites: InvokeSite[] } {
  const staticSites: InvokeSite[] = []
  const dynamicSites: InvokeSite[] = []

  for (const file of rendererSourceFiles()) {
    const source = fs.readFileSync(file, 'utf8')
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )
    const invokeNames = new Set<string>()

    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
      if (statement.moduleSpecifier.text !== '@tauri-apps/api/core') continue
      const bindings = statement.importClause?.namedBindings
      if (!bindings || !ts.isNamedImports(bindings)) continue
      for (const binding of bindings.elements) {
        if ((binding.propertyName?.text ?? binding.name.text) === 'invoke') {
          invokeNames.add(binding.name.text)
        }
      }
    }

    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && invokeNames.has(node.expression.text)
      ) {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
        const site = { file: relativePath(file), line: position.line + 1 }
        const command = node.arguments[0]
        if (command && ts.isStringLiteralLike(command)) staticSites.push({ ...site, command: command.text })
        else dynamicSites.push(site)
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }

  return { staticSites, dynamicSites }
}

function extractRustCommands(): Set<string> {
  const commands = new Set<string>()
  const declaration = /#\[tauri::command(?:\([^\]]*\))?\]\s*(?:#\[[^\]]+\]\s*)*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/g

  for (const file of walkFiles(RUST_ROOT, candidate => candidate.endsWith('.rs'))) {
    const source = fs.readFileSync(file, 'utf8')
    for (const match of source.matchAll(declaration)) commands.add(match[1])
  }
  return commands
}

describe('renderer invoke vocabulary matches Rust Tauri commands', () => {
  it('every production invoke names a statically verifiable #[tauri::command]', () => {
    const { staticSites, dynamicSites } = extractRendererInvokes()
    const rustCommands = extractRustCommands()

    expect(staticSites.length, 'the scanner found no renderer invokes; its coverage is broken').toBeGreaterThan(0)
    expect(rustCommands.size, 'the scanner found no #[tauri::command] functions; its coverage is broken').toBeGreaterThan(0)
    expect(
      dynamicSites,
      `Dynamic invoke names cannot be checked against Rust. Replace them with literals or extend the scanner.\n${formatSites(dynamicSites)}`,
    ).toEqual([])

    const missing = staticSites.filter(site => !rustCommands.has(site.command!))
    expect(
      missing,
      `Renderer invokes commands that do not exist as #[tauri::command] functions in Rust:\n${formatSites(missing)}`,
    ).toEqual([])
  })
})

function formatSites(sites: InvokeSite[]): string {
  return sites.map(site => `- ${site.command ?? '<dynamic>'} at ${site.file}:${site.line}`).join('\n')
}

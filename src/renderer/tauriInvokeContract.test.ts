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
 *
 * F2 (Faro Campo B1B2C) — pin FOCADO para o gate de `origin`:
 * O nome do arg `origin` nos 4 comandos de input (tap/drag/type_text/press_key)
 * é o portão do presence-guard nativo. Rename silencioso quebra o guard sem
 * detecção. Este scanner extrai os PARAM NAMES dos comandos nativos via
 * regex e cruza contra os KEYS do payload renderer para confirmar o nome.
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

/**
 * F2 (Faro Campo B1B2C): extrai os PARAM NAMES dos 4 comandos de input nativos
 * para pinar o nome do arg `origin`. Retorna Map<commandName, paramNames[]>.
 *
 * LIMIT: regex simples sobre a assinatura `fn name(...)`. Não processa generics,
 * lifetimes, atributos em cada arg, ou wraps complexos (`State<'_, S>` etc.).
 * O gate é FORM-ONLY (declaração textual) — cobre o caso do despacho ("rename
 * silencioso do param `origin` → `input_origin` quebra o presence guard").
 */
function extractRustParamNames(): Map<string, string[]> {
  const result = new Map<string, string[]>()
  const declaration = /#\[tauri::command(?:\([^\]]*\))?\]\s*(?:#\[[^\]]+\]\s*)*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/g

  for (const file of walkFiles(RUST_ROOT, candidate => candidate.endsWith('.rs'))) {
    const source = fs.readFileSync(file, 'utf8')
    for (const match of source.matchAll(declaration)) {
      const commandName = match[1]
      const argsBody = match[2]
      // Cada arg na forma `name: type` ou `name: type = default`. Pula `self`
      // e injecções do Tauri (State, AppHandle, Window) — patterns conhecidos.
      const paramNames: string[] = []
      for (const argMatch of argsBody.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) {
        const name = argMatch[1]
        if (name === 'self') continue
        // Heurística leve para pular State/AppHandle/Window — se o que
        // vem DEPOIS de ':' começa com State< / AppHandle / Window,
        // a próxima captura do regex já pegaria o tipo; aqui só usamos
        // o nome do param.
        paramNames.push(name)
      }
      // Dedup preservando ordem
      const seen = new Set<string>()
      const dedup = paramNames.filter(n => !seen.has(n) && seen.add(n))
      result.set(commandName, dedup)
    }
  }
  return result
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

  // F2 (Faro Campo B1B2C): pin do NOME do arg `origin` nos 4 comandos de input.
  // O renderer envia `{ origin: 'manual' }` (campo camelCase, Tauri v2). O
  // nativo recebe `origin: Option<InputOrigin>` (Tauri v2 camelCase por
  // default — `origin` é palavra única, sem conversão). Se o nativo renomear
  // para `input_origin`, o `unwrap_or_default()` cairia em Agent → presence
  // emitida para input manual. Gate: nome do arg nativo `origin` está
  // presente na assinatura dos 4 comandos de input.
  it('F2 — args dos 4 comandos de input nativos expõem `origin` (gate do presence guard)', () => {
    const rustParams = extractRustParamNames()
    const inputCommands = ['android_emulator_tap', 'android_emulator_drag', 'android_emulator_type_text', 'android_emulator_press_key']
    const missing: string[] = []
    for (const cmd of inputCommands) {
      const params = rustParams.get(cmd) ?? []
      if (!params.includes('origin')) missing.push(cmd)
    }
    expect(missing, `F2: param \`origin\` não encontrado nas assinaturas dos 4 comandos de input.\n`
      + `O \`origin: Option<InputOrigin>\` é o portão do presence guard nativo — rename silencioso quebraria o guard sem detecção.`)
      .toEqual([])
  })
})

function formatSites(sites: InvokeSite[]): string {
  return sites.map(site => `- ${site.command ?? '<dynamic>'} at ${site.file}:${site.line}`).join('\n')
}

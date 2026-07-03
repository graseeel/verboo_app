import { execFile } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { FileDiff, FileDiffHunk, FileDiffLine, FileDiffStatus } from '../../shared/types'
import { runGit } from './workspaceChangeService'

const execFileAsync = promisify(execFile)
const MAX_DIFF_BYTES = 1_500_000
const MAX_DIFF_LINES = 5_000

export async function resolveRepoRoot(workingDirectory: string): Promise<string | undefined> {
  const result = await runGit(workingDirectory, ['rev-parse', '--show-toplevel'])
  return result.ok ? result.stdout.trim() : undefined
}

export function resolveSafePath(root: string, filePath: string): string | undefined {
  const target = resolve(root, filePath)
  const rel = relative(root, target)
  if (!rel || rel.startsWith('..') || resolve(rel) === rel) return undefined
  return target
}

export async function readFileDiff(
  workingDirectory: string,
  filePath: string,
  status: FileDiffStatus,
): Promise<FileDiff> {
  const root = await resolveRepoRoot(workingDirectory)
  if (!root) return emptyDiff(filePath, status, 'Diff indisponível fora de um repositório Git.')

  const target = resolveSafePath(root, filePath)
  if (!target) return emptyDiff(filePath, status, 'Caminho fora do repositório.')

  const args = status === 'untracked' || status === 'added'
    ? ['diff', '--no-index', '--', '/dev/null', target]
    : ['diff', 'HEAD', '--', filePath]

  const result = await runDiff(root, args)
  if (!result.ok && !result.stdout) return emptyDiff(filePath, status, 'Não foi possível ler o diff.')

  if (isDiffTooLarge(result.stdout)) {
    return {
      ...emptyDiff(filePath, status),
      truncated: true,
      message: 'Diff muito grande para exibir.',
    }
  }

  return parseUnifiedDiff(filePath, status, result.stdout)
}

export async function revertFile(
  workingDirectory: string,
  filePath: string,
): Promise<{ ok: boolean; message?: string }> {
  const root = await resolveRepoRoot(workingDirectory)
  if (!root) return { ok: false, message: 'Reverter exige um repositório Git.' }

  const target = resolveSafePath(root, filePath)
  if (!target) return { ok: false, message: 'Caminho fora do repositório.' }

  const trackedResult = await runGit(root, ['ls-files', '--error-unmatch', '--', filePath])

  if (trackedResult.ok) {
    const checkout = await runGit(root, ['checkout', 'HEAD', '--', filePath])
    return checkout.ok ? { ok: true } : { ok: false, message: 'Não foi possível restaurar o arquivo.' }
  }

  await rm(target, { force: true, recursive: false })
  return { ok: true }
}

function isDiffTooLarge(raw: string): boolean {
  return Buffer.byteLength(raw, 'utf8') > MAX_DIFF_BYTES || raw.split(/\r?\n/).length > MAX_DIFF_LINES
}

async function runDiff(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { maxBuffer: MAX_DIFF_BYTES + 1024 })
    return { ok: true, stdout }
  } catch (error) {
    const maybeStdout = typeof error === 'object' && error && 'stdout' in error ? String(error.stdout ?? '') : ''
    return { ok: false, stdout: maybeStdout }
  }
}

function parseUnifiedDiff(path: string, status: FileDiffStatus, raw: string): FileDiff {
  const hunks: FileDiffHunk[] = []
  let current: FileDiffHunk | undefined
  let oldLine = 0
  let newLine = 0
  let additions = 0
  let deletions = 0
  let binary = false

  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('Binary files ')) {
      binary = true
      continue
    }

    if (line.startsWith('@@')) {
      const match = /^@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/.exec(line)
      const oldStart = Number(match?.[1] ?? 0)
      const oldLines = Number(match?.[2] || 1)
      const newStart = Number(match?.[3] ?? 0)
      const newLines = Number(match?.[4] || 1)
      current = { header: line, oldStart, oldLines, newStart, newLines, lines: [] }
      oldLine = oldStart
      newLine = newStart
      hunks.push(current)
      continue
    }

    if (!current || line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
      continue
    }

    const parsed = parseDiffLine(line, oldLine, newLine)
    current.lines.push(parsed.line)
    oldLine = parsed.nextOldLine
    newLine = parsed.nextNewLine
    if (parsed.line.kind === 'add') additions += 1
    if (parsed.line.kind === 'del') deletions += 1
  }

  return { path, status, additions, deletions, binary, truncated: false, hunks }
}

function parseDiffLine(raw: string, oldLine: number, newLine: number): {
  line: FileDiffLine
  nextOldLine: number
  nextNewLine: number
} {
  if (raw.startsWith('+')) {
    return {
      line: { kind: 'add', newLine, text: raw.slice(1) },
      nextOldLine: oldLine,
      nextNewLine: newLine + 1,
    }
  }

  if (raw.startsWith('-')) {
    return {
      line: { kind: 'del', oldLine, text: raw.slice(1) },
      nextOldLine: oldLine + 1,
      nextNewLine: newLine,
    }
  }

  return {
    line: { kind: 'context', oldLine, newLine, text: raw.startsWith(' ') ? raw.slice(1) : raw },
    nextOldLine: oldLine + 1,
    nextNewLine: newLine + 1,
  }
}

function emptyDiff(path: string, status: FileDiffStatus, message?: string): FileDiff {
  return { path, status, additions: 0, deletions: 0, binary: false, truncated: false, hunks: [], message }
}

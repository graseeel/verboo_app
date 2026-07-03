import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { WorkspaceChangeEntry, WorkspaceChangeSummary, WorkspaceReviewMetadata } from '../../shared/types'

const execFileAsync = promisify(execFile)
const MAX_UNTRACKED_FILE_BYTES = 1_000_000

export async function readWorkspaceChangeSummary(workingDirectory: string): Promise<WorkspaceChangeSummary> {
  const rootResult = await runGit(workingDirectory, ['rev-parse', '--show-toplevel'])
  if (!rootResult.ok) return emptySummary()

  const root = rootResult.stdout.trim()
  const entries = new Map<string, WorkspaceChangeEntry>()

  await addNumstatEntries(root, ['diff', '--numstat', '--'], entries)
  await addNumstatEntries(root, ['diff', '--cached', '--numstat', '--'], entries)
  await addUntrackedEntries(root, entries)

  return summarizeEntries([...entries.values()].sort((a, b) => a.path.localeCompare(b.path)))
}

async function addNumstatEntries(
  root: string,
  args: string[],
  entries: Map<string, WorkspaceChangeEntry>,
): Promise<void> {
  const result = await runGit(root, args)
  if (!result.ok) return

  for (const rawLine of result.stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    const [rawAdditions, rawDeletions, ...pathParts] = line.split('\t')
    const path = pathParts.join('\t').trim()
    if (!path) continue

    const additions = parseNumstatValue(rawAdditions)
    const deletions = parseNumstatValue(rawDeletions)
    const existing = entries.get(path)
    entries.set(path, {
      path,
      additions: (existing?.additions ?? 0) + additions,
      deletions: (existing?.deletions ?? 0) + deletions,
      status: deletions > 0 && additions === 0 ? 'deleted' : existing?.status ?? 'modified',
    })
  }
}

async function addUntrackedEntries(root: string, entries: Map<string, WorkspaceChangeEntry>): Promise<void> {
  const result = await runGit(root, ['ls-files', '--others', '--exclude-standard'])
  if (!result.ok) return

  const paths = result.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)

  for (const path of paths) {
    if (entries.has(path)) continue
    entries.set(path, {
      path,
      additions: await countReadableLines(join(root, path)),
      deletions: 0,
      status: 'untracked',
    })
  }
}

function summarizeEntries(files: WorkspaceChangeEntry[]): WorkspaceChangeSummary {
  return {
    files,
    totalFiles: files.length,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
  }
}

export async function runGit(cwd: string, args: string[]): Promise<{ ok: true; stdout: string } | { ok: false }> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      maxBuffer: 4 * 1024 * 1024,
    })
    return { ok: true, stdout }
  } catch {
    return { ok: false }
  }
}

function parseNumstatValue(value: string | undefined): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

async function countReadableLines(path: string): Promise<number> {
  try {
    const stats = await stat(path)
    if (!stats.isFile() || stats.size > MAX_UNTRACKED_FILE_BYTES) return 0
    const text = await readFile(path, 'utf8')
    if (!text || text.includes('\0')) return 0
    const normalized = text.endsWith('\n') ? text.slice(0, -1) : text
    return normalized ? normalized.split(/\r\n|\r|\n/).length : 0
  } catch {
    return 0
  }
}

function emptySummary(): WorkspaceChangeSummary {
  return {
    files: [],
    totalFiles: 0,
    additions: 0,
    deletions: 0,
  }
}

export async function readWorkspaceReviewMetadata(workingDirectory: string): Promise<WorkspaceReviewMetadata> {
  const rootResult = await runGit(workingDirectory, ['rev-parse', '--show-toplevel'])

  if (!rootResult.ok) {
    return {
      scope: 'local-folder',
      title: 'Arquivos com mudanças',
      subtitle: 'Sem repositório Git',
      isGitRepository: false,
      isGitHubRepository: false,
      capabilities: {
        canDiff: false,
        canRevert: false,
        canOpenExternal: true,
      },
    }
  }

  const repositoryRoot = rootResult.stdout.trim()
  const remoteResult = await runGit(repositoryRoot, ['remote', '-v'])
  const isGitHubRepository = remoteResult.ok && /\bgithub\.com[:/]/i.test(remoteResult.stdout)
  const currentBranch = await readCurrentBranch(repositoryRoot)
  const upstreamBranch = await readUpstreamBranch(repositoryRoot)

  if (isGitHubRepository) {
    return {
      scope: 'github-repo',
      title: 'Mudanças não commitadas',
      subtitle: 'Arquivos diferentes do último commit',
      isGitRepository: true,
      isGitHubRepository: true,
      repositoryRoot,
      currentBranch,
      upstreamBranch,
      capabilities: {
        canDiff: true,
        canRevert: true,
        canOpenExternal: true,
      },
    }
  }

  return {
    scope: 'git-repo',
    title: 'Mudanças no repositório',
    subtitle: 'Arquivos diferentes do último commit',
    isGitRepository: true,
    isGitHubRepository: false,
    repositoryRoot,
    currentBranch,
    upstreamBranch,
    capabilities: {
      canDiff: true,
      canRevert: true,
      canOpenExternal: true,
    },
  }
}

async function readCurrentBranch(root: string): Promise<string | undefined> {
  const branchResult = await runGit(root, ['branch', '--show-current'])
  if (branchResult.ok && branchResult.stdout.trim()) return branchResult.stdout.trim()
  const detachedResult = await runGit(root, ['rev-parse', '--short', 'HEAD'])
  return detachedResult.ok ? detachedResult.stdout.trim() || undefined : undefined
}

async function readUpstreamBranch(root: string): Promise<string | undefined> {
  const result = await runGit(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  return result.ok ? result.stdout.trim() || undefined : undefined
}

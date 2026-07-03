import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { WorkspaceBranch, WorkspaceBranchInfo, WorkspaceBranchSwitchResult } from '../../shared/types'
import { resolveRepoRoot } from './fileReviewService'
import { runGit } from './workspaceChangeService'

const execFileAsync = promisify(execFile)

export async function readWorkspaceBranchInfo(workingDirectory: string): Promise<WorkspaceBranchInfo> {
  const root = await resolveRepoRoot(workingDirectory)
  if (!root) {
    return {
      branches: [],
      canSwitch: false,
      dirty: false,
      dirtyFiles: [],
      message: 'Branches exigem um repositório Git.',
    }
  }

  const currentResult = await runGit(root, ['branch', '--show-current'])
  const currentBranch = currentResult.ok ? currentResult.stdout.trim() || undefined : undefined
  const upstreamBranch = await readUpstreamBranch(root)
  const branches = await readBranches(root, currentBranch)
  const dirtyFiles = await readDirtyFiles(root)

  return {
    currentBranch,
    upstreamBranch,
    branches,
    canSwitch: branches.length > 1 && dirtyFiles.length === 0,
    dirty: dirtyFiles.length > 0,
    dirtyFiles,
  }
}

export async function switchWorkspaceBranch(
  workingDirectory: string,
  branchName: string,
): Promise<WorkspaceBranchSwitchResult> {
  const root = await resolveRepoRoot(workingDirectory)
  if (!root) return { ok: false, message: 'Trocar branch exige um repositório Git.' }

  const requested = branchName.trim()
  if (!requested || requested.includes('\0')) return { ok: false, message: 'Branch inválida.' }

  const branchInfo = await readWorkspaceBranchInfo(root)
  const branch = branchInfo.branches.find(item => item.name === requested)
  if (!branch) return { ok: false, message: 'Branch não encontrada neste repositório.', branchInfo }
  if (branch.current) return { ok: true, branchInfo }
  if (branchInfo.dirty) {
    return {
      ok: false,
      message: 'Há mudanças não commitadas. Faça commit, stash ou descarte antes de trocar de branch.',
      branchInfo,
    }
  }

  const result = await runGitWithError(root, ['switch', requested])
  if (!result.ok) {
    return {
      ok: false,
      message: result.message || 'Não foi possível trocar de branch.',
      branchInfo,
    }
  }

  return {
    ok: true,
    branchInfo: await readWorkspaceBranchInfo(root),
  }
}

async function readUpstreamBranch(root: string): Promise<string | undefined> {
  const result = await runGit(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  return result.ok ? result.stdout.trim() || undefined : undefined
}

async function readBranches(root: string, currentBranch?: string): Promise<WorkspaceBranch[]> {
  const result = await runGit(root, ['for-each-ref', '--format=%(refname:short)|%(HEAD)|%(upstream:short)', 'refs/heads'])
  if (!result.ok) return []

  const seen = new Set<string>()
  const branches: WorkspaceBranch[] = []

  for (const rawLine of result.stdout.split(/\r?\n/)) {
    const [rawName, head, upstream] = rawLine.split('|')
    const name = normalizeBranchName(rawName)
    if (!name || seen.has(name)) continue
    seen.add(name)
    branches.push({
      name,
      current: head.trim() === '*' || name === currentBranch,
      remote: false,
      upstream: upstream?.trim() || undefined,
    })
  }

  return branches.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1
    if (a.remote !== b.remote) return a.remote ? 1 : -1
    return a.name.localeCompare(b.name)
  })
}

async function readDirtyFiles(root: string): Promise<string[]> {
  const result = await runGit(root, ['status', '--porcelain=v1', '--untracked-files=normal'])
  if (!result.ok) return []
  return result.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line.slice(3).trim())
    .filter(Boolean)
}

function normalizeBranchName(value: string | undefined): string {
  const name = value?.trim() ?? ''
  if (!name || name === 'HEAD' || name.endsWith('/HEAD')) return ''
  return name.replace(/^remotes\//, '')
}

async function runGitWithError(cwd: string, args: string[]): Promise<{ ok: true } | { ok: false; message?: string }> {
  try {
    await execFileAsync('git', ['-C', cwd, ...args], { maxBuffer: 256 * 1024 })
    return { ok: true }
  } catch (error) {
    const stderr = typeof error === 'object' && error && 'stderr' in error ? String(error.stderr ?? '') : ''
    const stdout = typeof error === 'object' && error && 'stdout' in error ? String(error.stdout ?? '') : ''
    return { ok: false, message: (stderr || stdout).trim() }
  }
}

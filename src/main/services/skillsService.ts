import { app } from 'electron'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { SkillSource, SkillSummary } from '../../shared/types'

type SkillRoot = {
  path: string
  source: SkillSource
  trusted: boolean
}

export class SkillsService {
  async listSkills(workingDirectory: string): Promise<SkillSummary[]> {
    const roots = this.getSkillRoots(workingDirectory)
    const nested = await Promise.all(roots.map(root => this.readRoot(root)))
    return dedupeSkills(nested.flat()).sort((a, b) => a.name.localeCompare(b.name))
  }

  async openUserSkillsFolder(): Promise<string> {
    const userDir = join(homedir(), '.verboo', 'skills')
    await import('node:fs/promises').then(fs => fs.mkdir(userDir, { recursive: true }))
    return userDir
  }

  private getSkillRoots(workingDirectory: string): SkillRoot[] {
    const cwd = resolve(workingDirectory || app.getPath('home'))
    return [
      { path: join(homedir(), '.verboo', 'skills'), source: 'user', trusted: true },
      { path: join(homedir(), '.agents', 'skills'), source: 'user', trusted: true },
      { path: join(homedir(), '.claude', 'skills'), source: 'legacy', trusted: true },
      { path: join(homedir(), '.codex', 'skills'), source: 'legacy', trusted: true },
      { path: join(cwd, '.verboo', 'skills'), source: 'project', trusted: false },
      { path: join(cwd, '.agents', 'skills'), source: 'project', trusted: false },
      { path: join(cwd, '.claude', 'skills'), source: 'project', trusted: false },
    ]
  }

  private async readRoot(root: SkillRoot): Promise<SkillSummary[]> {
    try {
      const entries = await readdir(root.path, { withFileTypes: true })
      const skills = await Promise.all(
        entries
          .filter(entry => entry.isDirectory())
          .map(entry => this.readSkillDirectory(join(root.path, entry.name), root)),
      )
      return skills.filter((skill): skill is SkillSummary => Boolean(skill))
    } catch {
      return []
    }
  }

  private async readSkillDirectory(path: string, root: SkillRoot): Promise<SkillSummary | undefined> {
    const skillPath = join(path, 'SKILL.md')
    try {
      const info = await stat(skillPath)
      if (!info.isFile()) return undefined
      const content = await readFile(skillPath, 'utf8')
      const frontmatter = parseFrontmatter(content)
      const name = frontmatter.name || basename(path)
      const description = frontmatter.description || firstContentLine(content) || 'Sem descricao'
      return {
        id: `${root.source}:${skillPath}`,
        name,
        description,
        path: skillPath,
        source: root.source,
        trusted: root.trusted,
      }
    } catch {
      return undefined
    }
  }
}

function parseFrontmatter(content: string): Record<string, string> {
  if (!content.startsWith('---')) return {}
  const end = content.indexOf('\n---', 3)
  if (end === -1) return {}
  const frontmatter = content.slice(3, end).trim()
  const result: Record<string, string> = {}
  for (const line of frontmatter.split('\n')) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!match) continue
    const [, key, rawValue] = match
    result[key] = rawValue.replace(/^['"]|['"]$/g, '').trim()
  }
  return result
}

function firstContentLine(content: string): string | undefined {
  const body = content.startsWith('---') ? content.slice(content.indexOf('\n---', 3) + 4) : content
  return body
    .split('\n')
    .map(line => line.replace(/^#+\s*/, '').trim())
    .find(Boolean)
}

function dedupeSkills(skills: SkillSummary[]): SkillSummary[] {
  const seen = new Map<string, SkillSummary>()
  for (const skill of skills) {
    const key = skill.name.toLowerCase()
    if (!seen.has(key)) seen.set(key, skill)
  }
  return [...seen.values()]
}

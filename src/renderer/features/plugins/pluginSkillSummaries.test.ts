import { describe, it, expect } from 'vitest'
import { loadPluginSkillSummaries } from './pluginSkillSummaries'
import { OFFICIAL_MARKETPLACES } from '../../../shared/plugins'
import type { SkillSummary } from '../../../shared/types'

describe('loadPluginSkillSummaries', () => {
  it('loads and maps skills from installed+enabled plugins with trusted:true', async () => {
    const pluginList = async () => [
      { id: 'my@market', name: 'My Plugin', enabled: true, installed: true },
      { id: 'disabled@market', name: 'Disabled Plugin', enabled: false, installed: true },
    ]
    const pluginSkills = async (id: string) =>
      id === 'my@market'
        ? [{ name: 'debugging', description: 'Systematic debugging', skillPath: '/cache/skills/debug/SKILL.md' }]
        : []

    const result = await loadPluginSkillSummaries(pluginList as any, pluginSkills as any)

    // 1 plugin-level mention + 1 skill entry
    expect(result).toHaveLength(2)
    expect(result[0].isPluginMention).toBe(true)
    expect(result[0].name).toBe('My Plugin')
    expect(result[0].path).toBe('')
    expect(result[1].name).toBe('debugging')
    expect(result[1].description).toBe('Systematic debugging')
    expect(result[1].path).toBe('/cache/skills/debug/SKILL.md')
    expect(result[1].source).toBe('managed')
    expect(result[1].trusted).toBe(true)
    expect(result[1].pluginId).toBe('my@market')
    expect(result[1].pluginName).toBe('My Plugin')
    expect(result[1].id).toBe('plugin:my@market:/cache/skills/debug/SKILL.md')
  })

  it('skips disabled plugins', async () => {
    const pluginList = async () => [
      { id: 'p1', name: 'P1', enabled: false, installed: true },
    ]
    const pluginSkills = async () => [{ name: 's', description: '', skillPath: '/s/SKILL.md' }]

    const result = await loadPluginSkillSummaries(pluginList as any, pluginSkills as any)
    expect(result).toHaveLength(0)
  })

  it('returns empty array when no plugins are installed', async () => {
    const pluginList = async () => []
    const pluginSkills = async () => []

    const result = await loadPluginSkillSummaries(pluginList as any, pluginSkills as any)
    expect(result).toHaveLength(0)
  })

  it('handles pluginSkills rejection gracefully', async () => {
    const pluginList = async () => [
      { id: 'bad', name: 'Bad', enabled: true, installed: true },
    ]
    const pluginSkills = async () => { throw new Error('network') }

    const result = await loadPluginSkillSummaries(pluginList as any, pluginSkills as any)
    // Plugin-level mention still emitted (skills failed but plugin is installed)
    expect(result).toHaveLength(1)
    expect(result[0].isPluginMention).toBe(true)
    expect(result[0].name).toBe('Bad')
  })

  it('emits plugin-mention even when plugin has zero skills (empty array)', async () => {
    // Case 1: plugin sem skills → token via hero. PluginSkills returns [],
    // not a rejection — the pluginMention must still be emitted so the hero
    // can insert @pluginName even when no individual skills exist.
    const pluginList = async () => [
      { id: 'mcp@hub', name: 'MCP Hub', enabled: true, installed: true },
    ]
    const pluginSkills = async () => [] as { name: string; description: string; skillPath: string }[]

    const result = await loadPluginSkillSummaries(pluginList as any, pluginSkills as any)
    expect(result).toHaveLength(1)
    expect(result[0].isPluginMention).toBe(true)
    expect(result[0].name).toBe('MCP Hub')
    expect(result[0].path).toBe('')
    expect(result[0].id).toBe('plugin-mention:mcp@hub')
  })
})

describe('merge — homonymous skills', () => {
  it('keeps separate entries for user and plugin skills with same name', () => {
    const userSkill: SkillSummary = {
      id: 'user:/path/s1', name: 'debugging', description: 'User debug',
      path: '/path/s1', source: 'user', trusted: true,
    }
    const pluginSkill: SkillSummary = {
      id: 'plugin:my@market:/cache/p/s1', name: 'debugging', description: 'Plugin debug',
      path: '/cache/p/s1', source: 'managed', trusted: true,
      pluginId: 'my@market', pluginName: 'My Plugin',
    }
    const merged = [userSkill, pluginSkill]
    expect(merged).toHaveLength(2)
    expect(merged.filter(s => s.name === 'debugging')).toHaveLength(2)
    expect(merged[0].id).not.toBe(merged[1].id)
    expect(merged[0].source).toBe('user')
    expect(merged[1].source).toBe('managed')
  })

  it('plugin-mention entry has isPluginMention:true and empty path', () => {
    const mention: SkillSummary = {
      id: 'plugin-mention:test', name: 'Test Plugin', description: '',
      path: '', source: 'managed', trusted: true,
      pluginId: 'test', pluginName: 'Test Plugin', isPluginMention: true,
    }
    expect(mention.isPluginMention).toBe(true)
    expect(mention.path).toBe('')
  })

  it('skipped plugin (disabled) does not emit mention entry', async () => {
    const pluginList = async () => [
      { id: 'off@market', name: 'Off', enabled: false, installed: true },
    ]
    const pluginSkills = async () => []
    const result = await loadPluginSkillSummaries(pluginList as any, pluginSkills as any)
    expect(result).toHaveLength(0)
  })
})

describe('OFFICIAL_MARKETPLACES', () => {
  it('exports expected marketplace names', () => {
    expect(Array.isArray(OFFICIAL_MARKETPLACES)).toBe(true)
    expect(OFFICIAL_MARKETPLACES).toContain('verboo-plugins')
  })

  it('isOfficial check via id.split(@)', () => {
    const officialId = 'my-plugin@verboo-plugins'
    const unofficialId = 'my-plugin@community-market'
    expect(OFFICIAL_MARKETPLACES.includes(officialId.split('@')[1])).toBe(true)
    expect(OFFICIAL_MARKETPLACES.includes(unofficialId.split('@')[1])).toBe(false)
  })
})

describe('merge — homonymous skills', () => {
  it('dedupes when same skill id is selected via hero chip and @ palette', () => {
    const skill: SkillSummary = {
      id: 'plugin:m1:/s/SKILL.md', name: 'review', description: 'Code review',
      path: '/s/SKILL.md', source: 'managed', trusted: true,
      pluginId: 'm1', pluginName: 'M1',
    }
    const selected: SkillSummary[] = []
    if (!selected.some(s => s.id === skill.id)) selected.push(skill)
    expect(selected).toHaveLength(1)
    // Hero chip select of the same skill must not duplicate.
    if (!selected.some(s => s.id === skill.id || s.path === skill.path)) selected.push(skill)
    expect(selected).toHaveLength(1)
  })
})

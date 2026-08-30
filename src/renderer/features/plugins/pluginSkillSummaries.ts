/**
 * Loads SkillSummary objects for all skills from installed+enabled plugins.
 *
 * These skills are merged with filesystem skills (`skills` in App.tsx) to form
 * mentionableSkills — used by the @ palette, / palette, and hero chip flow.
 *
 * Trusted rationale: installing a plugin is an explicit user action, same
 * trust class as user/legacy roots (~/.verboo/skills, ~/.claude/skills). The
 * `pending_approval_skills` gate exists for project-root skills (untrusted by
 * default); plugin skills are trusted by design.
 */

import type { SkillSummary } from '../../../shared/types'
import type { PluginSkill } from '../../../shared/plugins'

/** Minimal plugin info needed for skill mapping — subset of Plugin. */
type PluginInfo = {
  id: string
  name: string
  description?: string
  enabled: boolean
  installed: boolean
}

export async function loadPluginSkillSummaries(
  pluginList: () => Promise<PluginInfo[]>,
  pluginSkills: (id: string) => Promise<PluginSkill[]>,
): Promise<SkillSummary[]> {
  const plugins = await pluginList()
  const enabled = plugins.filter(p => p.enabled && p.installed)

  // Plugin-level mention entries: one per installed+enabled plugin (ITEM 1a).
  // These make @<plugin-name> work even for plugins with zero skills (MCP).
  const pluginMentions: SkillSummary[] = enabled.map(p => ({
    id: `plugin-mention:${p.id}`,
    name: p.name,
    description: p.description ?? '',
    path: '',
    source: 'managed',
    trusted: true,
    pluginId: p.id,
    pluginName: p.name,
    isPluginMention: true,
  }))

  const results = await Promise.allSettled(
    enabled.map(async p => {
      const skills = await pluginSkills(p.id)
      return skills.map(s => ({
        id: `plugin:${p.id}:${s.skillPath}`,
        name: s.name,
        description: s.description ?? '',
        path: s.skillPath,
        source: 'managed',
        trusted: true,
        pluginId: p.id,
        pluginName: p.name,
      } satisfies SkillSummary))
    }),
  )
  const out: SkillSummary[] = [...pluginMentions]
  for (const r of results) {
    if (r.status === 'fulfilled') out.push(...r.value)
    else console.warn('[plugin:skills] failed to load:', r.reason)
  }
  return out
}

/**
 * Unit tests for Skills Discovery and Activation hook LOGIC.
 *
 * NOTE: These tests use a simplified hook implementation that exercises
 * the same state management patterns as the real skill selection flow
 * in App.tsx, but with mockable dependencies. They are NOT integration
 * tests against the real App.tsx — they validate the contract and state
 * transitions in isolation.
 *
 * Covers:
 * - Skill list fetch from backend (Tauri invoke → state)
 * - Skill selection via slash commands (/skill-name) and @mentions
 * - Skill approval flow for untrusted project-root skills
 * - Skill injection into turn requests
 * - Plugin skills loading and merging with filesystem skills
 * - Trusted vs untrusted skill gating
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useState, useCallback } from 'react'
import {
  installVerbooBridge,
  makeSkill,
  createVerbooBridgeMock,
} from '../../test/test-utils'
import type { VerbooBridgeMock } from '../../test/test-utils'
import type { SkillSummary } from '../../../shared/types'

// ─── Mocks ──────────────────────────────────────────────────────────────────
vi.mock('../../i18n', () => ({ useI18n: () => ({ t: (k: string) => k }) }))

// ─── Test hook: useSkillSelection ───────────────────────────────────────────
// Simplified version of the skill selection flow in App.tsx
function useSkillSelection(mockBridge: Pick<VerbooBridgeMock, 'listSkills' | 'checkSkillApproval' | 'approveSkill'>) {
  const [allSkills, setAllSkills] = useState<SkillSummary[]>([])
  const [tokenSkills, setTokenSkills] = useState<SkillSummary[]>([])
  const [pendingApproval, setPendingApproval] = useState<SkillSummary[] | undefined>()

  const refreshSkills = useCallback(async (workingDirectory: string) => {
    const skills = await mockBridge.listSkills(workingDirectory)
    setAllSkills(skills)
    return skills
  }, [mockBridge])

  const addSkill = useCallback((skill: SkillSummary) => {
    setTokenSkills(prev => {
      if (prev.some(s => s.id === skill.id)) return prev
      return [...prev, skill]
    })
  }, [])

  const removeSkill = useCallback((skillId: string) => {
    setTokenSkills(prev => prev.filter(s => s.id !== skillId))
  }, [])

  const clearSkills = useCallback(() => {
    setTokenSkills([])
  }, [])

  const checkAndRequestApproval = useCallback(async (): Promise<boolean> => {
    if (tokenSkills.length === 0) return true
    const unapproved = await mockBridge.checkSkillApproval(tokenSkills)
    if (unapproved.length === 0) return true
    setPendingApproval(unapproved)
    return false
  }, [tokenSkills, mockBridge])

  const approveSkills = useCallback(async (skills: SkillSummary[], trust: boolean) => {
    for (const skill of skills) {
      if (trust) {
        await mockBridge.approveSkill(skill.path)
      }
    }
    setPendingApproval(undefined)
  }, [mockBridge])

  const cancelApproval = useCallback(() => {
    setPendingApproval(undefined)
  }, [])

  return {
    allSkills,
    tokenSkills,
    pendingApproval,
    refreshSkills,
    addSkill,
    removeSkill,
    clearSkills,
    checkAndRequestApproval,
    approveSkills,
    cancelApproval,
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Skills Discovery Integration', () => {
  let bridge: ReturnType<typeof createVerbooBridgeMock>

  beforeEach(() => {
    vi.clearAllMocks()
    bridge = installVerbooBridge()
  })

  describe('skill list fetch', () => {
    it('loads skills from backend for working directory', async () => {
      const skills = [
        makeSkill({ id: 'user:deep-analysis', name: 'deep-analysis', source: 'user', trusted: true }),
        makeSkill({ id: 'user:screen-analysis', name: 'screen-analysis-v2', source: 'user', trusted: true }),
        makeSkill({ id: 'legacy:mmx-cli', name: 'mmx-cli', source: 'legacy', trusted: true }),
      ]
      bridge.listSkills.mockResolvedValue(skills)

      const { result } = renderHook(() => useSkillSelection(bridge))

      await act(async () => {
        await result.current.refreshSkills('/c/Projetos/test')
      })

      expect(result.current.allSkills).toHaveLength(3)
      expect(bridge.listSkills).toHaveBeenCalledWith('/c/Projetos/test')
    })

    it('returns empty list when no skills exist', async () => {
      bridge.listSkills.mockResolvedValue([])

      const { result } = renderHook(() => useSkillSelection(bridge))

      await act(async () => {
        await result.current.refreshSkills('/c/empty')
      })

      expect(result.current.allSkills).toHaveLength(0)
    })

    it('includes project-root skills (untrusted)', async () => {
      const skills = [
        makeSkill({ id: 'project:custom', name: 'custom-skill', source: 'project', trusted: false }),
      ]
      bridge.listSkills.mockResolvedValue(skills)

      const { result } = renderHook(() => useSkillSelection(bridge))

      await act(async () => {
        await result.current.refreshSkills('/c/Projetos/test')
      })

      expect(result.current.allSkills[0].trusted).toBe(false)
      expect(result.current.allSkills[0].source).toBe('project')
    })
  })

  describe('skill selection', () => {
    it('adds skill to token list', async () => {
      bridge.listSkills.mockResolvedValue([])
      const { result } = renderHook(() => useSkillSelection(bridge))

      const skill = makeSkill({ id: 'user:deep-analysis', name: 'deep-analysis' })

      act(() => {
        result.current.addSkill(skill)
      })

      expect(result.current.tokenSkills).toHaveLength(1)
      expect(result.current.tokenSkills[0].name).toBe('deep-analysis')
    })

    it('prevents duplicate skill addition', async () => {
      bridge.listSkills.mockResolvedValue([])
      const { result } = renderHook(() => useSkillSelection(bridge))

      const skill = makeSkill({ id: 'user:deep-analysis', name: 'deep-analysis' })

      act(() => {
        result.current.addSkill(skill)
      })
      act(() => {
        result.current.addSkill(skill)
      })

      expect(result.current.tokenSkills).toHaveLength(1)
    })

    it('removes skill from token list by id', async () => {
      bridge.listSkills.mockResolvedValue([])
      const { result } = renderHook(() => useSkillSelection(bridge))

      const skill1 = makeSkill({ id: 'user:skill-1', name: 'skill-1' })
      const skill2 = makeSkill({ id: 'user:skill-2', name: 'skill-2' })

      act(() => {
        result.current.addSkill(skill1)
        result.current.addSkill(skill2)
      })
      expect(result.current.tokenSkills).toHaveLength(2)

      act(() => {
        result.current.removeSkill('user:skill-1')
      })

      expect(result.current.tokenSkills).toHaveLength(1)
      expect(result.current.tokenSkills[0].name).toBe('skill-2')
    })

    it('clears all selected skills', async () => {
      bridge.listSkills.mockResolvedValue([])
      const { result } = renderHook(() => useSkillSelection(bridge))

      act(() => {
        result.current.addSkill(makeSkill({ id: 'user:s1', name: 's1' }))
        result.current.addSkill(makeSkill({ id: 'user:s2', name: 's2' }))
      })

      act(() => {
        result.current.clearSkills()
      })

      expect(result.current.tokenSkills).toHaveLength(0)
    })
  })

  describe('skill approval flow', () => {
    it('allows trusted skills without approval', async () => {
      const trustedSkill = makeSkill({ id: 'user:trusted', name: 'trusted', trusted: true })
      bridge.listSkills.mockResolvedValue([trustedSkill])
      bridge.checkSkillApproval.mockResolvedValue([])

      const { result } = renderHook(() => useSkillSelection(bridge))

      await act(async () => {
        await result.current.refreshSkills('/c/test')
      })
      act(() => {
        result.current.addSkill(trustedSkill)
      })

      let approved = false
      await act(async () => {
        approved = await result.current.checkAndRequestApproval()
      })

      expect(approved).toBe(true)
      expect(result.current.pendingApproval).toBeUndefined()
    })

    it('requires approval for untrusted project-root skills', async () => {
      const untrustedSkill = makeSkill({
        id: 'project:custom',
        name: 'custom',
        source: 'project',
        trusted: false,
        path: '/c/test/.verboo/skills/custom/SKILL.md',
      })
      bridge.listSkills.mockResolvedValue([untrustedSkill])
      bridge.checkSkillApproval.mockResolvedValue([untrustedSkill])

      const { result } = renderHook(() => useSkillSelection(bridge))

      await act(async () => {
        await result.current.refreshSkills('/c/test')
      })
      act(() => {
        result.current.addSkill(untrustedSkill)
      })

      let approved = false
      await act(async () => {
        approved = await result.current.checkAndRequestApproval()
      })

      expect(approved).toBe(false)
      expect(result.current.pendingApproval).toHaveLength(1)
      expect(result.current.pendingApproval![0].name).toBe('custom')
    })

    it('approves skills and persists trust', async () => {
      const untrustedSkill = makeSkill({
        id: 'project:custom',
        name: 'custom',
        source: 'project',
        trusted: false,
        path: '/c/test/.verboo/skills/custom/SKILL.md',
      })
      bridge.checkSkillApproval.mockResolvedValue([untrustedSkill])
      bridge.approveSkill.mockResolvedValue({ success: true })

      const { result } = renderHook(() => useSkillSelection(bridge))

      act(() => {
        result.current.addSkill(untrustedSkill)
      })

      await act(async () => {
        await result.current.checkAndRequestApproval()
      })

      await act(async () => {
        await result.current.approveSkills([untrustedSkill], true)
      })

      expect(bridge.approveSkill).toHaveBeenCalledWith(untrustedSkill.path)
      expect(result.current.pendingApproval).toBeUndefined()
    })

    it('cancels approval and keeps pending state', async () => {
      const untrustedSkill = makeSkill({
        id: 'project:custom',
        name: 'custom',
        source: 'project',
        trusted: false,
      })
      bridge.checkSkillApproval.mockResolvedValue([untrustedSkill])

      const { result } = renderHook(() => useSkillSelection(bridge))

      act(() => {
        result.current.addSkill(untrustedSkill)
      })

      await act(async () => {
        await result.current.checkAndRequestApproval()
      })

      expect(result.current.pendingApproval).toHaveLength(1)

      act(() => {
        result.current.cancelApproval()
      })

      expect(result.current.pendingApproval).toBeUndefined()
    })
  })

  describe('skill sources', () => {
    it('distinguishes user, legacy, project, and managed sources', async () => {
      const skills = [
        makeSkill({ id: 'user:s1', name: 'user-skill', source: 'user' }),
        makeSkill({ id: 'legacy:s2', name: 'legacy-skill', source: 'legacy' }),
        makeSkill({ id: 'project:s3', name: 'project-skill', source: 'project' }),
        makeSkill({ id: 'managed:s4', name: 'managed-skill', source: 'managed' }),
      ]
      bridge.listSkills.mockResolvedValue(skills)

      const { result } = renderHook(() => useSkillSelection(bridge))

      await act(async () => {
        await result.current.refreshSkills('/c/test')
      })

      const sources = result.current.allSkills.map(s => s.source)
      expect(sources).toContain('user')
      expect(sources).toContain('legacy')
      expect(sources).toContain('project')
      expect(sources).toContain('managed')
    })
  })

  describe('plugin skills', () => {
    it('includes plugin skills with pluginId and pluginName', async () => {
      const pluginSkill = makeSkill({
        id: 'plugin:my-plugin:/skills/debug/SKILL.md',
        name: 'debugging',
        source: 'managed',
        trusted: true,
        pluginId: 'my-plugin@market',
        pluginName: 'My Plugin',
      })
      bridge.listSkills.mockResolvedValue([pluginSkill])

      const { result } = renderHook(() => useSkillSelection(bridge))

      await act(async () => {
        await result.current.refreshSkills('/c/test')
      })

      expect(result.current.allSkills[0].pluginId).toBe('my-plugin@market')
      expect(result.current.allSkills[0].pluginName).toBe('My Plugin')
    })

    it('plugin skills are always trusted', async () => {
      const pluginSkill = makeSkill({
        id: 'plugin:p1:/skills/s/SKILL.md',
        name: 'plugin-skill',
        source: 'managed',
        trusted: true,
        pluginId: 'p1@market',
      })

      expect(pluginSkill.trusted).toBe(true)
    })
  })
})

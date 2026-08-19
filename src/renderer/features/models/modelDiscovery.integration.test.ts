/**
 * Unit tests for Model Discovery and Selection hook LOGIC.
 *
 * NOTE: These tests use a simplified hook implementation that exercises
 * the same state management patterns as the real model discovery flow
 * in App.tsx, but with mockable dependencies. They are NOT integration
 * tests against the real App.tsx — they validate the contract and state
 * transitions in isolation.
 *
 * Covers:
 * - Model list fetch from backend (Tauri invoke → state)
 * - Model selection persistence
 * - Model switching with conversation context
 * - Fallback when model list is empty or stale
 * - Deduplication of models with same ID
 * - Vision support detection
 * - Context window and reasoning metadata
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useState, useCallback, useRef } from 'react'
import {
  installTauriMocks,
  makeModel,
  makeModelDiscoveryResult,
  installVerbooBridge,
  expectInvokeCalled,
} from '../../test/test-utils'
import type { VerbooBridgeMock } from '../../test/test-utils'
import type { VerbooModel, ModelDiscoveryResult } from '../../../shared/types'

// ─── Mocks ──────────────────────────────────────────────────────────────────
vi.mock('../../i18n', () => ({ useI18n: () => ({ t: (k: string) => k }) }))

// ─── Test hook: useModelDiscovery ───────────────────────────────────────────
// Simplified version of the model discovery flow in App.tsx (lines 1786-1794)
function useModelDiscovery(mockBridge: Pick<VerbooBridgeMock, 'listModels'>) {
  const [modelResult, setModelResult] = useState<ModelDiscoveryResult>({
    models: [],
    source: 'none',
    stale: false,
  })
  const [selectedModel, setSelectedModel] = useState<string | undefined>()
  const lastSelectedRef = useRef<string | undefined>(undefined)

  const refreshModels = useCallback(async (forceRefresh: boolean) => {
    const result = await mockBridge.listModels(forceRefresh)
    // Dedup by ID (mirrors App.tsx dedupModels)
    const seen = new Set<string>()
    const deduped = {
      ...result,
      models: result.models.filter((m: VerbooModel) => {
        if (seen.has(m.id)) return false
        seen.add(m.id)
        return true
      }),
    }
    setModelResult(deduped)
    // Resolve selected model (mirrors resolveSelectedModel)
    setSelectedModel(current => {
      if (current && deduped.models.some((m: VerbooModel) => m.id === current)) return current
      if (lastSelectedRef.current && deduped.models.some((m: VerbooModel) => m.id === lastSelectedRef.current)) return lastSelectedRef.current
      return deduped.models[0]?.id
    })
    return deduped
  }, [mockBridge])

  const selectModel = useCallback((modelId: string) => {
    setSelectedModel(modelId)
    lastSelectedRef.current = modelId
  }, [])

  return { modelResult, selectedModel, refreshModels, selectModel }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Model Discovery Integration', () => {
  let bridge: ReturnType<typeof installVerbooBridge>

  beforeEach(() => {
    vi.clearAllMocks()
    bridge = installVerbooBridge()
  })

  describe('fetch and populate model list', () => {
    it('loads models from backend on init', async () => {
      const models = [
        makeModel({ id: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash' }),
        makeModel({ id: 'mimo-v2.5', displayName: 'MiMo v2.5', supportsVision: true }),
        makeModel({ id: 'qwen3.6-27b', displayName: 'Qwen 3.6 27B' }),
      ]
      bridge.listModels.mockResolvedValue(makeModelDiscoveryResult({
        models,
        source: 'cli',
        stale: false,
      }))

      const { result } = renderHook(() => useModelDiscovery(bridge))

      await act(async () => {
        await result.current.refreshModels(false)
      })

      expect(result.current.modelResult.models).toHaveLength(3)
      expect(result.current.modelResult.source).toBe('cli')
      expect(result.current.selectedModel).toBe('deepseek-v4-flash')
    })

    it('selects first model when no previous selection', async () => {
      bridge.listModels.mockResolvedValue(makeModelDiscoveryResult({
        models: [
          makeModel({ id: 'model-a' }),
          makeModel({ id: 'model-b' }),
        ],
      }))

      const { result } = renderHook(() => useModelDiscovery(bridge))

      await act(async () => {
        await result.current.refreshModels(false)
      })

      expect(result.current.selectedModel).toBe('model-a')
    })

    it('preserves selection when model still in list', async () => {
      bridge.listModels.mockResolvedValue(makeModelDiscoveryResult({
        models: [
          makeModel({ id: 'model-a' }),
          makeModel({ id: 'model-b' }),
        ],
      }))

      const { result } = renderHook(() => useModelDiscovery(bridge))

      // First load
      await act(async () => {
        await result.current.refreshModels(false)
      })
      expect(result.current.selectedModel).toBe('model-a')

      // Select model-b
      act(() => {
        result.current.selectModel('model-b')
      })
      expect(result.current.selectedModel).toBe('model-b')

      // Refresh — model-b still in list
      await act(async () => {
        await result.current.refreshModels(false)
      })

      expect(result.current.selectedModel).toBe('model-b')
    })

    it('falls back to first model when selected model disappears', async () => {
      bridge.listModels.mockResolvedValueOnce(makeModelDiscoveryResult({
        models: [
          makeModel({ id: 'model-a' }),
          makeModel({ id: 'model-b' }),
        ],
      }))

      const { result } = renderHook(() => useModelDiscovery(bridge))

      await act(async () => {
        await result.current.refreshModels(false)
      })
      act(() => {
        result.current.selectModel('model-b')
      })

      // Refresh — model-b removed
      bridge.listModels.mockResolvedValueOnce(makeModelDiscoveryResult({
        models: [makeModel({ id: 'model-a' })],
      }))

      await act(async () => {
        await result.current.refreshModels(true)
      })

      expect(result.current.selectedModel).toBe('model-a')
    })
  })

  describe('model deduplication', () => {
    it('removes duplicate model IDs, keeps first occurrence', async () => {
      bridge.listModels.mockResolvedValue(makeModelDiscoveryResult({
        models: [
          makeModel({ id: 'deepseek-v4-flash', displayName: 'First' }),
          makeModel({ id: 'deepseek-v4-flash', displayName: 'Duplicate' }),
          makeModel({ id: 'mimo-v2.5' }),
        ],
      }))

      const { result } = renderHook(() => useModelDiscovery(bridge))

      await act(async () => {
        await result.current.refreshModels(false)
      })

      expect(result.current.modelResult.models).toHaveLength(2)
      expect(result.current.modelResult.models[0].displayName).toBe('First')
    })
  })

  describe('vision support metadata', () => {
    it('exposes supportsVision flag from model', async () => {
      bridge.listModels.mockResolvedValue(makeModelDiscoveryResult({
        models: [
          makeModel({ id: 'text-only', supportsVision: false }),
          makeModel({ id: 'vision-capable', supportsVision: true, visionSupportSource: 'router' }),
        ],
      }))

      const { result } = renderHook(() => useModelDiscovery(bridge))

      await act(async () => {
        await result.current.refreshModels(false)
      })

      const textModel = result.current.modelResult.models.find(m => m.id === 'text-only')
      const visionModel = result.current.modelResult.models.find(m => m.id === 'vision-capable')

      expect(textModel?.supportsVision).toBe(false)
      expect(visionModel?.supportsVision).toBe(true)
      expect(visionModel?.visionSupportSource).toBe('router')
    })
  })

  describe('reasoning/effort metadata', () => {
    it('exposes reasoning levels from model', async () => {
      bridge.listModels.mockResolvedValue(makeModelDiscoveryResult({
        models: [
          makeModel({
            id: 'reasoning-model',
            reasoning: {
              effortLevels: ['low', 'medium', 'high', 'max'],
              defaultEffort: 'high',
            },
          }),
        ],
      }))

      const { result } = renderHook(() => useModelDiscovery(bridge))

      await act(async () => {
        await result.current.refreshModels(false)
      })

      const model = result.current.modelResult.models[0]
      expect(model.reasoning?.effortLevels).toEqual(['low', 'medium', 'high', 'max'])
      expect(model.reasoning?.defaultEffort).toBe('high')
    })
  })

  describe('context window metadata', () => {
    it('exposes context window size', async () => {
      bridge.listModels.mockResolvedValue(makeModelDiscoveryResult({
        models: [
          makeModel({ id: 'small', contextWindow: 32000 }),
          makeModel({ id: 'large', contextWindow: 1000000 }),
        ],
      }))

      const { result } = renderHook(() => useModelDiscovery(bridge))

      await act(async () => {
        await result.current.refreshModels(false)
      })

      expect(result.current.modelResult.models[0].contextWindow).toBe(32000)
      expect(result.current.modelResult.models[1].contextWindow).toBe(1000000)
    })
  })

  describe('stale model list', () => {
    it('marks result as stale when backend reports it', async () => {
      bridge.listModels.mockResolvedValue(makeModelDiscoveryResult({
        models: [makeModel()],
        stale: true,
        source: 'cache',
      }))

      const { result } = renderHook(() => useModelDiscovery(bridge))

      await act(async () => {
        await result.current.refreshModels(false)
      })

      expect(result.current.modelResult.stale).toBe(true)
      expect(result.current.modelResult.source).toBe('cache')
    })
  })

  describe('empty model list', () => {
    it('handles empty model list gracefully', async () => {
      bridge.listModels.mockResolvedValue(makeModelDiscoveryResult({
        models: [],
        source: 'none',
      }))

      const { result } = renderHook(() => useModelDiscovery(bridge))

      await act(async () => {
        await result.current.refreshModels(false)
      })

      expect(result.current.modelResult.models).toHaveLength(0)
      expect(result.current.selectedModel).toBeUndefined()
    })
  })

  describe('force refresh', () => {
    it('passes forceRefresh flag to backend', async () => {
      bridge.listModels.mockResolvedValue(makeModelDiscoveryResult())

      const { result } = renderHook(() => useModelDiscovery(bridge))

      await act(async () => {
        await result.current.refreshModels(true)
      })

      expect(bridge.listModels).toHaveBeenCalledWith(true)
    })
  })
})

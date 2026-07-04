import { app } from 'electron'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ModelDiscoveryResult, VerbooModel } from '../../shared/types'
import type { VerbooApiClient } from './verbooApiClient'

const VERBOO_ROUTER_MODELS_URL = 'https://code.verboo.ai/router/v1/models'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

type ModelsCache = {
  fetchedAt: number
  models: VerbooModel[]
}

export class ModelService {
  private readonly filePath = join(app.getPath('userData'), 'cache', 'models.json')

  constructor(private readonly api: VerbooApiClient) {}

  async listModels(forceRefresh = false): Promise<ModelDiscoveryResult> {
    const cached = await this.readCache()
    let liveError: unknown

    if (!forceRefresh && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return { models: cached.models, source: 'cache', stale: false }
    }

    const apiKey = await this.api.getApiKeyBearerToken()
    if (apiKey) {
      try {
        const models = normalizeModels(await this.api.requestJson(VERBOO_ROUTER_MODELS_URL, apiKey.value))
        await this.writeCache({ fetchedAt: Date.now(), models })
        return { models, source: apiKey.source, stale: false }
      } catch (error) {
        liveError = error
      }
    }

    const cliToken = await this.api.getCliBearerToken()
    if (cliToken) {
      try {
        const models = normalizeModels(await this.api.requestJson(VERBOO_ROUTER_MODELS_URL, cliToken.value))
        await this.writeCache({ fetchedAt: Date.now(), models })
        return { models, source: cliToken.source, stale: false }
      } catch (error) {
        liveError = error
        if (isAuthFailure(error)) {
          const refreshedToken = await this.api.refreshCliBearerToken()
          if (refreshedToken) {
            try {
              const models = normalizeModels(await this.api.requestJson(VERBOO_ROUTER_MODELS_URL, refreshedToken.value))
              await this.writeCache({ fetchedAt: Date.now(), models })
              return { models, source: refreshedToken.source, stale: false }
            } catch (retryError) {
              liveError = retryError
            }
          }
        }
      }
    }

    if (cached) {
      return {
        models: cached.models,
        source: 'cache',
        stale: Boolean(liveError) || forceRefresh || Date.now() - cached.fetchedAt >= CACHE_TTL_MS,
        error: liveError ? modelErrorMessage(liveError) : 'Entre com Verboo pelo CLI/app para atualizar os modelos da sua conta.',
      }
    }

    return {
      models: [],
      source: 'none',
      stale: false,
      error: liveError ? modelErrorMessage(liveError) : 'Entre com Verboo pelo CLI/app ou configure uma chave API.',
    }
  }

  private async readCache(): Promise<ModelsCache | undefined> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      return JSON.parse(raw) as ModelsCache
    } catch {
      return undefined
    }
  }

  private async writeCache(cache: ModelsCache): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
    await writeFile(this.filePath, JSON.stringify(cache, null, 2), { encoding: 'utf8', mode: 0o600 })
    await chmod(this.filePath, 0o600)
  }
}

function modelErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (isAuthFailure(error)) {
    return 'Sessão Verboo expirada. Entre novamente ou salve uma chave de API válida.'
  }
  return message
}

function isAuthFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /401|expired token|invalid.*token/i.test(message)
}

function normalizeModels(payload: unknown): VerbooModel[] {
  const data = isRecord(payload) && Array.isArray(payload.data) ? payload.data : Array.isArray(payload) ? payload : []
  return data
    .map(item => normalizeModel(item))
    .filter((model): model is VerbooModel => Boolean(model))
}

function normalizeModel(item: unknown): VerbooModel | undefined {
  if (!isRecord(item) || typeof item.id !== 'string') return undefined
  const displayName =
    stringValue(item.display_name) ??
    stringValue(item.displayName) ??
    stringValue(item.label) ??
    item.id
  const visionSupport = detectVisionSupport(item)

  return {
    id: item.id,
    displayName,
    contextWindow:
      numberValue(item.context_window) ??
      numberValue(item.contextWindow) ??
      numberValue(item.context_length) ??
      numberValue(item.max_input_tokens),
    maxOutputTokens:
      numberValue(item.max_output_tokens) ??
      numberValue(item.maxOutputTokens) ??
      numberValue(item.max_completion_tokens),
    supportsVision: visionSupport.supportsVision,
    visionSupportSource: visionSupport.source,
    raw: item,
  }
}

function detectVisionSupport(item: Record<string, unknown>): {
  supportsVision?: boolean
  source?: VerbooModel['visionSupportSource']
} {
  const direct =
    booleanValue(item.supportsVision) ??
    booleanValue(item.supports_vision) ??
    booleanValue(item.vision)
  if (direct !== undefined) return { supportsVision: direct, source: 'router' }

  const capabilities = isRecord(item.capabilities) ? item.capabilities : undefined
  const capabilityVision =
    booleanValue(capabilities?.supportsVision) ??
    booleanValue(capabilities?.supports_vision) ??
    booleanValue(capabilities?.vision)
  if (capabilityVision !== undefined) return { supportsVision: capabilityVision, source: 'raw-capabilities' }

  const modalities = [
    ...stringArray(item.input_modalities),
    ...stringArray(item.inputModalities),
    ...stringArray(item.modalities),
    ...stringArray(capabilities?.input_modalities),
    ...stringArray(capabilities?.inputModalities),
    ...stringArray(capabilities?.modalities),
  ].map(value => value.toLowerCase())
  if (modalities.some(value => value === 'image' || value === 'vision')) {
    return { supportsVision: true, source: 'raw-capabilities' }
  }

  const classifications = stringArray(item.classification).map(value => value.toLowerCase())
  if (classifications.some(value => value.includes('vision') || value.includes('image'))) {
    return { supportsVision: true, source: 'raw-capabilities' }
  }

  const id = `${item.id} ${stringValue(item.display_name) ?? ''} ${stringValue(item.displayName) ?? ''} ${stringValue(item.label) ?? ''}`.toLowerCase()
  if (/\b(vision|vl|omni|multimodal)\b/.test(id) || id.includes('minimax-vision')) {
    return { supportsVision: true, source: 'heuristic' }
  }

  return {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

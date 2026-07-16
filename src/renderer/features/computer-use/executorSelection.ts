import type { VerbooModel } from '../../../shared/types'

export type ComputerUseExecutorSelection = {
  model: VerbooModel
  temporary: boolean
}

export type ComputerUseCliSessionPolicy = {
  resumeExistingSession: boolean
  persistReturnedSession: boolean
}

/**
 * A temporary visual executor gets an isolated CLI conversation. Its image
 * history must not enter or replace the user's original model session.
 */
export function computerUseCliSessionPolicy(
  temporaryExecutor: boolean,
): ComputerUseCliSessionPolicy {
  return temporaryExecutor
    ? { resumeExistingSession: false, persistReturnedSession: false }
    : { resumeExistingSession: true, persistReturnedSession: true }
}

/**
 * Computer Use needs a model that can inspect every screenshot itself.
 * Keep the user's selected model when possible; otherwise use the first
 * vision-capable model in the catalog. Catalog order is authoritative — this
 * deliberately avoids provider-specific or product-tier ranking.
 */
export function selectComputerUseExecutor(
  selectedModelId: string | undefined,
  models: VerbooModel[],
  preferredVisualModelId?: string,
): ComputerUseExecutorSelection | undefined {
  const selected = models.find(model => model.id === selectedModelId)
  if (selected?.supportsVision) return { model: selected, temporary: false }

  const preferred = preferredVisualModelId
    ? models.find(model => model.id === preferredVisualModelId && model.supportsVision === true)
    : undefined
  const visionModel = preferred ?? models.find(model => model.supportsVision === true)
  return visionModel ? { model: visionModel, temporary: true } : undefined
}

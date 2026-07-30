import { MSG } from '../controller/protocol.js'
import { replayRecordedSteps } from './replay.js'

/**
 * Resolve, validate, queue, and execute a saved routine.
 */
export function createRoutineRunner({
  routinesStore,
  runStore,
  queue,
  loadSession,
  loadModels,
  getSelectedModelId,
  getActiveTabMeta,
  runAgent,
  executeRecordedStep,
  assetsStore,
  broadcast,
  cryptoImpl = globalThis.crypto,
}) {
  const controllers = new Map()

  async function run(request) {
    const context = await resolveContext(request)
    const { accountId, routine, modelId } = context
    const runId = cryptoImpl.randomUUID()
    let runRecord = await runStore.create(accountId, {
      id: runId,
      routineId: routine.id,
      routineRevision: routine.revision,
      modelId,
      variables: cloneValue(request?.variables ?? {}),
      source: request?.source ?? 'manual',
      ...(Number.isInteger(request?.senderTabId)
        ? { senderTabId: request.senderTabId }
        : {}),
      ...(request?.occurrenceKey ? { occurrenceKey: request.occurrenceKey } : {}),
    })
    runRecord = await transition(accountId, runId, 'ready')
    runRecord = await transition(accountId, runId, 'queued')
    return enqueueExecution(context, runRecord, request, 0)
  }

  async function resume(accountId, runId, request = {}) {
    const runRecord = await runStore.get(accountId, runId)
    if (!runRecord) throw new Error('routine_run_not_found')
    if (runRecord.status !== 'queued') throw new Error('routine_run_not_queued')
    const resumedRequest = {
      ...request,
      routineId: runRecord.routineId,
      expectedRevision: runRecord.routineRevision,
      variables: cloneValue(runRecord.variables ?? {}),
      modelId: runRecord.modelId,
      source: runRecord.source,
      senderTabId: request.senderTabId ?? runRecord.senderTabId,
      occurrenceKey: runRecord.occurrenceKey,
    }
    const context = await resolveContext(resumedRequest, accountId)
    return enqueueExecution(
      context,
      runRecord,
      resumedRequest,
      Number.isInteger(runRecord.checkpointIndex) ? runRecord.checkpointIndex : 0,
    )
  }

  async function resolveContext(request, requiredAccountId) {
    const session = await loadSession()
    const accountId = String(session?.accountId ?? '').trim()
    if (!accountId || !session?.accessToken) throw new Error('auth_required')
    if (requiredAccountId && accountId !== requiredAccountId) {
      throw new Error('routine_account_mismatch')
    }

    const routine = await routinesStore.get(accountId, request?.routineId)
    if (!routine) throw new Error('routine_not_found')
    if (routine.revision !== request?.expectedRevision) {
      throw new Error('routine_revision_conflict')
    }

    const instructions = resolveInstructions(routine, request?.variables)
    const modelId = routine.modelId || request?.modelId || await getSelectedModelId()
    if (!modelId) throw new Error('routine_model_missing')
    const models = await loadModels(false)
    const model = models.find((item) => item.id === modelId)
    if (!model) throw new Error('routine_model_missing')
    if (routineNeedsVision(routine) && model.supportsVision !== true) {
      throw new Error('routine_model_requires_vision')
    }

    const activeTab = await getActiveTabMeta(request?.senderTabId)
    validateAllowedSite(routine, activeTab?.url)
    const assets = assetsStore
      ? (await Promise.all(
          (routine.assets ?? []).map((asset) => assetsStore.get(accountId, asset.id)),
        )).filter(Boolean)
      : cloneValue(routine.assets ?? [])
    return {
      accountId,
      session,
      routine,
      instructions,
      modelId,
      model,
      activeTab,
      assets,
    }
  }

  function enqueueExecution(context, runRecord, request, startIndex) {
    const {
      accountId,
      session,
      routine,
      instructions,
      modelId,
      model,
      activeTab,
      assets,
    } = context
    const runId = runRecord.id
    const controller = new AbortController()
    controllers.set(runId, controller)
    const completion = queue.enqueue({
      id: runId,
      cancel: () => controller.abort(),
      execute: async () => {
        try {
          await transition(accountId, runId, 'running')
          const agentInput = {
            turnId: runId,
            userMessage: routineRunPrompt(routine),
            accessToken: session.accessToken,
            modelId,
            modelSupportsVision: model.supportsVision === true,
            routineContext: {
              name: routine.name,
              instructions,
              assets,
            },
            routineAllowedOrigins: cloneValue(routine.allowedOrigins ?? []),
            senderTabId: request?.senderTabId,
            signal: controller.signal,
          }
          let result
          let recoverySuggestion

          if ((routine.recordedSteps ?? []).length > 0) {
            if (typeof executeRecordedStep !== 'function') {
              throw new Error('routine_replay_unavailable')
            }
            if (
              startIndex === 0 &&
              routine.startUrl &&
              activeTab?.url !== routine.startUrl
            ) {
              const navigation = await executeRecordedStep(
                {
                  id: cryptoImpl.randomUUID(),
                  name: 'navigate',
                  params: { url: routine.startUrl },
                  reasoning: 'Opening the recorded routine start page.',
                },
                {
                  ...request,
                  runId,
                  routineAllowedOrigins: routine.allowedOrigins ?? [],
                },
                controller.signal,
              )
              if (!navigation?.ok) {
                throw new Error(navigation?.error ?? 'routine_start_navigation_failed')
              }
            }

            const replay = await replayRecordedSteps({
              steps: routine.recordedSteps,
              startIndex,
              execute: (toolCall) =>
                executeRecordedStep(
                  toolCall,
                  {
                    ...request,
                    runId,
                    routineAllowedOrigins: routine.allowedOrigins ?? [],
                  },
                  controller.signal,
                ),
              checkpoint: async (checkpointIndex) => {
                await runStore.patch?.(accountId, runId, { checkpointIndex })
              },
              signal: controller.signal,
            })
            if (replay.status === 'completed') {
              result = {
                assistantMessage: 'Recorded routine completed.',
                toolResults: [],
              }
            } else {
              const failedStep = replay.failure.step
              result = await runAgent({
                ...agentInput,
                userMessage: recoveryPrompt(routine, replay.failure),
                routineContext: {
                  ...agentInput.routineContext,
                  instructions: recoveryInstructions(instructions, replay.failure),
                },
                toolAllowlist: recoveryToolAllowlist(
                  failedStep.name,
                  model.supportsVision === true,
                ),
              })
              recoverySuggestion = findRecoverySuggestion(
                replay.failure,
                result?.toolResults,
                routine.revision,
              )
            }
          } else {
            result = await runAgent(agentInput)
          }
          if (controller.signal.aborted) {
            return transition(accountId, runId, 'cancelled')
          }
          return transition(accountId, runId, 'completed', {
            assistantMessage: result?.assistantMessage ?? '',
            toolResults: compactToolResults(result?.toolResults),
            ...(recoverySuggestion ? { recoverySuggestion } : {}),
          })
        } catch (error) {
          if (controller.signal.aborted || error?.message === 'run_cancelled') {
            return transition(accountId, runId, 'cancelled')
          }
          return transition(accountId, runId, 'failed', {
            error: error?.message ?? String(error),
          })
        } finally {
          controllers.delete(runId)
        }
      },
    })

    if (request?.waitForCompletion === false) {
      void completion.catch(() => {})
      return runRecord
    }
    return completion
  }

  async function cancel(accountId, runId) {
    const didCancel = queue.cancel(runId)
    controllers.get(runId)?.abort()
    if (!didCancel) return false
    const current = await runStore.get(accountId, runId)
    if (current && ['draft', 'ready', 'queued'].includes(current.status)) {
      await transition(accountId, runId, 'cancelled')
    }
    return true
  }

  async function transition(accountId, runId, status, patch) {
    const updated = await runStore.transition(accountId, runId, status, patch)
    broadcast({
      type: MSG.ROUTINE_RUN_CHANGED,
      run: updated,
    })
    return updated
  }

  return { run, resume, cancel }
}

function resolveInstructions(routine, submittedVariables) {
  const values = submittedVariables && typeof submittedVariables === 'object'
    ? submittedVariables
    : {}
  let instructions = String(routine.instructions ?? '')
  for (const variable of routine.variables ?? []) {
    const submitted = values[variable.name]
    const value = submitted == null || String(submitted).length === 0
      ? variable.defaultValue
      : submitted
    if (variable.required !== false && (value == null || String(value).trim() === '')) {
      throw new Error(`routine_variable_missing:${variable.name}`)
    }
    instructions = instructions.replaceAll(`{{${variable.name}}}`, String(value ?? ''))
  }
  return instructions
}

function routineNeedsVision(routine) {
  return (routine.assets ?? []).some((asset) =>
    String(asset?.mime ?? asset?.type ?? '').startsWith('image/'),
  )
}

function validateAllowedSite(routine, activeUrl) {
  const allowed = new Set(routine.allowedOrigins ?? [])
  if (allowed.size === 0) return

  const targetUrl = routine.startUrl || activeUrl
  if (!targetUrl) throw new Error('routine_site_not_allowed')
  try {
    const origin = new URL(targetUrl).origin
    if (!allowed.has(origin)) throw new Error('routine_site_not_allowed')
  } catch (error) {
    if (error?.message === 'routine_site_not_allowed') throw error
    throw new Error('routine_site_not_allowed')
  }
}

function routineRunPrompt(routine) {
  return `Run the saved browser routine "${routine.name}".`
}

function recoveryPrompt(routine, failure) {
  return (
    `Recover step ${failure.index + 1} of the saved routine "${routine.name}". ` +
    'Do not repeat earlier confirmed steps.'
  )
}

function recoveryInstructions(instructions, failure) {
  return (
    `${instructions}\n\n` +
    `RECOVERY SCOPE: Only recover recorded step ${failure.index + 1}. ` +
    `Goal: ${JSON.stringify(failure.semantic)}. ` +
    `The saved action failed with: ${failure.error}. ` +
    'Inspect the page, perform one equivalent action, verify it, and stop.'
  )
}

function recoveryToolAllowlist(failedToolName, supportsVision) {
  return [...new Set([
    failedToolName,
    'read_page',
    ...(supportsVision ? ['screenshot'] : []),
  ])]
}

function findRecoverySuggestion(failure, toolResults, routineRevision) {
  const replacement = (Array.isArray(toolResults) ? toolResults : []).find(
    (result) =>
      result?.success === true &&
      result.name === failure.step.name &&
      result.params &&
      JSON.stringify(result.params) !== JSON.stringify(failure.step.params),
  )
  if (!replacement) return undefined
  return {
    stepIndex: failure.index,
    name: replacement.name,
    params: cloneValue(replacement.params),
    expectedRoutineRevision: routineRevision,
  }
}

function compactToolResults(results) {
  return (Array.isArray(results) ? results : []).map((result) => ({
    toolCallId: result?.toolCallId,
    name: result?.name,
    success: result?.success === true,
    error: result?.error ?? null,
  }))
}

function cloneValue(value) {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value))
}

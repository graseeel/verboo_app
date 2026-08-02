import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * STRUCTURAL source pins for the F3 send wiring inside App.tsx — the file is
 * far too large to mount in jsdom, so these pins read the source the way
 * App.agentEventSubscription.test.ts does. They pin POSITION and PRESENCE,
 * never behavior: the behavioral proof lives in annotationSend.test.ts
 * (freeze, byte-identical contrafactual, degradation) and in the Rust golden
 * (build_prompt_is_byte_identical_when_no_annotations). Each assertion names
 * what it protects, so a red here says WHAT broke, not just THAT it broke.
 */
const app = readFileSync(resolve(process.cwd(), 'src/renderer/App.tsx'), 'utf8')
const composerSource = readFileSync(resolve(process.cwd(), 'src/renderer/features/composer/Composer.tsx'), 'utf8')
const annotationLayerSource = readFileSync(resolve(process.cwd(), 'src/renderer/features/annotations/AnnotationLayer.tsx'), 'utf8')
const annotationSelectionSource = readFileSync(resolve(process.cwd(), 'src/renderer/features/annotations/useAnnotationSelection.ts'), 'utf8')

function sliceOf(fromSignature: string, toSignature: string): string {
  const start = app.indexOf(fromSignature)
  const end = start === -1 ? -1 : app.indexOf(toSignature, start)
  if (start === -1 || end === -1) throw new Error(`slice not found: ${fromSignature} → ${toSignature}`)
  return app.slice(start, end)
}

describe('F3 wiring pins (structural, source-level)', () => {
  it('GUARD: sendMessage rejects ONLY when there is no text AND no annotations', () => {
    // Sending ONLY an annotation is required behavior (the user, verbatim:
    // "posso apenas enviar a anotação"). If this pin goes red, someone
    // narrowed the guard back to text-only.
    const send = sliceOf('async function sendMessage', 'function isConversationRunning')
    expect(send).toContain('if (!trimmed && pendingAnnotations.length === 0) return')
  })

  it('FREEZE AT THE CLICK: the queued request is built through applyAnnotations', () => {
    // The request is born at click time inside createQueuedFollowUp — the
    // only place the field enters. A raw `request: {` here would mean the
    // annotations bypass the freeze.
    const create = sliceOf('function createQueuedFollowUp', 'function conversationLanguageFallback')
    expect(create).toContain('annotations: readonly Annotation[] = []')
    expect(create).toContain('request: applyAnnotations({')
  })

  it('CONSUME-AFTER-CONFIRM: drafts are consumed AFTER sendTrackedTurn resolves, never in a finally', () => {
    // The order IS the failure-preservation proof: if sendTrackedTurn throws,
    // nothing below it runs and the user's drafts survive the failed send.
    // Moving the consume into a finally (or above the await) reintroduces
    // "draft lost on failure" — this pin goes red first.
    const run = sliceOf('async function runTurn', 'async function sendTrackedTurn')
    const sendIdx = run.indexOf('await sendTrackedTurn(')
    const consumeIdx = run.indexOf('consumeAnnotationDrafts(')
    const itemIdx = run.indexOf('buildAnnotationTurnItem(')
    expect(sendIdx).toBeGreaterThan(-1)
    expect(consumeIdx).toBeGreaterThan(sendIdx)
    expect(itemIdx).toBeGreaterThan(sendIdx)
    expect(run).toContain('const sentAnnotations = request.annotations')
    expect(run).not.toContain('finally')
  })

  it('N3: the transcript item is built from the SENT annotations (the click-time portrait), not the live drafts', () => {
    const run = sliceOf('async function runTurn', 'async function sendTrackedTurn')
    expect(run).toContain('buildAnnotationTurnItem(\n          sentAnnotations,')
    expect(run).toContain('annotationTurnItemId(sentAnnotations.map(annotation => annotation.id))')
  })

  it('NO TS PROMPT ASSEMBLY: the deleted annotationPrompt.ts must never be reborn', () => {
    // The official block assembly is Rust-side (build_annotation_block,
    // audited). A second assembler in TS is the duplicated-implementation
    // defect the Maestro caught in F1 — any of these strings means it came back.
    expect(app).not.toContain('annotationPrompt')
    expect(app).not.toContain('buildAnnotationBlock')
  })
})

describe('cross-component selector contract', () => {
  it('pins the annotation .composer selector against the REAL Composer source', () => {
    // House rule after three escaped selector regressions: a fixture carrying
    // the expected class is not evidence. The producer source and every
    // annotation consumer must agree in this same contract test.
    expect(composerSource).toMatch(/<form[\s\S]{0,200}className="composer"/)
    expect(annotationLayerSource).toContain("querySelector<HTMLElement>('.composer')")
    expect(annotationSelectionSource).toContain(".goal-active-panel, .composer')")
  })
})

describe('QA a-i — the dead-session retry replays the annotations (never a stripped copy)', () => {
  // App.tsx is not mountable in jsdom (precedent: App.agentEventSubscription
  // .test.ts is source-based for the same reason), so the EFFECT is proven by
  // COMPOSITION: these pins prove WHICH arguments each call site passes, and
  // annotationSend.test.ts proves what applyAnnotations does with them —
  // together: the retried request carries the field. The end-to-end retry
  // over a real dead session is field, declared.
  it('PAYLOAD: the retry payload records the click-time annotations', () => {
    const run = sliceOf('async function runTurn', 'async function sendTrackedTurn')
    expect(run).toContain('annotations: request.annotations,')
    // The declared asymmetry must stay VISIBLE to the next reader:
    // annotation-only sends do NOT retry (shouldRetrySession needs a
    // non-empty message) — they fail visibly. Deliberate, not an oversight.
    expect(run).toContain('DECLARED ASYMMETRY')
  })

  it('EFFECT (error path): the willRestartSession retry passes the payload annotations to the queue', () => {
    const errorPath = sliceOf(
      'if (willRestartSession && conversationId && retryMeta) {',
      '// Auto-resume with a structured hidden prompt.',
    )
    expect(errorPath).toContain(
      'createQueuedFollowUp(conversationId, retryMeta.message, undefined, retryMeta.annotations ?? [])',
    )
  })

  it('EFFECT (done path): the shouldRetrySession retry passes the payload annotations to the queue', () => {
    const donePath = sliceOf(
      'if (shouldRetrySession && conversationId && retryMeta) {',
      'if (conversationId && event.exitCode !== 0) {',
    )
    expect(donePath).toContain(
      'createQueuedFollowUp(conversationId, message, undefined, retryMeta.annotations ?? [])',
    )
  })

  it('CONTRAFACTUAL: the auth/context RESUME must NOT carry annotations (continuation, not replay)', () => {
    // The trap the QA declared: this call site LOOKS identical to the two
    // above, but here the original turn was already delivered — the model
    // already saw the block. Replaying it would double the content.
    const resumePath = sliceOf(
      'if ((willRecoverAuth || willRecoverContext) && conversationId) {',
      'void runTurn(resume)',
    )
    expect(resumePath).toContain('createQueuedFollowUp(conversationId, resumeMessage)\n')
    expect(resumePath).not.toContain('resumeMessage,')
  })
})

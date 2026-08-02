import { describe, expect, it } from 'vitest'

import type { AgentTurnRequest, Annotation } from '../../../shared/types'
import { applyAnnotations } from './annotationRequest'
import { consumeAnnotationDrafts, addAnnotationDraft, draftsForConversation, type AnnotationDrafts } from './annotationDrafts'
import { buildAnnotationTurnItem } from './annotationTurnItem'

/**
 * F3 send-path pure tests — the seams that keep the biggest blast radius
 * in the project honest. What is pinned here:
 *
 *  - BYTE-IDENTICAL contrafactual (the gate the Maestro sealed): with zero
 *    annotations the request is the SAME REFERENCE — the `annotations` key
 *    never comes into existence;
 *  - effect: with annotations the FIELD arrives (never concatenated text);
 *  - N10 freeze: editing drafts DURING the in-flight turn cannot change
 *    what the model received — the request holds click-time copies;
 *  - degradation layer 3: an annotation whose excerpt vanished STILL ships;
 *  - Rust fixture pin: the serialized camelCase shape matches the Rust
 *    contract literals VERBATIM (sources cited inline);
 *  - consume-after-confirm: only the SENT annotations leave the drafts.
 */

let seq = 0
function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  seq += 1
  return {
    id: `ann-${seq}`,
    segmentId: 'turn1:text:0',
    quote: `quote-${seq}`,
    prefix: 'pre ',
    suffix: ' post',
    occurrenceIndex: 0,
    comment: null,
    createdAt: 1_700_000_000_000 + seq,
    ...overrides,
  }
}

function legacyRequest(): AgentTurnRequest {
  // The pre-F3 shape, verbatim: every key a request had before the field
  // existed. If applyAnnotations adds so much as a key in the empty case,
  // the toStrictEqual below goes red.
  return {
    conversationId: 'conv-1',
    message: 'hello',
    accessMode: 'approval',
    workingDirectory: '/tmp/project',
    skills: [],
  }
}

describe('applyAnnotations', () => {
  it('CONTRAFACTUAL (byte-identical gate): zero annotations → SAME reference, key never exists', () => {
    const request = legacyRequest()
    const result = applyAnnotations(request, [])
    expect(result).toBe(request) // same reference — nothing was touched
    expect('annotations' in result).toBe(false)
    expect(result).toStrictEqual(legacyRequest())
  })

  it('EFFECT: annotations travel as a FIELD of the request, message text untouched', () => {
    const annotations = [makeAnnotation({ quote: 'the chosen excerpt', comment: 'check this' })]
    const result = applyAnnotations(legacyRequest(), annotations)
    expect(result.message).toBe('hello') // never concatenated
    expect(result.annotations).toHaveLength(1)
    expect(result.annotations![0].quote).toBe('the chosen excerpt')
    expect(result.annotations![0].comment).toBe('check this')
  })

  it('N10 FREEZE: mutating the draft objects after the click does NOT change the request', () => {
    const draft = makeAnnotation({ comment: 'at click time' })
    const quoteAtClick = draft.quote
    const result = applyAnnotations(legacyRequest(), [draft])
    // Simulate the user editing the annotation DURING the in-flight turn:
    draft.comment = 'edited while flying'
    draft.quote = 'tampered'
    expect(result.annotations![0].comment).toBe('at click time')
    expect(result.annotations![0].quote).toBe(quoteAtClick)
    expect(result.annotations![0].quote).not.toBe('tampered')
  })

  it('DEGRADATION layer 3: an annotation whose excerpt NO LONGER EXISTS still ships', () => {
    // The resolver is display-only (F2). Nothing in the send path consults
    // it: the vanished-excerpt annotation reaches the model as data.
    const orphan = makeAnnotation({ quote: 'excerpt-that-vanished-from-the-transcript' })
    const result = applyAnnotations(legacyRequest(), [orphan])
    expect(result.annotations).toHaveLength(1)
    expect(result.annotations![0].quote).toBe('excerpt-that-vanished-from-the-transcript')
  })

  it('RUST FIXTURE PIN: the serialized annotation matches the Rust camelCase contract verbatim', () => {
    // Source: src-tauri/src/models/types.rs:952-963 (struct Annotation,
    // rename_all camelCase) + sample_annotation() at turn_service.rs:6120-6131.
    // The multi-word trap fields are segmentId / occurrenceIndex / createdAt —
    // the pair that zeroed the app's token count for days when it once
    // crossed in snake_case.
    const annotation = makeAnnotation({
      id: 'a1',
      segmentId: 'turn_42:text:0',
      quote: 'q',
      prefix: 'p',
      suffix: 's',
      occurrenceIndex: 1,
      comment: 'c',
      createdAt: 1_700_000_000_000,
    })
    const wire = JSON.parse(JSON.stringify(annotation))
    expect(wire).toStrictEqual({
      id: 'a1',
      segmentId: 'turn_42:text:0',
      quote: 'q',
      prefix: 'p',
      suffix: 's',
      occurrenceIndex: 1,
      comment: 'c',
      createdAt: 1_700_000_000_000,
    })
  })

  it('RUST FIXTURE PIN (legacy): a request WITHOUT annotations serializes without the key', () => {
    // Mirror of agent_turn_request_without_annotations_field_deserializes_to_none
    // (turn_service.rs:6353): the #[serde(default)] side tolerates absence —
    // this side must PRODUCE absence.
    const wire = JSON.parse(JSON.stringify(applyAnnotations(legacyRequest(), [])))
    expect('annotations' in wire).toBe(false)
  })

  it('comment: null serializes as JSON null (Option<String> without skip — the Rust shape)', () => {
    const wire = JSON.parse(JSON.stringify(applyAnnotations(legacyRequest(), [makeAnnotation({ comment: null })])))
    expect(wire.annotations[0].comment).toBeNull()
    expect('comment' in wire.annotations[0]).toBe(true)
  })
})

describe('consumeAnnotationDrafts — consume ONLY what the confirmed request carried', () => {
  it('removes the SENT ids and PRESERVES drafts created during flight', () => {
    const sent1 = makeAnnotation({ id: 'sent-1' })
    const sent2 = makeAnnotation({ id: 'sent-2' })
    const inFlight = makeAnnotation({ id: 'in-flight' })
    let drafts: AnnotationDrafts = {}
    for (const a of [sent1, sent2, inFlight]) drafts = addAnnotationDraft(drafts, 'conv-a', a)

    const next = consumeAnnotationDrafts(drafts, 'conv-a', new Set(['sent-1', 'sent-2']))
    expect(draftsForConversation(next, 'conv-a').map(a => a.id)).toEqual(['in-flight'])
  })

  it('all sent → the conversation key disappears (no empty array litter)', () => {
    const a = makeAnnotation({ id: 'only' })
    const drafts = addAnnotationDraft({}, 'conv-a', a)
    const next = consumeAnnotationDrafts(drafts, 'conv-a', new Set(['only']))
    expect('conv-a' in next).toBe(false)
  })

  it('nothing matched → SAME reference (no store churn)', () => {
    const a = makeAnnotation({ id: 'kept' })
    const drafts = addAnnotationDraft({}, 'conv-a', a)
    expect(consumeAnnotationDrafts(drafts, 'conv-a', new Set(['other']))).toBe(drafts)
  })

  it('OTHER conversations are never touched (posse, same reference)', () => {
    const a = makeAnnotation({ id: 'a1' })
    const b = makeAnnotation({ id: 'b1' })
    let drafts: AnnotationDrafts = {}
    drafts = addAnnotationDraft(drafts, 'conv-a', a)
    drafts = addAnnotationDraft(drafts, 'conv-b', b)
    const next = consumeAnnotationDrafts(drafts, 'conv-a', new Set(['a1']))
    expect(next['conv-b']).toBe(drafts['conv-b'])
  })
})

describe('buildAnnotationTurnItem — N3, the chip becomes a turn', () => {
  const labels = { quoteLabel: 'Selected text', commentLabel: 'Your comment' }

  it('SELF-CONTAINED: quote+comment pairs are frozen inside the item', () => {
    const item = buildAnnotationTurnItem(
      [makeAnnotation({ quote: 'excerpt one', comment: 'first note' }), makeAnnotation({ quote: 'excerpt two' })],
      labels,
      'annotation:1',
      123,
    )
    expect(item.kind).toBe('annotation')
    expect(item.role).toBe('user')
    expect(item.annotationEntries).toStrictEqual([
      { quote: 'excerpt one', comment: 'first note' },
      { quote: 'excerpt two', comment: null },
    ])
    expect(item.timestamp).toBe(123)
  })

  it('OLD-BUILD fallback: text renders the same pairs readably, with NO orphan comment label', () => {
    const item = buildAnnotationTurnItem(
      [makeAnnotation({ quote: 'excerpt one', comment: 'first note' }), makeAnnotation({ quote: 'excerpt two' })],
      labels,
      'annotation:1',
      123,
    )
    expect(item.text).toContain('1. Selected text: "excerpt one"')
    expect(item.text).toContain('Your comment: "first note"')
    expect(item.text).toContain('2. Selected text: "excerpt two"')
    // The second annotation has no comment — the fallback must NOT emit a
    // dangling label for it (one occurrence only, belonging to the first).
    expect(item.text.match(/Your comment/g)).toHaveLength(1)
  })
})

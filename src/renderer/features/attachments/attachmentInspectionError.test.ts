import { describe, expect, it } from 'vitest'
import { attachmentInspectionErrorKey } from './attachmentInspectionError'

describe('attachment inspection errors', () => {
  it('maps typed video errors to stable translation keys', () => {
    expect(attachmentInspectionErrorKey({ kind: 'video', details: { kind: 'tooLarge' } })).toBe('attachments.error.tooLarge')
    expect(attachmentInspectionErrorKey({ kind: 'video', details: { kind: 'tooLong' } })).toBe('attachments.error.tooLong')
    expect(attachmentInspectionErrorKey({ kind: 'video', details: { kind: 'missingVideoStream' } })).toBe('attachments.error.missingVideoStream')
    expect(attachmentInspectionErrorKey({ kind: 'video', details: { kind: 'unsupportedContainer' } })).toBe('attachments.error.unsupportedContainer')
    expect(attachmentInspectionErrorKey({ kind: 'video', details: { kind: 'unsupportedCodec' } })).toBe('attachments.error.unsupportedCodec')
    expect(attachmentInspectionErrorKey({ kind: 'video', details: { kind: 'protectedOrUnreadable' } })).toBe('attachments.error.protectedOrUnreadable')
    expect(attachmentInspectionErrorKey({ kind: 'video', details: { kind: 'probeFailed' } })).toBe('attachments.error.probeFailed')
  })

  it('handles not-a-file, JSON strings, and unknown values safely', () => {
    expect(attachmentInspectionErrorKey({ kind: 'notAFile' })).toBe('attachments.error.notAFile')
    expect(attachmentInspectionErrorKey('{"kind":"video","details":{"kind":"tooLong"}}')).toBe('attachments.error.tooLong')
    expect(attachmentInspectionErrorKey('{not json}')).toBe('attachments.error.generic')
    expect(attachmentInspectionErrorKey({ kind: 'video', details: { kind: 'newFailure' } })).toBe('attachments.error.generic')
    expect(attachmentInspectionErrorKey(undefined)).toBe('attachments.error.generic')
  })
})

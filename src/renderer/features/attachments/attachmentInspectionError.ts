const videoErrorKeys = new Set([
  'tooLarge',
  'tooLong',
  'missingVideoStream',
  'unsupportedContainer',
  'unsupportedCodec',
  'protectedOrUnreadable',
  'probeFailed',
])

export function attachmentInspectionErrorKey(error: unknown): string {
  const decoded = decodeInspectionError(error)
  if (decoded?.kind === 'notAFile') return 'attachments.error.notAFile'
  if (decoded?.kind === 'video' && videoErrorKeys.has(decoded.details?.kind ?? '')) {
    return `attachments.error.${decoded.details!.kind}`
  }
  return 'attachments.error.generic'
}

type InspectionError = {
  kind: string
  details?: { kind?: string }
}

function decodeInspectionError(error: unknown): InspectionError | undefined {
  const value = typeof error === 'string' ? parseJson(error) : error
  if (!isRecord(value) || typeof value.kind !== 'string') return undefined
  const details = isRecord(value.details) && typeof value.details.kind === 'string'
    ? { kind: value.details.kind }
    : undefined
  return { kind: value.kind, details }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

import type { AttachmentMeta } from '../../../shared/types'
import { invoke } from '@tauri-apps/api/core'

export type AnnotationCandidate = {
  type: 'annotation-candidate'
  token: string
  kind: 'pen' | 'element'
  url: string
  selector?: string
  component?: string | null
  rect: { x: number; y: number; width: number; height: number }
  viewport: { width: number; height: number }
}

export type BrowserAnnotationIdentity = {
  tabId: string
  generation: number
  url: string
}

export type PageReadyMessage = {
  type: 'page-ready'
  url: string
  title?: string
  historyLength: number
}

export type PageLoadedMessage = {
  type: 'page-loaded'
  url: string
}

export type AnnotationSubmitMessage = {
  type: 'annotation-submit'
  token: string
  note?: string | null
}

export type AnnotationCancelMessage = {
  type: 'annotation-cancel'
  token: string
}

export type BrowserPageMessage = PageReadyMessage | PageLoadedMessage | AnnotationCandidate | AnnotationSubmitMessage | AnnotationCancelMessage

export type AnnotationCaptureReport = {
  cropPath: string
  viewportPath: string
  cropWidth: number
  cropHeight: number
  viewportWidth: number
  viewportHeight: number
  cropBytes: number
  viewportBytes: number
}

export function isVisualAttachment(attachment: Pick<AttachmentMeta, 'kind'>): boolean {
  return attachment.kind === 'image' || attachment.kind === 'browser-annotation'
}

export function browserAnnotationLocationLabel(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    if (url.hostname) return url.hostname
    const lastPathSegment = url.pathname.split('/').filter(Boolean).at(-1)
    return lastPathSegment ? decodeURIComponent(lastPathSegment) : rawUrl
  } catch {
    return rawUrl
  }
}

export function parseBrowserPageMessage(raw: string): BrowserPageMessage | null {
  if (raw.length > 64 * 1024) return null
  try {
    const value = JSON.parse(raw) as unknown
    if (!isRecord(value) || typeof value.type !== 'string') return null
    if (value.type === 'page-ready') {
      if (!isBrowserPageUrl(value.url) || !isIntegerInRange(value.historyLength, 1, 100_000)) return null
      if (value.title !== undefined && !isBoundedString(value.title, 512, true)) return null
      return {
        type: 'page-ready',
        url: value.url,
        historyLength: value.historyLength,
        ...(typeof value.title === 'string' ? { title: value.title } : {}),
      }
    }
    if (value.type === 'page-loaded') {
      if (!isBrowserPageUrl(value.url)) return null
      return { type: 'page-loaded', url: value.url }
    }
    if (value.type === 'annotation-submit') {
      if (!isBoundedString(value.token, 128) || (value.note !== undefined && value.note !== null && !isBoundedString(value.note, 4_000, true))) return null
      return {
        type: 'annotation-submit', token: value.token,
        ...(typeof value.note === 'string' ? { note: value.note } : {}),
      }
    }
    if (value.type === 'annotation-cancel') {
      if (!isBoundedString(value.token, 128)) return null
      return { type: 'annotation-cancel', token: value.token }
    }
    if (
      value.type === 'annotation-candidate'
      && isBoundedString(value.token, 128)
      && isBrowserPageUrl(value.url)
      && (value.kind === 'pen' || value.kind === 'element')
      && isRecord(value.rect)
      && isRecord(value.viewport)
      && isViewport(value.viewport)
      && isAnnotationRect(value.rect, value.viewport)
      && (value.selector === undefined || isBoundedString(value.selector, 1_000, true))
      && (value.component === undefined || value.component === null || isBoundedString(value.component, 512, true))
    ) {
      return {
        type: 'annotation-candidate',
        token: value.token,
        kind: value.kind,
        url: value.url,
        rect: value.rect as AnnotationCandidate['rect'],
        viewport: value.viewport as AnnotationCandidate['viewport'],
        ...(typeof value.selector === 'string' ? { selector: value.selector } : {}),
        ...(typeof value.component === 'string' ? { component: value.component } : {}),
      }
    }
    return null
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isBoundedString(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= maxLength && (allowEmpty || value.length > 0)
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

function isFiniteInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

function isBrowserPageUrl(value: unknown): value is string {
  if (!isBoundedString(value, 8_192)) return false
  try {
    const url = new URL(value)
    return ['http:', 'https:', 'about:', 'file:'].includes(url.protocol)
  } catch {
    return false
  }
}

function isViewport(value: Record<string, unknown>): value is AnnotationCandidate['viewport'] {
  return isFiniteInRange(value.width, 1, 100_000) && isFiniteInRange(value.height, 1, 100_000)
}

function isAnnotationRect(
  value: Record<string, unknown>,
  viewport: AnnotationCandidate['viewport'],
): value is AnnotationCandidate['rect'] {
  return isFiniteInRange(value.x, 0, viewport.width)
    && isFiniteInRange(value.y, 0, viewport.height)
    && isFiniteInRange(value.width, 1, viewport.width)
    && isFiniteInRange(value.height, 1, viewport.height)
}

export function deleteBrowserTempFiles(paths: Array<string | undefined>): Promise<void> {
  const uniquePaths = [...new Set(paths.filter((path): path is string => Boolean(path)))]
  if (!uniquePaths.length) return Promise.resolve()
  return invoke('browser_delete_temp_files', { paths: uniquePaths }).then(() => undefined)
}

export function deleteBrowserCapture(capture: AnnotationCaptureReport): Promise<void> {
  return deleteBrowserTempFiles([capture.cropPath, capture.viewportPath])
}

type PromotedBrowserFile = { from: string; to: string }

export async function promoteBrowserAttachments(
  attachments: AttachmentMeta[],
  ownerId: string,
): Promise<AttachmentMeta[]> {
  const paths = [...new Set(attachments.flatMap(attachment => {
    if (attachment.kind !== 'browser-annotation') return []
    return [attachment.path, attachment.browserAnnotation?.viewportSnapshot?.path]
      .filter((path): path is string => typeof path === 'string' && path.replaceAll('\\', '/').includes('/verboo-browser/'))
  }))]
  if (!paths.length) return attachments
  const promoted = await invoke<PromotedBrowserFile[]>('browser_promote_temp_files', { ownerId, paths })
  const pathMap = new Map(promoted.map(file => [file.from, file.to]))
  return attachments.map(attachment => {
    const annotation = attachment.browserAnnotation
    if (attachment.kind !== 'browser-annotation' || !annotation) return attachment
    const path = pathMap.get(attachment.path) ?? attachment.path
    const viewportSnapshot = annotation.viewportSnapshot
      ? { ...annotation.viewportSnapshot, path: pathMap.get(annotation.viewportSnapshot.path) ?? annotation.viewportSnapshot.path }
      : undefined
    return {
      ...attachment,
      path,
      browserAnnotation: { ...annotation, crop: path, viewportSnapshot },
    }
  })
}

export function deleteBrowserCaptureOwner(ownerId: string): Promise<void> {
  return invoke('browser_delete_capture_owner', { ownerId }).then(() => undefined)
}

export function cleanupBrowserCaptureOwners(activeOwnerIds: string[]): Promise<void> {
  return invoke('browser_cleanup_capture_owners', { activeOwnerIds }).then(() => undefined)
}

/**
 * Returns false when the capture is no longer relevant because the
 * originating tab has changed (navigated, closed, or its generation advanced).
 * Silently discarding stale results avoids attaching outdated captures.
 */
export function annotationStillCurrent(
  identity: BrowserAnnotationIdentity,
  current: { id: string; generation: number },
): boolean {
  return identity.tabId === current.id && identity.generation === current.generation
}

export function createAnnotationAttachment(
  candidate: AnnotationCandidate,
  note: string | null | undefined,
  capture: AnnotationCaptureReport,
): AttachmentMeta {
  const detail = [
    `Browser annotation (${candidate.kind}) at ${candidate.url}.`,
    candidate.component ? `Component: ${candidate.component}.` : '',
    candidate.selector ? `Selector: ${candidate.selector}.` : '',
    note ? `User note (authoritative instruction): ${note}` : 'No written note was provided.',
    candidate.kind === 'element' && candidate.selector
      ? `Apply the requested change only to the selected element matched by selector ${candidate.selector}, unless the user note explicitly requests a broader scope. If styles are shared, use a selector-specific rule or local markup instead of changing sibling instances.`
      : '',
    'Treat the written instruction and selector as authoritative. Use the attached crop and full viewport only as supporting visual context.',
  ].filter(Boolean).join('\n')

  return {
    path: capture.cropPath,
    name: candidate.kind === 'element' ? 'browser-element.png' : 'browser-annotation.png',
    size: capture.cropBytes,
    kind: 'browser-annotation',
    mediaType: 'image/png',
    width: capture.cropWidth,
    height: capture.cropHeight,
    extractedText: detail,
    extractionStatus: 'extracted',
    browserAnnotation: {
      kind: candidate.kind,
      crop: capture.cropPath,
      note: note || undefined,
      url: candidate.url,
      selector: candidate.selector,
      component: candidate.component || undefined,
      rect: candidate.rect,
      viewport: candidate.viewport,
      viewportSnapshot: {
        path: capture.viewportPath,
        width: capture.viewportWidth,
        height: capture.viewportHeight,
        size: capture.viewportBytes,
      },
    },
  }
}

export function expandBrowserAnnotationSnapshots(attachments: AttachmentMeta[]): AttachmentMeta[] {
  return attachments.flatMap(attachment => {
    const annotation = attachment.browserAnnotation
    const snapshot = annotation?.viewportSnapshot
    if (attachment.kind !== 'browser-annotation' || !annotation || !snapshot) return [attachment]
    return [attachment, {
      path: snapshot.path,
      name: 'browser-viewport.png',
      size: snapshot.size,
      kind: 'image',
      mediaType: 'image/png',
      width: snapshot.width,
      height: snapshot.height,
      extractedText: `Full browser viewport for the annotation at ${annotation.url}.`,
      extractionStatus: 'extracted',
    }]
  })
}

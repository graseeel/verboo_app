import { invoke } from '@tauri-apps/api/core'
import type { AttachmentMeta } from '../../../shared/types'
import {
  deleteBrowserCaptureOwner,
  deleteBrowserTempFiles,
  expandBrowserAnnotationSnapshots,
  promoteBrowserAttachments,
} from '../browser/browserAnnotations'
import {
  expandSimulatorAnnotationSnapshots,
  isAndroidSimulatorTempPath,
  isIosSimulatorTempPath,
  isSimulatorTempPath,
  promoteSimulatorAttachments,
} from '../simulator/simulatorAnnotations'
import { androidEmulatorApi } from '../simulator/androidEmulatorApi'

export function isVisualAttachment(attachment: Pick<AttachmentMeta, 'kind'>): boolean {
  return attachment.kind === 'image'
    || attachment.kind === 'browser-annotation'
    || attachment.kind === 'simulator-annotation'
}

export function isVisualAnnotation(attachment: Pick<AttachmentMeta, 'kind'>): boolean {
  return attachment.kind === 'browser-annotation' || attachment.kind === 'simulator-annotation'
}

export function expandVisualAttachmentSnapshots(attachments: AttachmentMeta[]): AttachmentMeta[] {
  return expandSimulatorAnnotationSnapshots(expandBrowserAnnotationSnapshots(attachments))
}

export async function promoteVisualAttachments(
  attachments: AttachmentMeta[],
  ownerId: string,
): Promise<AttachmentMeta[]> {
  return promoteSimulatorAttachments(
    await promoteBrowserAttachments(attachments, ownerId),
    ownerId,
  )
}

export function visualTempPaths(attachments: AttachmentMeta[]): string[] {
  return [...new Set(attachments.flatMap(attachment => [
    attachment.path,
    attachment.browserAnnotation?.viewportSnapshot?.path,
    attachment.simulatorAnnotation?.viewportSnapshot.path,
  ]).filter((path): path is string => (
    typeof path === 'string' && (isBrowserTempPath(path) || isSimulatorTempPath(path))
  )))]
}

export async function deleteVisualTempFiles(paths: Array<string | undefined>): Promise<void> {
  const unique = [...new Set(paths.filter((path): path is string => Boolean(path)))]
  const browser = unique.filter(isBrowserTempPath)
  const iosSimulator = unique.filter(isIosSimulatorTempPath)
  const androidSimulator = unique.filter(isAndroidSimulatorTempPath)
  await Promise.all([
    deleteBrowserTempFiles(browser),
    iosSimulator.length
      ? invoke('ios_simulator_delete_temp_files', { paths: iosSimulator }).then(() => undefined)
      : Promise.resolve(),
    androidSimulator.length
      ? androidEmulatorApi.captureDelete(androidSimulator)
      : Promise.resolve(),
  ])
}

export async function deleteVisualCaptureOwner(ownerId: string): Promise<void> {
  await Promise.all([
    deleteBrowserCaptureOwner(ownerId),
    invoke('ios_simulator_delete_capture_owner', { ownerId }),
  ])
}

export async function cleanupVisualCaptureOwners(activeOwnerIds: string[]): Promise<void> {
  await Promise.all([
    invoke('browser_cleanup_capture_owners', { activeOwnerIds }),
    invoke('ios_simulator_cleanup_capture_owners', { activeOwnerIds }),
    androidEmulatorApi.captureCleanup(activeOwnerIds),
  ])
}

function isBrowserTempPath(path: string): boolean {
  return path.replaceAll('\\', '/').includes('/verboo-browser/')
}

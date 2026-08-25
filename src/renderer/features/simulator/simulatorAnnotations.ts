import { invoke } from '@tauri-apps/api/core'
import type { AttachmentMeta } from '../../../shared/types'
import { androidEmulatorApi } from './androidEmulatorApi'
import type { IosSimulatorAnnotationCapture } from './iosSimulatorApi'

type SimulatorAnnotationKind = 'element' | 'area'
type PromotedSimulatorFile = { from: string; to: string }
export type SimulatorAnnotationContext = {
  platform: 'iOS' | 'Android'
  version: string
  selectionImage?: 'crop' | 'viewport'
}

export function createSimulatorAnnotationAttachment(
  kind: SimulatorAnnotationKind,
  note: string | null | undefined,
  capture: IosSimulatorAnnotationCapture,
  context: SimulatorAnnotationContext = {
    platform: 'iOS',
    version: capture.device.iosVersion,
  },
): AttachmentMeta {
  const element = capture.element
    ? {
        id: capture.element.id,
        role: capture.element.role,
        ...(capture.element.label ? { label: capture.element.label } : {}),
      }
    : undefined
  const selected = element
    ? `Selected component: ${element.role}${element.label ? ` “${element.label}”` : ''}.`
    : 'Selected area of the simulator viewport.'
  const detail = [
    `Simulator annotation (${kind}) on ${capture.device.name}, ${context.platform} ${context.version}, ${capture.orientation}.`,
    selected,
    note
      ? `User note (authoritative instruction): ${note}.`
      : 'No written note was provided.',
    context.selectionImage === 'viewport'
      ? 'Treat the written instruction and selected simulator component as authoritative. Use the selected rect metadata and full simulator viewport only as supporting visual context.'
      : 'Treat the written instruction and selected simulator component as authoritative. Use the crop and full simulator viewport only as supporting visual context.',
  ].join('\n')

  return {
    path: capture.cropPath,
    name: kind === 'element' ? 'simulator-element.png' : 'simulator-area.png',
    size: capture.cropBytes,
    kind: 'simulator-annotation',
    mediaType: 'image/png',
    width: capture.cropWidth,
    height: capture.cropHeight,
    extractedText: detail,
    extractionStatus: 'extracted',
    simulatorAnnotation: {
      kind,
      crop: capture.cropPath,
      note: note || undefined,
      device: {
        name: capture.device.name,
        udid: capture.device.udid,
        iosVersion: capture.device.iosVersion,
        orientation: capture.orientation,
      },
      deviceGeneration: capture.deviceGeneration,
      frameGeneration: capture.frameGeneration,
      rect: capture.rect,
      deviceRect: capture.deviceRect,
      element,
      viewportSnapshot: {
        path: capture.viewportPath,
        width: capture.viewportWidth,
        height: capture.viewportHeight,
        size: capture.viewportBytes,
      },
    },
  }
}

export function expandSimulatorAnnotationSnapshots(attachments: AttachmentMeta[]): AttachmentMeta[] {
  return attachments.flatMap(attachment => {
    const annotation = attachment.simulatorAnnotation
    const snapshot = annotation?.viewportSnapshot
    if (attachment.kind !== 'simulator-annotation' || !annotation || !snapshot) return [attachment]
    if (snapshot.path === attachment.path) return [attachment]
    return [attachment, {
      path: snapshot.path,
      name: 'simulator-viewport.png',
      size: snapshot.size,
      kind: 'image',
      mediaType: 'image/png',
      width: snapshot.width,
      height: snapshot.height,
      extractedText: `Full ${annotation.device.name} simulator viewport supporting the selected ${annotation.kind}.`,
      extractionStatus: 'extracted',
    }]
  })
}

export async function promoteSimulatorAttachments(
  attachments: AttachmentMeta[],
  ownerId: string,
): Promise<AttachmentMeta[]> {
  const paths = [...new Set(attachments.flatMap(attachment => {
    if (attachment.kind !== 'simulator-annotation') return []
    return [attachment.path, attachment.simulatorAnnotation?.viewportSnapshot.path]
      .filter((path): path is string => typeof path === 'string' && isSimulatorTempPath(path))
  }))]
  if (!paths.length) return attachments
  const iosPaths = paths.filter(isIosSimulatorTempPath)
  const androidPaths = paths.filter(isAndroidSimulatorTempPath)
  const [iosPromoted, androidPromoted] = await Promise.all([
    iosPaths.length
      ? invoke<PromotedSimulatorFile[]>('ios_simulator_promote_temp_files', {
          ownerId,
          paths: iosPaths,
        })
      : Promise.resolve([]),
    androidPaths.length
      ? androidEmulatorApi.capturePromote(ownerId, androidPaths)
      : Promise.resolve([]),
  ])
  const promoted = [...iosPromoted, ...androidPromoted]
  const pathMap = new Map(promoted.map(file => [file.from, file.to]))
  return attachments.map(attachment => {
    const annotation = attachment.simulatorAnnotation
    if (attachment.kind !== 'simulator-annotation' || !annotation) return attachment
    const path = pathMap.get(attachment.path) ?? attachment.path
    return {
      ...attachment,
      path,
      simulatorAnnotation: {
        ...annotation,
        crop: path,
        viewportSnapshot: {
          ...annotation.viewportSnapshot,
          path: pathMap.get(annotation.viewportSnapshot.path) ?? annotation.viewportSnapshot.path,
        },
      },
    }
  })
}

export function isSimulatorTempPath(path: string): boolean {
  return isIosSimulatorTempPath(path) || isAndroidSimulatorTempPath(path)
}

export function isIosSimulatorTempPath(path: string): boolean {
  return path.replaceAll('\\', '/').includes('/verboo-ios-simulator/')
}

export function isAndroidSimulatorTempPath(path: string): boolean {
  return path.replaceAll('\\', '/').includes('/verboo-android-emulator/')
}

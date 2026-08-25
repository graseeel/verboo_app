import { invoke } from '@tauri-apps/api/core'
import { describe, expect, it, vi } from 'vitest'
import {
  createSimulatorAnnotationAttachment,
  expandSimulatorAnnotationSnapshots,
  promoteSimulatorAttachments,
} from './simulatorAnnotations'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

const capture = {
  cropPath: '/tmp/verboo-ios-simulator/one-crop.png',
  viewportPath: '/tmp/verboo-ios-simulator/one-viewport.png',
  cropWidth: 180,
  cropHeight: 80,
  viewportWidth: 393,
  viewportHeight: 852,
  cropBytes: 1200,
  viewportBytes: 9000,
  device: { name: 'iPhone 17 Pro', udid: 'phone-17-pro', state: 'Booted', iosVersion: '26.5', family: 'iphone' as const },
  orientation: 'portrait' as const,
  deviceGeneration: 4,
  frameGeneration: 92,
  rect: { x: 0.2, y: 0.3, width: 0.4, height: 0.1 },
  deviceRect: { x: 78.6, y: 255.6, width: 157.2, height: 85.2 },
  element: {
    id: 'save-button', role: 'Button', label: 'Save', value: null,
    frame: { x: 78.6, y: 255.6, width: 157.2, height: 85.2 },
    enabled: true, visible: true, actionable: true,
  },
}

describe('simulator annotations', () => {
  it('builds simulator-only structured context without browser selectors or URLs', () => {
    const attachment = createSimulatorAnnotationAttachment('element', 'Increase the spacing', capture)

    expect(attachment).toMatchObject({
      kind: 'simulator-annotation',
      path: capture.cropPath,
      simulatorAnnotation: {
        kind: 'element',
        element: { id: 'save-button', role: 'Button', label: 'Save' },
      },
    })
    expect(attachment.extractedText).toBe([
      'Simulator annotation (element) on iPhone 17 Pro, iOS 26.5, portrait.',
      'Selected component: Button “Save”.',
      'User note (authoritative instruction): Increase the spacing.',
      'Treat the written instruction and selected simulator component as authoritative. Use the crop and full simulator viewport only as supporting visual context.',
    ].join('\n'))
    expect(attachment.extractedText).not.toMatch(/https?:|selector/i)
  })

  it('parameterizes the platform/version label for an Android annotation', () => {
    const attachment = createSimulatorAnnotationAttachment(
      'area',
      undefined,
      {
        ...capture,
        viewportPath: capture.cropPath,
        device: { ...capture.device, name: 'Pixel 8', udid: 'Pixel_8_API_35', iosVersion: 'API 35' },
      },
      { platform: 'Android', version: 'API 35', selectionImage: 'viewport' },
    )

    expect(attachment.extractedText).toContain(
      'Simulator annotation (area) on Pixel 8, Android API 35, portrait.',
    )
    expect(attachment.extractedText).not.toContain('iOS API 35')
    expect(attachment.extractedText).toContain('selected rect metadata and full simulator viewport')
    expect(attachment.extractedText).not.toContain('Use the crop')
    expect(expandSimulatorAnnotationSnapshots([attachment])).toEqual([attachment])
  })

  it('expands the full viewport and promotes both simulator paths', async () => {
    const attachment = createSimulatorAnnotationAttachment('element', undefined, capture)
    expect(expandSimulatorAnnotationSnapshots([attachment])).toMatchObject([
      { kind: 'simulator-annotation', path: capture.cropPath },
      { kind: 'image', path: capture.viewportPath, name: 'simulator-viewport.png' },
    ])
    vi.mocked(invoke).mockResolvedValueOnce([
      { from: capture.cropPath, to: '/app/simulator_captures/crop.png' },
      { from: capture.viewportPath, to: '/app/simulator_captures/viewport.png' },
    ])

    const [promoted] = await promoteSimulatorAttachments([attachment], 'conversation-1')

    expect(invoke).toHaveBeenCalledWith('ios_simulator_promote_temp_files', {
      ownerId: 'conversation-1',
      paths: [capture.cropPath, capture.viewportPath],
    })
    expect(promoted).toMatchObject({
      path: '/app/simulator_captures/crop.png',
      simulatorAnnotation: {
        crop: '/app/simulator_captures/crop.png',
        viewportSnapshot: { path: '/app/simulator_captures/viewport.png' },
      },
    })
  })

  it('promotes Android annotation paths through the Android capture owner store', async () => {
    const androidCapture = {
      ...capture,
      cropPath: '/tmp/verboo-android-emulator/one-crop.png',
      viewportPath: '/tmp/verboo-android-emulator/one-viewport.png',
      device: {
        ...capture.device,
        name: 'Pixel 8',
        udid: 'Pixel_8_API_35',
        iosVersion: 'API 35',
      },
    }
    const attachment = createSimulatorAnnotationAttachment(
      'element',
      undefined,
      androidCapture,
      { platform: 'Android', version: 'API 35', selectionImage: 'viewport' },
    )
    vi.mocked(invoke).mockResolvedValueOnce([
      { from: androidCapture.cropPath, to: '/app/android_captures/crop.png' },
      { from: androidCapture.viewportPath, to: '/app/android_captures/viewport.png' },
    ])

    const [promoted] = await promoteSimulatorAttachments([attachment], 'conversation-android')

    expect(invoke).toHaveBeenCalledWith('android_emulator_capture_promote', {
      ownerId: 'conversation-android',
      paths: [androidCapture.cropPath, androidCapture.viewportPath],
    })
    expect(promoted).toMatchObject({
      path: '/app/android_captures/crop.png',
      simulatorAnnotation: {
        crop: '/app/android_captures/crop.png',
        viewportSnapshot: { path: '/app/android_captures/viewport.png' },
      },
    })
  })
})

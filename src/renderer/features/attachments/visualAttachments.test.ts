import { invoke } from '@tauri-apps/api/core'
import { describe, expect, it, vi } from 'vitest'
import type { AttachmentMeta } from '../../../shared/types'
import {
  deleteVisualTempFiles,
  expandVisualAttachmentSnapshots,
  isVisualAttachment,
} from './visualAttachments'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }))

describe('visual attachment dispatch', () => {
  it('classifies and expands simulator annotations beside browser annotations', () => {
    const simulator = {
      path: '/tmp/verboo-ios-simulator/a-crop.png', name: 'simulator-element.png', size: 1,
      kind: 'simulator-annotation', mediaType: 'image/png',
      simulatorAnnotation: {
        kind: 'area', crop: '/tmp/verboo-ios-simulator/a-crop.png',
        device: { name: 'iPhone', udid: '1', iosVersion: '26.5', orientation: 'portrait' },
        deviceGeneration: 1, frameGeneration: 2,
        rect: { x: 0, y: 0, width: 1, height: 1 },
        deviceRect: { x: 0, y: 0, width: 393, height: 852 },
        viewportSnapshot: { path: '/tmp/verboo-ios-simulator/a-viewport.png', width: 393, height: 852, size: 2 },
      },
    } satisfies AttachmentMeta

    expect(isVisualAttachment(simulator)).toBe(true)
    expect(expandVisualAttachmentSnapshots([simulator])).toHaveLength(2)
  })

  it('partitions browser and simulator temp deletion into separate allowlists', async () => {
    await deleteVisualTempFiles([
      '/tmp/verboo-browser/a.png',
      '/tmp/verboo-ios-simulator/b.png',
      '/documents/leave-me-alone.png',
    ])

    expect(invoke).toHaveBeenCalledWith('browser_delete_temp_files', {
      paths: ['/tmp/verboo-browser/a.png'],
    })
    expect(invoke).toHaveBeenCalledWith('ios_simulator_delete_temp_files', {
      paths: ['/tmp/verboo-ios-simulator/b.png'],
    })
  })
})

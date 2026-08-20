import { describe, expect, it } from 'vitest'
import type { IosSimulatorAccessibilityNode } from './iosSimulatorApi'
import {
  accessibilityNodeAtPoint,
  normalizedAccessibilityRect,
  type SimulatorAccessibilityNode,
} from './simulatorSelection'

const nodes: SimulatorAccessibilityNode[] = [
  {
    id: 'root', role: 'Application', frame: { x: 0, y: 0, width: 393, height: 852 },
    enabled: true, visible: true, actionable: false,
  },
  {
    id: 'card', role: 'Other', frame: { x: 40, y: 100, width: 300, height: 300 },
    enabled: true, visible: true, actionable: true,
  },
  {
    id: 'save', role: 'Button', label: 'Save', frame: { x: 120, y: 180, width: 100, height: 48 },
    enabled: true, visible: true, actionable: true,
  },
]

describe('simulator element selection', () => {
  it('keeps the iOS public type as a re-export of the platform-neutral node', () => {
    const iosNodes: IosSimulatorAccessibilityNode[] = nodes
    expect(iosNodes).toBe(nodes)
  })

  it('chooses the smallest visible actionable component under the point', () => {
    expect(accessibilityNodeAtPoint(nodes, { x: 0.4, y: 0.24 })?.id).toBe('save')
  })

  it('normalizes the selected device frame against the full accessibility root', () => {
    expect(normalizedAccessibilityRect(nodes, nodes[2])).toEqual({
      x: 120 / 393,
      y: 180 / 852,
      width: 100 / 393,
      height: 48 / 852,
    })
  })
})

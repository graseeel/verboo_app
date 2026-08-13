import type {
  IosSimulatorAccessibilityNode,
  IosSimulatorPoint,
  IosSimulatorRect,
} from './iosSimulatorApi'

type DeviceSize = { width: number; height: number }

export function accessibilityDeviceSize(
  nodes: readonly IosSimulatorAccessibilityNode[],
): DeviceSize | null {
  const width = Math.max(0, ...nodes.filter(node => node.visible).map(node => node.frame.x + node.frame.width))
  const height = Math.max(0, ...nodes.filter(node => node.visible).map(node => node.frame.y + node.frame.height))
  return width > 0 && height > 0 ? { width, height } : null
}

export function normalizedAccessibilityRect(
  nodes: readonly IosSimulatorAccessibilityNode[],
  node: IosSimulatorAccessibilityNode,
): IosSimulatorRect | null {
  const device = accessibilityDeviceSize(nodes)
  if (!device) return null
  return {
    x: clampUnit(node.frame.x / device.width),
    y: clampUnit(node.frame.y / device.height),
    width: clampUnit(node.frame.width / device.width),
    height: clampUnit(node.frame.height / device.height),
  }
}

export function accessibilityNodeAtPoint(
  nodes: readonly IosSimulatorAccessibilityNode[],
  point: IosSimulatorPoint,
): IosSimulatorAccessibilityNode | undefined {
  const device = accessibilityDeviceSize(nodes)
  if (!device) return undefined
  const x = clampUnit(point.x) * device.width
  const y = clampUnit(point.y) * device.height
  return nodes
    .filter(node => node.visible && node.enabled && node.actionable)
    .filter(node => (
      x >= node.frame.x
      && y >= node.frame.y
      && x <= node.frame.x + node.frame.width
      && y <= node.frame.y + node.frame.height
    ))
    .sort((left, right) => (
      left.frame.width * left.frame.height - right.frame.width * right.frame.height
    ))[0]
}

function clampUnit(value: number) {
  return Math.min(1, Math.max(0, value))
}

export type SimulatorPoint = { x: number; y: number }
export type SimulatorRect = { x: number; y: number; width: number; height: number }
export type SimulatorAccessibilityNode = {
  id: string
  role: string
  label?: string | null
  value?: string | null
  frame: SimulatorRect
  enabled: boolean
  visible: boolean
  actionable: boolean
}
export type SimulatorElementHit = {
  element: SimulatorAccessibilityNode
  rect: SimulatorRect
}

type DeviceSize = { width: number; height: number }

export function accessibilityDeviceSize(
  nodes: readonly SimulatorAccessibilityNode[],
): DeviceSize | null {
  const width = Math.max(0, ...nodes.filter(node => node.visible).map(node => node.frame.x + node.frame.width))
  const height = Math.max(0, ...nodes.filter(node => node.visible).map(node => node.frame.y + node.frame.height))
  return width > 0 && height > 0 ? { width, height } : null
}

export function normalizedAccessibilityRect(
  nodes: readonly SimulatorAccessibilityNode[],
  node: SimulatorAccessibilityNode,
): SimulatorRect | null {
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
  nodes: readonly SimulatorAccessibilityNode[],
  point: SimulatorPoint,
): SimulatorAccessibilityNode | undefined {
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

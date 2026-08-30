export type Size = { width: number; height: number }
export type Rect = { x: number; y: number; width: number; height: number }
export type NormalizedPoint = { x: number; y: number }
export type DevicePoint = { x: number; y: number }
export type CssRect = { left: number; top: number; width: number; height: number }

function finite(...values: number[]) {
  return values.every(Number.isFinite)
}

function clampUnit(value: number) {
  return Math.min(1, Math.max(0, value))
}

export function paintedContainRect(container: Size, image: Size): Rect {
  if (
    !finite(container.width, container.height, image.width, image.height)
    || container.width <= 0
    || container.height <= 0
    || image.width <= 0
    || image.height <= 0
  ) {
    return { x: 0, y: 0, width: 0, height: 0 }
  }
  const scale = Math.min(container.width / image.width, container.height / image.height)
  const width = image.width * scale
  const height = image.height * scale
  return {
    x: (container.width - width) / 2,
    y: (container.height - height) / 2,
    width,
    height,
  }
}

export function clientPointToNormalized(
  point: { x: number; y: number },
  painted: Rect,
): NormalizedPoint | null {
  if (
    !finite(point.x, point.y, painted.x, painted.y, painted.width, painted.height)
    || painted.width <= 0
    || painted.height <= 0
    || point.x < painted.x
    || point.y < painted.y
    || point.x > painted.x + painted.width
    || point.y > painted.y + painted.height
  ) {
    return null
  }
  return {
    x: clampUnit((point.x - painted.x) / painted.width),
    y: clampUnit((point.y - painted.y) / painted.height),
  }
}

/** Maps a client point on the surface element to device-normalized
 *  coordinates against the EXPLICIT media size (canvas mode: VAF1 header
 *  dims; img mode: naturalWidth/Height resolved by the caller). Shared by
 *  useSimulatorInteraction and SimulatorSurface so interact/selection modes
 *  hit-test identically in both render paths. */
export function pointToNormalizedOnSurface(
  surface: HTMLElement,
  size: Size,
  clientX: number,
  clientY: number,
): NormalizedPoint | null {
  if (size.width <= 0 || size.height <= 0) return null
  const bounds = surface.getBoundingClientRect()
  const painted = paintedContainRect(
    { width: bounds.width, height: bounds.height },
    size,
  )
  return clientPointToNormalized(
    { x: clientX - bounds.left, y: clientY - bounds.top },
    painted,
  )
}

export function normalizedPointToDevice(point: NormalizedPoint, device: Size): DevicePoint | null {
  if (
    !finite(point.x, point.y, device.width, device.height)
    || device.width <= 0
    || device.height <= 0
  ) return null
  return {
    x: clampUnit(point.x) * device.width,
    y: clampUnit(point.y) * device.height,
  }
}

export function normalizedRectToCss(rect: Rect, painted: Rect): CssRect {
  if (
    !finite(
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      painted.x,
      painted.y,
      painted.width,
      painted.height,
    )
    || painted.width <= 0
    || painted.height <= 0
  ) {
    return { left: painted.x || 0, top: painted.y || 0, width: 0, height: 0 }
  }
  const x1 = clampUnit(Math.min(rect.x, rect.x + rect.width))
  const y1 = clampUnit(Math.min(rect.y, rect.y + rect.height))
  const x2 = clampUnit(Math.max(rect.x, rect.x + rect.width))
  const y2 = clampUnit(Math.max(rect.y, rect.y + rect.height))
  return {
    left: painted.x + x1 * painted.width,
    top: painted.y + y1 * painted.height,
    width: (x2 - x1) * painted.width,
    height: (y2 - y1) * painted.height,
  }
}

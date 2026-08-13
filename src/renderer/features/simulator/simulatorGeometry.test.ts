import { describe, expect, it } from 'vitest'
import {
  clientPointToNormalized,
  normalizedPointToDevice,
  normalizedRectToCss,
  paintedContainRect,
} from './simulatorGeometry'

describe('simulator geometry', () => {
  it.each([
    [
      { width: 600, height: 600 },
      { width: 393, height: 852 },
      { x: 161.62, y: 0, width: 276.76, height: 600 },
    ],
    [
      { width: 600, height: 400 },
      { width: 852, height: 393 },
      { x: 0, y: 61.62, width: 600, height: 276.76 },
    ],
    [
      { width: 800, height: 600 },
      { width: 1024, height: 1366 },
      { x: 175.11, y: 0, width: 449.78, height: 600 },
    ],
  ])('computes the object-fit contain rectangle', (container, image, expected) => {
    const result = paintedContainRect(container, image)
    expect(result.x).toBeCloseTo(expected.x, 1)
    expect(result.y).toBeCloseTo(expected.y, 1)
    expect(result.width).toBeCloseTo(expected.width, 1)
    expect(result.height).toBeCloseTo(expected.height, 1)
  })

  it('rejects a click in the letterbox and normalizes a click inside the device', () => {
    const painted = { x: 100, y: 0, width: 200, height: 400 }
    expect(clientPointToNormalized({ x: 50, y: 200 }, painted)).toBeNull()
    expect(clientPointToNormalized({ x: 200, y: 100 }, painted)).toEqual({ x: 0.5, y: 0.25 })
  })

  it('maps normalized points to device pixels and clamps normalized rectangles', () => {
    expect(normalizedPointToDevice({ x: 0.5, y: 0.25 }, { width: 393, height: 852 }))
      .toEqual({ x: 196.5, y: 213 })
    expect(normalizedRectToCss(
      { x: -0.2, y: 0.25, width: 0.6, height: 1 },
      { x: 100, y: 20, width: 200, height: 400 },
    )).toEqual({ left: 100, top: 120, width: 80, height: 300 })
  })

  it('fails closed for non-finite and empty geometry', () => {
    expect(paintedContainRect({ width: 0, height: 10 }, { width: 1, height: 1 }))
      .toEqual({ x: 0, y: 0, width: 0, height: 0 })
    expect(clientPointToNormalized(
      { x: Number.NaN, y: 0 },
      { x: 0, y: 0, width: 100, height: 100 },
    )).toBeNull()
  })
})

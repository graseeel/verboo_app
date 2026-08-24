import { describe, expect, it } from 'vitest'
import {
  clientPointToNormalized,
  normalizedPointToDevice,
  normalizedRectToCss,
  paintedContainRect,
  pointToNormalizedOnSurface,
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

  it('pointToNormalizedOnSurface guards against degenerate size dims (F3)', () => {
    const surface = {
      getBoundingClientRect: () => ({
        left: 0, top: 0, width: 600, height: 900, right: 600, bottom: 900, x: 0, y: 0, toJSON: () => ({}),
      }),
    } as unknown as HTMLElement
    expect(pointToNormalizedOnSurface(surface, { width: 0, height: 1600 }, 300, 450)).toBeNull()
    expect(pointToNormalizedOnSurface(surface, { width: 720, height: 0 }, 300, 450)).toBeNull()
    expect(pointToNormalizedOnSurface(surface, { width: -720, height: 1600 }, 300, 450)).toBeNull()
    expect(pointToNormalizedOnSurface(surface, { width: 720, height: -1600 }, 300, 450)).toBeNull()
  })

  it('rotation: portrait vs landscape yield different normalized coords for the same client point (F4)', () => {
    const surface = {
      getBoundingClientRect: () => ({
        left: 0, top: 0, width: 600, height: 900, right: 600, bottom: 900, x: 0, y: 0, toJSON: () => ({}),
      }),
    } as unknown as HTMLElement

    // Portrait 720x1600 em surface 600x900: scale = min(600/720, 900/1600) = 0.5625
    // → painted 405x900 a (97.5, 0). Click (400, 500) está dentro dos DOIS painted
    // rects (portrait [97.5..502.5]x[0..900] e landscape [0..600]x[315..585]).
    // Portrait normalized: ((400-97.5)/405, 500/900) ≈ (0.7470, 0.5556).
    const portrait = pointToNormalizedOnSurface(surface, { width: 720, height: 1600 }, 400, 500)
    expect(portrait).not.toBeNull()
    expect(portrait!.x).toBeCloseTo(0.7470, 3)
    expect(portrait!.y).toBeCloseTo(0.5556, 3)

    // Landscape 1600x720 em surface 600x900: scale = min(600/1600, 900/720) = 0.375
    // → painted 600x270 a (0, 315). MESMO click (400, 500) → (400/600, (500-315)/270)
    // = (0.6667, 0.6852).
    const landscape = pointToNormalizedOnSurface(surface, { width: 1600, height: 720 }, 400, 500)
    expect(landscape).not.toBeNull()
    expect(landscape!.x).toBeCloseTo(0.6667, 3)
    expect(landscape!.y).toBeCloseTo(0.6852, 3)

    // O paintedContainRect muda com as dims → coords normalizadas para o
    // MESMO client point DEVEM diferir entre portrait e landscape.
    expect(portrait!.x).not.toBe(landscape!.x)
    expect(portrait!.y).not.toBe(landscape!.y)
  })
})

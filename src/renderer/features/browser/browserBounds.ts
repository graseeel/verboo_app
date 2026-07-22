type BrowserContentRect = Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>

type BrowserBoundsInput = {
  rect: BrowserContentRect | null
  browserWidth: number
  viewportWidth: number
}

export type BrowserBounds = {
  x: number
  y: number
  width: number
  height: number
}

const BROWSER_CHROME_TOP = 36 + 38 + 38

export function browserContentBounds({
  rect,
  browserWidth,
  viewportWidth,
}: BrowserBoundsInput): BrowserBounds {
  if (rect && rect.width > 1 && rect.height > 1) {
    return {
      x: Math.max(0, rect.left),
      y: Math.max(0, rect.top),
      width: rect.width,
      height: Math.max(200, rect.height),
    }
  }

  return {
    x: Math.max(0, viewportWidth - browserWidth),
    y: BROWSER_CHROME_TOP,
    width: browserWidth,
    height: 600,
  }
}

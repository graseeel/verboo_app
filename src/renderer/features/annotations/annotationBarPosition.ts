/**
 * Posição da barra flutuante de anotação — função pura, testável sem DOM.
 *
 * A barra prefere ficar ACIMA da seleção, centralizada nela, e cai para
 * BAIXO quando não cabe acima ou quando colidiria com um obstáculo. Os
 * obstáculos são os outros elementos flutuantes do app medidos NO MOMENTO
 * (o cartão do checklist no canto superior direito e o painel do goal junto
 * ao composer) — o app já corrigiu uma sobreposição de composer neste ciclo;
 * a barra não pode criar a próxima. Se AMBOS os lados colidirem, vence o
 * candidato com MENOR área de sobreposição (desempate: acima). O resultado
 * final é sempre clampado à viewport com folga.
 */
export type BarRect = { top: number; left: number; width: number; height: number }

const VIEWPORT_GAP = 8
const SELECTION_GAP = 8

function intersects(a: BarRect, b: BarRect): boolean {
  return !(
    a.left + a.width <= b.left ||
    b.left + b.width <= a.left ||
    a.top + a.height <= b.top ||
    b.top + b.height <= a.top
  )
}

function overlapArea(a: BarRect, b: BarRect): number {
  if (!intersects(a, b)) return 0
  const width = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left)
  const height = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top)
  return width * height
}

function totalOverlap(rect: BarRect, obstacles: readonly BarRect[]): number {
  return obstacles.reduce((sum, obstacle) => sum + overlapArea(rect, obstacle), 0)
}

export function resolveAnnotationBarPosition(params: {
  selectionRect: BarRect
  barSize: { width: number; height: number }
  obstacles?: readonly BarRect[]
  viewport: { width: number; height: number }
}): { top: number; left: number; placement: 'above' | 'below' } {
  const { selectionRect, barSize, viewport } = params
  const obstacles = params.obstacles ?? []

  const clampedLeft = Math.min(
    Math.max(selectionRect.left + selectionRect.width / 2 - barSize.width / 2, VIEWPORT_GAP),
    Math.max(viewport.width - barSize.width - VIEWPORT_GAP, VIEWPORT_GAP),
  )
  const candidate = (top: number): BarRect => ({ top, left: clampedLeft, width: barSize.width, height: barSize.height })

  const above = candidate(selectionRect.top - barSize.height - SELECTION_GAP)
  const below = candidate(selectionRect.top + selectionRect.height + SELECTION_GAP)

  const aboveFits = above.top >= VIEWPORT_GAP
  const belowFits = below.top + barSize.height <= viewport.height - VIEWPORT_GAP
  const aboveOverlap = totalOverlap(above, obstacles)
  const belowOverlap = totalOverlap(below, obstacles)

  let placement: 'above' | 'below'
  if (aboveFits && aboveOverlap === 0) placement = 'above'
  else if (belowFits && belowOverlap === 0) placement = 'below'
  else if (aboveOverlap !== belowOverlap) placement = aboveOverlap < belowOverlap ? 'above' : 'below'
  else placement = aboveFits ? 'above' : 'below'

  const chosen = placement === 'above' ? above : below
  const clampedTop = Math.min(
    Math.max(chosen.top, VIEWPORT_GAP),
    Math.max(viewport.height - barSize.height - VIEWPORT_GAP, VIEWPORT_GAP),
  )
  return { top: clampedTop, left: clampedLeft, placement }
}

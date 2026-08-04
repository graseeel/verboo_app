import { describe, it, expect } from 'vitest'
import { resolveAnnotationBarPosition, type BarRect } from './annotationBarPosition'

const viewport = { width: 1280, height: 800 }
const barSize = { width: 220, height: 40 }
const compactBarSize = { width: 300, height: 44 }

const rect = (top: number, left: number, width = 100, height = 20): BarRect => ({ top, left, width, height })

// Os obstáculos reais: o cartão do checklist flutua no canto superior direito
// e o painel do goal fica junto ao composer (parte inferior).
const checklistCard: BarRect = { top: 12, left: 1040, width: 220, height: 120 }
const goalPanel: BarRect = { top: 680, left: 285, width: 800, height: 60 }

describe('resolveAnnotationBarPosition — colisão e clamp', () => {
  it('padrão: ACIMA da seleção, centralizada nela', () => {
    const selection = rect(200, 400)
    const pos = resolveAnnotationBarPosition({ selectionRect: selection, barSize, viewport })
    expect(pos.placement).toBe('above')
    expect(pos.top).toBe(200 - barSize.height - 8)
    expect(pos.left).toBe(400 + 50 - barSize.width / 2) // centro da seleção
  })

  it('sem espaço acima (seleção no topo da viewport) → cai para BAIXO', () => {
    const selection = rect(20, 400)
    const pos = resolveAnnotationBarPosition({ selectionRect: selection, barSize, viewport })
    expect(pos.placement).toBe('below')
    expect(pos.top).toBe(20 + 20 + 8)
  })

  it('COLISÃO com o cartão do checklist acima → cai para BAIXO', () => {
    // Seleção sob o cartão: a barra acima ocuparia exatamente a área do cartão.
    const selection = rect(140, 1040, 120, 20)
    const pos = resolveAnnotationBarPosition({ selectionRect: selection, barSize, obstacles: [checklistCard], viewport })
    expect(pos.placement).toBe('below')
  })

  it('CONTRAFACTUAL: a MESMA seleção SEM o cartão → fica ACIMA (a única variável é o obstáculo)', () => {
    const selection = rect(140, 1040, 120, 20)
    const pos = resolveAnnotationBarPosition({ selectionRect: selection, barSize, obstacles: [], viewport })
    expect(pos.placement).toBe('above')
  })

  it('COLISÃO com o painel do goal abaixo → fica ACIMA', () => {
    // Seleção logo acima do painel: a barra abaixo entraria na área dele.
    const selection = rect(620, 500, 200, 20)
    const pos = resolveAnnotationBarPosition({ selectionRect: selection, barSize, obstacles: [goalPanel], viewport })
    expect(pos.placement).toBe('above')
  })

  it('obstáculos nos DOIS lados → vence o de MENOR sobreposição', () => {
    // Acima: obstáculo cobre quase toda a barra; abaixo: obstáculo só encosta.
    const selection = rect(300, 400, 100, 20)
    const bigAbove: BarRect = { top: 240, left: 330, width: 260, height: 60 } // cobre a barra acima inteira
    const smallBelow: BarRect = { top: 328, left: 300, width: 30, height: 30 } // encosta parcialmente
    const pos = resolveAnnotationBarPosition({
      selectionRect: selection,
      barSize,
      obstacles: [bigAbove, smallBelow],
      viewport,
    })
    expect(pos.placement).toBe('below')
  })

  it('horizontal: clampada à viewport quando a seleção encosta na borda direita', () => {
    const selection = rect(200, 1240, 30, 20)
    const pos = resolveAnnotationBarPosition({ selectionRect: selection, barSize, viewport })
    expect(pos.left + barSize.width).toBeLessThanOrEqual(viewport.width - 8)
    expect(pos.left).toBeGreaterThanOrEqual(8)
  })

  it('barra compacta com os dois botões também fica inteira na borda direita', () => {
    const selection = rect(200, 1240, 30, 20)
    const pos = resolveAnnotationBarPosition({ selectionRect: selection, barSize: compactBarSize, viewport })
    expect(pos.left + compactBarSize.width).toBeLessThanOrEqual(viewport.width - 8)
    expect(pos.left).toBeGreaterThanOrEqual(8)
  })

  it('horizontal: clampada à viewport quando a seleção encosta na borda esquerda', () => {
    const selection = rect(200, 0, 30, 20)
    const pos = resolveAnnotationBarPosition({ selectionRect: selection, barSize, viewport })
    expect(pos.left).toBeGreaterThanOrEqual(8)
  })

  it('vertical: nunca sai da viewport nem com seleção na última linha visível', () => {
    const selection = rect(790, 400, 100, 20)
    const pos = resolveAnnotationBarPosition({ selectionRect: selection, barSize, viewport })
    expect(pos.top + barSize.height).toBeLessThanOrEqual(viewport.height - 8)
  })
})

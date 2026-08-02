import { describe, it, expect } from 'vitest'
import {
  draftsForConversation,
  addAnnotationDraft,
  removeAnnotationDraft,
  updateAnnotationComment,
  type AnnotationDrafts,
} from './annotationDrafts'
import type { Annotation } from '../../../shared/types'

const ann = (id: string, overrides: Partial<Annotation> = {}): Annotation => ({
  id,
  segmentId: 't1:text:0',
  quote: 'trecho',
  prefix: '',
  suffix: '',
  occurrenceIndex: 0,
  comment: null,
  createdAt: 1000,
  ...overrides,
})

describe('annotationDrafts — POSSE por conversa', () => {
  it('POSSE: criar em A, trocar para B, voltar para A — as de A estão lá e NÃO aparecem em B', () => {
    let drafts: AnnotationDrafts = {}
    drafts = addAnnotationDraft(drafts, 'convA', ann('a1'))
    drafts = addAnnotationDraft(drafts, 'convA', ann('a2', { quote: 'outro' }))
    // "Troca para B": B não tem nada, e ler B não cria nem vaza nada.
    expect(draftsForConversation(drafts, 'convB')).toEqual([])
    // "Volta para A": os dois rascunhos continuam.
    expect(draftsForConversation(drafts, 'convA').map(a => a.id)).toEqual(['a1', 'a2'])
    // E criar em B não toca A.
    drafts = addAnnotationDraft(drafts, 'convB', ann('b1'))
    expect(draftsForConversation(drafts, 'convA').map(a => a.id)).toEqual(['a1', 'a2'])
    expect(draftsForConversation(drafts, 'convB').map(a => a.id)).toEqual(['b1'])
  })

  it('listas das OUTRAS conversas mantêm a MESMA referência (padrão updateConversation)', () => {
    let drafts: AnnotationDrafts = {}
    drafts = addAnnotationDraft(drafts, 'convA', ann('a1'))
    drafts = addAnnotationDraft(drafts, 'convB', ann('b1'))
    const listB = drafts['convB']
    drafts = addAnnotationDraft(drafts, 'convA', ann('a2'))
    expect(drafts['convB']).toBe(listB) // identidade preservada: sem re-render inútil em B
  })

  it('remover renumera por posição (sem buraco) e esvaziar remove a chave', () => {
    let drafts: AnnotationDrafts = {}
    drafts = addAnnotationDraft(drafts, 'convA', ann('a1'))
    drafts = addAnnotationDraft(drafts, 'convA', ann('a2'))
    drafts = addAnnotationDraft(drafts, 'convA', ann('a3'))
    drafts = removeAnnotationDraft(drafts, 'convA', 'a1')
    expect(draftsForConversation(drafts, 'convA').map(a => a.id)).toEqual(['a2', 'a3'])
    drafts = removeAnnotationDraft(drafts, 'convA', 'a2')
    drafts = removeAnnotationDraft(drafts, 'convA', 'a3')
    expect('convA' in drafts).toBe(false) // chave some, não fica lista vazia
  })

  it('remover de uma conversa NÃO toca a outra, nem remoção de id inexistente', () => {
    let drafts: AnnotationDrafts = {}
    drafts = addAnnotationDraft(drafts, 'convA', ann('a1'))
    drafts = addAnnotationDraft(drafts, 'convB', ann('b1'))
    const same = removeAnnotationDraft(drafts, 'convA', 'nao-existe')
    expect(same).toBe(drafts) // mesma referência: nada mudou
    drafts = removeAnnotationDraft(drafts, 'convB', 'b1')
    expect(draftsForConversation(drafts, 'convA').map(a => a.id)).toEqual(['a1'])
  })

  it('updateAnnotationComment edita SÓ o item alvo, com trim e null em branco', () => {
    let drafts: AnnotationDrafts = {}
    drafts = addAnnotationDraft(drafts, 'convA', ann('a1'))
    drafts = addAnnotationDraft(drafts, 'convA', ann('a2'))
    drafts = updateAnnotationComment(drafts, 'convA', 'a2', '  ver isso  ')
    expect(draftsForConversation(drafts, 'convA')[1].comment).toBe('ver isso')
    expect(draftsForConversation(drafts, 'convA')[0].comment).toBeNull()
    drafts = updateAnnotationComment(drafts, 'convA', 'a2', '   ')
    expect(draftsForConversation(drafts, 'convA')[1].comment).toBeNull()
  })
})

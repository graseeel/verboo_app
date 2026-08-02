import type { Annotation } from '../../../shared/types'

/**
 * Rascunhos de anotações POR CONVERSA — POSSE, não cache.
 *
 * O dono é fixado UMA vez, na criação: a anotação entra na lista da conversa
 * onde a seleção aconteceu e nunca é relida contra "a conversa ativa". Por
 * isso trocar de conversa e voltar não PERDE os rascunhos de A nem os VAZA
 * para B — cada conversa tem sua lista, e os helpers abaixo preservam a
 * identidade das listas das OUTRAS conversas (mesma referência), como manda
 * o padrão updateConversation do chatStore. Já fomos mordidos por delegate
 * de vida longa que vazou entre conversas.
 *
 * Estado: um Record<conversationId, Annotation[]> em useState no App (sem
 * zustand neste app; rascunho é memória de sessão — restart limpa, limite
 * declarado: persistência em disco de rascunho não enviado ficou fora da F1).
 *
 * RENUMERAÇÃO AO APAGAR (decisão do Maestro): removeAnnotationDraft tira do
 * array — os números exibidos e os do prompt derivam da posição no array, no
 * instante, então nunca há buraco. O id estável existe só para remover/editar.
 */

export type AnnotationDrafts = Record<string, Annotation[]>

export function draftsForConversation(drafts: AnnotationDrafts, conversationId: string): Annotation[] {
  return drafts[conversationId] ?? []
}

export function addAnnotationDraft(
  drafts: AnnotationDrafts,
  conversationId: string,
  annotation: Annotation,
): AnnotationDrafts {
  const list = draftsForConversation(drafts, conversationId)
  return { ...drafts, [conversationId]: [...list, annotation] }
}

export function removeAnnotationDraft(
  drafts: AnnotationDrafts,
  conversationId: string,
  annotationId: string,
): AnnotationDrafts {
  const list = draftsForConversation(drafts, conversationId)
  const next = list.filter(a => a.id !== annotationId)
  if (next.length === list.length) return drafts
  if (next.length === 0) {
    const { [conversationId]: _removed, ...rest } = drafts
    return rest
  }
  return { ...drafts, [conversationId]: next }
}

export function updateAnnotationComment(
  drafts: AnnotationDrafts,
  conversationId: string,
  annotationId: string,
  comment: string | null,
): AnnotationDrafts {
  const list = draftsForConversation(drafts, conversationId)
  if (!list.some(a => a.id === annotationId)) return drafts
  return {
    ...drafts,
    [conversationId]: list.map(a =>
      a.id === annotationId
        ? { ...a, comment: comment && comment.trim().length > 0 ? comment.trim() : null }
        : a,
    ),
  }
}

/** F3 (N10): consome SÓ as anotações que o request confirmado carregou —
 *  por id, nunca a conversa inteira. Uma anotação criada DURANTE o turno em
 *  voo não estava no retrato do clique e NÃO pode ser apagada de carona:
 *  ela ainda não foi enviada. Chamada SÓ depois do envio confirmado —
 *  antes disso o rascunho é o trabalho do usuário e se preserva na falha. */
export function consumeAnnotationDrafts(
  drafts: AnnotationDrafts,
  conversationId: string,
  sentIds: ReadonlySet<string>,
): AnnotationDrafts {
  const list = draftsForConversation(drafts, conversationId)
  const next = list.filter(a => !sentIds.has(a.id))
  if (next.length === list.length) return drafts
  if (next.length === 0) {
    const { [conversationId]: _removed, ...rest } = drafts
    return rest
  }
  return { ...drafts, [conversationId]: next }
}

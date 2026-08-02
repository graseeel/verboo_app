import type { AgentTurnRequest, Annotation } from '../../../shared/types'

/**
 * A costura do campo annotations no request (F3) — o ÚNICO ponto onde o
 * campo entra num AgentTurnRequest.
 *
 * CONTRAFACTUAL BYTE-IDÊNTICO, por construção: com zero anotações, devolve
 * a MESMA referência — a chave `annotations` nem chega a existir no objeto
 * (e undefined é descartado na serialização). O request sem anotações fica
 * byte-idêntico ao pré-F3, e o golden do lado Rust
 * (build_prompt_is_byte_identical_when_no_annotations, turn_service.rs:6149)
 * continua verde porque o #[serde(default)] tolera a ausência.
 *
 * N10 — CONGELAMENTO NO CLIQUE: com anotações, o campo recebe CÓPIAS novas
 * de cada item. Editar o rascunho durante o turno em voo (updateAnnotationComment
 * cria objetos novos, mas quem segura o array original mutaria por referência)
 * nunca altera o que o modelo recebeu — o request carrega o retrato do
 * clique, não uma janela para o rascunho vivo.
 *
 * DEGRADAÇÃO camada 3: esta função NÃO consulta o resolvedor. Uma anotação
 * cujo trecho sumiu do transcript viaja igual — perde o visual (F2), nunca
 * o dado. Quem decide o destino dela no prompt é o Rust, não a resolubilidade.
 */
export function applyAnnotations<R extends AgentTurnRequest>(
  request: R,
  annotations: readonly Annotation[],
): R {
  if (annotations.length === 0) return request
  return { ...request, annotations: annotations.map(a => ({ ...a })) }
}

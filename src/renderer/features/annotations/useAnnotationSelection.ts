import { useCallback, useEffect, useRef, useState } from 'react'
import { resolveSelectionTarget, type SelectionTarget } from './annotationSelectionTarget'
import { resolveAnnotationBarPosition } from './annotationBarPosition'

/**
 * Ouvinte de seleção ESCOPADO (F1): escuta selectionchange/pointer no
 * document, mas só produz barra quando resolveSelectionTarget encontra um
 * segmento de resposta do MODELO ([data-annotation-segment], fora de
 * [data-turn-streaming]). A exceção explícita é o cabeçalho do mesmo turno:
 * a seleção é limitada ao segmento de resposta e sinalizada. Mensagem de
 * usuário, activity, summary e área sem relação com um turno continuam fora.
 * R1 — copiar/colar: este hook NUNCA chama
 * preventDefault nem stopPropagation; só observa. O gesto de copiar segue
 * intacto (há teste pinnando).
 *
 * Eventos de PONTEIRO (não de mouse), porque seleção diverge entre WebKit,
 * WebView2 e WebKitGTK e o app roda nos três sistemas.
 *
 * A barra aparece ao FIM do gesto (pointerup) ou em seleção por teclado
 * (keyup com Shift/setas), nunca no meio do arrasto — mostrar durante o
 * gesto roubaria o foco visual da seleção. Esconde em: seleção colapsada
 * (EXCETO com a interação dentro da barra — ver o FIX em compute), Escape,
 * pointerdown fora da barra.
 *
 * FRONTEIRA DE TESTE REGISTRADA: em jsdom, focar um input NÃO colapsa a
 * seleção do documento como o WebView real faz — foi por isso que a suíte
 * passou com o defeito de campo (a barra sumia ao clicar no comentário).
 * O teste do FIX simula o COLAPSO explicitamente; o clique sozinho não
 * reproduz nada em jsdom.
 */

export type AnnotationSelection = {
  target: SelectionTarget
  top: number
  left: number
  placement: 'above' | 'below'
}

// Tamanho conservador da barra compacta (dois botões) para o cálculo de
// colisão. O modo de comentário é mais estreito; usar a largura compacta aqui
// mantém o clamp horizontal seguro antes de a barra real ser montada.
const BAR_SIZE = { width: 300, height: 44 }

export function useAnnotationSelection(enabled: boolean): {
  selection: AnnotationSelection | null
  dismiss: () => void
  barRef: React.RefObject<HTMLDivElement | null>
} {
  const [selection, setSelection] = useState<AnnotationSelection | null>(null)
  const barRef = useRef<HTMLDivElement | null>(null)
  const pointerDownRef = useRef(false)
  // Ponte do trânsito de foco (defeito de campo, 2026-08-01): true só entre
  // o pointerdown DENTRO da barra e o pointerup — a janela em que o navegador
  // já colapsou a seleção do documento mas o activeElement ainda é o body.
  const interactingWithBarRef = useRef(false)

  const dismiss = useCallback(() => setSelection(null), [])

  useEffect(() => {
    if (!enabled) {
      setSelection(null)
      return
    }

    const compute = () => {
      const sel = document.getSelection()
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        // FIX (defeito de campo): clicar no campo de comentário COLAPSA a
        // seleção do documento — o navegador move o cursor para dentro do
        // input e o selectionchange cai aqui; a guarda de ponteiro (abaixo)
        // não cobre esse caminho. A âncora JÁ foi calculada no gesto de
        // seleção (quote/prefix/suffix/occurrenceIndex em mãos): perder a
        // seleção do DOM não perde dado nenhum — só não pode derrubar a
        // interface. A barra fica enquanto a interação estiver DENTRO dela:
        // (a) o foco já chegou — activeElement contido cobre inclusive a
        //     digitação, porque seleção de input TAMBÉM dispara o
        //     selectionchange do document;
        // (b) o pointerdown começou dentro e o foco está em trânsito
        //     (activeElement === body entre o mousedown e o focus).
        // Fora desses dois casos, o comportamento é o de sempre: colapsou,
        // dispensa.
        if (interactingWithBarRef.current) return
        if (barRef.current && barRef.current.contains(document.activeElement)) return
        setSelection(null)
        return
      }
      const target = resolveSelectionTarget(sel.anchorNode, sel.anchorOffset, sel.focusNode, sel.focusOffset)
      if (!target) {
        setSelection(null)
        return
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect()
      // Obstáculos medidos NO MOMENTO: o cartão do checklist (FLUTUANTE e
      // ACOPLADO — o seletor casa a classe base, sem o modificador de estado),
      // o painel do goal, o composer e a coluna do chat lateral são
      // superfícies que a barra não pode atropelar. O composer também define
      // o teto dinâmico do comentário.
      // O consumidor e o Composer são montados no mesmo documento; os testes
      // de seleção exercitam esse contrato pela presença real da barra.
      const obstacles = Array.from(document.querySelectorAll('.checklist-panel, .goal-active-panel, .composer, .sidechat-panel'))
        .map(el => {
          const r = el.getBoundingClientRect()
          return { top: r.top, left: r.left, width: r.width, height: r.height }
        })
      const position = resolveAnnotationBarPosition({
        selectionRect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
        barSize: BAR_SIZE,
        obstacles,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      })
      setSelection({ target, ...position })
    }

    const onSelectionChange = () => {
      // Durante o arrasto (pointer ainda pressionado) não reposiciona — a
      // barra só aparece no fim do gesto.
      if (!pointerDownRef.current) compute()
    }
    const onPointerDown = (event: PointerEvent) => {
      pointerDownRef.current = true
      // Clique DENTRO da barra não a derruba (o botão precisa receber o click)
      // e ARMA a ponte de foco (ver compute). Fora, desarma — e dispensa.
      const insideBar = Boolean(barRef.current && event.target instanceof Node && barRef.current.contains(event.target))
      interactingWithBarRef.current = insideBar
      if (insideBar) return
      setSelection(null)
    }
    const onPointerUp = () => {
      pointerDownRef.current = false
      compute()
    }
    const onFocusIn = (event: FocusEvent) => {
      // A ponte expira quando o foco CHEGA dentro da barra — nunca no
      // pointerup: num WebView o selectionchange do colapso pode ser tarefa
      // assíncrona que chega DEPOIS do pointerup com activeElement ainda no
      // body, e é exatamente essa janela que a ponte cobre. Daqui em diante
      // quem rege o colapso é o activeElement. Este listener é obrigatório:
      // sem ele, a ponte só desarma no próximo pointerdown fora, e sair por
      // Tab deixa a barra presa.
      if (barRef.current && event.target instanceof Node && barRef.current.contains(event.target)) {
        interactingWithBarRef.current = false
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelection(null)
    }
    const onScroll = (event: Event) => {
      // Texto longo faz o textarea crescer e pode gerar scroll interno. Esse
      // movimento pertence à própria barra; só scroll externo invalida sua
      // posição em relação ao trecho anotado.
      if (barRef.current && event.target instanceof Node && barRef.current.contains(event.target)) return
      setSelection(null)
    }
    const onKeyUp = (event: KeyboardEvent) => {
      // Seleção por teclado (Shift+setas): sem pointer events, o keyup é o fim do gesto.
      if (event.key === 'Shift' || event.key.startsWith('Arrow')) compute()
    }

    document.addEventListener('selectionchange', onSelectionChange)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('pointerup', onPointerUp)
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('keydown', onKeyDown)
    // scroll não borbulha; captura observa o contêiner rolável do transcript.
    document.addEventListener('scroll', onScroll, true)
    document.addEventListener('keyup', onKeyUp)
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('pointerup', onPointerUp)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('scroll', onScroll, true)
      document.removeEventListener('keyup', onKeyUp)
    }
  }, [enabled])

  return { selection, dismiss, barRef }
}

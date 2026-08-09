import { Check, CheckCircle2, ChevronDown, ChevronRight, Clipboard, Clock3, FileSearch, FileText, GitBranch, Image as ImageIcon, ListChecks, LoaderCircle, Pencil, Search, Terminal, Wrench } from 'lucide-react'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { TranscriptItem, VerbooModel, VideoProgress, WorkspaceChangeEntry, WorkspaceReviewMetadata } from '../../shared/types'
import { assistantTurnLabel, providerAccountName, providerDisplayName, providerToneStyle, resolveTurnProvider, VERBOO_PROVIDER } from '../features/models/providerCatalog'
import { ProviderIcon } from '../features/models/ProviderIcon'
import { VideoProcessingRow } from '../features/video/VideoProcessingRow'
import { ApiErrorAwareText } from '../features/transcript/ApiErrorText'
import { MarkdownMessage } from '../features/transcript/MarkdownMessage'
import { StepFlow } from '../features/transcript/StepFlow'
import { ThinkingIcon } from '../features/transcript/TranscriptIcons'
import { TurnErrorDetails } from '../features/transcript/TurnErrorDetails'
import { useI18n, type Translator } from '../i18n'

type TranscriptProps = {
  items: TranscriptItem[]
  conversationId?: string
  onOpenReview?: (files: WorkspaceChangeEntry[], index: number) => void
  reviewMetadata?: WorkspaceReviewMetadata
  thinkingTurnId?: string
  thinkingSnippets?: string[]
  compactingTurnId?: string
  /** Set of turnIds whose compaction has completed (done boundary). A
   *  separator marker is rendered below the turn once compaction finished. */
  compactedTurnIds?: ReadonlySet<string>
  imageReadingTurnId?: string
  onEditSent?: (conversationId: string, itemId: string, newText: string) => void
  /** Fired when a user toggles expand/collapse on a turn. The parent uses
   *  this to suppress stick-to-bottom autoscroll during the height change
   *  — otherwise scrollToLatest/forceWorkspaceToBottom fire after the
   *  restore and override the user's viewport position. */
  onUserExpand?: () => void
  /** Live video-analysis progress keyed by turnId. A turn with an entry
   *  shows one compact transient row; removal deletes the row entirely. */
  videoProgressByTurn?: Record<string, VideoProgress>
  /** Cancels the active video analysis via the same conversation interrupt
   *  the composer stop button uses. */
  onCancelVideo?: () => void
  /** F3: model catalog used to resolve each turn's provider (id → provider,
   *  displayName fallback). Absent → every header renders as verboo, exactly
   *  as today. */
  models?: VerbooModel[]
  /** Live provider rate-limit retries per turn (system/api_retry payloads):
   *  the thinking row says "retrying (N of M)" instead of sitting mute. */
  apiRetryByTurn?: Record<string, { attempt: number; maxRetries: number }>
  /** T8: offered as the exit when a turn hits the thinking-block 400 that
   *  permanently kills the conversation. The old history stays saved and
   *  readable; it just won't accept new turns. */
  onStartNewConversation?: () => void
}

const MAX_ACTIVITY_DETAIL_LINES = 8
const MAX_SUMMARY_DETAIL_LINES = 3

export const Transcript = memo(function Transcript({ items, onOpenReview, reviewMetadata, thinkingTurnId, thinkingSnippets, compactingTurnId, compactedTurnIds, imageReadingTurnId, conversationId, onEditSent, onUserExpand, videoProgressByTurn, onCancelVideo, models, apiRetryByTurn, onStartNewConversation }: TranscriptProps) {
  // `items` is a new array reference only when the conversation actually changes,
  // so this recomputes on real content changes but is skipped when the parent
  // re-renders for unrelated reasons (context-usage ticks, subagent updates…).
  const visibleItems = useMemo(() => buildTranscriptEntries(items), [items])

  const handleUserExpand = useCallback(() => {
    onUserExpand?.()
  }, [onUserExpand])

  return (
    <div className="transcript">
      {visibleItems.map(entry => (
        entry.kind === 'assistant-turn'
          ? <TurnView
              key={entry.turnId}
              entry={entry}
              thinking={thinkingTurnId === entry.turnId}
              thinkingSnippets={thinkingSnippets}
              compacting={compactingTurnId === entry.turnId}
              compacted={compactedTurnIds?.has(entry.turnId) ?? false}
              readingImage={imageReadingTurnId === entry.turnId}
              videoProgress={videoProgressByTurn?.[entry.turnId]}
              onCancelVideo={onCancelVideo}
              onOpenReview={onOpenReview}
              reviewMetadata={reviewMetadata}
              onUserExpand={handleUserExpand}
              models={models}
              apiRetry={apiRetryByTurn?.[entry.turnId]}
              onStartNewConversation={onStartNewConversation}
            />
          : <MessageArticle key={entry.item.id} item={entry.item} conversationId={conversationId} onCopy={() => {}} onEditSent={onEditSent} />
      ))}
    </div>
  )
})

type TranscriptEntry =
  | { kind: 'message'; item: TranscriptItem }
  | { kind: 'assistant-turn'; turnId: string; items: TranscriptItem[]; summary?: TranscriptItem }

// Rotates through real model thinking snippets every ~4s, like ChatGPT.
// New snippets are appended to the end; the timer cycles through them in
// order. No reset-to-latest — that would skip earlier thoughts.
function ThinkingRotator({ snippets }: { snippets: string[] }) {
  const [index, setIndex] = useState(0)
  // Clamp index when snippets shrink (turn ended/cleared) so we never read
  // out of bounds. When new snippets arrive, the index stays where it is so
  // the user can finish reading the current one before rotation continues.
  useEffect(() => {
    if (snippets.length === 0) return
    if (index >= snippets.length) setIndex(snippets.length - 1)
  }, [snippets.length, index])
  useEffect(() => {
    if (snippets.length <= 1) return
    const timer = setInterval(() => {
      setIndex(prev => (prev + 1) % snippets.length)
    }, 4000)
    return () => clearInterval(timer)
  }, [snippets.length])
  const text = snippets[index] ?? snippets[snippets.length - 1] ?? ''
  return (
    <span className="shimmer shimmer-color-purple shimmer-spread-24 shimmer-duration-calm thinking-snippet" title={text}>
      {text}
    </span>
  )
}

function TurnView({ entry, thinking, thinkingSnippets, compacting, compacted, readingImage, videoProgress, onCancelVideo, onOpenReview, reviewMetadata, onUserExpand, models, apiRetry, onStartNewConversation }: {
  entry: Extract<TranscriptEntry, { kind: 'assistant-turn' }>
  thinking: boolean
  thinkingSnippets?: string[]
  compacting: boolean
  compacted: boolean
  readingImage: boolean
  videoProgress?: VideoProgress
  onCancelVideo?: () => void
  onOpenReview?: TranscriptProps['onOpenReview']
  reviewMetadata?: WorkspaceReviewMetadata
  onUserExpand?: () => void
  models?: VerbooModel[]
  apiRetry?: { attempt: number; maxRetries: number }
  onStartNewConversation?: () => void
}) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const streaming = entry.items.some(item => item.streaming)
  const textItems = entry.items.filter(item => item.role === 'assistant' && item.text.trim().length > 0)
  const hasText = textItems.length > 0

  // Preserve scroll position when toggling expand — the grid-template-rows
  // 0fr→1fr transition changes the container height, which can cause the
  // browser to shift the user's viewport. Capture scrollTop before the
  // state change and restore it in a layout effect so the user stays put.
  const toggleExpand = useCallback(() => {
    const workspace = document.querySelector<HTMLElement>('.workspace')
    if (workspace) workspace.dataset.scrollBefore = String(workspace.scrollTop)
    onUserExpand?.()
    setExpanded(prev => !prev)
  }, [onUserExpand])

  useLayoutEffect(() => {
    const workspace = document.querySelector<HTMLElement>('.workspace')
    const saved = workspace?.dataset.scrollBefore
    if (workspace && saved !== undefined) {
      workspace.scrollTop = Number(saved)
      delete workspace.dataset.scrollBefore
    }
  }, [expanded])
  // When a vision-relay activity is in the turn, the VisionRelayRow in
  // StepFlow replaces the "Lendo imagem…" live chip — no double status.
  const hasVisionRelay = entry.items.some(item =>
    item.activityDetail?.startsWith('vision-relay|') ?? false
  )
  // The collapsed summary is the model's own final message (natural language),
  // not an app-generated action count. The recap is always visible below the
  // panel; StepFlow uses hideFinalTextId to suppress the duplicate block.
  const finalTextItem = hasText ? textItems[textItems.length - 1] : undefined
  const finalText = finalTextItem?.text ?? ''
  const modelItem = entry.items.find(item => item.role === 'assistant' && item.modelDisplayName)
  // F3: external providers replace the "Verboo" prefix with the provider name
  // and add the official brand icon (unknown ids: generic initial tile).
  // Verboo turns render EXACTLY as today.
  // The provider STAMPED at send time wins over re-resolving against the live
  // catalog: the catalog can degrade mid-turn (provider CLI hiccup — exactly
  // the 429-storm scenario) and a finished turn's header must not
  // retroactively lose its provider. Catalog resolution stays for legacy
  // items persisted before the stamp.
  const turnProvider = modelItem?.provider ?? (models ? resolveTurnProvider(modelItem?.modelId, modelItem?.modelDisplayName, models) : VERBOO_PROVIDER)
  const providerName = turnProvider !== VERBOO_PROVIDER ? providerDisplayName(turnProvider, t) : undefined
  // T10: without a stamped modelDisplayName the app has NO evidence of who
  // answered — the header must not invent a provider. The old fallback was
  // the literal 'Verboo' regardless of the real provider (the owner's claude
  // turn showed "Verboo" — a trust defect). Neutral role label instead.
  // T12: the label itself is built by the ONE canonical helper
  // (assistantTurnLabel) — shared with MessageArticle's standalone path.
  const label = assistantTurnLabel(modelItem?.modelDisplayName, providerName, t)
  const summary = entry.summary
  // The backend always sends summary.text in English ("Worked for 8s").
  // When the user's locale is not en, localise via the i18n key instead of
  // displaying the raw English string. The regex extracts the elapsed portion
  // (e.g. "8s", "1m 23s") and re-renders via t('transcript.workedFor').
  const WORKED_FOR_RE = /^Worked for (.+)$/
  const workedForMatch = summary?.text?.match(WORKED_FOR_RE)
  // A turn has "steps" when it contains at least one transcript activity
  // (read/search/edit/command/etc). Planning is rendered by ChecklistPanel,
  // not by StepFlow, so it must not make an otherwise empty panel expandable.
  // Turns with only a final assistant message
  // have nothing to expand — the chevron would open an empty panel.
  const hasActions = entry.items.some(item =>
    item.kind === 'activity' && item.activityKind !== 'thinking' && item.activityKind !== 'planning'
  )
  return (
    <article className="message-row assistant turn-view" data-turn-streaming={streaming ? 'true' : undefined}>
      {/* No "generating" badge here: while streaming, the thinking marker and
          the active action row below already signal progress — two indicators
          side-by-side read as noise. */}
      <div className="message-meta">
        <ProviderIcon providerId={turnProvider} size={11} style={providerToneStyle(turnProvider)} />
        <span>{label}</span>
      </div>

      {!streaming && entry.items.length > 0 && (
        hasActions ? (
          <button type="button" className="turn-collapsed" onClick={toggleExpand}>
            <ChevronRight size={14} className={expanded ? 'is-open' : ''} />
            <span>{workedForMatch ? t('transcript.workedFor', { elapsed: workedForMatch[1] }) : summary?.text ?? t('transcript.worked')}</span>
          </button>
        ) : (
          <span className="turn-collapsed is-static">
            <span>{workedForMatch ? t('transcript.workedFor', { elapsed: workedForMatch[1] }) : summary?.text ?? t('transcript.worked')}</span>
          </span>
        )
      )}

      {videoProgress && (
        <VideoProcessingRow progress={videoProgress} onCancel={() => onCancelVideo?.()} />
      )}

      {thinking && !hasText && !(readingImage && hasVisionRelay) && (
        <div className={`step-thinking ${readingImage ? 'is-reading-image' : ''}`} role="status">
          <span className="step-marker-icon" aria-hidden="true">
            {readingImage ? <ImageIcon size={14} strokeWidth={1.8} /> : <ThinkingIcon />}
          </span>
          {readingImage ? (
            <span className="shimmer shimmer-color-purple shimmer-spread-24 shimmer-duration-calm">
              {t('transcript.imageReading')}
            </span>
          ) : apiRetry ? (
            <span className="shimmer shimmer-color-purple shimmer-spread-24 shimmer-duration-calm">
              {t('transcript.apiRetry', { attempt: apiRetry.attempt, max: apiRetry.maxRetries })}
            </span>
          ) : thinkingSnippets && thinkingSnippets.length > 0 ? (
            <ThinkingRotator snippets={thinkingSnippets} />
          ) : (
            <span className="shimmer shimmer-color-purple shimmer-spread-24 shimmer-duration-calm">
              {t('transcript.thinking')}
            </span>
          )}
        </div>
      )}

      {streaming
        ? <StepFlow items={entry.items} streaming={streaming} imageReading={readingImage} />
        : entry.items.length > 0 && (
            <div className={`turn-flow-panel ${expanded ? 'is-open' : ''}`} aria-hidden={!expanded}>
              <div><StepFlow items={entry.items} streaming={false} imageReading={readingImage} hideFinalTextId={finalTextItem?.id} /></div>
            </div>
          )}

      {!streaming && finalText && (
        <div className="step-text turn-recap" data-annotation-segment={finalTextItem?.id}>
          <ApiErrorAwareText text={finalText} account={providerAccountName(turnProvider, t)} onStartNewConversation={onStartNewConversation} />
          {/* T23: the technical-detail toggle rides on the turn body (the
           * errorDetail is stamped on the final text segment by App.tsx).
           * The StepFlow hides the final text item (hideFinalTextId), so the
           * toggle must render here in the turn-recap alongside the headline. */}
          {finalTextItem?.errorDetail && <TurnErrorDetails detail={finalTextItem.errorDetail} />}
        </div>
      )}

      {/* G-C15-TS: goal-completion usage line, rendered inline after the
          agent's final text. No box, no badge — same typographic family
          as the turn-recap above, so it reads as a continuation of the
          agent's final message ("...Conteúdo verificado: valor\nUso
          registrado: 79.695 tokens; tempo aproximado: 8min20s"). The
          line is stamped on the turn's summary item by the onComplete
          delegate (App.tsx) when the goal completes. Empty for non-goal
          turns (summary.usageLine is undefined). */}
      {!streaming && summary?.usageLine && (
        <div className="step-text turn-usage-line">{summary.usageLine}</div>
      )}

      {/* T4: batch-goal progress ("Tarefa 3 de 12") and the final batch
          report — same surface rule as the usage line above: stamped on
          the turn's summary item, rendered inline in the SAME
          .turn-usage-line typographic family (NO new class, no box, no
          badge — the user rejected both). The progress line only exists
          while the batch runs; on completion the onComplete delegate
          clears it and stamps batchReportLines instead (one line per
          task with its cited evidence + the compaction-failure footer).
          Both undefined for non-batch goals — nothing renders. */}
      {!streaming && summary?.progressLine && (
        <div className="step-text turn-usage-line">{summary.progressLine}</div>
      )}
      {!streaming && summary?.batchReportLines && summary.batchReportLines.length > 0 && (
        <div className="step-text turn-usage-line">
          {summary.batchReportLines.map((line, index) => (
            <div key={index}>{line}</div>
          ))}
        </div>
      )}

      {!streaming && summary?.changeSummary?.totalFiles ? (
        <section className="turn-completion-summary" aria-label={t('transcript.turnSummary')}>
          <ChangeSummaryCard summary={summary.changeSummary} onOpenReview={onOpenReview} reviewMetadata={reviewMetadata} />
        </section>
      ) : null}

      {/* Compacting marker — below the turn flow, centered. Two phases:
          active (spinner + label) and done (separator with label). */}
      {compacting && (
        <div className="transcript-marker is-active" role="status">
          <LoaderCircle size={14} strokeWidth={2} className="transcript-marker-spinner" />
          <span>{t('transcript.compactingConversation')}</span>
        </div>
      )}
      {compacted && !compacting && (
        <div className="transcript-marker is-separator" role="status">
          <span className="transcript-marker-line" aria-hidden="true" />
          <span>{t('transcript.conversationCompacted')}</span>
          <span className="transcript-marker-line" aria-hidden="true" />
        </div>
      )}
    </article>
  )
}

export type MessageArticleProps = {
  item: TranscriptItem
  conversationId?: string
  children?: ReactNode
  onCopy?: (text: string) => void
  onEditSent?: (conversationId: string, itemId: string, newText: string) => void
}

const MessageArticle = memo(function MessageArticle({ item, conversationId, onCopy, onEditSent, children }: MessageArticleProps) {
  const { t } = useI18n()
  const visibleText = visibleTextForItem(item)
  const [editMode, setEditMode] = useState(false)
  const [editText, setEditText] = useState(visibleText)
  const [copyFlash, setCopyFlash] = useState(false)
  const isUserMessage = item.role === 'user' && item.kind !== 'activity' && item.kind !== 'summary'
  const visualRole = item.presentation === 'interruption' ? 'assistant' : item.role
  // T7: isTurnError (buildEntries, Transcript.tsx:731) — a linha de Sistema
  // carrega erro (id termina em :error). Só aplicamos a variante de erro
  // quando a linha é VISUALMENTE system (presentation !== 'interruption');
  // o interruption é visualmente assistant e não herda o cartão verde.
  const isTurnError = item.role === 'system' && item.id.endsWith(':error') && visualRole === 'system'

  function handleCopy() {
    const text = visibleText || item.text
    if (!text) return
    navigator.clipboard.writeText(text).then(() => {
      setCopyFlash(true)
      setTimeout(() => setCopyFlash(false), 1200)
    }).catch(() => {})
  }

  function handleSaveEdit() {
    const newText = editText.trim()
    if (!newText) return
    if (isUserMessage && conversationId && onEditSent) {
      onEditSent(conversationId, item.id, newText)
    }
    setEditMode(false)
  }

  // Inline edit UI
  if (editMode) {
    return (<>
      <article className={`message-row ${visualRole} ${item.kind ?? 'message'}`} data-activity={item.activityKind}>
        {item.presentation !== 'interruption' && <div className="message-meta"><span>{t('transcript.editMessage')}</span></div>}
        <textarea className="message-edit-textarea" value={editText} onChange={e => setEditText(e.target.value)} autoFocus />
        <div className="message-edit-actions">
          <button type="button" className="message-edit-btn save" onClick={handleSaveEdit} disabled={!editText.trim()}>{t('common.save')}</button>
          <button type="button" className="message-edit-btn cancel" onClick={() => setEditMode(false)}>{t('common.cancel')}</button>
        </div>
        {children}
      </article>
    </>
    )
  }

  // F3 (N3): item de anotação ENVIADA — cartão dedicado, montado dos pares
  // CONGELADOS em annotationEntries. O fallback `text` (MarkdownMessage) é
  // só para builds ANTIGAS; aqui ele nunca é a fonte. Sem ações de copiar/
  // editar: editar mexeria no texto-fallback, não nos pares congelados —
  // limite declarado do v1.
  if (item.kind === 'annotation' && item.annotationEntries?.length) {
    return (
      <div className="msg-wrap msg-wrap-right">
        <article className="message-row user annotation annotation-turn">
          <div className="message-meta">
            <span>{labelForItem(item, t)}</span>
          </div>
          <ol className="annotation-turn-list">
            {item.annotationEntries.map((entry, index) => (
              <li key={index} className="annotation-turn-entry">
                <span className="annotation-turn-index" aria-hidden="true">{index + 1}</span>
                <div className="annotation-turn-body">
                  <p className="annotation-turn-quote">{entry.quote}</p>
                  {entry.comment ? <p className="annotation-turn-comment">{entry.comment}</p> : null}
                </div>
              </li>
            ))}
          </ol>
        </article>
      </div>
    )
  }

  return (<>
    <div className={`msg-wrap ${isUserMessage ? 'msg-wrap-right' : ''}`}>
      <article
        className={`message-row ${visualRole} ${item.kind ?? 'message'}${isTurnError ? ' is-turn-error' : ''}`}
        data-activity={item.activityKind}
        data-command={isInitialGoalUserItem(item) ? 'goal' : undefined}
      >
        {item.presentation !== 'interruption' && (
          <div className="message-meta">
            {item.kind === 'activity' && <ActivityIcon item={item} />}
            {item.kind === 'summary' && <CheckCircle2 size={14} strokeWidth={1.8} />}
            <span>{labelForItem(item, t)}</span>
            {item.streaming && (
              <span className="message-status-marker" role="status">
                <span className="message-status-marker-icon" aria-hidden="true"><LoaderCircle size={12} /></span>
                <span className="shimmer shimmer-color-purple shimmer-spread-24 shimmer-duration-calm" data-text={t('transcript.generating')}>{t('transcript.generating')}</span>
              </span>
            )}
          </div>
        )}

        {item.attachments?.length ? (
          <div className="message-attachments">
            {item.attachments.map(att => {
              const isImage = att.kind === 'image'
                || att.kind === 'browser-annotation'
                || att.kind === 'simulator-annotation'
              return (
                <button key={att.path} type="button" className={`message-attachment-chip ${isImage ? 'message-attachment-image' : 'message-attachment-file'}`}
                  onClick={() => window.verboo?.openExternalFile?.('', att.path)} title={att.path}>
                  {isImage ? <img src={window.verboo?.fileUrl?.(att.path) ?? ''} alt="" className="message-attachment-thumb" loading="lazy" />
                    : <span className="message-attachment-icon" aria-hidden="true"><FileText size={14} /></span>}
                  <span className="message-attachment-name">{att.name}</span>
                </button>
              )
            })}
          </div>
        ) : null}

        {item.skills && item.skills.length > 0 && (
          <div className="message-skills">{item.skills.map(s => <span key={s.id}>/{s.name}</span>)}</div>
        )}

        <div
          className={`message-text ${item.streaming ? 'streaming-text' : ''}`}
          data-annotation-segment={item.role === 'assistant' && !item.kind && visibleText ? item.id : undefined}
        >
          {item.kind === 'summary' && item.activityDetail ? item.activityDetail
            : visibleText ? <MarkdownMessage text={visibleText} />
            : item.streaming ? t('transcript.thinking') : ''}
          {item.kind !== 'summary' && item.activityDetail && <span className="message-detail">{item.activityDetail}</span>}
        </div>
        {item.errorDetail ? <TurnErrorDetails detail={item.errorDetail} /> : null}

        {children}
      </article>

      {/* Actions only for sent user messages — queue lives in composer now */}
      {isUserMessage && !item.streaming && (
        <div className="message-actions message-actions-right">
          <button type="button" className="msg-action" onClick={handleCopy} title={t('transcript.copyText')}>
            {copyFlash ? <Check size={14} /> : <Clipboard size={14} />}
          </button>
          <button type="button" className="msg-action" onClick={() => { setEditText(visibleText || item.text); setEditMode(true) }} title={t('transcript.editMessage')}>
            <Pencil size={14} />
          </button>
        </div>
      )}
    </div>
  </>
  )
})

function visibleTextForItem(item: TranscriptItem): string {
  if (isInitialGoalUserItem(item)) return visibleInitialGoalCommand(item.text)
  return item.text
}

function isInitialGoalUserItem(item: TranscriptItem): boolean {
  return item.role === 'user' && item.id.startsWith('user:goal:')
}

function isInternalGoalContinuationItem(item: TranscriptItem): boolean {
  return item.role === 'user' && item.id.startsWith('user:goal-continue:')
}

// --- Vazamento de tag de raciocínio no stream --------------------------------
// Medido no histórico persistido real (verboo:chat-store:v1): 36 segmentos
// assistant (id no formato turnId:text:N) contêm `</think>` cru — o FECHAMENTO
// escapa do filtro do stream (a abertura é consumida antes e nunca vaza). A
// limpeza acontece AQUI, na exibição, e não na gravação: assim o histórico já
// persistido do usuário também fica limpo.
//
// Duas regras conservadoras, com o motivo de cada uma:
// 1) Remove-se a TAG, nunca o segmento inteiro: 3 das 36 ocorrências reais
//    traziam a resposta do modelo junto da tag (uma delas uma explicação de
//    várias linhas que o usuário precisava ler). Descartar a mensagem inteira
//    — como faz features/subagents/subagentThreads.ts, onde o critério é outro
//    — apagaria essas respostas. O segmento só é descartado quando NADA além
//    de whitespace sobra depois da remoção.
// 2) A tag só é removida quando ocupa a PRÓPRIA LINHA começando na coluna 0
//    (no máximo whitespace depois dela) E está FORA de cerca de crases. Menção
//    inline ("...o token </think> fecha...") e qualquer linha dentro de bloco
//    de código cercado SOBREVIVEM — inclusive a tag na coluna zero dentro da
//    cerca, porque ali ela é CONTEÚDO visível ao usuário, e apagar conteúdo
//    visível é pior que o vazamento que viemos consertar. A consciência de
//    cerca é paridade simples: cada linha começando com ``` alterna dentro/
//    fora. CASOS NÃO COBERTOS, declarados: cerca com til (~~~), cerca aninhada
//    (quatro crases abrindo, três fechando), cerca dentro de citação (> ```)
//    e cerca indentada (válida em markdown com até 3 espaços) NÃO são
//    reconhecidas — nenhuma observada nas 36 ocorrências reais. Cerca não
//    fechada protege até o fim do texto, mesmo comportamento do render
//    markdown.
const LEAKED_THINK_TAG_LINE_RE = /^<\/?think>\s*$/i
const CODE_FENCE_LINE_RE = /^```/

/** Remove linhas que são só uma tag `<think>`/`</think>` vazada FORA de cerca de crases. Uso de exibição; não altera o dado persistido. */
export function stripLeakedThinkTagLines(text: string): string {
  if (!text.includes('<')) return text
  const lines = text.split('\n')
  if (!lines.some((line) => LEAKED_THINK_TAG_LINE_RE.test(line))) return text
  let inFence = false
  return lines
    .filter((line) => {
      if (CODE_FENCE_LINE_RE.test(line)) {
        inFence = !inFence
        return true
      }
      if (inFence) return true
      return !LEAKED_THINK_TAG_LINE_RE.test(line)
    })
    .join('\n')
}

/**
 * Limpa um segmento de texto assistant com tag de raciocínio vazada.
 * Retorna o MESMO item quando não há nada a limpar (fast-path por referência);
 * um item novo com o texto limpo quando sobra conteúdo; e null quando o
 * segmento era só ruído (tag + whitespace), caso em que deve ser descartado.
 * Mensagens de usuário e itens activity/summary são intocáveis.
 */
export function cleanLeakedThinkTagItem(item: TranscriptItem): TranscriptItem | null {
  if (item.role !== 'assistant') return item
  if (item.kind === 'activity' || item.kind === 'summary') return item
  const cleaned = stripLeakedThinkTagLines(item.text)
  if (cleaned === item.text) return item
  if (cleaned.trim().length === 0) return null
  return { ...item, text: cleaned }
}

function visibleInitialGoalCommand(text: string): string {
  const goalLine = text.match(/^## Goal:\s*(.+)$/m)
  if (goalLine?.[1]) return `/goal ${goalLine[1].trim()}`
  return text.trim().startsWith('/goal') ? text.trim() : `/goal ${text.trim()}`
}

function ActivityPanel({ activities, summary }: { activities: TranscriptItem[]; summary?: TranscriptItem }) {
  const { t } = useI18n()
  if (activities.length === 0 && !summary) return null
  const detailLines = activityDetailLines(activities, summary, t)
  const primaryActivity = activities.find(item => item.activityKind !== 'thinking') ?? activities[0]
  const title = summary?.text ?? activityPanelTitle(activities, summary, t)

  return (
    <details className="turn-activity-panel">
      <summary>
        <span className="turn-activity-label">
          {primaryActivity ? <ActivityIcon item={primaryActivity} /> : <CheckCircle2 size={14} strokeWidth={1.8} />}
          {title}
        </span>
        <ChevronDown className="turn-activity-chevron" size={14} strokeWidth={1.9} />
      </summary>
      {detailLines.length > 0 && (
        <div className="turn-activity-details">
          {detailLines.map((line, index) => (
            <div key={`${index}:${line}`}>{line}</div>
          ))}
        </div>
      )}
    </details>
  )
}

function CompletionSummary({ summary, onOpenReview, reviewMetadata }: { summary: TranscriptItem; onOpenReview?: TranscriptProps['onOpenReview']; reviewMetadata?: WorkspaceReviewMetadata }) {
  const { t } = useI18n()
  const lines = summary.activityDetail
    ?.split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    ?? []

  if (lines.length === 0 && !summary.changeSummary?.totalFiles) return null

  return (
    <section className="turn-completion-summary" aria-label={t('transcript.turnSummary')}>
      <div className="turn-completion-header">
        <CheckCircle2 size={14} strokeWidth={1.8} />
        <span>{summary.text}</span>
      </div>
      {lines.length > 0 && (
        <div className="turn-completion-lines">
          {lines.map(line => (
            <p key={line}>{line}</p>
          ))}
        </div>
      )}
      {summary.changeSummary?.totalFiles ? <ChangeSummaryCard summary={summary.changeSummary} onOpenReview={onOpenReview} reviewMetadata={reviewMetadata} /> : null}
    </section>
  )
}

function changeSummaryTitle(summary: NonNullable<TranscriptItem['changeSummary']>, metadata: WorkspaceReviewMetadata | undefined, t: Translator): string {
  if (metadata?.scope === 'github-repo') return t('transcript.uncommittedChanges')
  if (metadata?.scope === 'git-repo') return t('transcript.repoChanges')
  return `${summary.totalFiles} ${summary.totalFiles === 1 ? t('transcript.fileWithChange') : t('transcript.filesWithChanges')}`
}

function changeSummarySubtitle(summary: NonNullable<TranscriptItem['changeSummary']>, metadata: WorkspaceReviewMetadata | undefined, t: Translator): string {
  if (metadata?.scope === 'github-repo' || metadata?.scope === 'git-repo') {
    return `${summary.totalFiles} ${summary.totalFiles === 1 ? t('transcript.fileWithChange') : t('transcript.filesWithChanges')}`
  }
  return t('transcript.localProject')
}

function ChangeSummaryCard({ summary, onOpenReview, reviewMetadata }: { summary: NonNullable<TranscriptItem['changeSummary']>; onOpenReview?: TranscriptProps['onOpenReview']; reviewMetadata?: WorkspaceReviewMetadata }) {
  const { t } = useI18n()
  const visibleFiles = summary.files.slice(0, 3)
  const hiddenCount = Math.max(0, summary.totalFiles - visibleFiles.length)
  const canOpenReview = Boolean(onOpenReview && reviewMetadata?.capabilities.canDiff !== false)

  const handleClickFile = (index: number) => {
    if (!canOpenReview) return
    onOpenReview?.(summary.files, index)
  }

  return (
    <div className="change-summary-card">
      <div className="change-summary-card-header"
        role={canOpenReview ? 'button' : undefined}
        tabIndex={canOpenReview ? 0 : undefined}
        title={canOpenReview ? t('transcript.review') : ''}
        onClick={() => handleClickFile(0)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClickFile(0) } }}
      >
        <span>
          {changeSummaryTitle(summary, reviewMetadata, t)}
          <small>{changeSummarySubtitle(summary, reviewMetadata, t)}</small>
        </span>
        <span className="change-summary-totals">
          <span className="added">+{summary.additions}</span>
          <span className="deleted">-{summary.deletions}</span>
        </span>
      </div>
      <div className="change-summary-files">
        {visibleFiles.map((file, index) => (
          <button
            key={file.path}
            type="button"
            className="change-summary-file"
            disabled={!canOpenReview}
            onClick={() => handleClickFile(index)}
            title={file.path}
          >
            <span>{compactPath(file.path)}</span>
            <span className="change-summary-totals">
              <span className="added">+{file.additions}</span>
              <span className="deleted">-{file.deletions}</span>
            </span>
          </button>
        ))}
        {hiddenCount > 0 && (
          <button
            type="button"
            className="change-summary-more"
            disabled={!canOpenReview}
            onClick={() => handleClickFile(visibleFiles.length)}
          >{t('transcript.showMoreFiles', { count: hiddenCount, files: hiddenCount === 1 ? t('transcript.fileSingular') : t('transcript.filePlural') })}</button>
        )}
      </div>
    </div>
  )
}

function ActivityIcon({ item }: { item: TranscriptItem }) {
  if (item.activityKind === 'read') return <FileText size={14} strokeWidth={1.8} />
  if (item.activityKind === 'edit') return <Pencil size={14} strokeWidth={1.8} />
  if (item.activityKind === 'search') return <Search size={14} strokeWidth={1.8} />
  if (item.activityKind === 'command') return <Terminal size={14} strokeWidth={1.8} />
  if (item.activityKind === 'terminal') return <Terminal size={14} strokeWidth={1.8} />
  if (item.activityKind === 'image') return <ImageIcon size={14} strokeWidth={1.8} />
  if (item.activityKind === 'thinking') return <Clock3 size={14} strokeWidth={1.8} />
  if (item.activityKind === 'permission') return <FileSearch size={14} strokeWidth={1.8} />
  if (item.activityKind === 'subagent') return <GitBranch size={14} strokeWidth={1.8} />
  // planning (T1-TodoWrite): the todowrite activity — a checklist, not a wrench.
  if (item.activityKind === 'planning') return <ListChecks size={14} strokeWidth={1.8} />
  return <Wrench size={14} strokeWidth={1.8} />
}

function turnIdFromText(item: TranscriptItem): string | undefined {
  return item.id.match(/^(.*):text:\d+$/)?.[1]
}

// The turn an item belongs to. Assistant text now streams as `turnId:text:N`
// segments; legacy persisted turns used a bare `turnId` assistant item, so fall
// back to the id itself for backward compatibility.
function turnIdOf(item: TranscriptItem): string | undefined {
  if (item.kind === 'activity') return turnIdFromActivity(item) ?? turnIdFromThinking(item)
  if (item.kind === 'summary') return turnIdFromSummary(item)
  if (item.role === 'assistant') return turnIdFromText(item) ?? item.id
  return undefined
}

export function buildTranscriptEntries(items: TranscriptItem[]): TranscriptEntry[] {
  // Limpa o vazamento de `</think>` ANTES do laço de agrupamento: um filtro
  // aplicado só no segundo laço (como o de isInternalGoalContinuationItem)
  // deixaria a tag já dentro de turn.items. Se a limpeza esvaziar TODOS os
  // segmentos de texto de um turno e ele não tiver summary, o turno some do
  // transcript — desfecho correto para um turno que só continha ruído (uma
  // bolha vazia seria pior). No fluxo real todo turno encerrado recebe
  // summary, então o cabeçalho e o resumo permanecem.
  const visibleItems: TranscriptItem[] = []
  for (const item of items) {
    const cleaned = cleanLeakedThinkTagItem(item)
    if (cleaned) visibleItems.push(cleaned)
  }

  const turns = new Map<string, { turnId: string; items: TranscriptItem[]; summary?: TranscriptItem }>()
  for (const item of visibleItems) {
    const turnId = turnIdOf(item)
    if (!turnId) continue
    let turn = turns.get(turnId)
    if (!turn) { turn = { turnId, items: [], summary: undefined }; turns.set(turnId, turn) }
    if (item.kind === 'summary') turn.summary = item
    else turn.items.push(item)
  }

  const emitted = new Set<string>()
  const entries: TranscriptEntry[] = []
  for (const item of visibleItems) {
    const isTurnError = item.role === 'system' && item.id.endsWith(':error')
    if (item.role === 'system' && item.kind !== 'summary' && !isTurnError) continue
    if (isInternalGoalContinuationItem(item)) continue
    const turnId = turnIdOf(item)
    if (turnId && turns.has(turnId)) {
      if (emitted.has(turnId)) continue
      emitted.add(turnId)
      const turn = turns.get(turnId)!
      entries.push({ kind: 'assistant-turn', turnId, items: turn.items, summary: turn.summary })
      continue
    }
    entries.push({ kind: 'message', item })
  }

  return entries
}

function labelForItem(item: TranscriptItem, t: Translator): string {
  if (item.kind === 'activity') return item.text
  if (item.kind === 'summary') return item.text
  if (item.role === 'assistant') {
    // T12 (the T10 sister Cadinho's sweep found): this used to hardcode the
    // brand — `Verboo - <model>` or a bare 'Verboo' — regardless of the real
    // provider. Same canonical rule as the turn header now: prefix from the
    // send-time stamp, neutral role label without a stamp. UNREACHABLE today:
    // buildTranscriptEntries groups EVERY assistant item into a turn
    // (turnIdOf falls back to item.id), so no assistant item ever reaches
    // MessageArticle — the reachability is pinned by test, and the fix keeps
    // the branch honest if the grouping invariant ever changes.
    return assistantTurnLabel(
      item.modelDisplayName,
      item.provider && item.provider !== VERBOO_PROVIDER ? providerDisplayName(item.provider, t) : undefined,
      t,
    )
  }
  if (item.role === 'tool') return t('transcript.tool')
  if (item.role === 'system') return t('transcript.system')
  return t('transcript.you')
}

function turnIdFromActivity(item: TranscriptItem): string | undefined {
  return item.id.match(/^(.*):activity:\d+$/)?.[1]
}

function turnIdFromThinking(item: TranscriptItem): string | undefined {
  return item.id.match(/^(.*):thinking$/)?.[1]
}

function turnIdFromSummary(item: TranscriptItem): string | undefined {
  return item.id.match(/^(.*):summary$/)?.[1]
}

function activityPanelTitle(activities: TranscriptItem[], summary: TranscriptItem | undefined, t: Translator): string {
  const counts = countActivities(activities)
  const parts = [
    formatCount(counts.image, t('transcript.imageOne'), t('transcript.imageMany')),
    formatCount(counts.read, t('transcript.readOne'), t('transcript.readMany')),
    formatCount(counts.edit, t('transcript.editOne'), t('transcript.editMany')),
    formatCount(counts.search, t('transcript.searchOne'), t('transcript.searchMany')),
    formatCount(counts.command, t('transcript.commandOne'), t('transcript.commandMany')),
    formatCount(counts.terminal, t('transcript.terminalOne'), t('transcript.terminalMany')),
    formatCount(counts.subagent, t('transcript.subagentOne'), t('transcript.subagentMany')),
    formatCount(counts.permission, t('transcript.permissionOne'), t('transcript.permissionMany')),
    formatCount(counts.tool, t('transcript.toolOne'), t('transcript.toolMany')),
    formatCount(counts.browser, t('transcript.browserOne'), t('transcript.browserMany')),
  ].filter((part): part is string => Boolean(part))

  if (parts.length > 0) return joinParts(parts, t)
  return summary?.text ?? t('transcript.agentActivity')
}

function activityDetailLines(activities: TranscriptItem[], summary: TranscriptItem | undefined, t: Translator): string[] {
  const title = activityPanelTitle(activities, summary, t)
  const seen = new Set<string>()
  const activityLines: string[] = []

  for (const item of activities) {
    if (item.activityKind === 'thinking' || !item.activityDetail) continue
    const line = `${item.text}: ${item.activityDetail}`
    const key = line.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    activityLines.push(line)
  }

  const hiddenCount = Math.max(0, activityLines.length - MAX_ACTIVITY_DETAIL_LINES)
  const visibleActivityLines = activityLines.slice(0, MAX_ACTIVITY_DETAIL_LINES)
  if (hiddenCount > 0) {
    visibleActivityLines.push(t('transcript.hiddenActions', { count: hiddenCount }))
  }

  const summaryLines = summary?.activityDetail
    ?.split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith(t('transcript.summaryPrefix')) && line !== t('transcript.stopReason', { reason: 'end_turn' }))
    .slice(0, MAX_SUMMARY_DETAIL_LINES)
    ?? []

  return [
    ...(title ? [title] : []),
    ...visibleActivityLines,
    ...summaryLines,
  ]
}

function countActivities(activities: TranscriptItem[]): Partial<Record<NonNullable<TranscriptItem['activityKind']>, number>> {
  return activities.reduce<Partial<Record<NonNullable<TranscriptItem['activityKind']>, number>>>((counts, item) => {
    if (!item.activityKind || item.activityKind === 'thinking') return counts
    if (!item.activityDetail && item.activityKind !== 'permission' && item.activityKind !== 'subagent' && item.activityKind !== 'image' && item.activityKind !== 'browser') return counts
    counts[item.activityKind] = (counts[item.activityKind] ?? 0) + 1
    return counts
  }, {})
}

function formatCount(count: number | undefined, singular: string, plural: string): string | undefined {
  if (!count) return undefined
  if (singular === plural) return count > 1 ? `${plural} ${count}x` : singular
  return count === 1 ? singular : `${plural} (${count})`
}

function joinParts(parts: string[], t: Translator): string {
  if (parts.length <= 1) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} ${t('transcript.and')} ${parts[parts.length - 1]}`
}

function compactPath(path: string): string {
  if (path.length <= 58) return path
  return `...${path.slice(-55)}`
}

import { useEffect, useRef } from 'react'
import { Film } from 'lucide-react'
import type {
  AttachmentMeta,
  VideoFallbackConsent,
  VideoUnderstandingRoute,
} from '../../../shared/types'
import { useI18n } from '../../i18n'

export type VideoFallbackResponse =
  | { allowOnce: true }
  | { persist: Extract<VideoFallbackConsent, 'always' | 'never'> }
  | { cancel: true }

export const DEFAULT_VIDEO_FALLBACK_CONSENT: VideoFallbackConsent = 'ask'

export type VideoConsentBeforeSendOptions = {
  consent: VideoFallbackConsent
  requestChoice: () => Promise<VideoFallbackResponse>
  persistConsent: (consent: Extract<VideoFallbackConsent, 'always' | 'never'>) => Promise<void> | void
  onConsentUpdated: () => void
  onDenied: () => void
  onPipelinePending: () => void
}

export type VideoConsentBeforeSendResult = 'blocked' | 'continue'

export async function resolveVideoConsentBeforeSend({
  consent,
  requestChoice,
  persistConsent,
  onConsentUpdated,
  onDenied,
  onPipelinePending,
}: VideoConsentBeforeSendOptions): Promise<VideoConsentBeforeSendResult> {
  if (consent === 'never') {
    onDenied()
    return 'blocked'
  }

  if (consent === 'ask') {
    const choice = await requestChoice()
    if ('cancel' in choice) return 'blocked'
    if ('persist' in choice) {
      await persistConsent(choice.persist)
      onConsentUpdated()
      if (choice.persist === 'never') {
        onDenied()
        return 'blocked'
      }
    }
  }

  // Task 5 owns consent only. Returning blocked is the security boundary
  // until the later media pipeline replaces the original attachment with the
  // disclosed route's safe inputs.
  onPipelinePending()
  return 'blocked'
}

export async function shouldBlockVideoBeforeCli(
  attachments: ReadonlyArray<Pick<AttachmentMeta, 'kind'>>,
  options: VideoConsentBeforeSendOptions,
): Promise<boolean> {
  if (!attachments.some(attachment => attachment.kind === 'video')) return false
  await resolveVideoConsentBeforeSend(options)
  return true
}

type VideoFallbackModalProps = {
  route: VideoUnderstandingRoute
  onRespond: (response: VideoFallbackResponse) => void
}

export function videoConsentAction(
  consent: VideoFallbackConsent,
): 'prompt' | 'proceed' | 'reject' {
  if (consent === 'always') return 'proceed'
  if (consent === 'never') return 'reject'
  return 'prompt'
}

export function VideoFallbackModal({ route, onRespond }: VideoFallbackModalProps) {
  const { t } = useI18n()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const onRespondRef = useRef(onRespond)
  onRespondRef.current = onRespond

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined
    const inertedElements: HTMLElement[] = []
    let activeBranch: HTMLElement | null = backdropRef.current
    while (activeBranch?.parentElement) {
      const parent = activeBranch.parentElement
      for (const sibling of Array.from(parent.children)) {
        if (sibling === activeBranch || !(sibling instanceof HTMLElement)) continue
        if (!sibling.hasAttribute('inert')) {
          sibling.setAttribute('inert', '')
          inertedElements.push(sibling)
        }
      }
      activeBranch = parent
    }

    function handleDocumentKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        onRespondRef.current({ cancel: true })
        return
      }
      if (event.key !== 'Tab') return

      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [])
      const first = focusable[0]
      const last = focusable.at(-1)
      if (!first || !last) {
        event.preventDefault()
        return
      }
      const active = document.activeElement
      if (event.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || !dialogRef.current?.contains(active))) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleDocumentKeyDown)
    cancelRef.current?.focus()
    return () => {
      document.removeEventListener('keydown', handleDocumentKeyDown)
      for (const element of inertedElements) element.removeAttribute('inert')
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [])

  return (
    <div ref={backdropRef} className="video-fallback-backdrop">
      <section
        ref={dialogRef}
        className="video-fallback-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="video-fallback-title"
      >
        <div className="video-fallback-heading">
          <Film size={18} aria-hidden="true" />
          <strong id="video-fallback-title">{t('videoConsent.title')}</strong>
        </div>
        <p className="video-fallback-note">{t(`videoConsent.route.${route}`)}</p>
        <div className="video-fallback-actions">
          <button ref={cancelRef} type="button" onClick={() => onRespond({ cancel: true })}>
            {t('common.cancel')}
          </button>
          <button type="button" onClick={() => onRespond({ allowOnce: true })}>
            {t('videoConsent.allowOnce')}
          </button>
          <button type="button" onClick={() => onRespond({ persist: 'always' })}>
            {t('videoConsent.always')}
          </button>
          <button className="video-fallback-never" type="button" onClick={() => onRespond({ persist: 'never' })}>
            {t('videoConsent.never')}
          </button>
        </div>
      </section>
    </div>
  )
}

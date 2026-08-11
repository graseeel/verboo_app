import { useEffect, useRef, useState } from 'react'
import { ExternalLink, Sparkles } from 'lucide-react'
import { openUrl } from '@tauri-apps/plugin-opener'
import type { WhatsNewAcknowledgeResult, WhatsNewStatus } from '../../../shared/types'
import { useI18n } from '../../i18n'
import { getReleaseCopy, releaseTagUrl } from './releaseCatalog'

type WhatsNewModalProps = {
  status: WhatsNewStatus
  onAcknowledge: (version: string) => Promise<WhatsNewAcknowledgeResult>
  onDismiss: (result: WhatsNewAcknowledgeResult) => void
  openReleaseUrl?: (url: string) => Promise<void>
}

export function WhatsNewModal({
  status,
  onAcknowledge,
  onDismiss,
  openReleaseUrl = openUrl,
}: WhatsNewModalProps) {
  const { language } = useI18n()
  const copy = getReleaseCopy(status.version, language)
  if (!copy) {
    console.error(`[verboo:whats-new] no bundled release copy for ${status.version}`)
    return null
  }
  return (
    <WhatsNewDialog
      status={status}
      copy={copy}
      onAcknowledge={onAcknowledge}
      onDismiss={onDismiss}
      openReleaseUrl={openReleaseUrl}
    />
  )
}

type WhatsNewDialogProps = Omit<WhatsNewModalProps, 'openReleaseUrl'> & {
  copy: NonNullable<ReturnType<typeof getReleaseCopy>>
  openReleaseUrl: (url: string) => Promise<void>
}

function WhatsNewDialog({
  status,
  copy,
  onAcknowledge,
  onDismiss,
  openReleaseUrl,
}: WhatsNewDialogProps) {
  const { t } = useI18n()
  const backdropRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const busyRef = useRef(false)
  const acknowledgeActionRef = useRef<() => Promise<void>>(async () => undefined)
  const [busy, setBusy] = useState(false)
  const [openError, setOpenError] = useState(false)

  async function finishAcknowledgment() {
    try {
      return await onAcknowledge(status.version)
    } catch (error) {
      return {
        persisted: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async function acknowledge() {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    const result = await finishAcknowledgment()
    onDismiss(result)
  }
  acknowledgeActionRef.current = acknowledge

  async function learnMore() {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setOpenError(false)
    try {
      await openReleaseUrl(releaseTagUrl(status.version))
    } catch {
      busyRef.current = false
      setBusy(false)
      setOpenError(true)
      return
    }
    const result = await finishAcknowledgment()
    onDismiss(result)
  }

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

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        void acknowledgeActionRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ) ?? [])
      const first = focusable[0]
      const last = focusable.at(-1)
      if (!first || !last) {
        event.preventDefault()
        return
      }
      event.preventDefault()
      const activeIndex = focusable.findIndex((element) => element === document.activeElement)
      const nextIndex = event.shiftKey
        ? (activeIndex <= 0 ? focusable.length - 1 : activeIndex - 1)
        : (activeIndex < 0 || activeIndex === focusable.length - 1 ? 0 : activeIndex + 1)
      focusable[nextIndex]?.focus()
    }

    document.addEventListener('keydown', onKeyDown)
    closeRef.current?.focus()
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      for (const element of inertedElements) element.removeAttribute('inert')
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [])

  return (
    <div ref={backdropRef} className="whats-new-backdrop" data-testid="whats-new-backdrop">
      <section
        ref={dialogRef}
        className="whats-new-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="whats-new-title"
        aria-describedby="whats-new-summary"
      >
        <header className="whats-new-header">
          <span className="whats-new-mark" aria-hidden="true"><Sparkles size={19} /></span>
          <div>
            <span className="whats-new-eyebrow">
              {t('whatsNew.eyebrow')} · v{status.version}
              {status.preview ? ` · ${t('whatsNew.preview')}` : ''}
            </span>
            <h2 id="whats-new-title">{copy.title}</h2>
            <p id="whats-new-summary">{copy.summary}</p>
          </div>
        </header>
        <div className="whats-new-content">
          <ul className="whats-new-list">
            {copy.items.map((item) => (
              <li key={item.title}>
                <span aria-hidden="true" />
                <div><strong>{item.title}</strong><p>{item.body}</p></div>
              </li>
            ))}
          </ul>
          {openError && <p className="whats-new-error" role="alert">{t('whatsNew.openFailed')}</p>}
        </div>
        <footer className="whats-new-actions">
          <button type="button" className="secondary" disabled={busy} onClick={() => { void learnMore() }}>
            {t('access.learnMore')} <ExternalLink size={15} aria-hidden="true" />
          </button>
          <button ref={closeRef} type="button" className="primary" disabled={busy} onClick={() => { void acknowledge() }}>
            {t('common.close')}
          </button>
        </footer>
      </section>
    </div>
  )
}

import { useCallback, useEffect, useState } from 'react'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { useI18n } from '../../i18n'
import { useToast } from '../../components/Toast'

type FileName = 'AGENTS.md' | 'CLAUDE.md'

type ProjectInstructionsEditorProps = {
  workingDirectory: string
}

/** Pure helper, exported so the dirty-state check is unit-testable.
 *  Same byte-for-byte content ⇒ not dirty. Anything changed ⇒ dirty. */
export function isInstructionDirty(original: string, draft: string): boolean {
  return original !== draft
}

/** Pure helper, exported for tests. Counts UTF-8 code points (not bytes)
 *  to give an honest size estimate on the panel — current rust size field
 *  is bytes, which underreports multibyte characters. */
export function countInstructionChars(content: string): number {
  return Array.from(content).length
}

/** Pure helper, exported for tests. Last non-empty path segment, trimmed
 *  of trailing separators. Returns the whole input when no separator is
 *  present (single-name project like `~/Code`). */
export function basename(path: string): string {
  if (!path) return ''
  const trimmed = path.replace(/[\\/]+$/, '')
  const lastForward = trimmed.lastIndexOf('/')
  const lastBack = trimmed.lastIndexOf('\\')
  const last = Math.max(lastForward, lastBack)
  return last >= 0 ? trimmed.slice(last + 1) : trimmed
}

export function ProjectInstructionsEditor({ workingDirectory }: ProjectInstructionsEditorProps) {
  const { t } = useI18n()
  const { toast } = useToast()
  const [whichFile, setWhichFile] = useState<FileName>('AGENTS.md')
  const [loadedContent, setLoadedContent] = useState<string>('')
  const [draft, setDraft] = useState<string>('')
  const [exists, setExists] = useState<boolean>(false)
  const [busy, setBusy] = useState<'idle' | 'loading' | 'saving'>('idle')
  const [loadFailed, setLoadFailed] = useState<string | null>(null)
  // Pending file switch — when set, the editor has unsaved changes and
  // the user has not yet confirmed discarding them. Set inside the click
  // handler; cleared by either confirming (sets whichFile + clears) or
  // cancelling (just clears).
  const [pendingSwitch, setPendingSwitch] = useState<FileName | null>(null)

  const reload = useCallback(async () => {
    if (!workingDirectory) return
    setBusy('loading')
    setLoadFailed(null)
    try {
      const result = await window.verboo.readProjectInstructionFile(workingDirectory, whichFile)
      setLoadedContent(result.content)
      setDraft(result.content)
      setExists(result.exists)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setLoadFailed(message)
    } finally {
      setBusy('idle')
    }
  }, [workingDirectory, whichFile])

  // Load (and reload) when the active project or file changes.
  useEffect(() => {
    void reload()
  }, [reload])

  function requestSwitchFile(next: FileName) {
    if (next === whichFile) return
    if (isInstructionDirty(loadedContent, draft)) {
      // Gate the switch behind the app-styled confirm dialog instead of
      // silently clobbering the dirty buffer via reload().
      setPendingSwitch(next)
      return
    }
    setWhichFile(next)
  }

  function confirmSwitch() {
    if (pendingSwitch) {
      setWhichFile(pendingSwitch)
    }
    setPendingSwitch(null)
  }

  if (!workingDirectory) {
    return (
      <div className="project-instructions-empty">{t('settings.projectInstructionsEmpty')}</div>
    )
  }

  const dirty = isInstructionDirty(loadedContent, draft)
  const saveLabel = exists ? t('common.save') : t('settings.projectInstructionsNewFile')
  const projectName = basename(workingDirectory)
  const projectDisplay = projectName || workingDirectory

  async function save() {
    if (!dirty || busy !== 'idle') return
    setBusy('saving')
    try {
      await window.verboo.writeProjectInstructionFile(workingDirectory, whichFile, draft)
      setLoadedContent(draft)
      setExists(true)
      toast(t('settings.projectInstructionsSaved'))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      toast(t('settings.projectInstructionsErrorSave', { message }), 'error')
    } finally {
      setBusy('idle')
    }
  }

  return (
    <section className="settings-panel project-instructions-panel">
      <header className="project-instructions-header">
        <div className="project-instructions-meta">
          <strong title={workingDirectory}>{projectDisplay}</strong>
          <small>{t('settings.projectInstructionsWorkingDir', { path: workingDirectory })}</small>
        </div>
        <div className="project-instructions-tabs" role="tablist" aria-label={t('settings.projectInstructions')}>
          <button
            type="button"
            className={whichFile === 'AGENTS.md' ? 'active' : ''}
            onClick={() => requestSwitchFile('AGENTS.md')}
            role="tab"
            aria-selected={whichFile === 'AGENTS.md'}
          >
            {t('settings.projectInstructionsFileAgents')}
          </button>
          <button
            type="button"
            className={whichFile === 'CLAUDE.md' ? 'active' : ''}
            onClick={() => requestSwitchFile('CLAUDE.md')}
            role="tab"
            aria-selected={whichFile === 'CLAUDE.md'}
          >
            {t('settings.projectInstructionsFileClaude')}
          </button>
        </div>
      </header>

      {!exists && !loadFailed && (
        <div className="project-instructions-banner">{t('settings.projectInstructionsNewFile')}</div>
      )}

      <textarea
        className="project-instructions-editor"
        value={draft}
        onChange={event => setDraft(event.target.value)}
        rows={18}
        spellCheck
        aria-label={whichFile}
        disabled={busy === 'loading'}
      />

      {loadFailed && (
        <p className="settings-warning">
          {t('settings.projectInstructionsErrorLoad', { message: loadFailed })}
        </p>
      )}

      <footer className="project-instructions-footer">
        <button type="button" className="ghost-button" onClick={() => void reload()} disabled={busy !== 'idle'}>
          {t('settings.projectInstructionsReload')}
        </button>
        <span className="project-instructions-status" aria-live="polite">
          {dirty ? t('settings.projectInstructionsDirty') : ''}
        </span>
        <button
          type="button"
          className="primary-soft-button"
          disabled={!dirty || busy !== 'idle'}
          onClick={() => void save()}
        >
          {busy === 'saving' ? t('common.saving') : saveLabel}
        </button>
      </footer>

      <ConfirmDialog
        request={
          pendingSwitch
            ? {
                title: t('settings.projectInstructionsConfirmSwitchTitle'),
                description: t('settings.projectInstructionsConfirmSwitchBody', {
                from: whichFileLabel(whichFile, t),
                to: whichFileLabel(pendingSwitch, t),
              }),
                confirmLabel: t('settings.projectInstructionsConfirmSwitchCta'),
                danger: true,
                onConfirm: confirmSwitch,
              }
            : undefined
        }
        onClose={() => setPendingSwitch(null)}
      />
    </section>
  )
}

/** Resolve a file kind label through i18n (kept local; tiny pure helper). */
function whichFileLabel(file: FileName, t: (key: string, vars?: Record<string, string | number>) => string) {
  if (file === 'AGENTS.md') return t('settings.projectInstructionsFileAgents')
  return t('settings.projectInstructionsFileClaude')
}

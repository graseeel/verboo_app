import { Check, Copy, ExternalLink, LoaderCircle, RefreshCw, Smartphone } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../../i18n'
import { simulatorIssueMessageKey } from './iosSimulatorModel'
import type { SimulatorIssue } from './iosSimulatorModel'
import { iosSimulatorApi } from './iosSimulatorApi'
import type {
  IosSimulatorSetupDone,
  IosSimulatorSetupProgress,
  IosSimulatorSetupStep,
} from './iosSimulatorApi'

/**
 * Simulator setup onboarding (design-ios-onboarding, frozen vocabulary
 * 2026-08-19 — verbatim, do not rename).
 *
 * Replaces the old static .ios-simulator-requirement card: the detected
 * problem title, a choice between AUTOMATIC setup (recommended — the
 * backend runs xcode-select/license/first-launch, downloads the iOS
 * runtime and creates the default device) and MANUAL setup (guided
 * steps with convenience buttons), the progress screen driven by the
 * ios-simulator:setup-progress / setup-done events, and Check again.
 *
 * Frozen-vocabulary consequences baked into this component:
 *   - UI v1 always starts the sequence with mode 'full' — the backend
 *     derives the real step list from detect_requirements, so the
 *     renderer renders steps EVENT-DRIVEN (as they arrive), never from
 *     a local per-mode list;
 *   - 'waitingForXcode' is emitted by the BACKEND during its own App
 *     Store polling (15s) — the renderer only displays it, never polls;
 *   - setup-done { ready:false, error:'cancelled' } is the user's own
 *     cancel — back to the choice screen, not a failure;
 *   - setup-done { ready:false, issue, NO error } means "manual only"
 *     (e.g. unsupportedXcode) — land straight on the manual guide.
 *
 * Fail-open: an older backend without the new commands (invoke rejects
 * with unknown-command) falls back to the pre-onboarding static card —
 * the panel never breaks.
 */

// Issues for which the choice screen offers the automatic path.
// unsupportedXcode is manual-only by design (never force a version
// change); unsupportedPlatform/discoveryFailed have no automatic path.
const AUTO_CAPABLE: readonly SimulatorIssue[] = ['xcodeMissing', 'simctlMissing', 'simulatorsMissing']

const SIMULATOR_ISSUES: readonly SimulatorIssue[] = [
  'unsupportedPlatform',
  'xcodeMissing',
  'unsupportedXcode',
  'simctlMissing',
  'simulatorsMissing',
  'discoveryFailed',
]

function isSimulatorIssue(value: unknown): value is SimulatorIssue {
  return typeof value === 'string' && (SIMULATOR_ISSUES as readonly string[]).includes(value)
}

/** Older backends reject unregistered commands with an unknown-command /
 *  not-found error; anything else (e.g. "setup already running") is a
 *  REAL failure of a backend that does support the contract. */
function isUnknownCommandError(err: unknown): boolean {
  const text = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err)
  return /unknown command|not found/i.test(text)
}

function errorText(err: unknown): string | undefined {
  const text = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err)
  return text || undefined
}

type AutoState = {
  view: 'auto'
  /** Steps in arrival order — the last one is active, the rest done. */
  seenSteps: IosSimulatorSetupStep[]
  percent?: number
  message?: string
}

type OnboardingState =
  | { view: 'choice' }
  | AutoState
  | { view: 'autoFailed'; message?: string; issue?: SimulatorIssue }
  | { view: 'manual'; issueOverride?: SimulatorIssue }
  // Older backend without the setup commands: render the pre-onboarding
  // static card (the contract's fail-open path).
  | { view: 'legacy' }

type SimulatorOnboardingProps = {
  issue: SimulatorIssue
  xcodeVersion?: string
  requirementsLoading: boolean
  /** Requirements refetch — fired when setup-done reports ready. */
  onRefresh: () => Promise<number | undefined>
  /** User-facing Check again — the panel's refresh (with its feedback). */
  onCheckAgain: () => void
}

export function SimulatorOnboarding({
  issue,
  xcodeVersion,
  requirementsLoading,
  onRefresh,
  onCheckAgain,
}: SimulatorOnboardingProps) {
  const { t } = useI18n()
  const autoCapable = AUTO_CAPABLE.includes(issue)
  const [state, setState] = useState<OnboardingState>(() =>
    autoCapable ? { view: 'choice' } : { view: 'manual' },
  )
  // Guards against starting the automatic sequence twice (double click
  // while the start invoke is still in flight).
  const autoStartInFlightRef = useRef(false)
  const onRefreshRef = useRef(onRefresh)
  onRefreshRef.current = onRefresh

  // ios-simulator:setup-progress / setup-done — subscribed ONCE (same
  // drain pattern as the login:event listener). Progress is the frozen
  // event-driven step list; done either re-detects (ready), returns to
  // the choice screen (cancelled), drops into the retryable failure, or
  // — issue without error — lands on the manual guide.
  useEffect(() => {
    let disposed = false
    let unProgress: (() => void) | undefined
    let unDone: (() => void) | undefined
    const progressPromise = iosSimulatorApi.onSetupProgress(handleSetupProgress)
    const donePromise = iosSimulatorApi.onSetupDone(handleSetupDone)
    progressPromise.then(un => { if (disposed) un(); else unProgress = un }).catch(() => {})
    donePromise.then(un => { if (disposed) un(); else unDone = un }).catch(() => {})
    return () => {
      disposed = true
      unProgress?.()
      unDone?.()
      progressPromise.then(un => un()).catch(() => {})
      donePromise.then(un => un()).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function handleSetupProgress(progress: IosSimulatorSetupProgress) {
    setState(current => {
      if (current.view !== 'auto') return current
      // The backend re-emits 'verify' on every detect_requirements loop
      // and re-emits 'waitingForXcode' per poll — move a repeated step to
      // the end instead of duplicating it.
      const seenSteps = [...current.seenSteps.filter(step => step !== progress.step), progress.step]
      return {
        ...current,
        seenSteps,
        percent: progress.percent ?? undefined,
        message: progress.message ?? undefined,
      }
    })
  }

  function handleSetupDone(done: IosSimulatorSetupDone) {
    if (done.ready) {
      // Re-run detect_requirements — the parent swaps the panel to the
      // device list as soon as the fresh requirements arrive.
      void onRefreshRef.current()
      return
    }
    if (done.error === 'cancelled') {
      setState({ view: 'choice' })
      return
    }
    const doneIssue = isSimulatorIssue(done.issue) ? done.issue : undefined
    if (!done.error && doneIssue) {
      // "Manual only" outcome (e.g. an unsupported Xcode was installed):
      // straight to the guide for the FRESH issue the backend detected.
      setState({ view: 'manual', issueOverride: doneIssue })
      return
    }
    setState({ view: 'autoFailed', message: done.error ?? undefined, issue: doneIssue })
  }

  async function startAutomatic() {
    if (autoStartInFlightRef.current) return
    autoStartInFlightRef.current = true
    // Enter the progress screen BEFORE the invoke resolves — the backend
    // emits ios-simulator:setup-progress immediately after spawn, and
    // events landing before this state would be dropped. UI v1 always
    // uses 'full' (frozen vocabulary); the backend derives the steps.
    setState({ view: 'auto', seenSteps: [] })
    try {
      await iosSimulatorApi.setupStart('full')
    } catch (err) {
      if (isUnknownCommandError(err)) {
        // Backend without the new commands → the old static card keeps
        // working (fail-open contract).
        setState({ view: 'legacy' })
      } else {
        setState({ view: 'autoFailed', message: errorText(err) })
      }
    } finally {
      autoStartInFlightRef.current = false
    }
  }

  async function chooseAutomatic() {
    if (issue === 'xcodeMissing') {
      // Xcode only installs via the App Store with the user's session:
      // open the page, then hand the waiting to the backend (its
      // waitingForXcode step polls detect_requirements every 15s).
      try {
        await iosSimulatorApi.setupOpenAppStore()
      } catch (err) {
        if (isUnknownCommandError(err)) {
          setState({ view: 'legacy' })
          return
        }
        // A failed store open must not block the setup — the waiting
        // screen offers an "open again" convenience button.
      }
    }
    void startAutomatic()
  }

  async function reopenAppStore() {
    try {
      await iosSimulatorApi.setupOpenAppStore()
    } catch {
      // The step keeps waiting either way — the user can retry.
    }
  }

  function cancelAutomatic() {
    void iosSimulatorApi.setupCancel().catch(() => {})
    // Responsive first: leave the progress screen now; the backend's
    // setup-done { error:'cancelled' } confirms the same transition.
    setState({ view: 'choice' })
  }

  if (state.view === 'legacy') {
    // The pre-onboarding static card, verbatim — the fail-open path for
    // backends that predate the setup commands.
    return (
      <div className="ios-simulator-requirement" role="alert">
        <Smartphone size={24} aria-hidden="true" />
        <strong>{t('simulator.requirements.title')}</strong>
        <p>{t(simulatorIssueMessageKey(issue), { version: xcodeVersion ?? '' })}</p>
        <button
          type="button"
          className="ghost-button"
          onClick={onCheckAgain}
          disabled={requirementsLoading}
        >
          {t('simulator.refresh')}
        </button>
      </div>
    )
  }

  const issueMessage = t(simulatorIssueMessageKey(issue), { version: xcodeVersion ?? '' })

  return (
    <div className="ios-simulator-onboarding" role="alert">
      <Smartphone size={24} aria-hidden="true" />
      <strong>{t('simulator.requirements.title')}</strong>
      <p className="ios-simulator-onboarding-issue">{issueMessage}</p>

      {state.view === 'choice' && (
        <div className="ios-onboarding-choices">
          {autoCapable && (
            <button
              type="button"
              className="ios-onboarding-choice is-primary"
              onClick={() => void chooseAutomatic()}
            >
              <strong>
                {t('simulator.onboarding.autoTitle')}
                <span className="ios-onboarding-badge">{t('simulator.onboarding.recommended')}</span>
              </strong>
              <small>{t('simulator.onboarding.autoBody')}</small>
            </button>
          )}
          <button
            type="button"
            className="ios-onboarding-choice"
            onClick={() => setState({ view: 'manual' })}
          >
            <strong>{t('simulator.onboarding.manualTitle')}</strong>
            <small>{t('simulator.onboarding.manualBody')}</small>
          </button>
        </div>
      )}

      {state.view === 'auto' && (
        <AutomaticProgress
          state={state}
          onReopenAppStore={() => void reopenAppStore()}
          onCancel={cancelAutomatic}
        />
      )}

      {state.view === 'autoFailed' && (
        <div className="ios-onboarding-failed">
          <strong>{t('simulator.onboarding.failedTitle')}</strong>
          {state.message && <small className="ios-onboarding-failed-detail">{state.message}</small>}
          <div className="ios-onboarding-row">
            <button type="button" className="ghost-button" onClick={() => void startAutomatic()}>
              <RefreshCw size={12} aria-hidden="true" />
              {t('simulator.retry')}
            </button>
            <button
              type="button"
              className="ghost-button"
              onClick={() => setState({ view: 'manual', issueOverride: state.issue })}
            >
              {t('simulator.onboarding.manualTitle')}
            </button>
          </div>
        </div>
      )}

      {state.view === 'manual' && (
        <ManualGuide
          issue={state.issueOverride ?? issue}
          onOpenAppStore={() => void reopenAppStore()}
        />
      )}

      {(state.view === 'choice' || state.view === 'manual' || state.view === 'autoFailed') && (
        <button
          type="button"
          className="ghost-button ios-onboarding-check-again"
          onClick={onCheckAgain}
          disabled={requirementsLoading}
        >
          {t('simulator.onboarding.checkAgain')}
        </button>
      )}
    </div>
  )
}

function AutomaticProgress({
  state,
  onReopenAppStore,
  onCancel,
}: {
  state: AutoState
  onReopenAppStore: () => void
  onCancel: () => void
}) {
  const { t } = useI18n()
  const activeStep = state.seenSteps[state.seenSteps.length - 1]
  const waitingForXcode = activeStep === 'waitingForXcode'
  return (
    <div className="ios-onboarding-auto">
      <strong className="ios-onboarding-auto-title">{t('simulator.onboarding.progressTitle')}</strong>
      <ol className="ios-onboarding-steps">
        {state.seenSteps.map((step, index) => {
          const visual = index < state.seenSteps.length - 1 ? 'done' : 'active'
          return (
            <li key={step} data-state={visual}>
              <span className="ios-onboarding-step-icon" aria-hidden="true">
                {visual === 'done' ? <Check size={13} /> : <LoaderCircle size={13} className="is-spinning" />}
              </span>
              <span>{t(`simulator.onboarding.step.${step}`)}</span>
            </li>
          )
        })}
      </ol>
      {waitingForXcode && (
        <div className="ios-onboarding-waiting">
          <small>{t('simulator.onboarding.waitingXcodeBody')}</small>
          <button type="button" className="ghost-button" onClick={onReopenAppStore}>
            <ExternalLink size={12} aria-hidden="true" />
            {t('simulator.onboarding.openAppStoreAgain')}
          </button>
        </div>
      )}
      {typeof state.percent === 'number' && (
        <div
          className="cli-bootstrap-progress"
          role="progressbar"
          aria-label={t('simulator.onboarding.step.downloadPlatform')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(state.percent)}
        >
          <span style={{ transform: `scaleX(${Math.min(100, Math.max(0, state.percent)) / 100})` }} />
          <small>{Math.round(state.percent)}%</small>
        </div>
      )}
      {state.message && <small className="ios-onboarding-step-message" role="status">{state.message}</small>}
      <button type="button" className="ghost-button" onClick={onCancel}>
        {t('common.cancel')}
      </button>
    </div>
  )
}

type GuideStep = { text: string; command?: string; openAppStore?: boolean }

function ManualGuide({
  issue,
  onOpenAppStore,
}: {
  issue: SimulatorIssue
  onOpenAppStore: () => void
}) {
  const { t } = useI18n()
  const steps: GuideStep[] = []
  if (issue === 'xcodeMissing') {
    steps.push(
      { text: t('simulator.onboarding.guide.installXcode'), openAppStore: true },
      { text: t('simulator.onboarding.guide.openXcodeOnce') },
      { text: t('simulator.onboarding.guide.selectXcode'), command: 'sudo xcode-select -s /Applications/Xcode.app' },
      { text: t('simulator.onboarding.guide.acceptLicense'), command: 'sudo xcodebuild -license accept' },
    )
  } else if (issue === 'unsupportedXcode') {
    steps.push(
      { text: t('simulator.onboarding.guide.updateXcode'), openAppStore: true },
      { text: t('simulator.onboarding.guide.openXcodeOnce') },
      { text: t('simulator.onboarding.guide.selectXcode'), command: 'sudo xcode-select -s /Applications/Xcode.app' },
    )
  } else if (issue === 'simctlMissing') {
    steps.push(
      { text: t('simulator.onboarding.guide.installXcode'), openAppStore: true },
      { text: t('simulator.onboarding.guide.selectXcode'), command: 'sudo xcode-select -s /Applications/Xcode.app' },
    )
  } else if (issue === 'simulatorsMissing') {
    steps.push(
      { text: t('simulator.onboarding.guide.downloadRuntime'), command: 'xcodebuild -downloadPlatform iOS' },
      { text: t('simulator.onboarding.guide.createDevice') },
    )
  } else if (issue === 'discoveryFailed') {
    steps.push({ text: t('simulator.onboarding.guide.checkSelection'), command: 'xcode-select -p' })
  }

  return (
    <ol className="ios-onboarding-guide">
      {steps.map((step, index) => (
        <li key={index}>
          <span>{step.text}</span>
          {step.command && <CopyCommandButton command={step.command} />}
          {step.openAppStore && (
            <button type="button" className="ghost-button" onClick={onOpenAppStore}>
              <ExternalLink size={12} aria-hidden="true" />
              {t('simulator.onboarding.openAppStore')}
            </button>
          )}
        </li>
      ))}
    </ol>
  )
}

function CopyCommandButton({ command }: { command: string }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const resetRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => {
    if (resetRef.current) clearTimeout(resetRef.current)
  }, [])

  async function copy() {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      if (resetRef.current) clearTimeout(resetRef.current)
      resetRef.current = setTimeout(() => setCopied(false), 1600)
    } catch {
      // Clipboard unavailable: the command stays visible for manual copy.
    }
  }

  return (
    <span className="ios-onboarding-command">
      <code>{command}</code>
      <button type="button" className="ghost-button" onClick={() => void copy()}>
        {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
        {copied ? t('simulator.onboarding.copied') : t('simulator.onboarding.copy')}
      </button>
    </span>
  )
}

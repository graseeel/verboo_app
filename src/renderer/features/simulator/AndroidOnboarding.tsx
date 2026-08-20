import { Check, Copy, FolderOpen, LoaderCircle, RefreshCw, Smartphone } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { appDataDir, homeDir, join } from '@tauri-apps/api/path'
import { openPath } from '@tauri-apps/plugin-opener'
import { useI18n } from '../../i18n'
import {
  ANDROID_EMULATOR_AUTO_CAPABLE_ISSUES,
  androidEmulatorIssueMessageKey,
  androidEmulatorSetupStepMessageKey,
  errorText,
  isAndroidEmulatorIssue,
  isAndroidEmulatorSetupStep,
  isUnknownCommandError,
} from './androidEmulatorModel'
import type { AndroidEmulatorIssue } from './androidEmulatorModel'
import { androidEmulatorApi } from './androidEmulatorApi'
import type {
  AndroidEmulatorSetupAwaiting,
  AndroidEmulatorSetupDone,
  AndroidEmulatorSetupProgress,
  AndroidEmulatorSetupResume,
} from './androidEmulatorApi'

/**
 * Android emulator setup onboarding (PA-25, contract
 * `contrato-android-simulator` — frozen vocabulary 2026-08-19, refined with
 * the `awaiting` resume protocol; names verbatim, do not rename).
 *
 * Same mold as SimulatorOnboarding (design-ios-onboarding, PA-13/14): the
 * detected problem title, the AUTOMATIC/MANUAL choice, the event-driven
 * progress screen, and Check again. Android-specific, per the contract:
 *   - LICENSES are never accepted silently: when the worker pauses with
 *     setup-progress awaiting:'licenses', this component shows the license
 *     card (the text arrives in `message`, DISPLAY-ONLY — no logic ever
 *     anchors on it) and only the explicit Accept click re-invokes
 *     setup_start with acceptedLicenses=true;
 *   - LARGE DOWNLOADS never start silently: awaiting:'download' shows the
 *     confirmation card (size in `message`) and Download re-invokes
 *     setup_start with confirmDownload=true;
 *   - ACCELERATION that needs admin/reboot (WHPX) or a re-login (kvm group)
 *     is never faked: the worker STOPS at enableAccel and setup-done
 *     { issue:'accelMissing' } (no error) lands on the per-OS manual guide;
 *   - UI v1 always sends mode 'full' — the backend derives the real step
 *     list from detect_requirements (same frozen consequence as iOS).
 *
 * Fail-open: an older backend without the android_emulator_* commands
 * (invoke rejects with unknown-command) drops to AndroidEmulatorLegacyCard —
 * the guide without any setup offer. The panel renders the same card when
 * android_emulator_requirements itself is unknown.
 */

type AutoState = {
  view: 'auto'
  /** Steps in arrival order — the last one is active, the rest done. Typed
   *  as string because Solda may propose step ADDITIONS: unknown steps
   *  render by their raw id (the frozen ones get the i18n label). */
  seenSteps: string[]
  percent?: number
  message?: string
  /** Set while the worker is paused (frozen `awaiting` protocol). */
  awaiting?: AndroidEmulatorSetupAwaiting
}

type OnboardingState =
  | { view: 'choice' }
  | AutoState
  | { view: 'autoFailed'; message?: string; issue?: AndroidEmulatorIssue }
  | { view: 'manual'; issueOverride?: AndroidEmulatorIssue }
  // Older backend without the setup commands: the legacy guide card (the
  // contract's fail-open path — setup is never offered).
  | { view: 'legacy' }

type AndroidOnboardingProps = {
  issue: AndroidEmulatorIssue
  /** Host OS — the accelMissing guide is per-OS (WHPX / kvm group /
   *  Hypervisor.framework). */
  platform: NodeJS.Platform
  requirementsLoading: boolean
  /** Requirements refetch — fired when setup-done reports ready. */
  onRefresh: () => Promise<number | undefined>
  /** User-facing Check again. */
  onCheckAgain: () => void
}

export function AndroidOnboarding({
  issue,
  platform,
  requirementsLoading,
  onRefresh,
  onCheckAgain,
}: AndroidOnboardingProps) {
  const { t } = useI18n()
  const autoCapable = ANDROID_EMULATOR_AUTO_CAPABLE_ISSUES.includes(issue)
  const [state, setState] = useState<OnboardingState>(() =>
    autoCapable ? { view: 'choice' } : { view: 'manual' },
  )
  // Guards against starting the automatic sequence twice (double click
  // while the start invoke is still in flight).
  const autoStartInFlightRef = useRef(false)
  const onRefreshRef = useRef(onRefresh)
  onRefreshRef.current = onRefresh

  // android-emulator:setup-progress / setup-done — subscribed ONCE (same
  // drain pattern as the iOS onboarding). Progress is the frozen
  // event-driven step list; done either re-detects (ready), returns to the
  // choice screen (cancelled), drops into the retryable failure, or — issue
  // without error — lands on the manual guide.
  useEffect(() => {
    let disposed = false
    let unProgress: (() => void) | undefined
    let unDone: (() => void) | undefined
    const progressPromise = androidEmulatorApi.onSetupProgress(handleSetupProgress)
    const donePromise = androidEmulatorApi.onSetupDone(handleSetupDone)
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

  function handleSetupProgress(progress: AndroidEmulatorSetupProgress) {
    setState(current => {
      if (current.view !== 'auto') return current
      // Move a re-emitted step to the end instead of duplicating it (same
      // drain rule as the iOS onboarding).
      const seenSteps = [...current.seenSteps.filter(step => step !== progress.step), progress.step]
      return {
        ...current,
        seenSteps,
        percent: progress.percent ?? undefined,
        message: progress.message ?? undefined,
        // A progress event without `awaiting` means the worker resumed —
        // clear the pause card.
        awaiting: progress.awaiting ?? undefined,
      }
    })
  }

  function handleSetupDone(done: AndroidEmulatorSetupDone) {
    if (done.ready) {
      // Re-run detect_requirements — the parent swaps the tab to the
      // device list as soon as the fresh requirements arrive.
      void onRefreshRef.current()
      return
    }
    if (done.error === 'cancelled') {
      setState({ view: 'choice' })
      return
    }
    const doneIssue = isAndroidEmulatorIssue(done.issue) ? done.issue : undefined
    if (!done.error && doneIssue) {
      // "Manual only" outcome — e.g. the worker STOPPED at enableAccel
      // (WHPX admin/reboot, kvm re-login): land on the per-OS guide for the
      // FRESH issue the backend detected.
      setState({ view: 'manual', issueOverride: doneIssue })
      return
    }
    setState({ view: 'autoFailed', message: done.error ?? undefined, issue: doneIssue })
  }

  async function startAutomatic() {
    if (autoStartInFlightRef.current) return
    autoStartInFlightRef.current = true
    // Enter the progress screen BEFORE the invoke resolves — the backend
    // emits android-emulator:setup-progress immediately after spawn, and
    // events landing before this state would be dropped. UI v1 always uses
    // 'full' (frozen vocabulary); the backend derives the steps.
    setState({ view: 'auto', seenSteps: [] })
    try {
      await androidEmulatorApi.setupStart('full')
    } catch (err) {
      if (isUnknownCommandError(err)) {
        // Backend without the new commands → the legacy guide card keeps
        // working (fail-open contract).
        setState({ view: 'legacy' })
      } else {
        setState({ view: 'autoFailed', message: errorText(err) })
      }
    } finally {
      autoStartInFlightRef.current = false
    }
  }

  async function resumeAutomatic(resume: AndroidEmulatorSetupResume) {
    // Responsive first: clear the pause card now; the worker's next
    // progress event confirms the resume (or re-emits the pause).
    setState(current => (current.view === 'auto' ? { ...current, awaiting: undefined } : current))
    try {
      await androidEmulatorApi.setupStart('full', resume)
    } catch (err) {
      if (isUnknownCommandError(err)) {
        setState({ view: 'legacy' })
      } else {
        setState({ view: 'autoFailed', message: errorText(err) })
      }
    }
  }

  function cancelAutomatic() {
    void androidEmulatorApi.setupCancel().catch(() => {})
    // Responsive first: leave the progress screen now; the backend's
    // setup-done { error:'cancelled' } confirms the same transition.
    setState({ view: 'choice' })
  }

  if (state.view === 'legacy') {
    return (
      <AndroidEmulatorLegacyCard
        platform={platform}
        requirementsLoading={requirementsLoading}
        onCheckAgain={onCheckAgain}
      />
    )
  }

  const issueMessage = t(androidEmulatorIssueMessageKey(issue))

  return (
    <div className="ios-simulator-onboarding" role="alert">
      <Smartphone size={24} aria-hidden="true" />
      <strong>{t('androidEmulator.requirements.title')}</strong>
      <p className="ios-simulator-onboarding-issue">{issueMessage}</p>

      {state.view === 'choice' && (
        <div className="ios-onboarding-choices">
          {autoCapable && (
            <button
              type="button"
              className="ios-onboarding-choice is-primary"
              onClick={() => void startAutomatic()}
            >
              <strong>
                {t('androidEmulator.onboarding.autoTitle')}
                <span className="ios-onboarding-badge">{t('androidEmulator.onboarding.recommended')}</span>
              </strong>
              <small>{t('androidEmulator.onboarding.autoBody')}</small>
            </button>
          )}
          <button
            type="button"
            className="ios-onboarding-choice"
            onClick={() => setState({ view: 'manual' })}
          >
            <strong>{t('androidEmulator.onboarding.manualTitle')}</strong>
            <small>{t('androidEmulator.onboarding.manualBody')}</small>
          </button>
        </div>
      )}

      {state.view === 'auto' && (
        <AutomaticProgress
          state={state}
          onResume={resumeAutomatic}
          onCancel={cancelAutomatic}
        />
      )}

      {state.view === 'autoFailed' && (
        <div className="ios-onboarding-failed">
          <strong>{t('androidEmulator.onboarding.failedTitle')}</strong>
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
              {t('androidEmulator.onboarding.manualTitle')}
            </button>
          </div>
        </div>
      )}

      {state.view === 'manual' && (
        <AndroidEmulatorManualGuide issue={state.issueOverride ?? issue} platform={platform} />
      )}

      {(state.view === 'choice' || state.view === 'manual' || state.view === 'autoFailed') && (
        <button
          type="button"
          className="ghost-button ios-onboarding-check-again"
          onClick={onCheckAgain}
          disabled={requirementsLoading}
        >
          {t('androidEmulator.onboarding.checkAgain')}
        </button>
      )}
    </div>
  )
}

function AutomaticProgress({
  state,
  onResume,
  onCancel,
}: {
  state: AutoState
  onResume: (resume: AndroidEmulatorSetupResume) => Promise<void>
  onCancel: () => void
}) {
  const { t } = useI18n()
  const activeStep = state.seenSteps[state.seenSteps.length - 1]
  const activeStepLabel = activeStep && isAndroidEmulatorSetupStep(activeStep)
    ? t(androidEmulatorSetupStepMessageKey(activeStep))
    : activeStep
  return (
    <div className="ios-onboarding-auto">
      <strong className="ios-onboarding-auto-title">{t('androidEmulator.onboarding.progressTitle')}</strong>
      <ol className="ios-onboarding-steps">
        {state.seenSteps.map((step, index) => {
          const visual = index < state.seenSteps.length - 1 ? 'done' : 'active'
          return (
            <li key={step} data-state={visual}>
              <span className="ios-onboarding-step-icon" aria-hidden="true">
                {visual === 'done' ? <Check size={13} /> : <LoaderCircle size={13} className="is-spinning" />}
              </span>
              <span>{isAndroidEmulatorSetupStep(step) ? t(androidEmulatorSetupStepMessageKey(step)) : step}</span>
            </li>
          )
        })}
      </ol>
      {typeof state.percent === 'number' && (
        <div
          className="cli-bootstrap-progress"
          role="progressbar"
          aria-label={activeStepLabel ?? t('androidEmulator.onboarding.progressTitle')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(state.percent)}
        >
          <span style={{ transform: `scaleX(${Math.min(100, Math.max(0, state.percent)) / 100})` }} />
          <small>{Math.round(state.percent)}%</small>
        </div>
      )}
      {state.awaiting === 'licenses' && (
        <div className="ios-onboarding-awaiting" role="group" aria-label={t('androidEmulator.onboarding.licenseTitle')}>
          <strong>{t('androidEmulator.onboarding.licenseTitle')}</strong>
          <small>{t('androidEmulator.onboarding.licenseBody')}</small>
          {state.message && <pre className="ios-onboarding-license-text">{state.message}</pre>}
          <button
            type="button"
            className="primary-button"
            onClick={() => void onResume({ acceptedLicenses: true })}
          >
            {t('androidEmulator.onboarding.licenseAccept')}
          </button>
        </div>
      )}
      {state.awaiting === 'download' && (
        <div className="ios-onboarding-awaiting" role="group" aria-label={t('androidEmulator.onboarding.downloadTitle')}>
          <strong>{t('androidEmulator.onboarding.downloadTitle')}</strong>
          <small>{t('androidEmulator.onboarding.downloadBody')}</small>
          {state.message && <small className="ios-onboarding-step-message">{state.message}</small>}
          <button
            type="button"
            className="primary-button"
            onClick={() => void onResume({ confirmDownload: true })}
          >
            {t('androidEmulator.onboarding.downloadConfirm')}
          </button>
        </div>
      )}
      {state.message && !state.awaiting && (
        <small className="ios-onboarding-step-message" role="status">{state.message}</small>
      )}
      <button type="button" className="ghost-button" onClick={onCancel}>
        {t('common.cancel')}
      </button>
    </div>
  )
}

type GuideStep = { text: string; command?: string }

/** The per-issue manual guide (contract §Onboarding: caminho DUPLO sempre).
 *  Convenience = copyable commands plus the contract's open-folder action.
 *  Component/package issues open the app-managed SDK destination; avdMissing
 *  opens the standard AVD destination, and sdkMissing opens the parent where
 *  the managed SDK is created.
 *  accelMissing is per-OS: WHPX needs admin + reboot (Windows), the kvm
 *  group needs a re-login (Linux), macOS always has Hypervisor.framework on
 *  modern hardware. */
export function AndroidEmulatorManualGuide({
  issue,
  platform,
}: {
  issue: AndroidEmulatorIssue
  platform: NodeJS.Platform
}) {
  const { t } = useI18n()
  const steps: GuideStep[] = []
  if (issue === 'sdkMissing') {
    steps.push(
      { text: t('androidEmulator.onboarding.guide.installTools') },
      { text: t('androidEmulator.onboarding.guide.setAndroidHome') },
    )
  } else if (issue === 'adbMissing') {
    steps.push({
      text: t('androidEmulator.onboarding.guide.installPlatformTools'),
      command: 'sdkmanager --install "platform-tools"',
    })
  } else if (issue === 'emulatorMissing') {
    steps.push({
      text: t('androidEmulator.onboarding.guide.installEmulator'),
      command: 'sdkmanager --install "emulator"',
    })
  } else if (issue === 'licensesNotAccepted') {
    steps.push({
      text: t('androidEmulator.onboarding.guide.acceptLicenses'),
      command: 'sdkmanager --licenses',
    })
  } else if (issue === 'systemImageMissing') {
    steps.push(
      {
        text: t('androidEmulator.onboarding.guide.listSystemImages'),
        command: 'sdkmanager --list',
      },
      {
        text: t('androidEmulator.onboarding.guide.installSystemImage'),
        command: 'sdkmanager --install "system-images;android-35;google_apis;arm64-v8a"',
      },
    )
  } else if (issue === 'avdMissing') {
    steps.push({
      text: t('androidEmulator.onboarding.guide.createAvd'),
      command: 'avdmanager create avd -n My_Device -k "system-images;android-35;google_apis;arm64-v8a"',
    })
  } else if (issue === 'accelMissing') {
    if (platform === 'win32') {
      steps.push(
        {
          text: t('androidEmulator.onboarding.guide.accelWindows'),
          command: 'dism.exe /online /enable-feature /featurename:HypervisorPlatform /all',
        },
        { text: t('androidEmulator.onboarding.guide.accelWindowsReboot') },
      )
    } else if (platform === 'linux') {
      steps.push(
        {
          text: t('androidEmulator.onboarding.guide.accelLinux'),
          command: 'sudo usermod -aG kvm $USER',
        },
        { text: t('androidEmulator.onboarding.guide.accelLinuxRelogin') },
      )
    } else {
      steps.push({ text: t('androidEmulator.onboarding.guide.accelMac') })
    }
  } else if (issue === 'discoveryFailed') {
    steps.push({
      text: t('androidEmulator.onboarding.guide.checkSdkPath'),
      command: 'sdkmanager --list_installed',
    })
  }
  // unsupportedPlatform: no steps — the issue text is the whole answer.

  if (steps.length === 0) return null
  return (
    <>
      <ol className="ios-onboarding-guide">
        {steps.map((step, index) => (
          <li key={index}>
            <span>{step.text}</span>
            {step.command && <CopyCommandButton command={step.command} />}
          </li>
        ))}
      </ol>
      <button
        type="button"
        className="ghost-button"
        onClick={() => { void openAndroidEmulatorGuideFolder(issue) }}
      >
        <FolderOpen size={12} aria-hidden="true" />
        {t('androidEmulator.onboarding.openFolder')}
      </button>
    </>
  )
}

async function openAndroidEmulatorGuideFolder(issue: AndroidEmulatorIssue) {
  try {
    if (issue === 'sdkMissing') {
      await openPath(await appDataDir())
      return
    }
    if (issue === 'avdMissing') {
      await openPath(await join(await homeDir(), '.android', 'avd'))
      return
    }
    await openPath(await join(await appDataDir(), 'android-sdk'))
  } catch {
    // The manual steps remain usable when the native opener is unavailable.
  }
}

/** Fail-open surface for backends that predate the android_emulator_*
 *  commands (contract: the tab never offers setup — it shows the guide).
 *  Rendered by the panel when android_emulator_requirements is unknown, and
 *  by the onboarding when setup_start is unknown. */
export function AndroidEmulatorLegacyCard({
  platform = 'darwin',
  requirementsLoading,
  onCheckAgain,
}: {
  platform?: NodeJS.Platform
  requirementsLoading: boolean
  onCheckAgain: () => void
}) {
  const { t } = useI18n()
  return (
    <div className="ios-simulator-requirement" role="alert">
      <Smartphone size={24} aria-hidden="true" />
      <strong>{t('androidEmulator.legacyTitle')}</strong>
      <p>{t('androidEmulator.legacyBody')}</p>
      <AndroidEmulatorManualGuide issue="sdkMissing" platform={platform} />
      <button
        type="button"
        className="ghost-button"
        onClick={onCheckAgain}
        disabled={requirementsLoading}
      >
        {t('androidEmulator.onboarding.checkAgain')}
      </button>
    </div>
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
        {copied ? t('androidEmulator.onboarding.copied') : t('androidEmulator.onboarding.copy')}
      </button>
    </span>
  )
}

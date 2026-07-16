import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../../components/Toast'
import { I18nProvider } from '../../i18n'
import { computerUseStore } from './computerUseStore'
import { ComputerUseLayer } from './ComputerUseLayer'

beforeEach(() => computerUseStore.__reset())
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ComputerUseLayer consent flow', () => {
  it('uses the compact header only after the matching native layout lease is compact', async () => {
    computerUseStore.__mockRequestConsent({ goal: 'Edit Notes', appName: 'Notes', isSelfTest: false })
    await computerUseStore.grant({ type: 'session' })
    const sessionId = computerUseStore.getSnapshot().session!.id

    computerUseStore.handleNativeLayoutState({ mode: 'entering', sessionId })
    const { rerender } = render(
      <I18nProvider language="en-US">
        <ComputerUseLayer />
      </I18nProvider>,
    )
    expect(screen.getByRole('region', { name: /controlling your computer/i })).toBeInTheDocument()
    expect(screen.queryByRole('banner')).not.toBeInTheDocument()

    act(() => computerUseStore.handleNativeLayoutState({ mode: 'compact', sessionId }))
    rerender(
      <I18nProvider language="en-US">
        <ComputerUseLayer />
      </I18nProvider>,
    )
    expect(screen.getByRole('banner')).toHaveTextContent('Verboo is using Notes')

    act(() => computerUseStore.handleNativeLayoutState({ mode: 'fallback', sessionId }))
    expect(screen.getByRole('region', { name: /controlling your computer/i })).toBeInTheDocument()
    expect(screen.queryByRole('banner')).not.toBeInTheDocument()
  })

  it('hydrates the compact lease for the exact recovered native session', async () => {
    const originalVerboo = (window as unknown as { verboo?: unknown }).verboo
    computerUseStore.__mockRequestConsent({
      goal: 'Edit Notes',
      appName: 'Notes',
      appBundleId: 'com.apple.Notes',
      isSelfTest: false,
    })
    await computerUseStore.grant({ type: 'session' })
    const sessionId = computerUseStore.getSnapshot().session!.id
    const getLayout = vi.fn().mockResolvedValue({
      mode: 'compact',
      sessionId,
      targetBundleId: 'com.apple.Notes',
    })
    ;(window as unknown as { verboo?: unknown }).verboo = {
      getComputerUseLayoutState: getLayout,
    }
    try {
      render(
        <I18nProvider language="en-US">
          <ComputerUseLayer />
        </I18nProvider>,
      )

      expect(await screen.findByRole('banner')).toHaveTextContent('Verboo is using Notes')
      expect(getLayout).toHaveBeenCalledOnce()
    } finally {
      ;(window as unknown as { verboo?: unknown }).verboo = originalVerboo
    }
  })

  it('keeps the compact header visible with one inline confirmation in the composer dock', async () => {
    const originalVerboo = (window as unknown as { verboo?: unknown }).verboo
    const dock = document.createElement('div')
    dock.className = 'bottom-dock'
    document.body.append(dock)
    const pending = {
      id: 'confirmation-inline',
      sessionId: 'session-inline',
      appBundleId: 'com.apple.Notes',
      action: 'left_click',
      summary: 'Delete content in the approved app',
      createdAt: 1,
      expiresAt: 2,
    }
    const getPending = vi.fn().mockResolvedValue(pending)
    ;(window as unknown as { verboo?: unknown }).verboo = {
      getPendingComputerUseConfirmation: getPending,
      decideComputerUseConfirmation: vi.fn().mockResolvedValue(undefined),
    }
    try {
      computerUseStore.__mockRequestConsent({
        goal: 'Edit Notes',
        appName: 'Notes',
        appBundleId: 'com.apple.Notes',
        isSelfTest: false,
      })
      await computerUseStore.grant({ type: 'session' })
      const sessionId = computerUseStore.getSnapshot().session!.id
      pending.sessionId = sessionId
      computerUseStore.handleNativeLayoutState({ mode: 'compact', sessionId })

      render(
        <I18nProvider language="en-US">
          <ComputerUseLayer />
        </I18nProvider>,
      )

      expect(await screen.findByRole('banner')).toHaveTextContent('Verboo is using Notes')
      expect(await screen.findByRole('alertdialog', { name: /confirm action/i })).toBeInTheDocument()
      expect(screen.queryByRole('dialog', { name: /confirm action/i })).not.toBeInTheDocument()
      expect(dock.querySelectorAll('.computer-use-confirmation-card')).toHaveLength(1)
      await new Promise(resolve => window.setTimeout(resolve, 350))
      expect(dock.querySelectorAll('.computer-use-confirmation-card')).toHaveLength(1)
    } finally {
      dock.remove()
      ;(window as unknown as { verboo?: unknown }).verboo = originalVerboo
    }
  })

  it('does not start until the user approves and reports the active session', async () => {
    const onSessionStarted = vi.fn()
    render(
      <I18nProvider language="en-US">
        <ComputerUseLayer onSessionStarted={onSessionStarted} />
      </I18nProvider>,
    )

    act(() => {
      computerUseStore.__mockRequestConsent({
        goal: 'Write in Notes',
        appName: 'Notes',
        appBundleId: 'com.apple.Notes',
        scope: 'full',
      })
    })

    expect(screen.getByRole('dialog', { name: /allow computer use/i })).toBeInTheDocument()
    expect(onSessionStarted).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /allow for this session/i }))
    await waitFor(() => expect(onSessionStarted).toHaveBeenCalledOnce())
    expect(onSessionStarted.mock.calls[0]?.[0]).toMatchObject({
      status: 'active',
      appName: 'Notes',
    })
  })

  it('denies without starting when the user cancels', async () => {
    const onSessionStarted = vi.fn()
    const onConsentDismissed = vi.fn()
    render(
      <I18nProvider language="en-US">
        <ComputerUseLayer
          onSessionStarted={onSessionStarted}
          onConsentDismissed={onConsentDismissed}
        />
      </I18nProvider>,
    )

    act(() => computerUseStore.__mockRequestConsent({ goal: 'Read Notes', appName: 'Notes' }))
    fireEvent.click(screen.getByRole('button', { name: /^deny$/i }))

    await waitFor(() => expect(onConsentDismissed).toHaveBeenCalledOnce())
    expect(onSessionStarted).not.toHaveBeenCalled()
  })

  it('interrupts the executor when the active banner is stopped', async () => {
    const onEmergencyStop = vi.fn()
    computerUseStore.__mockRequestConsent({ goal: 'Edit Notes', appName: 'Notes' })
    await computerUseStore.grant({ type: 'session' })

    render(
      <I18nProvider language="en-US">
        <ComputerUseLayer onEmergencyStop={onEmergencyStop} />
      </I18nProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /stop computer use/i }))
    expect(onEmergencyStop).toHaveBeenCalledOnce()
  })

  it('reports executor failures as errors instead of successful completion', async () => {
    const originalVerboo = (window as unknown as { verboo?: unknown }).verboo
    let complete: ((event: {
      sessionId: string
      conversationId: string
      executorModelId: string
      stoppedReason: 'executor_error'
    }) => void) | undefined
    const onTurnComplete = vi.fn()
    ;(window as unknown as { verboo?: unknown }).verboo = {
      onComputerUseTurnComplete: (callback: typeof complete) => {
        complete = callback
        return () => undefined
      },
    }
    try {
      computerUseStore.__mockRequestConsent({ goal: 'Edit Notes', appName: 'Notes' })
      await computerUseStore.grant({ type: 'session' })
      render(
        <I18nProvider language="en-US">
          <ComputerUseLayer onTurnComplete={onTurnComplete} />
        </I18nProvider>,
      )

      act(() => complete?.({
        sessionId: computerUseStore.getSnapshot().session?.id ?? 'session',
        conversationId: 'conversation-1',
        executorModelId: 'vision-model',
        stoppedReason: 'executor_error',
      }))

      expect(computerUseStore.getSnapshot().lastStop?.reason).toBe('error')
      expect(onTurnComplete).toHaveBeenCalledOnce()
    } finally {
      ;(window as unknown as { verboo?: unknown }).verboo = originalVerboo
    }
  })

  it('preserves cleanup_error and does not claim that control was returned', async () => {
    const originalVerboo = (window as unknown as { verboo?: unknown }).verboo
    let complete: ((event: {
      sessionId: string
      conversationId: string
      executorModelId: string
      stoppedReason: 'cleanup_error'
    }) => void) | undefined
    ;(window as unknown as { verboo?: unknown }).verboo = {
      onComputerUseTurnComplete: (callback: typeof complete) => {
        complete = callback
        return () => undefined
      },
    }
    try {
      computerUseStore.__mockRequestConsent({ goal: 'Edit Notes', appName: 'Notes' })
      await computerUseStore.grant({ type: 'session' })
      render(
        <I18nProvider language="en-US">
          <ComputerUseLayer />
        </I18nProvider>,
      )

      act(() => complete?.({
        sessionId: computerUseStore.getSnapshot().session?.id ?? 'session',
        conversationId: 'conversation-1',
        executorModelId: 'vision-model',
        stoppedReason: 'cleanup_error',
      }))

      expect(computerUseStore.getSnapshot().lastStop?.turnReason).toBe('cleanup_error')
      expect(screen.getByRole('status')).toHaveTextContent(/cleanup error/i)
      expect(screen.getByRole('status')).not.toHaveTextContent(/control returned to you/i)
    } finally {
      ;(window as unknown as { verboo?: unknown }).verboo = originalVerboo
    }
  })

  it('localizes app-list failures and never renders the raw error', async () => {
    const originalVerboo = (window as unknown as { verboo?: unknown }).verboo
    const rawError = new Error('private app inventory detail')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    ;(window as unknown as { verboo?: unknown }).verboo = {
      listComputerUseApps: vi.fn().mockRejectedValue(rawError),
    }
    try {
      computerUseStore.__mockRequestConsent({ goal: 'Edit Notes', appName: 'Notes' })
      await computerUseStore.grant({ type: 'session' })
      render(
        <I18nProvider language="pt-BR">
          <ToastProvider>
            <ComputerUseLayer />
          </ToastProvider>
        </I18nProvider>,
      )

      fireEvent.click(screen.getByRole('button', { name: /gerenciar apps/i }))

      expect(await screen.findByText('Não foi possível listar os apps em execução.')).toBeInTheDocument()
      expect(screen.queryByText(/private app inventory detail/i)).not.toBeInTheDocument()
      expect(consoleError).toHaveBeenCalledWith(
        '[computer-use] list running apps',
        rawError,
      )
    } finally {
      ;(window as unknown as { verboo?: unknown }).verboo = originalVerboo
    }
  })

  it('localizes empty app inventory copy', async () => {
    const originalVerboo = (window as unknown as { verboo?: unknown }).verboo
    ;(window as unknown as { verboo?: unknown }).verboo = {
      listComputerUseApps: vi.fn().mockResolvedValue([]),
    }
    try {
      computerUseStore.__mockRequestConsent({ goal: 'Edit Notes', appName: 'Notes' })
      await computerUseStore.grant({ type: 'session' })
      render(
        <I18nProvider language="pt-BR">
          <ToastProvider>
            <ComputerUseLayer />
          </ToastProvider>
        </I18nProvider>,
      )

      fireEvent.click(screen.getByRole('button', { name: /gerenciar apps/i }))

      expect(await screen.findByText('Nenhum app em execução disponível para controle foi encontrado.')).toBeInTheDocument()
    } finally {
      ;(window as unknown as { verboo?: unknown }).verboo = originalVerboo
    }
  })

  it('localizes app-approval failures and never renders the raw error', async () => {
    const originalVerboo = (window as unknown as { verboo?: unknown }).verboo
    const rawError = new Error('private approval detail')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(computerUseStore, 'approveApp').mockRejectedValueOnce(rawError)
    ;(window as unknown as { verboo?: unknown }).verboo = {
      listComputerUseApps: vi.fn().mockResolvedValue([
        { bundleId: 'com.apple.Notes', name: 'Notes', pid: 1, isFrontmost: false },
        { bundleId: 'com.google.Chrome', name: 'Google Chrome', pid: 2, isFrontmost: true },
      ]),
    }
    try {
      computerUseStore.__mockRequestConsent({ goal: 'Edit Notes', appName: 'Notes' })
      await computerUseStore.grant({ type: 'session' })
      render(
        <I18nProvider language="pt-BR">
          <ToastProvider>
            <ComputerUseLayer />
          </ToastProvider>
        </I18nProvider>,
      )

      fireEvent.click(screen.getByRole('button', { name: /gerenciar apps/i }))
      await screen.findByRole('dialog', { name: /gerenciar apps autorizados/i })
      fireEvent.click(screen.getByRole('button', { name: /google chrome/i }))
      fireEvent.click(screen.getByRole('button', { name: /autorizar e usar app/i }))

      expect(await screen.findByText('Não foi possível autorizar este app.')).toBeInTheDocument()
      expect(screen.queryByText(/private approval detail/i)).not.toBeInTheDocument()
      expect(consoleError).toHaveBeenCalledWith(
        '[computer-use] approve app',
        rawError,
      )
    } finally {
      ;(window as unknown as { verboo?: unknown }).verboo = originalVerboo
    }
  })

  it('localizes OS-permission and cleanup event failures', async () => {
    const originalVerboo = (window as unknown as { verboo?: unknown }).verboo
    let permissionRevoked: (() => void) | undefined
    let cleanupFailed: ((message: string) => void) | undefined
    const rawCleanupMessage = 'private cleanup detail'
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    ;(window as unknown as { verboo?: unknown }).verboo = {
      onComputerUseOsPermissionRevoked: (callback: typeof permissionRevoked) => {
        permissionRevoked = callback
        return () => undefined
      },
      onComputerUseCleanupFailed: (callback: typeof cleanupFailed) => {
        cleanupFailed = callback
        return () => undefined
      },
    }
    try {
      computerUseStore.__mockRequestConsent({ goal: 'Edit Notes', appName: 'Notes' })
      await computerUseStore.grant({ type: 'session' })
      render(
        <I18nProvider language="pt-BR">
          <ToastProvider>
            <ComputerUseLayer />
          </ToastProvider>
        </I18nProvider>,
      )

      act(() => permissionRevoked?.())
      expect(await screen.findByText(/Acessibilidade ou Gravação da Tela do macOS foi revogada/i)).toBeInTheDocument()

      act(() => cleanupFailed?.(rawCleanupMessage))
      expect(await screen.findByText(/não conseguiu concluir a limpeza com segurança/i)).toBeInTheDocument()
      expect(screen.queryByText(rawCleanupMessage)).not.toBeInTheDocument()
      expect(consoleError).toHaveBeenCalledWith(
        '[computer-use] cleanup failed',
        rawCleanupMessage,
      )
    } finally {
      ;(window as unknown as { verboo?: unknown }).verboo = originalVerboo
    }
  })

  it('pauses and explicitly approves another running app before activating it', async () => {
    const originalVerboo = (window as unknown as { verboo?: unknown }).verboo
    ;(window as unknown as { verboo?: unknown }).verboo = {
      listComputerUseApps: vi.fn().mockResolvedValue([
        { bundleId: 'com.apple.Notes', name: 'Notes', pid: 1, isFrontmost: false },
        { bundleId: 'com.google.Chrome', name: 'Google Chrome', pid: 2, isFrontmost: true },
      ]),
    }
    try {
      computerUseStore.__mockRequestConsent({
        goal: 'Use two apps',
        appName: 'Notes',
        appBundleId: 'com.apple.Notes',
        scope: 'full',
        requestedTier: 'full_control',
      })
      await computerUseStore.grant({ type: 'session' })

      render(
        <I18nProvider language="en-US">
          <ComputerUseLayer />
        </I18nProvider>,
      )
      fireEvent.click(screen.getByRole('button', { name: /manage apps/i }))

      await screen.findByRole('dialog', { name: /manage approved apps/i })
      expect(computerUseStore.getSnapshot().status).toBe('paused')
      fireEvent.click(screen.getByRole('button', { name: /google chrome/i }))
      fireEvent.click(screen.getByRole('button', { name: /approve and use app/i }))

      await waitFor(() => {
        expect(computerUseStore.getSnapshot().status).toBe('active')
        expect(computerUseStore.getSnapshot().session?.appName).toBe('Google Chrome')
      })
    } finally {
      ;(window as unknown as { verboo?: unknown }).verboo = originalVerboo
    }
  })

  it('keeps control active and shows localized feedback when pausing fails', async () => {
    const originalVerboo = (window as unknown as { verboo?: unknown }).verboo
    const pauseError = new Error('private pause detail')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      ;(window as unknown as { verboo?: unknown }).verboo = undefined
      computerUseStore.__mockRequestConsent({ goal: 'Edit Notes', appName: 'Notes' })
      await computerUseStore.grant({ type: 'session' })
      ;(window as unknown as { verboo?: unknown }).verboo = {
        pauseComputerUseSession: vi.fn().mockRejectedValue(pauseError),
      }
      render(
        <I18nProvider language="pt-BR">
          <ToastProvider>
            <ComputerUseLayer />
          </ToastProvider>
        </I18nProvider>,
      )

      fireEvent.click(screen.getByRole('button', { name: /^pausar$/i }))

      expect(await screen.findByText(
        'Não foi possível pausar o Computer Use com segurança. O controle pode continuar ativo; pressione Esc para parar.',
      )).toBeInTheDocument()
      expect(computerUseStore.getSnapshot().status).toBe('active')
      expect(screen.queryByText(/private pause detail/i)).not.toBeInTheDocument()
      expect(consoleError).toHaveBeenCalledWith('[computer-use] pause session', pauseError)
    } finally {
      ;(window as unknown as { verboo?: unknown }).verboo = originalVerboo
    }
  })

  it('keeps control paused and shows localized feedback when resuming fails', async () => {
    const originalVerboo = (window as unknown as { verboo?: unknown }).verboo
    const resumeError = new Error('private resume detail')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      ;(window as unknown as { verboo?: unknown }).verboo = undefined
      computerUseStore.__mockRequestConsent({ goal: 'Edit Notes', appName: 'Notes' })
      await computerUseStore.grant({ type: 'session' })
      await computerUseStore.pause()
      ;(window as unknown as { verboo?: unknown }).verboo = {
        resumeComputerUseSession: vi.fn().mockRejectedValue(resumeError),
      }
      render(
        <I18nProvider language="pt-BR">
          <ToastProvider>
            <ComputerUseLayer />
          </ToastProvider>
        </I18nProvider>,
      )

      fireEvent.click(screen.getByRole('button', { name: /^continuar$/i }))

      expect(await screen.findByText(
        'Não foi possível retomar o Computer Use. O controle permanece pausado.',
      )).toBeInTheDocument()
      expect(computerUseStore.getSnapshot().status).toBe('paused')
      expect(screen.queryByText(/private resume detail/i)).not.toBeInTheDocument()
      expect(consoleError).toHaveBeenCalledWith('[computer-use] resume session', resumeError)
    } finally {
      ;(window as unknown as { verboo?: unknown }).verboo = originalVerboo
    }
  })

  it('keeps the active banner and shows localized feedback when stop cannot be confirmed', async () => {
    const originalVerboo = (window as unknown as { verboo?: unknown }).verboo
    const stopError = new Error('private stop detail')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      ;(window as unknown as { verboo?: unknown }).verboo = undefined
      computerUseStore.__mockRequestConsent({ goal: 'Edit Notes', appName: 'Notes' })
      await computerUseStore.grant({ type: 'session' })
      ;(window as unknown as { verboo?: unknown }).verboo = {
        requestComputerUseSession: vi.fn(),
        stopComputerUseSession: vi.fn().mockRejectedValue(stopError),
      }
      render(
        <I18nProvider language="pt-BR">
          <ToastProvider>
            <ComputerUseLayer />
          </ToastProvider>
        </I18nProvider>,
      )

      fireEvent.click(screen.getByRole('button', { name: /parar computer use/i }))

      expect(await screen.findByText(
        'Não foi possível confirmar que o Computer Use parou. Pressione Esc novamente para tentar interromper o controle.',
      )).toBeInTheDocument()
      expect(computerUseStore.getSnapshot().status).toBe('active')
      expect(screen.queryByText(/private stop detail/i)).not.toBeInTheDocument()
      expect(consoleError).toHaveBeenCalledWith('[computer-use] stop session', stopError)
    } finally {
      ;(window as unknown as { verboo?: unknown }).verboo = originalVerboo
    }
  })

  it('clears an open app picker when the session enters a terminal state', async () => {
    const originalVerboo = (window as unknown as { verboo?: unknown }).verboo
    ;(window as unknown as { verboo?: unknown }).verboo = {
      listComputerUseApps: vi.fn().mockResolvedValue([
        { bundleId: 'com.apple.Notes', name: 'Notes', pid: 1, isFrontmost: true },
      ]),
    }
    try {
      computerUseStore.__mockRequestConsent({ goal: 'Edit Notes', appName: 'Notes' })
      await computerUseStore.grant({ type: 'session' })
      render(
        <I18nProvider language="en-US">
          <ComputerUseLayer />
        </I18nProvider>,
      )

      fireEvent.click(screen.getByRole('button', { name: /manage apps/i }))
      await screen.findByRole('dialog', { name: /manage approved apps/i })

      act(() => computerUseStore.handleNativeRevocation('error'))

      await waitFor(() => {
        expect(screen.queryByRole('dialog', { name: /manage approved apps/i })).not.toBeInTheDocument()
        expect(screen.getByRole('status')).toHaveTextContent(/Computer Use stopped/i)
      })
    } finally {
      ;(window as unknown as { verboo?: unknown }).verboo = originalVerboo
    }
  })

  it('polls for a consequential action and sends an exact one-shot decision', async () => {
    const originalVerboo = (window as unknown as { verboo?: unknown }).verboo
    const getPending = vi.fn()
      .mockResolvedValueOnce({
        id: 'confirmation-1',
        sessionId: 'session-1',
        appBundleId: 'com.apple.Notes',
        action: 'left_click',
        summary: 'Delete “Draft”',
        createdAt: 1,
        expiresAt: 2,
      })
      .mockResolvedValue(null)
    const decide = vi.fn().mockResolvedValue(undefined)
    ;(window as unknown as { verboo?: unknown }).verboo = {
      getPendingComputerUseConfirmation: getPending,
      decideComputerUseConfirmation: decide,
    }
    try {
      computerUseStore.__mockRequestConsent({
        goal: 'Edit Notes',
        appName: 'Notes',
        appBundleId: 'com.apple.Notes',
        scope: 'full',
      })
      await computerUseStore.grant({ type: 'session' })

      render(
        <I18nProvider language="en-US">
          <ComputerUseLayer />
        </I18nProvider>,
      )

      await screen.findByRole('dialog', { name: /confirm action/i })
      fireEvent.click(screen.getByRole('button', { name: /allow once/i }))

      await waitFor(() => expect(decide).toHaveBeenCalledWith(
        computerUseStore.getSnapshot().session?.id,
        'confirmation-1',
        true,
      ))
      await waitFor(() => {
        expect(screen.queryByRole('dialog', { name: /confirm action/i })).not.toBeInTheDocument()
      })
      expect(computerUseStore.getSnapshot().status).toBe('active')
      expect(screen.getByRole('region')).toBeInTheDocument()
    } finally {
      ;(window as unknown as { verboo?: unknown }).verboo = originalVerboo
    }
  })
})

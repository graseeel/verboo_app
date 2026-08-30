import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import { AppSidebar } from './AppSidebar'

describe('AppSidebar', () => {
  it('keeps the update control in the fixed footer above the account', () => {
    render(
      <I18nProvider language="en-US">
        <AppSidebar
          activeView="chat"
          projects={Array.from({ length: 12 }, (_, index) => ({
            id: `project-${index}`,
            name: `Project ${index}`,
            path: `/tmp/project-${index}`,
            collapsed: false,
            createdAt: index,
            updatedAt: index,
          }))}
          conversations={[]}
          profile={{ status: 'ready', user: { name: 'Gabriel' } }}
          cliAuth={{ loggedIn: true }}
          updatePresentation={{
            phase: 'available',
            version: '0.6.0',
            actionEnabled: true,
          }}
          onRequestUpdate={vi.fn()}
          onSelectView={vi.fn()}
          onOpenSettings={vi.fn()}
          onOpenSearch={vi.fn()}
          onOpenFeedback={vi.fn()}
          onLogout={vi.fn()}
          onNewChat={vi.fn()}
          onToggleSidebar={vi.fn()}
          onOpenProject={vi.fn()}
          onSelectConversation={vi.fn()}
          onToggleProject={vi.fn()}
          onRenameProject={vi.fn()}
          onArchiveProject={vi.fn()}
          onDeleteProject={vi.fn()}
          onArchiveConversation={vi.fn()}
          archivedConversations={[]}
          onRestoreConversation={vi.fn()}
          onDeleteConversation={vi.fn()}
          onRenameConversation={vi.fn()}
        />
      </I18nProvider>,
    )

    const updateAction = screen.getByRole('button', { name: 'Download Verboo Code 0.6.0' })
    const accountAction = screen.getByRole('button', { name: /Gabriel/i })
    const footer = updateAction.closest('.sidebar-account-wrap')

    expect(footer).not.toBeNull()
    expect(updateAction.closest('.sidebar-scroll')).toBeNull()
    expect(updateAction.compareDocumentPosition(accountAction) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it.each([
    ['en-US' as const, 'Plan unavailable'],
    ['pt-BR' as const, 'Plano indisponível'],
  ])('uses the Account unavailable plan copy in %s', (language, unavailableCopy) => {
    render(
      <I18nProvider language={language}>
        <AppSidebar
          activeView="chat"
          projects={[]}
          conversations={[]}
          profile={{ status: 'error', user: { name: 'Gabriel' }, error: 'offline' }}
          cliAuth={{ loggedIn: true }}
          onSelectView={vi.fn()}
          onOpenSettings={vi.fn()}
          onOpenSearch={vi.fn()}
          onOpenFeedback={vi.fn()}
          onLogout={vi.fn()}
          onNewChat={vi.fn()}
          onToggleSidebar={vi.fn()}
          onOpenProject={vi.fn()}
          onSelectConversation={vi.fn()}
          onToggleProject={vi.fn()}
          onRenameProject={vi.fn()}
          onArchiveProject={vi.fn()}
          onDeleteProject={vi.fn()}
          onArchiveConversation={vi.fn()}
          archivedConversations={[]}
          onRestoreConversation={vi.fn()}
          onDeleteConversation={vi.fn()}
          onRenameConversation={vi.fn()}
        />
      </I18nProvider>,
    )

    expect(screen.getByRole('button', { name: /Gabriel/ })).toHaveTextContent(unavailableCopy)
  })

  it.each([
    ['en-US' as const, 'API key ready for inference', 'Plan unavailable'],
    ['pt-BR' as const, 'Chave de API pronta para inferência', 'Plano indisponível'],
  ])(
    'uses the inference-only account copy in %s instead of an unavailable plan',
    (language, apiKeyOnlyCopy, unavailableCopy) => {
      render(
        <I18nProvider language={language}>
          <AppSidebar
            activeView="chat"
            projects={[]}
            conversations={[]}
            profile={{ status: 'api-key-only', user: { name: 'Gabriel' } }}
            cliAuth={{ loggedIn: false }}
            onSelectView={vi.fn()}
            onOpenSettings={vi.fn()}
            onOpenSearch={vi.fn()}
            onOpenFeedback={vi.fn()}
            onLogout={vi.fn()}
            onNewChat={vi.fn()}
            onToggleSidebar={vi.fn()}
            onOpenProject={vi.fn()}
            onSelectConversation={vi.fn()}
            onToggleProject={vi.fn()}
            onRenameProject={vi.fn()}
            onArchiveProject={vi.fn()}
            onDeleteProject={vi.fn()}
            onArchiveConversation={vi.fn()}
            archivedConversations={[]}
            onRestoreConversation={vi.fn()}
            onDeleteConversation={vi.fn()}
            onRenameConversation={vi.fn()}
          />
        </I18nProvider>,
      )

      const accountAction = screen.getByRole('button', { name: /Gabriel/ })
      expect(accountAction).toHaveTextContent(apiKeyOnlyCopy)
      expect(accountAction).not.toHaveTextContent(unavailableCopy)
    },
  )
})

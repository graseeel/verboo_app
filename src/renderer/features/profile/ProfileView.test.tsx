import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '../../i18n'
import { ToastProvider } from '../../components/Toast'
import { ProfileView } from './ProfileView'
import type { ProfileResult } from '../../../shared/types'

const readyProfile: ProfileResult = {
  status: 'ready',
  user: { name: 'Ada' },
  summary: { totalTokens: 1, tokensInTotal: 1, tokensOutTotal: 0, reqTotal: 1 },
  plan: { name: 'Pro', status: 'active' },
}

const apiKeyOnlyProfile: ProfileResult = { status: 'api-key-only' }

function renderProfile(
  language: 'en-US' | 'pt-BR' = 'en-US',
  profile: ProfileResult = readyProfile,
) {
  return render(
    <I18nProvider language={language}>
      <ToastProvider>
        <ProfileView
          profile={profile}
          loading={false}
          avatarSettings={{ kind: 'preset', presetId: 'cat', presetColor: '#6B7280' }}
          onRefresh={() => {}}
          onManagePlan={() => {}}
          onUpdateAvatar={() => {}}
        />
      </ToastProvider>
    </I18nProvider>,
  )
}

afterEach(cleanup)

beforeEach(() => {
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:preview'),
    revokeObjectURL: vi.fn(),
  })
  ;(window as unknown as { verboo: unknown }).verboo = {
    saveAvatarBlob: vi.fn(async () => '/tmp/avatar.jpg'),
  }
})

describe('ProfileView → avatar upload control (issue #92)', () => {
  it('renders a styled Settings button and keeps the file input screen-reader accessible', () => {
    renderProfile()

    const input = screen.getByLabelText('Upload photo')
    expect(input).toHaveAttribute('type', 'file')
    expect(input).toHaveClass('sr-only')

    const button = screen.getByRole('button', { name: 'Upload photo' })
    expect(button).toHaveClass('button', 'button-sm', 'button-secondary')
    expect(button).not.toHaveAttribute('type', 'file')
  })

  it('shows the empty-state copy before a file is chosen', () => {
    renderProfile()
    expect(screen.getByText('No file selected')).toBeInTheDocument()
  })

  it('displays the selected file name after the change handler runs', () => {
    renderProfile()
    const input = screen.getByLabelText('Upload photo')
    const file = new File(['pixels'], 'portrait.png', { type: 'image/png' })

    fireEvent.change(input, { target: { files: [file] } })

    expect(screen.getByText('portrait.png')).toBeInTheDocument()
    expect(screen.queryByText('No file selected')).not.toBeInTheDocument()
  })

  it('opens the native picker when the styled button is clicked', () => {
    renderProfile()
    const input = screen.getByLabelText('Upload photo') as HTMLInputElement
    const clickSpy = vi.spyOn(input, 'click')

    fireEvent.click(screen.getByRole('button', { name: 'Upload photo' }))

    expect(clickSpy).toHaveBeenCalledTimes(1)
  })

  it('uses the Portuguese empty-state copy in pt-BR', () => {
    renderProfile('pt-BR')
    expect(screen.getByText('Nenhum arquivo selecionado')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Enviar foto' })).toBeInTheDocument()
  })

  it('resets the input after a pick so re-selecting the same file fires the handler again', () => {
    renderProfile()
    const input = screen.getByLabelText('Upload photo')
    // Pinned contract: a real browser only fires change on a second pick of the
    // SAME file if the first pick cleared the input value (issue #92, review
    // F2). jsdom never updates .value from an assigned FileList, and React
    // installs an own-property value tracker on the node — so the observable
    // seam is the node's own value setter being called with ''.
    const descriptor = Object.getOwnPropertyDescriptor(input, 'value')
      ?? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!
    const valueReset = vi.fn((value: string) => descriptor.set!.call(input, value))
    Object.defineProperty(input, 'value', { ...descriptor, set: valueReset })
    const file = new File(['pixels'], 'portrait.png', { type: 'image/png' })

    fireEvent.change(input, { target: { files: [file] } })

    expect(valueReset).toHaveBeenCalledWith('')
  })
})

describe('ProfileView → inference API key without account OAuth (issue #102)', () => {
  it('explains the account login requirement in English without empty account placeholders', () => {
    renderProfile('en-US', apiKeyOnlyProfile)

    expect(screen.getByText('API key ready for inference')).toBeInTheDocument()
    expect(screen.getByText(
      'Plan and usage details require an account login. Sign in to Verboo through the CLI, then refresh this page.',
    )).toBeInTheDocument()
    expect(screen.queryByText(
      'Configure or update the API key below to load usage and plan details.',
    )).not.toBeInTheDocument()
    expect(screen.queryAllByText('Unavailable')).toHaveLength(0)
    expect(screen.queryByText('Plan unavailable')).not.toBeInTheDocument()
  })

  it('explains the account login requirement in Portuguese without empty account placeholders', () => {
    renderProfile('pt-BR', apiKeyOnlyProfile)

    expect(screen.getByText('Chave de API pronta para inferência')).toBeInTheDocument()
    expect(screen.getByText(
      'Detalhes do plano e do consumo exigem login na conta. Entre no Verboo pelo CLI e atualize esta página.',
    )).toBeInTheDocument()
    expect(screen.queryByText(
      'Configure ou atualize a chave de API abaixo para carregar o consumo e os detalhes do plano.',
    )).not.toBeInTheDocument()
    expect(screen.queryAllByText('Indisponível')).toHaveLength(0)
    expect(screen.queryByText('Plano indisponível')).not.toBeInTheDocument()
  })
})

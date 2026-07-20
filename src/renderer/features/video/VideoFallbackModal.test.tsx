import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../../i18n'
import { VideoFallbackModal, videoConsentAction } from './VideoFallbackModal'

function renderModal(onRespond = vi.fn()) {
  render(
    <I18nProvider language="en-US">
      <VideoFallbackModal route="sampledFramesWithTranscript" onRespond={onRespond} />
    </I18nProvider>,
  )
  return onRespond
}

describe('VideoFallbackModal', () => {
  it('approves Ask once without persisting', () => {
    const onRespond = renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Allow this time' }))
    expect(onRespond).toHaveBeenCalledWith({ allowOnce: true })
  })

  it('can remember Always or deny future video understanding', () => {
    const onRespond = renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Always allow' }))
    expect(onRespond).toHaveBeenCalledWith({ persist: 'always' })

    fireEvent.click(screen.getByRole('button', { name: 'Never allow' }))
    expect(onRespond).toHaveBeenCalledWith({ persist: 'never' })
  })

  it('maps stored Always and Never without opening a prompt', () => {
    expect(videoConsentAction('always')).toBe('proceed')
    expect(videoConsentAction('never')).toBe('reject')
    expect(videoConsentAction('ask')).toBe('prompt')
  })

  it('cancels on Escape and focuses Cancel by default', () => {
    const onRespond = renderModal()
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onRespond).toHaveBeenCalledWith({ cancel: true })
  })

  it('traps focus, makes the background inert, cleans up and restores focus', () => {
    const previous = document.createElement('button')
    previous.textContent = 'Before modal'
    document.body.append(previous)
    previous.focus()
    const onRespond = vi.fn()
    const view = render(
      <div>
        <button type="button">Background action</button>
        <I18nProvider language="en-US">
          <VideoFallbackModal route="sampledFramesWithTranscript" onRespond={onRespond} />
        </I18nProvider>
      </div>,
    )

    const cancel = screen.getByRole('button', { name: 'Cancel' })
    const never = screen.getByRole('button', { name: 'Never allow' })
    const background = screen.getByRole('button', { name: 'Background action' })
    expect(background).toHaveAttribute('inert')
    expect(cancel).toHaveFocus()

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(never).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(cancel).toHaveFocus()

    view.unmount()
    expect(background).not.toHaveAttribute('inert')
    expect(previous).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onRespond).not.toHaveBeenCalled()
    previous.remove()
  })

  it('discloses the exact non-native route', () => {
    renderModal()
    expect(screen.getByText(/sampled frames plus a local audio transcript/i)).toBeInTheDocument()
    expect(screen.queryByText(/native video/i)).not.toBeInTheDocument()
  })

  it.each([
    ['nativeOriginal', /original video will be sent directly/i],
    ['nativeSdrProxy', /SDR proxy.*will be sent.*original video will not/i],
    ['sampledFramesWithTranscript', /sampled frames plus a local audio transcript.*will be sent.*original video will not/i],
  ] as const)('names the exact %s route', (route, disclosure) => {
    render(
      <I18nProvider language="en-US">
        <VideoFallbackModal route={route} onRespond={vi.fn()} />
      </I18nProvider>,
    )
    expect(screen.getByText(disclosure)).toBeInTheDocument()
  })
})

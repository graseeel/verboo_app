import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SimulatorSurface } from './SimulatorSurface'
import type { IosSimulatorPresenceEvent } from './iosSimulatorApi'
import { paintedContainRect } from './simulatorGeometry'

function renderSurface(
  mode: 'interact' | 'select-area' = 'interact',
  agentPresence?: IosSimulatorPresenceEvent,
) {
  const callbacks = {
    onTap: vi.fn(),
    onDrag: vi.fn(),
    onTypeText: vi.fn(),
    onPressKey: vi.fn(),
    onModeChange: vi.fn(),
    onCaptureAnnotation: vi.fn().mockResolvedValue({
      cropPath: '/tmp/verboo-ios-simulator/a-crop.png',
      viewportPath: '/tmp/verboo-ios-simulator/a-viewport.png',
      cropWidth: 100, cropHeight: 48, viewportWidth: 393, viewportHeight: 852,
      cropBytes: 100, viewportBytes: 200,
      device: { name: 'iPhone 17 Pro', udid: 'phone', state: 'Booted', iosVersion: '26.5' },
      orientation: 'portrait', deviceGeneration: 1, frameGeneration: 2,
      rect: { x: 120 / 393, y: 180 / 852, width: 100 / 393, height: 48 / 852 },
      deviceRect: { x: 120, y: 180, width: 100, height: 48 },
      element: {
        id: 'save', role: 'Button', label: 'Save', frame: { x: 120, y: 180, width: 100, height: 48 },
        enabled: true, visible: true, actionable: true,
      },
    }),
    onDeleteCapture: vi.fn().mockResolvedValue(undefined),
    onAddAnnotation: vi.fn(),
  }
  render(
    <SimulatorSurface
      frameDataUrl="data:image/jpeg;base64,frame"
      deviceName="iPhone 17 Pro"
      previewAlt="Live iPhone preview"
      mode={mode}
      interactive
      labels={{
        interact: 'Interact',
        selectArea: 'Select area',
        interaction: 'Control iPhone 17 Pro',
        keyboardHint: 'Type, paste, or use special keys. Escape releases focus.',
        unavailable: 'Interaction unavailable',
        note: 'Instruction',
        notePlaceholder: 'Describe the change',
        addToChat: 'Add to chat',
        cancel: 'Cancel',
        capturing: 'Capturing selection…',
        selectionTooSmall: 'Select a larger area.',
        agentActive: 'Verboo is controlling this simulator.',
      }}
      agentPresence={agentPresence}
      {...callbacks}
    />,
  )
  const surface = screen.getByRole('application')
  const image = screen.getByAltText('Live iPhone preview')
  Object.defineProperty(surface, 'getBoundingClientRect', {
    value: () => ({ left: 0, top: 0, width: 600, height: 900, right: 600, bottom: 900 }),
  })
  Object.defineProperty(image, 'naturalWidth', { value: 393, configurable: true })
  Object.defineProperty(image, 'naturalHeight', { value: 852, configurable: true })
  Object.defineProperty(surface, 'setPointerCapture', { value: vi.fn(), configurable: true })
  Object.defineProperty(surface, 'releasePointerCapture', { value: vi.fn(), configurable: true })
  return { surface, callbacks }
}

describe('SimulatorSurface', () => {
  it('bounds agent presence to the object-fit painted device instead of the whole surface', () => {
    const bounds = vi.spyOn(HTMLDivElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 600, height: 900, right: 600, bottom: 900,
      x: 0, y: 0, toJSON: () => ({}),
    })
    const naturalWidth = vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(393)
    const naturalHeight = vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(852)

    renderSurface('interact', {
      generation: 4,
      phase: 'start',
      action: 'tap',
      target: { x: 0.5, y: 0.5 },
    })

    const expected = paintedContainRect({ width: 600, height: 900 }, { width: 393, height: 852 })
    const overlay = screen.getByTestId('simulator-presence-overlay')
    expect(Number.parseFloat(overlay.style.left)).toBeCloseTo(expected.x)
    expect(Number.parseFloat(overlay.style.top)).toBeCloseTo(expected.y)
    expect(Number.parseFloat(overlay.style.width)).toBeCloseTo(expected.width)
    expect(Number.parseFloat(overlay.style.height)).toBeCloseTo(expected.height)
    expect(Number.parseFloat(overlay.style.width)).toBeLessThan(600)

    bounds.mockRestore()
    naturalWidth.mockRestore()
    naturalHeight.mockRestore()
  })

  it('paints presence after the first image load establishes stable intrinsic dimensions', () => {
    renderSurface('interact', {
      generation: 5,
      phase: 'start',
      action: 'drag',
      start: { x: 0.2, y: 0.45 },
      end: { x: 0.8, y: 0.55 },
    })

    expect(screen.queryByTestId('simulator-presence-overlay')).toBeNull()
    fireEvent.load(screen.getByAltText('Live iPhone preview'))
    expect(screen.getByTestId('simulator-presence-overlay')).toBeInTheDocument()
  })

  it('distinguishes a tap from a drag using device-relative coordinates', () => {
    const { surface, callbacks } = renderSurface()

    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, clientX: 200, clientY: 300 })
    fireEvent.pointerUp(surface, { pointerId: 1, button: 0, clientX: 202, clientY: 302 })
    expect(callbacks.onTap).toHaveBeenCalledWith(expect.objectContaining({
      x: expect.any(Number),
      y: expect.any(Number),
    }))
    expect(callbacks.onDrag).not.toHaveBeenCalled()

    fireEvent.pointerDown(surface, { pointerId: 2, button: 0, clientX: 200, clientY: 700 })
    fireEvent.pointerMove(surface, { pointerId: 2, clientX: 200, clientY: 200 })
    fireEvent.pointerUp(surface, { pointerId: 2, button: 0, clientX: 200, clientY: 200 })
    expect(callbacks.onDrag).toHaveBeenCalledTimes(1)
    expect(callbacks.onDrag).toHaveBeenCalledWith(
      expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
      expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
      180,
    )
  })

  it('routes text, paste, composition, and supported special keys', () => {
    const { surface, callbacks } = renderSurface()
    surface.focus()

    fireEvent.keyDown(surface, { key: 'a' })
    fireEvent.paste(surface, { clipboardData: { getData: () => ' colado' } })
    fireEvent.compositionStart(surface)
    fireEvent.keyDown(surface, { key: 'x', isComposing: true })
    fireEvent.compositionEnd(surface, { data: 'ção' })
    fireEvent.keyDown(surface, { key: 'Backspace' })

    expect(callbacks.onTypeText).toHaveBeenNthCalledWith(1, 'a')
    expect(callbacks.onTypeText).toHaveBeenNthCalledWith(2, ' colado')
    expect(callbacks.onTypeText).toHaveBeenNthCalledWith(3, 'ção')
    expect(callbacks.onPressKey).toHaveBeenCalledWith('backspace')
  })

  it('leaves shortcuts to the app and Escape releases focus without WDA input', () => {
    const { surface, callbacks } = renderSurface()
    surface.focus()

    const shortcut = new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true, cancelable: true })
    surface.dispatchEvent(shortcut)
    expect(shortcut.defaultPrevented).toBe(false)
    expect(callbacks.onTypeText).not.toHaveBeenCalled()

    fireEvent.keyDown(surface, { key: 'Escape' })
    expect(surface).not.toHaveFocus()
    expect(callbacks.onPressKey).not.toHaveBeenCalled()
  })

  it('rejects letterbox gestures and cancels incomplete pointers', () => {
    const { surface, callbacks } = renderSurface()

    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, clientX: 50, clientY: 200 })
    fireEvent.pointerUp(surface, { pointerId: 1, button: 0, clientX: 50, clientY: 200 })
    fireEvent.pointerDown(surface, { pointerId: 2, button: 0, clientX: 200, clientY: 300 })
    fireEvent.pointerCancel(surface, { pointerId: 2 })

    expect(callbacks.onTap).not.toHaveBeenCalled()
    expect(callbacks.onDrag).not.toHaveBeenCalled()
  })

  it('offers interaction and rectangular selection without the unsafe accessibility mode', () => {
    renderSurface()

    expect(screen.getByRole('button', { name: 'Interact' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Select area' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Select component' })).not.toBeInTheDocument()
  })
})

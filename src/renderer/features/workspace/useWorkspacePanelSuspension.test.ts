import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useWorkspacePanelSuspension } from './useWorkspacePanelSuspension'

type Props = {
  isFullscreenView: boolean
  isChatView: boolean
  terminalOpen: boolean
  reviewOpen: boolean
  browserOpen: boolean
  simulatorOpen?: boolean
}

const chatWithoutPanels: Props = {
  isFullscreenView: false,
  isChatView: true,
  terminalOpen: false,
  reviewOpen: false,
  browserOpen: false,
}

const fullscreenWithoutPanels: Props = {
  ...chatWithoutPanels,
  isFullscreenView: true,
  isChatView: false,
}

function setup(initialProps: Props) {
  const closeAll = vi.fn()
  const restorePanel = vi.fn()
  const view = renderHook((props: Props) => useWorkspacePanelSuspension({
    ...props,
    closeAll,
    restorePanel,
  }), { initialProps })
  return { ...view, closeAll, restorePanel }
}

describe('useWorkspacePanelSuspension', () => {
  it('suspends the browser in Settings and restores it once in Chat', () => {
    const test = setup({ ...chatWithoutPanels, browserOpen: true })

    act(() => test.rerender({ ...fullscreenWithoutPanels, browserOpen: true }))

    expect(test.result.current.workspacePanelsEnabled).toBe(false)
    expect(test.closeAll).toHaveBeenCalledTimes(1)

    act(() => test.rerender(fullscreenWithoutPanels))
    act(() => test.rerender(chatWithoutPanels))
    act(() => test.rerender(chatWithoutPanels))

    expect(test.restorePanel).toHaveBeenCalledTimes(1)
    expect(test.restorePanel).toHaveBeenCalledWith('browser')
  })

  it('suspends the terminal in Profile and restores its panel in Chat', () => {
    const test = setup({ ...chatWithoutPanels, terminalOpen: true })

    act(() => test.rerender({ ...fullscreenWithoutPanels, terminalOpen: true }))
    act(() => test.rerender(fullscreenWithoutPanels))
    act(() => test.rerender(chatWithoutPanels))

    expect(test.restorePanel).toHaveBeenCalledWith('terminal')
  })

  it('preserves review suspension across Settings to Profile', () => {
    const test = setup({ ...chatWithoutPanels, reviewOpen: true })

    act(() => test.rerender({ ...fullscreenWithoutPanels, reviewOpen: true }))
    act(() => test.rerender(fullscreenWithoutPanels))
    act(() => test.rerender(fullscreenWithoutPanels))
    act(() => test.rerender(chatWithoutPanels))

    expect(test.restorePanel).toHaveBeenCalledTimes(1)
    expect(test.restorePanel).toHaveBeenCalledWith('review')
  })

  it('restores nothing when fullscreen was entered without a panel', () => {
    const test = setup(chatWithoutPanels)

    act(() => test.rerender(fullscreenWithoutPanels))
    act(() => test.rerender(chatWithoutPanels))

    expect(test.closeAll).not.toHaveBeenCalled()
    expect(test.restorePanel).not.toHaveBeenCalled()
  })

  it('closes an automatic browser open without replacing the suspended terminal', () => {
    const test = setup({ ...chatWithoutPanels, terminalOpen: true })

    act(() => test.rerender({ ...fullscreenWithoutPanels, terminalOpen: true }))
    act(() => test.rerender(fullscreenWithoutPanels))
    act(() => test.rerender({ ...fullscreenWithoutPanels, browserOpen: true }))

    expect(test.closeAll).toHaveBeenCalledTimes(2)

    act(() => test.rerender(fullscreenWithoutPanels))
    act(() => test.rerender(chatWithoutPanels))

    expect(test.restorePanel).toHaveBeenCalledTimes(1)
    expect(test.restorePanel).toHaveBeenCalledWith('terminal')
  })

  it('suspends and restores the simulator panel through Settings', () => {
    const test = setup({ ...chatWithoutPanels, simulatorOpen: true })

    act(() => test.rerender({ ...fullscreenWithoutPanels, simulatorOpen: true }))
    act(() => test.rerender(fullscreenWithoutPanels))
    act(() => test.rerender(chatWithoutPanels))

    expect(test.closeAll).toHaveBeenCalledTimes(1)
    expect(test.restorePanel).toHaveBeenCalledWith('simulator')
  })
})

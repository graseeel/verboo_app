import { cleanup, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installContextMenuGuard } from './contextMenuGuard'

/**
 * T3 (field report, Windows): right-clicking empty chrome areas opened the
 * webview's NATIVE menu (Back / Reload / Save as / Print). The guard suppresses
 * the default contextmenu on the main window EXCEPT where the native menu is
 * genuinely useful — editable elements and an active text selection.
 *
 * What jsdom does NOT prove (declared per the task): that the NATIVE menu
 * actually stops appearing. preventDefault on contextmenu is the standard
 * suppression mechanism, but the menu itself is runtime behavior (Tauri
 * webview, per-OS). Field verification on macOS/Windows/Linux is required.
 * jsdom DOES prove the handler logic: which targets get preventDefault.
 */
function rightClick(target: Element): MouseEvent {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  fireEvent(target, event)
  return event
}

describe('contextMenuGuard — suppress the webview menu on empty chrome (T3)', () => {
  let uninstall: () => void

  beforeEach(() => {
    document.body.innerHTML = ''
    uninstall = installContextMenuGuard(window)
  })

  afterEach(() => {
    uninstall()
    cleanup()
  })

  it('prevents the default menu on a plain (empty) area', () => {
    const div = document.createElement('div')
    document.body.appendChild(div)
    expect(rightClick(div).defaultPrevented).toBe(true)
  })

  it('prevents the default menu on nested chrome (button inside a toolbar)', () => {
    document.body.innerHTML = '<div class="toolbar"><button type="button">Go</button></div>'
    const button = document.querySelector('button')!
    expect(rightClick(button).defaultPrevented).toBe(true)
  })

  it('keeps the native menu inside text inputs and textareas', () => {
    const input = document.createElement('input')
    const textarea = document.createElement('textarea')
    document.body.append(input, textarea)
    expect(rightClick(input).defaultPrevented).toBe(false)
    expect(rightClick(textarea).defaultPrevented).toBe(false)
  })

  it('keeps the native menu inside contenteditable regions', () => {
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    const inner = document.createElement('span')
    editable.appendChild(inner)
    document.body.appendChild(editable)
    expect(rightClick(inner).defaultPrevented).toBe(false)
  })

  it('keeps the native menu while text is selected (copy flow)', () => {
    const div = document.createElement('div')
    div.textContent = 'selectable text'
    document.body.appendChild(div)
    const originalGetSelection = window.getSelection
    window.getSelection = () => ({ toString: () => 'selectable text' }) as Selection
    try {
      expect(rightClick(div).defaultPrevented).toBe(false)
    } finally {
      window.getSelection = originalGetSelection
    }
  })

  it('uninstalling the guard restores the default behavior', () => {
    const div = document.createElement('div')
    document.body.appendChild(div)
    uninstall()
    expect(rightClick(div).defaultPrevented).toBe(false)
  })
})

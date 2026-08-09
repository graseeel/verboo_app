/**
 * T3 (field report, Windows): right-clicking empty chrome areas opened the
 * webview's NATIVE menu (Back / Reload / Save as / Print). The main window is
 * an app, not a document: suppress the default contextmenu EXCEPT where the
 * native menu is genuinely useful — editable elements (input / textarea /
 * contenteditable, e.g. the composer or the read-only login URL field, where
 * copy/paste lives) and an active text selection (the copy flow).
 *
 * OUT OF SCOPE by construction: the browser panel's webviews are native child
 * processes — a main-window listener never reaches inside them, and the site's
 * own menu belongs to the site (the task's explicit boundary).
 */

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  const editable = target.closest('input, textarea, [contenteditable]')
  if (!editable) return false
  // [contenteditable="false"] opts out; inputs/textareas always count.
  return editable.getAttribute('contenteditable') !== 'false'
}

/** Installs the suppression on the given window; returns the uninstaller. */
export function installContextMenuGuard(win: Window): () => void {
  function onContextMenu(event: MouseEvent) {
    const selectionText = win.getSelection()?.toString() ?? ''
    if (selectionText.length > 0 || isEditableTarget(event.target)) return
    event.preventDefault()
  }
  win.addEventListener('contextmenu', onContextMenu)
  return () => win.removeEventListener('contextmenu', onContextMenu)
}

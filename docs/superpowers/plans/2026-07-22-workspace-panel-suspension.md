# Workspace Panel Suspension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Suspend terminal, review, and embedded browser while Settings or Profile is active, then restore exactly the panel that was open when Chat returns.

**Architecture:** Add one focused React hook that captures the mutually-exclusive open panel, closes workspace panels during fullscreen views, and restores the captured panel once Chat returns. `App.tsx` provides existing panel callbacks and synchronously guards layout/rendering; `TopBar` disables the three workspace controls without removing them.

**Tech Stack:** React 19 hooks, TypeScript, Vitest, Testing Library, Tauri v2 desktop release build, Computer Use visual verification.

## Global Constraints

- Settings and Profile must never display terminal, review, or browser.
- Restore only the panel that was open on fullscreen entry; restore nothing when none was open.
- Browser restoration uses idle annotation mode, retained URL, and the existing `close()` / `open()` contract.
- Terminal restoration preserves its running session; review restoration preserves its target and selected file.
- Plugins, sidebar, Chrome extension, OAuth, model latency, and panel contents are out of scope.
- Preserve all pre-existing dirty-worktree changes. Do not stage or commit mixed changes from `App.tsx`.

---

### Task 1: Workspace panel suspension controller

**Files:**
- Create: `src/renderer/features/workspace/useWorkspacePanelSuspension.ts`
- Test: `src/renderer/features/workspace/useWorkspacePanelSuspension.test.ts`

**Interfaces:**
- Consumes: fullscreen/chat booleans, three open booleans, `closeAll()`, and `restorePanel(kind)`.
- Produces: `WorkspacePanelKind`, `UseWorkspacePanelSuspensionOptions`, and `useWorkspacePanelSuspension(options): { workspacePanelsEnabled: boolean }`.

- [ ] **Step 1: Write the failing hook tests**

Create tests using `renderHook`, `act`, and `vi.fn()` for these exact transitions:

```ts
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useWorkspacePanelSuspension } from './useWorkspacePanelSuspension'

type Props = {
  isFullscreenView: boolean
  isChatView: boolean
  terminalOpen: boolean
  reviewOpen: boolean
  browserOpen: boolean
}

function setup(initial: Props) {
  const closeAll = vi.fn()
  const restorePanel = vi.fn()
  const view = renderHook((props: Props) => useWorkspacePanelSuspension({
    ...props,
    closeAll,
    restorePanel,
  }), { initialProps: initial })
  return { ...view, closeAll, restorePanel }
}

it('suspends the browser in Settings and restores it once in Chat', () => {
  const test = setup({ isFullscreenView: false, isChatView: true, terminalOpen: false, reviewOpen: false, browserOpen: true })
  act(() => test.rerender({ isFullscreenView: true, isChatView: false, terminalOpen: false, reviewOpen: false, browserOpen: true }))
  expect(test.result.current.workspacePanelsEnabled).toBe(false)
  expect(test.closeAll).toHaveBeenCalledTimes(1)
  act(() => test.rerender({ isFullscreenView: true, isChatView: false, terminalOpen: false, reviewOpen: false, browserOpen: false }))
  act(() => test.rerender({ isFullscreenView: false, isChatView: true, terminalOpen: false, reviewOpen: false, browserOpen: false }))
  expect(test.restorePanel).toHaveBeenCalledTimes(1)
  expect(test.restorePanel).toHaveBeenCalledWith('browser')
})

it('preserves review suspension across Settings to Profile', () => {
  const test = setup({ isFullscreenView: false, isChatView: true, terminalOpen: false, reviewOpen: true, browserOpen: false })
  act(() => test.rerender({ isFullscreenView: true, isChatView: false, terminalOpen: false, reviewOpen: true, browserOpen: false }))
  act(() => test.rerender({ isFullscreenView: true, isChatView: false, terminalOpen: false, reviewOpen: false, browserOpen: false }))
  act(() => test.rerender({ isFullscreenView: false, isChatView: true, terminalOpen: false, reviewOpen: false, browserOpen: false }))
  expect(test.restorePanel).toHaveBeenCalledWith('review')
})

it('restores nothing when fullscreen was entered without a panel', () => {
  const test = setup({ isFullscreenView: false, isChatView: true, terminalOpen: false, reviewOpen: false, browserOpen: false })
  act(() => test.rerender({ isFullscreenView: true, isChatView: false, terminalOpen: false, reviewOpen: false, browserOpen: false }))
  act(() => test.rerender({ isFullscreenView: false, isChatView: true, terminalOpen: false, reviewOpen: false, browserOpen: false }))
  expect(test.restorePanel).not.toHaveBeenCalled()
})

it('closes an attempted automatic browser open without replacing the suspended terminal', () => {
  const test = setup({ isFullscreenView: false, isChatView: true, terminalOpen: true, reviewOpen: false, browserOpen: false })
  act(() => test.rerender({ isFullscreenView: true, isChatView: false, terminalOpen: true, reviewOpen: false, browserOpen: false }))
  act(() => test.rerender({ isFullscreenView: true, isChatView: false, terminalOpen: false, reviewOpen: false, browserOpen: true }))
  expect(test.closeAll).toHaveBeenCalledTimes(2)
  act(() => test.rerender({ isFullscreenView: false, isChatView: true, terminalOpen: false, reviewOpen: false, browserOpen: false }))
  expect(test.restorePanel).toHaveBeenCalledWith('terminal')
})
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npx vitest run src/renderer/features/workspace/useWorkspacePanelSuspension.test.ts
```

Expected: FAIL because `useWorkspacePanelSuspension.ts` does not exist.

- [ ] **Step 3: Implement the minimal hook**

Create:

```ts
import { useLayoutEffect, useRef } from 'react'

export type WorkspacePanelKind = 'terminal' | 'review' | 'browser'

export type UseWorkspacePanelSuspensionOptions = {
  isFullscreenView: boolean
  isChatView: boolean
  terminalOpen: boolean
  reviewOpen: boolean
  browserOpen: boolean
  closeAll: () => void
  restorePanel: (panel: WorkspacePanelKind) => void
}

export function useWorkspacePanelSuspension({
  isFullscreenView,
  isChatView,
  terminalOpen,
  reviewOpen,
  browserOpen,
  closeAll,
  restorePanel,
}: UseWorkspacePanelSuspensionOptions) {
  const suspendedPanelRef = useRef<WorkspacePanelKind | undefined>(undefined)
  const wasFullscreenRef = useRef(false)

  useLayoutEffect(() => {
    if (isFullscreenView) {
      if (!wasFullscreenRef.current) {
        suspendedPanelRef.current = terminalOpen
          ? 'terminal'
          : reviewOpen
            ? 'review'
            : browserOpen
              ? 'browser'
              : undefined
      }
      wasFullscreenRef.current = true
      if (terminalOpen || reviewOpen || browserOpen) closeAll()
      return
    }

    wasFullscreenRef.current = false
    if (!isChatView || !suspendedPanelRef.current) return
    const panel = suspendedPanelRef.current
    suspendedPanelRef.current = undefined
    restorePanel(panel)
  }, [
    browserOpen,
    closeAll,
    isChatView,
    isFullscreenView,
    restorePanel,
    reviewOpen,
    terminalOpen,
  ])

  return { workspacePanelsEnabled: !isFullscreenView }
}
```

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the same Vitest command. Expected: four tests pass with zero failures.

---

### Task 2: Wire suspension into App and Top Bar

**Files:**
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/components/TopBar.tsx`
- Modify: `src/renderer/styles/layout.css`
- Modify: `src/renderer/features/browser/browserExclusivity.test.ts`
- Create: `src/renderer/components/TopBar.test.tsx`

**Interfaces:**
- Consumes: `useWorkspacePanelSuspension` and `WorkspacePanelKind` from Task 1.
- Produces: guarded panel booleans and `workspacePanelsEnabled` Top Bar prop.

- [ ] **Step 1: Write failing Top Bar and App wiring tests**

The Top Bar test renders `TopBar` inside `I18nProvider`, passes
`workspacePanelsEnabled={false}`, and asserts all three named panel buttons are
disabled but still present.

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TopBar } from './TopBar'
import { I18nProvider } from '../i18n'

it('keeps workspace controls visible but disabled in fullscreen views', () => {
  render(
    <I18nProvider language="pt-BR">
      <TopBar
        sidebarVisible
        onToggleSidebar={vi.fn()}
        terminalOpen={false}
        onToggleTerminal={vi.fn()}
        reviewOpen={false}
        onToggleReview={vi.fn()}
        browserOpen={false}
        onToggleBrowser={vi.fn()}
        workspacePanelsEnabled={false}
      />
    </I18nProvider>,
  )
  expect(screen.getByRole('button', { name: 'Abrir terminal local' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Abrir revisão de arquivos' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Abrir navegador' })).toBeDisabled()
})
```

Extend `browserExclusivity.test.ts` to require guarded layout widths, guarded
panel props, Top Bar enabled-state wiring, and handler guards:

```ts
expect(appSource).toMatch(/const visibleTerminalOpen = workspacePanelsEnabled && terminal\.terminalOpen/)
expect(appSource).toMatch(/const visibleReviewOpen = workspacePanelsEnabled && review\.reviewOpen/)
expect(appSource).toMatch(/const visibleBrowserOpen = workspacePanelsEnabled && browser\.browserOpen/)
expect(appSource).toMatch(/workspacePanelsEnabled=\{workspacePanelsEnabled\}/)
expect(appSource).toMatch(/if \(!workspacePanelsEnabled\) return/)
```

- [ ] **Step 2: Run the focused tests and verify RED**

```bash
npx vitest run src/renderer/components/TopBar.test.tsx src/renderer/features/browser/browserExclusivity.test.ts
```

Expected: FAIL because Top Bar lacks the prop/disabled attributes and App lacks
the suspension wiring.

- [ ] **Step 3: Add Top Bar enabled state**

Add `workspacePanelsEnabled: boolean` to `TopBarProps`, accept it in the component,
and add `disabled={!workspacePanelsEnabled}` to the terminal, review, and browser
buttons. Add a subdued disabled style without moving controls:

```css
.topbar-terminal-button:disabled {
  opacity: 0.36;
  cursor: default;
}

.topbar-terminal-button:disabled:hover {
  border-color: transparent;
  color: var(--text-dim);
  background: transparent;
}
```

- [ ] **Step 4: Add App suspension and synchronous rendering guards**

Import the hook/type, create stable `closeAll` and `restorePanel` callbacks, and
call the hook with `isFullscreenView` and `activeView === 'chat'`.

Restoration must use:

```ts
const restoreWorkspacePanel = useCallback((panel: WorkspacePanelKind) => {
  if (panel === 'terminal') {
    void terminal.open(currentWorkspaceDirectory)
    return
  }
  if (panel === 'review') {
    const target = review.target
    if (target) review.open(target.workingDirectory, target.files, target.index)
    return
  }
  browser.open()
}, [browser.open, currentWorkspaceDirectory, review.open, review.target, terminal.open])
```

Derive:

```ts
const visibleTerminalOpen = workspacePanelsEnabled && terminal.terminalOpen
const visibleReviewOpen = workspacePanelsEnabled && review.reviewOpen
const visibleBrowserOpen = workspacePanelsEnabled && browser.browserOpen
```

Use the guarded values for CSS widths/classes, Top Bar active state, and each
panel's `open`/`browserOpen` prop. Pass `workspacePanelsEnabled` to Top Bar.

Add `if (!workspacePanelsEnabled) return` to terminal/review/browser toggle
handlers and their keyboard shortcut handlers. This also blocks command-palette
toggle entries because they call the same handlers.

- [ ] **Step 5: Run focused tests and verify GREEN**

```bash
npx vitest run src/renderer/features/workspace/useWorkspacePanelSuspension.test.ts src/renderer/components/TopBar.test.tsx src/renderer/features/browser/browserExclusivity.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 6: Run renderer regression suite**

```bash
npm test -- --reporter=dot
```

Expected: all existing renderer tests plus the new tests pass.

- [ ] **Step 7: Inspect the exact dirty-worktree delta**

Run:

```bash
git diff --check
git diff -- src/renderer/App.tsx src/renderer/components/TopBar.tsx src/renderer/styles/layout.css src/renderer/features/workspace src/renderer/features/browser/browserExclusivity.test.ts
```

Expected: no whitespace errors and every added line traces to the approved
suspension behavior. Do not stage or commit mixed `App.tsx` changes.

---

### Task 3: Release build and manual acceptance

**Files:**
- Verify only: release bundle, installed app, and screenshots.

**Interfaces:**
- Consumes: guarded panel behavior from Task 2.
- Produces: installed latest release and visual evidence for every acceptance path.

- [ ] **Step 1: Run backend regressions**

```bash
cargo +1.89.0 test --manifest-path src-tauri/Cargo.toml
```

Expected: all Rust unit, integration, and doc tests pass.

- [ ] **Step 2: Build and install the latest app**

```bash
npm run tauri:build
```

Expected: release build exits zero. Install the generated
`Verboo Code.app`, verify its executable SHA-256 equals the bundle artifact, and
launch the installed `/Applications/Verboo Code.app` binary.

- [ ] **Step 3: Validate browser suspension with Computer Use**

Open the embedded browser, enter Settings, verify the browser disappears and all
three Top Bar controls are disabled, return to Chat, and verify the browser and
its previous URL return. Repeat through Profile. Do not use reload or reopen the
browser manually during restoration checks.

- [ ] **Step 4: Validate terminal suspension with Computer Use**

Open terminal, enter Settings and Profile separately, verify it disappears, and
verify the same live session returns to Chat.

- [ ] **Step 5: Validate review suspension with Computer Use**

Open workspace review, remember the selected file, enter Settings and Profile
separately, and verify the same target/file returns to Chat.

- [ ] **Step 6: Validate the no-panel path**

Close all panels, enter Settings and Profile, return to Chat, and verify no panel
opens automatically.

- [ ] **Step 7: Final evidence gate**

Re-run focused tests, `npm test -- --reporter=dot`, `git diff --check`, confirm the
installed executable hash, and report any warnings or unverified path honestly.

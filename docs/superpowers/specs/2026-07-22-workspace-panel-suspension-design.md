# Workspace Panel Suspension in Settings and Profile

## Context

Verboo Code has three mutually exclusive workspace panels: the local terminal,
workspace review, and embedded browser. They are mounted alongside the routed
workspace content, so today an open panel remains visible and interactive when
the user enters Settings or Profile.

Settings and Profile are fullscreen product views. They must not share the
window with workspace tools. If one workspace panel was open before entering a
fullscreen view, that same panel should return when the user comes back to the
normal Chat view.

## Scope

This change applies only to:

- local terminal;
- workspace review;
- embedded browser;
- Settings and Profile views;
- returning from either fullscreen view to Chat.

Plugins keep their current behavior. The Chrome extension, OAuth configuration,
model latency, and panel contents are outside this change.

## User-visible behavior

1. Entering Settings or Profile records which one of the three workspace panels
   is currently open.
2. All three workspace panels close before the fullscreen view is presented.
3. Their Top Bar buttons remain in place but are disabled while Settings or
   Profile is active, avoiding layout movement and preventing new panels from
   opening.
4. Their keyboard shortcuts do nothing while Settings or Profile is active.
5. Moving between Settings and Profile does not replace or clear the recorded
   panel.
6. Returning to Chat restores exactly the recorded panel and clears the
   suspension record.
7. If no panel was open on entry, no panel opens on return.

The browser returns in idle annotation mode because closing it already cancels
pencil/arrow mode. Its current URL remains available. The terminal session stays
alive while hidden, using its existing close/open contract. Workspace review
retains its current target and selected file.

## State model

The implementation keeps one transient suspension value:

```text
none | terminal | review | browser
```

This is not persisted across app launches. Existing panel exclusivity guarantees
that at most one value can be captured.

On the first transition into Settings or Profile, the controller captures the
open panel and closes every workspace panel. Re-renders and transitions between
the two fullscreen views do not recapture state. If an automatic event attempts
to open a panel while a fullscreen view is active, that panel is closed without
overwriting the original suspension value.

When Chat becomes active, the controller restores the suspended panel once and
then clears the value. A synchronous rendering guard ensures no panel can remain
visible for one frame while the close effect runs.

## Implementation boundary

A focused workspace-panel suspension hook will own the transition bookkeeping.
`App.tsx` will provide current panel state plus existing close/restore callbacks.
The hook will return whether workspace panel actions are enabled.

`TopBar` will receive that enabled state and apply the native `disabled`
attribute to the terminal, review, and browser buttons. Existing toggle handlers
and keyboard shortcuts will also guard against Settings/Profile so command
palette or shortcut paths cannot bypass the disabled buttons.

No panel hook will be refactored. Restoration uses their existing contracts:

- terminal: `open(cwd)`, which restores a running session when present;
- review: `open(...)` with the retained review target;
- browser: `open()`, retaining its current URL.

## Edge cases

- If the terminal no longer fits the viewport on return, its existing
  unavailable message is shown and no other panel is substituted.
- If a review target is no longer available, review is not reopened and no other
  panel is substituted.
- Automatic local-server detection during Settings/Profile cannot make the
  browser visible or replace the suspended panel.
- Repeated Settings/Profile renders must not reopen or repeatedly close panels.
- Returning with Escape, the Back button, selecting a chat, or creating a chat
  follows the same Chat transition and restoration behavior.

## Tests

The regression suite will be written before production changes and must first
fail against the current behavior.

The suspension hook tests will cover:

- browser -> Settings -> Chat;
- terminal -> Profile -> Chat;
- review -> Settings -> Profile -> Chat;
- entering fullscreen with no panel open;
- an attempted panel open while fullscreen;
- restoration occurring exactly once.

Top Bar tests will verify all three controls are disabled together without being
removed. Focused App tests will verify shortcuts and rendered panel widths/open
props are guarded while fullscreen.

After automated tests pass, the release app will be rebuilt and manually checked
with each panel through both Settings and Profile. Each test will confirm closure,
disabled controls, restoration of the original panel, and no restoration when
the entry state had no open panel.

## Acceptance criteria

- Terminal, review, and browser never appear in Settings or Profile.
- None of the three can be opened there by button, shortcut, command palette, or
  automatic browser detection.
- The panel that was open on entry returns when Chat is restored.
- Internal panel context is preserved as described above.
- No unrelated sidebar, plugin, Chrome extension, or model behavior changes.

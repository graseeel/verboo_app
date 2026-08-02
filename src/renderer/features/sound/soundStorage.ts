/**
 * soundStorage — the master sound switch, persisted renderer-side.
 *
 * Follows the repo's `verboo:*` localStorage pattern (checklistStorage,
 * and the effortByModel precedent: a settings-class preference kept in
 * localStorage while the backend does not carry it). updateUserSettings
 * goes through the Rust bridge — adding a field to UserSettings would
 * be a contract change owned by TORNO, so this toggle lives HERE. The
 * UI surfaces it INSIDE Settings → Notifications (integrated with the
 * existing notification preferences, not a loose separate switch).
 *
 * Default ON: the user explicitly asked for the two sounds. The toggle
 * is the guaranteed OFF switch — the OS volume/mute state is not
 * readable from a WebView (declared limit in sounds.ts).
 */

const SOUNDS_KEY = 'verboo:sounds-enabled'

export function readSoundsEnabled(): boolean {
  try {
    const raw = window.localStorage.getItem(SOUNDS_KEY)
    return raw === null ? true : raw === 'true'
  } catch {
    return true
  }
}

export function writeSoundsEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(SOUNDS_KEY, String(enabled))
  } catch {
    // optional persistence — a full quota must never break the toggle
  }
}

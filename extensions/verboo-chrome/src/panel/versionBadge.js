/**
 * versionBadge.js — discreet runtime version stamp.
 *
 * The version always comes from chrome.runtime.getManifest().version at
 * runtime, so a manifest bump propagates to the UI with no code change.
 * Distributed app: the value is NEVER hardcoded here.
 */

/**
 * Version string from the extension manifest ('' when unavailable).
 * @returns {string}
 */
export function extensionVersion() {
  return String(globalThis.chrome?.runtime?.getManifest?.()?.version ?? '').trim()
}

/**
 * Stamp every [data-version-badge] element under root with
 * `<label> <version>`. Rendered via textContent only; elements stay empty
 * when the manifest version cannot be read.
 * @param {ParentNode} root
 * @param {string} label localized label (i18n key `version_label`)
 */
export function applyVersionBadge(root, label) {
  const version = extensionVersion()
  if (!version) return
  for (const el of root.querySelectorAll('[data-version-badge]')) {
    el.textContent = `${label} ${version}`
  }
}

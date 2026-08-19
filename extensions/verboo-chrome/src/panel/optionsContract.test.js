import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const html = await readFile(new URL('./options.html', import.meta.url), 'utf8')
const script = await readFile(new URL('./options.js', import.meta.url), 'utf8')
const styles = await readFile(new URL('./options.css', import.meta.url), 'utf8')

test('settings exposes an accessible routines manager and editor', () => {
  for (const id of [
    'routines-section',
    'routines-list',
    'routine-create',
    'routine-editor-dialog',
    'routine-form',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`))
  }
  assert.match(html, /id="routines-section"[^>]*aria-labelledby="routines-title"/s)
  assert.match(html, /id="routine-editor-dialog"[^>]*aria-labelledby="routine-editor-title"/s)
  assert.match(html, /id="routine-form"/)
  assert.match(script, /MSG\.ROUTINE_CREATE/)
  assert.match(script, /MSG\.ROUTINE_UPDATE/)
  assert.match(script, /MSG\.ROUTINE_DUPLICATE/)
  assert.match(script, /MSG\.ROUTINE_DELETE/)
  assert.match(script, /MSG\.ROUTINE_RUN_LIST/)
  assert.match(script, /MSG\.ROUTINE_RECOVERY_APPLY/)
  assert.match(html, /option value="monthly"/)
  assert.match(html, /option value="annual"/)
  assert.match(html, /id="routine-schedule-weekday"/)
  assert.match(html, /id="routine-schedule-day"/)
  assert.match(html, /id="routine-schedule-month"/)
  assert.match(html, /id="routine-schedule-error"[^>]*role="status"/s)
  assert.match(script, /routineEditorOpener/)
})

test('settings markup does not duplicate element IDs', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1])
  assert.equal(new Set(ids).size, ids.length)
})

test('settings footer stamps the runtime manifest version discreetly', () => {
  // Footer badge after the account section; value filled at runtime by JS.
  assert.match(html, /<footer class="options-foot">/)
  assert.match(html, /<span class="version-badge" data-version-badge><\/span>/)
  assert.match(styles, /\.options-foot\s*\{/)
  // Runtime source of truth: the manifest, never a hardcoded literal.
  assert.match(script, /import \{ applyVersionBadge \} from '\.\/versionBadge\.js'/)
  assert.match(script, /applyVersionBadge\(document, t\('version_label'\)\)/)
})

/**
 * sync-browser-tools.mjs — regenerate browserTools.json from browserTools.js.
 *
 * browserTools.js is the SINGLE source of truth for the browser tool catalog
 * (imported by the extension at runtime). browserTools.json is a generated
 * mirror consumed by the Rust side (catalog.rs include_str) and by the
 * chrome_tools_canary in the desktop app. Keeping a checked-in copy means a
 * missing/diverged manifest IS the defect (the canary fails loudly), while
 * this script guarantees the two can never drift silently.
 *
 * Run after editing browserTools.js:  node scripts/sync-browser-tools.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const catalogUrl = new URL('../src/controller/browserTools.js', import.meta.url)
const { default: browserCatalog } = await import(catalogUrl.href)
const outPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'controller',
  'browserTools.json',
)
writeFileSync(outPath, `${JSON.stringify(browserCatalog, null, 2)}\n`)
console.log(`browserTools.json regenerated from browserTools.js (version ${browserCatalog.version})`)

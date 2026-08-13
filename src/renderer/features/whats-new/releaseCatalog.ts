import catalogJson from '../../../../release-notes/releases.json'
import type { LanguageCode } from '../../../shared/types'

export type ReleaseHighlight = { title: string; body: string }
export type ReleaseCopy = { title: string; summary: string; items: ReleaseHighlight[] }
type ReleaseCatalog = {
  schemaVersion: 1
  releases: Record<string, Record<LanguageCode, ReleaseCopy>>
}

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const catalog = catalogJson as ReleaseCatalog

export function getReleaseCopy(version: string, language: LanguageCode): ReleaseCopy | undefined {
  return catalog.releases[version]?.[language]
}

export function releaseTagUrl(version: string): string {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`release version must be canonical: ${version}`)
  }
  return `https://github.com/graseeel/verboo_app/releases/tag/v${version}`
}

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/App.tsx'), 'utf8')
const typesSource = readFileSync(resolve(process.cwd(), 'src/shared/types.ts'), 'utf8')

describe('video settings and shared contracts', () => {
  it('defaults video fallback consent to ask independently from image fallback consent', () => {
    expect(appSource).toMatch(/visionFallbackConsent:\s*'ask'/)
    expect(appSource).toMatch(/videoFallbackConsent:\s*'ask'/)
  })

  it('declares the video wire-contract field names and values', () => {
    expect(typesSource).toContain("export type VideoFallbackConsent = 'ask' | 'always' | 'never'")
    expect(typesSource).toContain("export type AttachmentKind = 'image' | 'video' | 'file'")
    expect(typesSource).toMatch(/video\?: VideoStreamMetadata/)
    expect(typesSource).toMatch(/mediaCapabilities\?: ModelMediaCapabilities/)
    expect(typesSource).toMatch(/cliMediaCapabilities\?: CliMediaCapabilities/)
    expect(typesSource).toMatch(/runVideoAnalysis\?: boolean/)
    expect(typesSource).toMatch(/\{ type: 'video-progress';[^}]*videoProgress: VideoProgress \}/)
  })
})

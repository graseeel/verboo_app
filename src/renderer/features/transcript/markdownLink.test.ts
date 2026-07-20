import { describe, expect, it } from 'vitest'
import { parseLinkDestination } from './markdownLink'

describe('parseLinkDestination', () => {
  it.each(['http://localhost:8765/', 'http://127.0.0.1:3000/', 'http://[::1]:5173/'])(
    'classifies %s as local',
    href => expect(parseLinkDestination(href)).toEqual({ href, kind: 'local' }),
  )

  it('classifies a remote HTTPS link as external', () => {
    expect(parseLinkDestination('https://code.verboo.ai/docs')).toEqual({
      href: 'https://code.verboo.ai/docs',
      kind: 'external',
    })
  })

  it.each(['mailto:help@example.com', 'file:///tmp/report.html', 'javascript:alert(1)', 'not a URL'])(
    'rejects %s',
    href => expect(parseLinkDestination(href)).toBeUndefined(),
  )
})

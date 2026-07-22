import assert from 'node:assert/strict'
import test from 'node:test'

import { assertExactSemver, needsCliUpdate } from './update-cli-dependency.mjs'

test('accepts exact releases and prereleases', () => {
  assert.equal(assertExactSemver('0.14.4'), '0.14.4')
  assert.equal(assertExactSemver('0.15.0-beta.2'), '0.15.0-beta.2')
  assert.equal(assertExactSemver('1.0.0+build.7'), '1.0.0+build.7')
})

test('rejects ranges, URLs, tags, and package injection', () => {
  for (const value of [
    '^0.14.4',
    'latest',
    'https://example.test/pkg.tgz',
    '0.14.4 --ignore-scripts',
    '01.14.4',
    '0.14.4-beta.02',
  ]) {
    assert.throws(() => assertExactSemver(value), /exact SemVer/i)
  }
})

test('does nothing when the pinned CLI is current', () => {
  assert.equal(needsCliUpdate('0.14.4', '0.14.4'), false)
  assert.equal(needsCliUpdate('0.14.4', '0.14.5'), true)
})

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { boundGemRange, boundPypiRange, boundSemverRange } from '../src/advisories/patched.js'
import { readRange as readPypiRange } from '../src/pypi/version.js'
import { readRange as readGemRange } from '../src/rubygems/version.js'
import { satisfies } from '../src/semver.js'

const check = (bound, cases) => {
  for (const [range, patched, bounded] of cases) assert.deepEqual(bound(range, patched), bounded, `${range} patched in ${String(patched).slice(0, 40)}`)
}

describe('a range with no end of its own, ended below its patched versions', () => {
  it('ends below each line its patched versions end, as GitHub reviewed Next.js\'s GHSA-ggv3-7p47-pfv8', () => {
    check(boundSemverRange, [
      // As vercel/next.js publishes it, its fixes in either order.
      ['>=9.5.0', '16.1.7, 15.5.13', ['>=9.5.0, < 15.5.13', '>= 16.0.0-0, < 16.1.7']],
      [' >=9.5.0 ', ' 15.5.13 ,16.1.7 ', ['>=9.5.0, < 15.5.13', '>= 16.0.0-0, < 16.1.7']],
      ['', '15.5.13, 16.1.7', ['< 15.5.13', '>= 16.0.0-0, < 16.1.7']],
      // One, as before.
      ['>= 2.1.0', '4.1.11', ['>= 2.1.0, < 4.1.11']],
      ['', '5.0.0', ['< 5.0.0']],
      // A major whose minors each have a fix, then the next major.
      ['>= 1.0.0', '1.2.9, 1.3.4, 2.0.1', ['>= 1.0.0, < 1.2.9', '>= 1.3.0-0, < 1.3.4', '>= 2.0.0-0, < 2.0.1']],
      ['>= 0.1.0', '0.3.5, 0.4.2', ['>= 0.1.0, < 0.3.5', '>= 0.4.0-0, < 0.4.2']],
      ['>= 5.0.0', '5.0.1, 6.0.0', ['>= 5.0.0, < 5.0.1', '>= 6.0.0-0, < 6.0.0']],
    ])
    const [first, second] = boundSemverRange('>=9.5.0', '16.1.7, 15.5.13').map((range) => range.replaceAll(',', ' '))
    const affected = (version) => [first, second].some((range) => satisfies(version, range, { includePrerelease: true }))
    for (const version of ['9.5.0', '14.2.30', '15.5.12', '16.0.0-beta.0', '16.0.0-canary.1', '16.1.6']) assert.ok(affected(version), version)
    for (const version of ['9.4.0', '15.5.13', '15.5.20', '16.1.7', '16.2.5', '17.0.0-canary.0']) assert.ok(!affected(version), version)
  })

  it('leaves in a line no patched version ends, and ends a line at the highest of its own', () => {
    check(boundSemverRange, [
      // 2.x has no fix: 2.0.0 up to 3.0.1 is affected.
      ['>= 1.0.0', '1.2.5, 3.0.1', ['>= 1.0.0, < 1.2.5', '>= 2.0.0-0, < 3.0.1']],
      // Two in one line: the higher ends it.
      ['>= 3.0.0', '3.1.2, 3.1.4', ['>= 3.0.0, < 3.1.4']],
      ['>= 5.0.0-beta.1', '5.0.0-rc.2, 5.0.0', ['>= 5.0.0-beta.1, < 5.0.0']],
      ['>= 1.0.0', '1.2.5, 1.2.9, 2.0.1', ['>= 1.0.0, < 1.2.9', '>= 2.0.0-0, < 2.0.1']],
    ])
  })

  it('takes the range where it begins inside a line, and leaves out a line below it', () => {
    check(boundSemverRange, [
      ['>= 16.0.0', '15.5.13, 16.1.7', ['>= 16.0.0, < 16.1.7']],
      ['>= 3.0.0', '2.2.9, 3.1.0', ['>= 3.0.0, < 3.1.0']],
      ['> 16.0.0', '15.5.13, 16.1.7', ['> 16.0.0, < 16.1.7']],
      // Begun at or above every fix: as given.
      ['>= 4.0.0', '2.2.9, 3.1.0', ['>= 4.0.0']],
      ['>= 3.1.0', '2.2.9, 3.1.0', ['>= 3.1.0']],
    ])
  })

  it('leaves as given a range with an end, alternatives, or fixes it cannot read every one of', () => {
    check(boundSemverRange, [
      ['>= 1.0.0, < 2.0.0', '1.5.0, 2.1.0', ['>= 1.0.0, < 2.0.0']],
      ['^3.1.0', '3.1.3, 4.0.1', ['^3.1.0']],
      ['>= 3.2.0 || >= 3.0.0', '3.1.3, 4.0.1', ['>= 3.2.0 || >= 3.0.0']],
      ['not a range', '1.0.0, 2.0.0', ['not a range']],
      ['>= 1.0.0', '1.2.5, >= 2.0.0', ['>= 1.0.0']],
      ['>= 1.0.0', '1.2.5,', ['>= 1.0.0']],
      ['>= 1.0.0', '1.2, 2.0.1', ['>= 1.0.0']],
      ['>= 1.0.0', '', ['>= 1.0.0']],
      ['>= 1.0.0', undefined, ['>= 1.0.0']],
      ['>= 1.0.0', Array.from({ length: 200 }, (_, i) => `${i}.0.1`).join(', '), ['>= 1.0.0']],
    ])
  })

  it('reads a gem\'s as Gem::Requirement does, a line from below any prerelease of it', () => {
    check(boundGemRange, [
      ['>= 7.0.0.rc1', '7.0.4.1', ['>= 7.0.0.rc1, < 7.0.4.1']],
      ['', '1.2', ['< 1.2']],
      ['> 3.0, != 3.0.5', '3.1', ['> 3.0, != 3.0.5, < 3.1']],
      ['>= 3.0', '2.2.9', ['>= 3.0']],
      ['>= 3.0', '3.0.0', ['>= 3.0']],
      ['= 3.1.2', '3.1.2', ['= 3.1.2']],
      ['~> 3.1', '3.1.3', ['~> 3.1']],
      ['>= 1.0, < 2.0', '1.5', ['>= 1.0, < 2.0']],
      ['>= 1.0', `1${'.1'.repeat(200)}`, ['>= 1.0']],
      ['^1.0', '1.5', ['^1.0']],
      ['>= 1.0', '1.5, 2.1', ['>= 1.0, < 1.5', '>= 2.A, < 2.1']],
      // As rails/rails names its fixes: 4 numbers each, one per minor of 7.
      ['', '7.1.3.1, 7.0.8.1, 6.1.7.7', ['< 6.1.7.7', '>= 7.A, < 7.0.8.1', '>= 7.1.A, < 7.1.3.1']],
      ['>= 6.0.0', '7.1.3.1, 7.0.8.1, 6.1.7.7', ['>= 6.0.0, < 6.1.7.7', '>= 7.A, < 7.0.8.1', '>= 7.1.A, < 7.1.3.1']],
      // One version, written twice.
      ['>= 0.9', '1.0, 1.0.0', ['>= 0.9, < 1.0.0']],
      // What it leaves out stays out of each line, even where it is where
      // a line begins.
      ['>= 1.0, != 2.0.5', '1.5, 2.1', ['>= 1.0, != 2.0.5, < 1.5', '>= 2.A, != 2.0.5, < 2.1']],
      ['>= 1.0, != 2.A', '1.5, 2.1', ['>= 1.0, != 2.A, < 1.5', '>= 2.A, != 2.A, < 2.1']],
      ['>= 2.0.1, != 2.0.5', '1.5, 2.1', ['>= 2.0.1, != 2.0.5, < 2.1']],
    ])
    const excluded = readGemRange(boundGemRange('>= 1.0, != 2.0.5', '1.5, 2.1')[1])
    for (const [version, held] of [['2.0.4', true], ['2.0.5', false], ['2.0.6', true]]) assert.equal(excluded(version), held, version)
    const seven = readGemRange(boundGemRange('', '7.0.8.1, 6.1.7.7')[1])
    for (const version of ['7.0.0.RC1', '7.0.0.alpha', '7.0.0', '7.0.8']) assert.ok(seven(version), version)
    for (const version of ['6.1.7.7', '6.1.99', '7.0.8.1', '7.1.0']) assert.ok(!seven(version), version)
  })

  it('reads a Python package\'s as PEP 440 does, a line from its first dev release, an epoch only alone', () => {
    check(boundPypiRange, [
      ['>= 1.0', '1.5', ['>= 1.0, < 1.5']],
      ['', '4.2.16, 5.0.9, 5.1.1', ['< 4.2.16', '>= 5.dev0, < 5.0.9', '>= 5.1.dev0, < 5.1.1']],
      ['>= 3.0', '2.2.9, 3.1.0', ['>= 3.0, < 3.1.0']],
      ['>= 1!1.0', '1!1.2', ['>= 1!1.0, < 1!1.2']],
      ['>= 1.0', '1!1.2, 1!2.1', ['>= 1.0']],
      ['>= 1.0, < 2.0', '1.5, 2.1', ['>= 1.0, < 2.0']],
    ])
    const five = readPypiRange(boundPypiRange('', '4.2.16, 5.0.9')[1])
    for (const version of ['5.0.dev1', '5.0a1', '5.0rc1', '5.0', '5.0.8']) assert.ok(five(version), version)
    for (const version of ['4.2.16', '4.2.99.post1', '5.0.9']) assert.ok(!five(version), version)
  })
})

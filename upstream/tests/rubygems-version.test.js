import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { compareVersions, isVersion, readRange } from '../src/rubygems/version.js'

// Gem::Version and Gem::Requirement as RubyGems 3.5 has them: every case
// below is what `Gem::Version.new(a) <=> Gem::Version.new(b)` and
// `satisfied_by?` answer there.

describe('Gem::Version', () => {
  // [a, b, a <=> b]
  const ORDERED = [
    // A prerelease is below its release, and above the one before.
    ['1.0.0.rc1', '1.0.0', -1],
    ['1.0.0.rc1', '0.9.9', 1],
    ['1.0.0.a', '1.0.0.b', -1],
    ['1.0.0.beta', '1.0.0.alpha', 1],
    ['1.0.0.rc1', '1.0.0.rc10', -1],
    ['1.0.0.rc2', '1.0.0.rc10', -1],
    ['1.0.0.pre', '1.0.0.pre.1', -1],
    ['1.16.0.rc1', '1.16.0.rc1.1', -1],
    // Trailing zeros are none, before letters too.
    ['1.0', '1.0.0', 0],
    ['1', '1.0.0.0', 0],
    ['1.0.0.a', '1.a', 0],
    ['1.0.a.0', '1.a', 0],
    ['1.0.0.rc1', '1.rc1', 0],
    ['0', '0.0', 0],
    // Numbers by value, letters by byte, letters below numbers.
    ['1.10', '1.9', 1],
    ['1.01', '1.1', 0],
    ['1.007', '1.7', 0],
    ['2.0.0', '10.0.0', -1],
    ['1.0.0.A', '1.0.0.a', -1],
    ['1.0.0.a', '1.0.0.0', -1],
    ['1.0a', '1.0.a', 0],
    ['1.0rc1', '1.0.rc1', 0],
    ['7.0.4.3', '7.0.4', 1],
    ['7.0.4.3', '7.0.10', -1],
    // As long as Ruby's integers: bigger than any double.
    ['1.18446744073709551617', '1.18446744073709551616', 1],
    ['18446744073709551617.0', '18446744073709551617', 0],
    [`1.${'0.'.repeat(200)}1`, '1.0.1', -1],
    [`1${'.0'.repeat(200)}`, '1', 0],
    // A `-` reads as `.pre.`.
    ['1.0.0-rc1', '1.0.0.pre.rc1', 0],
    ['1.0.0-rc1', '1.0.0', -1],
  ]

  it('orders versions as Gem::Version#<=> does', () => {
    for (const [a, b, expected] of ORDERED) {
      assert.equal(compareVersions(a, b), expected, `${a} <=> ${b}`)
      assert.equal(compareVersions(b, a), 0 - expected, `${b} <=> ${a}`)
    }
  })

  it('sorts a list as RubyGems would', () => {
    const sorted = ['1.10.0', '1.9.0', '1.0.0', '1.0.0.rc1', '1.0.0.beta2', '1.0.0.beta10', '0.9', '1.1.0.pre'].toSorted(compareVersions)
    assert.deepEqual(sorted, ['0.9', '1.0.0.beta2', '1.0.0.beta10', '1.0.0.rc1', '1.0.0', '1.1.0.pre', '1.9.0', '1.10.0'])
  })

  it('reads a version as Gem::Version::VERSION_PATTERN does', () => {
    for (const version of ['0', '1.0', '7.0.4.3', '1.16.0.rc1', '1.0a', '1.0.0-rc1', '1.0.0-rc.1', '4.25.14p12', '01']) assert.ok(isVersion(version), version)
    for (const version of ['', ' 1.0', '1.0 ', 'a', '.1', '1.', '1..0', '1.0.', '1_0', '1.0-', '1.0+build', 'v1.0', '1,0', 1, undefined]) assert.ok(!isVersion(version), String(version))
  })
})

describe('Gem::Requirement, in GitHub\'s ranges', () => {
  // [range, version, met]
  const MET = [
    ['>= 1.0.0, < 1.2.6', '1.2.5', true],
    ['>= 1.0.0, < 1.2.6', '1.2.6', false],
    ['>= 1.0.0, < 1.2.6', '0.9.9', false],
    // A prerelease is matched as any version: below its release.
    ['>= 1.0.0, < 1.2.6', '1.2.6.rc1', true],
    ['>= 1.0.0, < 1.2.6', '1.0.0.rc1', false],
    ['< 6.1.7.1', '6.1.7', true],
    ['< 6.1.7.1', '6.1.7.1', false],
    ['>= 6.1.0, < 6.1.7.1', '6.1.10', false],
    ['<= 2.2.8', '2.2.8.1', false],
    ['<= 2.2.8', '2.2.8.0', true],
    ['= 1.0', '1.0.0', true],
    ['!= 1.0', '1.0.0', false],
    ['1.0', '1.0.0', true],
    ['> 1.0', '1.0.0.1', true],
    ['~> 1.2.3', '1.2.9', true],
    ['~> 1.2.3', '1.3.0', false],
    ['~> 1.2', '1.9', true],
    ['~> 1.2', '1.9.9.rc1', true],
    ['~> 1.2', '2.0.0.rc1', false],
    ['< 1.0.0-rc2', '1.0.0.pre.rc1', true],
    ['< 1.0.0-rc2', '1.0.0.rc1', false],
  ]

  it('meets each comma-separated part, as satisfied_by? does', () => {
    for (const [range, version, met] of MET) assert.equal(readRange(range)(version), met, `${version} in ${range}`)
  })

  it('reads each part as Gem::Requirement::PATTERN does, space and all, an operator `=` where there is none', () => {
    for (const [range, version, met] of [
      ['>= 1.0.0, < 1.2.6', '1.2.5', true], ['>= 1.0.0, < 1.2.6', '1.2.6', false],
      [' >=1.0.0 ,\t<1.2.6 ', '1.0.0', true], [' >=1.0.0 ,\t<1.2.6 ', '0.9', false],
      ['1.0.0', '1.0', true], ['1.0.0', '1.0.1', false],
      ['~> 7.0.4.3', '7.0.4.9', true], ['~> 7.0.4.3', '7.0.5', false],
    ]) assert.equal(readRange(range)(version), met, `${version} in ${range}`)
  })

  it('reads no range with a part it cannot, or none', () => {
    for (const range of ['', ' ', '>= 1.0.0,', ', < 2', '>= 1.0.0 < 2.0.0', '=> 1.0', '== 1.0', '^1.0', '1.x.*', '*', '< v2', '>= 1.0.0 || < 0.5', '<\u00A01.0']) {
      assert.equal(readRange(range), undefined, range)
    }
  })
})

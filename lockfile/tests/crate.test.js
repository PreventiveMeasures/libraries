import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import * as rustSemver from '../rust-semver.js'
import { sanitizeWithOptions } from '../src/crate/sanitize-filename.js'

const { matches, parseVersion, parseVersionReq } = rustSemver

// What the Rust crates make of a grid of inputs, as
// scripts/record-crates.js records it.
const FIXTURE = JSON.parse(readFileSync(new URL('fixtures/crates.json', import.meta.url), 'utf8'))

describe('rust-semver.js, as the semver crate reads and matches', () => {
  const { versions, requirements } = FIXTURE.semver
  const parsed = versions.map(parseVersion)
  const row = requirements.find(([, matched]) => matched !== null)[1]

  it('exports the parsers and matches alone', () => {
    assert.deepEqual(Object.keys(rustSemver).sort(), ['matches', 'parseVersion', 'parseVersionReq'])
  })

  it('every version the crate parses, and no other', () => {
    assert.ok(parsed.filter((version) => version === undefined).length > 20)
    for (const [index, text] of versions.entries()) assert.equal(parsed[index] !== undefined, row[index] !== '-', JSON.stringify(text))
  })

  it('every requirement the crate parses, matched by every version it matches', () => {
    assert.ok(requirements.filter(([, matched]) => matched === null).length > 20)
    assert.ok(requirements.map(([, matched]) => matched ?? '').join('').split('1').length > 500)
    for (const [text, matched] of requirements) {
      const comparators = parseVersionReq(text)
      assert.equal(comparators === undefined, matched === null, JSON.stringify(text))
      if (comparators === undefined) continue
      const mine = parsed.map((version) => (version === undefined ? '-' : matches(comparators, version) ? '1' : '0')).join('')
      assert.equal(mine, matched, JSON.stringify(text))
    }
  })

  it('a version and a comparator as the crate has them', () => {
    assert.deepEqual(parseVersion('1.2.3-alpha.1+build.5'), { major: 1n, minor: 2n, patch: 3n, pre: 'alpha.1', build: 'build.5' })
    assert.deepEqual(parseVersionReq(' >= 1.2 , 1.*, ~0.1.2-rc'), [
      { op: '>=', major: 1n, minor: 2n, patch: undefined, pre: '' },
      { op: '*', major: 1n, minor: undefined, patch: undefined, pre: '' },
      { op: '~', major: 0n, minor: 1n, patch: 2n, pre: 'rc' },
    ])
    assert.deepEqual(parseVersionReq('X'), [])
  })

  it('numbers up to u64, read as bigints', () => {
    assert.equal(parseVersion('18446744073709551615.0.0').major, 2n ** 64n - 1n)
    assert.equal(parseVersion('18446744073709551616.0.0'), undefined)
    assert.equal(parseVersion(`${'9'.repeat(100000)}.0.0`), undefined)
  })

  it('in time linear in its length, whatever it is', () => {
    const long = 100000
    for (const text of ['1.2.3-' + '1a.'.repeat(long) + '!', '>=1.2.3-' + '0'.repeat(long) + '!', ' '.repeat(long) + '1' + ' '.repeat(long) + 'x', Array.from({ length: long }, () => '1').join(',')]) {
      const start = performance.now()
      assert.equal(parseVersion(text), undefined)
      assert.equal(parseVersionReq(text), undefined)
      assert.ok(performance.now() - start < 1000, `${text.slice(0, 20)}…`)
    }
  })

  it('a TypeError for what is not a string, or not as the parsers make', () => {
    for (const value of [undefined, null, 1, {}, ['1.0.0']]) {
      assert.throws(() => parseVersion(value), { name: 'TypeError', message: 'expected a string' })
      assert.throws(() => parseVersionReq(value), { name: 'TypeError', message: 'expected a string' })
    }
    const version = parseVersion('1.0.0')
    const [comparator] = parseVersionReq('1.0.0')
    for (const forged of [{ ...version, major: 1 }, { ...version, minor: -1n }, { ...version, patch: 2n ** 64n }, { ...version, pre: 'a..b' }, null]) {
      assert.throws(() => matches([comparator], forged), { name: 'TypeError', message: 'expected a version, as parseVersion makes' })
    }
    for (const forged of [{ ...comparator, op: '!' }, { ...comparator, minor: undefined }, { ...comparator, patch: undefined, pre: 'rc' }, { ...comparator, pre: '01' }, '1.0.0']) {
      assert.throws(() => matches([forged], version), { name: 'TypeError', message: 'expected comparators, as parseVersionReq makes' })
    }
    assert.throws(() => matches('1.0.0', version), { name: 'TypeError', message: 'expected comparators, as parseVersionReq makes' })
  })
})

describe('the sanitize-filename crate, as Soldeer names a folder', () => {
  it('every name as the crate makes it, on Unix and on Windows', () => {
    for (const [name, unix, windows] of FIXTURE.sanitize) {
      assert.equal(sanitizeWithOptions(name, { windows: false, truncate: true, replacement: '-' }), unix, JSON.stringify(name))
      assert.equal(sanitizeWithOptions(name, { windows: true, truncate: true, replacement: '-' }), windows, JSON.stringify(name))
    }
  })

  it('its other options: a replacement taken as it is, and no cut', () => {
    assert.equal(sanitizeWithOptions('a/b', { windows: false, truncate: true, replacement: '$&' }), 'a$&b')
    assert.equal(sanitizeWithOptions('a/b', { windows: false, truncate: true, replacement: '' }), 'ab')
    assert.equal(sanitizeWithOptions('x'.repeat(300), { windows: false, truncate: false, replacement: '-' }).length, 300)
  })
})

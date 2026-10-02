import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { isDeepStrictEqual } from 'node:util'
import * as rustSemver from '../rust-semver.js'
import { fileName } from '../src/crate/path.js'
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
    // A wildcard patch after a wildcard minor, but no number after either.
    for (const text of ['1.*.*', '1.x.X']) assert.deepEqual(parseVersionReq(text), [{ op: '*', major: 1n, minor: undefined, patch: undefined, pre: '' }])
    assert.equal(parseVersionReq('1.*.3'), undefined)
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
    for (const forged of [{ ...version, major: 1 }, { ...version, minor: -1n }, { ...version, patch: 2n ** 64n }, { ...version, pre: 'a..b' }, { ...version, build: 'a..b' }, { ...version, build: 7 }, { major: 1n, minor: 0n, patch: 0n, pre: '' }, null]) {
      assert.throws(() => matches([comparator], forged), { name: 'TypeError', message: 'expected a version, as parseVersion makes' })
    }
    for (const forged of [{ ...comparator, op: '!' }, { ...comparator, minor: undefined }, { ...comparator, patch: undefined, pre: 'rc' }, { ...comparator, pre: '01' }, '1.0.0']) {
      assert.throws(() => matches([forged], version), { name: 'TypeError', message: 'expected comparators, as parseVersionReq makes' })
    }
    assert.throws(() => matches('1.0.0', version), { name: 'TypeError', message: 'expected comparators, as parseVersionReq makes' })
    assert.equal(matches([comparator], { ...version, build: '001.a-b' }), true)
    assert.equal(matches(Array.from({ length: 32 }, () => comparator), version), true)
    assert.throws(() => matches(Array.from({ length: 33 }, () => comparator), version), { name: 'TypeError', message: 'expected comparators, as parseVersionReq makes' })
    // A hole is no comparator, where every and some would pass it by.
    for (const forged of [[], [comparator]]) {
      forged.length += 1
      assert.throws(() => matches(forged, version), { name: 'TypeError', message: 'expected comparators, as parseVersionReq makes' })
    }
    // Each field read once, so what is matched is what was checked.
    let reads = 0
    const shifty = Object.defineProperty({ ...comparator }, 'op', { enumerable: true, get: () => ((reads += 1) === 1 ? '>' : '!') })
    assert.equal(matches([shifty], version), false)
    assert.equal(reads, 1)
  })

  // Every shape in a grid, refused but where a parser reads it back the same.
  it('a TypeError for every version and comparator but what the parsers make', () => {
    const numbers = [0n, 1n, 1, -1n, 2n ** 64n, undefined]
    const tags = ['', 'rc', 'rc.01', 'a..b', 7, undefined]
    const tail = (mark, value) => (value === '' ? '' : `${mark}${value}`)
    const show = (value) => JSON.stringify(value, (key, part) => (typeof part === 'bigint' ? `${part}n` : part))
    let made = 0
    for (const [major, minor, patch, pre, build] of grid([numbers, numbers, numbers, tags, tags])) {
      const forged = { major, minor, patch, pre, build }
      if (isDeepStrictEqual(parseVersion(`${major}.${minor}.${patch}${tail('-', pre)}${tail('+', build)}`), forged)) {
        made += 1
        matches([], forged)
      } else {
        assert.throws(() => matches([], forged), { name: 'TypeError' }, show(forged))
      }
    }
    // 0n or 1n for each number, '' or 'rc' for a prerelease, and 'rc.01' too
    // for build metadata.
    assert.equal(made, 2 ** 4 * 3)
    made = 0
    const version = parseVersion('1.2.3')
    for (const [op, major, minor, patch, pre] of grid([[...'=><~^*', '>=', '<=', '!', '', '>= '], numbers, numbers, numbers, tags])) {
      const forged = { op, major, minor, patch, pre }
      const named = [major, minor, patch].filter((part) => part !== undefined).join('.')
      if (isDeepStrictEqual(parseVersionReq(op === '*' ? `${named}.*` : `${op}${named}${tail('-', pre)}`), [forged])) {
        made += 1
        matches([forged], version)
      } else {
        assert.throws(() => matches([forged], version), { name: 'TypeError' }, show(forged))
      }
    }
    // Of 0n or 1n, a major, minor and patch with '' or 'rc' after it, a major
    // and minor, or a major alone, for each of seven operators; and a major
    // and minor, or a major alone, for a wildcard.
    assert.equal(made, 7 * 2 * (2 * 2 * 2 + 2 + 1) + 2 * (2 + 1))
  })
})

function* grid([first, ...rest]) {
  if (first === undefined) return yield []
  for (const value of first) for (const others of grid(rest)) yield [value, ...others]
}

describe('the sanitize-filename crate, as Soldeer names a folder', () => {
  it('every name as the crate makes it, on Unix and on Windows', () => {
    for (const [name, unix, windows] of FIXTURE.sanitize) {
      assert.equal(sanitizeWithOptions(name, { windows: false, truncate: true, replacement: '-' }), unix, JSON.stringify(name))
      assert.equal(sanitizeWithOptions(name, { windows: true, truncate: true, replacement: '-' }), windows, JSON.stringify(name))
    }
  })

  it('in time linear in its length, a run of dots and spaces anywhere', () => {
    const start = performance.now()
    assert.equal(sanitizeWithOptions(`a${' '.repeat(100000)}b`, { windows: true, truncate: false, replacement: '-' }).length, 100002)
    assert.ok(performance.now() - start < 1000)
  })

  it('its other options: a replacement taken as it is, and no cut', () => {
    assert.equal(sanitizeWithOptions('a/b', { windows: false, truncate: true, replacement: '$&' }), 'a$&b')
    assert.equal(sanitizeWithOptions('a/b', { windows: false, truncate: true, replacement: '' }), 'ab')
    assert.equal(sanitizeWithOptions('x'.repeat(300), { windows: false, truncate: false, replacement: '-' }).length, 300)
  })
})

// std's own cases of Path::file_name, from Rust 1.97's
// library/std/tests/path.rs: test_decompositions_unix and _windows.
const PATHS = JSON.parse(readFileSync(new URL('fixtures/rust-path.json', import.meta.url), 'utf8'))

describe('path.js, as std::path reads a file name on Unix and on Windows', () => {
  for (const [os, cases] of Object.entries(PATHS)) {
    it(`every case std tests on ${os}`, () => {
      assert.ok(cases.length > 25)
      for (const [path, name] of cases) assert.equal(fileName(path, os === 'windows') ?? null, name, JSON.stringify(path))
    })
  }
})

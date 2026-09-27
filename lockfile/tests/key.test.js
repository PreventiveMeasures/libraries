import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { LockfileError } from '../src/error.js'
import { checkIntegrity, checkName, checkRelative, isVersion, joinRelative } from '../src/names.js'
import { packageKeyOf, refToKey, splitPackageKey, splitSnapshotKey } from '../src/pnpm/key.js'

// The pieces a key and its references are read by, one at a time.

describe('refToKey reads a reference as pnpm does', () => {
  for (const [ref, alias, key] of [
    ['1.0.0', 'a', 'a@1.0.0'],
    ['1.0.0(react@18.2.0)', 'a', 'a@1.0.0(react@18.2.0)'],
    ['1.0.0(patch_hash=abc)(react@18.2.0)', 'a', 'a@1.0.0(patch_hash=abc)(react@18.2.0)'],
    ['q@1.5.1', 'my-q', 'q@1.5.1'],
    ['@s/q@1.5.1', 'my-q', '@s/q@1.5.1'],
    ['q@1.5.1(react@18.2.0)', 'my-q', 'q@1.5.1(react@18.2.0)'],
    ['file:packages/ws-a(react@18.2.0)', 'ws-a', 'ws-a@file:packages/ws-a(react@18.2.0)'],
    ['local-dir@file:local-dir', 'x', 'local-dir@file:local-dir'],
    ['https://example.com/f.tgz', 'f', 'f@https://example.com/f.tgz'],
    ['git+ssh://git@github.com/a/b.git#abc', 'b', 'b@git+ssh://git@github.com/a/b.git#abc'],
    ['git+https://git@github.com:a/b.git#abc', 'b', 'b@git+https://git@github.com:a/b.git#abc'],
    ['b@git+https://git@github.com:a/b.git#abc', 'x', 'b@git+https://git@github.com:a/b.git#abc'],
  ]) {
    it(`${alias}: ${ref}`, () => assert.equal(refToKey(ref, alias), key))
  }
})

describe('a snapshot key splits where pnpm splits it', () => {
  for (const [key, base, patchHash] of [
    ['a@1.0.0', 'a@1.0.0', undefined],
    ['a@1.0.0(b@2.0.0)', 'a@1.0.0', undefined],
    ['a@1.0.0(b@2.0.0(c@3.0.0))(c@3.0.0)', 'a@1.0.0', undefined],
    ['a@1.0.0(patch_hash=abc)', 'a@1.0.0', 'abc'],
    ['a@1.0.0(patch_hash=abc)(b@2.0.0)', 'a@1.0.0', 'abc'],
    ['a@1.0.0(3c43e3b4d70b446a2aae7f4f7fbeccdd)', 'a@1.0.0', undefined],
    ['ws@file:packages/ws(react@18.2.0)', 'ws@file:packages/ws', undefined],
    // Not a suffix: the key does not end in a balanced group.
    ['a@1.0.0)', 'a@1.0.0)', undefined],
    ['a@1.0.0((b)', 'a@1.0.0((b)', undefined],
  ]) {
    it(key, () => {
      assert.deepEqual(splitSnapshotKey(key, 'here'), { base, patchHash })
      assert.equal(packageKeyOf(key), base)
    })
  }

  for (const key of ['a@1.0.0()', 'a@1.0.0(b)()', 'a@1.0.0(b)(patch_hash=abc)', 'a@1.0.0(patch_hash=)', 'a@1.0.0(patch_hash=A)']) {
    it(`refuses ${key}`, () => assert.throws(() => splitSnapshotKey(key, 'here'), LockfileError))
  }
})

describe('a package key is a name and what follows it', () => {
  it('splits at the @ after the name', () => {
    assert.deepEqual(splitPackageKey('@s/a@1.0.0', 'here'), { name: '@s/a', ref: '1.0.0' })
    assert.deepEqual(splitPackageKey('a@git+ssh://git@x/y.git#1', 'here'), { name: 'a', ref: 'git+ssh://git@x/y.git#1' })
  })

  it('refuses one with a suffix', () => {
    assert.throws(() => splitPackageKey('a@1.0.0(b@1.0.0)', 'here'), { message: 'here: "a@1.0.0(b@1.0.0)" carries a peer or patch suffix, which only a snapshot key does' })
  })
})

describe('names', () => {
  for (const name of ['a', 'JSONStream', '@s/a', '@s.x/a-b.c_d~e', 'constructor', '1', '-a', '~a', 'n'.repeat(214)]) {
    it(`takes ${name.slice(0, 20)}`, () => assert.equal(checkName(name, 'here'), name))
  }
  for (const name of ['', '.a', '_a', 'a b', 'a/b', '@s', '@s/', '@/a', '@s/a/b', 'a(b)', "a'", 'a!', 'a*', '..', '__proto__', 'ä', 'n'.repeat(215)]) {
    it(`refuses ${JSON.stringify(name.slice(0, 20))}`, () => assert.throws(() => checkName(name, 'here'), LockfileError))
  }
})

// npm's own semver, from the npm that ships beside node, as pnpm's reader
// uses it. A version is read here exactly when semver reads it and hands
// back the same text, but for build metadata, which it keeps apart.
const semver = (() => {
  try {
    return createRequire(join(dirname(process.execPath), '../lib/node_modules/npm/'))('semver')
  } catch {
    return undefined
  }
})()

const canonical = (text) => {
  try {
    const version = new semver.SemVer(text)
    return `${version.version}${version.build.length > 0 ? `+${version.build.join('.')}` : ''}` === text
  } catch {
    return false
  }
}

describe('versions', () => {
  const EDGES = [
    '0.0.0', '1.2.3', '1.2.3-0', '1.2.3-alpha.1', '1.2.3-0a', '1.2.3-a-b', '1.2.3+build.01', '1.2.3-rc.1+b', `${2 ** 53 - 1}.0.0`,
    'v1.2.3', '=1.2.3', ' 1.2.3', '1.2.3 ', '1.2', '1.2.3.4', '01.2.3', '1.02.3', '1.2.3-01', '1.2.3-', '1.2.3+', '1.2.3-a..b',
    `${2 ** 53}.0.0`, `1.2.3-${'1'.repeat(300)}`, `1.2.3-${'a'.repeat(250)}`, `1.2.3-${'a'.repeat(251)}`,
  ]

  it('agree with npm\'s semver on the edges', { skip: semver === undefined && 'npm is not beside node' }, () => {
    for (const version of EDGES) assert.equal(isVersion(version), canonical(version), version)
  })

  it('agree with npm\'s semver at random', { skip: semver === undefined && 'npm is not beside node' }, () => {
    const pieces = ['0', '1', '9', '10', '.', '.', '-', '+', 'a', 'Z', 'v', '=', ' ', '-0', '.0']
    let seed = 0x5EED
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31)
    for (let i = 0; i < 3000; i++) {
      let version = ['1.2.3', '0.0.', '1.', ''][next() % 4]
      for (let n = next() % 8; n > 0; n--) version += pieces[next() % pieces.length]
      assert.equal(isVersion(version), canonical(version), JSON.stringify(version))
    }
  })
})

describe('relative paths', () => {
  for (const path of ['.', 'a', 'a/b', '..', '../..', '../a/b', 'a.b/.c', 'a..']) {
    it(`takes ${path}`, () => assert.equal(checkRelative(path, 'here'), path))
  }
  for (const path of ['', '/', '/a', './a', 'a/', 'a//b', 'a/./b', 'a/..', 'a/../b', '../a/..', 'a\\b', 'C:', 'c:/a', 'a/\u202Eb', 'a/\nb']) {
    it(`refuses ${JSON.stringify(path)}`, () => assert.throws(() => checkRelative(path, 'here'), LockfileError))
  }

  for (const [base, path, joined] of [
    ['.', '.', '.'],
    ['.', 'a', 'a'],
    ['.', '../a', '../a'],
    ['a/b', '.', 'a/b'],
    ['a/b', '..', 'a'],
    ['a/b', '../..', '.'],
    ['a/b', '../../..', '..'],
    ['a/b', '../c', 'a/c'],
    ['../a', '..', '..'],
    ['../a', '../..', '../..'],
  ]) {
    it(`${base} + ${path} = ${joined}`, () => assert.equal(joinRelative(base, path), joined))
  }
})

describe('integrities', () => {
  for (const integrity of [
    'sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk=',
    'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=',
    'sha384-OLBgp1GsljhM2TJ+sbHjaiH9txEUvgdDTAzHv2P24donTt6/529l+9Ua0vFImLlb',
    'sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==',
  ]) {
    it(`takes ${integrity.slice(0, 7)}`, () => assert.equal(checkIntegrity(integrity, 'here'), integrity))
  }
  for (const integrity of [
    'sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk',
    'sha1-2jmj7l5rSw0yVb/vlWAYkK/YBw==',
    'sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg=',
    'SHA1-2jmj7l5rSw0yVb/vlWAYkK/YBwk=',
    'md5-1B2M2Y8AsgTpgAmY7PhCfg==',
    'sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk=?opt',
    'sha1-2jmj7l5rSw0yVb_vlWAYkK-YBwk=',
    '__proto__-x',
  ]) {
    it(`refuses ${integrity.slice(0, 16)}…`, () => assert.throws(() => checkIntegrity(integrity, 'here'), LockfileError))
  }
})

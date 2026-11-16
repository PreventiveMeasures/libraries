import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { parsePnpmLockfile } from '../../pnpm.js'
import { parseYaml } from '../../yaml.js'
import { FIXTURES } from './fixtures.js'

// Real lockfiles of 13.0, each beside what pnpm read it as: the lockfile
// it keeps in node_modules/.pnpm after a frozen install from it alone, in
// v9's shape, which is what pnpm installs from. Each is read here to what
// that is read to. pnpm keeps that one under 13.0 and with the
// `specifiers` of the directories, which no v9 lockfile it writes has, so
// it is read as one with both taken out, and the specifiers held apart.
// The lockfiles: scripts/record-pnpm-13.js's, of peers in every way the
// format records them, by pnpm 12.19.0, 12.20.0 and 12.21.0, and
// scripts/record-pnpm.js's, of the workspace the v9 fixtures are of, its
// config dependency and pinned pnpm, and the small project its pnpmfile
// and package extension rewrite.

const DIR = new URL('../fixtures/', import.meta.url)
const RECORDED = ['pnpm-13', 'pnpm-13-env', 'pnpm-13-hooks', 'pnpm-13-12.19']
const fixture = (name) => readFileSync(new URL(`${name}.yaml`, DIR), 'utf8')
const ALL = {
  ...FIXTURES,
  ...Object.fromEntries(RECORDED.map((name) => [name, { lockfile: fixture(name), read: fixture(`${name}-read`) }])),
}

const plain = (value) => structuredClone(value)

function asV9(read) {
  const text = read.replace(/^lockfileVersion: '13\.0'$/mu, "lockfileVersion: '9.0'").replace(/^ {4}specifiers:\n(?: {6}.*\n)+/gmu, '')
  return parsePnpmLockfile(text).lockfile
}

// Each package's specifiers, by package key, of what pnpm read.
const specifiersOf = (read) => Object.fromEntries(Object.entries(parseYaml(read).packages ?? {}).filter(([, pkg]) => pkg.specifiers !== undefined).map(([key, pkg]) => [key, plain(pkg.specifiers)]))

describe('a lockfile of 13.0 reads to what pnpm reads it as', () => {
  for (const [name, { lockfile, read }] of Object.entries(ALL)) {
    it(name, () => {
      const ours = parsePnpmLockfile(lockfile).lockfile
      const theirs = asV9(read)
      assert.equal(ours.lockfileVersion, '13.0')
      const specifiers = {}
      const mine = plain(ours)
      for (const [key, pkg] of Object.entries(mine.packages)) {
        if (pkg.specifiers !== undefined) specifiers[key.replace(/\(.*$/u, '')] = pkg.specifiers
        delete pkg.specifiers
      }
      // A lockfile of 13.0 keeps no deprecation, which pnpm read anew where
      // it resolved before.
      for (const pkg of Object.values(theirs.packages)) delete pkg.specifiers
      for (const pkg of Object.values(theirs.packages)) pkg.deprecated = undefined
      assert.deepEqual({ ...mine, lockfileVersion: '9.0' }, plain(theirs))
      const recorded = specifiersOf(read)
      assert.deepEqual(Object.keys(specifiers).sort(), Object.keys(recorded).sort())
      for (const [key, value] of Object.entries(recorded)) {
        assert.deepEqual(plain(specifiers[key].dependencies), value.dependencies ?? {}, key)
        assert.equal(specifiers[key].manifestSource, value.manifestSource, key)
      }
    })
  }
})

describe('the workspace of the v9 fixtures, as pnpm 12 writes it in 13.0', () => {
  const v13 = parsePnpmLockfile(fixture('pnpm-13'))
  const v9 = parsePnpmLockfile(fixture('pnpm-12')).lockfile
  const lock = v13.lockfile

  it('asks for the same, of the same importers', () => {
    assert.deepEqual(Object.keys(lock.importers), Object.keys(v9.importers))
    for (const id of Object.keys(v9.importers)) assert.deepEqual(plain(lock.importers[id].specifiers), plain(v9.importers[id].specifiers), id)
    assert.deepEqual(plain(lock.importers['.'].dependenciesMeta), plain(v9.importers['.'].dependenciesMeta))
  })

  it('records the settings v9 has as sections of their own', () => {
    assert.deepEqual(plain(lock.settings), plain(v9.settings))
    assert.deepEqual(plain(lock.catalogs), plain(v9.catalogs))
    assert.deepEqual(plain(lock.overrides), plain(v9.overrides))
    assert.deepEqual(plain(lock.patchedDependencies), plain(v9.patchedDependencies))
  })

  it('records what a directory asked for, from 12.20.0', () => {
    assert.deepEqual(plain(lock.packages['local-dir@file:local-dir'].specifiers), { dependencies: { 'is-number': '^7.0.0' }, optionalDependencies: {}, dependenciesMeta: {}, manifestSource: 'path' })
    assert.equal(lock.packages['ws-a@file:packages/ws-a(react@18.2.0)'].specifiers.manifestSource, 'workspace')
    assert.equal(parsePnpmLockfile(fixture('pnpm-13-12.19')).lockfile.packages['local-dir@file:local-dir'].specifiers, undefined)
    assert.equal(v9.packages['local-dir@file:local-dir'].specifiers, undefined)
  })

  it('leads with the env document in v9, where there is one', () => {
    const { env, lockfile } = parsePnpmLockfile(fixture('pnpm-13-env'))
    assert.equal(env.lockfileVersion, '9.0')
    assert.deepEqual(Object.keys(env.importers['.'].packageManagerDependencies), ['pnpm'])
    assert.equal(lockfile.lockfileVersion, '13.0')
  })

  it('the small project, with its checksums, ignored optional dependencies and publish times', () => {
    const hooks = parsePnpmLockfile(fixture('pnpm-13-hooks')).lockfile
    assert.match(hooks.packageExtensionsChecksum, /^sha256-/u)
    assert.match(hooks.pnpmfileChecksum, /^sha256-/u)
    assert.deepEqual(plain(hooks.ignoredOptionalDependencies), ['fsevents', '@esbuild/*'])
    assert.deepEqual(Object.keys(hooks.time).sort(), ['is-odd@3.0.1', 'mkdirp@1.0.4', 'react-dom@18.2.0', 'react@18.2.0'])
    assert.equal(hooks.settings.peersSuffixMaxLength, 0)
  })
})

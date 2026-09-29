import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { TomlDateTime, parseToml } from '../../toml.js'
import { plain } from './reference.js'

// The baseline: real files, each written by its own tool or kept by its own
// project — Cargo.lock, uv.lock, poetry.lock, a pylock.toml from uv and one
// from pip, three projects' foundry.toml, and Cargo.toml as crates.io
// serves it, published and as written — with the .json of what Python's
// tomllib reads from each beside it. scripts/record-toml.js records them
// all; its header says how.

const FIXTURES = new URL('fixtures/', import.meta.url)
const text = (name) => readFileSync(new URL(name, FIXTURES), 'utf8')
const read = (name) => parseToml(text(name))

const NAMES = [
  'Cargo.lock', 'uv.lock', 'poetry.lock', 'pylock.uv.toml', 'pylock.pip.toml',
  'foundry.forge-std.toml', 'foundry.solady.toml', 'foundry.openzeppelin.toml',
  'Cargo.regex.toml', 'Cargo.regex.toml.orig', 'Cargo.toml_edit.toml',
]

describe('reads what tomllib reads', () => {
  for (const name of NAMES) {
    it(name, () => assert.deepEqual(plain(read(name)), JSON.parse(text(`${name}.json`))))
  }
})

describe('each, spot-checked', () => {
  it('Cargo.toml: a multi-line description, published and as written', () => {
    const description = 'An implementation of regular expressions for Rust. This implementation uses\nfinite automata and guarantees linear time matching on all inputs.\n'
    assert.equal(read('Cargo.regex.toml').package.description, description)
    assert.equal(read('Cargo.regex.toml.orig').package.description, description)
  })

  it('Cargo.toml: cargo-release replacements in multi-line strings', () => {
    const replacements = read('Cargo.toml_edit.toml').package.metadata.release['pre-release-replacements']
    assert.ok(replacements.some((item) => item.replace === '<!-- next-header -->\n## [Unreleased] - ReleaseDate\n'))
    assert.ok(replacements.some((item) => item.replace.startsWith('<!-- next-url -->\n[Unreleased]: ')))
  })

  it('Cargo.lock: the format version, and a package from git', () => {
    const lock = read('Cargo.lock')
    assert.equal(lock.version, 4)
    const semver = lock.package.find((pkg) => pkg.name === 'semver')
    assert.match(semver.source, /^git\+https:\/\/github\.com\/dtolnay\/semver\?tag=1\.0\.23#[\da-f]{40}$/u)
    assert.equal(lock.package.find((pkg) => pkg.name === 'demo').dependencies.includes('winapi-util'), true)
  })

  it('uv.lock: inline tables, and tables of the last package', () => {
    const lock = read('uv.lock')
    const own = lock.package.find((pkg) => pkg.name === 'uv-demo')
    assert.deepEqual(structuredClone(own.source), { virtual: '.' })
    assert.deepEqual(structuredClone(own.metadata['requires-dev']), { lint: [{ name: 'ruff', specifier: '==0.4.4' }] })
    assert.equal(lock.package.at(-1), own)
  })

  it('pylock.uv.toml: upload times as date-times', () => {
    const lock = read('pylock.uv.toml')
    const time = lock.packages[0].sdist['upload-time']
    assert.ok(time instanceof TomlDateTime)
    assert.match(time.text, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/u)
    assert.equal(time.toDate().toISOString().replace('.000Z', 'Z'), time.text)
  })

  it('pylock.pip.toml: a table of the last wheel of the last package', () => {
    const lock = read('pylock.pip.toml')
    assert.match(lock.packages.at(-1).wheels.at(-1).hashes.sha256, /^[\da-f]{64}$/u)
  })

  it('poetry.lock: booleans, and quotes escaped in a marker', () => {
    const lock = read('poetry.lock')
    assert.equal(lock.package[0].optional, false)
    assert.ok(lock.package.some((pkg) => pkg.markers === 'sys_platform == "win32"'))
  })

  it('foundry.toml: underscores in integers, and comments dropped', () => {
    const config = read('foundry.solady.toml')
    assert.equal(config.profile.default.gas_limit, 100_000_000)
    assert.equal(config.profile.default.optimizer_runs, 1000)
    assert.equal(config.profile.default.evm_version, 'paris')
    assert.deepEqual(structuredClone(config.profile.default.fuzz), { runs: 256 })
  })
})

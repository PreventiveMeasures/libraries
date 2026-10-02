import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseCargoManifest, patchesCargoSource } from '../../cargo.js'

// Which [patch] tables patch a dependency, as linkCargo and cargo match
// them. The crates.io ones are cargo 1.97's: a dependency on crates.io,
// patched by a path under each key, resolves offline only where cargo takes
// the patch.

const CRATES_IO = { type: 'registry', registry: undefined, index: undefined }
const git = (url, reference = {}) => ({ type: 'git', url, branch: undefined, tag: undefined, rev: undefined, ...reference })

describe('patchesCargoSource', () => {
  it('patches crates.io by its name or its index\'s URL, as canonical', () => {
    const keys = [
      'crates-io',
      'https://github.com/rust-lang/crates.io-index',
      'https://github.com/Rust-Lang/Crates.io-Index',
      'https://github.com/rust-lang/crates.io-index/',
      'https://github.com/rust-lang/crates.io-index.git',
      'http://github.com/rust-lang/crates.io-index',
    ]
    for (const key of keys) assert.equal(patchesCargoSource(key, CRATES_IO), true, key)
    assert.equal(patchesCargoSource('crates-io', { ...CRATES_IO, registry: 'crates-io' }), true)
    assert.equal(patchesCargoSource('crates-io', { ...CRATES_IO, index: 'https://github.com/rust-lang/crates.io-index' }), true)
  })

  it('patches no dependency of crates.io by the sparse index it is fetched from', () => {
    for (const key of ['sparse+https://index.crates.io', 'sparse+https://index.crates.io/']) assert.equal(patchesCargoSource(key, CRATES_IO), false, key)
  })

  it('patches another registry by its name where named, and by its index where that is given', () => {
    const corp = { ...CRATES_IO, registry: 'corp' }
    assert.deepEqual(['corp', 'crates-io', 'https://corp.example/index'].map((key) => patchesCargoSource(key, corp)), [true, false, false])
    const indexed = { ...CRATES_IO, index: 'sparse+https://corp.example/index/' }
    assert.deepEqual(['sparse+https://corp.example/index', 'https://corp.example/index', 'corp'].map((key) => patchesCargoSource(key, indexed)), [true, false, false])
  })

  it('patches a git repository by its URL whatever the reference, in lower case on github.com alone', () => {
    const github = git('https://github.com/foo/bar', { tag: 'v1' })
    assert.deepEqual(['https://github.com/Foo/Bar.git', 'https://github.com/foo/bar/', 'https://github.com/foo/baz'].map((key) => patchesCargoSource(key, github)), [true, true, false])
    const other = git('https://example.com/foo/bar')
    assert.deepEqual(['https://EXAMPLE.com/foo/bar.git', 'https://example.com/Foo/Bar'].map((key) => patchesCargoSource(key, other)), [true, false])
  })

  it('patches no path dependency', () => {
    assert.equal(patchesCargoSource('crates-io', { type: 'path', path: '../x' }), false)
  })

  it('takes the sources parseCargoManifest gives', () => {
    const manifest = parseCargoManifest('[package]\nname = "a"\nversion = "0.1.0"\n\n[dependencies]\nb = "1"\nc = { git = "https://github.com/x/c", branch = "main" }\n')
    const [b, c] = manifest.package.dependencies
    assert.deepEqual([patchesCargoSource('crates-io', b.source), patchesCargoSource('https://github.com/X/C', c.source)], [true, true])
  })

  it('throws a TypeError for anything but a key and a source', () => {
    assert.throws(() => patchesCargoSource(undefined, CRATES_IO), TypeError)
    assert.throws(() => patchesCargoSource('crates-io', { type: 'svn' }), TypeError)
    assert.throws(() => patchesCargoSource('crates-io', { type: 'git' }), TypeError)
    assert.throws(() => patchesCargoSource('crates-io', { ...CRATES_IO, registry: 1 }), TypeError)
    assert.throws(() => patchesCargoSource('crates-io', git('not a url')), TypeError)
  })
})

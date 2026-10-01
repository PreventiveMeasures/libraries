import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { LockfileError, parseSoldeerLockfile } from '../../soldeer.js'
import { parseToml } from '../../toml.js'

// Real lockfiles, each with the soldeer.toml it was written for: Soldeer
// 0.12, 0.11 and 0.5 locking one config of every kind of dependency;
// 0.12 with none; and 0.12 adding one to a lockfile of 0.11.
// scripts/record-soldeer.js builds them.

const FIXTURES = new URL('fixtures/', import.meta.url)
const text = (name) => readFileSync(new URL(`${name}.lock`, FIXTURES), 'utf8')
const config = (name) => parseToml(readFileSync(new URL(`${name}.toml`, FIXTURES), 'utf8'))
const read = (name) => parseSoldeerLockfile(text(name), { config: config(name) })

const plain = (value) => structuredClone(value)

const OZ = 'https://soldeer-revisions.s3.amazonaws.com/@openzeppelin-contracts/5_1_0_19-10-2024_10:28:52_contracts.zip'

describe('every kind of dependency, as Soldeer 0.12 writes it', () => {
  const lock = read('soldeer-0.12.0')

  it('the format, and every entry by name, sorted', () => {
    assert.equal(lock.lockfileVersion, 2)
    assert.deepEqual(Object.keys(lock.dependencies), ['@openzeppelin-contracts', 'forge-std', 'is-number', 'isarray', 'oz', 'solady'])
  })

  it('a registry package, resolved from the range the config asks for', () => {
    assert.equal(config('soldeer-0.12.0').dependencies['@openzeppelin-contracts'], '~5.1.0')
    assert.deepEqual(plain(lock.dependencies['@openzeppelin-contracts']), {
      type: 'http',
      name: '@openzeppelin-contracts',
      version: '5.1.0',
      url: OZ,
      checksum: 'fd3d1ea561cb27897008aee18ada6e85f248eb161c86e4435272fc2b5777574f',
      integrity: 'cb6cf6e878f2943b2291d5636a9d72ac51d43d8135896ceb6cf88d36c386f212',
    })
  })

  it('a zip by the URL the config names, of the version it names', () => {
    assert.equal(lock.dependencies.oz.url, OZ)
    assert.equal(lock.dependencies.oz.version, '5.1.0')
  })

  it('git repositories, by tag and by commit, at the commit they resolved to', () => {
    assert.deepEqual(plain(lock.dependencies.isarray), { type: 'git', name: 'isarray', version: '2.0.5', git: 'https://github.com/juliangruber/isarray.git', rev: '63ea4ca0a0d6b0574d6a470ebd26880c3026db4a' })
    assert.equal(lock.dependencies['is-number'].rev, '98e8ff1da1a89f93d1397a24d7413ed15421c139')
  })

  it('the same, without the config', () => {
    assert.deepEqual(plain(parseSoldeerLockfile(text('soldeer-0.12.0'))), plain(lock))
  })
})

describe('the first format, of no version, as Soldeer 0.11 and 0.5 write it', () => {
  for (const name of ['soldeer-0.11.0', 'soldeer-0.5.4']) {
    it(`${name}: the same entries as 0.12's`, () => {
      const lock = read(name)
      assert.equal(lock.lockfileVersion, 1)
      assert.deepEqual(plain(lock.dependencies), plain(read('soldeer-0.12.0').dependencies))
      assert.equal(text('soldeer-0.12.0'), `version = 2\n\n${text(name)}`)
    })
  }
})

describe('what else Soldeer 0.12 writes', () => {
  it('no dependencies, as an empty array', () => {
    assert.equal(text('soldeer-0.12.0-empty'), 'version = 2\ndependencies = []\n')
    assert.deepEqual(plain(read('soldeer-0.12.0-empty')), { lockfileVersion: 2, dependencies: {} })
  })

  it('the first format, kept as it adds to a lockfile of 0.11, as a version of 1', () => {
    const lock = read('soldeer-0.12.0-legacy')
    assert.match(text('soldeer-0.12.0-legacy'), /^version = 1\n\n\[\[dependencies\]\]\n/u)
    assert.equal(lock.lockfileVersion, 1)
    assert.deepEqual(Object.keys(lock.dependencies), ['forge-std', 'solady'])
  })
})

describe('the config, as Soldeer 0.12 holds it to the lockfile', () => {
  const refuses = (edit, message) => {
    const dependencies = { ...config('soldeer-0.12.0').dependencies, ...edit }
    for (const [name, value] of Object.entries(dependencies)) if (value === undefined) delete dependencies[name]
    assert.throws(() => parseSoldeerLockfile(text('soldeer-0.12.0'), { config: { dependencies } }), (error) => error instanceof LockfileError && error.message === message)
  }

  it('a dependency the lockfile has no entry for, and an entry no dependency asks for', () => {
    refuses({ 'forge-std': undefined }, 'dependencies["forge-std"]: nothing in the config asks for it, and Soldeer drops it')
    refuses({ extra: '1.0.0' }, 'config.dependencies.extra: no entry in the lockfile, which Soldeer then resolves anew')
  })

  it('a range the locked version does not satisfy, and a version not the very one for a URL or git', () => {
    refuses({ '@openzeppelin-contracts': '~5.2.0' }, 'config.dependencies["@openzeppelin-contracts"].version: "~5.2.0", which its entry\'s version, "5.1.0", does not satisfy')
    // No operator is the very version, where semver would take it as ^.
    refuses({ '@openzeppelin-contracts': '5.0.0' }, 'config.dependencies["@openzeppelin-contracts"].version: "5.0.0", which its entry\'s version, "5.1.0", does not satisfy')
    refuses({ oz: { version: '5.1', url: OZ } }, 'config.dependencies.oz.version: "5.1", which its entry\'s version, "5.1.0", is not')
  })

  it('another URL, repository or commit than the entry\'s, or another kind', () => {
    refuses({ oz: { version: '5.1.0', url: `${OZ}?x` } }, `config.dependencies.oz.url: "${OZ}?x", where its entry has "${OZ}"`)
    refuses({ isarray: { version: '2.0.5', git: 'https://example.com/isarray.git' } }, 'config.dependencies.isarray.git: "https://example.com/isarray.git", where its entry has "https://github.com/juliangruber/isarray.git"')
    refuses({ 'is-number': { version: '7.0.0', git: 'https://github.com/jonschlinkert/is-number.git', rev: '98e8ff1' } }, 'config.dependencies["is-number"].rev: "98e8ff1", where its entry has "98e8ff1da1a89f93d1397a24d7413ed15421c139"')
    refuses({ solady: { version: '0.0.238', git: 'https://example.com/solady.git' } }, 'config.dependencies.solady: a git dependency, whose entry is a registry one')
  })
})

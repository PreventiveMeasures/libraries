import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { LockfileError, parsePackageResolved } from '../../swiftpm.js'
import { FIXTURES } from './fixtures.js'
import { readPin } from './write.js'

// The baseline: real lockfiles, each with the manifest of its root package,
// written by `swift package resolve` of SwiftPM 6.4.2: a package of each
// kind of pin a repository has, of the root's tools version 5.5, 5.9 and
// 6.0, which write versions 1, 2 and 3, the last with a short hash SwiftPM
// keeps as a branch and a dependency with one of its own; and of a
// registry's package, by its identity and by a repository's URL SwiftPM
// looked up in the registry. scripts/record-swiftpm.js records them, and
// the manifest of each, into fixtures.json.br; its header says what is in
// them.

const lockfile = (name) => FIXTURES[`swiftpm-6.4.2-${name}`].resolved
const manifest = (name) => FIXTURES[`swiftpm-6.4.2-${name}`].manifest

const plain = (value) => structuredClone(value)

const repository = (identity, location, state, name) => readPin({ identity, location, name, ...state })

const ATOMICS = (name) => repository('swift-atomics', 'https://github.com/Apple/Swift-Atomics.git', { branch: 'main', revision: 'bc30c67cf0c4479633621ad7950d71494a07390f' }, name)
const LOG = (name) => repository('swift-log', 'https://github.com/apple/swift-log.git', { version: '1.6.1', revision: '9cb486020ebf03bfa5b5df985387a14a98744537' }, name)
const NUMERICS = (name) => repository('swift-numerics', 'https://github.com/apple/swift-numerics', { revision: '0a5bc04095a675662cf24757cc0640aa2204253b' }, name)

const LINKED_LIST = readPin({ identity: 'mona.LinkedList', kind: 'registry', version: '1.2.0' })

describe('a package of each kind of pin a repository has, as SwiftPM 6.4.2 writes it', () => {
  it('version 1, of tools version 5.5: each by its location, with the name its manifest gives the package', async () => {
    const resolved = await parsePackageResolved(lockfile('v1'))
    assert.equal(Object.getPrototypeOf(resolved.pins), null)
    assert.deepEqual(plain(resolved), {
      version: 1,
      originHash: undefined,
      pins: { 'swift-atomics': ATOMICS('swift-atomics'), 'swift-log': LOG('swift-log'), 'swift-numerics': NUMERICS('swift-numerics') },
    })
  })

  it('version 2, of 5.9: the same, by identity and kind, and no name', async () => {
    assert.deepEqual(plain(await parsePackageResolved(lockfile('v2'))), {
      version: 2,
      originHash: undefined,
      pins: { 'swift-atomics': ATOMICS(), 'swift-log': LOG(), 'swift-numerics': NUMERICS() },
    })
  })

  it('version 3, of 6.0: with originHash, a short hash as a branch, and what a dependency depends on', async () => {
    const resolved = await parsePackageResolved(lockfile('v3'), { manifest: manifest('v3') })
    assert.deepEqual(Object.keys(resolved.pins), ['swift-atomics', 'swift-collections', 'swift-distributed-tracing', 'swift-log', 'swift-numerics', 'swift-service-context'])
    assert.deepEqual(plain(resolved), {
      version: 3,
      originHash: '4ffabeebe8cdee650c1e0e1a411d5028faea4f8bd469d7423d075cb869659778',
      pins: {
        'swift-atomics': ATOMICS(),
        'swift-collections': repository('swift-collections', 'https://github.com/apple/swift-collections', { branch: '8d9834a', revision: '8d9834a6189db730f6264db7556a7ffb751e99ee' }),
        'swift-distributed-tracing': repository('swift-distributed-tracing', 'https://github.com/apple/swift-distributed-tracing.git', { version: '1.1.2', revision: '6483d340853a944c96dbcc28b27dd10b6c581703' }),
        'swift-log': LOG(),
        'swift-numerics': NUMERICS(),
        'swift-service-context': repository('swift-service-context', 'https://github.com/apple/swift-service-context.git', { version: '1.3.0', revision: 'd0997351b0c7779017f88e7a93bc30a1878d7f29' }),
      },
    })
  })

  it('the manifest held to originHash, as text or bytes, and refused of another', async () => {
    const text = manifest('v3')
    for (const given of [text, new TextEncoder().encode(text)]) {
      assert.equal((await parsePackageResolved(lockfile('v3'), { manifest: given })).originHash, '4ffabeebe8cdee650c1e0e1a411d5028faea4f8bd469d7423d075cb869659778')
    }
    await assert.rejects(() => parsePackageResolved(lockfile('v3'), { manifest: `${text} ` }), (error) => error instanceof LockfileError && error.where === 'originHash'
      && error.message.startsWith('originHash: not the sha256 of the manifest given, '))
    await assert.rejects(() => parsePackageResolved(lockfile('v3'), { manifest: manifest('v2') }), (error) => error instanceof LockfileError && error.where === 'originHash')
  })

  it('a manifest refused of versions 1 and 2, which have no originHash', async () => {
    for (const name of ['v1', 'v2']) {
      await assert.rejects(() => parsePackageResolved(lockfile(name), { manifest: manifest(name) }), (error) => error instanceof LockfileError
        && error.message === 'no originHash to hold the manifest to, which SwiftPM writes in version 3 alone')
    }
  })
})

describe('a registry\'s package, as SwiftPM 6.4.2 writes it', () => {
  it('by its identity, in the case the manifest gives it, and no location', async () => {
    assert.deepEqual(plain(await parsePackageResolved(lockfile('registry'), { manifest: manifest('registry') })), {
      version: 3,
      originHash: '22be882cf465774aea3d763d5c8f6e526ca1f85cb448a11b3898b45304f6a9be',
      pins: { 'mona.LinkedList': LINKED_LIST, 'swift-log': LOG() },
    })
  })

  it('looked up by a repository\'s URL: that URL as originalLocation', async () => {
    assert.deepEqual(plain((await parsePackageResolved(lockfile('scm-registry'), { manifest: manifest('scm-registry') })).pins), {
      'mona.LinkedList': { ...LINKED_LIST, originalLocation: 'https://github.com/mona/LinkedList' },
      'swift-log': LOG(),
    })
  })
})

describe('the fixtures as git and Windows leave them', () => {
  it('checked out with CRLF throughout: the same', async () => {
    for (const name of ['v1', 'v2', 'v3']) {
      assert.deepEqual(plain(await parsePackageResolved(lockfile(name).replaceAll('\n', '\r\n'))), plain(await parsePackageResolved(lockfile(name))))
    }
  })

  it('without the line end at the end, as SwiftPM writes on Windows, and before 5.6', async () => {
    for (const name of ['v1', 'v2', 'v3']) {
      assert.deepEqual(plain(await parsePackageResolved(lockfile(name).trimEnd())), plain(await parsePackageResolved(lockfile(name))))
    }
  })
})

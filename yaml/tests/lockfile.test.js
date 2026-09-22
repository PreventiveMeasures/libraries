import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { parseYaml } from '../index.js'

// The baseline: real lockfiles, one per format pnpm has written — 5.4 (pnpm
// 7), 6.0 (pnpm 8) and 9.0 (pnpm 10) — generated from one project that
// pulls in every kind of dependency a lockfile records: registry, tarball,
// git, link and workspace packages, peers, a catalog, overrides, injected
// and optional dependencies, platform bindings, bins, and deprecation
// notices in each of the three shapes they take (plain, quoted and a `|`
// block). Beside them a hand-written pnpm-workspace.yaml, with comments.
//
// Each has a .json next to it: what js-yaml 4.1.0, pnpm's own reader, makes
// of the same text. Reading the same data out of it is the whole claim.

const FIXTURES = new URL('fixtures/', import.meta.url)
const fixture = (name) => readFileSync(new URL(name, FIXTURES), 'utf8')

// Mappings come back with a null prototype, which strict deepEqual holds
// against JSON.parse's objects; structuredClone gives them Object.prototype
// back and changes nothing else.
const parse = (text) => structuredClone(parseYaml(text))

describe('reads what js-yaml reads', () => {
  for (const name of ['lockfile-v9', 'lockfile-v6', 'lockfile-v5.4', 'workspace']) {
    it(name, () => {
      assert.deepEqual(parse(fixture(`${name}.yaml`)), JSON.parse(fixture(`${name}.json`)))
    })
  }
})

describe('a v9 lockfile, spot-checked', () => {
  const lock = parseYaml(fixture('lockfile-v9.yaml'))

  it('mappings have no prototype', () => {
    assert.equal(Object.getPrototypeOf(lock), null)
    assert.equal(Object.getPrototypeOf(lock.packages), null)
  })

  it('the header', () => {
    assert.equal(lock.lockfileVersion, '9.0')
    assert.deepEqual(structuredClone(lock.settings), { autoInstallPeers: true, excludeLinksFromLockfile: false })
  })

  it('specifiers that need quoting', () => {
    assert.equal(lock.importers['.'].dependencies.react.specifier, 'catalog:')
    assert.equal(lock.importers['.'].dependencies['ws-pkg'].specifier, 'workspace:*')
    assert.equal(lock.importers['.'].dependencies['react-dom'].version, '18.2.0(react@18.2.0)')
  })

  it('flow collections under a package', () => {
    const binding = lock.packages['@img/sharp-linux-x64@0.33.5']
    assert.deepEqual(structuredClone(binding.engines), { node: '^18.17.0 || ^20.3.0 || >=21.0.0' })
    assert.deepEqual(binding.cpu, ['x64'])
    assert.deepEqual(binding.os, ['linux'])
    assert.deepEqual(binding.libc, ['glibc'])
    assert.deepEqual(structuredClone(lock.packages['extsprintf@1.3.0'].engines), { 0: 'node >=0.6.0' })
    assert.deepEqual(structuredClone(lock.snapshots['assert-plus@1.0.0']), {})
  })

  it('a git resolution, whose repo has a colon in it', () => {
    const key = 'isarray@git+https://git@github.com:juliangruber/isarray.git#63ea4ca0a0d6b0574d6a470ebd26880c3026db4a'
    assert.deepEqual(structuredClone(lock.packages[key].resolution), {
      commit: '63ea4ca0a0d6b0574d6a470ebd26880c3026db4a',
      repo: 'git@github.com:juliangruber/isarray.git',
      type: 'git',
    })
  })

  it('deprecation notices, in all three shapes', () => {
    assert.equal(lock.packages['request@2.88.2'].deprecated, 'request has been deprecated, see https://github.com/request/request/issues/3142')
    assert.match(lock.packages['stable@0.1.8'].deprecated, /^Modern JS already guarantees .* MDN: https:\/\/developer\.mozilla\.org\/.*#browser_compatibility$/u)
    const q = lock.packages['q@1.5.1'].deprecated
    assert.match(q, /^You or someone you depend on is using Q, .* Be excellent to each other\.\n\n\(For a CapTP .*captp\)$/u)
    assert.equal(q.split('\n').length, 3)
  })
})

describe('the older formats', () => {
  it('5.4 wrote its version as a number, 6.0 as a string', () => {
    assert.equal(parseYaml(fixture('lockfile-v5.4.yaml')).lockfileVersion, 5.4)
    assert.equal(parseYaml(fixture('lockfile-v6.yaml')).lockfileVersion, '6.0')
  })

  it('both carry the same block-scalar notice under their own keys', () => {
    const v6 = parseYaml(fixture('lockfile-v6.yaml')).packages['/q@1.5.1'].deprecated
    const v54 = parseYaml(fixture('lockfile-v5.4.yaml')).packages['/q/1.5.1'].deprecated
    assert.equal(v6, v54)
    assert.match(v6, /each other\.\n\n\(For a CapTP/u)
  })
})

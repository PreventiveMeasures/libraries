import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { LockfileError, parseFoundryLockfile, parseGitmodules } from '../../foundry.js'

// The baseline: real lockfiles, each with the .gitmodules of its repository.
// forge 1.3.0, which writes its keys in no order, and 1.8.3 wrote a project
// of a tag, a branch, a commit and a tag under another directory; 1.8.3 the
// same written again by forge install after its lockfile was deleted, a
// project in a monorepo with a submodule outside it, one with everything
// removed again, and one with a commit given by a short hash, which its own
// build --locked refuses. scripts/record-foundry.js builds them; its header
// says what is in them.

const FIXTURES = new URL('fixtures/', import.meta.url)
const lockfile = (name) => readFileSync(new URL(`${name}.lock`, FIXTURES), 'utf8')
const gitmodules = (name) => readFileSync(new URL(`${name}.gitmodules`, FIXTURES), 'utf8')
const read = (name, directory) => parseFoundryLockfile(lockfile(name), { gitmodules: gitmodules(name), directory })

const plain = (value) => structuredClone(value)

const FORGE_STD = 'https://github.com/foundry-rs/forge-std'
const SOLMATE = 'https://github.com/transmissions11/solmate'
const PINNED = 'c93f7716c9909175d45f6ef80a34a650e2d24e56'
const V1_9_7 = '77041d2ce690e692d6e03cc812b57d1ddaa4d505'
const V6 = 'a9e3ea26a2dc73bfa87f0cb189687d029028e0c5'
const MAIN = '89365b880c4f3c786bdd453d4b8e8fe410344a69'

const PROJECT = {
  'lib/forge-std': { type: 'tag', name: 'v1.9.7', rev: V1_9_7, url: FORGE_STD },
  'lib/pinned': { type: 'rev', name: undefined, rev: PINNED, url: SOLMATE },
  'lib/solmate': { type: 'branch', name: 'main', rev: MAIN, url: SOLMATE },
  'lib/v6': { type: 'tag', name: 'v6', rev: V6, url: SOLMATE },
}

describe('a project of each kind of dependency, as forge writes it', () => {
  it('forge 1.8.3: in order, each pinned as it was installed', () => {
    const { dependencies } = read('forge-1.8.3')
    assert.equal(Object.getPrototypeOf(dependencies), null)
    assert.deepEqual(Object.keys(dependencies), ['lib/forge-std', 'lib/pinned', 'lib/solmate', 'lib/v6'])
    assert.deepEqual(plain(dependencies), PROJECT)
  })

  it('forge 1.3.0: the same, in the order forge wrote, which is none', () => {
    const { dependencies } = read('forge-1.3.0')
    assert.deepEqual(Object.keys(dependencies), ['lib/pinned', 'lib/forge-std', 'lib/v6', 'lib/solmate'])
    assert.deepEqual(plain(dependencies), PROJECT)
  })

  it('without .gitmodules, the same with no url', () => {
    const { dependencies } = parseFoundryLockfile(lockfile('forge-1.8.3'))
    assert.deepEqual(plain(dependencies), Object.fromEntries(Object.entries(PROJECT).map(([path, dependency]) => [path, { ...dependency, url: undefined }])))
  })

  it('written again by forge install: a commit for each, but the branch .gitmodules gives', () => {
    const { dependencies } = read('forge-1.8.3-synced')
    assert.deepEqual(plain(dependencies), {
      'lib/forge-std': { type: 'rev', name: undefined, rev: V1_9_7, url: FORGE_STD },
      'lib/pinned': { type: 'rev', name: undefined, rev: PINNED, url: SOLMATE },
      'lib/solmate': { type: 'branch', name: 'main', rev: MAIN, url: SOLMATE },
      'lib/v6': { type: 'rev', name: undefined, rev: V6, url: SOLMATE },
    })
  })

  it('the .gitmodules beside them, by name', () => {
    const submodules = parseGitmodules(gitmodules('forge-1.8.3'))
    assert.equal(Object.getPrototypeOf(submodules), null)
    assert.deepEqual(plain(submodules), {
      'lib/forge-std': { path: 'lib/forge-std', url: FORGE_STD, branch: undefined },
      'lib/solmate': { path: 'lib/solmate', url: SOLMATE, branch: 'main' },
      'lib/pinned': { path: 'lib/pinned', url: SOLMATE, branch: undefined },
      'lib/v6': { path: 'lib/v6', url: SOLMATE, branch: undefined },
    })
  })
})

describe('a project in a monorepo, as forge 1.8.3 writes it', () => {
  const name = 'forge-1.8.3-monorepo'

  it('its own submodule, and the repository\'s outside it, from the project', () => {
    assert.deepEqual(plain(read(name, 'packages/contracts').dependencies), {
      '../../other/lib/solmate': { type: 'rev', name: undefined, rev: MAIN, url: SOLMATE },
      'lib/forge-std': { type: 'tag', name: 'v1.9.7', rev: V1_9_7, url: FORGE_STD },
    })
  })

  it('refused with .gitmodules but not where the project is in the repository', () => {
    assert.throws(() => read(name), (error) => error instanceof LockfileError && error.where === '["../../other/lib/solmate"]')
    assert.throws(() => read(name, 'packages'), (error) => error instanceof LockfileError && error.message === '["../../other/lib/solmate"]: outside the repository, from the lockfile\'s directory "packages" in it')
  })

  it('read alone, without the repository', () => {
    assert.deepEqual(Object.keys(parseFoundryLockfile(lockfile(name)).dependencies), ['../../other/lib/solmate', 'lib/forge-std'])
  })
})

describe('what forge leaves', () => {
  it('every dependency removed: no dependencies, and an empty .gitmodules', () => {
    assert.deepEqual(plain(read('forge-1.8.3-removed')), { dependencies: {} })
    assert.deepEqual(plain(parseGitmodules(gitmodules('forge-1.8.3-removed'))), {})
  })

  it('a commit by a short hash, which forge build --locked refuses', () => {
    for (const options of [{}, { gitmodules: gitmodules('forge-1.8.3-short') }]) {
      assert.throws(() => parseFoundryLockfile(lockfile('forge-1.8.3-short'), options), (error) => error instanceof LockfileError
        && error.message === '["lib/short"].rev: "c93f771" is not a full commit hash, which forge build --locked compares the submodule\'s with')
    }
  })
})

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { checkPatchUse, checkPeerPatches } from '../src/pnpm/patches.js'

// The patch pnpm picks by selector, held against the hash a key names.
const lockfile = (packages) => ({ packages: Object.fromEntries(packages.map(([name, version, patchHash]) => [`${name}@${version}${patchHash ? `(patch_hash=${patchHash})` : ''}`, { name, version, patchHash }])) })
const hashes = (selectors) => Object.fromEntries(Object.entries(selectors).map(([selector, hash]) => [selector, { hash, path: `${hash}.patch` }]))

describe('checkPatchUse', () => {
  it('takes an exact version over a range, a range over a name, and a name alone', () => {
    const patches = hashes({ 'a@1.0.0': 'e', 'a@^1': 'r', a: 'n' })
    checkPatchUse(lockfile([['a', '1.0.0', 'e'], ['a', '1.5.0', 'r'], ['a', '2.0.0', 'n']]), patches)
    checkPatchUse(lockfile([['b', '1.0.0', 's'], ['b', '3.0.0', 's']]), hashes({ 'b@*': 's' }))
  })

  it('refuses a snapshot whose patch is not the one pnpm picks', () => {
    assert.throws(() => checkPatchUse(lockfile([['a', '1.0.0', 'n'], ['a', '2.0.0', 'n']]), hashes({ 'a@1.0.0': 'e', a: 'n' })), /^DeptreeError: "a@1\.0\.0\(patch_hash=n\)": pnpm applies the patch of "a@1\.0\.0" to it, and the lockfile names the patch n$/u)
    assert.throws(() => checkPatchUse(lockfile([['a', '1.0.0'], ['a', '2.0.0', 'n']]), hashes({ a: 'n' })), /pnpm applies the patch of "a" to it, and the lockfile names none/u)
    assert.throws(() => checkPatchUse(lockfile([['a', '1.0.0', 'n']]), {}), /pnpm applies no patch to it/u)
  })

  it('refuses two ranges that take one version, a selector that is not a range, and a patch nothing uses', () => {
    assert.throws(() => checkPatchUse(lockfile([['a', '1.5.0', 'x']]), hashes({ 'a@^1': 'x', 'a@>=1.2': 'y' })), /the patches "a@\^1" and "a@>=1\.2" both take it/u)
    assert.throws(() => checkPatchUse(lockfile([['a', '1.5.0']]), hashes({ 'a@latest': 'x' })), /"latest" is not a version range/u)
    assert.throws(() => checkPatchUse(lockfile([['a', '1.0.0', 'x']]), hashes({ 'a@1.0.0': 'x', 'b@1.0.0': 'y' })), /^DeptreeError: patchedDependencies\["b@1\.0\.0"\]: patches no package in the lockfile$/u)
  })
})

// pnpm 11 holds the peers in a key to their patches too.
describe('checkPeerPatches', () => {
  const keys = (list, dedupePeers) => ({ settings: { dedupePeers }, packages: Object.fromEntries(list.map((key) => [key, {}])) })
  const b = hashes({ 'b@2.0.0': 'h' })

  it('takes a patched peer that names the hash of its patch', () => {
    checkPeerPatches(keys(['a@1.0.0(b@2.0.0(patch_hash=h))', 'b@2.0.0(patch_hash=h)', 'c@1.0.0(d@1.0.0)']), b)
    checkPeerPatches(keys(['a@1.0.0(b@2.0.0)'], true), b)
  })

  const refused = [
    ['a patched peer that names no hash', ['a@1.0.0(b@2.0.0)'], /the patch hash "b@2\.0\.0" names is not the one of the patch pnpm picks/u],
    ['a patched peer that names another hash', ['a@1.0.0(b@2.0.0(patch_hash=x))'], /"b@2\.0\.0\(patch_hash=x\)" names is not the one/u],
    ['a peer that names a hash no patch picks', ['a@1.0.0(c@1.0.0(patch_hash=h))'], /"c@1\.0\.0\(patch_hash=h\)" names is not the one/u],
    ['a peer whose hash is not where pnpm reads it', ['a@1.0.0(b@2.0.0(d@1.0.0)(patch_hash=h))'], /is patched in a way pnpm 11 cannot check/u],
  ]
  for (const [what, list, pattern] of refused) {
    it(`refuses ${what}`, () => assert.throws(() => checkPeerPatches(keys(list), b), pattern))
  }
})

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { checkPatchUse } from '../src/pnpm/patches.js'

// Which patch pnpm applies to a package, by the settings' selectors, held
// against the patch hash its snapshot key names.
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

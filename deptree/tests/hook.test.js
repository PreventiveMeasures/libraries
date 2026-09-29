import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createHook } from '../src/pnpm/hook.js'
import { listOverrides } from '../src/pnpm/overrides.js'

// pnpm's read-package hook, as far as it is reproduced: checked here case
// by case, and against pnpm 10.33.4's own createVersionsOverrider on the
// cases in the commit that brought it, with no difference.
const hook = (overrides, ignored = []) => createHook({ overrides: listOverrides(overrides, {}), ignored })

describe('createHook', () => {
  it('replaces a dependency an override targets, and removes one overridden with -', () => {
    const read = hook({ chalk: '4.1.1', 'ms@^2.0.0': '2.1.2', debug: '-' })({ dependencies: { chalk: '4.1.2', ms: '^2.0.0', debug: '4.3.4' }, devDependencies: { ms: '1.0.0' } }, 'x')
    assert.deepEqual(read, { dependencies: { chalk: '4.1.1', ms: '2.1.2' }, devDependencies: { ms: '1.0.0' } })
  })

  // pnpm's "most specific" is its sort's: for `1.0.0` it takes `ms` alone
  // over `ms@<2`, which pnpm 10.33.4's own code does too.
  it('takes the override pnpm takes as most specific, and one scoped to the package over any', () => {
    const overrides = { 'ms@<2': '1.0.0', ms: '2.1.3', 'ms@^2.1.0': '2.1.2', 'root@^1>foo': '1.0.1', foo: '2.0.0' }
    assert.deepEqual(hook(overrides)({ name: 'root', version: '1.2.0', dependencies: { ms: '^2.1.0', foo: '^1.0.0' } }, 'x').dependencies, { ms: '2.1.2', foo: '1.0.1' })
    assert.deepEqual(hook(overrides)({ name: 'root', version: '2.0.0', dependencies: { ms: '1.0.0', foo: '^1.0.0' } }, 'x').dependencies, { ms: '2.1.3', foo: '2.0.0' })
  })

  it('overrides a peer in place where the override is a range, and as a dependency where it is not', () => {
    const read = hook({ react: '18.2.0', 'react-dom': 'npm:react-dom@18.2.0', gone: '-' })({ peerDependencies: { react: '^18.0.0', 'react-dom': '^18.0.0', gone: '*' } }, 'x')
    assert.deepEqual(read, { peerDependencies: { react: '18.2.0', 'react-dom': '^18.0.0' }, dependencies: { 'react-dom': 'npm:react-dom@18.2.0' } })
  })

  it('removes an ignored optional dependency, from dependencies too', () => {
    const read = hook({}, ['fsevents', '@esbuild/*'])({ dependencies: { fsevents: '2', a: '1' }, optionalDependencies: { fsevents: '2', '@esbuild/linux-x64': '1', b: '1' } }, 'x')
    assert.deepEqual(read, { dependencies: { a: '1' }, optionalDependencies: { b: '1' } })
  })

  it('refuses an override to a local path where asked to, and a malformed package.json', () => {
    assert.throws(() => hook({ a: 'link:../a' })({ dependencies: { a: '1' } }, 'x', { local: 'refuse' }), /^DeptreeError: x: the override "a" is to a local path/u)
    assert.deepEqual(hook({ a: 'link:../a' })({ dependencies: { a: '1' } }, 'x').dependencies, { a: 'link:../a' })
    assert.throws(() => hook({})({ dependencies: { a: 1 } }, 'x'), /^DeptreeError: x\.dependencies: expected a mapping of names to specifiers$/u)
  })

  it('leaves the package.json it is given as it was', () => {
    const manifest = { dependencies: { chalk: '4.1.2' } }
    hook({ chalk: '4.1.1' })(manifest, 'x')
    assert.deepEqual(manifest, { dependencies: { chalk: '4.1.2' } })
  })
})

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createHook } from '../src/pnpm/hook.js'
import { listOverrides } from '../src/pnpm/overrides.js'

// Checked against pnpm 10.33.4's own createVersionsOverrider on the cases
// in the commit that brought it, with no difference.
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

  // As a real install of pnpm 9.15.9 records use-sync-external-store's peer
  // on react overridden to 18.3.1.
  it('overrides a peer in place for pnpm 9, whatever the override is', () => {
    const hook9 = (overrides) => createHook({ overrides: listOverrides(overrides, {}, 9), ignored: [], major: 9 })
    const read = hook9({ react: '18.2.0', 'react-dom': 'npm:react-dom@18.2.0', gone: '-' })({ peerDependencies: { react: '^18.0.0', 'react-dom': '^18.0.0', gone: '*' } }, 'x')
    assert.deepEqual(read, { peerDependencies: { react: '18.2.0', 'react-dom': 'npm:react-dom@18.2.0' } })
  })

  it('removes an ignored optional dependency, from dependencies too', () => {
    const read = hook({}, ['fsevents', '@esbuild/*'])({ dependencies: { fsevents: '2', a: '1' }, optionalDependencies: { fsevents: '2', '@esbuild/linux-x64': '1', b: '1' } }, 'x')
    assert.deepEqual(read, { dependencies: { a: '1' }, optionalDependencies: { b: '1' } })
  })

  // pnpm 10 does not take a path alone for a directory, so leaves it.
  it('writes an override to a directory into a project relative to it, and refuses a malformed package.json', () => {
    const local = hook({ a: 'link:vendor/a', b: 'file:./b/', c: './c' })
    assert.deepEqual(local({ dependencies: { a: '1', b: '1', c: '1' } }, 'x', { dir: 'packages/x' }).dependencies, { a: 'link:../../vendor/a', b: 'file:../../b', c: './c' })
    assert.deepEqual(local({ dependencies: { a: '1' } }, 'x', { dir: '.' }).dependencies, { a: 'link:vendor/a' })
    assert.deepEqual(local({ dependencies: { a: '1' } }, 'x').dependencies, { a: 'link:vendor/a' }, 'a package\'s is read by its names alone')
    assert.throws(() => hook({})({ dependencies: { a: 1 } }, 'x'), /^DeptreeError: x\.dependencies: expected a mapping of names to specifiers$/u)
  })

  // pnpm 11 converges where no other override is chosen, drops a peer's
  // meta with the peer, and writes a path alone relative to a project too.
  it('reads overrides as pnpm 11 does', () => {
    const hook11 = (overrides) => createHook({ overrides: listOverrides(overrides, {}, 11), ignored: [], major: 11 })
    const converging = hook11({ 'foo@': '1.2.3', 'bar@': '2.0.0', bar: '3.0.0' })({ dependencies: { foo: '^1.0.0', bar: '^2.0.0' }, devDependencies: { foo: '^2.0.0' }, peerDependencies: { foo: '1.x' } }, 'x')
    assert.deepEqual(converging, { dependencies: { foo: '1.2.3', bar: '3.0.0' }, devDependencies: { foo: '^2.0.0' }, peerDependencies: { foo: '1.2.3' } })
    const gone = hook11({ p: '-' })({ peerDependencies: { p: '1', q: '1' }, peerDependenciesMeta: { p: { optional: true }, q: { optional: true } } }, 'x')
    assert.deepEqual(gone, { dependencies: {}, peerDependencies: { q: '1' }, peerDependenciesMeta: { q: { optional: true } } })
    const local = hook11({ a: 'link:packages/a', b: 'file:./b/', c: './c' })
    assert.deepEqual(local({ dependencies: { a: '1', b: '1', c: '1' } }, 'x', { dir: 'packages/x' }).dependencies, { a: 'link:../a', b: 'file:../../b', c: '../../c' })
    assert.deepEqual(local({ dependencies: { a: '1', c: '1' } }, 'x', { dir: '.' }).dependencies, { a: 'link:packages/a', c: './c' })
    for (const spec of ['link:/abs', 'file:~/x', '~/x', '../d', 'link:a/../../d', 'link:C:/x']) {
      assert.throws(() => listOverrides({ a: spec }, {}, 11), /^DeptreeError: overrides\["a"\]: ".*" is not a directory under the lockfile's, which is not supported$/u, spec)
    }
  })

  it('leaves the package.json it is given as it was', () => {
    const manifest = { dependencies: { chalk: '4.1.2' } }
    hook({ chalk: '4.1.1' })(manifest, 'x')
    assert.deepEqual(manifest, { dependencies: { chalk: '4.1.2' } })
  })
})

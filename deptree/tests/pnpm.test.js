import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { afterEach, describe, it } from 'node:test'
import { DeptreeError, LockfileError, buildPnpmTree } from '../pnpm.js'
import { HOST, stubRegistry, tarball } from './registry.js'

// One small lockfile with a package of every kind this builds — a peer, an
// alias, a capital in a name, a patch, a dev and an optional dependency,
// one with a bin, a link — against a registry stubbed with tarballs made
// here; then one change at a time, each refused with where and why.

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const hex = (text) => createHash('sha256').update(text).digest('hex')

const PATCH = `diff --git a/index.js b/index.js
index 0000000..1111111 100644
--- a/index.js
+++ b/index.js
@@ -1 +1 @@
-module.exports = 1
+module.exports = 2
`
const H = hex(PATCH)

const TARBALLS = await Promise.all([
  tarball('Up', '1.0.0'),
  tarball('a', '1.0.0', { 'index.js': 'a' }),
  tarball('b', '1.0.0'),
  tarball('c', '2.0.0'),
  tarball('d', '1.0.0', { 'bin/d.js': { data: '#!/usr/bin/env node\n', mode: 0o755 } }),
  tarball('e', '1.0.0'),
  tarball('lodash', '4.17.21', { 'lodash.js': 'lodash' }),
  tarball('mac', '1.0.0'),
  tarball('p', '1.0.0', { 'index.js': 'module.exports = 1\n' }),
])
const I = Object.fromEntries(TARBALLS.map((t) => [t.name, t.integrity]))

const lockfile = ({ patchHash = H, mac = '[darwin]', overrides = '' } = {}) => `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false
${overrides}
patchedDependencies:
  p@1.0.0:
    hash: ${patchHash}
    path: patches/p.patch

importers:

  .:
    dependencies:
      Up:
        specifier: 1.0.0
        version: 1.0.0
      a:
        specifier: 1.0.0
        version: 1.0.0(c@2.0.0)
      l:
        specifier: link:../l
        version: link:../l
      my-lodash:
        specifier: npm:lodash@4.17.21
        version: lodash@4.17.21
      p:
        specifier: 1.0.0
        version: 1.0.0(patch_hash=${patchHash})
    devDependencies:
      e:
        specifier: 1.0.0
        version: 1.0.0
    optionalDependencies:
      mac:
        specifier: 1.0.0
        version: 1.0.0

packages:

  Up@1.0.0:
    resolution: {integrity: ${I.Up}}

  a@1.0.0:
    resolution: {integrity: ${I.a}}
    peerDependencies:
      c: ^2.0.0

  b@1.0.0:
    resolution: {integrity: ${I.b}}

  c@2.0.0:
    resolution: {integrity: ${I.c}}

  d@1.0.0:
    resolution: {integrity: ${I.d}}
    hasBin: true

  e@1.0.0:
    resolution: {integrity: ${I.e}}

  lodash@4.17.21:
    resolution: {integrity: ${I.lodash}}

  mac@1.0.0:
    resolution: {integrity: ${I.mac}}
    os: ${mac}

  p@1.0.0:
    resolution: {integrity: ${I.p}}

snapshots:

  Up@1.0.0: {}

  a@1.0.0(c@2.0.0):
    dependencies:
      b: 1.0.0
      c: 2.0.0

  b@1.0.0:
    dependencies:
      d: 1.0.0

  c@2.0.0: {}

  d@1.0.0: {}

  e@1.0.0: {}

  lodash@4.17.21: {}

  mac@1.0.0:
    optional: true

  p@1.0.0(patch_hash=${patchHash}): {}
`

// The root package.json, which names the patch as pnpm-workspace.yaml
// may instead.
const root = ({ pnpm = {}, ...fields } = {}) => JSON.stringify({
  name: 'root',
  dependencies: { Up: '1.0.0', a: '1.0.0', l: 'link:../l', 'my-lodash': 'npm:lodash@4.17.21', p: '1.0.0' },
  devDependencies: { e: '1.0.0' },
  optionalDependencies: { mac: '1.0.0' },
  pnpm: { patchedDependencies: { 'p@1.0.0': 'patches/p.patch' }, ...pnpm },
  ...fields,
})

const build = (options = {}) => buildPnpmTree({ lockfile: lockfile(), manifest: root(), patches: { 'patches/p.patch': PATCH }, host: HOST, ...options })
const text = (vfs, path) => vfs.readText(path)
const UP = `Up@1.0.0_${hex('Up@1.0.0').slice(0, 32)}`
const P = `p@1.0.0_patch_hash=${H}`

describe('buildPnpmTree', () => {
  it('builds the tree pnpm 10 installs', async () => {
    const calls = stubRegistry(TARBALLS)
    const vfs = await build()
    assert.equal(calls.length, 8, 'every package but the optional one the host cannot run')
    assert.deepEqual(vfs.readdir('/node_modules'), ['.pnpm', 'Up', 'a', 'e', 'l', 'my-lodash', 'p'])
    assert.deepEqual(vfs.readdir('/node_modules/.pnpm'), [UP, 'a@1.0.0_c@2.0.0', 'b@1.0.0', 'c@2.0.0', 'd@1.0.0', 'e@1.0.0', 'lodash@4.17.21', 'node_modules', P])
    assert.equal(vfs.readlink('/node_modules/a'), '.pnpm/a@1.0.0_c@2.0.0/node_modules/a')
    assert.equal(vfs.readlink('/node_modules/my-lodash'), '.pnpm/lodash@4.17.21/node_modules/lodash')
    assert.equal(vfs.readlink('/node_modules/Up'), `.pnpm/${UP}/node_modules/Up`)
    assert.equal(vfs.readlink('/node_modules/l'), '../../l')
    assert.equal(vfs.readlink('/node_modules/.pnpm/a@1.0.0_c@2.0.0/node_modules/c'), '../../c@2.0.0/node_modules/c')
    assert.equal(vfs.readlink('/node_modules/.pnpm/b@1.0.0/node_modules/d'), '../../d@1.0.0/node_modules/d')
    assert.equal(text(vfs, '/node_modules/a/index.js'), 'a')
    assert.equal(text(vfs, '/node_modules/my-lodash/lodash.js'), 'lodash')
    assert.equal(vfs.realpath('/node_modules/a/../b/../d/bin/d.js'), '/node_modules/.pnpm/d@1.0.0/node_modules/d/bin/d.js')
    assert.equal(vfs.stat('/node_modules/.pnpm/d@1.0.0/node_modules/d/bin/d.js').mode, 0o755)
    assert.equal(vfs.stat('/node_modules/.pnpm/d@1.0.0/node_modules/d/package.json').mode, 0o644)
  })

  // pnpm folds an alias's case before it looks for it among the root
  // project's, which it does not fold: `Up` is hoisted although the root
  // project has it, as pnpm hoists JSONStream.
  it('hoists what the root project does not depend on into .pnpm/node_modules', async () => {
    stubRegistry(TARBALLS)
    const vfs = await build()
    assert.deepEqual(vfs.readdir('/node_modules/.pnpm/node_modules'), ['Up', 'b', 'c', 'd'])
    assert.equal(vfs.readlink('/node_modules/.pnpm/node_modules/d'), '../d@1.0.0/node_modules/d')
  })

  it('hoists publicly what the public pattern matches, and nothing with hoist off', async () => {
    stubRegistry(TARBALLS)
    const vfs = await build({ npmrc: 'public-hoist-pattern[]=d\nhoist=false\n' })
    assert.equal(vfs.readlink('/node_modules/d'), '.pnpm/d@1.0.0/node_modules/d')
    assert.equal(vfs.isDirectory('/node_modules/.pnpm/node_modules'), false)
    const flat = await build({ workspace: 'shamefullyHoist: true\n' })
    assert.deepEqual(flat.readdir('/node_modules').filter((name) => ['b', 'c', 'd'].includes(name)), ['b', 'c', 'd'])
  })

  it('applies the patch', async () => {
    stubRegistry(TARBALLS)
    const vfs = await build()
    assert.equal(text(vfs, '/node_modules/p/index.js'), 'module.exports = 2\n')
  })

  it('installs an optional package where supportedArchitectures takes it', async () => {
    stubRegistry(TARBALLS)
    const vfs = await build({ workspace: 'supportedArchitectures:\n  os: [current, darwin]\n' })
    assert.equal(vfs.readlink('/node_modules/mac'), '.pnpm/mac@1.0.0/node_modules/mac')
  })

  it('names long directories as pnpm 10 does', async () => {
    stubRegistry(TARBALLS)
    const vfs = await build({ workspace: 'virtualStoreDirMaxLength: 40\n' })
    assert.ok(vfs.isDirectory(`/node_modules/.pnpm/a@1.0.0_c@2.0.0/node_modules/a`))
    assert.ok(vfs.isDirectory(`/node_modules/.pnpm/p@1.0.0_${hex(`p@1.0.0_patch_hash=${H}`).slice(0, 32)}/node_modules/p`))
  })
})

describe('buildPnpmTree refuses', () => {
  const refuses = async (options, pattern, ErrorType = DeptreeError) => {
    await assert.rejects(build(options), (error) => error instanceof ErrorType && pattern.test(error.message))
  }

  it('a tarball that is not the one the lockfile pins', async () => {
    stubRegistry(TARBALLS.map((t) => (t.name === 'b' ? { ...t, served: new Uint8Array([...t.bytes, 0]) } : t)))
    await refuses({}, /^"b@1\.0\.0": getTarball: integrity mismatch/u)
  })

  it('a tarball whose package.json is for another package', async () => {
    const other = await tarball('b', '1.0.0', { 'package.json': JSON.stringify({ name: 'bb', version: '1.0.0' }) })
    stubRegistry([...TARBALLS.filter((t) => t.name !== 'b'), other])
    await refuses({ lockfile: lockfile().replace(I.b, other.integrity) }, /^"b@1\.0\.0": package.json is for "bb@1\.0\.0"/u)
  })

  it('a hard link in a tarball, and passes over a symlink', async () => {
    const { pack } = await import('@preventive/archive/tar.js')
    const { compress } = await import('@preventive/archive/compression.js')
    const entries = (extra) => [{ name: 'package/package.json', data: new TextEncoder().encode('{"name":"c","version":"2.0.0"}') }, extra]
    const linked = await compress(pack(entries({ name: 'package/x', type: 'symlink', linkname: 'package.json' })), 'gzip')
    const hard = await compress(pack(entries({ name: 'package/x', type: 'hardlink', linkname: 'package/package.json' })), 'gzip')
    const withLink = { name: 'c', version: '2.0.0', bytes: linked }
    stubRegistry([...TARBALLS.filter((t) => t.name !== 'c'), withLink])
    const { sri } = await import('./registry.js')
    const vfs = await build({ lockfile: lockfile().replace(I.c, sri(linked)) })
    assert.deepEqual(vfs.readdir('/node_modules/.pnpm/c@2.0.0/node_modules/c'), ['package.json'])
    stubRegistry([...TARBALLS.filter((t) => t.name !== 'c'), { ...withLink, bytes: hard }])
    await refuses({ lockfile: lockfile().replace(I.c, sri(hard)) }, /^"c@2\.0\.0": "package\/x" is a hardlink/u)
  })

  it('a package from anywhere but the registry, before fetching anything', async () => {
    const calls = stubRegistry(TARBALLS)
    const git = lockfile()
      .replace('      c: ^2.0.0\n', '      c: ^2.0.0\n\n  g@git+https://example.com/g.git#0123456789abcdef0123456789abcdef01234567:\n    resolution: {commit: 0123456789abcdef0123456789abcdef01234567, repo: https://example.com/g.git, type: git}\n    version: 1.0.0\n')
      .replace('  b@1.0.0:\n    dependencies:\n', '  b@1.0.0:\n    dependencies:\n      g: git+https://example.com/g.git#0123456789abcdef0123456789abcdef01234567\n')
      .replace('  c@2.0.0: {}\n', '  c@2.0.0: {}\n\n  g@git+https://example.com/g.git#0123456789abcdef0123456789abcdef01234567: {}\n')
    await refuses({ lockfile: git }, /^"g@git\+https:.*only packages from https:\/\/registry\.npmjs\.org\/ are supported/u)
    assert.deepEqual(calls, [])
  })

  // pnpm hashes every patch it is configured with, and holds the lockfile
  // to the hashes and the paths: each has to be given, and hash as the
  // lockfile says, under the path it says.
  it('a patch that is not given, does not hash as the lockfile says, or is named elsewhere', async () => {
    stubRegistry(TARBALLS)
    await refuses({ patches: {} }, /^patchedDependencies\["p@1\.0\.0"\]: the patch "patches\/p\.patch" is not given, and pnpm reads every patch/u)
    await refuses({ patches: { 'patches/p.patch': PATCH.replace('= 2', '= 3') } }, /^patchedDependencies: the patches differ: "p@1\.0\.0" is "[\da-f]{64} patches\/p\.patch" in the lockfile and "[\da-f]{64} patches\/p\.patch" in the settings; pnpm would refuse a frozen install/u)
    await refuses({ patches: { 'patches/p.patch': PATCH, 'patches/q.patch': PATCH } }, /^patches\["patches\/q\.patch"\]: no patchedDependencies setting names this patch/u)
    await refuses({ patches: { 'patches/p.patch': `${PATCH}\uDC00` } }, /^patches\["patches\/p\.patch"\]: expected well-formed text to hash$/u)
    await refuses({ manifest: root({ pnpm: { patchedDependencies: undefined } }), workspace: 'patchedDependencies:\n  p@1.0.0: other.patch\n', patches: { 'other.patch': PATCH } }, /^patchedDependencies: the patches differ: .* in the lockfile and "[\da-f]{64} other\.patch" in the settings/u)
    // The package.json's patches win over pnpm-workspace.yaml's.
    await refuses({ workspace: 'patchedDependencies:\n  p@1.0.0: other.patch\n', patches: { 'patches/p.patch': PATCH, 'other.patch': PATCH } }, /^patches\["other\.patch"\]: no patchedDependencies setting names this patch/u)
    await refuses({ manifest: root({ pnpm: { patchedDependencies: undefined } }) }, /^patches\["patches\/p\.patch"\]: no patchedDependencies setting names this patch/u)
    await refuses({ manifest: root({ pnpm: { patchedDependencies: undefined } }), patches: {} }, /^patchedDependencies: the patches differ: "p@1\.0\.0" is .* in the lockfile and nothing in the settings/u)
  })

  it('reads the patch where pnpm-workspace.yaml names it instead', async () => {
    stubRegistry(TARBALLS)
    const vfs = await build({ manifest: root({ pnpm: { patchedDependencies: undefined } }), workspace: 'patchedDependencies:\n  p@1.0.0: ./patches/p.patch\n' })
    assert.equal(vfs.readText('/node_modules/p/index.js'), 'module.exports = 2\n')
  })

  it('a patch that does not apply exactly', async () => {
    stubRegistry(TARBALLS)
    const off = PATCH.replace('-module.exports = 1', '-module.exports = 1 ')
    await refuses({ lockfile: lockfile({ patchHash: hex(off) }), patches: { 'patches/p.patch': off } }, /"index\.js": the hunk at line 1 does not apply/u)
  })

  it('a host this does not build for', async () => {
    await refuses({ host: { ...HOST, pnpm: '9.15.9' } }, /^host\.pnpm: pnpm "9\.15\.9" is not supported/u)
    await refuses({ host: { ...HOST, os: 'win32' } }, /^host\.os: Windows is not supported/u)
    await assert.rejects(build({ host: { ...HOST, libc: undefined } }), TypeError)
  })

  it('an incompatible package where engineStrict has pnpm refuse one', async () => {
    stubRegistry(TARBALLS)
    const strict = lockfile().replace('    os: [darwin]\n', '    os: [darwin]\n\n  e@1.0.0:\n    resolution: {integrity: X}\n    os: [darwin]\n'.replace('X', I.e)).replace(`  e@1.0.0:\n    resolution: {integrity: ${I.e}}\n\n  lodash`, '  lodash')
    await refuses({ lockfile: strict, workspace: 'engineStrict: true\n' }, /^"e@1\.0\.0": the host does not take its os, cpu or libc/u)
    const vfs = await build({ lockfile: strict })
    assert.ok(vfs.isSymlink('/node_modules/e'), 'installed with a warning, as pnpm does')
  })

  it('nothing for a pnpm-workspace.yaml of comments alone', async () => {
    stubRegistry(TARBALLS)
    const vfs = await build({ workspace: '# nothing here\n\n' })
    assert.ok(vfs.isSymlink('/node_modules/a'))
  })

  it('a root package.json that is not a JSON object', async () => {
    await refuses({ manifest: '{' }, /^package\.json: not JSON/u)
    await refuses({ manifest: '[]' }, /^package\.json: expected an object$/u)
    await assert.rejects(build({ manifest: undefined }), TypeError)
  })

  it('a lockfile resolved with other settings', async () => {
    stubRegistry(TARBALLS)
    await refuses({ workspace: 'autoInstallPeers: false\n' }, /^settings\.autoInstallPeers: autoInstallPeers is true in the lockfile; pnpm would refuse a frozen install/u)
    await refuses({ workspace: 'dedupePeers: true\n' }, /^settings\.dedupePeers:/u)
    await refuses({ npmrc: 'peers-suffix-max-length=100\n' }, /^settings\.peersSuffixMaxLength:/u)
    await refuses({ workspace: 'ignoredOptionalDependencies: [mac]\n' }, /^ignoredOptionalDependencies: the optional dependencies left out differ/u)
    await refuses({ workspace: 'packageExtensions:\n  a:\n    dependencies:\n      b: 1.0.0\n' }, /^packageExtensions: package extensions are not supported/u)
  })

  it('a lockfile the lockfile reader refuses', async () => {
    await refuses({ lockfile: "lockfileVersion: '6.0'\n" }, /unsupported version/u, LockfileError)
  })

  it('workspace packages to hoist, whose names the lockfile does not hold', async () => {
    const two = lockfile().replace('importers:\n', 'importers:\n\n  packages/x: {}\n')
    await refuses({ lockfile: two }, /^hoistWorkspacePackages: hoisting workspace packages needs each project's name/u)
  })
})

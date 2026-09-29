import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { afterEach, describe, it } from 'node:test'
import { createVfs } from '@preventive/vfs'
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
  tarball('d', '1.0.0', { 'bin/d.js': { data: '#!/usr/bin/env node\n', mode: 0o755 } }, { manifest: { bin: { d: 'bin/d.js' } } }),
  tarball('e', '1.0.0'),
  tarball('lodash', '4.17.21', { 'lodash.js': 'lodash' }),
  tarball('mac', '1.0.0', {}, { manifest: { os: ['darwin'] } }),
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

const buildResult = ({ manifest = root(), ...options } = {}) => buildPnpmTree({ lockfile: lockfile(), manifests: { '.': manifest }, patches: { 'patches/p.patch': PATCH }, host: HOST, ...options })
const build = async (options) => (await buildResult(options)).vfs
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

  it('counts what it installs', async () => {
    stubRegistry(TARBALLS)
    const { stats } = await buildResult()
    assert.ok(stats.bytes > 0)
    assert.deepEqual({ ...stats, bytes: 0 }, { projects: 1, snapshots: 9, installed: 8, skipped: 1, incompatible: 0, tarballs: 8, patched: 1, files: 12, bytes: 0, links: 13 })
  })

  it('names long directories as pnpm 10 does', async () => {
    stubRegistry(TARBALLS)
    const vfs = await build({ workspace: 'virtualStoreDirMaxLength: 40\n' })
    assert.ok(vfs.isDirectory(`/node_modules/.pnpm/a@1.0.0_c@2.0.0/node_modules/a`))
    assert.ok(vfs.isDirectory(`/node_modules/.pnpm/p@1.0.0_${hex(`p@1.0.0_patch_hash=${H}`).slice(0, 32)}/node_modules/p`))
  })
})

// Tarballs are fetched once for each package, however many snapshots it
// has; bins' files are left as linking them leaves them.
describe('buildPnpmTree packages', () => {
  const small = (importer, packages, snapshots) => `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
${importer}
packages:
${packages}
snapshots:
${snapshots}`
  const dep = (name, version = '1.0.0') => `      ${name}:\n        specifier: ${version}\n        version: ${version}\n`
  const manifest = (dependencies) => JSON.stringify({ name: 'root', dependencies })

  it('fetches a package resolved under two sets of peers once', async () => {
    const more = await Promise.all([tarball('c', '2.1.0'), tarball('x', '1.0.0'), tarball('y', '1.0.0')])
    const calls = stubRegistry([...TARBALLS, ...more])
    const integrity = Object.fromEntries([...TARBALLS, ...more].map((t) => [`${t.name}@${t.version}`, t.integrity]))
    const peers = small(dep('x') + dep('y'), `  a@1.0.0:
    resolution: {integrity: ${integrity['a@1.0.0']}}
    peerDependencies:
      c: ^2.0.0

${['c@2.0.0', 'c@2.1.0', 'x@1.0.0', 'y@1.0.0'].map((id) => `  ${id}:\n    resolution: {integrity: ${integrity[id]}}\n`).join('\n')}
`, `  a@1.0.0(c@2.0.0):
    dependencies:
      c: 2.0.0

  a@1.0.0(c@2.1.0):
    dependencies:
      c: 2.1.0

  c@2.0.0: {}

  c@2.1.0: {}

  x@1.0.0:
    dependencies:
      a: 1.0.0(c@2.0.0)
      c: 2.0.0

  y@1.0.0:
    dependencies:
      a: 1.0.0(c@2.1.0)
      c: 2.1.0
`)
    const { vfs, stats } = await buildPnpmTree({ lockfile: peers, manifests: { '.': manifest({ x: '1.0.0', y: '1.0.0' }) }, host: HOST })
    assert.equal(calls.filter((url) => url.endsWith('/a-1.0.0.tgz')).length, 1)
    assert.equal(calls.length, 5)
    assert.equal(stats.tarballs, 5)
    assert.equal(stats.installed, 6)
    assert.equal(vfs.readText('/node_modules/.pnpm/a@1.0.0_c@2.0.0/node_modules/a/index.js'), 'a')
    assert.equal(vfs.readText('/node_modules/.pnpm/a@1.0.0_c@2.1.0/node_modules/a/index.js'), 'a')
  })

  // pnpm links `t` of t, whose name it is, over u's, and fixes only the
  // file it links: made executable, and its `#!` line ending in LF.
  it('leaves the files bins run as linking them leaves them', async () => {
    const bins = await Promise.all([
      tarball('t', '1.0.0', { 'cli.js': '#!/usr/bin/env node\r\nrun()\r\n', 'other.js': '#!/x\r\n' }, { manifest: { bin: { t: 'cli.js' } } }),
      tarball('u', '1.0.0', { 'u.js': '#!/usr/bin/env node\r\n' }, { manifest: { bin: { t: 'u.js' } } }),
    ])
    stubRegistry(bins)
    const packages = bins.map((t) => `  ${t.name}@1.0.0:\n    resolution: {integrity: ${t.integrity}}\n    hasBin: true\n`).join('\n')
    const { vfs } = await buildPnpmTree({ lockfile: small(dep('t') + dep('u'), `${packages}\n`, '  t@1.0.0: {}\n\n  u@1.0.0: {}\n'), manifests: { '.': manifest({ t: '1.0.0', u: '1.0.0' }) }, host: HOST })
    const t = '/node_modules/.pnpm/t@1.0.0/node_modules/t'
    assert.equal(vfs.stat(`${t}/cli.js`).mode, 0o755)
    assert.equal(vfs.readText(`${t}/cli.js`), '#!/usr/bin/env node\nrun()\r\n')
    assert.equal(vfs.stat(`${t}/other.js`).mode, 0o644)
    assert.equal(vfs.readText(`${t}/other.js`), '#!/x\r\n')
    assert.equal(vfs.stat('/node_modules/.pnpm/u@1.0.0/node_modules/u/u.js').mode, 0o644)
    assert.equal(vfs.readText('/node_modules/.pnpm/u@1.0.0/node_modules/u/u.js'), '#!/usr/bin/env node\r\n')
  })

  // pnpm 11 has npm own npx, and links into a project's .bin the bins of
  // the peers its dependencies require: h's peer p loses `cmd` to z beside
  // h, and wins it in the project's .bin.
  it('links bins as pnpm 11 does', async () => {
    const bins = await Promise.all([
      tarball('npm', '1.0.0', { 'n.js': '#!n\n' }, { manifest: { bin: { npx: 'n.js' } } }),
      tarball('zz', '1.0.0', { 'z.js': '#!zz\n' }, { manifest: { bin: { npx: 'z.js' } } }),
      tarball('h', '1.0.0', {}, { manifest: { peerDependencies: { p: '1.0.0' }, dependencies: { z: '1.0.0' } } }),
      tarball('p', '1.0.0', { 'p.js': '#!p\n' }, { manifest: { bin: { cmd: 'p.js' } } }),
      tarball('z', '1.0.0', { 'z.js': '#!z\n' }, { manifest: { bin: { cmd: 'z.js' } } }),
    ])
    stubRegistry(bins)
    const entry = (t) => `  ${t.name}@1.0.0:\n    resolution: {integrity: ${t.integrity}}\n${t.name === 'h' ? '    peerDependencies:\n      p: 1.0.0\n' : '    hasBin: true\n'}`
    const lock = small(dep('npm') + dep('zz') + dep('h', '1.0.0(p@1.0.0)'), `${bins.map(entry).join('\n')}\n`, '  h@1.0.0(p@1.0.0):\n    dependencies:\n      p: 1.0.0\n      z: 1.0.0\n\n  npm@1.0.0: {}\n\n  p@1.0.0: {}\n\n  z@1.0.0: {}\n\n  zz@1.0.0: {}\n').replace('specifier: 1.0.0(p@1.0.0)', 'specifier: 1.0.0')
    const mode = (vfs, key, file) => vfs.stat(`/node_modules/.pnpm/${key}/node_modules/${key.split('@')[0]}/${file}`).mode
    const options = { lockfile: lock, manifests: { '.': manifest({ npm: '1.0.0', zz: '1.0.0', h: '1.0.0' }) }, workspace: 'hoist: false\n' }
    const v11 = (await buildPnpmTree({ ...options, host: { ...HOST, pnpm: '11.28.2' } })).vfs
    assert.deepEqual([mode(v11, 'npm@1.0.0', 'n.js'), mode(v11, 'zz@1.0.0', 'z.js'), mode(v11, 'p@1.0.0', 'p.js')], [0o755, 0o644, 0o755])
    const v10 = (await buildPnpmTree({ ...options, host: HOST })).vfs
    assert.deepEqual([mode(v10, 'npm@1.0.0', 'n.js'), mode(v10, 'zz@1.0.0', 'z.js'), mode(v10, 'p@1.0.0', 'p.js')], [0o644, 0o755, 0o644])
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

  // pnpm passes over a symlink, and npm packs none: a tarball with one was
  // not packed by npm, and is refused as a hard link or a device is.
  it('a link of either kind in a tarball', async () => {
    const { pack } = await import('@preventive/archive/tar.js')
    const { compress } = await import('@preventive/archive/compression.js')
    const entries = (extra) => [{ name: 'package/package.json', data: new TextEncoder().encode('{"name":"c","version":"2.0.0"}') }, extra]
    const linked = await compress(pack(entries({ name: 'package/x', type: 'symlink', linkname: 'package.json' })), 'gzip')
    const hard = await compress(pack(entries({ name: 'package/x', type: 'hardlink', linkname: 'package/package.json' })), 'gzip')
    const withLink = { name: 'c', version: '2.0.0', bytes: linked }
    stubRegistry([...TARBALLS.filter((t) => t.name !== 'c'), withLink])
    const { sri } = await import('./registry.js')
    await refuses({ lockfile: lockfile().replace(I.c, sri(linked)) }, /^"c@2\.0\.0": "package\/x" is a symlink, which is not supported$/u)
    stubRegistry([...TARBALLS.filter((t) => t.name !== 'c'), { ...withLink, bytes: hard }])
    await refuses({ lockfile: lockfile().replace(I.c, sri(hard)) }, /^"c@2\.0\.0": "package\/x" is a hardlink/u)
  })

  // Stricter than pnpm, which passes over most of these: what npm packs,
  // and a package.json that says what the lockfile recorded of it.
  it('a tarball that is not one npm packs, or whose package.json the lockfile does not agree with', async () => {
    const { sri } = await import('./registry.js')
    const cases = [
      [await tarball('b', '1.0.0', {}, { manifest: { os: ['darwin'] } }), /package\.json's os is not the lockfile's$/u],
      [await tarball('b', '1.0.0', {}, { manifest: { bin: 'x.js' } }), /package\.json has bins, and the lockfile says it has none$/u],
      [await tarball('b', '1.0.0', {}, { manifest: { bundleDependencies: ['z'] } }), /package\.json bundles other than the lockfile says$/u],
      [await tarball('b', '1.0.0', {}, { manifest: { dependencies: { z: '1.0.0' } } }), /package\.json asks for "z", which the lockfile does not give it$/u],
      [await tarball('B', '1.0.0', {}), /package\.json is for "B@1\.0\.0"/u],
      [await tarball('b', '1.0.0', { 'package.json': '[]' }), /package\.json is not an object$/u],
    ]
    for (const [served, pattern] of cases) {
      const b = { ...served, name: 'b' }
      stubRegistry([...TARBALLS.filter((t) => t.name !== 'b'), b])
      await refuses({ lockfile: lockfile().replace(I.b, b.integrity) }, pattern)
    }
    const { pack } = await import('@preventive/archive/tar.js')
    const { compress } = await import('@preventive/archive/compression.js')
    const json = new TextEncoder().encode('{"name":"b","version":"1.0.0"}')
    const two = await compress(pack([{ name: 'package/package.json', data: json }, { name: 'other/x.js', data: json }]), 'gzip')
    stubRegistry([...TARBALLS.filter((t) => t.name !== 'b'), { name: 'b', version: '1.0.0', bytes: two }])
    await refuses({ lockfile: lockfile().replace(I.b, sri(two)) }, /^"b@1\.0\.0": the tarball has files under more than one directory, or at its top$/u)
    const flat = await compress(pack([{ name: 'package.json', data: json }, { name: 'x.js', data: json }]), 'gzip')
    stubRegistry([...TARBALLS.filter((t) => t.name !== 'b'), { name: 'b', version: '1.0.0', bytes: flat }])
    await refuses({ lockfile: lockfile().replace(I.b, sri(flat)) }, /^"b@1\.0\.0": the tarball has files under more than one directory, or at its top$/u)
    const plain = pack([{ name: 'package/package.json', data: json }])
    stubRegistry([...TARBALLS.filter((t) => t.name !== 'b'), { name: 'b', version: '1.0.0', bytes: plain }])
    await refuses({ lockfile: lockfile().replace(I.b, sri(plain)) }, /^"b@1\.0\.0": the tarball is not gzipped$/u)
    const bare = await tarball('b', '1.0.0', { 'x.js': 'x', 'package.json': undefined })
    stubRegistry([...TARBALLS.filter((t) => t.name !== 'b'), bare])
    await refuses({ lockfile: lockfile().replace(I.b, bare.integrity) }, /^"b@1\.0\.0": the tarball has no package\.json$/u)
  })

  it('a lockfile whose optional marks pnpm would not have written', async () => {
    await refuses({ lockfile: lockfile().replace('  mac@1.0.0:\n    optional: true\n', '  mac@1.0.0: {}\n') }, /^snapshots\["mac@1\.0\.0"\]: marked required where only optional dependencies reach it/u)
    await refuses({ lockfile: lockfile().replace('  c@2.0.0: {}\n', '  c@2.0.0:\n    optional: true\n') }, /^snapshots\["c@2\.0\.0"\]: marked optional where an importer requires it/u)
  })

  it('a project inside node_modules', async () => {
    const inside = lockfile().replace('importers:\n', 'importers:\n\n  node_modules/x: {}\n')
    await refuses({ lockfile: inside, manifests: { '.': root(), 'node_modules/x': '{}' } }, /^importers\["node_modules\/x"\]: a project inside node_modules/u)
  })

  it('names that are one name on macOS, where the host is macOS', async () => {
    const both = await tarball('b', '1.0.0', { 'Index.js': 'a', 'index.js': 'b' })
    stubRegistry([...TARBALLS.filter((t) => t.name !== 'b'), both])
    const vfs = await build({ lockfile: lockfile().replace(I.b, both.integrity) })
    assert.deepEqual(vfs.readdir('/node_modules/.pnpm/b@1.0.0/node_modules/b'), ['Index.js', 'index.js', 'package.json'])
    await refuses({ lockfile: lockfile().replace(I.b, both.integrity), host: { ...HOST, os: 'darwin', libc: 'unknown' } }, /"Index\.js" and "index\.js" are one name on macOS$/u)
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
    await refuses({ patches: { 'patches/p.patch': PATCH.replace('= 2', '= 3') } }, /^patchedDependencies: the patches differ: "p@1\.0\.0" is "[\da-f]{64} patches\/p\.patch" in the lockfile and "[\da-f]{64} patches\/p\.patch" in the settings, which a frozen install refuses$/u)
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
    const e = await tarball('e', '1.0.0', {}, { manifest: { os: ['darwin'] } })
    stubRegistry([...TARBALLS.filter((t) => t.name !== 'e'), e])
    const strict = lockfile().replace('    os: [darwin]\n', '    os: [darwin]\n\n  e@1.0.0:\n    resolution: {integrity: X}\n    os: [darwin]\n'.replace('X', e.integrity)).replace(`  e@1.0.0:\n    resolution: {integrity: ${I.e}}\n\n  lodash`, '  lodash')
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
    await refuses({ manifest: '{' }, /^manifests\["\."\]: not JSON/u)
    await refuses({ manifest: '[]' }, /^manifests\["\."\]: expected an object$/u)
    await assert.rejects(build({ manifests: undefined }), TypeError)
    await assert.rejects(build({ manifest: 7 }), TypeError)
  })

  it('a lockfile resolved with other settings', async () => {
    stubRegistry(TARBALLS)
    await refuses({ workspace: 'autoInstallPeers: false\n' }, /^settings\.autoInstallPeers: autoInstallPeers is true in the lockfile, which a frozen install refuses$/u)
    await refuses({ workspace: 'dedupePeers: true\n' }, /^settings\.dedupePeers:/u)
    await refuses({ npmrc: 'peers-suffix-max-length=100\n' }, /^settings\.peersSuffixMaxLength:/u)
    await refuses({ workspace: 'ignoredOptionalDependencies: [mac]\n' }, /^ignoredOptionalDependencies: the optional dependencies left out differ/u)
    await refuses({ workspace: 'packageExtensions:\n  a:\n    dependencies:\n      b: 1.0.0\n' }, /^packageExtensions: package extensions are not supported/u)
  })

  it('a lockfile the lockfile reader refuses', async () => {
    await refuses({ lockfile: "lockfileVersion: '6.0'\n" }, /unsupported version/u, LockfileError)
  })

  // pnpm installs the projects it finds, and holds each to its importer:
  // one without the other is not the lockfile's tree.
  it('a project without its package.json, or a package.json without its importer', async () => {
    const two = lockfile().replace('importers:\n', 'importers:\n\n  packages/x: {}\n')
    await refuses({ lockfile: two }, /^importers\["packages\/x"\]: the package\.json of this project is not given$/u)
    await refuses({ manifests: { '.': root(), 'packages/y': '{}' } }, /^manifests\["packages\/y"\]: the lockfile has no importer for this project/u)
  })

  it('a lockfile not up to date with a package.json', async () => {
    stubRegistry(TARBALLS)
    await refuses({ manifest: root({ dependencies: { a: '^1.0.0' } }) }, /^manifests\["\."\]: the lockfile is not up to date with this package\.json, which a frozen install refuses: the specifiers differ/u)
    await refuses({ manifest: root({ peerDependencies: { b: '1.0.0' } }) }, /the specifiers differ: "b" is nothing in the lockfile and "1\.0\.0" in package\.json$/u)
    const vfs = await build({ manifest: root({ peerDependencies: { a: '1.0.0' } }), workspace: 'hoist: true\n' })
    assert.ok(vfs.isSymlink('/node_modules/a'), 'a peer the project lists as a dependency too asks for nothing more')
  })
})

// pnpm 11 reads its settings from pnpm-workspace.yaml alone, and writes
// each patch's hash alone in the lockfile.
describe('buildPnpmTree for pnpm 11', () => {
  const HOST_11 = { ...HOST, pnpm: '11.28.2' }
  const lockfile11 = () => lockfile().replace(`  p@1.0.0:\n    hash: ${H}\n    path: patches/p.patch\n`, `  p@1.0.0: ${H}\n`)
  const patchedInYaml = 'patchedDependencies:\n  p@1.0.0: patches/p.patch\n'

  it('builds from settings in pnpm-workspace.yaml and pnpm 11\'s lockfile', async () => {
    stubRegistry(TARBALLS)
    const { vfs } = await buildPnpmTree({ lockfile: lockfile11(), manifests: { '.': root({ pnpm: { patchedDependencies: undefined } }) }, workspace: patchedInYaml, patches: { 'patches/p.patch': PATCH }, host: HOST_11 })
    assert.equal(text(vfs, '/node_modules/p/index.js'), 'module.exports = 2\n')
  })

  // pnpm 11 checks a lockfile against the registry before it installs,
  // unless trustLockfile: the tree here follows the lockfile, whatever
  // minimumReleaseAge says, and asks the registry for nothing but tarballs.
  it('follows the lockfile, whatever minimumReleaseAge says', async () => {
    const calls = stubRegistry(TARBALLS)
    const elsewhere = lockfile11().replace(`  mac@1.0.0:\n    resolution: {integrity: ${I.mac}}`, `  mac@1.0.0:\n    resolution: {integrity: ${I.mac}, tarball: https://example.com/mac.tgz}`)
    const workspace = `${patchedInYaml}minimumReleaseAge: 100000\nminimumReleaseAgeStrict: true\ntrustLockfile: false\n`
    const { vfs } = await buildPnpmTree({ lockfile: elsewhere, manifests: { '.': root({ pnpm: { patchedDependencies: undefined } }) }, workspace, patches: { 'patches/p.patch': PATCH }, host: HOST_11 })
    assert.equal(text(vfs, '/node_modules/p/index.js'), 'module.exports = 2\n')
    assert.ok(calls.every((url) => url.endsWith('.tgz')), calls.join(', '))
  })

  it('reads no setting of the package.json', async () => {
    await assert.rejects(buildPnpmTree({ lockfile: lockfile11(), manifests: { '.': root() }, patches: { 'patches/p.patch': PATCH }, host: HOST_11 }), /^DeptreeError: patches\["patches\/p\.patch"\]: no patchedDependencies setting names this patch$/u)
  })

  it('refuses a pnpm it is not built for', async () => {
    await assert.rejects(buildPnpmTree({ lockfile: lockfile11(), manifests: { '.': root() }, host: { ...HOST, pnpm: '12.0.0' } }), /^DeptreeError: host\.pnpm: pnpm "12\.0\.0" is not supported: only pnpm 10 and 11 are$/u)
  })
})

describe('buildPnpmTree with a workspace', () => {
  const two = lockfile().replace('importers:\n', 'importers:\n\n  packages/x:\n    dependencies:\n      b:\n        specifier: 1.0.0\n        version: 1.0.0\n')
  const manifests = (x) => ({ '.': root(), 'packages/x': JSON.stringify(x) })
  const WORKSPACE = 'packages:\n  - packages/*\n'
  const buildTwo = async (x, options) => (await buildPnpmTree({ lockfile: two, manifests: manifests(x), workspace: WORKSPACE, patches: { 'patches/p.patch': PATCH }, host: HOST, ...options })).vfs

  it('links each project\'s dependencies, and hoists each named project by its name', async () => {
    stubRegistry(TARBALLS)
    const vfs = await buildTwo({ name: '@w/x', dependencies: { b: '1.0.0' } })
    assert.equal(vfs.readlink('/packages/x/node_modules/b'), '../../../node_modules/.pnpm/b@1.0.0/node_modules/b')
    assert.equal(vfs.readlink('/node_modules/.pnpm/node_modules/@w/x'), '../../../../packages/x')
    const unnamed = await buildTwo({ dependencies: { b: '1.0.0' } })
    assert.deepEqual(unnamed.readdir('/node_modules/.pnpm/node_modules'), ['Up', 'b', 'c', 'd'])
    const off = await buildTwo({ name: '@w/x', dependencies: { b: '1.0.0' } }, { workspace: `${WORKSPACE}hoistWorkspacePackages: false\n` })
    assert.equal(off.isSymlink('/node_modules/.pnpm/node_modules/@w/x'), false)
  })

  // A project hoisted by its name does not take it: a package of that name
  // is hoisted there too, and the project wins, as pnpm has it.
  it('hoists a project over a package of its name', async () => {
    stubRegistry(TARBALLS)
    const vfs = await buildTwo({ name: 'd', dependencies: { b: '1.0.0' } })
    assert.equal(vfs.readlink('/node_modules/.pnpm/node_modules/d'), '../../../packages/x')
  })

  it('refuses a project not up to date with its package.json, or two projects of one name', async () => {
    await assert.rejects(buildTwo({ name: 'x', dependencies: { b: '^1.0.0' } }), /^DeptreeError: manifests\["packages\/x"\]: the lockfile is not up to date/u)
    const three = two.replace('importers:\n', 'importers:\n\n  packages/y: {}\n')
    await assert.rejects(buildPnpmTree({ lockfile: three, manifests: { ...manifests({ name: 'x', dependencies: { b: '1.0.0' } }), 'packages/y': '{"name":"x"}' }, workspace: WORKSPACE, patches: { 'patches/p.patch': PATCH }, host: HOST }), /^DeptreeError: manifests\["packages\/y"\]\.name: "x" is the name of another project too$/u)
  })

  // pnpm installs the projects `packages` finds, the root always among
  // them, and only those: a project it would not find is refused.
  it('takes only the projects pnpm-workspace.yaml\'s packages finds', async () => {
    stubRegistry(TARBALLS)
    const x = { name: 'x', dependencies: { b: '1.0.0' } }
    for (const globs of [['packages/*'], ['packages/**'], ['**'], ['./packages/x/'], ['packages/*', '!packages/y'], ['!packages/y', 'packages/*'], ['other/../packages/x']]) {
      const workspace = `packages:\n${globs.map((glob) => `  - '${glob}'\n`).join('')}`
      assert.equal((await buildTwo(x, { workspace })).isSymlink('/packages/x/node_modules/b'), true, globs.join(', '))
    }
    for (const globs of [[], ['packages'], ['packages/y'], ['packages/*/z'], ['*'], ['packages/*', '!packages/x'], ['!packages/x', 'packages/*'], ['packages/.*']]) {
      const workspace = `packages:${globs.length === 0 ? ' []' : ''}\n${globs.map((glob) => `  - '${glob}'\n`).join('')}`
      await assert.rejects(buildTwo(x, { workspace }), /^DeptreeError: importers\["packages\/x"\]: pnpm-workspace\.yaml's packages do not take this directory, so pnpm would not install it as a project$/u, globs.join(', '))
    }
    await assert.rejects(buildTwo(x, { workspace: undefined }), /^DeptreeError: importers\["packages\/x"\]: pnpm-workspace\.yaml's packages are not set/u)
    await assert.rejects(buildTwo(x, { workspace: 'hoist: true\n' }), /packages are not set/u)
  })

  it('refuses globs it does not read as tinyglobby does', async () => {
    for (const glob of ['packages/{x,y}', 'packages/?', 'packages/[xy]', 'packages/@(x)', 'packages\\x', '/packages/x', '../packages/x', 'packages/x**', '!!packages/x', 'packages/!x']) {
      await assert.rejects(buildTwo({}, { workspace: `packages:\n  - '${glob}'\n` }), /^DeptreeError: pnpm-workspace\.yaml: packages: ".*" (?:is not supported|reaches outside)/u, glob)
    }
    for (const workspace of ['packages: packages/*\n', 'packages:\n  - ""\n', 'packages:\n  - 1\n']) {
      await assert.rejects(buildTwo({}, { workspace }), /^DeptreeError: pnpm-workspace\.yaml: packages: expected a list of non-empty strings/u, workspace)
    }
  })
})

// A tree mounted into a Vfs that holds the projects already, beside what
// is there: nothing is written over, and a node_modules there already is
// refused, before anything is fetched, and whatever refuses, nothing is
// written.
describe('buildPnpmTree into a given Vfs', () => {
  const two = lockfile().replace('importers:\n', 'importers:\n\n  packages/x:\n    dependencies:\n      b:\n        specifier: 1.0.0\n        version: 1.0.0\n')
  const x = JSON.stringify({ name: 'x', dependencies: { b: '1.0.0' } })
  const sources = { 'package.json': root(), 'pnpm-lock.yaml': two, 'packages/x/package.json': x, 'packages/x/index.js': 'x' }
  const into = (vfs, options) => buildPnpmTree({ lockfile: two, manifests: { '.': root(), 'packages/x': x }, workspace: 'packages:\n  - packages/*\n', patches: { 'patches/p.patch': PATCH }, host: HOST, vfs, ...options })
  const paths = (vfs) => [...vfs.walk('/')].map(({ path, type }) => `${path} ${type}`)

  it('mounts the tree beside the projects\' own files', async () => {
    stubRegistry(TARBALLS)
    const target = createVfs(sources)
    const { vfs, stats } = await into(target)
    assert.equal(vfs, target)
    assert.equal(vfs.readText('/packages/x/index.js'), 'x')
    assert.equal(vfs.readText('/packages/x/node_modules/b/package.json'), '{"name":"b","version":"1.0.0"}')
    assert.equal(vfs.readText('/node_modules/p/index.js'), 'module.exports = 2\n')
    assert.equal(vfs.stat('/node_modules/.pnpm/d@1.0.0/node_modules/d/bin/d.js').mode, 0o755)
    assert.equal(vfs.realpath('/node_modules/.pnpm/node_modules/x'), '/packages/x')
    assert.equal(stats.projects, 2)
  })

  it('refuses a node_modules there already, anywhere, before it fetches anything', async () => {
    const calls = stubRegistry(TARBALLS)
    const there = [
      ['node_modules/q/index.js', '/node_modules'],
      ['packages/x/node_modules/.modules.yaml', '/packages/x/node_modules'],
      ['packages/unrelated/src/node_modules', '/packages/unrelated/src/node_modules'],
    ]
    for (const [path, found] of there) {
      const target = createVfs({ ...sources, [path]: '' })
      const before = paths(target)
      await assert.rejects(into(target), (error) => error instanceof DeptreeError && error.message === `vfs[${JSON.stringify(found)}]: a node_modules is there already, which is neither kept beside the tree nor removed`, path)
      assert.deepEqual(paths(target), before)
    }
    const linked = createVfs({ ...sources, 'other/node_modules': { type: 'symlink', target: '../elsewhere' } })
    await assert.rejects(into(linked), /^DeptreeError: vfs\["\/other\/node_modules"\]: a node_modules is there already/u)
    assert.equal(calls.length, 0)
  })

  it('refuses a link or a file where the tree has a directory, and writes nothing', async () => {
    stubRegistry(TARBALLS)
    const refused = [
      [{ 'package.json': root(), packages: { type: 'symlink', target: 'elsewhere' }, 'elsewhere/x/package.json': x }, /^DeptreeError: vfs\["\/packages"\]: a symlink is there already, where the tree has a directory$/u],
      [{ 'package.json': root(), 'packages/x': 'not a directory' }, /^DeptreeError: vfs\["\/packages\/x"\]: a file is there already, where the tree has a directory$/u],
    ]
    for (const [given, pattern] of refused) {
      const target = createVfs(given)
      const before = paths(target)
      await assert.rejects(into(target), pattern)
      assert.deepEqual(paths(target), before)
    }
  })

  it('writes nothing where the tree is refused as it is built', async () => {
    stubRegistry(TARBALLS.map((t) => (t.name === 'b' ? { ...t, served: new Uint8Array([...t.bytes, 0]) } : t)))
    const target = createVfs(sources)
    const before = paths(target)
    await assert.rejects(into(target), /integrity mismatch/u)
    assert.deepEqual(paths(target), before)
  })

  it('refuses on macOS a name there already that is one with a name of the tree', async () => {
    stubRegistry(TARBALLS)
    const mac = { ...HOST, os: 'darwin', cpu: 'arm64' }
    await assert.rejects(into(createVfs({ ...sources, 'lib/Node_Modules/x': '' }), { host: mac }), /^DeptreeError: vfs\["\/lib\/Node_Modules"\]: a node_modules is there already/u)
    await assert.rejects(into(createVfs({ 'package.json': root(), 'Packages/x/package.json': x }), { host: mac }), /^DeptreeError: vfs\["\/packages"\]: "Packages" is there already, which is one name with "packages" on macOS$/u)
    const linux = await into(createVfs({ ...sources, 'lib/Node_Modules/x': '' }))
    assert.equal(linux.vfs.isFile('/lib/Node_Modules/x'), true)
  })

  it('takes a Vfs and nothing else', async () => {
    await assert.rejects(into({}), (error) => error instanceof TypeError && error.message === 'vfs must be a Vfs, or left out')
  })
})

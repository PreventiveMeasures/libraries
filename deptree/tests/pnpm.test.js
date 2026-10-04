import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { afterEach, describe, it } from 'node:test'
import { compress } from '@preventive/archive/compression.js'
import { pack } from '@preventive/archive/tar.js'
import { createVfs } from '@preventive/vfs'
import { DeptreeError, LockfileError, YamlError, buildPnpmTree, findPnpmProjects } from '../pnpm.js'
import { HOST, paths, rawTar, sri, stubFailingRegistry, stubRegistry, tarball } from './registry.js'

// A lockfile with a package of every kind this builds, from tarballs made
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
const HOST_9 = { ...HOST, pnpm: '9.15.9' }
const HOST_11 = { ...HOST, pnpm: '11.28.2' }
const HOST_12 = { ...HOST, pnpm: '12.8.1' }
const UP = `Up@1.0.0_${hex('Up@1.0.0').slice(0, 32)}`
const P = `p@1.0.0_patch_hash=${H}`

const small = (importer, packages, snapshots, overrides = '') => `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false
${overrides && `\noverrides:\n${overrides}`}
importers:

  .:
    dependencies:
${importer}
packages:
${packages}
snapshots:
${snapshots}`
const dep = (name, version = '1.0.0', specifier = version) => `      ${name}:\n        specifier: ${specifier}\n        version: ${version}\n`
const entry = (t, fields = '') => `  ${t.name}@${t.version}:\n    resolution: {integrity: ${t.integrity}}\n${fields}`
// The tree of a root that depends on each tarball's package alone.
const only = (tarballs, { fields = '', ...options } = {}) => {
  stubRegistry(tarballs)
  const locked = small(tarballs.map((t) => dep(t.name, t.version)).join(''), `${tarballs.map((t) => entry(t, fields)).join('\n')}\n`, tarballs.map((t) => `  ${t.name}@${t.version}: {}\n`).join('\n'))
  return buildPnpmTree({ lockfile: locked, manifests: { '.': JSON.stringify({ name: 'root', dependencies: Object.fromEntries(tarballs.map((t) => [t.name, t.version])) }) }, host: HOST, ...options })
}

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
    assert.equal(vfs.readText('/node_modules/a/index.js'), 'a')
    assert.equal(vfs.readText('/node_modules/my-lodash/lodash.js'), 'lodash')
    assert.equal(vfs.realpath('/node_modules/a/../b/../d/bin/d.js'), '/node_modules/.pnpm/d@1.0.0/node_modules/d/bin/d.js')
    assert.equal(vfs.stat('/node_modules/.pnpm/d@1.0.0/node_modules/d/bin/d.js').mode, 0o755)
    assert.equal(vfs.stat('/node_modules/.pnpm/d@1.0.0/node_modules/d/package.json').mode, 0o644)
  })

  // pnpm folds an alias's case, but not the root project's, before it looks
  // for it there: `Up` is hoisted though the root has it, as JSONStream is.
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
    assert.equal(vfs.readText('/node_modules/p/index.js'), 'module.exports = 2\n')
  })

  it('installs an optional package where supportedArchitectures takes it', async () => {
    stubRegistry(TARBALLS)
    const vfs = await build({ workspace: 'supportedArchitectures:\n  os: [current, darwin]\n' })
    assert.equal(vfs.readlink('/node_modules/mac'), '.pnpm/mac@1.0.0/node_modules/mac')
  })

  it('refuses once every fetch started has ended', async () => {
    const open = stubFailingRegistry(TARBALLS, 'a', '1.0.0')
    await assert.rejects(build(), /^DeptreeError: "a@1\.0\.0": /u)
    assert.equal(open(), 0)
  })

  it('counts what it installs', async () => {
    stubRegistry(TARBALLS)
    const { stats } = await buildResult()
    assert.ok(stats.bytes > 0)
    assert.deepEqual({ ...stats, bytes: 0 }, { projects: 1, snapshots: 9, installed: 8, skipped: 1, incompatible: 0, tarballs: 8, patched: 1, files: 12, bytes: 0, links: 13 })
  })

  it('lists what it installs, as an SBOM would take it', async () => {
    stubRegistry(TARBALLS)
    const listed = (name, version, { key = `${name}@${version}`, dir = key, dev = false, optional = false, patch } = {}) => ({
      path: `node_modules/.pnpm/${dir}/node_modules/${name}`, key, name, version, integrity: I[name], directory: undefined, dev, optional, patch,
    })
    const { installed, stats } = await buildResult()
    assert.deepEqual(installed, [
      listed('Up', '1.0.0', { dir: UP }),
      listed('a', '1.0.0', { key: 'a@1.0.0(c@2.0.0)', dir: 'a@1.0.0_c@2.0.0' }),
      listed('b', '1.0.0'),
      listed('c', '2.0.0'),
      listed('d', '1.0.0'),
      listed('e', '1.0.0', { dev: true }),
      listed('lodash', '4.17.21'),
      listed('p', '1.0.0', { key: `p@1.0.0(patch_hash=${H})`, dir: P, patch: { hash: H, path: 'patches/p.patch' } }),
    ])
    assert.equal(installed.length, stats.installed)
    const { installed: wider } = await buildResult({ workspace: 'supportedArchitectures:\n  os: [current, darwin]\n' })
    assert.deepEqual(wider.find(({ name }) => name === 'mac'), listed('mac', '1.0.0', { optional: true }))
  })

  // z is reached by y, a devDependency, and by x, a dependency: only w,
  // which y alone reaches, is dev.
  it('lists as dev only what devDependencies alone reach', async () => {
    const more = await Promise.all([
      tarball('w', '1.0.0'),
      tarball('x', '1.0.0', {}, { manifest: { dependencies: { z: '1.0.0' } } }),
      tarball('y', '1.0.0', {}, { manifest: { dependencies: { w: '1.0.0', z: '1.0.0' } } }),
      tarball('z', '1.0.0'),
    ])
    stubRegistry(more)
    const { installed } = await buildPnpmTree({
      lockfile: small(`${dep('x')}    devDependencies:\n${dep('y')}`, `${more.map((t) => entry(t)).join('\n')}\n`, `  w@1.0.0: {}

  x@1.0.0:
    dependencies:
      z: 1.0.0

  y@1.0.0:
    dependencies:
      w: 1.0.0
      z: 1.0.0

  z@1.0.0: {}
`),
      manifests: { '.': JSON.stringify({ name: 'root', dependencies: { x: '1.0.0' }, devDependencies: { y: '1.0.0' } }) },
      host: HOST,
    })
    assert.deepEqual(installed.map(({ name, dev }) => [name, dev]), [['w', true], ['x', false], ['y', true], ['z', false]])
  })

  it('names long directories as pnpm 10 does', async () => {
    stubRegistry(TARBALLS)
    const vfs = await build({ workspace: 'virtualStoreDirMaxLength: 40\n' })
    assert.ok(vfs.isDirectory(`/node_modules/.pnpm/a@1.0.0_c@2.0.0/node_modules/a`))
    assert.ok(vfs.isDirectory(`/node_modules/.pnpm/p@1.0.0_${hex(`p@1.0.0_patch_hash=${H}`).slice(0, 32)}/node_modules/p`))
  })
})

describe('buildPnpmTree packages', () => {
  const BIN = { fields: '    hasBin: true\n' }
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
    const { vfs } = await only(bins, BIN)
    const t = '/node_modules/.pnpm/t@1.0.0/node_modules/t'
    assert.equal(vfs.stat(`${t}/cli.js`).mode, 0o755)
    assert.equal(vfs.readText(`${t}/cli.js`), '#!/usr/bin/env node\nrun()\r\n')
    assert.equal(vfs.stat(`${t}/other.js`).mode, 0o644)
    assert.equal(vfs.readText(`${t}/other.js`), '#!/x\r\n')
    assert.equal(vfs.stat('/node_modules/.pnpm/u@1.0.0/node_modules/u/u.js').mode, 0o644)
    assert.equal(vfs.readText('/node_modules/.pnpm/u@1.0.0/node_modules/u/u.js'), '#!/usr/bin/env node\r\n')
  })

  // pnpm reads a `bin` list as any object, by its keys: `["bin/foo"]`'s
  // command is `0`, and takes nothing from foo's `foo`, so both are fixed.
  it('takes a bin list\'s commands by their indexes, as pnpm does', async () => {
    const bins = await Promise.all([
      tarball('arr', '1.0.0', { 'bin/foo': '#!/usr/bin/env node\n' }, { manifest: { bin: ['bin/foo'] } }),
      tarball('foo', '1.0.0', { 'f.js': '#!/usr/bin/env node\n' }, { manifest: { bin: { foo: 'f.js' } } }),
    ])
    const { vfs } = await only(bins, BIN)
    assert.equal(vfs.stat('/node_modules/.pnpm/arr@1.0.0/node_modules/arr/bin/foo').mode, 0o755)
    assert.equal(vfs.stat('/node_modules/.pnpm/foo@1.0.0/node_modules/foo/f.js').mode, 0o755)
  })

  // pnpm looks for a Node to run a package's bins with where the first
  // Node of its engines.runtime is one to download, and fails on a list
  // with nothing where it reads a runtime.
  it('refuses the bins of a package whose engines.runtime has pnpm download a Node', async () => {
    const runtimes = [
      [{ name: 'node', onFail: 'warn' }, true],
      [[{ name: 'deno', onFail: 'download' }, { name: 'node', onFail: 'error' }, null], true],
      [[{ name: 'node', onFail: 'download' }], false],
      [{ name: 'node', version: '22', onFail: 'download' }, false],
      [[{ name: 'deno' }, null, { name: 'node' }], false],
    ]
    for (const [runtime, builds] of runtimes) {
      const r = await tarball('r', '1.0.0', { 'r.js': '#!/usr/bin/env node\n' }, { manifest: { bin: { r: 'r.js' }, engines: { runtime } } })
      const built = only([r], BIN)
      if (builds) assert.equal((await built).vfs.stat('/node_modules/r/r.js').mode, 0o755, JSON.stringify(runtime))
      else await assert.rejects(built, /^DeptreeError: "r@1\.0\.0": its engines\.runtime (?:has pnpm look for a Node|lists nothing where pnpm reads a runtime)/u, JSON.stringify(runtime))
    }
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
    const lock = small(dep('npm') + dep('zz') + dep('h', '1.0.0(p@1.0.0)', '1.0.0'), `${bins.map((t) => entry(t, t.name === 'h' ? '    peerDependencies:\n      p: 1.0.0\n' : '    hasBin: true\n')).join('\n')}\n`, '  h@1.0.0(p@1.0.0):\n    dependencies:\n      p: 1.0.0\n      z: 1.0.0\n\n  npm@1.0.0: {}\n\n  p@1.0.0: {}\n\n  z@1.0.0: {}\n\n  zz@1.0.0: {}\n')
    const mode = (vfs, key, file) => vfs.stat(`/node_modules/.pnpm/${key}/node_modules/${key.split('@')[0]}/${file}`).mode
    const options = { lockfile: lock, manifests: { '.': manifest({ npm: '1.0.0', zz: '1.0.0', h: '1.0.0' }) }, workspace: 'hoist: false\n' }
    const v11 = (await buildPnpmTree({ ...options, host: HOST_11 })).vfs
    assert.deepEqual([mode(v11, 'npm@1.0.0', 'n.js'), mode(v11, 'zz@1.0.0', 'z.js'), mode(v11, 'p@1.0.0', 'p.js')], [0o755, 0o644, 0o755])
    const v10 = (await buildPnpmTree({ ...options, host: HOST })).vfs
    assert.deepEqual([mode(v10, 'npm@1.0.0', 'n.js'), mode(v10, 'zz@1.0.0', 'z.js'), mode(v10, 'p@1.0.0', 'p.js')], [0o644, 0o755, 0o644])
  })

  // pnpm 12 links p's own bins beside a's in p's .bin, where a's `x` wins,
  // a's name sorting first, as it does beside q; where pnpm 11 links p's,
  // whose name sorts last, beside q. Beside a directories.bin, it reads a
  // null `bin` as its store has the package or not, and it fails on a bin
  // that is a directory.
  it('links bins as pnpm 12 does', async () => {
    const bins = await Promise.all([
      tarball('a', '1.0.0', { 'ax.js': '#!a\n' }, { manifest: { bin: { x: 'ax.js' } } }),
      tarball('p', '1.0.0', { 'x.js': '#!p\n' }, { manifest: { bin: { x: 'x.js' }, dependencies: { a: '1.0.0' } } }),
      tarball('q', '1.0.0', {}, { manifest: { dependencies: { p: '1.0.0', a: '1.0.0' } } }),
    ])
    stubRegistry(bins)
    const lock = small(dep('q'), `${bins.map((t) => entry(t, t.name === 'q' ? '' : '    hasBin: true\n')).join('\n')}\n`, '  a@1.0.0: {}\n\n  p@1.0.0:\n    dependencies:\n      a: 1.0.0\n\n  q@1.0.0:\n    dependencies:\n      a: 1.0.0\n      p: 1.0.0\n')
    const mode = (vfs, name, file) => vfs.stat(`/node_modules/.pnpm/${name}@1.0.0/node_modules/${name}/${file}`).mode
    const options = { lockfile: lock, manifests: { '.': manifest({ q: '1.0.0' }) }, workspace: 'hoist: false\n' }
    const modes = (vfs) => [mode(vfs, 'a', 'ax.js'), mode(vfs, 'p', 'x.js')]
    assert.deepEqual(modes((await buildPnpmTree({ ...options, host: HOST_12 })).vfs), [0o755, 0o644])
    assert.deepEqual(modes((await buildPnpmTree({ ...options, host: HOST_11 })).vfs), [0o755, 0o755])

    const nul = await tarball('nul', '1.0.0', { 'bin/n.js': '#!nul\n' }, { manifest: { bin: null, directories: { bin: 'bin' } } })
    await assert.rejects(only([nul], { ...BIN, host: HOST_12 }), /^DeptreeError: "nul@1\.0\.0": its bin is null beside a directories\.bin, which pnpm 12 links as its store has the package or not$/u)
    assert.equal(mode((await only([nul], { ...BIN, host: HOST_11 })).vfs, 'nul', 'bin/n.js'), 0o755)

    const dir = await tarball('d', '1.0.0', { 'dir/f.js': '' }, { manifest: { bin: { d: 'dir' } } })
    await assert.rejects(only([dir], { ...BIN, host: HOST_12 }), /^DeptreeError: "d@1\.0\.0": its bin "dir" is a directory, which pnpm 12 fails on$/u)
  })

  // pnpm 9 takes a command by its name before it drops the scope, so links
  // `@x/y z` as `y z`; links a `bin` string or a directories.bin wherever
  // it leads; reads no engines.runtime; and fails on a bin that is a
  // directory, which pnpm 10 passes over. Each as real installs of pnpm
  // 9.15.9 and 10.33.4 have it.
  it('links bins as pnpm 9 does', async () => {
    const mode = (vfs, name, file) => vfs.stat(`/node_modules/${name}/${file}`).mode
    const spaced = await tarball('s', '1.0.0', { 's.js': '#!s\n' }, { manifest: { bin: { '@x/y z': 's.js' } } })
    assert.equal(mode((await only([spaced], { ...BIN, host: HOST_9 })).vfs, 's', 's.js'), 0o755)
    assert.equal(mode((await only([spaced], BIN)).vfs, 's', 's.js'), 0o644)
    const runtime = await tarball('r', '1.0.0', { 'r.js': '#!r\n' }, { manifest: { bin: { r: 'r.js' }, engines: { runtime: { name: 'node', onFail: 'download' } } } })
    assert.equal(mode((await only([runtime], { ...BIN, host: HOST_9 })).vfs, 'r', 'r.js'), 0o755)
    const out = await tarball('o', '1.0.0', {}, { manifest: { bin: '../o.js' } })
    await assert.rejects(only([out], { ...BIN, host: HOST_9 }), /^DeptreeError: "o@1\.0\.0": "\.\.\/o\.js" leads out of the package, which pnpm 9 links a bin to all the same, and that is not supported$/u)
    await only([out], BIN)
    const outDir = await tarball('od', '1.0.0', {}, { manifest: { directories: { bin: '../x' } } })
    await assert.rejects(only([outDir], { ...BIN, host: HOST_9 }), /^DeptreeError: "od@1\.0\.0": "\.\.\/x" leads out of the package/u)
    const dir = await tarball('d', '1.0.0', { 'dir/f.js': '' }, { manifest: { bin: { d: 'dir' } } })
    await assert.rejects(only([dir], { ...BIN, host: HOST_9 }), /^DeptreeError: "d@1\.0\.0": its bin "dir" is a directory, which pnpm 9 fails on$/u)
    await only([dir], BIN)
  })
})

// For a `bin` naming none beside a directories.bin, pnpm resolves hasBin
// as none, and pnpm 11 rewrites a snapshot as some: either is taken. pnpm
// links the directories.bin where `bin` is empty text, and pnpm 10 links
// a root project's direct dependency's bins whatever hasBin says.
describe('buildPnpmTree reads a package.json as pnpm writes the lockfile', () => {
  it('takes either hasBin for a bin that names none beside a directories.bin', async () => {
    for (const bin of [{}, '', true]) {
      const k = await tarball('k', '1.0.0', { 'bin/k.js': '#!k\n' }, { manifest: { bin, directories: { bin: 'bin' } } })
      for (const fields of ['', '    hasBin: true\n']) {
        const { vfs } = await only([k], { fields })
        assert.equal(vfs.stat('/node_modules/k/bin/k.js').mode, bin === '' ? 0o755 : 0o644, JSON.stringify([bin, fields]))
      }
    }
    const none = await tarball('k', '1.0.0', { 'bin/k.js': '#!k\n' }, { manifest: { directories: { bin: 'bin' } } })
    await assert.rejects(only([none]), /^DeptreeError: "k@1\.0\.0": package\.json has bins, and the lockfile says it has none$/u)
  })

  it('takes an empty list of bundled dependencies as pnpm 10 and pnpm 11 record it', async () => {
    const e = await tarball('e', '1.0.0', {}, { manifest: { bundleDependencies: [] } })
    for (const fields of ['', '    bundledDependencies: []\n']) {
      const { vfs } = await only([e], { fields })
      assert.equal(vfs.readText('/node_modules/e/package.json'), '{"name":"e","version":"1.0.0","bundleDependencies":[]}', JSON.stringify(fields))
    }
    await assert.rejects(only([e], { fields: '    bundledDependencies: [x]\n' }), /^DeptreeError: "e@1\.0\.0": package\.json bundles other than the lockfile says$/u)
  })

  it('passes over the specifier of a dependency it bundles', async () => {
    const m = await tarball('m', '1.0.0', { 'node_modules/x/package.json': '{"name":"x","version":"1.0.0"}' }, { manifest: { dependencies: { x: 'file:../../x' }, bundledDependencies: ['x'] } })
    const { vfs } = await only([m], { fields: '    bundledDependencies: [x]\n' })
    assert.equal(vfs.readText('/node_modules/m/node_modules/x/package.json'), '{"name":"x","version":"1.0.0"}')
  })
})

// A directory outside the tree whose bins are not known here — one a
// `link:` leads to with no package.json given, one outside the lockfile's
// directory, or a project by its directories.bin — may take any name in
// a .bin it is linked into, so a bin beside it that linking would fix is
// refused. t's bin is `cmd`, and so is v's, which sorts after and wins it.
describe('buildPnpmTree beside the bins of a directory outside the tree', () => {
  const lock = (importer, t) => small(importer, `${entry(t, '    hasBin: true\n')}\n`, '  t@1.0.0: {}\n')
  const bin = async (mode) => {
    const t = await tarball('t', '1.0.0', { 't.js': { data: '#!t\n', mode } }, { manifest: { bin: { cmd: 't.js' } } })
    stubRegistry([t])
    return t
  }
  const tMode = (vfs) => vfs.stat('/node_modules/.pnpm/t@1.0.0/node_modules/t/t.js').mode
  const UNKNOWN = /^DeptreeError: "t@1\.0\.0": whether pnpm makes "t\.js" executable turns on the bins of a directory outside the tree, which are not known here$/u

  describe('a link: that is no project', () => {
    const importers = (to) => `${dep('t')}${dep('v', `link:${to}`)}`
    const rootOf = (to) => JSON.stringify({ name: 'root', dependencies: { t: '1.0.0', v: `link:${to}` } })
    const linkedTo = async (mode, { to = 'vendor/v', project } = {}) => buildPnpmTree({ lockfile: lock(importers(to), await bin(mode)), manifests: { '.': rootOf(to) }, host: HOST, project })
    const given = (v) => createVfs({ 'package.json': rootOf('vendor/v'), 'vendor/v/package.json': JSON.stringify({ name: 'v', version: '1.0.0', bin: v }), 'vendor/v/v.js': '' })

    it('refuses a bin beside it that linking would fix, and takes one it would leave as it is', async () => {
      await assert.rejects(linkedTo(0o644), UNKNOWN)
      await assert.rejects(linkedTo(0o644, { to: '../v', project: given({ cmd: 'v.js' }) }), UNKNOWN)
      assert.equal(tMode((await linkedTo(0o755)).vfs), 0o755)
    })

    it('reads its bins from the project given', async () => {
      assert.equal(tMode((await linkedTo(0o644, { project: given({ cmd: 'v.js' }) })).vfs), 0o644)
      assert.equal(tMode((await linkedTo(0o644, { project: given({ other: 'v.js' }) })).vfs), 0o755)
    })
  })

  describe('a project', () => {
    const importers = (to) => `${dep('t')}${dep('v', `link:${to}`)}\n  packages/b: {}\n`
    const inWorkspace = async (mode, { to, top = {}, b = {} }) => buildPnpmTree({
      lockfile: lock(importers(to), await bin(mode)).replace('  .:\n', '  .: {}\n\n  packages/a:\n'),
      manifests: { '.': JSON.stringify({ name: 'v', ...top }), 'packages/a': JSON.stringify({ name: 'a', dependencies: { t: '1.0.0', v: `link:${to}` } }), 'packages/b': JSON.stringify({ name: 'b', ...b }) },
      workspace: `${WORKSPACE}hoist: false\n`,
      host: HOST,
    })

    it('takes the bins of the root project, where it is linked', async () => {
      assert.equal(tMode((await inWorkspace(0o644, { to: '../..', top: { bin: { cmd: 'cli.js' } } })).vfs), 0o644)
      assert.equal(tMode((await inWorkspace(0o644, { to: '../..' })).vfs), 0o755)
    })

    it('refuses a bin beside one whose bins are the files of its directories.bin', async () => {
      await assert.rejects(inWorkspace(0o644, { to: '../b', b: { directories: { bin: 'bin' } } }), UNKNOWN)
      assert.equal(tMode((await inWorkspace(0o644, { to: '../b', b: { directories: { bin: '../elsewhere' } } })).vfs), 0o755)
    })
  })
})

describe('buildPnpmTree refuses', () => {
  const refuses = async (options, pattern, ErrorType = DeptreeError) => {
    await assert.rejects(build(options), (error) => error instanceof ErrorType && pattern.test(error.message))
  }
  // `packed` is a tarball of entries as they are, not as npm packs one.
  const serving = (served) => {
    stubRegistry([...TARBALLS.filter((t) => t.name !== served.name), served])
    return lockfile().replace(I[served.name], sri(served.bytes))
  }
  const packed = async (name, version, entries, gzip = true) => ({ name, version, bytes: gzip ? await compress(pack(entries), 'gzip') : pack(entries) })

  it('a tarball that is not the one the lockfile pins', async () => {
    stubRegistry(TARBALLS.map((t) => (t.name === 'b' ? { ...t, served: new Uint8Array([...t.bytes, 0]) } : t)))
    await refuses({}, /^"b@1\.0\.0": getTarball: integrity mismatch/u)
  })

  it('a tarball whose package.json is for another package', async () => {
    const other = await tarball('b', '1.0.0', { 'package.json': JSON.stringify({ name: 'bb', version: '1.0.0' }) })
    await refuses({ lockfile: serving(other) }, /^"b@1\.0\.0": package.json is for "bb@1\.0\.0"/u)
  })

  // pnpm passes over a symlink, and npm packs none: a tarball with one was
  // not packed by npm, and is refused as a hard link or a device is.
  it('a link of either kind in a tarball', async () => {
    const linked = (type, linkname) => packed('c', '2.0.0', [{ name: 'package/package.json', data: new TextEncoder().encode('{"name":"c","version":"2.0.0"}') }, { name: 'package/x', type, linkname }])
    await refuses({ lockfile: serving(await linked('symlink', 'package.json')) }, /^"c@2\.0\.0": "package\/x" is a symlink, which is not supported$/u)
    await refuses({ lockfile: serving(await linked('hardlink', 'package/package.json')) }, /^"c@2\.0\.0": "package\/x" is a hardlink/u)
  })

  // Real installs of pnpm 10.33.4 and 11.28.2 put `a\..\b` at `b`, `x.\y`
  // at `x./y`, `c\d` at `c\d` and `pkg\sub/w` at `sub/w`; 12.8.1 fails on
  // the first, and puts `c\d` at `c/d`; 9.15.9 keeps the first three as they
  // are, and puts `pkg\sub/w` at `sub/w`. @preventive/archive refuses each
  // first, and package.js would after it.
  it('a name with a backslash, which pnpm may take for a separator', async () => {
    for (const name of ['package/a\\..\\b', 'package/x.\\y', 'package/c\\d', 'pkg\\sub/w']) {
      const bytes = await compress(rawTar([{ name: 'package/package.json', data: '{"name":"b","version":"1.0.0"}' }, { name, data: '' }]), 'gzip')
      const pattern = new RegExp(`^DeptreeError: "b@1\\.0\\.0": .*${RegExp.escape(JSON.stringify(name))}.* backslash`, 'u')
      for (const host of [HOST_9, HOST, HOST_11, HOST_12]) await assert.rejects(only([{ name: 'b', version: '1.0.0', bytes, integrity: sri(bytes) }], { host }), pattern)
    }
  })

  // Stricter than pnpm, which passes over most of these.
  it('a tarball that is not one npm packs, or whose package.json the lockfile does not agree with', async () => {
    const json = new TextEncoder().encode('{"name":"b","version":"1.0.0"}')
    const cases = [
      [await tarball('b', '1.0.0', {}, { manifest: { os: ['darwin'] } }), /package\.json's os is not the lockfile's$/u],
      [await tarball('b', '1.0.0', {}, { manifest: { bin: 'x.js' } }), /package\.json has bins, and the lockfile says it has none$/u],
      [await tarball('b', '1.0.0', {}, { manifest: { bundleDependencies: ['z'] } }), /package\.json bundles other than the lockfile says$/u],
      [await tarball('b', '1.0.0', {}, { manifest: { dependencies: { z: '1.0.0' } } }), /package\.json asks for "z", which the lockfile does not give it$/u],
      [await tarball('B', '1.0.0', {}), /package\.json is for "B@1\.0\.0"/u],
      [await tarball('b', '1.0.0', { 'package.json': '[]' }), /package\.json is not an object$/u],
      [await packed('b', '1.0.0', [{ name: 'package/package.json', data: json }, { name: 'other/x.js', data: json }]), /^"b@1\.0\.0": the tarball has files under more than one directory, or at its top$/u],
      [await packed('b', '1.0.0', [{ name: 'package.json', data: json }, { name: 'x.js', data: json }]), /^"b@1\.0\.0": the tarball has files under more than one directory, or at its top$/u],
      [await packed('b', '1.0.0', [{ name: 'package/package.json', data: json }], false), /^"b@1\.0\.0": the tarball is not gzipped$/u],
      [await tarball('b', '1.0.0', { 'x.js': 'x', 'package.json': undefined }), /^"b@1\.0\.0": the tarball has no package\.json$/u],
    ]
    for (const [served, pattern] of cases) await refuses({ lockfile: serving({ ...served, name: 'b' }) }, pattern)
  })

  it('a lockfile whose optional marks pnpm would not have written', async () => {
    await refuses({ lockfile: lockfile().replace('  mac@1.0.0:\n    optional: true\n', '  mac@1.0.0: {}\n') }, /^snapshots\["mac@1\.0\.0"\]: marked required where only optional dependencies reach it/u)
    await refuses({ lockfile: lockfile().replace('  c@2.0.0: {}\n', '  c@2.0.0:\n    optional: true\n') }, /^snapshots\["c@2\.0\.0"\]: marked optional where an importer requires it/u)
  })

  it('a project inside node_modules', async () => {
    const inside = lockfile().replace('importers:\n', 'importers:\n\n  node_modules/x: {}\n')
    await refuses({ lockfile: inside, manifests: { '.': root(), 'node_modules/x': '{}' } }, /^importers\["node_modules\/x"\]: a project inside node_modules/u)
    // macOS takes Node_Modules for node_modules.
    const mac = { ...HOST, os: 'darwin', libc: 'unknown' }
    const cased = lockfile().replace('importers:\n', 'importers:\n\n  Node_Modules/x: {}\n')
    const workspace = 'packages:\n  - "**"\n'
    await refuses({ lockfile: cased, manifests: { '.': root(), 'Node_Modules/x': '{}' }, host: mac, workspace }, /^importers\["Node_Modules\/x"\]: a project inside node_modules/u)
    // A project given with no importer, as pnpm 12 takes, too.
    await refuses({ manifests: { '.': root(), 'packages/node_modules/x': '{}' }, workspace }, /^importers\["packages\/node_modules\/x"\]: a project inside node_modules/u)
  })

  it('names that are one name on macOS, where the host is macOS', async () => {
    const both = serving(await tarball('b', '1.0.0', { 'Index.js': 'a', 'index.js': 'b' }))
    const vfs = await build({ lockfile: both })
    assert.deepEqual(vfs.readdir('/node_modules/.pnpm/b@1.0.0/node_modules/b'), ['Index.js', 'index.js', 'package.json'])
    await refuses({ lockfile: both, host: { ...HOST, os: 'darwin', libc: 'unknown' } }, /"Index\.js" and "index\.js" are one name on macOS$/u)
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
  // to the hashes and the paths.
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
    await refuses({ host: { ...HOST, pnpm: '8.15.9' } }, /^host\.pnpm: pnpm "8\.15\.9" is not supported: only pnpm 9, 10, 11 and 12 are$/u)
    await refuses({ host: { ...HOST, os: 'win32' } }, /^host\.os: Windows is not supported/u)
    await assert.rejects(build({ host: { ...HOST, libc: undefined } }), TypeError)
  })

  it('an incompatible package where engineStrict has pnpm refuse one', async () => {
    const e = await tarball('e', '1.0.0', {}, { manifest: { os: ['darwin'] } })
    const strict = serving(e).replace(`{integrity: ${e.integrity}}\n`, `{integrity: ${e.integrity}}\n    os: [darwin]\n`)
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

  // NPM_TOKEN is taken to be set, so the rest of the file is read, and the
  // lockfile held to it.
  it('an .npmrc with the registry\'s token, read whole', async () => {
    stubRegistry(TARBALLS)
    const npmrc = '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\nauto-install-peers=false\nhoist=false\n'
    const vfs = await build({ npmrc, lockfile: lockfile().replace('autoInstallPeers: true', 'autoInstallPeers: false') })
    assert.equal(vfs.isDirectory('/node_modules/.pnpm/node_modules'), false)
    await refuses({ npmrc }, /^settings\.autoInstallPeers: autoInstallPeers is true in the lockfile, which a frozen install refuses$/u)
  })

  it('a lockfile the lockfile reader refuses, or YAML it cannot read', async () => {
    const named = (pattern, Cause) => (error) => error instanceof DeptreeError && pattern.test(error.message) && error.cause instanceof Cause
    await assert.rejects(build({ lockfile: "lockfileVersion: '6.0'\n" }), named(/^pnpm-lock\.yaml: lockfileVersion: unsupported version/u, LockfileError))
    await assert.rejects(build({ lockfile: 'a:\n   b: 1\n  c: 2\n' }), named(/^pnpm-lock\.yaml: bad indentation at line 3$/u, YamlError))
    await assert.rejects(build({ workspace: 'a:\n   b: 1\n  c: 2\n' }), named(/^pnpm-workspace\.yaml: bad indentation at line 3$/u, YamlError))
  })

  // pnpm installs the projects it finds, and holds each to its importer:
  // one without the other is not the lockfile's tree.
  it('a project without its package.json, or one pnpm would not find', async () => {
    const two = lockfile().replace('importers:\n', 'importers:\n\n  packages/x: {}\n')
    await refuses({ lockfile: two }, /^importers\["packages\/x"\]: the package\.json of this project is not given$/u)
    await refuses({ manifests: { '.': root(), 'packages/y': '{}' } }, /^importers\["packages\/y"\]: pnpm-workspace\.yaml's packages are not set, so pnpm would not install it as a project$/u)
  })

  it('a lockfile not up to date with a package.json', async () => {
    stubRegistry(TARBALLS)
    await refuses({ manifest: root({ dependencies: { a: '^1.0.0' } }) }, /^manifests\["\."\]: the lockfile is not up to date with this package\.json, which a frozen install refuses: the specifiers differ/u)
    await refuses({ manifest: root({ peerDependencies: { b: '1.0.0' } }) }, /the specifiers differ: "b" is nothing in the lockfile and "1\.0\.0" in package\.json$/u)
    const vfs = await build({ manifest: root({ peerDependencies: { a: '1.0.0' } }), workspace: 'hoist: true\n' })
    assert.ok(vfs.isSymlink('/node_modules/a'), 'a peer the project lists as a dependency too asks for nothing more')
  })
})

const TWO = lockfile().replace('importers:\n', 'importers:\n\n  packages/x:\n    dependencies:\n      b:\n        specifier: 1.0.0\n        version: 1.0.0\n')
const WORKSPACE = 'packages:\n  - packages/*\n'

// The lockfile as pnpm 11 and 12 write it, each patch's hash alone.
const flatLockfile = ({ patchHash = H } = {}) => lockfile({ patchHash }).replace(`  p@1.0.0:\n    hash: ${patchHash}\n    path: patches/p.patch\n`, `  p@1.0.0: ${patchHash}\n`)
const PATCHED_IN_YAML = 'patchedDependencies:\n  p@1.0.0: patches/p.patch\n'
const UNPATCHED = root({ pnpm: { patchedDependencies: undefined } })

// pnpm 9 reads its settings from the .npmrc and the package.json, and of
// pnpm-workspace.yaml the projects and the catalogs alone; hashes a patch,
// and cuts a long directory's name, with MD5 in base32; and hoists
// `*eslint*` and `*prettier*` publicly by default. Each as real installs of
// pnpm 9.15.9 have it.
describe('buildPnpmTree for pnpm 9', () => {
  const md5 = (text) => {
    let bits = ''
    for (const byte of createHash('md5').update(text).digest()) bits += byte.toString(2).padStart(8, '0')
    return bits.padEnd(130, '0').match(/.{5}/gu).map((chunk) => 'abcdefghijklmnopqrstuvwxyz234567'[Number.parseInt(chunk, 2)]).join('')
  }
  const H9 = md5(PATCH)
  const lockfile9 = () => lockfile({ patchHash: H9 })
  const built = (options = {}) => buildResult({ lockfile: lockfile9(), host: HOST_9, ...options })

  it('builds the tree pnpm 9 installs', async () => {
    stubRegistry(TARBALLS)
    const { vfs } = await built()
    assert.equal(vfs.readText('/node_modules/p/index.js'), 'module.exports = 2\n')
    assert.deepEqual(vfs.readdir('/node_modules/.pnpm'), [`Up@1.0.0_${md5('Up@1.0.0')}`, 'a@1.0.0_c@2.0.0', 'b@1.0.0', 'c@2.0.0', 'd@1.0.0', 'e@1.0.0', 'lodash@4.17.21', 'node_modules', `p@1.0.0_patch_hash=${H9}`])
    assert.deepEqual(vfs.readdir('/node_modules/.pnpm/node_modules'), ['Up', 'b', 'c', 'd'])
    await assert.rejects(built({ lockfile: lockfile() }), /^DeptreeError: patchedDependencies: the patches differ: "p@1\.0\.0" is "[\da-f]{64} patches\/p\.patch" in the lockfile and "[a-z2-7]{26} patches\/p\.patch" in the settings, which a frozen install refuses$/u)
  })

  it('hoists *eslint* and *prettier* publicly by default', async () => {
    const more = await Promise.all([tarball('w', '1.0.0', {}, { manifest: { dependencies: { 'eslint-z': '1.0.0', y: '1.0.0' } } }), tarball('eslint-z', '1.0.0'), tarball('y', '1.0.0')])
    stubRegistry(more)
    const lock = small(dep('w'), `${more.map((t) => entry(t)).join('\n')}\n`, '  eslint-z@1.0.0: {}\n\n  w@1.0.0:\n    dependencies:\n      eslint-z: 1.0.0\n      y: 1.0.0\n\n  y@1.0.0: {}\n')
    const options = { lockfile: lock, manifests: { '.': JSON.stringify({ name: 'root', dependencies: { w: '1.0.0' } }) } }
    const { vfs } = await buildPnpmTree({ ...options, host: HOST_9 })
    assert.equal(vfs.readlink('/node_modules/eslint-z'), '.pnpm/eslint-z@1.0.0/node_modules/eslint-z')
    assert.deepEqual(vfs.readdir('/node_modules/.pnpm/node_modules'), ['y'])
    assert.equal((await buildPnpmTree({ ...options, host: HOST })).vfs.isSymlink('/node_modules/eslint-z'), false)
    assert.equal((await buildPnpmTree({ ...options, host: HOST_9, npmrc: 'public-hoist-pattern=\n' })).vfs.isSymlink('/node_modules/eslint-z'), false)
  })

  it('reads no setting of pnpm-workspace.yaml, nor one pnpm 9 has not', async () => {
    stubRegistry(TARBALLS)
    const { vfs } = await built({ workspace: 'packages: []\nhoist: false\nnodeLinker: hoisted\npatchedDependencies:\n  q: patches/q.patch\n' })
    assert.deepEqual(vfs.readdir('/node_modules/.pnpm/node_modules'), ['Up', 'b', 'c', 'd'])
    await assert.rejects(built({ workspace: 'hoist: false\n' }), /^DeptreeError: pnpm-workspace\.yaml: packages: pnpm 9 fails on a workspace manifest that sets anything and no packages$/u)
    await built({ npmrc: 'dedupe-peers=true\nenable-global-virtual-store=true\n', manifest: root({ pnpm: { configDependencies: { c: '2.0.0' }, allowBuilds: { a: true } } }) })
  })

  it('takes a project anywhere for a pnpm-workspace.yaml that sets nothing', async () => {
    stubRegistry(TARBALLS)
    const manifests = { '.': root(), 'packages/x': JSON.stringify({ name: 'x', dependencies: { b: '1.0.0' } }) }
    const two = TWO.replace(`hash: ${H}`, `hash: ${H9}`).replaceAll(`patch_hash=${H}`, `patch_hash=${H9}`)
    const { vfs } = await built({ lockfile: two, manifests, workspace: '' })
    assert.equal(vfs.realpath('/packages/x/node_modules/b'), '/node_modules/.pnpm/b@1.0.0/node_modules/b')
    await assert.rejects(buildResult({ lockfile: TWO, manifests, workspace: '' }), /^DeptreeError: importers\["packages\/x"\]: pnpm-workspace\.yaml's packages are not set/u)
  })

  it('holds the lockfile to neither the catalogs nor dedupePeers', async () => {
    stubRegistry(TARBALLS)
    const deduped = (locked) => locked.replace('  autoInstallPeers: true\n', '  autoInstallPeers: true\n  dedupePeers: true\n')
    const cataloged = (locked) => locked.replace('\nimporters:\n', '\ncatalogs:\n  default:\n    ms:\n      specifier: 2.1.3\n      version: 2.1.3\n\nimporters:\n')
    for (const change of [deduped, cataloged]) {
      await built({ lockfile: change(lockfile9()) })
      await assert.rejects(buildResult({ lockfile: change(lockfile()) }), /^DeptreeError: (?:settings\.dedupePeers|catalogs): /u)
    }
  })

  it('installs with itself the project another pnpm is pinned for', async () => {
    stubRegistry(TARBALLS)
    await built({ manifest: root({ packageManager: 'pnpm@10.33.4' }) })
    await assert.rejects(built({ manifest: root({ packageManager: 'pnpm@10.33.4' }), npmrc: 'package-manager-strict-version=true\n' }), /which pnpm 9 refuses with packageManagerStrict and packageManagerStrictVersion$/u)
    await assert.rejects(built({ manifest: root({ packageManager: 'yarn@1.22.22' }) }), /which pnpm 9 refuses with packageManagerStrict$/u)
  })

  it('refuses a pnpm 9 before 9.15.0', async () => {
    await assert.rejects(built({ host: { ...HOST, pnpm: '9.14.4' } }), /^DeptreeError: host\.pnpm: pnpm "9\.14\.4" is not supported: pnpm 9 is from 9\.15\.0 on$/u)
  })
})

// pnpm 11 reads its settings from pnpm-workspace.yaml alone.
describe('buildPnpmTree for pnpm 11', () => {

  it('builds from settings in pnpm-workspace.yaml and pnpm 11\'s lockfile', async () => {
    stubRegistry(TARBALLS)
    const { vfs } = await buildResult({ lockfile: flatLockfile(), manifest: UNPATCHED, workspace: PATCHED_IN_YAML, host: HOST_11 })
    assert.equal(vfs.readText('/node_modules/p/index.js'), 'module.exports = 2\n')
  })

  // pnpm 11 checks a lockfile against the registry before it installs,
  // unless trustLockfile; this asks the registry for nothing but tarballs.
  it('follows the lockfile, whatever minimumReleaseAge says', async () => {
    const calls = stubRegistry(TARBALLS)
    const elsewhere = flatLockfile().replace(`  mac@1.0.0:\n    resolution: {integrity: ${I.mac}}`, `  mac@1.0.0:\n    resolution: {integrity: ${I.mac}, tarball: https://example.com/mac.tgz}`)
    const workspace = `${PATCHED_IN_YAML}minimumReleaseAge: 100000\nminimumReleaseAgeStrict: true\ntrustLockfile: false\n`
    const { vfs } = await buildResult({ lockfile: elsewhere, manifest: UNPATCHED, workspace, host: HOST_11 })
    assert.equal(vfs.readText('/node_modules/p/index.js'), 'module.exports = 2\n')
    assert.ok(calls.every((url) => url.endsWith('.tgz')), calls.join(', '))
  })

  // With engineStrict, pnpm 11 passes over the engines the lockfile
  // records of a patched package, and holds its package.json, patched, to
  // the Node instead; pnpm 10 holds the lockfile's.
  it('holds a patched package to its engines once patched, with engineStrict', async () => {
    const json = (node) => `{"name":"p","version":"1.0.0","engines":{"node":"${node}"}}\n`
    const p = await tarball('p', '1.0.0', { 'index.js': 'module.exports = 1\n', 'package.json': json('>=99') })
    stubRegistry([...TARBALLS.filter((t) => t.name !== 'p'), p])
    const ANY = `diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -1 +1 @@
-${json('>=99')}+${json('*')}`
    const locked = (patch, major) => (major < 11 ? lockfile : flatLockfile)({ patchHash: hex(patch) }).replace(`{integrity: ${I.p}}\n`, `{integrity: ${p.integrity}}\n    engines: {node: '>=99'}\n`)
    const built = (patch, { host = HOST_11, workspace = `${PATCHED_IN_YAML}engineStrict: true\n` } = {}) => {
      const major = Number(host.pnpm.split('.')[0])
      const manifest = major < 11 ? root({ pnpm: { patchedDependencies: undefined } }) : root()
      return buildPnpmTree({ lockfile: locked(patch, major), manifests: { '.': manifest }, workspace, patches: { 'patches/p.patch': patch }, host })
    }
    assert.equal((await built(ANY)).vfs.readText('/node_modules/p/package.json'), json('*'))
    await assert.rejects(built(PATCH), /^DeptreeError: "p@1\.0\.0\(patch_hash=[\da-f]{64}\)": its package\.json, patched, has an engines\.node, ">=99", that does not take Node 24\.15\.0, which pnpm 11 refuses with engineStrict/u)
    assert.equal((await built(PATCH, { workspace: PATCHED_IN_YAML })).vfs.readText('/node_modules/p/index.js'), 'module.exports = 2\n')
    await assert.rejects(built(ANY, { host: HOST }), /^DeptreeError: "p@1\.0\.0\(patch_hash=[\da-f]{64}\)": the host does not take its engines\.node, which engineStrict refuses$/u)
  })

  // pnpm 11 writes an env document before the lockfile, for config
  // dependencies and the pnpm a project pins; before anything is installed,
  // the env document alone.
  it('reads the env document before the lockfile, and refuses it alone', async () => {
    stubRegistry(TARBALLS)
    const env = (config = '') => `---\nlockfileVersion: '9.0'\n\nimporters:\n\n  .:\n${config}    packageManagerDependencies:\n      pnpm:\n        specifier: 11.28.2\n        version: 11.28.2\n\npackages:\n\n${config && `  c@2.0.0:\n    resolution: {integrity: ${I.c}}\n\n`}  pnpm@11.28.2:\n    resolution: {integrity: ${I.p}}\n\nsnapshots:\n\n${config && '  c@2.0.0: {}\n\n'}  pnpm@11.28.2: {}\n\n---\n`
    const built = (locked, host = HOST_11) => buildResult({ lockfile: locked, manifest: UNPATCHED, workspace: PATCHED_IN_YAML, host })
    assert.equal((await built(`${env()}${flatLockfile()}`)).vfs.readText('/node_modules/p/index.js'), 'module.exports = 2\n')
    await assert.rejects(built(env()), /^DeptreeError: pnpm-lock\.yaml: it holds the env document pnpm 11 writes alone, not the project's lockfile, which a frozen install cannot do without$/u)
    await assert.rejects(built(env(), HOST), /^DeptreeError: pnpm-lock\.yaml: it holds the env document pnpm 11 writes alone/u)
    await assert.rejects(built(`${env()}${flatLockfile()}`, HOST), /^DeptreeError: env: the env document pnpm 11 writes is not supported$/u)
    const config = '    configDependencies:\n      c:\n        specifier: 2.0.0\n        version: 2.0.0\n'
    await assert.rejects(built(`${env(config)}${flatLockfile()}`), /^DeptreeError: env\.importers\["\."\]\.configDependencies: config dependencies are not supported$/u)
  })

  it('reads no setting of the package.json', async () => {
    await assert.rejects(buildResult({ lockfile: flatLockfile(), host: HOST_11 }), /^DeptreeError: patches\["patches\/p\.patch"\]: no patchedDependencies setting names this patch$/u)
  })

  it('refuses a pnpm it is not built for', async () => {
    await assert.rejects(buildPnpmTree({ lockfile: flatLockfile(), manifests: { '.': root() }, host: { ...HOST, pnpm: '13.0.0' } }), /^DeptreeError: host\.pnpm: pnpm "13\.0\.0" is not supported: only pnpm 9, 10, 11 and 12 are$/u)
  })
})

describe('buildPnpmTree for pnpm 12', () => {
  const env = (version = '12.8.1') => `---\nlockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    configDependencies: {}\n    packageManagerDependencies:\n      pnpm:\n        specifier: ${version}\n        version: ${version}\n\npackages:\n\n  pnpm@${version}:\n    resolution: {integrity: ${I.p}}\n\nsnapshots:\n\n  pnpm@${version}: {}\n\n---\n`
  const built = ({ locked = flatLockfile(), fields = {}, workspace = PATCHED_IN_YAML, host = HOST_12 } = {}) => buildResult({ lockfile: locked, manifest: root({ pnpm: { patchedDependencies: undefined }, ...fields }), workspace, host })
  const pinned = { packageManager: 'pnpm@12.8.1' }

  // pnpm 12 records a pin of pnpm 12 in the lockfile's env document, and a
  // frozen install fails where it is not there, or is another pnpm.
  it('holds the pnpm the root pins to the lockfile\'s record of it', async () => {
    stubRegistry(TARBALLS)
    assert.equal((await built({ locked: `${env()}${flatLockfile()}`, fields: pinned })).vfs.readText('/node_modules/p/index.js'), 'module.exports = 2\n')
    await assert.rejects(built({ fields: pinned }), /^DeptreeError: env\.importers\["\."\]\.packageManagerDependencies: the lockfile records no pnpm for manifests\["\."\]\.packageManager, which a frozen install of pnpm 12 fails on$/u)
    await assert.rejects(built({ locked: `${env('12.8.0')}${flatLockfile()}`, fields: pinned }), /^DeptreeError: env\.importers\["\."\]\.packageManagerDependencies\.pnpm: "pnpm@12\.8\.0" is not pnpm 12\.8\.1, which pnpm 12 would run or fail on$/u)
    const ranged = { devEngines: { packageManager: { name: 'pnpm', version: '^12.0.0' } } }
    assert.equal((await built({ locked: `${env()}${flatLockfile()}`, fields: ranged })).vfs.readText('/node_modules/p/index.js'), 'module.exports = 2\n')
    await assert.rejects(built({ fields: { devEngines: { packageManager: { name: 'pnpm', version: '^11.0.0', onFail: 'error' } } } }), /^DeptreeError: manifests\["\."\]\.devEngines\.packageManager: pnpm 12\.8\.1 is not in "\^11\.0\.0", which pnpm 12 switches from or refuses$/u)
    await assert.rejects(built({ fields: { devEngines: { packageManager: [{ name: 'yarn' }] } } }), /^DeptreeError: manifests\["\."\]\.devEngines\.packageManager: the project is installed by "yarn", which pnpm 12 refuses$/u)
    await built({ fields: { devEngines: { packageManager: [{ name: 'yarn' }, { name: 'npm' }] } } })
  })

  // pnpm 12 fails on a setting it does not know where the root pins the
  // pnpm that runs, and drops it otherwise.
  it('refuses a setting pnpm 12 does not know where the root pins it', async () => {
    stubRegistry(TARBALLS)
    for (const setting of ['shamefullyFlatten: false\n', 'alwaysAuth: true\n', 'foo-bar: 1\n']) {
      await assert.rejects(built({ locked: `${env()}${flatLockfile()}`, fields: pinned, workspace: `${PATCHED_IN_YAML}${setting}` }), /^DeptreeError: pnpm-workspace\.yaml: [\w-]+: pnpm 12 does not know it, and fails on it where the root package\.json pins the pnpm that runs$/u, setting)
      await built({ workspace: `${PATCHED_IN_YAML}${setting}` })
    }
    await built({ locked: `${env()}${flatLockfile()}`, fields: pinned, workspace: `${PATCHED_IN_YAML}node-linker: isolated\nautoDedupe: true\ncargo:\n  enabled: false\n` })
    await assert.rejects(built({ workspace: `${PATCHED_IN_YAML}cargo:\n  enabled: true\n` }), /^DeptreeError: pnpm-workspace\.yaml: cargo\.enabled: true is not supported: an install of Cargo or Python packages beside the tree is not supported$/u)
    await assert.rejects(built({ workspace: `${PATCHED_IN_YAML}hoistPattern: '*'\n` }), /^DeptreeError: pnpm-workspace\.yaml: hoistPattern: expected a list of strings, found "\*"$/u)
  })

  // pnpm 11 installs the root alone.
  it('takes the root package.json\'s workspaces where there is no pnpm-workspace.yaml', async () => {
    stubRegistry(TARBALLS)
    const dependency = `    dependencies:\n      b:\n        specifier: 1.0.0\n        version: 1.0.0\n`
    const locked = `lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n\n  packages/x:\n${dependency}\npackages:\n\n  b@1.0.0:\n    resolution: {integrity: ${I.b}}\n\nsnapshots:\n\n  b@1.0.0: {}\n`
    const manifests = { '.': JSON.stringify({ name: 'root', workspaces: ['packages/*', ''] }), 'packages/x': JSON.stringify({ name: 'x', dependencies: { b: '1.0.0' } }) }
    const { vfs } = await buildPnpmTree({ lockfile: locked, manifests, host: HOST_12 })
    assert.equal(vfs.realpath('/packages/x/node_modules/b'), '/node_modules/.pnpm/b@1.0.0/node_modules/b')
    assert.equal(vfs.realpath('/node_modules/.pnpm/node_modules/x'), '/packages/x')
    const notSet = /^DeptreeError: importers\["packages\/x"\]: pnpm-workspace\.yaml's packages are not set, so pnpm would not install it as a project$/u
    await assert.rejects(buildPnpmTree({ lockfile: locked, manifests, workspace: '', host: HOST_12 }), notSet)
    await assert.rejects(buildPnpmTree({ lockfile: locked, manifests, host: HOST_11 }), notSet)
  })

  it('refuses a pnpm 12 before 12.8.1', async () => {
    await assert.rejects(built({ host: { ...HOST, pnpm: '12.8.0' } }), /^DeptreeError: host\.pnpm: pnpm "12\.8\.0" is not supported: pnpm 12 is from 12\.8\.1 on$/u)
  })
})

describe('buildPnpmTree with a workspace', () => {
  const manifests = (x) => ({ '.': root(), 'packages/x': JSON.stringify(x) })
  const buildTwo = (x, options) => build({ lockfile: TWO, manifests: manifests(x), workspace: WORKSPACE, ...options })

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

  // e is the root's devDependency, and packages/x's dependency: no project
  // installed with --prod would leave it out.
  it('lists as dev only what no project\'s dependencies reach', async () => {
    stubRegistry(TARBALLS)
    const e = TWO.replace('      b:\n        specifier: 1.0.0\n        version: 1.0.0\n', '      e:\n        specifier: 1.0.0\n        version: 1.0.0\n')
    const { installed } = await buildResult({ lockfile: e, manifests: manifests({ name: '@w/x', dependencies: { e: '1.0.0' } }), workspace: WORKSPACE })
    assert.equal(installed.find(({ name }) => name === 'e').dev, false)
  })

  it('hoists a project over a package of its name', async () => {
    stubRegistry(TARBALLS)
    const vfs = await buildTwo({ name: 'd', dependencies: { b: '1.0.0' } })
    assert.equal(vfs.readlink('/node_modules/.pnpm/node_modules/d'), '../../../packages/x')
  })

  it('refuses a project not up to date with its package.json, or two projects of one name', async () => {
    await assert.rejects(buildTwo({ name: 'x', dependencies: { b: '^1.0.0' } }), /^DeptreeError: manifests\["packages\/x"\]: the lockfile is not up to date/u)
    const three = TWO.replace('importers:\n', 'importers:\n\n  packages/y: {}\n')
    await assert.rejects(buildResult({ lockfile: three, manifests: { ...manifests({ name: 'x', dependencies: { b: '1.0.0' } }), 'packages/y': '{"name":"x"}' }, workspace: WORKSPACE }), /^DeptreeError: manifests\["packages\/y"\]\.name: "x" is the name of another project too$/u)
  })

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

  it('holds a project findPnpmProjects finds that the lockfile has no importer for to an empty one', async () => {
    stubRegistry(TARBALLS)
    const x = JSON.stringify({ name: 'x', dependencies: { b: '1.0.0' } })
    const project = createVfs({ 'package.json': root(), 'pnpm-workspace.yaml': WORKSPACE, 'packages/x/package.json': x, 'patches/p.patch': PATCH })
    assert.deepEqual(findPnpmProjects({ project, host: HOST }), ['.', 'packages/x'])
    project.mkdir('/packages/y')
    const given = (y) => {
      project.writeFile('/packages/y/package.json', JSON.stringify(y))
      const ids = findPnpmProjects({ project, host: HOST })
      assert.deepEqual(ids, ['.', 'packages/x', 'packages/y'])
      return Object.fromEntries(ids.map((id) => [id, project.readText(`/${id === '.' ? '' : `${id}/`}package.json`)]))
    }
    const options = { lockfile: TWO, workspace: WORKSPACE }
    await assert.rejects(buildResult({ ...options, manifests: given({ name: 'y', dependencies: { b: '1.0.0' } }) }), /^DeptreeError: manifests\["packages\/y"\]: the lockfile is not up to date with this package\.json, which a frozen install refuses: the specifiers differ/u)
    const { vfs: tree, stats } = await buildResult({ ...options, manifests: given({ name: 'y' }) })
    assert.equal(tree.readlink('/node_modules/.pnpm/node_modules/y'), '../../../packages/y')
    assert.equal(stats.projects, 3)
  })

  // As the lockfile's own importers are keyed: a path pnpm could find the
  // project by, which a glob may take all the same.
  it('refuses a project the lockfile has no importer for by a path not in normal form', async () => {
    const workspace = 'packages:\n  - packages/**\n  - \'*\'\n'
    for (const id of ['packages//y', './packages/y', 'packages/y/', 'packages/./y', 'packages/x/../y', '/packages/y', 'packages/y\\z', '', 'C:y']) {
      const given = { '.': root(), 'packages/x': JSON.stringify({ name: 'x', dependencies: { b: '1.0.0' } }), [id]: '{"name":"y"}' }
      await assert.rejects(buildResult({ lockfile: TWO, manifests: given, workspace }), /^DeptreeError: manifests\[".*"\]: expected a directory under the lockfile's, by its path from there in normal form, as a lockfile can key an importer$/u, JSON.stringify(id))
    }
  })

  it('finds the projects as it reads pnpm-workspace.yaml, and refuses what buildPnpmTree refuses of it', () => {
    const projectWith = (files) => createVfs({ 'package.json': '{}', 'packages/x/package.json': '{}', ...files })
    for (const workspace of [undefined, '', '# none\n', 'hoist: true\n', 'packages: []\n']) {
      assert.deepEqual(findPnpmProjects({ project: projectWith(workspace === undefined ? {} : { 'pnpm-workspace.yaml': workspace }), host: HOST }), ['.'], JSON.stringify(workspace))
    }
    const project = projectWith({ 'pnpm-workspace.yaml': WORKSPACE })
    assert.deepEqual(findPnpmProjects({ project, host: { pnpm: '11.28.2' } }), ['.', 'packages/x'])
    const refused = [
      [{ 'pnpm-workspace.yaml': '- packages/*\n' }, /^DeptreeError: pnpm-workspace\.yaml: expected a mapping$/u],
      [{ 'pnpm-workspace.yaml': 'packages: packages/*\n' }, /^DeptreeError: pnpm-workspace\.yaml: packages: expected a list of non-empty strings/u],
      [{ 'pnpm-workspace.yaml': "packages:\n  - 'packages/{x,y}'\n" }, /^DeptreeError: pnpm-workspace\.yaml: packages: "packages\/\{x,y\}" is not supported/u],
      [{ 'pnpm-workspace.yaml': new Uint8Array([0xff]) }, /^DeptreeError: "pnpm-workspace\.yaml" is not UTF-8$/u],
      [{ 'pnpm-workspace.yaml': { type: 'directory' } }, /^DeptreeError: "pnpm-workspace\.yaml" is a directory, not a file$/u],
      [{ 'pnpm-workspace.yaml': 'packages:\n    - packages/*\n  - other/*\n' }, /^DeptreeError: pnpm-workspace\.yaml: bad indentation at line 3$/u],
    ]
    for (const [files, pattern] of refused) assert.throws(() => findPnpmProjects({ project: projectWith(files), host: HOST }), pattern, JSON.stringify(files))
    const wrong = [
      [{ host: { pnpm: '9.14.4' } }, /^DeptreeError: host\.pnpm: pnpm "9\.14\.4" is not supported: pnpm 9 is from 9\.15\.0 on$/u],
      [{ host: { pnpm: '' } }, /^TypeError: host\.pnpm must be a non-empty string, or left out$/u],
      [{ host: null }, /^TypeError: host must be an object, or left out$/u],
      [{ host: {} }, /^TypeError: host\.pnpm must be given where the root package\.json's packageManager pins no pnpm$/u],
      [{ project: { readdir: () => [], lstat: () => ({}), stat: () => ({}) } }, /^TypeError: project must be a Vfs, or have its readdir, lstat, stat and readFile$/u],
    ]
    for (const [options, pattern] of wrong) assert.throws(() => findPnpmProjects({ project, host: HOST, ...options }), pattern, JSON.stringify(options))
    assert.throws(() => findPnpmProjects(), /^TypeError: project must be a Vfs/u)
  })

  // pnpm 9 finds projects everywhere for a pnpm-workspace.yaml that sets
  // nothing, fails on one that sets anything else and no packages, and
  // refuses no other name but pnpm-workspace.yml, as 9.15.9 does.
  it('finds the projects as pnpm 9 does', () => {
    const projectWith = (files) => createVfs({ 'package.json': '{}', 'packages/x/package.json': '{}', ...files })
    const find9 = (files) => findPnpmProjects({ project: projectWith(files), host: HOST_9 })
    for (const workspace of ['', '# none\n', '{}\n']) assert.deepEqual(find9({ 'pnpm-workspace.yaml': workspace }), ['.', 'packages/x'], JSON.stringify(workspace))
    assert.deepEqual(find9({}), ['.'])
    assert.deepEqual(find9({ 'pnpm-workspace.yaml': 'packages: []\n' }), ['.'])
    assert.throws(() => find9({ 'pnpm-workspace.yaml': 'hoist: true\n' }), /^DeptreeError: pnpm-workspace\.yaml: packages: pnpm 9 fails on a workspace manifest that sets anything and no packages$/u)
    assert.deepEqual(find9({ '.pnpm-workspaces.yaml': WORKSPACE }), ['.'])
    assert.throws(() => find9({ 'pnpm-workspace.yml': WORKSPACE }), /^DeptreeError: "pnpm-workspace\.yml": pnpm refuses a workspace manifest not named pnpm-workspace\.yaml$/u)
  })

  // pnpm finds pnpm-workspace.yaml under other names too, and refuses it
  // there, where it finds none of its own name first.
  it('refuses a workspace manifest pnpm would refuse by its name', () => {
    for (const name of ['pnpm-workspace.yml', '.pnpm-workspaces.yaml']) {
      assert.throws(() => findPnpmProjects({ project: createVfs({ 'package.json': '{}', [name]: WORKSPACE }), host: HOST }), new RegExp(`^DeptreeError: "${name.replaceAll('.', '\\.')}": pnpm refuses a workspace manifest not named pnpm-workspace\\.yaml$`, 'u'))
    }
    assert.deepEqual(findPnpmProjects({ project: createVfs({ 'package.json': '{}', 'pnpm-workspace.yaml': WORKSPACE, 'pnpm-workspace.yml': '', 'packages/x/package.json': '{}' }), host: HOST }), ['.', 'packages/x'])
  })

  // pnpm 11 leaves out what a `!` glob takes, a name with a leading dot
  // among it, and pnpm 10 does not.
  it('finds the projects as the pnpm the root package.json pins does, where host.pnpm is left out', () => {
    const project = (packageManager) => createVfs({ 'package.json': JSON.stringify({ packageManager }), 'pnpm-workspace.yaml': "packages:\n  - '.a/*'\n  - '!**/b'\n", '.a/b/package.json': '{}' })
    assert.deepEqual(findPnpmProjects({ project: project('pnpm@10.33.4') }), ['.', '.a/b'])
    assert.deepEqual(findPnpmProjects({ project: project('pnpm@11.28.2+sha512.abc') }), ['.'])
    assert.deepEqual(findPnpmProjects({ project: project('pnpm@11.28.2'), host: HOST }), ['.', '.a/b'])
    for (const packageManager of [undefined, 'yarn@1.22.22', 'pnpm@11', 'pnpm@^11.0.0']) {
      assert.throws(() => findPnpmProjects({ project: project(packageManager) }), /^TypeError: host\.pnpm must be given where the root package\.json's packageManager pins no pnpm$/u, packageManager)
    }
    // Read for nothing else: with host.pnpm given, it is not parsed.
    for (const [data, pattern] of [['{', /^DeptreeError: manifests\["\."\]: not JSON/u], [new Uint8Array([0xff]), /^DeptreeError: manifests\["\."\]: "package\.json" is not UTF-8$/u]]) {
      const unread = createVfs({ 'package.json': data, 'pnpm-workspace.yaml': WORKSPACE, 'packages/x/package.json': '{}' })
      assert.deepEqual(findPnpmProjects({ project: unread, host: HOST }), ['.', 'packages/x'])
      assert.throws(() => findPnpmProjects({ project: unread }), pattern)
    }
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

describe('buildPnpmTree into a given Vfs', () => {
  const x = JSON.stringify({ name: 'x', dependencies: { b: '1.0.0' } })
  const sources = { 'package.json': root(), 'pnpm-lock.yaml': TWO, 'packages/x/package.json': x, 'packages/x/index.js': 'x' }
  const into = (vfs, options) => buildResult({ lockfile: TWO, manifests: { '.': root(), 'packages/x': x }, workspace: WORKSPACE, vfs, ...options })
  const both = (files) => {
    const vfs = createVfs(files)
    return { project: vfs, vfs }
  }

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

  const app = tarball('app', '1.0.0', { 'index.js': 'app' }, { manifest: { dependencies: { foo: '^1.0.0' } } })

  describe('with an override to a directory', () => {
    const linked = async (spec, specifier, { v11 = false, appFoo = 'link:vendor/foo' } = {}) => {
      const locked = small(dep('app') + dep('foo', 'link:vendor/foo', specifier), `${entry(await app)}\n`, `  app@1.0.0:\n    dependencies:\n      foo: ${appFoo}\n`, `  foo: ${spec}\n`)
      return { overrides: `overrides:\n  foo: ${spec}\n`, lockfile: locked, manifest: JSON.stringify({ name: 'root', dependencies: { app: '1.0.0', foo: '^1.0.0' }, ...(v11 ? {} : { pnpm: { overrides: { foo: spec } } }) }) }
    }
    const vendored = { 'vendor/foo/package.json': '{"name":"foo","version":"1.5.0","bin":{"foo":"cli.js"}}', 'vendor/foo/cli.js': '#!/usr/bin/env node\n' }
    const buildLinked = ({ lockfile: locked, manifest, overrides }, { host = HOST, ...options } = {}) => buildPnpmTree({ lockfile: locked, manifests: { '.': manifest }, workspace: host === HOST ? undefined : overrides, host, ...options })

    it('links it where the project holds it, a path alone or by link:', async () => {
      stubRegistry([await app])
      for (const [spec, specifier, host] of [['./vendor/foo', './vendor/foo', HOST], ['link:./vendor/foo', 'link:vendor/foo', HOST], ['./vendor/foo', './vendor/foo', HOST_11]]) {
        const given = await linked(spec, specifier, { v11: host !== HOST })
        const { vfs } = await buildLinked(given, { ...both({ 'package.json': given.manifest, ...vendored }), host })
        assert.equal(vfs.realpath('/node_modules/foo'), '/vendor/foo', spec)
        assert.equal(vfs.realpath('/node_modules/.pnpm/app@1.0.0/node_modules/foo'), '/vendor/foo', spec)
        assert.equal(vfs.stat('/vendor/foo/cli.js').mode, 0o644, 'nothing outside node_modules is written')
      }
    })

    // What the tree is mounted into is not read: the project is.
    it('refuses it without a project, or where the project does not hold it', async () => {
      stubRegistry([await app])
      const given = await linked('./vendor/foo', './vendor/foo')
      const unread = /^DeptreeError: overrides\["foo"\]: an override to a directory, "vendor\/foo", is read only from a project given$/u
      await assert.rejects(buildLinked(given), unread)
      await assert.rejects(buildLinked(given, { vfs: createVfs({ 'package.json': given.manifest, ...vendored }) }), unread)
      await assert.rejects(buildLinked(given, { project: createVfs({ 'package.json': given.manifest, 'vendor/foo/cli.js': '' }) }), /^DeptreeError: overrides\["foo"\]: "vendor\/foo" holds no package\.json in the project given$/u)
      await assert.rejects(buildLinked(await linked('file:./vendor/foo.tgz', 'file:vendor/foo.tgz'), { project: createVfs({ ...vendored, 'vendor/foo.tgz': '' }) }), /^DeptreeError: overrides\["foo"\]: "vendor\/foo\.tgz" is a file in the project given, and an override to a tarball is not supported$/u)
      const notUtf8 = createVfs({ 'package.json': given.manifest, ...vendored, 'vendor/foo/package.json': new Uint8Array([0xff]) })
      await assert.rejects(buildLinked(given, { project: notUtf8 }), /^DeptreeError: overrides\["foo"\]: "vendor\/foo\/package\.json" is not UTF-8$/u)
    })

    it('reads its package.json as pnpm does, one byte order mark dropped', async () => {
      stubRegistry([await app])
      const given = await linked('./vendor/foo', './vendor/foo')
      const marked = (count) => ({ 'package.json': given.manifest, ...vendored, 'vendor/foo/package.json': `${'\uFEFF'.repeat(count)}${vendored['vendor/foo/package.json']}` })
      assert.equal((await buildLinked(given, both(marked(1)))).vfs.realpath('/node_modules/foo'), '/vendor/foo')
      await assert.rejects(buildLinked(given, both(marked(2))), /^DeptreeError: overrides\["foo"\]: not JSON/u)
    })

    // pnpm writes a package's dependency overridden to a directory as a link
    // to it, and links whatever the lockfile says.
    it('refuses a package\'s link to another directory than its override names', async () => {
      stubRegistry([await app])
      const elsewhere = { ...vendored, 'vendor/bar/package.json': '{"name":"foo","version":"1.5.0"}' }
      const given = await linked('./vendor/foo', './vendor/foo', { appFoo: 'link:vendor/bar' })
      await assert.rejects(buildLinked(given, { project: createVfs({ 'package.json': given.manifest, ...elsewhere }) }), /^DeptreeError: "app@1\.0\.0": the lockfile gives it "foo" as "link:vendor\/bar", and its package\.json, overridden, names "vendor\/foo"$/u)
    })
  })

  // pnpm installs a directory a `file:` override names as a package, of
  // the files npm-packlist picks, hardlinked from it.
  describe('with a file: override', () => {
    const DIRECTORY = '  foo@file:vendor/foo:\n    resolution: {directory: vendor/foo, type: directory}\n'
    const copied = async ({ hasBin = true, override = true } = {}) => small(dep('app') + dep('foo', 'file:vendor/foo'), `${entry(await app)}\n${DIRECTORY}${hasBin ? '    hasBin: true\n' : ''}`, '  app@1.0.0:\n    dependencies:\n      foo: file:vendor/foo\n\n  foo@file:vendor/foo: {}\n', override ? '  foo: file:./vendor/foo\n' : '')
    const rootWith = (fields) => JSON.stringify({ name: 'root', dependencies: { app: '1.0.0', foo: '^1.0.0' }, ...fields })
    const v10 = rootWith({ pnpm: { overrides: { foo: 'file:./vendor/foo' } } })
    const vendored = { 'vendor/foo/package.json': '{"name":"foo","version":"1.5.0","bin":{"foo":"cli.js"}}', 'vendor/foo/cli.js': '#!/usr/bin/env node\r\nrun()\n', 'vendor/foo/index.js': 'foo', 'vendor/foo/.npmrc': 'a=b\n' }
    const FOO = '/node_modules/.pnpm/foo@file+vendor+foo/node_modules/foo'

    it('installs the files npm-packlist picks, as pnpm 10 and 11 do', async () => {
      stubRegistry([await app])
      for (const [host, manifest, workspace] of [[HOST, v10, undefined], [HOST_11, rootWith(), 'overrides:\n  foo: file:./vendor/foo\n']]) {
        const { vfs, stats } = await buildPnpmTree({ lockfile: await copied(), manifests: { '.': manifest }, workspace, host, ...both({ 'package.json': manifest, ...vendored }) })
        assert.deepEqual(vfs.readdir(FOO), ['cli.js', 'index.js', 'package.json'], host.pnpm)
        assert.equal(vfs.realpath('/node_modules/foo'), FOO)
        assert.equal(vfs.realpath('/node_modules/.pnpm/app@1.0.0/node_modules/foo'), FOO)
        assert.equal(vfs.readText(`${FOO}/cli.js`), '#!/usr/bin/env node\nrun()\n')
        assert.equal(vfs.stat(`${FOO}/cli.js`).mode, 0o755)
        assert.equal(vfs.stat('/vendor/foo/cli.js').mode, 0o644, 'nothing outside node_modules is written')
        assert.equal(stats.tarballs, 1)
      }
    })

    // As ExodusOSS/bytes has pnpm install its own directory: `files` beside
    // a .gitignore at the top, which none reads then, and a browser map.
    // Real installs of each keep these files.
    it('installs the files package.json lists, as each pnpm does', async () => {
      stubRegistry([await app])
      const fields = { name: 'foo', version: '1.5.0', bin: { foo: 'cli.js' }, browser: { './index.js': './browser.js' }, files: ['/index.js', '/lib/', '!/lib/*.test.js'] }
      const listed = { ...vendored, 'vendor/foo/package.json': JSON.stringify(fields), 'vendor/foo/lib/a.js': 'a', 'vendor/foo/lib/a.test.js': 't', 'vendor/foo/test/x.js': 'x', 'vendor/foo/README.md': 'r', 'vendor/foo/.gitignore': 'lib\n' }
      const later = 'overrides:\n  foo: file:./vendor/foo\n'
      for (const [host, manifest, workspace] of [[HOST_9, v10], [HOST, v10], [HOST_11, rootWith(), later], [HOST_12, rootWith(), later]]) {
        const { vfs } = await buildPnpmTree({ lockfile: await copied(), manifests: { '.': manifest }, workspace, host, project: createVfs({ 'package.json': manifest, ...listed }) })
        assert.deepEqual(vfs.readdir(FOO), ['README.md', 'cli.js', 'index.js', 'lib', 'package.json'], host.pnpm)
        assert.deepEqual(vfs.readdir(`${FOO}/lib`), ['a.js'], host.pnpm)
      }
    })

    // As real installs of a checkout under umask 002 have it: each file keeps
    // its mode, and a bin is made 0o755 by pnpm 9 and 10, 0o111 added by
    // pnpm 11 and 12.
    it('keeps a checkout\'s 664 and 775, and makes a bin executable as each pnpm does', async () => {
      stubRegistry([await app])
      const later = 'overrides:\n  foo: file:./vendor/foo\n'
      const [LF, CRLF] = ['#!/usr/bin/env node\nrun()\n', '#!/usr/bin/env node\r\nrun()\n']
      for (const [host, manifest, workspace, mode, text] of [[HOST_9, v10, undefined, 0o755, LF], [HOST, v10, undefined, 0o755, LF], [HOST_11, rootWith(), later, 0o775, LF], [HOST_12, rootWith(), later, 0o775, CRLF]]) {
        const project = createVfs({ 'package.json': manifest, ...vendored, 'vendor/foo/tool.sh': '#!/bin/sh\n' })
        for (const path of ['package.json', 'cli.js', 'index.js']) project.chmod(`/vendor/foo/${path}`, 0o664)
        project.chmod('/vendor/foo/tool.sh', 0o775)
        const { vfs } = await buildPnpmTree({ lockfile: await copied(), manifests: { '.': manifest }, workspace, host, project })
        assert.deepEqual(['cli.js', 'index.js', 'package.json', 'tool.sh'].map((path) => vfs.stat(`${FOO}/${path}`).mode), [mode, 0o664, 0o664, 0o775], host.pnpm)
        assert.equal(vfs.readText(`${FOO}/cli.js`), text, host.pnpm)
      }
    })

    it('lists it by its directory, with no version or integrity, as the lockfile has none', async () => {
      stubRegistry([await app])
      const { installed } = await buildPnpmTree({ lockfile: await copied(), manifests: { '.': v10 }, host: HOST, ...both({ 'package.json': v10, ...vendored }) })
      assert.deepEqual(installed.find(({ name }) => name === 'foo'), {
        path: FOO.slice(1), key: 'foo@file:vendor/foo', name: 'foo', version: undefined, integrity: undefined, directory: 'vendor/foo', dev: false, optional: false, patch: undefined,
      })
    })

    // pnpm 10 records an empty list of bundled dependencies, and pnpm 11
    // leaves it out; npm-packlist bundles none by it.
    it('takes an empty list of bundled dependencies', async () => {
      stubRegistry([await app])
      const listed = { ...vendored, 'vendor/foo/package.json': '{"name":"foo","version":"1.5.0","bin":{"foo":"cli.js"},"bundleDependencies":[]}' }
      const lockfile10 = (await copied()).replace('    hasBin: true\n', '    bundledDependencies: []\n    hasBin: true\n')
      for (const [host, manifest, workspace, written] of [[HOST, v10, undefined, lockfile10], [HOST_11, rootWith(), 'overrides:\n  foo: file:./vendor/foo\n', await copied()]]) {
        const { vfs } = await buildPnpmTree({ lockfile: written, manifests: { '.': manifest }, workspace, host, project: createVfs({ 'package.json': manifest, ...listed }) })
        assert.deepEqual(vfs.readdir(FOO), ['cli.js', 'index.js', 'package.json'], host.pnpm)
      }
    })

    // foo under two peers, p@1 beside the root and p@2 beside app2: pnpm
    // links foo's `tool` into the root's .bin, and zz's over it into app2's.
    const twoSnapshots = async (fields, { host = HOST, workspace, files = {}, mode } = {}) => {
      const bins = await Promise.all([
        tarball('app2', '1.0.0', {}, { manifest: { dependencies: { foo: '^1.0.0', zz: '1.0.0', p: '2.0.0' } } }),
        tarball('p', '1.0.0'),
        tarball('p', '2.0.0'),
        tarball('zz', '1.0.0', { 'z.js': '#!z\n' }, { manifest: { bin: { tool: 'z.js' } } }),
      ])
      stubRegistry(bins)
      const manifest = rootWith({ dependencies: { app2: '1.0.0', foo: '^1.0.0', p: '1.0.0' }, ...host.pnpm.startsWith('10.') ? { pnpm: { overrides: { foo: 'file:./vendor/foo' } } } : {} })
      const foo = { name: 'foo', version: '1.5.0', peerDependencies: { p: '*' }, bin: { tool: 'cli.js' }, ...fields }
      const source = { 'vendor/foo/package.json': JSON.stringify(foo), 'vendor/foo/cli.js': '#!/usr/bin/env node\r\nrun()\n', ...files }
      const project = createVfs({ 'package.json': manifest, ...source })
      if (mode !== undefined) project.chmod('/vendor/foo/cli.js', mode)
      const { vfs } = await buildPnpmTree({ lockfile: twoPeers(bins), manifests: { '.': manifest }, workspace, host, project })
      const cli = (peer) => `/node_modules/.pnpm/foo@file+vendor+foo_p@${peer}/node_modules/foo/cli.js`
      return [1, 2].map((major) => [vfs.stat(cli(`${major}.0.0`)).mode, vfs.readText(cli(`${major}.0.0`))])
    }
    const twoPeers = (bins) => small(dep('app2') + dep('foo', 'file:vendor/foo(p@1.0.0)', 'file:vendor/foo') + dep('p'), `${entry(bins[0])}\n${DIRECTORY}    hasBin: true\n    peerDependencies:\n      p: '*'\n\n${entry(bins[1])}\n${entry(bins[2])}\n${entry(bins[3], '    hasBin: true\n')}`, `  app2@1.0.0:
    dependencies:
      foo: file:vendor/foo(p@2.0.0)
      p: 2.0.0
      zz: 1.0.0

  foo@file:vendor/foo(p@1.0.0):
    dependencies:
      p: 1.0.0

  foo@file:vendor/foo(p@2.0.0):
    dependencies:
      p: 2.0.0

  p@1.0.0: {}

  p@2.0.0: {}

  zz@1.0.0: {}
`, '  foo: file:./vendor/foo\n')

    // fixBin's chmod reaches foo's file in every snapshot, which are
    // hardlinks of it, and its CRLF rewrite the one it is run in alone.
    it('makes a bin executable in every snapshot, and rewrites it in the one linking fixes it in', async () => {
      assert.deepEqual(await twoSnapshots(), [[0o755, '#!/usr/bin/env node\nrun()\n'], [0o755, '#!/usr/bin/env node\r\nrun()\n']])
      const v11 = { host: HOST_11, workspace: 'overrides:\n  foo: file:./vendor/foo\n', mode: 0o664 }
      assert.deepEqual(await twoSnapshots({}, v11), [[0o775, '#!/usr/bin/env node\nrun()\n'], [0o775, '#!/usr/bin/env node\r\nrun()\n']])
      assert.deepEqual(await twoSnapshots({}, { mode: 0o664 }), [[0o755, '#!/usr/bin/env node\nrun()\n'], [0o755, '#!/usr/bin/env node\r\nrun()\n']])
    })

    // Where pnpm builds the package — an install script, or a binding.gyp
    // that pnpm 11 passes over with gypfile false — or, with pnpm 11,
    // packageImportMethod asks for copies, each snapshot has its own.
    it('makes a bin executable in its own snapshot alone where each has a copy of its own', async () => {
      const own = [[0o755, '#!/usr/bin/env node\nrun()\n'], [0o644, '#!/usr/bin/env node\r\nrun()\n']]
      const shared = [[0o755, '#!/usr/bin/env node\nrun()\n'], [0o755, '#!/usr/bin/env node\r\nrun()\n']]
      const v11 = { host: HOST_11, workspace: 'overrides:\n  foo: file:./vendor/foo\n' }
      assert.deepEqual(await twoSnapshots({ scripts: { postinstall: 'x' } }), own)
      assert.deepEqual(await twoSnapshots({ scripts: { postinstall: 'x' } }, v11), own)
      const gyp = { files: { 'vendor/foo/binding.gyp': '{}' } }
      assert.deepEqual(await twoSnapshots({ gypfile: false }, gyp), own)
      assert.deepEqual(await twoSnapshots({ gypfile: false }, { ...v11, ...gyp }), shared)
      assert.deepEqual(await twoSnapshots({}, { ...v11, workspace: `${v11.workspace}packageImportMethod: copy\n` }), own)
      assert.deepEqual(await twoSnapshots({}, { ...v11, workspace: `${v11.workspace}packageImportMethod: hardlink\n` }), shared)
      assert.deepEqual(await twoSnapshots({}, { workspace: 'packageImportMethod: copy\n' }), shared)
    })

    it('refuses a directory the lockfile is not up to date with for pnpm 12', async () => {
      stubRegistry([await app])
      const options = { lockfile: await copied(), manifests: { '.': rootWith() }, workspace: 'overrides:\n  foo: file:./vendor/foo\n', host: HOST_12 }
      const changed = (fields) => createVfs({ 'package.json': rootWith(), ...vendored, 'vendor/foo/package.json': JSON.stringify({ name: 'foo', version: '1.5.0', bin: { foo: 'cli.js' }, ...fields }) })
      await buildPnpmTree({ ...options, project: changed({}) })
      await assert.rejects(buildPnpmTree({ ...options, project: changed({ peerDependencies: { p: '*' } }) }), /^DeptreeError: "foo@file:vendor\/foo": the lockfile is not up to date with its package\.json, which a frozen install of pnpm 12 refuses: its peerDependencies are not the lockfile's: "p" is "\*" in its package\.json and nothing in the lockfile$/u)
    })

    it('refuses it without a project, or as the lockfile does not have it', async () => {
      stubRegistry([await app])
      await assert.rejects(buildPnpmTree({ lockfile: await copied(), manifests: { '.': v10 }, host: HOST }), /^DeptreeError: overrides\["foo"\]: an override to a directory, "vendor\/foo", is read only from a project given$/u)
      await assert.rejects(buildPnpmTree({ lockfile: await copied({ hasBin: false }), manifests: { '.': v10 }, host: HOST, project: createVfs({ 'package.json': v10, ...vendored }) }), /^DeptreeError: "foo@file:vendor\/foo": package\.json has bins, and the lockfile says it has none$/u)
      const other = { ...vendored, 'vendor/foo/package.json': '{"name":"bar","version":"1.5.0","bin":{"foo":"cli.js"}}' }
      await assert.rejects(buildPnpmTree({ lockfile: await copied(), manifests: { '.': v10 }, host: HOST, project: createVfs({ 'package.json': v10, ...other }) }), /^DeptreeError: "foo@file:vendor\/foo": its package\.json is for "bar"$/u)
    })

    it('refuses a dependency on a directory no file: override names', async () => {
      stubRegistry([await app])
      const direct = rootWith({ dependencies: { app: '1.0.0', foo: 'file:vendor/foo' } })
      await assert.rejects(buildPnpmTree({ lockfile: await copied({ override: false }), manifests: { '.': direct }, host: HOST, project: createVfs({ 'package.json': direct, ...vendored }) }), /^DeptreeError: "foo@file:vendor\/foo": a dependency on a local directory is supported only where a file: override names it$/u)
    })

    // pnpm 9, 10 and 11 write the lockfile's own directory, which the root
    // project's `file:.` names, as an empty path, which pnpm 12 refuses as
    // broken; all of them take it written as `.`, and pnpm 11 and 12 name
    // its directory with a hash then. Its snapshot depends on what the root does.
    it('installs the lockfile\'s own directory as pnpm does, written empty or as `.`', async () => {
      const served = await app
      stubRegistry([served])
      const own = (path) => small(dep('app'), `${entry(served)}\n  'foo@file:${path}':\n    resolution: {directory: '${path}', type: directory}\n`, `  app@1.0.0:\n    dependencies:\n      foo: 'file:${path}'\n\n  'foo@file:${path}':\n    dependencies:\n      app: 1.0.0\n`, '  app>foo: file:.\n')
      const rootOf = (fields) => JSON.stringify({ name: 'foo', version: '1.5.0', dependencies: { app: '1.0.0' }, ...fields })
      const early = (host) => [host, rootOf({ pnpm: { overrides: { 'app>foo': 'file:.' } } }), undefined]
      const later = (host) => [host, rootOf(), 'overrides:\n  app>foo: file:.\n']
      const hashed = `foo@file++_${hex('foo@file+.').slice(0, 32)}`
      for (const [path, dir, host, manifest, workspace] of [
        ['', 'foo@file+', ...early(HOST_9)], ['', 'foo@file+', ...early(HOST)], ['', 'foo@file+', ...later(HOST_11)],
        ['.', 'foo@file+.', ...early(HOST_9)], ['.', 'foo@file+.', ...early(HOST)], ['.', hashed, ...later(HOST_11)], ['.', hashed, ...later(HOST_12)],
      ]) {
        const locked = own(path)
        const { vfs, installed } = await buildPnpmTree({ lockfile: locked, manifests: { '.': manifest }, workspace, host, ...both({ 'package.json': manifest, 'index.js': 'foo', 'pnpm-lock.yaml': locked }) })
        const self = `/node_modules/.pnpm/${dir}/node_modules/foo`
        assert.deepEqual(vfs.readdir(self), ['index.js', 'package.json'], `${host.pnpm} ${path}`)
        assert.equal(vfs.realpath('/node_modules/.pnpm/app@1.0.0/node_modules/foo'), self)
        assert.equal(vfs.realpath(`/node_modules/.pnpm/${dir}/node_modules/app`), '/node_modules/.pnpm/app@1.0.0/node_modules/app')
        assert.deepEqual(installed.find(({ name }) => name === 'foo'), {
          path: self.slice(1), key: `foo@file:${path}`, name: 'foo', version: undefined, integrity: undefined, directory: '.', dev: false, optional: false, patch: undefined,
        })
      }
      const v12 = { lockfile: own(''), manifests: { '.': rootOf() }, workspace: 'overrides:\n  app>foo: file:.\n', host: HOST_12, project: createVfs({ 'package.json': rootOf() }) }
      await assert.rejects(buildPnpmTree(v12), /^DeptreeError: "foo@file:": pnpm 12 refuses as broken a lockfile with `file:` and an empty path$/u)
    })
  })

  // pnpm links a package's dependency on its own name inside it only where
  // that leads to a package in its graph, and a directory is none: real
  // installs of pnpm 10 and 11 leave this one out, and so does this.
  it('leaves out a package\'s dependency on its own name overridden to a directory, as pnpm does', async () => {
    const foo = await tarball('foo', '1.0.0', { 'index.js': 'foo' }, { manifest: { dependencies: { foo: '^1.0.0' } } })
    stubRegistry([foo])
    const manifest = JSON.stringify({ name: 'root', dependencies: { foo: '1.0.0' }, pnpm: { overrides: { 'foo@1>foo': 'link:vendor/foo' } } })
    const selfLinked = small(dep('foo'), `${entry(foo)}\n`, '  foo@1.0.0:\n    dependencies:\n      foo: link:vendor/foo\n', '  foo@1>foo: link:vendor/foo\n')
    const { vfs } = await buildPnpmTree({ lockfile: selfLinked, manifests: { '.': manifest }, host: HOST, project: createVfs({ 'package.json': manifest, 'vendor/foo/package.json': '{"name":"foo","version":"2.0.0"}' }) })
    assert.deepEqual(vfs.readdir('/node_modules/.pnpm/foo@1.0.0/node_modules'), ['foo'])
    assert.equal(vfs.readdir('/node_modules/.pnpm/foo@1.0.0/node_modules/foo').includes('node_modules'), false)
    assert.equal(vfs.readText('/node_modules/foo/index.js'), 'foo')
  })

  it('takes a Vfs and nothing else', async () => {
    await assert.rejects(into({}), (error) => error instanceof TypeError && error.message === 'vfs must be a Vfs, or left out')
  })
})

// Without the lockfile given, what an install reads is read from the
// project, as pnpm reads it from the lockfile's directory.
describe('buildPnpmTree reading the project', () => {
  const files = { 'pnpm-lock.yaml': lockfile(), 'package.json': root(), 'patches/p.patch': PATCH }
  const without = (path) => Object.fromEntries(Object.entries(files).filter(([name]) => name !== path))
  const fromProject = (more = {}, options = {}) => buildPnpmTree({ project: createVfs({ ...files, ...more }), host: HOST, ...options })
  const logging = (project, read = []) => ({ read, logged: { readdir: (path) => project.readdir(path), lstat: (path) => project.lstat(path), stat: (path) => { read.push(path); return project.stat(path) }, readFile: (path) => { read.push(path); return project.readFile(path) } } })

  it('builds the tree it builds from the same files given', async () => {
    stubRegistry(TARBALLS)
    const read = await fromProject({ '.npmrc': 'hoist=false\n', 'pnpm-workspace.yaml': 'shamefullyHoist: true\n' })
    const given = await buildResult({ npmrc: 'hoist=false\n', workspace: 'shamefullyHoist: true\n' })
    assert.deepEqual(paths(read.vfs), paths(given.vfs))
    assert.deepEqual(read.stats, given.stats)
    assert.equal(read.vfs.isSymlink('/node_modules/d'), true)
    assert.equal(read.vfs.isDirectory('/node_modules/.pnpm/node_modules'), false)
    assert.equal(read.vfs.readText('/node_modules/p/index.js'), 'module.exports = 2\n')
  })

  // pnpm 10 takes the package.json's pnpm.patchedDependencies over
  // pnpm-workspace.yaml's, whole, and reads only the patches it names.
  it('reads the patches the settings name, and no other', async () => {
    stubRegistry(TARBALLS)
    const workspace = 'patchedDependencies:\n  q@1.0.0: patches/q.patch\n'
    const { vfs } = await fromProject({ 'pnpm-workspace.yaml': workspace, 'patches/q.patch': 'not a patch\n' })
    assert.equal(vfs.readText('/node_modules/p/index.js'), 'module.exports = 2\n')
    await assert.rejects(buildResult({ workspace, patches: { 'patches/p.patch': PATCH, 'patches/q.patch': 'not a patch\n' } }), /^DeptreeError: patches\["patches\/q\.patch"\]: no patchedDependencies setting names this patch$/u)
    await assert.rejects(buildPnpmTree({ project: createVfs(without('patches/p.patch')), host: HOST }), /^DeptreeError: patchedDependencies\["p@1\.0\.0"\]: the patch "patches\/p\.patch" is not given, and pnpm reads every patch it is configured with$/u)
    const outside = root({ pnpm: { patchedDependencies: { 'p@1.0.0': 'patches/../../p.patch' } } })
    await assert.rejects(fromProject({ 'package.json': outside }), /^DeptreeError: patchedDependencies\["p@1\.0\.0"\]: the patch "patches\/\.\.\/\.\.\/p\.patch" is not in the project: it is outside the lockfile's directory$/u)
    // An absolute one, refused as a setting, before anything is read for it.
    for (const path of ['/patches/p.patch', '//patches/p.patch']) {
      const project = createVfs({ ...files, 'package.json': root({ pnpm: { patchedDependencies: { 'p@1.0.0': path } } }) })
      const { read, logged } = logging(project)
      await assert.rejects(buildPnpmTree({ project: logged, host: HOST }), /^DeptreeError: package\.json: pnpm\.patchedDependencies\["p@1\.0\.0"\]: an absolute patch path is not supported$/u, path)
      assert.deepEqual(read.filter((at) => at.includes('patch')), [], path)
    }
  })

  it('reads the package.json of every project pnpm finds', async () => {
    stubRegistry(TARBALLS)
    const workspace = { 'pnpm-lock.yaml': TWO, 'pnpm-workspace.yaml': WORKSPACE }
    const x = { 'packages/x/package.json': JSON.stringify({ name: 'x', dependencies: { b: '1.0.0' } }) }
    const { vfs, stats } = await fromProject({ ...workspace, ...x, 'packages/y/package.json': '{"name":"y"}' })
    assert.equal(stats.projects, 3)
    assert.equal(vfs.readlink('/packages/x/node_modules/b'), '../../../node_modules/.pnpm/b@1.0.0/node_modules/b')
    assert.equal(vfs.readlink('/node_modules/.pnpm/node_modules/y'), '../../../packages/y')
    await assert.rejects(fromProject({ ...workspace, ...x, 'packages/y/package.json': '{"name":"y","dependencies":{"b":"1.0.0"}}' }), /^DeptreeError: manifests\["packages\/y"\]: the lockfile is not up to date with this package\.json/u)
    await assert.rejects(fromProject({ ...workspace, ...x, 'pnpm-workspace.yaml': 'packages:\n  - other/*\n' }), /^DeptreeError: importers\["packages\/x"\]: pnpm-workspace\.yaml's packages do not take this directory/u)
    await assert.rejects(fromProject(workspace), /^DeptreeError: importers\["packages\/x"\]: the package\.json of this project is not given$/u)
  })

  it('refuses what is not there, and what it cannot read', async () => {
    await assert.rejects(buildPnpmTree({ project: createVfs(without('pnpm-lock.yaml')), host: HOST }), /^DeptreeError: the project has no pnpm-lock\.yaml, which a frozen install cannot do without$/u)
    await assert.rejects(buildPnpmTree({ project: createVfs(without('package.json')), host: HOST }), /^DeptreeError: "package\.json": pnpm takes a workspace with no manifest at its root/u)
    await assert.rejects(fromProject({ 'package.json': new Uint8Array([0xc3]) }), /^DeptreeError: manifests\["\."\]: "package\.json" is not UTF-8$/u)
    await assert.rejects(fromProject({ '.npmrc': { type: 'directory' } }), /^DeptreeError: "\.npmrc" is a directory, not a file$/u)
    await assert.rejects(fromProject({ 'pnpm-workspace.yml': '' }), /^DeptreeError: "pnpm-workspace\.yml": pnpm refuses a workspace manifest not named pnpm-workspace\.yaml$/u)
    await assert.rejects(fromProject({ 'pnpm-lock.yaml': `\uFEFF${lockfile()}` }), (error) => error instanceof DeptreeError && error.message === 'pnpm-lock.yaml: U+FEFF is not allowed at line 1' && error.cause instanceof YamlError)
    await assert.rejects(fromProject({ 'pnpm-workspace.yaml': 'packages:\n    - packages/*\n  - other/*\n' }), /^DeptreeError: pnpm-workspace\.yaml: bad indentation at line 3$/u)
  })

  it('reads nothing outside the lockfile\'s directory for an importer', async () => {
    const outside = lockfile().replace('importers:\n', 'importers:\n\n  ../other: {}\n')
    const project = createVfs({ ...files, 'pnpm-lock.yaml': outside })
    const { read, logged } = logging(project)
    await assert.rejects(buildPnpmTree({ project: logged, host: HOST }), /^DeptreeError: importers\["\.\.\/other"\]: a project outside the lockfile's directory is not supported$/u)
    assert.deepEqual(read.filter((path) => path.includes('..')), [])
  })

  // pnpm reads no package.json of an importer it does not find, here one
  // through a link out of the lockfile's directory.
  it('reads nothing for an importer pnpm does not find', async () => {
    const unlisted = lockfile().replace('importers:\n', 'importers:\n\n  vendor/x: {}\n')
    const project = createVfs({ ...files, 'pnpm-lock.yaml': unlisted, 'pnpm-workspace.yaml': WORKSPACE, vendor: { type: 'symlink', target: 'elsewhere' }, 'elsewhere/x/package.json': '{}' })
    const { read, logged } = logging(project)
    await assert.rejects(buildPnpmTree({ project: logged, host: HOST }), /^DeptreeError: importers\["vendor\/x"\]: pnpm-workspace\.yaml's packages do not take this directory, so pnpm would not install it as a project$/u)
    assert.deepEqual(read.filter((path) => path.startsWith('/vendor')), [])
  })

  // Refused, as any project's is, before it is read for the pnpm it pins.
  it('reads no root package.json through a link', async () => {
    const project = createVfs({ ...files, 'package.json': { type: 'symlink', target: 'elsewhere/package.json' }, 'elsewhere/package.json': root({ packageManager: 'pnpm@10.33.4' }) })
    const { read, logged } = logging(project)
    const linked = /^DeptreeError: "package\.json": a link pnpm would read a project's manifest through is not supported$/u
    await assert.rejects(buildPnpmTree({ project: logged, host: { ...HOST, pnpm: undefined } }), linked)
    assert.throws(() => findPnpmProjects({ project: logged }), linked)
    assert.deepEqual(read.filter((path) => path.endsWith('package.json')), [])
  })

  it('takes a project, and nothing it reads there given besides', async () => {
    const project = createVfs(files)
    await assert.rejects(buildPnpmTree({ host: HOST }), /^TypeError: lockfile must be the text of pnpm-lock\.yaml, or left out with a project given to read it from$/u)
    for (const name of ['manifests', 'workspace', 'npmrc', 'patches']) {
      await assert.rejects(buildPnpmTree({ project, host: HOST, [name]: {} }), new RegExp(`^TypeError: ${name} must be left out where lockfile is: both are read from project$`, 'u'))
    }
    await assert.rejects(buildPnpmTree({ project: { readdir: () => [], lstat: () => ({}), stat: () => ({}) }, host: HOST }), /^TypeError: project must be a Vfs, or have its readdir, lstat, stat and readFile$/u)
    const strings = { readdir: (path) => project.readdir(path), lstat: (path) => project.lstat(path), stat: (path) => project.stat(path), readFile: (path) => project.readText(path) }
    await assert.rejects(buildPnpmTree({ project: strings, host: HOST }), /^TypeError: project\.readFile must give back bytes$/u)
  })

  // pnpm switches to the pnpm packageManager pins, so that one installs.
  it('installs with the pnpm the root package.json pins, where host.pnpm is left out', async () => {
    stubRegistry(TARBALLS)
    const machine = { ...HOST, pnpm: undefined }
    const pinned = root({ packageManager: 'pnpm@10.33.4+sha512.abc' })
    assert.equal((await fromProject({ 'package.json': pinned }, { host: machine })).vfs.isSymlink('/node_modules/a'), true)
    assert.equal((await build({ manifest: pinned, host: machine })).isSymlink('/node_modules/a'), true)
    await assert.rejects(fromProject({}, { host: machine }), /^TypeError: host\.pnpm must be given where the root package\.json's packageManager pins no pnpm$/u)
    await assert.rejects(build({ host: machine }), /^TypeError: host\.pnpm must be given where the root package\.json's packageManager pins no pnpm$/u)
    await assert.rejects(build({ manifest: pinned, host: { ...HOST, pnpm: '10.34.6' } }), /^DeptreeError: manifests\["\."\]\.packageManager: the project is installed by pnpm 10\.33\.4, which pnpm switches to, not 10\.34\.6$/u)
  })
})

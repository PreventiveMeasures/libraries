import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { afterEach, describe, it } from 'node:test'
import { buildPnpmTree } from '../pnpm.js'
import { hoistedTree } from '../src/pnpm/hoisted.js'
import { HOST, stubRegistry, tarball } from './registry.js'

// The trees pnpm 10's hoisted linker installs, from tarballs made here. What
// each test holds them to is what real installs of pnpm 10 made of trees of
// the same shape.

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const PATCH = `diff --git a/index.js b/index.js
index 0000000..1111111 100644
--- a/index.js
+++ b/index.js
@@ -1 +1 @@
-module.exports = 1
+module.exports = 2
`
const H = createHash('sha256').update(PATCH).digest('hex')
const CRLF_BIN = { data: '#!/usr/bin/env node\r\nconsole.log(1)\r\n', mode: 0o644 }

const TARBALLS = await Promise.all([
  tarball('ms', '2.0.0', { 'index.js': 'module.exports = 1\n' }),
  tarball('ms', '2.1.3', { 'index.js': 'module.exports = 1\n' }),
  tarball('debug', '2.6.9', { 'index.js': 'module.exports = 1\n' }, { manifest: { dependencies: { ms: '2.0.0' } } }),
  tarball('debug', '4.3.4', {}, { manifest: { dependencies: { ms: '2.1.3' } } }),
  tarball('tool', '1.0.0', { 'cli.js': CRLF_BIN }, { manifest: { bin: { x: 'cli.js' } } }),
  tarball('zzz', '1.0.0', { 'z.js': { data: '#!/usr/bin/env node\n', mode: 0o755 } }, { manifest: { bin: { x: 'z.js' } } }),
  tarball('builder', '1.0.0', {}, { manifest: { scripts: { postinstall: 'node -e 0' }, dependencies: { tool: '1.0.0' } } }),
  tarball('mac', '1.0.0', {}, { manifest: { os: ['darwin'] } }),
  tarball('mac', '2.0.0'),
  tarball('needs-mac', '1.0.0', {}, { manifest: { dependencies: { mac: '2.0.0' } } }),
  tarball('needs-zzz', '1.0.0', {}, { manifest: { dependencies: { zzz: '1.0.0' } } }),
])
const byKey = new Map(TARBALLS.map((t) => [`${t.name}@${t.version}`, t]))

const NPMRC = 'node-linker=hoisted\npackage-import-method=copy\n'
const WORKSPACE = 'packages:\n  - packages/*\n'

// The version a key is referred to by under `alias`, as pnpm writes it.
const ref = (alias, key) => (key.startsWith('link:') || key.slice(0, key.indexOf('@', 1)) !== alias ? key : key.slice(alias.length + 1))
const relative = (from, to) => {
  const a = from === '.' ? [] : from.split('/')
  const b = to.split('/')
  let i = 0
  while (i < a.length && a[i] === b[i]) i++
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/')
}

// A workspace: `projects` by directory, each by kind its dependencies by
// alias, a snapshot key or `workspace:` and a directory; `snapshots` by key
// their own, and `optional` where only optional dependencies reach them; a
// key with a patch hash is patched by PATCH.
function workspace({ projects, snapshots, patched }) {
  const lines = ["lockfileVersion: '9.0'", '', 'settings:', '  autoInstallPeers: true', '  excludeLinksFromLockfile: false', '']
  if (patched) lines.push('patchedDependencies:', `  ${patched}:`, `    hash: ${H}`, '    path: patches/p.patch', '')
  lines.push('importers:', '')
  const manifests = {}
  for (const [id, kinds] of Object.entries(projects)) {
    lines.push(`  ${id}:`)
    const manifest = { name: id === '.' ? 'root' : id.split('/').at(-1), version: '1.0.0' }
    for (const [kind, deps] of Object.entries(kinds)) {
      lines.push(`    ${kind}:`)
      manifest[kind] = {}
      for (const [alias, target] of Object.entries(deps)) {
        const linked = target.startsWith('workspace:')
        const specifier = linked ? 'workspace:*' : target.slice(alias.length + 1).replace(/\(.*$/u, '')
        lines.push(`      ${alias}:`, `        specifier: ${specifier}`, `        version: ${linked ? `link:${relative(id, target.slice(10))}` : ref(alias, target)}`)
        manifest[kind][alias] = specifier
      }
    }
    if (id === '.' && patched) manifest.pnpm = { patchedDependencies: { [patched]: 'patches/p.patch' } }
    manifests[id] = JSON.stringify(manifest)
    lines.push('')
  }
  lines.push('packages:', '')
  const bases = new Set(Object.keys(snapshots).map((key) => key.replace(/\(.*$/u, '')))
  for (const base of bases) {
    const t = byKey.get(base)
    lines.push(`  ${base}:`, `    resolution: {integrity: ${t.integrity}}`)
    if (t.bin) lines.push('    hasBin: true')
    if (t.os) lines.push(`    os: [${t.os.join(', ')}]`)
    lines.push('')
  }
  lines.push('snapshots:', '')
  for (const [key, { dependencies = {}, optional = false }] of Object.entries(snapshots)) {
    const body = Object.entries(dependencies).map(([alias, target]) => `      ${alias}: ${ref(alias, target)}`)
    if (body.length === 0 && !optional) {
      lines.push(`  ${key}: {}`, '')
      continue
    }
    lines.push(`  ${key}:`)
    if (body.length > 0) lines.push('    dependencies:', ...body)
    if (optional) lines.push('    optional: true')
    lines.push('')
  }
  return { lockfile: lines.join('\n'), manifests, patches: patched ? { 'patches/p.patch': PATCH } : {} }
}

// What the tarballs say of their bins and platforms, for the lockfile.
for (const t of TARBALLS) {
  if (['tool', 'zzz'].includes(t.name)) t.bin = true
  if (t.name === 'mac' && t.version === '1.0.0') t.os = ['darwin']
}

const build = async ({ host = HOST, npmrc = NPMRC, ...spec }) => {
  stubRegistry(TARBALLS)
  const { lockfile, manifests, patches } = workspace(spec)
  const { vfs, installed, stats } = await buildPnpmTree({ lockfile, manifests, patches, npmrc, workspace: Object.keys(spec.projects).length > 1 ? WORKSPACE : undefined, host })
  return { vfs, installed, stats, version: (path) => JSON.parse(vfs.readText(`/${path}/package.json`)).version }
}

const DEBUG = { 'debug@2.6.9': { dependencies: { ms: 'ms@2.0.0' } }, 'ms@2.0.0': {}, 'ms@2.1.3': {} }

describe('buildPnpmTree with the hoisted linker', () => {
  it('copies each package as near the root as it goes, and one the root has another of under what needs it', async () => {
    const { vfs, version, installed } = await build({ projects: { '.': { dependencies: { debug: 'debug@2.6.9', ms: 'ms@2.1.3' } } }, snapshots: DEBUG })
    assert.deepEqual(vfs.readdir('/node_modules'), ['.pnpm', 'debug', 'ms'])
    assert.equal(version('node_modules/ms'), '2.1.3')
    assert.equal(version('node_modules/debug/node_modules/ms'), '2.0.0')
    assert.equal(vfs.isSymlink('/node_modules/debug'), false)
    assert.deepEqual(installed.map(({ path, key }) => `${path} ${key}`), ['node_modules/debug debug@2.6.9', 'node_modules/debug/node_modules/ms ms@2.0.0', 'node_modules/ms ms@2.1.3'])
  })

  // debug@2.6.9 and 4.3.4 each have one dependent: the first the root's
  // dependencies and then each project's come to goes to the root.
  it('puts in a project\'s node_modules what the root has another of, and links its `workspace:` dependencies', async () => {
    const { vfs, version } = await build({
      projects: {
        '.': { dependencies: { ms: 'ms@2.1.3', a: 'workspace:packages/a' } },
        'packages/a': { dependencies: { ms: 'ms@2.0.0', debug: 'debug@2.6.9', b: 'workspace:packages/b' } },
        'packages/b': { dependencies: { debug: 'debug@4.3.4' } },
      },
      snapshots: { ...DEBUG, 'debug@4.3.4': { dependencies: { ms: 'ms@2.1.3' } } },
    })
    assert.deepEqual(vfs.readdir('/node_modules'), ['.pnpm', 'a', 'debug', 'ms'])
    assert.equal(vfs.readlink('/node_modules/a'), '../packages/a')
    assert.equal(version('node_modules/debug'), '2.6.9')
    assert.equal(version('node_modules/debug/node_modules/ms'), '2.0.0')
    assert.deepEqual(vfs.readdir('/packages/a/node_modules'), ['b', 'ms'])
    assert.equal(vfs.readlink('/packages/a/node_modules/b'), '../../b')
    assert.equal(version('packages/a/node_modules/ms'), '2.0.0')
    assert.deepEqual(vfs.readdir('/packages/b/node_modules'), ['debug'])
    assert.equal(version('packages/b/node_modules/debug'), '4.3.4')
  })

  it('leaves out an optional package the host cannot run, which takes its name all the same', async () => {
    const { vfs, version } = await build({
      projects: { '.': { dependencies: { 'needs-mac': 'needs-mac@1.0.0' }, optionalDependencies: { mac: 'mac@1.0.0' } } },
      snapshots: { 'mac@1.0.0': { optional: true }, 'mac@2.0.0': {}, 'needs-mac@1.0.0': { dependencies: { mac: 'mac@2.0.0' } } },
    })
    assert.deepEqual(vfs.readdir('/node_modules'), ['.pnpm', 'needs-mac'])
    assert.equal(version('node_modules/needs-mac/node_modules/mac'), '2.0.0')
  })

  it('links a command of one name to the greater package\'s, and fixes none of the other\'s', async () => {
    const { vfs } = await build({
      projects: { '.': { dependencies: { tool: 'tool@1.0.0', zzz: 'zzz@1.0.0' } }, 'packages/a': { dependencies: { tool: 'tool@1.0.0' } } },
      snapshots: { 'tool@1.0.0': {}, 'zzz@1.0.0': {} },
    })
    assert.equal(vfs.stat('/node_modules/tool/cli.js').mode, 0o644)
    assert.equal(vfs.readText('/node_modules/tool/cli.js'), CRLF_BIN.data)
  })

  // zzz is no dependency of the root's own: once the root's links are in,
  // its node_modules is linked again, tool's command first.
  it('links a project\'s own dependency\'s command over another\'s of its name', async () => {
    const { vfs } = await build({
      projects: { '.': { dependencies: { tool: 'tool@1.0.0', 'needs-zzz': 'needs-zzz@1.0.0' } } },
      snapshots: { 'tool@1.0.0': {}, 'zzz@1.0.0': {}, 'needs-zzz@1.0.0': { dependencies: { zzz: 'zzz@1.0.0' } } },
    })
    assert.deepEqual(vfs.readdir('/node_modules'), ['.pnpm', 'needs-zzz', 'tool', 'zzz'])
    assert.equal(vfs.stat('/node_modules/tool/cli.js').mode, 0o755)
    assert.equal(vfs.readText('/node_modules/tool/cli.js'), '#!/usr/bin/env node\nconsole.log(1)\r\n')
  })

  it('requires an import method that copies', async () => {
    for (const method of ['auto', 'hardlink']) {
      await assert.rejects(build({ npmrc: `node-linker=hoisted\npackage-import-method=${method}\n`, projects: { '.': { dependencies: { ms: 'ms@2.1.3' } } }, snapshots: { 'ms@2.1.3': {} } }), new RegExp(`^DeptreeError: packageImportMethod: "${method}" is not supported with the hoisted layout`, 'u'))
    }
    for (const method of ['copy', 'clone', 'clone-or-copy']) {
      const { vfs } = await build({ npmrc: `node-linker=hoisted\npackage-import-method=${method}\n`, projects: { '.': { dependencies: { ms: 'ms@2.1.3' } } }, snapshots: { 'ms@2.1.3': {} } })
      assert.equal(vfs.isDirectory('/node_modules/ms'), true, method)
    }
  })

  it('is refused for pnpm 9, as for 11 and 12 (settings.test.js)', async () => {
    const spec = { projects: { '.': { dependencies: { ms: 'ms@2.1.3' } } }, snapshots: { 'ms@2.1.3': {} } }
    await assert.rejects(build({ ...spec, host: { ...HOST, pnpm: '9.15.9' } }), /^DeptreeError: \.npmrc:1: node-linker: "hoisted" is not supported: only the isolated node_modules layout is built for pnpm 9$/u)
  })
})

const LEAVES = {
  projects: { '.': { dependencies: { ms: 'ms@2.1.3' } }, 'packages/a': { dependencies: { ms: `ms@2.0.0(patch_hash=${H})` } }, 'packages/b': { dependencies: { ms: `ms@2.0.0(patch_hash=${H})` } } },
  snapshots: { 'ms@2.1.3': {}, [`ms@2.0.0(patch_hash=${H})`]: {} },
  patched: 'ms@2.0.0',
}
const NESTED = {
  projects: {
    '.': { dependencies: { debug: 'debug@4.3.4', ms: 'ms@2.1.3' } },
    'packages/a': { dependencies: { debug: `debug@2.6.9(patch_hash=${H})`, ms: 'ms@2.1.3' } },
    'packages/b': { dependencies: { debug: `debug@2.6.9(patch_hash=${H})`, ms: 'ms@2.1.3' } },
  },
  snapshots: { [`debug@2.6.9(patch_hash=${H})`]: { dependencies: { ms: 'ms@2.0.0' } }, 'debug@4.3.4': { dependencies: { ms: 'ms@2.1.3' } }, 'ms@2.0.0': {}, 'ms@2.1.3': {} },
  patched: 'debug@2.6.9',
}

describe('buildPnpmTree with the hoisted linker and a patch', () => {
  it('patches every copy, as pnpm 10 from 10.21 links them all to the one it patches', async () => {
    const { vfs, stats } = await build(LEAVES)
    assert.equal(vfs.readText('/packages/a/node_modules/ms/index.js'), 'module.exports = 2\n')
    assert.equal(vfs.readText('/packages/b/node_modules/ms/index.js'), 'module.exports = 2\n')
    assert.equal(vfs.readText('/node_modules/ms/index.js'), 'module.exports = 1\n')
    assert.equal(stats.patched, 2)
  })

  it('refuses a patched package in two places before 10.21, which patches one alone', async () => {
    await assert.rejects(build({ ...LEAVES, host: { ...HOST, pnpm: '10.20.0' } }), /^DeptreeError: "ms@2\.0\.0\(patch_hash=[\da-f]+\)": pnpm 10 before 10\.21 patches one of its copies alone, and leaves the others as they were, which is not supported$/u)
  })

  // pnpm 10.21 to 11.24 put a copy of hardlinks in place of each other copy,
  // made with no node_modules: packages/b's debug would resolve its ms to
  // 2.1.3. Which copy it builds is not followed: either may lose its own.
  it('refuses a package it builds in two places where pnpm drops a copy\'s node_modules', async () => {
    await assert.rejects(build(NESTED), /^DeptreeError: "debug@2\.6\.9\(patch_hash=[\da-f]+\)": pnpm 10 builds one of its copies where any patch is configured, and makes the others hardlinks of it, dropping their node_modules: "packages\/a\/node_modules\/debug\/node_modules" may be dropped, which is not supported$/u)
  })

  it('builds a package with an install script where any patch is configured, which links its dependencies\' bins', async () => {
    const spec = {
      projects: { '.': { dependencies: { builder: 'builder@1.0.0', tool: 'tool@1.0.0', zzz: 'zzz@1.0.0', ms: `ms@2.0.0(patch_hash=${H})` } } },
      snapshots: { 'builder@1.0.0': { dependencies: { tool: 'tool@1.0.0' } }, 'tool@1.0.0': {}, 'zzz@1.0.0': {}, [`ms@2.0.0(patch_hash=${H})`]: {} },
    }
    const built = await build({ ...spec, patched: 'ms@2.0.0' })
    assert.equal(built.vfs.stat('/node_modules/tool/cli.js').mode, 0o755)
    const unpatched = { projects: { '.': { dependencies: { ...spec.projects['.'].dependencies, ms: 'ms@2.0.0' } } }, snapshots: { ...spec.snapshots, 'ms@2.0.0': {} } }
    delete unpatched.snapshots[`ms@2.0.0(patch_hash=${H})`]
    const plain = await build(unpatched)
    assert.equal(plain.vfs.stat('/node_modules/tool/cli.js').mode, 0o644)
  })
})

describe('hoistedTree', () => {
  const pkg = (name, version, dependencies = {}) => ({ name, version, resolution: { type: 'tarball' }, dependencies, optionalDependencies: {}, peerDependencies: {}, transitivePeerDependencies: [] })
  const lockfileOf = (rootDeps, packages) => ({ importers: { '.': { dependencies: rootDeps, devDependencies: {}, optionalDependencies: {} } }, packages })

  // A chain pnpm recurses down once per package, on a stack here.
  it('hoists a chain of 20,000 packages flat', () => {
    const packages = {}
    for (let i = 0; i < 20_000; i++) packages[`a${i}@1.0.0`] = pkg(`a${i}`, '1.0.0', i + 1 < 20_000 ? { [`a${i + 1}`]: `a${i + 1}@1.0.0` } : {})
    assert.equal(hoistedTree(lockfileOf({ a0: 'a0@1.0.0' }, packages), true).dependencies.size, 20_000)
  })

  it('refuses a graph that takes more steps, or makes more packages, than allowed', () => {
    const packages = {}
    const rootDeps = { b0: 'b0@1.0.0' }
    for (let i = 0; i < 200; i++) {
      packages[`b${i}@1.0.0`] = pkg(`b${i}`, '1.0.0', i + 1 < 200 ? { [`b${i + 1}`]: `b${i + 1}@1.0.0` } : {})
      packages[`b${i}@2.0.0`] = pkg(`b${i}`, '2.0.0')
      if (i > 0) rootDeps[`b${i}`] = `b${i}@2.0.0`
    }
    const lockfile = lockfileOf(rootDeps, packages)
    assert.throws(() => hoistedTree(lockfile, true, { maxSteps: 1000 }), /^DeptreeError: lockfile: hoisting it takes more than 1000 steps, which is not supported$/u)
    assert.throws(() => hoistedTree(lockfile, true, { maxNodes: 300 }), /^DeptreeError: lockfile: hoisting it makes a tree of more than 300 packages, which is not supported$/u)
    assert.equal(hoistedTree(lockfile, true).dependencies.size, 200)
  })
})

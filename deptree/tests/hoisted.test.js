import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { afterEach, describe, it } from 'node:test'
import { buildPnpmTree } from '../pnpm.js'
import { hoistedBuilds, hoistedTree, packageIdOf } from '../src/pnpm/hoisted.js'
import { HOST, stubRegistry, tarball } from './registry.js'

// The trees pnpm 10's and 11's hoisted linker installs, from tarballs made
// here. What each test holds them to is what real installs of pnpm 10 and 11
// made of trees of the same shape.

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
// key with a patch hash is patched by `patch`, configured as pnpm `major`
// reads it.
function workspace({ projects, snapshots, patched, patch = PATCH, major = 10 }) {
  const lines = ["lockfileVersion: '9.0'", '', 'settings:', '  autoInstallPeers: true', '  excludeLinksFromLockfile: false', '']
  const hash = createHash('sha256').update(patch).digest('hex')
  if (patched && major >= 11) lines.push('patchedDependencies:', `  ${patched}: ${hash}`, '')
  else if (patched) lines.push('patchedDependencies:', `  ${patched}:`, `    hash: ${hash}`, '    path: patches/p.patch', '')
  lines.push('importers:', '')
  const manifests = {}
  for (const [id, kinds] of Object.entries(projects)) {
    lines.push(`  ${id}:${Object.keys(kinds).length === 0 ? ' {}' : ''}`)
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
    if (id === '.' && patched && major < 11) manifest.pnpm = { patchedDependencies: { [patched]: 'patches/p.patch' } }
    manifests[id] = JSON.stringify(manifest)
    lines.push('')
  }
  lines.push(Object.keys(snapshots).length === 0 ? 'packages: {}' : 'packages:', '')
  const bases = new Set(Object.keys(snapshots).map((key) => key.replace(/\(.*$/u, '')))
  for (const base of bases) {
    const t = byKey.get(base)
    lines.push(`  ${base}:`, `    resolution: {integrity: ${t.integrity}}`)
    if (t.bin) lines.push('    hasBin: true')
    if (t.os) lines.push(`    os: [${t.os.join(', ')}]`)
    lines.push('')
  }
  lines.push(Object.keys(snapshots).length === 0 ? 'snapshots: {}' : 'snapshots:', '')
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
  return { lockfile: lines.join('\n'), manifests, patches: patched ? { 'patches/p.patch': patch } : {} }
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

// pnpm 11 reads its settings, the patches with them, from pnpm-workspace.yaml.
const HOST_11 = { ...HOST, pnpm: '11.28.4' }
const build11 = async ({ host = HOST_11, settings = '', ...spec }) => {
  stubRegistry(TARBALLS)
  const { lockfile, manifests, patches } = workspace({ ...spec, major: 11 })
  const patching = spec.patched ? `patchedDependencies:\n  ${spec.patched}: patches/p.patch\n` : ''
  const workspaceYaml = `${WORKSPACE}nodeLinker: hoisted\npackageImportMethod: copy\n${patching}${settings}`
  const { vfs, installed, stats } = await buildPnpmTree({ lockfile, manifests, patches, workspace: workspaceYaml, host })
  return { vfs, installed, stats, version: (path) => JSON.parse(vfs.readText(`/${path}/package.json`)).version }
}

const DEBUG = { 'debug@2.6.9': { dependencies: { ms: 'ms@2.0.0' } }, 'ms@2.0.0': {}, 'ms@2.1.3': {} }

describe('buildPnpmTree with the hoisted linker', () => {
  it('copies each package as near the root as it goes, and one the root has another of under what needs it, and no more', async () => {
    const { vfs, version, installed } = await build({ projects: { '.': { dependencies: { debug: 'debug@2.6.9', ms: 'ms@2.1.3' } } }, snapshots: DEBUG })
    assert.deepEqual(vfs.readdir('/node_modules'), ['debug', 'ms'])
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
    assert.deepEqual(vfs.readdir('/node_modules'), ['a', 'debug', 'ms'])
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
    assert.deepEqual(vfs.readdir('/node_modules'), ['needs-mac'])
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
    assert.deepEqual(vfs.readdir('/node_modules'), ['needs-zzz', 'tool', 'zzz'])
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

  it('is refused for pnpm 9, as for 12 (settings.test.js)', async () => {
    const spec = { projects: { '.': { dependencies: { ms: 'ms@2.1.3' } } }, snapshots: { 'ms@2.1.3': {} } }
    await assert.rejects(build({ ...spec, host: { ...HOST, pnpm: '9.15.9' } }), /^DeptreeError: \.npmrc:1: node-linker: "hoisted" is not supported: only the isolated node_modules layout is built for pnpm 9$/u)
  })

  it('makes no node_modules where nothing is installed', async () => {
    const { vfs } = await build({ projects: { '.': {} }, snapshots: {} })
    assert.deepEqual(vfs.readdir('/'), [])
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
    await assert.rejects(build(NESTED), /^DeptreeError: "debug@2\.6\.9\(patch_hash=[\da-f]+\)": pnpm 10\.33\.4 builds one of its copies where any patch is configured, and makes the others hardlinks of it, dropping their node_modules: "packages\/a\/node_modules\/debug\/node_modules" may be dropped, which is not supported$/u)
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

// Deletes ms@2.0.0's index.js.
const DELETE = `diff --git a/index.js b/index.js
deleted file mode 100644
index 0000000..0000000
--- a/index.js
+++ /dev/null
@@ -1 +0,0 @@
-module.exports = 1
`
const HD = createHash('sha256').update(DELETE).digest('hex')

describe('buildPnpmTree with pnpm 11\'s hoisted linker', () => {
  // packages/ms and packages/Debug are named as packages in the root's
  // node_modules, and b as a dependency of the root.
  it('links each named project into the root\'s node_modules where nothing of its name is, from 11.28', async () => {
    const projects = {
      '.': { dependencies: { debug: 'debug@2.6.9', b: 'workspace:packages/b' } },
      'packages/a': { dependencies: { ms: 'ms@2.1.3' } },
      'packages/b': {},
      'packages/ms': {},
      'packages/Debug': {},
    }
    const { vfs, version } = await build11({ projects, snapshots: DEBUG })
    assert.deepEqual(vfs.readdir('/node_modules'), ['a', 'b', 'debug', 'ms'])
    assert.equal(vfs.readlink('/node_modules/a'), '../packages/a')
    assert.equal(vfs.readlink('/node_modules/b'), '../packages/b')
    assert.equal(version('node_modules/ms'), '2.0.0')
    assert.equal(version('packages/a/node_modules/ms'), '2.1.3')
    const unhoisted = await build11({ projects, snapshots: DEBUG, settings: 'hoistWorkspacePackages: false\n' })
    assert.deepEqual(unhoisted.vfs.readdir('/node_modules'), ['b', 'debug', 'ms'])
    const publicOnly = await build11({ projects, snapshots: DEBUG, settings: 'hoist: false\npublicHoistPattern:\n  - b*\n' })
    assert.deepEqual(publicOnly.vfs.readdir('/node_modules'), ['b', 'debug', 'ms'])
    const before = await build11({ projects, snapshots: DEBUG, host: { ...HOST, pnpm: '11.27.1' } })
    assert.deepEqual(before.vfs.readdir('/node_modules'), ['b', 'debug', 'ms'])
  })

  it('lays out a workspace as pnpm 10 does', async () => {
    const { vfs, version } = await build11({
      projects: {
        '.': { dependencies: { ms: 'ms@2.1.3', a: 'workspace:packages/a' } },
        'packages/a': { dependencies: { ms: 'ms@2.0.0', debug: 'debug@2.6.9', b: 'workspace:packages/b' } },
        'packages/b': { dependencies: { debug: 'debug@4.3.4' } },
      },
      snapshots: { ...DEBUG, 'debug@4.3.4': { dependencies: { ms: 'ms@2.1.3' } } },
    })
    assert.deepEqual(vfs.readdir('/node_modules'), ['a', 'b', 'debug', 'ms'])
    assert.equal(version('node_modules/debug/node_modules/ms'), '2.0.0')
    assert.deepEqual(vfs.readdir('/packages/a/node_modules'), ['b', 'ms'])
    assert.equal(version('packages/b/node_modules/debug'), '4.3.4')
  })

  // From 11.25 pnpm links the built copy's files into each other copy in
  // place, and keeps its node_modules; before, as pnpm 10 from 10.21, it
  // drops them.
  it('patches every copy of a package it builds, each with its own node_modules, from 11.25', async () => {
    await assert.rejects(build11({ ...NESTED, host: { ...HOST, pnpm: '11.24.0' } }), /^DeptreeError: "debug@2\.6\.9\(patch_hash=[\da-f]+\)": pnpm 11\.24\.0 builds one of its copies where any patch is configured, and makes the others hardlinks of it, dropping their node_modules: "packages\/a\/node_modules\/debug\/node_modules" may be dropped, which is not supported$/u)
    const { vfs, version, stats } = await build11({ ...NESTED, host: { ...HOST, pnpm: '11.25.0' } })
    for (const project of ['packages/a', 'packages/b']) {
      assert.equal(vfs.readText(`/${project}/node_modules/debug/index.js`), 'module.exports = 2\n')
      assert.equal(version(`${project}/node_modules/debug/node_modules/ms`), '2.0.0')
    }
    assert.equal(stats.patched, 2)
  })

  it('refuses a patch that deletes a file of a package in two places, which pnpm keeps in the copy it does not build', async () => {
    const leaves = {
      projects: { '.': { dependencies: { ms: 'ms@2.1.3' } }, 'packages/a': { dependencies: { ms: `ms@2.0.0(patch_hash=${HD})` } }, 'packages/b': { dependencies: { ms: `ms@2.0.0(patch_hash=${HD})` } } },
      snapshots: { 'ms@2.1.3': {}, [`ms@2.0.0(patch_hash=${HD})`]: {} },
      patched: 'ms@2.0.0',
      patch: DELETE,
    }
    await assert.rejects(build11(leaves), /^DeptreeError: "ms@2\.0\.0\(patch_hash=[\da-f]+\)": pnpm 11\.28\.4 patches one of its copies, and links its files into the others, which keep "index\.js" the patch deletes, which is not supported$/u)
    const one = { ...leaves, projects: { '.': { dependencies: { ms: `ms@2.0.0(patch_hash=${HD})` } } }, snapshots: { [`ms@2.0.0(patch_hash=${HD})`]: {} } }
    const { vfs } = await build11(one)
    assert.deepEqual(vfs.readdir('/node_modules/ms'), ['package.json'])
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

  const names = (deps) => [...deps].map((dep) => `${dep.name} ${[...dep.references][0]}`).sort()

  // Two directories of one name, each under what needs it.
  it('takes the snapshots of a package from directories for one, and from pnpm 11.24 each for its own', () => {
    const dir = (directory) => ({ ...pkg('tool', undefined), resolution: { type: 'directory', directory } })
    const lockfile = lockfileOf({ a: 'a@1.0.0', b: 'b@1.0.0' }, {
      'a@1.0.0': pkg('a', '1.0.0', { tool: 'tool@file:vendor/one' }),
      'b@1.0.0': pkg('b', '1.0.0', { tool: 'tool@file:vendor/two' }),
      'tool@file:vendor/one': dir('vendor/one'),
      'tool@file:vendor/two': dir('vendor/two'),
    })
    const tree10 = hoistedTree(lockfile, true)
    assert.deepEqual(names(tree10.dependencies), ['a a@1.0.0', 'b b@1.0.0', 'tool tool@file:vendor/one'])
    assert.equal([...tree10.dependencies].find((dep) => dep.name === 'b').dependencies.size, 0)
    const tree = hoistedTree(lockfile, true, undefined, { directories: true })
    assert.deepEqual(names(tree.dependencies), ['a a@1.0.0', 'b b@1.0.0', 'tool tool@file:vendor/one'])
    assert.deepEqual(names([...tree.dependencies].find((dep) => dep.name === 'b').dependencies), ['tool tool@file:vendor/two'])
  })

  // Two projects link ms, a third depends on ms 2.1.3: the links, the more,
  // take the root's ms where pnpm hoists them.
  it('hoists a project\'s links, but from pnpm 11.28.1 none into the project that asks for it', () => {
    const importer = (dependencies) => ({ dependencies, devDependencies: {}, optionalDependencies: {} })
    const lockfileOf2 = (link) => ({
      importers: { '.': importer({}), 'packages/a': importer({ ms: `link:packages/a/${link}` }), 'packages/d': importer({ ms: `link:packages/d/${link}` }), 'packages/b': importer({ ms: 'ms@2.1.3' }) },
      packages: { 'ms@2.1.3': pkg('ms', '2.1.3') },
    })
    const top = (lockfile, pnpm) => names([...hoistedTree(lockfile, true, undefined, pnpm).dependencies].filter((dep) => dep.name === 'ms'))
    assert.deepEqual(top(lockfileOf2('<root>/ms'), {}), ['ms link:<root>/ms'])
    assert.deepEqual(top(lockfileOf2('<root>/ms'), { rootLinks: true }), ['ms ms@2.1.3'])
    assert.deepEqual(top(lockfileOf2('vendor/ms'), { rootLinks: true }), ['ms link:vendor/ms'])
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

describe('hoistedBuilds', () => {
  // q, at the root, depends on p's variant with ms 2.1.3, which pnpm took
  // for its variant with ms 2.0.0, copied only under q.
  const p = { resolution: { type: 'tarball' }, dependencies: {}, optionalDependencies: {}, patchHash: 'h' }
  const q = { resolution: { type: 'tarball' }, dependencies: { p: 'p@1.0.0(ms@2.1.3)' }, optionalDependencies: {} }
  const byDir = new Map([
    ['node_modules/q', { dir: 'node_modules/q', key: 'q@1.0.0', modules: 'node_modules', pkg: q, files: new Map() }],
    ['node_modules/q/node_modules/p', { dir: 'node_modules/q/node_modules/p', key: 'p@1.0.0(ms@2.0.0)', modules: 'node_modules/q/node_modules', pkg: p, files: new Map() }],
  ])
  const packages = { 'q@1.0.0': q, 'p@1.0.0(ms@2.0.0)': p, 'p@1.0.0(ms@2.1.3)': p }
  const patched = (node) => node.pkg.patchHash !== undefined

  it('finds a dependency by its snapshot, and from pnpm 11.23 by its package', () => {
    assert.throws(() => hoistedBuilds(byDir, new Set(['node_modules']), patched, { hardlinks: true, pnpm: '11.22.0' }), /^DeptreeError: "p@1\.0\.0\(ms@2\.0\.0\)": pnpm 11\.22\.0 reaches none of its copies through the dependencies it builds by, and leaves it unpatched, which is not supported$/u)
    const idOf = (key) => packageIdOf(key, packages[key])
    const [built] = hoistedBuilds(byDir, new Set(['node_modules']), patched, { hardlinks: true, idOf, pnpm: '11.23.0' })
    assert.deepEqual(built.candidates, ['node_modules/q/node_modules/p'])
  })
})

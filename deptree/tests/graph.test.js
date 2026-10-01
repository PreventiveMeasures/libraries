import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parsePnpmLockfile } from '@preventive/lockfile/pnpm.js'
import { buildGraph } from '../src/pnpm/graph.js'
import { hoist } from '../src/pnpm/hoist.js'
import { skippedSnapshots } from '../src/pnpm/install.js'
import { HOST } from './registry.js'

// Lockfiles of registry packages only, every snapshot a package of its own
// name at 1.0.0 unless its key says otherwise; what is checked here is the
// order pnpm walks them in, which decides what is left out and what is
// hoisted.

const I = 'sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg=='

// `root` maps a kind to aliases; `graph` maps a key to its dependencies
// by alias, as `alias: version`, and `meta` to more of its package entry.
function lockfile({ root, graph, meta = {}, snapshotMeta = {} }) {
  const importer = Object.entries(root).map(([kind, aliases]) => `    ${kind}:\n${aliases.map((alias) => `      ${alias}:\n        specifier: 1.0.0\n        version: 1.0.0\n`).join('')}`).join('')
  const packages = Object.keys(graph).map((key) => `  ${key}:\n    resolution: {integrity: ${I}}\n${meta[key] ?? ''}`).join('\n')
  const snapshots = Object.entries(graph).map(([key, deps]) => {
    const list = Object.entries(deps).map(([alias, version]) => `      ${alias}: ${version}\n`).join('')
    const body = `${list === '' ? '' : `    dependencies:\n${list}`}${snapshotMeta[key] ?? ''}`
    return body === '' ? `  ${key}: {}\n` : `  ${key}:\n${body}`
  }).join('\n')
  return parsePnpmLockfile(`lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n${importer}\npackages:\n\n${packages}\nsnapshots:\n\n${snapshots}`).lockfile
}

const settings = { hoistPattern: ['*'], publicHoistPattern: [] }
const on10 = { host: HOST, settings: {} }

describe('skippedSnapshots', () => {
  // m cannot run here; k can, and is reached through m before n.
  const graph = { 'k@1.0.0': {}, 'm@1.0.0': { k: '1.0.0' }, 'n@1.0.0': { k: '1.0.0' } }
  const meta = { 'm@1.0.0': '    os: [darwin]\n' }
  const optional = { 'k@1.0.0': '    optional: true\n', 'm@1.0.0': '    optional: true\n', 'n@1.0.0': '    optional: true\n' }

  it('leaves out an optional package first reached through one left out, as pnpm does', () => {
    const lock = lockfile({ root: { optionalDependencies: ['m', 'n'] }, graph, meta, snapshotMeta: optional })
    assert.deepEqual([...skippedSnapshots(lock, on10).skipped], ['m@1.0.0', 'k@1.0.0'])
  })

  it('keeps it where it is first reached through one kept', () => {
    const lock = lockfile({ root: { dependencies: ['n'], optionalDependencies: ['m'] }, graph, meta, snapshotMeta: optional })
    assert.deepEqual([...skippedSnapshots(lock, on10).skipped], ['m@1.0.0'])
  })

  it('installs a package that is not optional, whatever the host', () => {
    const lock = lockfile({ root: { dependencies: ['m'] }, graph: { 'm@1.0.0': {} }, meta })
    assert.deepEqual([...skippedSnapshots(lock, on10).skipped], [])
    const strict = { host: HOST, settings: { engineStrict: true } }
    assert.throws(() => skippedSnapshots(lock, strict), /^DeptreeError: "m@1\.0\.0": the host does not take its os, cpu or libc/u)
  })

  it('leaves out an optional package whose engines.node the host\'s Node does not take', () => {
    const lock = lockfile({ root: { optionalDependencies: ['m'] }, graph: { 'm@1.0.0': {} }, meta: { 'm@1.0.0': '    engines: {node: \'>=99\'}\n' }, snapshotMeta: { 'm@1.0.0': '    optional: true\n' } })
    assert.deepEqual([...skippedSnapshots(lock, on10).skipped], ['m@1.0.0'])
    const newer = { host: HOST, settings: { nodeVersion: '99.0.0' } }
    assert.deepEqual([...skippedSnapshots(lock, newer).skipped], [])
  })
})

// pnpm 11 walks by edges: an optional one to what the host cannot run is
// not taken, and what a taken package requires is taken whatever the host.
describe('skippedSnapshots for pnpm 11', () => {
  const on11 = { host: { ...HOST, major: 11 }, settings: {} }
  const skipped11 = (lock, on = on11) => [...skippedSnapshots(lock, on).skipped]
  const graph = { 'k@1.0.0': {}, 'm@1.0.0': { k: '1.0.0' }, 'n@1.0.0': { k: '1.0.0' } }
  const optional = { 'k@1.0.0': '    optional: true\n', 'm@1.0.0': '    optional: true\n', 'n@1.0.0': '    optional: true\n' }

  it('keeps what an installed package reaches, whichever way is walked first', () => {
    const lock = lockfile({ root: { optionalDependencies: ['m', 'n'] }, graph, meta: { 'm@1.0.0': '    os: [darwin]\n' }, snapshotMeta: optional })
    assert.deepEqual(skipped11(lock), ['m@1.0.0'])
  })

  it('installs what an installed optional package requires, whatever the host', () => {
    const lock = lockfile({ root: { optionalDependencies: ['p'] }, graph: { 'p@1.0.0': { c: '1.0.0' }, 'c@1.0.0': {} }, meta: { 'c@1.0.0': '    os: [darwin]\n' }, snapshotMeta: { 'p@1.0.0': '    optional: true\n', 'c@1.0.0': '    optional: true\n' } })
    assert.deepEqual(skipped11(lock), [])
    assert.deepEqual([...skippedSnapshots(lock, on10).skipped], ['c@1.0.0'], 'pnpm 10 leaves it out')
    assert.deepEqual([...skippedSnapshots(lock, on11).incompatible], ['c@1.0.0'])
  })

  it('infers an optional package\'s platform from its name', () => {
    const lock = lockfile({ root: { optionalDependencies: ['bin-win32-x64', 'bin-linux-x64', 'bin-x64'] }, graph: { 'bin-win32-x64@1.0.0': {}, 'bin-linux-x64@1.0.0': {}, 'bin-x64@1.0.0': {} }, snapshotMeta: { 'bin-win32-x64@1.0.0': '    optional: true\n', 'bin-linux-x64@1.0.0': '    optional: true\n', 'bin-x64@1.0.0': '    optional: true\n' } })
    assert.deepEqual(skipped11(lock), ['bin-win32-x64@1.0.0'])
    assert.deepEqual([...skippedSnapshots(lock, on10).skipped], [], 'pnpm 10 infers nothing')
  })

  it('takes a list of exclusions where the host is taken to be more than one thing', () => {
    const lock = lockfile({ root: { optionalDependencies: ['m'] }, graph: { 'm@1.0.0': {} }, meta: { 'm@1.0.0': '    os: [\'!win32\']\n' }, snapshotMeta: { 'm@1.0.0': '    optional: true\n' } })
    const wider = { supportedArchitectures: { os: ['current', 'darwin'] } }
    assert.deepEqual(skipped11(lock, { host: { ...HOST, major: 11 }, settings: wider }), [])
    assert.deepEqual([...skippedSnapshots(lock, { host: HOST, settings: wider }).skipped], ['m@1.0.0'], 'pnpm 10 counts the exclusions twice')
  })
})

// pnpm 12 leaves out what pnpm 11 does, but refuses with engineStrict an
// incompatible package an installed one requires though the lockfile marks
// it optional; takes the first entry of a cpu list that names the host's;
// and refuses an engines.node npm's semver does not read where it decides.
describe('skippedSnapshots for pnpm 12', () => {
  const on12 = (given = {}) => ({ host: { ...HOST, major: 12 }, settings: given })
  const on11 = (given = {}) => ({ host: { ...HOST, major: 11 }, settings: given })
  const optional = { 'opt@1.0.0': '    optional: true\n', 'bad@1.0.0': '    optional: true\n' }

  it('refuses with engineStrict what an installed package requires that the host cannot run', () => {
    const lock = lockfile({ root: { optionalDependencies: ['opt'] }, graph: { 'opt@1.0.0': { bad: '1.0.0' }, 'bad@1.0.0': {} }, meta: { 'bad@1.0.0': "    engines: {node: '>=99'}\n" }, snapshotMeta: optional })
    assert.deepEqual([...skippedSnapshots(lock, on11({ engineStrict: true })).incompatible], ['bad@1.0.0'])
    assert.throws(() => skippedSnapshots(lock, on12({ engineStrict: true })), /^DeptreeError: "bad@1\.0\.0": the host does not take its engines\.node, which engineStrict refuses$/u)
    assert.deepEqual([...skippedSnapshots(lock, on12()).incompatible], ['bad@1.0.0'])
  })

  it('takes the first entry of a list that names the host\'s', () => {
    const lock = lockfile({ root: { optionalDependencies: ['c'] }, graph: { 'c@1.0.0': {} }, meta: { 'c@1.0.0': "    cpu: [x64, '!x64']\n" }, snapshotMeta: { 'c@1.0.0': '    optional: true\n' } })
    assert.deepEqual([...skippedSnapshots(lock, on12()).skipped], [])
    assert.deepEqual([...skippedSnapshots(lock, on11()).skipped], ['c@1.0.0'])
  })

  it('refuses an engines.node npm\'s semver does not read where it decides what is installed', () => {
    for (const range of ['node >= 0.8', '1.2.3 - x']) {
      const lock = lockfile({ root: { optionalDependencies: ['e'] }, graph: { 'e@1.0.0': {} }, meta: { 'e@1.0.0': `    engines: {node: '${range}'}\n` }, snapshotMeta: { 'e@1.0.0': '    optional: true\n' } })
      assert.throws(() => skippedSnapshots(lock, on12()), /^DeptreeError: "e@1\.0\.0": its engines\.node, ".+", pnpm 12 reads otherwise than npm's semver, which is not supported$/u, range)
      skippedSnapshots(lock, on11())
    }
    const required = lockfile({ root: { dependencies: ['e'] }, graph: { 'e@1.0.0': {} }, meta: { 'e@1.0.0': "    engines: {node: 'node >= 0.8'}\n" } })
    assert.deepEqual([...skippedSnapshots(required, on12()).incompatible], ['e@1.0.0'], 'it only warns of one installed anyway')
  })
})

describe('hoist', () => {
  const hoisted = async (lock) => {
    const { nodes, direct } = await buildGraph(lock, new Set(), 120)
    const links = hoist(new Map([...nodes.values()].map((node) => [node.dir, node])), direct, settings)
    return Object.fromEntries([...links].map(([path, dir]) => [path.slice('node_modules/.pnpm/node_modules/'.length), dir.split('/')[2]]))
  }

  it('takes an alias for the shallowest parent first, then by directory', async () => {
    const lock = lockfile({ root: { dependencies: ['a', 'b'] }, graph: { 'a@1.0.0': { q: '1.0.0' }, 'b@1.0.0': { r: '1.0.0' }, 'r@1.0.0': { q: '2.0.0' }, 'q@1.0.0': {}, 'q@2.0.0': {} } })
    assert.deepEqual(await hoisted(lock), { q: 'q@1.0.0', r: 'r@1.0.0' })
  })

  // pnpm walks each level's next out to the bottom before the level's next
  // node's: `at` is reached under x2 at depth 3 before under y at depth 2,
  // so zs, at depth 2, hoists its q first, though `at` sorts before it.
  it('puts a node at the depth pnpm\'s walk first reaches it at', async () => {
    const graph = {
      'a@1.0.0': { x: '1.0.0' }, 'x@1.0.0': { x2: '1.0.0' }, 'x2@1.0.0': { at: '1.0.0' },
      'b@1.0.0': { y: '1.0.0' }, 'y@1.0.0': { at: '1.0.0', zs: '1.0.0' },
      'at@1.0.0': { q: '1.0.0' }, 'zs@1.0.0': { q: '2.0.0' }, 'q@1.0.0': {}, 'q@2.0.0': {},
    }
    const links = await hoisted(lockfile({ root: { dependencies: ['a', 'b'] }, graph }))
    assert.equal(links.q, 'q@2.0.0')
  })
})

// pnpm 12 hoists from a graph of every snapshot: it walks through opt,
// left out, though it hoists nothing of it, so opt's d@1 comes at depth 0,
// before g's d@2; holds back the root's s, left out, from u's s@2; and
// takes the nodes of one depth in the order of their directories' names,
// foo@1.0.0's before foo@1.0.0-rc.1's, which pnpm 11 has the other way.
describe('hoist for pnpm 12', () => {
  const graph = {
    'a@1.0.0': { z: '1.0.0' }, 'z@1.0.0': { d: '1.0.0' }, 'f@1.0.0': { g: '1.0.0' }, 'g@1.0.0': { d: '2.0.0' },
    'd@1.0.0': {}, 'd@2.0.0': {}, 'opt@1.0.0': { d: '1.0.0' }, 's@1.0.0': {}, 's@2.0.0': {}, 'u@1.0.0': { s: '2.0.0' },
    'p@1.0.0': { foo: '1.0.0' }, 'q@1.0.0': { foo: '1.0.0-rc.1' }, 'foo@1.0.0': { x: '1.0.0' }, 'foo@1.0.0-rc.1': { x: '2.0.0' }, 'x@1.0.0': {}, 'x@2.0.0': {},
  }
  const lock = lockfile({ root: { dependencies: ['a', 'f', 'u', 'p', 'q'], optionalDependencies: ['opt', 's'] }, graph })
  const hoisted = async (major) => {
    const { nodes, direct, hoisting } = await buildGraph(lock, new Set(['opt@1.0.0', 's@1.0.0']), 120, major)
    const links = hoist(new Map([...nodes.values()].map((node) => [node.dir, node])), direct, settings, new Map(), major, hoisting)
    return Object.fromEntries([...links].map(([path, dir]) => [path.slice('node_modules/.pnpm/node_modules/'.length), dir.split('/')[2]]))
  }

  it('hoists as pnpm 12 does, and pnpm 11 otherwise', async () => {
    const both = { z: 'z@1.0.0', g: 'g@1.0.0', foo: 'foo@1.0.0' }
    assert.deepEqual(await hoisted(12), { ...both, d: 'd@1.0.0', x: 'x@1.0.0' })
    assert.deepEqual(await hoisted(11), { ...both, d: 'd@2.0.0', x: 'x@2.0.0', s: 's@2.0.0' })
  })

  it('refuses two projects whose names are one folded, both hoisted', async () => {
    const { nodes, direct, hoisting } = await buildGraph(lock, new Set(), 120, 12)
    const projects = new Map([['packages/a', 'Tool'], ['packages/b', 'tool']])
    assert.throws(() => hoist(nodes, direct, settings, projects, 12, hoisting), /^DeptreeError: manifests\["packages\/b"\]\.name: its name and "packages\/a"'s are one with their case folded, of which pnpm 12 hoists one by an order not known here$/u)
  })
})

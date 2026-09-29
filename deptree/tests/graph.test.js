import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parsePnpmLockfile } from '@preventive/lockfile/pnpm.js'
import { buildGraph } from '../src/pnpm/graph.js'
import { hoist } from '../src/pnpm/hoist.js'
import { createCheck, skippedSnapshots } from '../src/pnpm/install.js'
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
const check = createCheck({ host: HOST, settings: {} })

describe('skippedSnapshots', () => {
  // m cannot run here; k can, and is reached through m before n.
  const graph = { 'k@1.0.0': {}, 'm@1.0.0': { k: '1.0.0' }, 'n@1.0.0': { k: '1.0.0' } }
  const meta = { 'm@1.0.0': '    os: [darwin]\n' }
  const optional = { 'k@1.0.0': '    optional: true\n', 'm@1.0.0': '    optional: true\n', 'n@1.0.0': '    optional: true\n' }

  it('leaves out an optional package first reached through one left out, as pnpm does', () => {
    const lock = lockfile({ root: { optionalDependencies: ['m', 'n'] }, graph, meta, snapshotMeta: optional })
    assert.deepEqual([...skippedSnapshots(lock, check).skipped], ['m@1.0.0', 'k@1.0.0'])
  })

  it('keeps it where it is first reached through one kept', () => {
    const lock = lockfile({ root: { dependencies: ['n'], optionalDependencies: ['m'] }, graph, meta, snapshotMeta: optional })
    assert.deepEqual([...skippedSnapshots(lock, check).skipped], ['m@1.0.0'])
  })

  it('installs a package that is not optional, whatever the host', () => {
    const lock = lockfile({ root: { dependencies: ['m'] }, graph: { 'm@1.0.0': {} }, meta })
    assert.deepEqual([...skippedSnapshots(lock, check).skipped], [])
    const strict = createCheck({ host: HOST, settings: { engineStrict: true } })
    assert.throws(() => skippedSnapshots(lock, strict), /^DeptreeError: "m@1\.0\.0": the host does not take its os, cpu or libc/u)
  })

  it('leaves out an optional package whose engines.node the host\'s Node does not take', () => {
    const lock = lockfile({ root: { optionalDependencies: ['m'] }, graph: { 'm@1.0.0': {} }, meta: { 'm@1.0.0': '    engines: {node: \'>=99\'}\n' }, snapshotMeta: { 'm@1.0.0': '    optional: true\n' } })
    assert.deepEqual([...skippedSnapshots(lock, check).skipped], ['m@1.0.0'])
    const newer = createCheck({ host: HOST, settings: { nodeVersion: '99.0.0' } })
    assert.deepEqual([...skippedSnapshots(lock, newer).skipped], [])
  })
})

// pnpm 11 walks by edges: an optional one to what the host cannot run is
// not taken, and what a taken package requires is taken whatever the host.
describe('skippedSnapshots for pnpm 11', () => {
  const check11 = createCheck({ host: { ...HOST, major: 11 }, settings: {} })
  const skipped11 = (lock, by = check11) => [...skippedSnapshots(lock, by, { major: 11 }).skipped]
  const graph = { 'k@1.0.0': {}, 'm@1.0.0': { k: '1.0.0' }, 'n@1.0.0': { k: '1.0.0' } }
  const optional = { 'k@1.0.0': '    optional: true\n', 'm@1.0.0': '    optional: true\n', 'n@1.0.0': '    optional: true\n' }

  it('keeps what an installed package reaches, whichever way is walked first', () => {
    const lock = lockfile({ root: { optionalDependencies: ['m', 'n'] }, graph, meta: { 'm@1.0.0': '    os: [darwin]\n' }, snapshotMeta: optional })
    assert.deepEqual(skipped11(lock), ['m@1.0.0'])
  })

  it('installs what an installed optional package requires, whatever the host', () => {
    const lock = lockfile({ root: { optionalDependencies: ['p'] }, graph: { 'p@1.0.0': { c: '1.0.0' }, 'c@1.0.0': {} }, meta: { 'c@1.0.0': '    os: [darwin]\n' }, snapshotMeta: { 'p@1.0.0': '    optional: true\n', 'c@1.0.0': '    optional: true\n' } })
    assert.deepEqual(skipped11(lock), [])
    assert.deepEqual([...skippedSnapshots(lock, check).skipped], ['c@1.0.0'], 'pnpm 10 leaves it out')
    assert.deepEqual([...skippedSnapshots(lock, check11, { major: 11 }).incompatible], ['c@1.0.0'])
  })

  it('infers an optional package\'s platform from its name', () => {
    const lock = lockfile({ root: { optionalDependencies: ['bin-win32-x64', 'bin-linux-x64', 'bin-x64'] }, graph: { 'bin-win32-x64@1.0.0': {}, 'bin-linux-x64@1.0.0': {}, 'bin-x64@1.0.0': {} }, snapshotMeta: { 'bin-win32-x64@1.0.0': '    optional: true\n', 'bin-linux-x64@1.0.0': '    optional: true\n', 'bin-x64@1.0.0': '    optional: true\n' } })
    assert.deepEqual(skipped11(lock), ['bin-win32-x64@1.0.0'])
    assert.deepEqual([...skippedSnapshots(lock, check).skipped], [], 'pnpm 10 infers nothing')
  })

  it('takes a list of exclusions where the host is taken to be more than one thing', () => {
    const lock = lockfile({ root: { optionalDependencies: ['m'] }, graph: { 'm@1.0.0': {} }, meta: { 'm@1.0.0': '    os: [\'!win32\']\n' }, snapshotMeta: { 'm@1.0.0': '    optional: true\n' } })
    const wider = { supportedArchitectures: { os: ['current', 'darwin'] } }
    assert.deepEqual(skipped11(lock, createCheck({ host: { ...HOST, major: 11 }, settings: wider })), [])
    assert.deepEqual([...skippedSnapshots(lock, createCheck({ host: HOST, settings: wider })).skipped], ['m@1.0.0'], 'pnpm 10 counts the exclusions twice')
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

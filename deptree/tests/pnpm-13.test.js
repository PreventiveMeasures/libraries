import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { DeptreeError, buildPnpmTree } from '../pnpm.js'
import { HOST, stubRegistry, tarball } from './registry.js'

// A workspace of two projects, each with its own `c`, and `a`, a peer of
// which is `c`, so `a` has a snapshot for each; written as pnpm 12 writes
// it in v9 and in 13.0, which build the one tree. Then what is refused.

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const TARBALLS = await Promise.all([
  tarball('a', '1.0.0', { 'index.js': 'a' }, { manifest: { peerDependencies: { c: '^2.0.0' }, dependencies: { b: '1.0.0' } } }),
  tarball('b', '1.0.0'),
  tarball('c', '2.0.0'),
  tarball('c', '2.1.0'),
])
const [A, B, C20, C21] = TARBALLS.map((t) => t.integrity)
const HOST_12 = { ...HOST, pnpm: '12.21.0' }

const V9 = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .: {}

  p/x:
    dependencies:
      a:
        specifier: 1.0.0
        version: 1.0.0(c@2.0.0)
      c:
        specifier: 2.0.0
        version: 2.0.0

  p/y:
    dependencies:
      a:
        specifier: 1.0.0
        version: 1.0.0(c@2.1.0)
      c:
        specifier: 2.1.0
        version: 2.1.0

packages:

  a@1.0.0:
    resolution: {integrity: ${A}}
    peerDependencies:
      c: ^2.0.0

  b@1.0.0:
    resolution: {integrity: ${B}}

  c@2.0.0:
    resolution: {integrity: ${C20}}

  c@2.1.0:
    resolution: {integrity: ${C21}}

snapshots:

  a@1.0.0(c@2.0.0):
    dependencies:
      b: 1.0.0
      c: 2.0.0

  a@1.0.0(c@2.1.0):
    dependencies:
      b: 1.0.0
      c: 2.1.0

  b@1.0.0: {}

  c@2.0.0: {}

  c@2.1.0: {}
`

// As pnpm 12.21.0 writes it.
const V13 = `{
\t"lockfileVersion": "13.0",

\t"settings": {
\t\t"autoInstallPeers": true,
\t\t"excludeLinksFromLockfile": false,
\t},

\t"projects": {
\t\t".": {},

\t\t"p/x": {
\t\t\t"dependencies": {
\t\t\t\t"a": "1.0.0",
\t\t\t\t"c": "2.0.0",
\t\t\t},
\t\t},

\t\t"p/y": {
\t\t\t"dependencies": {
\t\t\t\t"a": "1.0.0",
\t\t\t\t"c": "2.1.0",
\t\t\t},
\t\t},
\t},

\t"packages": {
\t\t"a@1.0.0": {
\t\t\t"integrity": "${A}",
\t\t\t"peerDependencies": {
\t\t\t\t"c": "^2.0.0",
\t\t\t},
\t\t\t"dependencies": {
\t\t\t\t"b": "1.0.0",
\t\t\t},
\t\t\t"snapshots": [
\t\t\t\t{
\t\t\t\t\t"peerDependencies": {
\t\t\t\t\t\t"c": {
\t\t\t\t\t\t\t"version": "2.0.0",
\t\t\t\t\t\t},
\t\t\t\t\t},
\t\t\t\t},
\t\t\t\t{
\t\t\t\t\t"peerDependencies": {
\t\t\t\t\t\t"c": {
\t\t\t\t\t\t\t"version": "2.1.0",
\t\t\t\t\t\t},
\t\t\t\t\t},
\t\t\t\t},
\t\t\t],
\t\t},

\t\t"b@1.0.0": {
\t\t\t"integrity": "${B}",
\t\t},

\t\t"c@2.0.0": {
\t\t\t"integrity": "${C20}",
\t\t},

\t\t"c@2.1.0": {
\t\t\t"integrity": "${C21}",
\t\t},
\t},
}
`

const project = (name, c) => JSON.stringify({ name, version: '1.0.0', dependencies: { a: '1.0.0', c } })
const MANIFESTS = { '.': JSON.stringify({ name: 'root', private: true }), 'p/x': project('x', '2.0.0'), 'p/y': project('y', '2.1.0') }
const WORKSPACE = 'packages:\n  - p/*\n'

const build = (lockfile, { host = HOST_12, workspace = WORKSPACE, manifests = MANIFESTS } = {}) => {
  stubRegistry(TARBALLS)
  return buildPnpmTree({ lockfile, manifests, workspace, host })
}

// Each path, with a link's target.
const listing = (vfs) => [...vfs.walk('/')].map(({ path, type }) => (type === 'symlink' ? `${path} -> ${vfs.readlink(path)}` : `${path} ${type}`)).toSorted()

describe('a lockfile of 13.0', () => {
  it('builds the tree its v9 equivalent does', async () => {
    const { vfs, stats } = await build(V13)
    assert.deepEqual(listing(vfs), listing((await build(V9)).vfs))
    assert.deepEqual(vfs.readdir('/node_modules/.pnpm').filter((name) => name.startsWith('a@')), ['a@1.0.0_c@2.0.0', 'a@1.0.0_c@2.1.0'])
    assert.equal(vfs.readlink('/p/y/node_modules/a'), '../../../node_modules/.pnpm/a@1.0.0_c@2.1.0/node_modules/a')
    assert.equal(stats.snapshots, 5)
  })

  it('with lockfile.format set, which leaves the tree as it is, for either format', async () => {
    const workspace = `${WORKSPACE}lockfile:\n  format: v13\n`
    const expected = listing((await build(V9)).vfs)
    assert.deepEqual(listing((await build(V13, { workspace })).vfs), expected)
    assert.deepEqual(listing((await build(V9, { workspace })).vfs), expected)
  })

  it('as pnpm 12.20.0 and later read it alone', async () => {
    for (const pnpm of ['12.19.0', '12.8.1', '11.28.2']) {
      const reads = pnpm === '12.19.0' ? 'reads a snapshot named by its bindings otherwise' : 'does not read one'
      await assert.rejects(build(V13, { host: { ...HOST, pnpm } }), { name: 'DeptreeError', message: `lockfileVersion: a lockfile of 13.0 is built for as pnpm 12.20.0 and later read it, and pnpm "${pnpm}" ${reads}` })
    }
    await build(V13, { host: { ...HOST, pnpm: '12.20.0' } })
  })

  it('refuses lockfile.format before pnpm 12.19.0, and what the section records beside the graph', async () => {
    await assert.rejects(build(V9, { host: { ...HOST, pnpm: '12.18.0' }, workspace: `${WORKSPACE}lockfile:\n  format: v9\n` }), { message: 'pnpm-workspace.yaml: lockfile.format: pnpm "12.18.0" fails on it, which pnpm has from 12.19.0' })
    await assert.rejects(build(V13, { workspace: `${WORKSPACE}lockfile:\n  integrityTarget: tar\n` }), { message: 'pnpm-workspace.yaml: lockfile.integrityTarget: "tar" is not supported: what the lockfile records beside the graph is not read here' })
    await assert.rejects(build(V13, { workspace: `${WORKSPACE}lockfile:\n  format: v10\n` }), { message: 'pnpm-workspace.yaml: lockfile.format: expected one of v9, v13, found "v10"' })
    await assert.rejects(build(V13, { workspace: `${WORKSPACE}lockfile:\n  shape: v13\n` }), { message: 'pnpm-workspace.yaml: lockfile.shape: pnpm fails on a key of the lockfile section it does not know' })
    await assert.rejects(build(V13, { workspace: `${WORKSPACE}lockfile: false\n` }), DeptreeError)
  })

  it('refuses a directory whose package.json it records', async () => {
    const recorded = V13.replace('\t\t"b@1.0.0": {\n\t\t\t"integrity": "', '\t\t"d@file:d": {\n\t\t\t"specifiers": {\n\t\t\t\t"manifestSource": "path",\n\t\t\t},\n\t\t},\n\n\t\t"b@1.0.0": {\n\t\t\t"integrity": "')
      .replace('\t\t".": {},', '\t\t".": {\n\t\t\t"dependencies": {\n\t\t\t\t"d": "file:d",\n\t\t\t},\n\t\t},')
    const manifests = { ...MANIFESTS, '.': JSON.stringify({ name: 'root', private: true, dependencies: { d: 'file:d' } }) }
    await assert.rejects(build(recorded, { manifests }), { message: '"d@file:d": a directory whose package.json the lockfile records is not supported: pnpm holds a frozen install to it by a check of its own, which is not built here' })
  })
})

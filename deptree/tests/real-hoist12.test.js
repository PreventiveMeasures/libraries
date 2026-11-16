import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { packageKeyOf, parsePnpmLockfile } from '@preventive/lockfile/pnpm.js'
import { compareNames } from '@preventive/vfs/path.js'
import { hoisterTree as treeOf } from '../src/pnpm/hoisted.js'
import { hoist12 } from '../src/pnpm/real-hoist12.js'

// The tree pnpm 12 hoists, of a lockfile.
const hoisterTree = (lockfile) => treeOf(lockfile, true, { pnpm12: true })

// The tests of pnpm 12.21.0's real-hoist crate (src/tests/*.rs), each under
// its name there, and its self-check (resolution.rs), run on each hoist. The
// port hoists with autoInstallPeers and without hoistingLimits or
// externalDependencies, as deptree has pnpm 12 do, so those of the crate's
// tests of peers that autoInstallPeers leaves none of, of hoisting borders,
// of external dependencies, and of the functions under them, are left out:
// all of peer_bindings.rs, and of the rest each the port has no path for.

// resolution.rs, a port of upstream's selfCheck: each edge of the tree has
// to resolve, by Node's walk up the hoisted layout, to the locator the tree
// names. A name that nodes of one locator resolve to different locators is
// not checked. Both walks are on stacks, as a chain can be long.
function assertResolvesAsDeclared(tree, result) {
  const declared = new Map()
  const treeLocator = (node) => `${node.identName}@${node.reference}`
  const seen = new Set()
  for (const pending = [tree]; pending.length > 0;) {
    const node = pending.pop()
    if (seen.has(node)) continue
    seen.add(node)
    if (!declared.has(treeLocator(node))) declared.set(treeLocator(node), new Map())
    const edges = declared.get(treeLocator(node))
    for (const dep of node.dependencies) {
      edges.set(dep.name, edges.has(dep.name) && edges.get(dep.name) !== treeLocator(dep) ? null : treeLocator(dep))
      pending.push(dep)
    }
  }
  const resultLocator = (node) => `${node.identName}@${[...node.references][0] ?? ''}`
  const indexes = new Map()
  const childNamed = (dir, name) => {
    if (!indexes.has(dir)) indexes.set(dir, new Map([...dir.dependencies].toReversed().map((dep) => [dep.name, dep])))
    return indexes.get(dir).get(name)
  }
  const [errors, ancestors, stack] = [[], [], []]
  const enter = (node) => {
    if (ancestors.includes(node)) return
    for (const [name, expected] of declared.get(resultLocator(node)) ?? []) {
      if (expected === null) continue
      const found = [node, ...ancestors.toReversed()].map((dir) => childNamed(dir, name)).find((dep) => dep !== undefined)
      const resolved = found === undefined ? undefined : resultLocator(found)
      if (resolved !== expected) errors.push(`  ${[...ancestors, node].map((dir) => dir.name).join(' > ')} requires ${name}: declared ${expected}, resolved ${resolved}`)
    }
    ancestors.push(node)
    stack.push([...node.dependencies].values())
  }
  enter(result)
  while (stack.length > 0) {
    const { value, done } = stack.at(-1).next()
    if (done) {
      stack.pop()
      ancestors.pop()
    } else enter(value)
  }
  assert.ok(errors.length === 0, `the hoisted layout breaks resolution:\n${errors.join('\n')}`)
}

// hoist and nm_hoist (lib.rs) as the crate's tests run them, the result
// checked against the tree it was hoisted from.
function hoistTree(tree) {
  const result = hoist12(tree)
  assertResolvesAsDeclared(tree, result)
  return result
}

const hoist = (lockfile) => hoistTree(hoisterTree(lockfile))

const INTEGRITY = `sha512-${Buffer.alloc(64).toString('base64')}`
const q = JSON.stringify

// A pnpm-lock.yaml, as deptree reads it: `importers` by id, each kind of
// its dependencies by alias, by the version pnpm writes; `snapshots` by key,
// each with its `dependencies`, the same, and its
// transitivePeerDependencies; `peers` by package key, the peers each
// declares, its pkg_metadata_with_peer (tests.rs). A package of a version
// is a registry tarball, of `file:` and a tarball that file, and of any
// other `file:` that directory. The reader refuses a snapshot no importer
// reaches, which the crate's tests have now and then, and those are left
// out; nothing hoists them.
function lockfileOf({ importers = {}, snapshots = {}, peers = {} }) {
  const lines = ["lockfileVersion: '9.0'", '', `importers:${Object.keys(importers).length === 0 ? ' {}' : ''}`]
  for (const [id, kinds] of Object.entries(importers)) {
    lines.push(`  ${q(id)}:${Object.keys(kinds).length === 0 ? ' {}' : ''}`)
    for (const [kind, deps] of Object.entries(kinds)) {
      lines.push(`    ${kind}:`)
      for (const [alias, version] of Object.entries(deps)) lines.push(`      ${q(alias)}:`, `        specifier: ${q(version)}`, `        version: ${q(version)}`)
    }
  }
  const bases = [...new Set(Object.keys(snapshots).map(packageKeyOf))]
  lines.push('', `packages:${bases.length === 0 ? ' {}' : ''}`)
  for (const base of bases) {
    const ref = base.slice(base.indexOf('@', 1) + 1)
    if (!ref.startsWith('file:')) lines.push(`  ${q(base)}:`, `    resolution: {integrity: ${q(INTEGRITY)}}`)
    else if (ref.endsWith('.tgz')) lines.push(`  ${q(base)}:`, `    resolution: {tarball: ${q(ref)}}`, '    version: 1.0.0')
    else lines.push(`  ${q(base)}:`, `    resolution: {type: directory, directory: ${q(ref.slice('file:'.length))}}`)
    if (peers[base] !== undefined) lines.push('    peerDependencies:', ...peers[base].map((name) => `      ${q(name)}: "*"`))
  }
  lines.push('', `snapshots:${Object.keys(snapshots).length === 0 ? ' {}' : ''}`)
  for (const [key, snapshot] of Object.entries(snapshots)) {
    lines.push(`  ${q(key)}:${Object.keys(snapshot).length === 0 ? ' {}' : ''}`)
    for (const [field, value] of Object.entries(snapshot)) {
      if (Array.isArray(value)) lines.push(`    ${field}: [${value.map(q).join(', ')}]`)
      else lines.push(`    ${field}:`, ...Object.entries(value).map(([alias, ref]) => `      ${q(alias)}: ${q(ref)}`))
    }
  }
  return parsePnpmLockfile(`${lines.join('\n')}\n`).lockfile
}

const rootImporter = (dependencies) => ({ '.': { dependencies } })
const on = (dependencies) => ({ dependencies })

// tree_node and tree_root (tests.rs): hand-made nodes, for shapes the
// lockfile does not give, with no peers.
const treeNode = (name, reference, dependencies) => ({ name, identName: name, reference, dependencies: new Set(dependencies) })
const treeRoot = (dependencies) => ({ name: '.', identName: '.', reference: '', dependencies: new Set(dependencies) })

// child_of (tests.rs): the child of that name, else a failure naming those
// there are.
function childOf(parent, name) {
  const child = [...parent.dependencies].find((dep) => dep.name === name)
  if (child === undefined) assert.fail(`${parent.name} has no child ${name}, only ${q([...parent.dependencies].map((dep) => dep.name))}`)
  return child
}

const names = (node) => [...node.dependencies].map((dep) => dep.name).sort()
const referenceOf = (node) => [...node.references][0]

describe('behavior.rs', () => {
  it('deep chain flattens in one pass', () => {
    const result = hoist(lockfileOf({
      importers: rootImporter({ a: '1.0.0' }),
      snapshots: { 'a@1.0.0': on({ b: '1.0.0' }), 'b@1.0.0': on({ c: '1.0.0' }), 'c@1.0.0': on({ d: '1.0.0' }), 'd@1.0.0': {} },
    }))
    assert.deepEqual(names(result), ['a', 'b', 'c', 'd'], 'depth-4 chain flattens')
    for (const entry of result.dependencies) assert.equal(entry.dependencies.size, 0, `${entry.name} has no nested deps`)
  })

  it('transitive npm alias resolves target snapshot', () => {
    const result = hoist(lockfileOf({
      importers: rootImporter({ host: '1.0.0' }),
      snapshots: { 'host@1.0.0': on({ 'aliased-name': 'real-pkg@2.0.0' }), 'real-pkg@2.0.0': {} },
    }))
    assert.deepEqual(names(result), ['aliased-name', 'host'])
    const aliased = childOf(result, 'aliased-name')
    assert.equal(aliased.name, 'aliased-name')
    assert.equal(aliased.identName, 'real-pkg')
    assert.ok(aliased.references.has('real-pkg@2.0.0'), 'reference is the resolved snapshot key, not the alias')
    assert.equal(aliased.references.size, 1)
    assert.equal(childOf(result, 'host').dependencies.size, 0, 'host stripped of its aliased dep')
  })

  // A cycle inside a conflict-nested shared cluster must be cut, or the
  // layout walkers recurse without end.
  it('conflict nested shared cycle is cut', () => {
    const result = hoist(lockfileOf({
      importers: rootImporter({ x: '1.0.0', y: '1.0.0', c1: '1.0.0', c2: '1.0.0' }),
      snapshots: { 'c1@1.0.0': on({ x: '2.0.0' }), 'c2@1.0.0': on({ x: '2.0.0' }), 'x@2.0.0': on({ y: '2.0.0' }), 'y@2.0.0': on({ x: '2.0.0' }), 'x@1.0.0': {}, 'y@1.0.0': {} },
    }))
    const stack = [...result.dependencies].map((dep) => [dep, []])
    while (stack.length > 0) {
      const [node, path] = stack.pop()
      assert.ok(!path.includes(node), `cycle in hoister output through ${node.name}@${referenceOf(node)}`)
      for (const dep of node.dependencies) stack.push([dep, [...path, node]])
    }
  })

  // `b@1` exposes itself under the alias `c`: that is the only
  // node_modules/c, so it stays, but the alias copy's own edge repeats
  // both the alias and the locator, and is cut.
  it('self alias keeps its entry and only the alias repeat is cut', () => {
    const result = hoist(lockfileOf({ importers: rootImporter({ b: '1.0.0' }), snapshots: { 'b@1.0.0': on({ c: 'b@1.0.0' }) } }))
    assert.deepEqual(names(result), ['b', 'c'], 'the alias keeps its own node_modules entry instead of being cut as a cycle')
    for (const child of result.dependencies) assert.equal(child.dependencies.size, 0, 'the alias-repeat back-edge is cut')
  })

  it('ancestor conflict blocks dedup against the root copy', () => {
    const result = hoist(lockfileOf({
      importers: rootImporter({ a: '1.0.0', x: '1.0.0', b: '2.0.0' }),
      snapshots: { 'a@1.0.0': on({ x: '2.0.0', b: '1.0.0' }), 'b@1.0.0': on({ x: '1.0.0' }), 'b@2.0.0': {}, 'x@1.0.0': {}, 'x@2.0.0': {} },
    }))
    const bNested = childOf(childOf(result, 'a'), 'b')
    assert.ok(childOf(bNested, 'x').references.has('x@1.0.0'), 'b@1 keeps its own x@1 below a\'s conflicting x@2')
  })

  // From express in @teambit/bit's lockfile: send's ms@2 dedups against the
  // root, so the nested pass must not hoist debug's ms@1 onto express.
  it('nested root does not shadow names its subtree uses from above', () => {
    const result = hoist(lockfileOf({
      importers: rootImporter({ e: '1.0.0', m: '2.0.0', s: '2.0.0', d: '2.0.0' }),
      snapshots: { 'e@1.0.0': on({ d: '1.0.0', s: '1.0.0' }), 'd@1.0.0': on({ m: '1.0.0' }), 's@1.0.0': on({ m: '2.0.0' }), 'm@1.0.0': {}, 'm@2.0.0': {}, 's@2.0.0': {}, 'd@2.0.0': {} },
    }))
    const e = childOf(result, 'e')
    assert.ok(![...e.dependencies].some((dep) => dep.name === 'm'), 'm@1 must not hoist onto e - s@1\'s requires resolve m through the root')
    const dNested = childOf(e, 'd')
    assert.ok([...dNested.dependencies].some((dep) => dep.name === 'm' && dep.references.has('m@1.0.0')), 'd@1 keeps its own m@1 nested')
  })
})

describe('dependencies.rs', () => {
  it('version conflict keeps loser at parent', () => {
    const result = hoist(lockfileOf({
      importers: rootImporter({ a: '1.0.0', c: '1.0.0', d: '1.0.0' }),
      snapshots: { 'a@1.0.0': on({ b: '1.0.0' }), 'c@1.0.0': on({ b: '2.0.0' }), 'b@1.0.0': {}, 'b@2.0.0': on({ d: '2.0.0' }), 'd@1.0.0': {}, 'd@2.0.0': {} },
    }))
    assert.deepEqual(names(result), ['a', 'b', 'c', 'd'], 'root keeps its direct d and one b')
    const bAtRoot = childOf(result, 'b')
    assert.ok(bAtRoot.references.has('b@1.0.0'), 'first DFS visitor wins root slot')
    assert.equal(bAtRoot.references.size, 1, 'no other reference accumulated yet')
    const c = childOf(result, 'c')
    assert.equal(c.dependencies.size, 2, 'c kept b@2 and hoisted its conflicting d@2')
    const bUnderC = childOf(c, 'b')
    assert.ok(bUnderC.references.has('b@2.0.0'), 'loser stays under c')
    assert.equal(bUnderC.references.size, 1)
    assert.equal(bUnderC.dependencies.size, 0, 'b\'s descendants hoist to nested root c')
    assert.ok(childOf(c, 'd').references.has('d@2.0.0'), 'd@2 stays below the root\'s d@1 conflict')
  })

  // The most depended on version takes the root slot, though a less used
  // one is found first, as yarn's getHoistIdentMap has it.
  it('most used version wins root slot', () => {
    const result = hoist(lockfileOf({
      importers: rootImporter({ aa: '1.0.0', cc: '1.0.0', dd: '1.0.0' }),
      snapshots: { 'aa@1.0.0': on({ x: '1.0.0' }), 'cc@1.0.0': on({ x: '2.0.0' }), 'dd@1.0.0': on({ x: '2.0.0' }), 'x@1.0.0': {}, 'x@2.0.0': {} },
    }))
    assert.deepEqual(names(result), ['aa', 'cc', 'dd', 'x'], 'one x at root')
    assert.ok(childOf(result, 'x').references.has('x@2.0.0'), 'the more-used x@2.0.0 wins root over the first-visited x@1.0.0')
    const aa = childOf(result, 'aa')
    assert.equal(aa.dependencies.size, 1, 'aa keeps its conflicting x@1.0.0')
    assert.ok([...aa.dependencies][0].references.has('x@1.0.0'), 'the less-used x stays nested under aa')
  })

  // From teambit/bit's root components: two importers on one `file:`
  // package, pinning conflicting peers, each a copy of its own.
  it('file dep peer variants keep their own copies', () => {
    const importers = { '.': {} }
    const snapshots = {}
    for (const [id, peer] of [['node_modules/.bit_roots/r1', '1.0.0'], ['node_modules/.bit_roots/r2', '2.0.0']]) {
      importers[id] = { dependencies: { comp: `file:comp(p@${peer})`, p: peer } }
      Object.assign(snapshots, { [`comp@file:comp(p@${peer})`]: on({ p: peer }), [`p@${peer}`]: {} })
    }
    const result = hoist(lockfileOf({ importers, snapshots }))
    // Node resolution walks up from the importer: the copy it sees is the
    // one in its subtree, or the root's, where its variant was hoisted.
    const seenBy = (name) => {
      const importer = childOf(result, name)
      return referenceOf([...importer.dependencies].find((dep) => dep.name === 'comp') ?? childOf(result, 'comp'))
    }
    assert.equal(seenBy('node_modules%2F.bit_roots%2Fr1'), 'comp@file:comp(p@1.0.0)', 'r1 must resolve the copy carrying its own peer variant')
    assert.equal(seenBy('node_modules%2F.bit_roots%2Fr2'), 'comp@file:comp(p@2.0.0)', 'r2 must resolve the copy carrying its own peer variant')
  })

  it('file tarball peer variants collapse like registry packages', () => {
    const importers = { '.': {} }
    const snapshots = {}
    for (const [id, peer] of [['packages/a', '1.0.0'], ['packages/b', '2.0.0']]) {
      importers[id] = { dependencies: { tarpkg: `file:tarpkg.tgz(p@${peer})`, p: peer } }
      Object.assign(snapshots, { [`tarpkg@file:tarpkg.tgz(p@${peer})`]: on({ p: peer }), [`p@${peer}`]: {} })
    }
    const result = hoist(lockfileOf({ importers, snapshots }))
    assert.ok(childOf(result, 'tarpkg').references.has('tarpkg@file:tarpkg.tgz(p@1.0.0)'), 'the first-seen variant is the canonical reference')
    for (const importer of ['packages%2Fa', 'packages%2Fb']) {
      assert.ok(!names(childOf(result, importer)).includes('tarpkg'), 'a tarball peer variant must dedup against the root copy')
    }
  })

  // Both variants of md@1.0.0 share a locator: the one under the root's
  // nds@1.0.0 reaches the root in the first wave, before widget's is
  // walked, and keeps nds@1.0.0's core@1.0.0 nested beneath it.
  it('shallower peer variant wins the root slot and nests its own dep', () => {
    const snapshots = { 'apps@1.0.0': on({ widget: '1.0.0' }), 'widget@1.0.0': on({ core: '2.0.0', nds: '2.0.0' }) }
    for (const core of ['1.0.0', '2.0.0']) {
      Object.assign(snapshots, { [`nds@${core}`]: on({ core, md: `1.0.0(core@${core})` }), [`md@1.0.0(core@${core})`]: on({ core }), [`core@${core}`]: {} })
    }
    const lockfile = lockfileOf({ importers: rootImporter({ apps: '1.0.0', nds: '1.0.0' }), snapshots, peers: { 'md@1.0.0': ['core'] } })
    const result = hoist(lockfile)
    assert.deepEqual(names(result), ['apps', 'core', 'md', 'nds', 'widget'], 'one md at root')
    assert.ok(childOf(result, 'core').references.has('core@2.0.0'), 'the more-used core@2.0.0 takes the root slot')
    assert.ok(childOf(childOf(result, 'md'), 'core').references.has('core@1.0.0'), 'the root md is nds@1.0.0\'s variant and keeps its core@1.0.0 nested')
    assert.equal(childOf(result, 'nds').dependencies.size, 1, 'nds@1.0.0 keeps only its conflicting core@1.0.0; its md dedups against the root')
    const widget = childOf(result, 'widget')
    assert.ok(!names(widget).includes('md'), 'nds@2.0.0\'s md resolves from the root, not from widget')
    assert.equal(childOf(widget, 'nds').dependencies.size, 0, 'nds@2.0.0\'s md and core dedup against the root copies')
  })

  it('self dependency does not loop', () => {
    const result = hoist(lockfileOf({ importers: rootImporter({ a: '1.0.0' }), snapshots: { 'a@1.0.0': on({ a: '1.0.0' }) } }))
    assert.deepEqual([...result.dependencies].map((dep) => dep.name), ['a'], 'single a at root')
    assert.equal(childOf(result, 'a').dependencies.size, 0, 'self-edge stripped')
  })

  it('basic cyclic dependency terminates', () => {
    const result = hoist(lockfileOf({ importers: rootImporter({ a: '1.0.0' }), snapshots: { 'a@1.0.0': on({ b: '1.0.0' }), 'b@1.0.0': on({ a: '1.0.0' }) } }))
    assert.deepEqual(names(result), ['a', 'b'], 'both a and b flatten to root')
    assert.equal(childOf(result, 'a').dependencies.size, 0, 'a\'s b hoisted away')
    assert.equal(childOf(result, 'b').dependencies.size, 0, 'b\'s back-edge to a stripped')
  })
})

// generated.rs: random peer-dependency graphs shaped like pnpm lockfiles,
// each hoisted under the check, by the crate's generator, of a fixed seed
// each, fewer of them than its 20,000.
describe('generated.rs', () => {
  const NAMES = ['a', 'b', 'c', 'd', 'e', 'f']
  const VERSIONS = 2
  const SEEDS = 2000

  // Rng: a linear congruential generator over u64, so a failing seed
  // reproduces.
  const rngOf = (seed) => {
    let state = BigInt(seed)
    const below = (bound) => {
      state = BigInt.asUintN(64, state * 6_364_136_223_846_793_005n + 1_442_695_040_888_963_407n)
      return Number((state >> 33n) % BigInt(bound))
    }
    return { below, version: () => 1 + below(VERSIONS) }
  }

  // manifest and registry: each version's regular dependencies, on names
  // after its own only, so the graph has no cycles, and an optional peer.
  function manifest(rng, name) {
    const later = NAMES.keys().filter((dep) => dep > name).toArray()
    const deps = []
    for (const dep of later) if (rng.below(3) === 0) deps.push([dep, rng.version()])
    const peer = later.length > 0 && rng.below(2) === 0 ? name + 1 + rng.below(later.length) : undefined
    return [deps.filter(([dep]) => dep !== peer).toReversed(), peer]
  }
  function registryOf(rng) {
    const [dependencies, peer] = [new Map(), new Map()]
    for (const name of NAMES.keys()) {
      for (let version = 1; version <= VERSIONS; version++) {
        const [deps, peerName] = manifest(rng, name)
        dependencies.set(`${name},${version}`, deps)
        if (peerName !== undefined) peer.set(`${name},${version}`, peerName)
      }
    }
    return { dependencies, peer }
  }

  // build: a snapshot, its peers resolved as pnpm does, from the parent's
  // dependencies first, then each ancestor's (`scopes`, nearest first); a
  // peer from outside the node joins its reference's suffix, as
  // transitivePeerDependencies do. The node has no peers, as
  // autoInstallPeers leaves it: each is an edge, and only that.
  function build(registry, [name, version], scopes, snapshots) {
    const [external, children] = [new Map(), []]
    const peer = registry.peer.get(`${name},${version}`)
    const provider = peer === undefined ? undefined : scopes.values().map((scope) => scope.find((node) => node.name === NAMES[peer])).find((node) => node !== undefined)
    if (provider !== undefined) {
      external.set(provider.name, provider)
      children.push(provider)
    }
    for (const dependency of registry.dependencies.get(`${name},${version}`)) {
      const [child, childExternal] = build(registry, dependency, [[...children], ...scopes], snapshots)
      for (const [peerName, peerProvider] of childExternal) if (!children.includes(peerProvider)) external.set(peerName, peerProvider)
      children.push(child)
    }
    const sorted = [...external].sort(([a], [b]) => compareNames(a, b))
    const reference = `${NAMES[name]}@${version}${sorted.map(([, node]) => `(${node.reference})`).join('')}`
    if (!snapshots.has(reference)) snapshots.set(reference, treeNode(NAMES[name], reference, children))
    return [snapshots.get(reference), external]
  }

  function importer(seed) {
    const rng = rngOf(seed)
    const registry = registryOf(rng)
    const [snapshots, rootDeps] = [new Map(), []]
    for (const name of NAMES.keys().toArray().toReversed()) {
      if (rng.below(2) === 0) rootDeps.push(build(registry, [name, rng.version()], [[...rootDeps]], snapshots)[0])
    }
    return treeRoot(rootDeps)
  }

  it('generated peer graphs resolve as declared', () => {
    const failures = []
    for (let seed = 0; seed < SEEDS; seed++) {
      try {
        hoistTree(importer(seed))
      } catch (error) {
        failures.push([seed, error.message])
      }
    }
    assert.deepEqual(failures, [], `${failures.length} graphs break`)
  })
})

describe('workspace_settings_hoist_throws_on_broken.rs', () => {
  it('one transitive dep hoists to root', () => {
    const result = hoist(lockfileOf({ importers: rootImporter({ a: '1.0.0' }), snapshots: { 'a@1.0.0': on({ b: '1.0.0' }), 'b@1.0.0': {} } }))
    assert.equal(result.name, '.')
    assert.deepEqual(names(result), ['a', 'b'], 'both a and b sit at root')
    assert.equal(childOf(result, 'a').dependencies.size, 0, 'a\'s b moved to root')
  })

  it('diamond dep hoists once to root', () => {
    const result = hoist(lockfileOf({ importers: rootImporter({ a: '1.0.0', c: '1.0.0' }), snapshots: { 'a@1.0.0': on({ b: '1.0.0' }), 'c@1.0.0': on({ b: '1.0.0' }), 'b@1.0.0': {} } }))
    assert.deepEqual(names(result), ['a', 'b', 'c'], 'diamond flattens at root')
    assert.equal(childOf(result, 'a').dependencies.size, 0, 'a stripped of its b')
    assert.equal(childOf(result, 'c').dependencies.size, 0, 'c stripped of its b')
    const [bs, walked, stack] = [new Set(), new Set(), [...result.dependencies]]
    while (stack.length > 0) {
      const node = stack.pop()
      if (walked.has(node)) continue
      walked.add(node)
      if (node.name === 'b') bs.add(node)
      stack.push(...node.dependencies)
    }
    assert.equal(bs.size, 1, 'exactly one `b` allocation across the entire result graph')
  })

  // From @teambit/bit's lockfile: root holds b@1 and d@1; c1 and c2 share
  // one b@2, whose d@2 conflicts with the root's d@1, and which each has to
  // reach from its own copy.
  it('nested hoist keeps conflicting dep reachable from every parent of a shared node', () => {
    const result = hoist(lockfileOf({
      importers: rootImporter({ b: '1.0.0', d: '1.0.0', c1: '1.0.0', c2: '1.0.0' }),
      snapshots: { 'c1@1.0.0': on({ b: '2.0.0' }), 'c2@1.0.0': on({ b: '2.0.0' }), 'b@2.0.0': on({ d: '2.0.0' }), 'b@1.0.0': {}, 'd@1.0.0': {}, 'd@2.0.0': {} },
    }))
    assert.deepEqual(names(result), ['b', 'c1', 'c2', 'd'], 'root keeps its direct b@1 and d@1')
    const nested = ['c1', 'c2'].map((parentName) => {
      const parent = childOf(result, parentName)
      const b = childOf(parent, 'b')
      assert.ok(b.references.has('b@2.0.0'))
      const isD2 = (dep) => dep.name === 'd' && dep.references.has('d@2.0.0')
      assert.ok([...b.dependencies].some(isD2) || [...parent.dependencies].some(isD2), `d@2 is unreachable from ${parentName}'s subtree, so its b@2 would resolve d to the root's d@1`)
      return b
    })
    assert.notEqual(nested[0], nested[1], 'each parent gets its own decoupled b@2 copy')
  })

  // Peer-suffix variants of one version collapse onto the first seen, so
  // they dedup at the root. The reader refuses a peer in a key that nothing
  // of the snapshot explains, and the crate's test gives x none, so its
  // dependency on p is taken out after reading, and p with it.
  it('peer suffix variants collapse to one hoisted copy', () => {
    const lockfile = lockfileOf({
      importers: rootImporter({ c1: '1.0.0', c2: '1.0.0' }),
      snapshots: { 'c1@1.0.0': on({ x: '1.0.0(p@1.0.0)' }), 'c2@1.0.0': on({ x: '1.0.0(p@2.0.0)' }), 'x@1.0.0(p@1.0.0)': on({ p: '1.0.0' }), 'x@1.0.0(p@2.0.0)': on({ p: '2.0.0' }), 'p@1.0.0': {}, 'p@2.0.0': {} },
    })
    for (const peer of ['1.0.0', '2.0.0']) {
      delete lockfile.packages[`x@1.0.0(p@${peer})`].dependencies.p
      delete lockfile.packages[`p@${peer}`]
    }
    const result = hoist(lockfile)
    assert.deepEqual(names(result), ['c1', 'c2', 'x'], 'one hoisted x, no nested variant copies')
    for (const parent of ['c1', 'c2']) assert.equal(childOf(result, parent).dependencies.size, 0, 'the variant edge dedups against the root copy')
    assert.ok(childOf(result, 'x').references.has('x@1.0.0(p@1.0.0)'), 'the first-seen variant is the canonical reference')
  })
})

describe('workspace_settings_multi_importer_lockfile_emits.rs', () => {
  it('multi importer lockfile emits workspace children', () => {
    const result = hoist(lockfileOf({ importers: { '.': {}, 'packages/foo': {}, 'packages/bar': {} } }))
    const children = [...result.dependencies].map((child) => [child.name, referenceOf(child)]).sort(([a], [b]) => compareNames(a, b))
    assert.deepEqual(children, [['packages%2Fbar', 'workspace:packages/bar'], ['packages%2Ffoo', 'workspace:packages/foo']], 'non-root importers are encoded as Workspace children')
  })
})

// Not of the crate: what is held of the port beyond it.
describe('hoist12', () => {
  // tree.rs: each list of dependencies by alias, in byte order, then the
  // projects, by id; a project's `link:`s left out, and a project the
  // lockfile has no importer for.
  it('makes the tree in pnpm 12\'s order', () => {
    const lockfile = lockfileOf({
      importers: { '.': { dependencies: { b: '1.0.0', '@s/x': '1.0.0' }, devDependencies: { B: '1.0.0', linked: 'link:packages/z' } }, 'packages/z': {}, 'packages/a b': { optionalDependencies: { b: '1.0.0' } } },
      snapshots: { 'b@1.0.0': on({ zz: '1.0.0', aa: '1.0.0' }), '@s/x@1.0.0': {}, 'B@1.0.0': {}, 'zz@1.0.0': {}, 'aa@1.0.0': {} },
    })
    lockfile.importers['packages/made'] = { dependencies: {}, devDependencies: {}, optionalDependencies: {}, made: true }
    const tree = hoisterTree(lockfile)
    assert.deepEqual([...tree.dependencies].map((dep) => `${dep.name} ${dep.reference}`), ['@s/x @s/x@1.0.0', 'B B@1.0.0', 'b b@1.0.0', 'packages%2Fa%20b workspace:packages/a b', 'packages%2Fz workspace:packages/z'])
    const b = [...tree.dependencies].find((dep) => dep.name === 'b')
    assert.deepEqual([...b.dependencies].map((dep) => dep.name), ['aa', 'zz'])
    assert.equal([...childOf(tree, 'packages%2Fa%20b').dependencies][0], b, 'one node for an alias and snapshot key')
  })

  // A chain pnpm 12 recurses down once per package, on a stack here.
  it('hoists a chain of 20,000 packages flat', () => {
    const snapshots = {}
    for (let i = 0; i < 20_000; i++) snapshots[`a${i}@1.0.0`] = i + 1 < 20_000 ? on({ [`a${i + 1}`]: '1.0.0' }) : {}
    const result = hoist(lockfileOf({ importers: rootImporter({ a0: '1.0.0' }), snapshots }))
    assert.equal(result.dependencies.size, 20_000)
    assert.deepEqual([...result.dependencies].slice(0, 3).map((dep) => dep.name), ['a0', 'a1', 'a2'])
  })

  it('refuses a graph that takes more steps, or makes more copies of packages, than allowed', () => {
    const lockfile = lockfileOf({ importers: rootImporter({ a: '1.0.0', c: '1.0.0' }), snapshots: { 'a@1.0.0': on({ b: '1.0.0' }), 'c@1.0.0': on({ b: '2.0.0' }), 'b@1.0.0': {}, 'b@2.0.0': {} } })
    assert.throws(() => hoist12(hoisterTree(lockfile), { maxSteps: 10 }), { name: 'DeptreeError', message: 'lockfile: hoisting it takes more than 10 steps, which is not supported' })
    assert.throws(() => hoist12(hoisterTree(lockfile), { maxNodes: 3 }), { name: 'DeptreeError', message: 'lockfile: hoisting it makes more than 3 copies of packages, which is not supported' })
    const stats = {}
    hoist12(hoisterTree(lockfile), { stats })
    assert.ok(stats.steps > 10 && stats.nodes > 3)
  })
})

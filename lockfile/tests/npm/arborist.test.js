import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { after, describe, it } from 'node:test'
import { LockfileError } from '../../npm.js'
import { random } from '../random.js'
import { BASE, fixture, parse, registry, write } from './base.js'
import { Arborist, calcDepFlags, resetDepFlags } from './reference.js'

// Arborist, from the npm beside node, against this reader, over lockfiles
// whose dependencies and links are edited at random: each laid out with the
// package.json files npm reads beside it, loaded into npm's tree, and
// given the flags npm works out for it. Where npm finds every dependency
// met, and nothing extraneous, this reads the lockfile to the same edges
// and flags; where it does not, this refuses it. The seed is fixed, so a
// failure names its lockfile and comes back on a rerun.

const SOURCES = [BASE, ...['npm-11', 'npm-11-flags', 'npm-11-outside'].map((name) => JSON.parse(fixture(name)))]

const LISTS = ['dependencies', 'optionalDependencies', 'peerDependencies']
const FLAGS = ['dev', 'optional', 'devOptional', 'peer', 'extraneous', 'inBundle']

// What is refused here that npm takes: a package of another name than an
// alias asks for, a tarball the registry would not have
// under a package's name and version, and a package the lockfile does not
// say where it comes from, which npm then fetches by its name and version.
const OWN = /which npm does not check|is not the registry's tarball of|expected where it comes from/u

const TOP = mkdtempSync(join(tmpdir(), 'npm-arborist-'))
const ROOT = join(TOP, 'project')
after(() => rmSync(TOP, { recursive: true, force: true }))

const isImporter = (location) => !/(?:^|\/)node_modules\//u.test(location)
const folderOf = (location) => location.split('/').slice(location.split('/').at(-2)?.startsWith('@') ? -2 : -1).join('/')

// A dependency taken off a list, and the list where npm leaves it out empty.
function unlist(entry, list, name) {
  delete entry[list][name]
  if (Object.keys(entry[list]).length === 0 && list !== 'devDependencies') delete entry[list]
}

// An edit of the dependencies of one entry: one added, of a name the
// lockfile has, one dropped, or one moved to another list.
function changeDependencies({ next, pick }, lock) {
  const locations = Object.keys(lock.packages).filter((location) => !lock.packages[location].link)
  const location = pick(locations)
  const entry = lock.packages[location]
  const lists = isImporter(location) ? [...LISTS, 'devDependencies'] : LISTS
  const names = [...new Set(locations.filter((other) => other !== '').map(folderOf))]
  const listed = lists.flatMap((list) => Object.keys(entry[list] ?? {}).map((name) => [list, name]))
  const r = next()
  if (r < 0.4 || listed.length === 0) {
    const list = pick(lists)
    entry[list] = { ...entry[list], [pick(names)]: pick(['*', '', '^1.0.0', '>=0.0.0', '^7.0.0', 'latest', '6.0.0']) }
    if (list === 'peerDependencies' && next() < 0.5) entry.peerDependenciesMeta = { ...entry.peerDependenciesMeta, [Object.keys(entry[list]).at(-1)]: { optional: true } }
    return
  }
  const [list, name] = pick(listed)
  const spec = entry[list][name]
  unlist(entry, list, name)
  if (r < 0.7) return
  const other = pick(lists)
  entry[other] = { ...entry[other], [name]: spec }
}

const packagesOf = (lock) => Object.keys(lock.packages).filter((location) => !isImporter(location))
const installed = (lock) => packagesOf(lock).filter((location) => !lock.packages[location].link)

// A package moved, with what is in its node_modules, into the node_modules
// of another node, or out of its parent's.
function move({ pick }, lock) {
  if (packagesOf(lock).length === 0) return
  const from = pick(packagesOf(lock))
  const parent = pick(Object.keys(lock.packages).filter((location) => !lock.packages[location].link && location !== from && !location.startsWith(`${from}/`)))
  const to = `${parent === '' ? '' : `${parent}/`}node_modules/${folderOf(from)}`
  if (to in lock.packages) return
  for (const location of Object.keys(lock.packages)) {
    if (location !== from && !location.startsWith(`${from}/`)) continue
    lock.packages[`${to}${location.slice(from.length)}`] = lock.packages[location]
    delete lock.packages[location]
  }
}

// A package of another version, from the registry's tarball of it.
function version({ pick }, lock) {
  if (installed(lock).length === 0) return
  const location = pick(installed(lock))
  const entry = lock.packages[location]
  entry.version = pick(['1.0.0', '2.0.0', '3.0.1', '6.0.0', '7.0.0', '18.2.0'])
  if (entry.resolved?.startsWith('https://registry.npmjs.org/')) entry.resolved = registry(entry.name ?? folderOf(location), entry.version)
}

// A package that bundles one of its dependencies, or no longer does.
function bundle({ pick }, lock) {
  if (installed(lock).length === 0) return
  const location = pick(installed(lock))
  const entry = lock.packages[location]
  const names = Object.keys({ ...entry.dependencies, ...entry.optionalDependencies })
  if (entry.bundleDependencies !== undefined || names.length === 0) delete entry.bundleDependencies
  else entry.bundleDependencies = [pick(names)]
}

// A package in whose node_modules there is nothing, gone.
function drop({ pick }, lock) {
  const leaves = packagesOf(lock).filter((location) => !Object.keys(lock.packages).some((other) => other.startsWith(`${location}/`)))
  if (leaves.length > 0) delete lock.packages[pick(leaves)]
}

// A link, in the node_modules of a node, to a package elsewhere, which the
// node asks for.
function linkTo({ pick }, lock) {
  if (installed(lock).length === 0) return
  const target = pick(installed(lock))
  const parent = pick(Object.keys(lock.packages).filter((location) => !lock.packages[location].link))
  const location = `${parent === '' ? '' : `${parent}/`}node_modules/${folderOf(target)}`
  if (location in lock.packages) return
  lock.packages[location] = { resolved: target, link: true }
  lock.packages[parent].dependencies = { ...lock.packages[parent].dependencies, [folderOf(target)]: '*' }
}

// Every dependency on one package gone, so that npm may keep it for a
// link into its node_modules alone.
function unask({ pick }, lock) {
  if (installed(lock).length === 0) return
  const name = folderOf(pick(installed(lock)))
  for (const entry of Object.values(lock.packages)) for (const list of [...LISTS, 'devDependencies']) if (entry[list]?.[name] !== undefined) unlist(entry, list, name)
}

function change(rand, lock) {
  if (rand.next() < 0.2) return linkTo(rand, lock)
  if (rand.next() < 0.15) return unask(rand, lock)
  const r = rand.next()
  if (r < 0.5) changeDependencies(rand, lock)
  else if (r < 0.65) move(rand, lock)
  else if (r < 0.8) version(rand, lock)
  else if (r < 0.9) bundle(rand, lock)
  else drop(rand, lock)
}

// The package.json npm reads for each directory of the lockfile.
function lay(lock) {
  rmSync(TOP, { recursive: true, force: true })
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (!isImporter(location)) continue
    const manifest = { name: entry.name ?? (location === '' ? 'project' : folderOf(location)), version: entry.version }
    for (const field of ['workspaces', ...LISTS, 'devDependencies', 'peerDependenciesMeta', 'bundleDependencies']) if (entry[field] !== undefined) manifest[field] = entry[field]
    mkdirSync(join(ROOT, location), { recursive: true })
    writeFileSync(join(ROOT, location, 'package.json'), JSON.stringify(manifest))
  }
}

// The tree npm loads, its flags worked out anew, and what npm makes of it:
// whether it would install as the lockfile says, and each edge. npm looks
// for a dependency that is not met from every node the project reaches
// (buildIdealTree's initTree), a bundled one too, and through links into
// the directories in the project (its resolveLinks), but for one a package
// bundles, and for an optional peer, which npm ci takes as it is.
async function npmOf(lock) {
  lay(lock)
  writeFileSync(join(ROOT, 'package-lock.json'), write(lock))
  const tree = await new Arborist({ path: ROOT }).loadVirtual()
  resetDepFlags(tree)
  calcDepFlags(tree)
  const nodes = [...tree.inventory.values()]
  let met = nodes.every((node) => !node.extraneous)
  const seen = new Set([tree])
  const queue = [tree]
  while (queue.length > 0) {
    const node = queue.pop()
    const bundled = node.isProjectRoot || node.isWorkspace ? [] : node.package.bundleDependencies ?? []
    for (const edge of node.edgesOut.values()) {
      if (!bundled.includes(edge.name) && edge.type !== 'peerOptional' && (edge.to === null || !edge.valid)) met = false
      const to = edge.to?.target
      if (to === undefined || seen.has(to) || !to.isDescendantOf(tree)) continue
      seen.add(to)
      queue.push(to)
    }
  }
  return { tree, nodes, met }
}

// The lockfile with the flags npm writes for its tree, and with nothing
// of where a package comes from that a tarball bundles, as npm writes what
// it loads from one.
function flagged(lock, nodes) {
  const flags = structuredClone(lock)
  for (const node of nodes) {
    const entry = flags.packages[node.location]
    if (entry === undefined || entry.link) continue
    for (const flag of FLAGS) delete entry[flag]
    if (node.extraneous) entry.extraneous = true
    else for (const flag of ['dev', 'optional', 'peer']) if (node[flag]) entry[flag] = true
    if (!node.extraneous && node.devOptional && !node.dev && !node.optional) entry.devOptional = true
    if (node.inBundle && !node.isLink) entry.inBundle = true
    if (node.inDepBundle && !node.isLink) {
      delete entry.resolved
      delete entry.integrity
    }
  }
  return flags
}

const targetOf = (to) => (to === null ? undefined : to.isLink ? `link:${to.target.location}` : to.location)

function compare(lock, { nodes, met }) {
  let read
  try {
    read = parse(write(lock))
  } catch (error) {
    if (!(error instanceof LockfileError)) throw error
    if (met) assert.match(error.message, OWN, `npm installs it as it is, refused here: ${error.message}`)
    return false
  }
  assert.ok(met, 'npm finds a dependency unmet, or a package extraneous, and it is read here')
  for (const node of nodes) {
    if (node.isLink) continue
    const ours = node.location === '' ? read.importers['.'] : read.importers[node.location] ?? read.packages[node.location]
    for (const flag of ['dev', 'optional', 'peer']) assert.equal(ours[flag], node[flag], `${flag} of ${node.location}`)
    assert.equal(ours.devOptional, node.devOptional || node.dev || node.optional, `devOptional of ${node.location}`)
    for (const edge of node.edgesOut.values()) {
      // npm gives a workspace's edge its absolute path.
      const spec = edge.type === 'workspace' ? `file:${relative(ROOT, edge.spec.slice(5))}` : edge.spec
      const theirs = { type: edge.type, spec, target: targetOf(edge.to) }
      const mine = ours.edges[edge.name]
      assert.deepEqual({ type: mine.type, spec: mine.spec, target: mine.target }, theirs, `${edge.name} of ${node.location}`)
    }
    assert.equal(Object.keys(ours.edges).length, node.edgesOut.size, `the edges of ${node.location}`)
  }
  return true
}

describe('whatever npm installs as the lockfile says, is read to the same tree here', () => {
  it('the lockfiles as npm flags them', async () => {
    for (const source of SOURCES) {
      const npm = await npmOf(source)
      assert.equal(compare(flagged(source, npm.nodes), npm), true)
    }
  })

  it('the lockfiles with their dependencies edited', async () => {
    const rand = random(0xA4B0)
    let read = 0
    for (let i = 0; i < 150; i++) {
      const lock = structuredClone(rand.pick(SOURCES))
      for (let edits = 1 + Math.floor(rand.next() * 2); edits > 0; edits--) change(rand, lock)
      let npm
      try {
        npm = await npmOf(lock)
      } catch (error) {
        // A link to what an edit took away, which npm refuses to load.
        assert.throws(() => parse(write(lock)), LockfileError, error.message)
        continue
      }
      if (compare(flagged(lock, npm.nodes), npm)) read++
    }
    assert.ok(read > 30, `only ${read} lockfiles were read`)
  })
})

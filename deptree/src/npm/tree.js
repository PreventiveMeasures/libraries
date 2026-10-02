// The tree `npm ci --ignore-scripts` makes, but node_modules/.bin and npm's
// node_modules/.package-lock.json.

import { parseNpmLockfile } from '@preventive/lockfile/npm.js'
import { Vfs } from '@preventive/vfs'
import { dirname, relative } from '@preventive/vfs/path.js'
import { satisfies, valid, validRange } from '@preventive/upstream/semver.js'
import { eachConcurrently } from '../concurrent.js'
import { DeptreeError, quote } from '../error.js'
import { checkCollisions, checkNoModules, mount, writeFiles } from '../mount.js'
import { fixBins } from './bins.js'
import { skippedOf } from './compat.js'
import { graphOf } from './graph.js'
import { checkHost, inputsOf } from './inputs.js'
import { checkManifests, recalculates, rootEdgesOf } from './manifests.js'
import { fetchNpmPackage, registryTarball } from './package.js'
import { checkRatio } from './ratio.js'

const whereOf = (node) => `packages[${quote(node.location)}]`

function checkLinks(lockfile) {
  for (const [location, target] of Object.entries(lockfile.links)) {
    const where = `packages[${quote(location)}]`
    const importer = lockfile.importers[target]
    if (!importer?.workspace) throw new DeptreeError(`a link to ${importer === undefined ? 'a package' : 'the project'} is not supported`, where)
    if (location !== `node_modules/${importer.name}`) throw new DeptreeError(`a workspace linked other than as node_modules/${importer.name} is not supported`, where)
  }
}

const LISTS = { prod: 'dependencies', optional: 'optionalDependencies', dev: 'devDependencies', peer: 'peerDependencies', peerOptional: 'peerDependencies', workspace: 'workspaces' }
const WILDCARD = /(?:^|[^\w-])[*Xx]\.\d/u

// semver 7.8.4 (npm 11.17 on) reads `1.x.0` otherwise; npm 10 resolves an
// unmet optional peer again, where npm 11 takes it as it is.
function checkSpecs(lockfile, host) {
  for (const [location, pkg] of [...Object.entries(lockfile.importers), ...Object.entries(lockfile.packages)]) {
    for (const [name, { type, spec, accept, target }] of Object.entries(pkg.edges)) {
      const where = `packages[${quote(location === '.' ? '' : location)}].${LISTS[type]}[${quote(name)}]`
      const ranges = [spec, accept].filter((range) => range !== undefined)
      if (ranges.some((range) => WILDCARD.test(range))) throw new DeptreeError(`${quote(spec)} has a wildcard before a number, which npm's releases read otherwise`, where)
      if (!host.reuse || type !== 'peerOptional' || target === undefined) continue
      const { version } = target.startsWith('link:') ? lockfile.importers[target.slice(5)] : lockfile.packages[target]
      if (!ranges.some((range) => validRange(range, true) !== null && satisfies(version ?? '', range, true))) {
        throw new DeptreeError(`${quote(spec)} is an optional peer the lockfile does not meet, which npm 10 resolves again`, where)
      }
    }
  }
}

// Every URL is checked before any is fetched.
async function fetchAll(nodes, host) {
  const tarballs = new Map()
  for (const node of nodes) {
    const tarball = registryTarball(node.pkg, whereOf(node))
    const key = `${tarball.name}@${tarball.version} ${tarball.integrity}`
    if (!tarballs.has(key)) tarballs.set(key, { tarball, where: whereOf(node), nodes: [] })
    tarballs.get(key).nodes.push(node)
  }
  const fetched = new Map()
  await eachConcurrently(tarballs.values(), async ({ tarball, where, nodes: copies }) => {
    const pkg = { ...await fetchNpmPackage(tarball, where, host.ratio ? checkRatio : undefined), integrity: tarball.integrity }
    for (const node of copies) fetched.set(node, pkg)
  }, ({ where }) => where)
  return { fetched, tarballs: tarballs.size }
}

// npm 10 makes every package's directory before leaving out those the host
// cannot run, and leaves the directories they were in.
function residueOf(nodes, skipped) {
  const removed = [...skipped].map((node) => node.location)
  const inRemoved = (dir) => removed.some((location) => dir === location || dir.startsWith(`${location}/`))
  const dirs = new Set()
  for (const location of removed) {
    for (let dir = dirname(location); dir !== '.' && !nodes.has(dir) && !inRemoved(dir); dir = dirname(dir)) dirs.add(dir)
  }
  return dirs
}

function writeTree({ lockfile, kept, fetched, changed, residue }) {
  const vfs = new Vfs()
  const stats = { files: 0, bytes: 0, links: 0 }
  for (const node of kept) {
    const { files, dirs } = fetched.get(node)
    const fixed = changed.get(node.location)
    vfs.mkdir(`/${node.location}`, { recursive: true })
    writeFiles(vfs, node.location, { dirs, files: fixed === undefined ? files : new Map([...files].map(([path, file]) => [path, fixed.get(path) ?? file])) }, stats)
  }
  for (const [location, target] of Object.entries(lockfile.links)) {
    vfs.mkdir(`/${dirname(location)}`, { recursive: true })
    vfs.symlink(relative(`/${dirname(location)}`, `/${target}`), `/${location}`)
    stats.links++
  }
  for (const dir of residue) vfs.mkdir(`/${dir}`, { recursive: true })
  return { vfs, stats }
}

// The lockfile reader refuses what does not parse.
function rootListsOf(text) {
  try {
    return JSON.parse(text)?.packages?.[''] ?? {}
  } catch {
    return {}
  }
}

export async function buildNpmTree(options) {
  const { host: given, vfs: into } = options ?? {}
  if (into !== undefined && !(into instanceof Vfs)) throw new TypeError('vfs must be a Vfs, or left out')
  const host = checkHost(given)
  const folded = host.os === 'darwin'
  const inputs = inputsOf(options ?? {}, folded)
  // Refused before anything is fetched; mount checks again.
  if (into !== undefined) checkNoModules(into, folded)
  const { settings, manifests } = inputs
  const rootEdges = rootEdgesOf(manifests, settings)
  // npm 10 takes the lockfile's flags as written, where it can.
  const recalculated = !host.reuse || recalculates(rootListsOf(inputs.lockfile), rootEdges)
  const lockfile = parseNpmLockfile(inputs.lockfile, { semver: { satisfies, valid, validRange }, legacyPeerDeps: settings.legacyPeerDeps, npm: recalculated ? host.npm : undefined })
  checkManifests({ lockfile, manifests, settings, host, rootEdges })
  checkLinks(lockfile)
  checkSpecs(lockfile, host)
  const nodes = graphOf(lockfile, manifests)
  const skipped = skippedOf(nodes, host, settings)
  const kept = [...nodes.values()].filter((node) => node.kind === 'package' && !skipped.has(node))
  const { fetched, tarballs } = await fetchAll(kept, host)
  const changed = settings.binLinks ? fixBins(kept, fetched) : new Map()
  const residue = host.reuse ? residueOf(nodes, skipped) : new Set()
  const { vfs, stats: written } = writeTree({ lockfile, kept, fetched, changed, residue })
  if (folded) checkCollisions(vfs)
  const packages = Object.keys(lockfile.packages).length
  const stats = { packages, installed: kept.length, skipped: packages - kept.length, tarballs, ...written }
  const installed = kept.map((node) => {
    const { name, version, dev, optional, devOptional, peer } = node.pkg
    return { path: node.location, name, version, integrity: fetched.get(node).integrity, dev, optional, devOptional, peer }
  })
  if (into !== undefined) mount(vfs, into, folded)
  return { vfs: into ?? vfs, stats, installed }
}

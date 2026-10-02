// A node_modules tree as `npm ci --ignore-scripts` makes it in a project
// with no node_modules yet: the lockfile read and held to the project's
// package.json files (manifests.js), an optional package the host cannot
// run left out with what only it needs (compat.js), each package's files
// unpacked where the lockfile puts it (package.js) and its bins' targets
// fixed as linking them fixes them (bins.js), and each workspace linked
// where the lockfile links it. Not written: node_modules/.bin, npm's own
// node_modules/.package-lock.json, and anything a script would build.

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

// Only a workspace, linked in the project's own node_modules by its name.
function checkLinks(lockfile) {
  for (const [location, target] of Object.entries(lockfile.links)) {
    const importer = lockfile.importers[target]
    if (importer === undefined) throw new DeptreeError('a link to a package is not supported', `packages[${quote(location)}]`)
    if (location !== `node_modules/${importer.name}`) throw new DeptreeError(`a workspace linked other than as node_modules/${importer.name} is not supported`, `packages[${quote(location)}]`)
  }
}

// Each tarball once, every URL checked before any is fetched.
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

// npm 10 makes a directory for every package before it leaves out those
// the host cannot run, and leaves the directories they were in.
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

export async function buildNpmTree(options) {
  const { host: given, vfs: into } = options ?? {}
  if (into !== undefined && !(into instanceof Vfs)) throw new TypeError('vfs must be a Vfs, or left out')
  const inputs = inputsOf(options ?? {})
  const host = checkHost(given)
  const folded = host.os === 'darwin'
  // Refused before anything is fetched; mount checks again.
  if (into !== undefined) checkNoModules(into, folded)
  const { settings, manifests } = inputs
  const rootEdges = rootEdgesOf(manifests, settings)
  // npm 10 takes the lockfile's flags as written, where it can.
  const recalculated = !host.reuse || recalculates(JSON.parse(inputs.lockfile).packages?.[''] ?? {}, rootEdges)
  const lockfile = parseNpmLockfile(inputs.lockfile, { semver: { satisfies, valid, validRange }, legacyPeerDeps: settings.legacyPeerDeps, npm: recalculated ? host.npm : undefined })
  checkManifests({ lockfile, manifests, settings, host, rootEdges })
  checkLinks(lockfile)
  const nodes = graphOf(lockfile, manifests)
  const skipped = skippedOf(nodes, host, settings)
  const kept = [...nodes.values()].filter((node) => node.kind === 'package' && !skipped.has(node))
  const { fetched, tarballs } = await fetchAll(kept, host)
  const changed = settings.binLinks ? fixBins(new Map(kept.map((node) => [node.location, { pkg: node.pkg, ...fetched.get(node) }]))) : new Map()
  const residue = host.reuse ? residueOf(nodes, skipped) : new Set()
  const { vfs, stats: written } = writeTree({ lockfile, kept, fetched, changed, residue })
  if (folded) checkCollisions(vfs)
  const stats = { packages: Object.keys(lockfile.packages).length, installed: kept.length, skipped: Object.keys(lockfile.packages).length - kept.length, tarballs, ...written }
  const installed = kept.map((node) => {
    const { name, version, dev, optional, devOptional, peer } = node.pkg
    return { path: node.location, name, version, integrity: fetched.get(node).integrity, dev, optional, devOptional, peer }
  })
  if (into !== undefined) mount(vfs, into, folded)
  return { vfs: into ?? vfs, stats, installed }
}

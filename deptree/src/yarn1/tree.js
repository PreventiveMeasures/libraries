// A node_modules tree as `yarn install --frozen-lockfile --ignore-scripts`
// makes it in a directory with no node_modules yet. Not written:
// node_modules/.bin, yarn's .yarn-integrity, and anything a script builds.

import { parseYarn1Lockfile } from '@preventive/lockfile/yarn1.js'
import { Vfs } from '@preventive/vfs'
import { compareNames, dirname, relative } from '@preventive/vfs/path.js'
import { clean, satisfies, valid, validRange } from '@preventive/upstream/semver.js'
import { eachConcurrently } from '../concurrent.js'
import { DeptreeError, quote } from '../error.js'
import { checkNoModules, isInside, makeDirs, mount, writeFiles, writeLink } from '../mount.js'
import { typeOf } from '../project.js'
import { fetchingOf } from '../tarball.js'
import { checkBinLinks } from './bins.js'
import { incompatibility } from './compat.js'
import { Hoister } from './hoist.js'
import { checkHost, inputsOf } from './inputs.js'
import { checkRoot, fixLists } from './manifest.js'
import { checkSha1, checkShared, fetchYarnPackage, readYarnDirectory, registryTarball } from './package.js'
import { resolvePeers } from './peers.js'
import { AGGREGATOR, aggregatorOf, rulesOf, topRequests, workspacesOf } from './requests.js'
import { resolve, splitPattern } from './resolve.js'

const whereOf = (ref) => quote(ref.patterns[0])

// The basenames yarn's copy passes over, wherever they are in a package.
const IGNORED = new Set(['.bin', '.yarn-metadata.json', '.yarn-tarball.tgz'])
const skipped = (path) => path.split('/').some((segment) => IGNORED.has(segment))

function fetchedName(ref) {
  const { range } = splitPattern(ref.patterns[0])
  return range.startsWith('npm:') ? splitPattern(range.slice(4)).name : ref.name
}

// The first of each place in `first` is fetched, and every entry held to it.
async function fetchAll(refs, first, fetching) {
  const fetched = new Map()
  const times = new Map()
  const tarballs = new Map(refs.map((ref) => [ref, registryTarball(ref.entry, fetchedName(ref), whereOf(ref))]))
  await eachConcurrently([...first.values()], async (ref) => {
    fetched.set(ref, await fetchYarnPackage(tarballs.get(ref), whereOf(ref), times, fetching))
  }, whereOf)
  for (const ref of refs) {
    const head = first.get(ref.loc)
    if (head !== ref) await checkShared(tarballs.get(ref), fetched.get(head), whereOf(ref), times)
  }
  return fetched
}

// Each file: directory, read from the project. yarn copies one into a place
// of its cache of its own each time it is asked for, as another package.
function readDirectories(order, project, fetched) {
  const read = new Set()
  for (const ref of order) {
    if (ref.kind !== 'directory') continue
    if (project === undefined) throw new DeptreeError('a file: directory is read from the project, which is not given', whereOf(ref))
    if (read.has(ref.dir)) throw new DeptreeError(`${quote(ref.dir)} is asked for by another pattern too, which yarn copies as another package, and which is not supported`, whereOf(ref))
    read.add(ref.dir)
    fetched.set(ref, readYarnDirectory(project, ref, whereOf(ref)))
  }
  return read.size
}

// Under the aggregator, a package goes in its workspace's node_modules.
function locationOf(names, workspaces) {
  if (names[0] === AGGREGATOR) return `${workspaces.get(names[1]).dir}/node_modules/${names.slice(2).join('/node_modules/')}`
  return `node_modules/${names.join('/node_modules/')}`
}

function resolveProject(inputs, host) {
  const lockfile = parseYarn1Lockfile(inputs.lockfile, { manifests: Object.fromEntries(inputs.manifests), semver: { clean, satisfies, valid, validRange } })
  const manifests = new Map([...inputs.manifests].map(([dir, manifest]) => [dir, fixLists(manifest)]))
  const root = manifests.get('.')
  const workspaces = workspacesOf(manifests)
  if (workspaces.size > 0) workspaces.set(AGGREGATOR, aggregatorOf(root, workspaces))
  const rules = rulesOf(root)
  const { requests, asked } = topRequests(root, workspaces, rules)
  const reason = incompatibility(root, host, 'manifests["."]', inputs.settings)
  if (reason !== undefined) throw new DeptreeError(reason, 'manifests["."]')
  const { project } = inputs
  const isDirectory = project === undefined ? () => undefined : (tag) => typeOf(project, `/${tag}/package.json`) !== undefined
  return { workspaces, asked, resolved: resolve({ lockfile, workspaces, rules, top: requests, isDirectory }) }
}

// As in yarn, every package is fetched before any is checked, in the order
// its resolver hands them over. Of two its cache keeps in one place, only the
// first is fetched; the rest keep their lockfile entry as package.json, with
// no peers, bins, platforms or engines, and the first's files, and their
// hashes are held to the first's tarball.
async function fetchChecked(resolved, host, settings, project, fetching) {
  const order = [...new Set(resolved.patterns.values())]
  const registry = order.filter((ref) => ref.kind === 'registry')
  const first = new Map()
  for (const ref of registry) if (!first.has(ref.loc)) first.set(ref.loc, ref)
  const fetched = await fetchAll(registry, first, fetching)
  const directories = readDirectories(order, project, fetched)
  const manifestOf = new Map()
  for (const ref of order) {
    let manifest = ref.workspace?.manifest
    if (ref.kind === 'registry') {
      const head = first.get(ref.loc)
      checkSha1(ref.entry.resolution.sha1, fetched.get(head).sha1, whereOf(ref))
      fetched.set(ref, fetched.get(head))
      ref.hasBins = head === ref && fetched.get(ref).hasBins
      manifest = head === ref ? fixLists(fetched.get(ref).manifest) : { name: ref.name, version: ref.version }
    } else if (ref.kind === 'directory') {
      ref.hasBins = fetched.get(ref).hasBins
      manifest = fixLists(fetched.get(ref).manifest)
    }
    const bundled = manifest.bundleDependencies ?? manifest.bundledDependencies
    if (bundled && !(Array.isArray(bundled) && bundled.length === 0)) throw new DeptreeError('a package with bundled dependencies is not supported', whereOf(ref))
    manifestOf.set(ref, manifest)
  }
  for (const ref of order) {
    const reason = incompatibility(manifestOf.get(ref), host, whereOf(ref), settings)
    if (reason === undefined) continue
    if (!ref.optional) throw new DeptreeError(`${reason}, and it is not optional, which yarn fails on`, whereOf(ref))
    ref.incompatible = true
  }
  return { packages: first.size + directories, fetched, manifestOf }
}

// Sorted as yarn's linker sorts its absolute paths, all under one directory,
// by localeCompare in Node's locale; that changes nothing written, as a link
// sorts before what is beneath it in any locale.
function layout({ resolved, manifestOf, asked, workspaces }) {
  resolvePeers(resolved, manifestOf)
  for (const ref of manifestOf.keys()) ref.dependencies = ref.asked.map(({ pattern }) => pattern)
  const hoister = new Hoister(resolved.patterns, (ref) => Object.keys(manifestOf.get(ref)?.peerDependencies ?? {}))
  hoister.seed(asked.map(({ pattern }) => pattern))
  const flat = hoister.flatten(workspaces.size > 0 ? AGGREGATOR : undefined)
  const placed = flat.map(({ names, info }) => ({ loc: locationOf(names, workspaces), info }))
  return { placed: placed.sort((a, b) => a.loc.localeCompare(b.loc)), hoister }
}

// Where `path` really is, through each link in `links`, in the order made.
function realOf(links, path) {
  for (const [link, target] of links) if (path === link || path.startsWith(`${link}/`)) path = target + path.slice(link.length)
  return path
}

// A package beneath a workspace's link is copied through it, so two of the
// hoister's places may be one real path, which `copies` maps to both.
function writeTree(placed, fetched) {
  const vfs = new Vfs()
  makeDirs(vfs, 'node_modules')
  const links = new Map()
  const locations = new Map()
  const copies = new Map()
  const left = new Map()
  for (const { info: { ref } } of placed) {
    if (ref.kind !== 'workspace') left.set(fetched.get(ref), (left.get(fetched.get(ref)) ?? 0) + 1)
  }
  const letGo = (pkg) => Object.assign(pkg, { files: undefined, dirs: undefined })
  for (const pkg of new Set(fetched.values())) if (!left.has(pkg)) letGo(pkg)
  const counted = { files: 0, bytes: 0 }
  for (const { loc, info } of placed) {
    const { ref } = info
    const dest = realOf(links, loc)
    if (!locations.has(ref)) locations.set(ref, [])
    if (!locations.get(ref).includes(dest)) locations.get(ref).push(dest)
    if (ref.kind === 'workspace') {
      // readManifests has each workspace in the project.
      if (!isInside(ref.workspace.dir)) throw new DeptreeError('links out of the project', whereOf(ref))
      links.set(dest, ref.workspace.dir)
      writeLink(vfs, dest, relative(`/${dirname(dest)}`, `/${ref.workspace.dir}`) || '.')
      continue
    }
    const pkg = fetched.get(ref)
    const earlier = copies.get(dest)
    if (earlier?.[0].ref === ref) earlier.push(info)
    else copies.set(dest, [info])
    writeFiles(vfs, dest, pkg, counted, skipped)
    left.set(pkg, left.get(pkg) - 1)
    if (left.get(pkg) === 0) letGo(pkg)
  }
  return { vfs, links, locations, copies, ...counted }
}

function listInstalled(copies, fetched, asked, hoister) {
  const prod = hoister.reachedBut('dev', asked)
  const required = hoister.reachedBut('optional', asked)
  return [...copies].map(([path, places]) => {
    const { ref } = places[0]
    const { manifest, integrity, about } = fetched.get(ref)
    const from = ref.kind === 'directory' ? { directory: ref.dir } : { integrity, ...Object.fromEntries(Object.entries(about).filter(([, value]) => value !== undefined)) }
    return { path, name: manifest.name, version: manifest.version, ...from, dev: !places.some((info) => prod.has(info)), optional: !places.some((info) => required.has(info)) }
  }).sort((a, b) => compareNames(a.path, b.path))
}

export async function buildYarn1Tree(options) {
  const { host: given, vfs: into } = options ?? {}
  if (into !== undefined && !(into instanceof Vfs)) throw new TypeError('vfs must be a Vfs, or left out')
  const fetching = fetchingOf(options ?? {})
  const inputs = inputsOf(options ?? {})
  const host = checkHost(given, inputs.manifests.get('.'))
  const folded = host.os === 'darwin'
  // Refused before anything is fetched; mount checks again.
  if (into !== undefined) checkNoModules(into, folded)
  checkRoot(inputs.manifests.get('.'))
  const { workspaces, asked, resolved } = resolveProject(inputs, host)
  const { packages, fetched, manifestOf } = await fetchChecked(resolved, host, inputs.settings, inputs.project, fetching)
  const { placed, hoister } = layout({ resolved, manifestOf, asked, workspaces })
  const { vfs, links, locations, copies, files, bytes } = writeTree(placed, fetched)
  checkBinLinks({ placed, patterns: resolved.patterns, locations, realOf: (path) => realOf(links, path) })
  const stats = {
    packages,
    skipped: [...manifestOf.keys()].filter((ref) => ref.incompatible).length,
    installed: placed.filter(({ info }) => info.ref.kind !== 'workspace').length,
    files,
    bytes,
    links: links.size,
  }
  const installed = listInstalled(copies, fetched, asked, hoister)
  return { vfs: mount(vfs, into, folded), stats, installed }
}

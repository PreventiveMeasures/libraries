// A node_modules tree as yarn 1 installs it from yarn.lock, frozen and with
// scripts ignored: `yarn install --frozen-lockfile --ignore-scripts`, into a
// directory with no node_modules yet. The lockfile is resolved as yarn
// resolves it (resolve.js), each package's peers looked for as yarn looks
// (peers.js), each package left out that the host cannot run and that is
// optional (compat.js), and the tree laid out as yarn hoists it (hoist.js):
// each package's files copied where it lands, as yarn's fetcher leaves
// them, each bin's target executable, and each workspace linked where it
// lands.
//
// Not written: bins themselves (node_modules/.bin), yarn's own
// .yarn-integrity, and anything a script would build.

import { parseYarn1Lockfile } from '@preventive/lockfile/yarn1.js'
import { Vfs } from '@preventive/vfs'
import { compareNames, dirname, relative } from '@preventive/vfs/path.js'
import { clean, satisfies, valid, validRange } from '@preventive/upstream/semver.js'
import { eachConcurrently } from '../concurrent.js'
import { DeptreeError, quote } from '../error.js'
import { checkCollisions, checkNoModules, mount, writeFiles } from '../mount.js'
import { typeOf } from '../project.js'
import { checkBinLinks } from './bins.js'
import { incompatibility } from './compat.js'
import { Hoister } from './hoist.js'
import { checkHost, inputsOf } from './inputs.js'
import { checkRoot, fixLists } from './manifest.js'
import { fetchYarnPackage, registryTarball } from './package.js'
import { resolvePeers } from './peers.js'
import { AGGREGATOR, aggregatorOf, rulesOf, topRequests, workspacesOf } from './requests.js'
import { resolve, splitPattern } from './resolve.js'

// What a refusal of a reference is about: the first pattern of it.
const whereOf = (ref) => quote(ref.patterns[0])

// The basenames yarn's copy passes over, wherever they are in a package.
const IGNORED = new Set(['.bin', '.yarn-metadata.json', '.yarn-tarball.tgz'])
const skipped = (path) => path.split('/').some((segment) => IGNORED.has(segment))

// The name a registry reference is fetched by: what its first pattern's
// `npm:` alias asks for, or its own.
function fetchedName(ref) {
  const { range } = splitPattern(ref.patterns[0])
  if (!range.startsWith('npm:')) return ref.name
  return splitPattern(range.slice(4)).name
}

// Each registry reference's files, package.json and the integrity its
// tarball is held to, a few at a time, every tarball's URL checked before
// any is fetched.
async function fetchAll(refs) {
  const fetched = new Map()
  const tarballs = refs.map((ref) => {
    const where = whereOf(ref)
    return { ref, where, tarball: registryTarball(ref.entry, fetchedName(ref), where) }
  })
  await eachConcurrently(tarballs, async ({ ref, where, tarball }) => {
    fetched.set(ref, { ...await fetchYarnPackage(tarball, where), integrity: tarball.integrity })
  }, ({ where }) => where)
  return fetched
}

// Where the hoister puts a package, from the lockfile's directory, as
// yarn's flat tree has it: under the aggregator, in the workspace's own
// node_modules.
function locationOf(names, workspaces) {
  if (names[0] === AGGREGATOR) return `${workspaces.get(names[1]).dir}/node_modules/${names.slice(2).join('/node_modules/')}`
  return `node_modules/${names.join('/node_modules/')}`
}

// The lockfile resolved as yarn resolves it for the project: the
// workspaces, the project's requests, as topRequests has them, and
// resolve.js's result.
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

// Every package fetched, as yarn fetches each before it checks any, and
// read; then each the host cannot run left out where it is optional, and
// refused where it is not, as yarn fails on it. By reference, each one's
// package.json as yarn reads it, a workspace's its own; and on each
// registry one whether it has bins, which those its fetcher passes over
// have none of.
async function fetchChecked(resolved, host, settings) {
  // What yarn's resolver hands its fetcher, in its order: each reference
  // its patterns name, once. Of those its cache keeps in one place, two of
  // one package, the fetcher fetches the first and passes over the rest,
  // whose package.json stays their lockfile entry's: no peers, bins,
  // platforms or engines; their files are the first's. The sha1 after the
  // `#` of each one's URL is held to the tarball fetched for it, the first
  // one's or not.
  const order = [...new Set(resolved.patterns.values())]
  const first = new Map()
  for (const ref of order) if (ref.kind === 'registry' && !first.has(ref.loc)) first.set(ref.loc, ref)
  const fetched = await fetchAll([...first.values()])
  const manifestOf = new Map()
  for (const ref of order) {
    let manifest = ref.workspace?.manifest
    if (ref.kind === 'registry') {
      const head = first.get(ref.loc)
      const { sha1 } = ref.entry.resolution
      if (sha1 !== undefined && fetched.get(head).sha1 !== sha1) throw new DeptreeError(`the tarball's sha1 is not ${sha1}`, whereOf(ref))
      fetched.set(ref, fetched.get(head))
      ref.hasBins = head === ref && fetched.get(ref).hasBins
      manifest = head === ref ? fixLists(fetched.get(ref).manifest) : { name: ref.name, version: ref.version }
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
  return { packages: first.size, fetched, manifestOf }
}

// The tree as yarn hoists it, flat: each package by where it goes, in the
// order yarn's linker sorts them, by the absolute paths it compares, all
// under the lockfile's directory, with localeCompare in the locale Node
// runs in; which changes nothing written, as a link sorts before what is
// beneath it in any locale. And the hoister that laid it out. Each reference's
// dependencies, as yarn's hold them for its hoister, are the patterns of
// what it asks for, its peers once found among them.
function layout({ resolved, manifestOf, asked, workspaces }) {
  resolvePeers(resolved, manifestOf)
  for (const ref of manifestOf.keys()) ref.dependencies = ref.asked.map(({ pattern }) => pattern)
  const hoister = new Hoister(resolved.patterns, (ref) => Object.keys(manifestOf.get(ref)?.peerDependencies ?? {}))
  hoister.seed(asked.map(({ pattern }) => pattern))
  const flat = hoister.flatten(workspaces.size > 0 ? AGGREGATOR : undefined)
  const placed = flat.map(({ names, info }) => ({ loc: locationOf(names, workspaces), info }))
  return { placed: placed.sort((a, b) => a.loc.localeCompare(b.loc)), hoister }
}

// Where a path in the tree really is: through each workspace link on its
// way, `links` by where each is to its target, in the order they are made.
function realOf(links, path) {
  for (const [link, target] of links) if (path === link || path.startsWith(`${link}/`)) path = target + path.slice(link.length)
  return path
}

// Each package copied where it goes, and each workspace linked: where a
// package goes beneath a workspace's link, it is copied through the link,
// into the workspace's own node_modules. `links` each link, by where it
// is, to its target; `locations` each reference's copies, where they
// really are; `copies` the hoister's places of each copy, by where it
// really is, as two places may be one through a link. A package's files
// are let go once its last copy is written, and those of one never placed
// at once.
function writeTree(placed, fetched) {
  const vfs = new Vfs()
  vfs.mkdir('/node_modules', { recursive: true })
  const links = new Map()
  const locations = new Map()
  const copies = new Map()
  const left = new Map()
  for (const { info: { ref } } of placed) {
    if (ref.kind === 'registry') left.set(fetched.get(ref), (left.get(fetched.get(ref)) ?? 0) + 1)
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
      links.set(dest, ref.workspace.dir)
      vfs.mkdir(`/${dirname(dest)}`, { recursive: true })
      vfs.symlink(relative(`/${dirname(dest)}`, `/${ref.workspace.dir}`) || '.', `/${dest}`)
      continue
    }
    const pkg = fetched.get(ref)
    const earlier = copies.get(dest)
    if (earlier?.[0].ref === ref) earlier.push(info)
    else copies.set(dest, [info])
    vfs.mkdir(`/${dest}`, { recursive: true })
    writeFiles(vfs, dest, pkg, counted, skipped)
    left.set(pkg, left.get(pkg) - 1)
    if (left.get(pkg) === 0) letGo(pkg)
  }
  return { vfs, links, locations, copies, ...counted }
}

// Each copy of a registry package as the list of what is installed has it,
// by its path, in an order no locale changes: by the places in the
// hoister's tree that reach it, whether only dev, or only optional,
// dependencies do. `copies` is writeTree's, and `asked` topRequests's.
function listInstalled(copies, fetched, asked, hoister) {
  const prod = hoister.reachedBut('dev', asked)
  const required = hoister.reachedBut('optional', asked)
  return [...copies].map(([path, places]) => {
    const { manifest, integrity } = fetched.get(places[0].ref)
    return { path, name: manifest.name, version: manifest.version, integrity, dev: !places.some((info) => prod.has(info)), optional: !places.some((info) => required.has(info)) }
  }).sort((a, b) => compareNames(a.path, b.path))
}

export async function buildYarn1Tree(options) {
  const { host: given, vfs: into } = options ?? {}
  if (into !== undefined && !(into instanceof Vfs)) throw new TypeError('vfs must be a Vfs, or left out')
  const inputs = inputsOf(options ?? {})
  const host = checkHost(given, inputs.manifests.get('.'))
  const folded = host.os === 'darwin'
  // Refused before anything is fetched; mount checks again.
  if (into !== undefined) checkNoModules(into, folded)
  checkRoot(inputs.manifests.get('.'))
  const { workspaces, asked, resolved } = resolveProject(inputs, host)
  const { packages, fetched, manifestOf } = await fetchChecked(resolved, host, inputs.settings)
  const { placed, hoister } = layout({ resolved, manifestOf, asked, workspaces })
  const { vfs, links, locations, copies, files, bytes } = writeTree(placed, fetched)
  checkBinLinks({ placed, patterns: resolved.patterns, locations, realOf: (path) => realOf(links, path) })
  if (folded) checkCollisions(vfs)
  const stats = {
    packages,
    skipped: [...manifestOf.keys()].filter((ref) => ref.incompatible).length,
    installed: placed.filter(({ info }) => info.ref.kind === 'registry').length,
    files,
    bytes,
    links: links.size,
  }
  const installed = listInstalled(copies, fetched, asked, hoister)
  if (into !== undefined) mount(vfs, into, folded)
  return { vfs: into ?? vfs, stats, installed }
}

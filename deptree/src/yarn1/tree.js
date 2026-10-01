// A node_modules tree as yarn 1 installs it from yarn.lock, frozen and with
// scripts ignored: `yarn install --frozen-lockfile --ignore-scripts`, into a
// directory with no node_modules yet. The lockfile is resolved as yarn
// resolves it (resolve.js), each package's peers looked for as yarn looks
// (peers.js), each package left out that the host cannot run and that is
// optional (compat.js), and the tree laid out as yarn hoists it (hoist.js):
// each package's files copied where it lands, each workspace linked where
// it lands, and each file a bin that yarn links runs made executable.
//
// Not written: bins themselves (node_modules/.bin), yarn's own
// .yarn-integrity, and anything a script would build.

import { parseYarn1Lockfile } from '@preventive/lockfile/yarn1.js'
import { Vfs, VfsError } from '@preventive/vfs'
import { dirname, relative } from '@preventive/vfs/path.js'
import { clean, satisfies, valid, validRange } from '@preventive/upstream/semver.js'
import { DeptreeError, quote } from '../error.js'
import { checkNoModules, mount } from '../mount.js'
import { checkCollisions } from '../pnpm/checks.js'
import { typeOf } from '../pnpm/project.js'
import { markBins } from './bins.js'
import { incompatibility } from './compat.js'
import { Hoister } from './hoist.js'
import { checkHost, inputsOf } from './inputs.js'
import { checkRoot, fixLists } from './manifest.js'
import { fetchYarnPackage, registryTarball } from './package.js'
import { resolvePeers } from './peers.js'
import { AGGREGATOR, aggregatorOf, rulesOf, topRequests, workspacesOf } from './requests.js'
import { resolve, splitPattern } from './resolve.js'

const CONCURRENCY = 8

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

// Each registry reference's files and package.json, a few at a time,
// every tarball's URL checked before any is fetched; the first failure
// stops the rest from starting.
async function fetchAll(refs) {
  const fetched = new Map()
  const queue = refs.map((ref) => {
    const where = quote(ref.patterns[0])
    return { ref, where, tarball: registryTarball(ref.entry, fetchedName(ref), where) }
  })
  let failed = false
  const worker = async () => {
    while (queue.length > 0 && !failed) {
      const { ref, where, tarball } = queue.shift()
      try {
        fetched.set(ref, await fetchYarnPackage(tarball, where))
      } catch (error) {
        failed = true
        throw error instanceof DeptreeError ? error : new DeptreeError(error.message, where, { cause: error })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker))
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
// workspaces, the root's patterns, and resolve.js's result.
function resolveProject(inputs, host) {
  const lockfile = parseYarn1Lockfile(inputs.lockfile, { manifests: Object.fromEntries(inputs.manifests), semver: { clean, satisfies, valid, validRange } })
  const manifests = new Map([...inputs.manifests].map(([dir, manifest]) => [dir, fixLists(manifest)]))
  const root = manifests.get('.')
  const workspaces = workspacesOf(manifests)
  if (workspaces.size > 0) workspaces.set(AGGREGATOR, aggregatorOf(root, workspaces))
  const rules = rulesOf(root)
  const { requests, patterns } = topRequests(root, workspaces, rules)
  const reason = incompatibility(root, host, 'manifests["."]', inputs.settings)
  if (reason !== undefined) throw new DeptreeError(reason, 'manifests["."]')
  const { project } = inputs
  const isDirectory = project === undefined ? () => undefined : (tag) => typeOf(project, `/${tag}/package.json`) !== undefined
  return { workspaces, topPatterns: patterns, resolved: resolve({ lockfile, workspaces, rules, top: requests, isDirectory }) }
}

// Every package fetched, as yarn fetches each before it checks any, and
// read; then each the host cannot run left out where it is optional, and
// refused where it is not, as yarn fails on it. By reference, each one's
// package.json as yarn reads it, a workspace's its own.
async function fetchChecked(resolved, host, settings) {
  // What yarn's resolver hands its fetcher, in its order: each reference
  // its patterns name, once. Of those its cache keeps in one place, two of
  // one package, the fetcher fetches the first and passes over the rest,
  // whose package.json stays their lockfile entry's: no peers, bins,
  // platforms or engines; their files are the first's.
  const order = [...new Set(resolved.patterns.values())]
  const first = new Map()
  for (const ref of order) if (ref.kind === 'registry' && !first.has(ref.loc)) first.set(ref.loc, ref)
  const fetched = await fetchAll([...first.values()])
  const manifestOf = new Map()
  for (const ref of order) {
    let manifest = ref.workspace?.manifest
    if (ref.kind === 'registry') {
      const head = first.get(ref.loc)
      fetched.set(ref, fetched.get(head))
      manifest = head === ref ? fixLists(fetched.get(ref).manifest) : { name: ref.name, version: ref.version }
    }
    const bundled = manifest.bundleDependencies ?? manifest.bundledDependencies
    if (bundled && !(Array.isArray(bundled) && bundled.length === 0)) throw new DeptreeError('a package with bundled dependencies is not supported', quote(ref.patterns[0]))
    manifestOf.set(ref, manifest)
  }
  for (const ref of order) {
    const reason = incompatibility(manifestOf.get(ref), host, quote(ref.patterns[0]), settings)
    if (reason === undefined) continue
    if (!ref.optional) throw new DeptreeError(`${reason}, and it is not optional, which yarn fails on`, quote(ref.patterns[0]))
    ref.incompatible = true
  }
  return { packages: first.size, fetched, manifestOf }
}

// The tree as yarn hoists it, flat: each package by where it goes, in the
// order yarn sorts them, by the absolute paths it compares, all under the
// lockfile's directory.
function layout({ resolved, manifestOf, topPatterns, workspaces }) {
  resolvePeers(resolved, manifestOf)
  const hoister = new Hoister(resolved.patterns, (ref) => Object.keys(manifestOf.get(ref)?.peerDependencies ?? {}))
  hoister.seed(topPatterns)
  const flat = hoister.flatten(workspaces.size > 0 ? AGGREGATOR : undefined)
  const placed = flat.map(({ names, info }) => ({ loc: locationOf(names, workspaces), info }))
  return placed.sort((a, b) => a.loc.localeCompare(b.loc))
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
// really are.
function writeTree(placed, fetched) {
  const vfs = new Vfs()
  vfs.mkdir('/node_modules', { recursive: true })
  const links = new Map()
  const locations = new Map()
  let files = 0
  let bytes = 0
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
    vfs.mkdir(`/${dest}`, { recursive: true })
    for (const dir of pkg.dirs) if (!skipped(dir)) vfs.mkdir(`/${dest}/${dir}`, { recursive: true })
    for (const [path, file] of pkg.files) {
      if (skipped(path)) continue
      try {
        vfs.writeFile(`/${dest}/${path}`, file.data, { mode: file.mode })
      } catch (error) {
        if (error instanceof VfsError) throw new DeptreeError(`cannot be written: ${error.message}`, quote(`${dest}/${path}`), { cause: error })
        throw error
      }
      files++
      bytes += file.data.length
    }
  }
  return { vfs, links, locations, files, bytes }
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
  const { workspaces, topPatterns, resolved } = resolveProject(inputs, host)
  const { packages, fetched, manifestOf } = await fetchChecked(resolved, host, inputs.settings)
  const placed = layout({ resolved, manifestOf, topPatterns, workspaces })
  const { vfs, links, locations, files, bytes } = writeTree(placed, fetched)
  markBins(vfs, { placed, patterns: resolved.patterns, fetched, manifestOf, locations, realOf: (path) => realOf(links, path) })
  if (folded) checkCollisions(vfs)
  const stats = {
    packages,
    skipped: [...manifestOf.keys()].filter((ref) => ref.incompatible).length,
    installed: placed.filter(({ info }) => info.ref.kind === 'registry').length,
    files,
    bytes,
    links: links.size,
  }
  if (into === undefined) return { vfs, stats }
  mount(vfs, into, folded)
  return { vfs: into, stats }
}

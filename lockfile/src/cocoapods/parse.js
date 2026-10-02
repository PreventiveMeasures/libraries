// A Podfile.lock, as CocoaPods 1.5 to 1.17 write it: every section read
// and its values checked, the file held to the text CocoaPods writes for
// them, and the sections to each other. The sections are Lockfile.generate's:
//
// - PODS: every pod installed, a root or a subspec, at its version, and
//   what its podspec depends on, on every platform it names.
// - DEPENDENCIES: what the Podfile asks for, each by requirements or by an
//   external source.
// - SPEC REPOS: by URL, or `trunk` for the CDN, the roots each spec repo
//   gave.
// - EXTERNAL SOURCES: by root, the Podfile's options for one of an
//   external source, and CHECKOUT OPTIONS what CocoaPods downloaded it by.
// - SPEC CHECKSUMS: by root, the sha1 of the podspec it read.
// - PODFILE CHECKSUM: the sha1 of the Podfile; COCOAPODS: its version.

import { LockfileError, at, quote } from '../error.js'
import { fail } from '../lines.js'
import { isHexSha1 } from '../names.js'
import { checkOptions, field } from '../shape.js'
import { checkCheckout, checkDescription } from './external.js'
import { SECTIONS, checkLayout, rulesOf } from './layout.js'
import { checkRootName, readDependency, readPodString, readPodfileDependency, rootOf } from './pods.js'
import { sha1Hex } from './sha1.js'
import { entriesOf, itemsOf, scalarOf, textOf } from './shape.js'
import { readCheckout, readExternalSource } from './sources.js'
import { parseCocoaYaml } from './yaml.js'

const where = (section) => at('', section)

function readSections(root) {
  const sections = Object.create(null)
  for (const { key, value } of root.entries) {
    if (key.type !== 'string' || !SECTIONS.includes(key.value)) throw fail(`unsupported section ${quote(String(key.value))}`, key.line)
    sections[key.value] = value
  }
  return sections
}

// From 1.5, the quoting CocoaPods writes still; a prerelease as its release.
function readVersion(node) {
  if (node === undefined) throw new LockfileError('expected COCOAPODS, the version of CocoaPods that wrote the file, which it always writes')
  const version = textOf(node, 'COCOAPODS')
  const m = /^(\d+)\.(\d+)\.\d+(?:\.(?:beta|rc)\.\d+)?$/u.exec(version)
  if (m === null || Number(m[1]) !== 1 || Number(m[2]) < 5) throw new LockfileError(`${quote(version)} is not a version of CocoaPods from 1.5 to 1.x, which this reader reads`, 'COCOAPODS')
  return { version, rules: rulesOf(Number(m[2])) }
}

function readSha1(node, here) {
  const value = textOf(node, here)
  if (!isHexSha1(value)) throw new LockfileError(`${quote(value)} is not a sha1 in lowercase hex`, here)
  return value
}

// The pods by name, and where each is in PODS.
function readPods(node) {
  const pods = Object.create(null)
  const placeOf = new Map()
  for (const [index, item] of itemsOf(node, 'PODS').entries()) {
    const here = `PODS[${index}]`
    if (item.kind === 'seq' || (item.kind === 'map' && item.entries.length !== 1)) throw new LockfileError('expected a pod, or one pod and what it depends on', here)
    const [key, list] = item.kind === 'map' ? [item.entries[0].key, item.entries[0].value] : [item, undefined]
    const there = at(here, String(key.value))
    const dependencies = itemsOf(list, there).map((dependency, number) => readDependency(textOf(dependency, `${there}[${number}]`), `${there}[${number}]`))
    const { name, version } = readPodString(textOf(key, here), here)
    if (name in pods) throw new LockfileError(`a second ${quote(name)}`, here)
    pods[name] = { name, root: rootOf(name), version, dependencies }
    placeOf.set(name, here)
  }
  return { pods, placeOf }
}

// The roots of the pods, each once, its pods at one version.
function readRoots(pods, placeOf) {
  const roots = Object.create(null)
  for (const pod of Object.values(pods)) {
    const root = (roots[pod.root] ??= { name: pod.root, version: pod.version, pods: [], checksum: undefined, repo: undefined, external: undefined, checkout: undefined })
    if (root.version !== pod.version) throw new LockfileError(`at ${quote(pod.version)}, where its root's other pods are at ${quote(root.version)}`, placeOf.get(pod.name))
    root.pods.push(pod.name)
  }
  return roots
}

// A section by root: what `read` makes of each, with where it is.
function byRoot(node, section, read) {
  const map = new Map()
  for (const [key, value, here] of entriesOf(node, where(section))) {
    map.set(checkRootName(scalarOf(key, 'string', here), here), { value: read(value, here), where: here })
  }
  return map
}

// SPEC REPOS, by root: the spec repo of each.
function readSpecRepos(node) {
  const repos = new Map()
  for (const [key, list, here] of entriesOf(node, where('SPEC REPOS'))) {
    const repo = textOf(key, here)
    if (/\s/u.test(repo)) throw new LockfileError(`${quote(repo)} is not a spec repo's URL or name`, here)
    for (const [index, item] of itemsOf(list, here).entries()) {
      const there = `${here}[${index}]`
      const root = checkRootName(textOf(item, there), there)
      if (repos.has(root)) throw new LockfileError(`${quote(root)} is in ${quote(repos.get(root).value)} too`, there)
      repos.set(root, { value: repo, where: there })
    }
  }
  return repos
}

function known(roots, root, here) {
  if (!(root in roots)) throw new LockfileError(`${quote(root)} is the root of no pod in PODS`, here)
  return roots[root]
}

// Each root's checksum, spec repo, external source and checkout options,
// from the sections by root, held to each other: each section's of a root
// of PODS, each root of a checksum and one source, a spec repo or an
// external one, with the checkout options CocoaPods keeps of that.
function checkRoots(roots, placeOf, { checksums, repos, externals, checkouts }) {
  const fill = (map, property) => {
    for (const [root, { value, where: here }] of map) known(roots, root, here)[property] = value
  }
  fill(checksums, 'checksum')
  fill(repos, 'repo')
  fill(externals, 'external')
  fill(checkouts, 'checkout')
  for (const [root, { where: here }] of externals) {
    if (repos.has(root)) throw new LockfileError(`${quote(root)} is from an external source and a spec repo both`, here)
  }
  for (const [root, { where: here }] of checkouts) {
    if (!externals.has(root)) throw new LockfileError(`${quote(root)} has no external source, and CocoaPods keeps checkout options of none other`, here)
  }
  for (const [root, { value, where: here }] of externals) checkCheckout(value, roots[root].checkout, checkouts.get(root)?.where, here)
  for (const root of Object.values(roots)) {
    const first = placeOf.get(root.pods[0])
    if (root.checksum === undefined) throw new LockfileError(`no checksum of ${quote(root.name)} in SPEC CHECKSUMS, which CocoaPods writes of every podspec`, first)
    if (root.repo === undefined && root.external === undefined) throw new LockfileError(`${quote(root.name)} is from no spec repo and no external source`, first)
  }
}

// The Podfile's dependencies: each of a pod in PODS, each of an external
// source as its root's is described; and the roots they describe so.
function checkPodfileDependencies(read, pods, roots) {
  const described = new Set()
  for (const { name, description, where: here } of read) {
    if (!(name in pods)) throw new LockfileError(`${quote(name)} is no pod in PODS`, here)
    if (description === undefined) continue
    const { root } = pods[name]
    if (roots[root].external === undefined) throw new LockfileError(`${quote(root)} has no external source in EXTERNAL SOURCES`, here)
    checkDescription(description, roots[root].external, here)
    described.add(root)
  }
  return described
}

// Every pod is one the Podfile's dependencies lead to, as CocoaPods
// resolves no other; a podspec's dependency may name none, as one of
// another platform does.
function checkReached(dependencies, pods, placeOf) {
  const reached = new Set(dependencies.map((dependency) => dependency.name))
  for (const name of reached) {
    for (const dependency of pods[name]?.dependencies ?? []) reached.add(dependency.name)
  }
  const missed = Object.values(pods).find((pod) => !reached.has(pod.name))
  if (missed !== undefined) throw new LockfileError(`${quote(missed.name)} is not one the Podfile's dependencies lead to, which CocoaPods would not install`, placeOf.get(missed.name))
}

// The Podfile's bytes, as CocoaPods hashes them.
function podfileBytes(podfile) {
  if (podfile === undefined || podfile instanceof Uint8Array) return podfile
  if (typeof podfile !== 'string') throw new TypeError('expected the Podfile as a string or a Uint8Array')
  if (!podfile.isWellFormed()) throw new TypeError('expected the Podfile as well-formed text, or its bytes')
  return new TextEncoder().encode(podfile)
}

function checkPodfile(bytes, checksum) {
  if (checksum === undefined) throw new LockfileError('no PODFILE CHECKSUM to hold the Podfile to, which CocoaPods writes of a Podfile it reads from a file')
  const digest = sha1Hex(bytes)
  if (digest !== checksum) throw new LockfileError(`not the sha1 of the Podfile given, ${digest}: the lockfile was written for another Podfile`, where('PODFILE CHECKSUM'))
}

// Each section read first, then the file held to its layout, then the
// sections to each other.
export function parsePodfileLock(text, options = {}) {
  if (typeof text !== 'string') throw new TypeError('expected a string')
  const podfile = podfileBytes(checkOptions(options, ['podfile']).podfile)
  const { root, crlf } = parseCocoaYaml(text)
  const sections = readSections(root)
  const { version, rules } = readVersion(sections.COCOAPODS)
  const podfileChecksum = field(sections, 'PODFILE CHECKSUM', '', readSha1)
  const { pods, placeOf } = readPods(sections.PODS)
  const roots = readRoots(pods, placeOf)
  const byRoots = {
    checksums: byRoot(sections['SPEC CHECKSUMS'], 'SPEC CHECKSUMS', readSha1),
    repos: readSpecRepos(sections['SPEC REPOS']),
    externals: byRoot(sections['EXTERNAL SOURCES'], 'EXTERNAL SOURCES', readExternalSource),
    checkouts: byRoot(sections['CHECKOUT OPTIONS'], 'CHECKOUT OPTIONS', readCheckout),
  }
  const read = itemsOf(sections.DEPENDENCIES, 'DEPENDENCIES').map((item, index) => {
    const here = `DEPENDENCIES[${index}]`
    return { ...readPodfileDependency(textOf(item, here), here), where: here }
  })
  checkLayout(text, root, rules, crlf, version)
  checkRoots(roots, placeOf, byRoots)
  const described = checkPodfileDependencies(read, pods, roots)
  for (const [name, { where: here }] of byRoots.externals) {
    if (!described.has(name)) throw new LockfileError(`${quote(name)} is from an external source no dependency of the Podfile names`, here)
  }
  const dependencies = read.map(({ name, requirements, description }) => ({ name, requirements, external: description !== undefined }))
  checkReached(dependencies, pods, placeOf)
  if (podfile !== undefined) checkPodfile(podfile, podfileChecksum)
  return { cocoapods: version, podfileChecksum, pods, roots, dependencies }
}

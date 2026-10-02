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
import { checkOptions } from '../shape.js'
import { checkCheckout, checkDescription } from './external.js'
import { SECTIONS, checkLayout } from './layout.js'
import { checkRootName, readDependency, readPodString, rootOf } from './pods.js'
import { sha1Hex } from './sha1.js'
import { readCheckout, readExternalSource, scalarOf, textOf } from './sources.js'
import { parseCocoaYaml } from './yaml.js'

const SHA1 = /^[\da-f]{40}$/u
const where = (section) => at('', section)

function readSections(root) {
  const sections = Object.create(null)
  for (const { key, value } of root.entries) {
    if (key.type !== 'string' || !SECTIONS.includes(key.value)) throw new LockfileError(`unsupported section ${quote(String(key.value))} at line ${key.line + 1}`)
    sections[key.value] = value
  }
  return sections
}

// From 1.5, the quoting CocoaPods writes still; a prerelease as its release.
function readVersion(node) {
  if (node === undefined) throw new LockfileError('expected COCOAPODS, the version of CocoaPods that wrote the file, which it always writes')
  const version = textOf(node, 'COCOAPODS')
  const m = /^(\d+)\.(\d+)\.(\d+)(?:\.(?:beta|rc)\.\d+)?$/u.exec(version)
  const [major, minor] = m === null ? [] : [Number(m[1]), Number(m[2])]
  if (m === null || major !== 1 || minor < 5) throw new LockfileError(`${quote(version)} is not a version of CocoaPods from 1.5 to 1.x, which this reader reads`, 'COCOAPODS')
  return { version, rules: { yesNo: minor >= 10, dates: minor >= 13 } }
}

function items(node, here) {
  if (node === undefined) return []
  if (node.kind !== 'seq') throw new LockfileError('expected a sequence', here)
  return node.items
}

function entries(node, here) {
  if (node === undefined) return []
  if (node.kind !== 'map') throw new LockfileError('expected a mapping', here)
  return node.entries.map(({ key, value }) => {
    const there = at(here, String(key.value))
    return [checkRootName(scalarOf(key, 'string', there), there), value, there]
  })
}

const sha1 = (node, here) => {
  const value = textOf(node, here)
  if (!SHA1.test(value)) throw new LockfileError(`${quote(value)} is not a sha1 in lowercase hex`, here)
  return value
}

const readDependencyNode = (node, here, podfile) => readDependency(textOf(node, here), here, podfile)

// The pods by name, and where each is in PODS.
function readPods(node) {
  const pods = Object.create(null)
  const order = new Map()
  for (const [index, item] of items(node, 'PODS').entries()) {
    const here = `PODS[${index}]`
    let key = item
    let dependencies = []
    if (item.kind === 'map' && item.entries.length === 1) {
      key = item.entries[0].key
      const there = at(here, String(key.value))
      dependencies = items(item.entries[0].value, there).map((dependency, number) => readDependencyNode(dependency, `${there}[${number}]`, false))
    } else if (item.kind !== 'scalar') {
      throw new LockfileError('expected a pod, or one pod and what it depends on', here)
    }
    const { name, version } = readPodString(textOf(key, here), here)
    if (name in pods) throw new LockfileError(`a second ${quote(name)}`, here)
    pods[name] = { name, root: rootOf(name), version, dependencies: dependencies.map(({ name: of, requirements }) => ({ name: of, requirements })) }
    order.set(name, here)
  }
  return { pods, order }
}

function readSpecRepos(node) {
  const repos = new Map()
  if (node === undefined) return repos
  if (node.kind !== 'map') throw new LockfileError('expected a mapping', where('SPEC REPOS'))
  for (const { key, value } of node.entries) {
    const here = at(where('SPEC REPOS'), String(key.value))
    const repo = textOf(key, here)
    if (/\s/u.test(repo)) throw new LockfileError(`${quote(repo)} is not a spec repo's URL or name`, here)
    for (const [index, item] of items(value, here).entries()) {
      const there = `${here}[${index}]`
      const root = checkRootName(textOf(item, there), there)
      if (repos.has(root)) throw new LockfileError(`${quote(root)} is in ${quote(repos.get(root).repo)} too`, there)
      repos.set(root, { repo, where: there })
    }
  }
  return repos
}

// The roots of the pods, each once, its pods at one version.
function readRoots(pods, order) {
  const roots = Object.create(null)
  for (const pod of Object.values(pods)) {
    const root = (roots[pod.root] ??= { name: pod.root, version: pod.version, pods: [], checksum: undefined, repo: undefined, external: undefined, checkout: undefined })
    if (root.version !== pod.version) throw new LockfileError(`at ${quote(pod.version)}, where its root's other pods are at ${quote(root.version)}`, order.get(pod.name))
    root.pods.push(pod.name)
  }
  return roots
}

function known(roots, root, here) {
  if (!(root in roots)) throw new LockfileError(`${quote(root)} is the root of no pod in PODS`, here)
  return roots[root]
}

// Each root's sources, checksum and checkout, held to the others'.
function fillRoots(roots, order, sections) {
  for (const [root, value, here] of entries(sections['SPEC CHECKSUMS'], where('SPEC CHECKSUMS'))) known(roots, root, here).checksum = sha1(value, here)
  for (const [root, { repo, where: here }] of readSpecRepos(sections['SPEC REPOS'])) known(roots, root, here).repo = repo
  const externals = new Map()
  for (const [root, value, here] of entries(sections['EXTERNAL SOURCES'], where('EXTERNAL SOURCES'))) {
    const { source, options } = readExternalSource(value, here)
    if (known(roots, root, here).repo !== undefined) throw new LockfileError(`${quote(root)} is from an external source and a spec repo both`, here)
    roots[root].external = source
    externals.set(root, { source, options, where: here, described: false })
  }
  const checkouts = new Map()
  for (const [root, value, here] of entries(sections['CHECKOUT OPTIONS'], where('CHECKOUT OPTIONS'))) {
    if (!externals.has(root)) throw new LockfileError(`${quote(root)} has no external source, and CocoaPods keeps checkout options of none other`, here)
    checkouts.set(root, { checkout: readCheckout(value, here), where: here })
  }
  for (const [root, external] of externals) {
    const { checkout, where: here } = checkouts.get(root) ?? {}
    checkCheckout(external.source, checkout, here, external.where)
    roots[root].checkout = checkout
  }
  for (const root of Object.values(roots)) {
    const first = order.get(root.pods[0])
    if (root.checksum === undefined) throw new LockfileError(`no checksum of ${quote(root.name)} in SPEC CHECKSUMS, which CocoaPods writes of every podspec`, first)
    if (root.repo === undefined && root.external === undefined) throw new LockfileError(`${quote(root.name)} is from no spec repo and no external source`, first)
  }
  return externals
}

// The Podfile's dependencies: each of a pod in PODS, each of an external
// source as EXTERNAL SOURCES has it, and each source of one of them.
function readPodfileDependencies(node, pods, externals) {
  return items(node, 'DEPENDENCIES').map((item, index) => {
    const here = `DEPENDENCIES[${index}]`
    const { name, requirements, external, description } = readDependencyNode(item, here, true)
    if (!(name in pods)) throw new LockfileError(`${quote(name)} is no pod in PODS`, here)
    if (external) {
      const source = externals.get(rootOf(name))
      if (source === undefined) throw new LockfileError(`${quote(rootOf(name))} has no external source in EXTERNAL SOURCES`, here)
      checkDescription(description, source.source, source.options, here)
      source.described = true
    }
    return { name, requirements, external }
  })
}

// Every pod is one the Podfile's dependencies lead to, as CocoaPods
// resolves no other.
function checkReached(dependencies, pods, order) {
  const reached = new Set()
  const queue = dependencies.map((dependency) => dependency.name)
  while (queue.length > 0) {
    const name = queue.pop()
    if (reached.has(name) || !(name in pods)) continue
    reached.add(name)
    queue.push(...pods[name].dependencies.map((dependency) => dependency.name))
  }
  const missed = Object.values(pods).find((pod) => !reached.has(pod.name))
  if (missed !== undefined) throw new LockfileError(`${quote(missed.name)} is not one the Podfile's dependencies lead to, which CocoaPods would not install`, order.get(missed.name))
}

function checkPodfile(podfile, checksum) {
  if (typeof podfile === 'string' && !podfile.isWellFormed()) throw new TypeError('expected the Podfile as well-formed text, or its bytes')
  if (checksum === undefined) throw new LockfileError('no PODFILE CHECKSUM to hold the Podfile to, which CocoaPods writes of a Podfile it reads from a file')
  const digest = sha1Hex(typeof podfile === 'string' ? new TextEncoder().encode(podfile) : podfile)
  if (digest !== checksum) throw new LockfileError(`not the sha1 of the Podfile given, ${digest}: the lockfile was written for another Podfile`, where('PODFILE CHECKSUM'))
}

export function parsePodfileLock(text, options = {}) {
  if (typeof text !== 'string') throw new TypeError('expected a string')
  const { podfile } = checkOptions(options, ['podfile'])
  if (podfile !== undefined && typeof podfile !== 'string' && !(podfile instanceof Uint8Array)) throw new TypeError('expected the Podfile as a string or a Uint8Array')
  const { root, crlf } = parseCocoaYaml(text)
  const sections = readSections(root)
  const { version, rules } = readVersion(sections.COCOAPODS)
  const podfileChecksum = sections['PODFILE CHECKSUM'] === undefined ? undefined : sha1(sections['PODFILE CHECKSUM'], where('PODFILE CHECKSUM'))
  const { pods, order } = readPods(sections.PODS)
  const roots = readRoots(pods, order)
  const externals = fillRoots(roots, order, sections)
  const dependencies = readPodfileDependencies(sections.DEPENDENCIES, pods, externals)
  checkLayout(text, root, rules, crlf, version)
  for (const [name, external] of externals) {
    if (!external.described) throw new LockfileError(`${quote(name)} is from an external source no dependency of the Podfile names`, external.where)
  }
  checkReached(dependencies, pods, order)
  if (podfile !== undefined) checkPodfile(podfile, podfileChecksum)
  return { cocoapods: version, podfileChecksum, pods, roots, dependencies }
}

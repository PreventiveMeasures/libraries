// What npm-install-checks makes of a package on the host: checkPlatform,
// by its os, cpu and libc, and checkEngine, by the Node and npm that run.
// And which packages npm leaves out for them: an optional one the host
// cannot run, with its optionalSet, and nothing else; one not optional the
// host cannot run fails npm, and so, with engine-strict, does one whose
// engines it does not take.

import { satisfies } from '@preventive/upstream/semver.js'
import { DeptreeError, quote } from '../error.js'

// checkList: a negated value the host has fails; else a plain one it has,
// or none but negated ones, passes.
function takes(value, list) {
  const values = typeof list === 'string' ? [list] : list
  if (values.length === 1 && values[0] === 'any') return true
  const negated = (entry) => entry.startsWith('!')
  if (values.includes(`!${value}`)) return false
  return values.some((entry) => !negated(entry) && entry === value) || values.every(negated)
}

// A list as npm reads it: none where falsy, a string, or a sequence of
// them; anything else it fails on.
function listOf(pkg, key, at) {
  const list = pkg[key]
  if (!list || typeof list === 'string' || (Array.isArray(list) && list.every((entry) => typeof entry === 'string'))) return list || undefined
  throw new DeptreeError('expected a string or a sequence of strings, which npm fails without', `${at}.${key}`)
}

// Why the host's platform is not one `pkg` takes, or undefined where it
// is. A libc it names fails where the host has none, whatever it names.
export function checkPlatform(pkg, host, at) {
  for (const key of ['os', 'cpu', 'libc']) {
    const list = listOf(pkg, key, at)
    if (list !== undefined && (host[key] === undefined || !takes(host[key], list))) return `its ${key}, ${quote(JSON.stringify(list))}, is not the host's`
  }
  return undefined
}

// Why the host's Node or npm is not one `pkg` takes, or undefined.
export function checkEngine(pkg, host) {
  const { engines } = pkg
  if (!engines) return undefined
  const options = { includePrerelease: true }
  if (engines.node && !satisfies(`v${host.node}`, engines.node, options)) return `its engines.node, ${quote(String(engines.node))}, does not take Node ${host.node}`
  if (engines.npm && !satisfies(host.npm, engines.npm, options)) return `its engines.npm, ${quote(String(engines.npm))}, does not take npm ${host.npm}`
  return undefined
}

// gatherDepSet: from `set`, every node its edges `follow` lead to, less
// those another node leads to by such an edge, until none is.
function gatherDepSet(set, follow) {
  const deps = new Set(set)
  for (const node of deps) for (const edge of node.edgesOut) if (follow(edge)) deps.add(edge.to)
  let changed = true
  while (changed && deps.size > 0) {
    changed = false
    for (const dep of deps) {
      if (dep.edgesIn.some((edge) => !deps.has(edge.from) && follow(edge))) {
        changed = true
        deps.delete(dep)
      }
    }
  }
  return deps
}

// optionalSet: the node, and what depends on it but optionally, up to its
// optional dependents; and what only they depend on. npm 10 gathers that
// by edges that are not optional, npm 11 by those out of the first set,
// and from 11.13 not from a node an earlier set left out.
function optionalSet(node, host, skipped) {
  const set = new Set([node])
  for (const member of set) for (const edge of member.edgesIn) if (!edge.optional) set.add(edge.from)
  return gatherDepSet(set, host.reuse ? (edge) => !edge.optional : (edge) => !set.has(edge.to) && !(host.inert && skipped.has(edge.from)))
}

const whereOf = (node) => `packages[${quote(node.location)}]`

// The nodes npm leaves out, by the flags it installs by. npm 11 checks each
// optional package in the inventory's order, and passes over one an
// earlier set took; npm 10 checks each as it extracts it, all at once.
// Whatever a node left out has in its node_modules is left out too.
export function skippedOf(nodes, host, settings) {
  const skipped = new Set()
  for (const node of nodes.values()) {
    if (node.kind !== 'package') continue
    if (!node.pkg.optional) {
      const platform = checkPlatform(node.manifest, host, whereOf(node))
      if (platform !== undefined) throw new DeptreeError(`${platform}, and it is not optional, which npm fails on`, whereOf(node))
      const engine = settings.engineStrict ? checkEngine(node.manifest, host) : undefined
      if (engine !== undefined) throw new DeptreeError(`${engine}, and it is not optional, which npm fails on with engine-strict`, whereOf(node))
      continue
    }
    if (!host.reuse && skipped.has(node)) continue
    if (checkEngine(node.manifest, host) === undefined && checkPlatform(node.manifest, host, whereOf(node)) === undefined) continue
    for (const member of optionalSet(node, host, skipped)) skipped.add(member)
  }
  for (const node of skipped) {
    if (node.kind !== 'package') throw new DeptreeError('left out with an optional package the host cannot run, which is not supported', node.kind === 'link' ? whereOf(node) : `importers[${quote(node.location)}]`)
  }
  const under = (node) => node.parent !== undefined && (skipped.has(nodes.get(node.parent)) || under(nodes.get(node.parent)))
  return new Set([...nodes.values()].filter((node) => skipped.has(node) || under(node)))
}

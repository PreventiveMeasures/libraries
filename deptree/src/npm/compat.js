// npm-install-checks' checkPlatform and checkEngine, and what npm leaves out
// for them: an optional package the host cannot run, with its optionalSet.

import { satisfies } from '@preventive/upstream/semver.js'
import { DeptreeError, quote } from '../error.js'

// npm-install-checks' checkList.
function takes(value, list) {
  const values = typeof list === 'string' ? [list] : list
  if (values.length === 1 && values[0] === 'any') return true
  const negated = (entry) => entry.startsWith('!')
  if (values.includes(`!${value}`)) return false
  return values.some((entry) => !negated(entry) && entry === value) || values.every(negated)
}

function listOf(pkg, key, at) {
  const list = pkg[key]
  if (!list || typeof list === 'string' || (Array.isArray(list) && list.every((entry) => typeof entry === 'string'))) return list || undefined
  throw new DeptreeError('expected a string or a sequence of strings, which npm fails without', `${at}.${key}`)
}

// A libc fails a host with none, whatever it names.
export function checkPlatform(pkg, host, at) {
  for (const key of ['os', 'cpu', 'libc']) {
    const list = listOf(pkg, key, at)
    if (list !== undefined && (host[key] === undefined || !takes(host[key], list))) return `its ${key}, ${quote(JSON.stringify(list))}, is not the host's`
  }
  return undefined
}

export function checkEngine(pkg, host) {
  const { engines } = pkg
  if (!engines) return undefined
  const options = { includePrerelease: true }
  if (engines.node && !satisfies(`v${host.node}`, engines.node, options)) return `its engines.node, ${quote(String(engines.node))}, does not take Node ${host.node}`
  if (engines.npm && !satisfies(host.npm, engines.npm, options)) return `its engines.npm, ${quote(String(engines.npm))}, does not take npm ${host.npm}`
  return undefined
}

// Arborist's gatherDepSet.
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

// Arborist's optionalSet: npm 10 gathers by edges that are not optional,
// npm 11 by those out of the first set, from 11.13 not from a node an
// earlier set left out.
function optionalSet(node, host, skipped) {
  const set = new Set([node])
  for (const member of set) for (const edge of member.edgesIn) if (!edge.optional) set.add(edge.from)
  return gatherDepSet(set, host.reuse ? (edge) => !edge.optional : (edge) => !set.has(edge.to) && !(host.inert && skipped.has(edge.from)))
}

const whereOf = (node) => `packages[${quote(node.location)}]`

// npm 11 checks optional packages in inventory order, passing over one an
// earlier set took; npm 10 checks them all as it extracts. What is in the
// node_modules of a node left out goes with it.
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

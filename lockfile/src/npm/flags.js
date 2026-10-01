// What npm writes of how each node is depended on, as Arborist works it out
// from the tree (calcDepFlags, getBundler): flags npm leaves a dependency
// out by, under --omit, and which packages come in another's tarball.

import { LockfileError, at, quote } from '../error.js'
import { resolveParent } from './tree.js'

const FLAGS = ['dev', 'optional', 'devOptional', 'peer', 'extraneous']
const WRITTEN = ['dev', 'optional', 'devOptional', 'peer']

// calcDepFlags, as npm 12 has it: each node starts with every flag but the
// project, and loses one wherever an edge without it leads to it from a
// node without it; an optional peer leaves it extraneous. A link passes its
// own on to what it leads to. devOptional, the dependencies both of dev and
// of optional ones, is left set where either is.
function calcFlags(nodes) {
  const flags = new Map()
  for (const node of nodes.values()) flags.set(node, Object.fromEntries(FLAGS.map((flag) => [flag, node.kind !== 'root'])))
  const seen = new Set()
  const queue = [nodes.get('')]
  while (queue.length > 0) {
    const node = queue.pop()
    seen.add(node)
    const own = flags.get(node)
    for (let parent = resolveParent(node); !own.extraneous && parent !== undefined && flags.get(parent).extraneous; parent = resolveParent(parent)) flags.get(parent).extraneous = false
    if (node.kind === 'link') {
      const target = flags.get(node.target)
      const changed = FLAGS.filter((flag) => target[flag] && !own[flag])
      for (const flag of changed) target[flag] = false
      if (changed.length > 0 || !seen.has(node.target)) queue.push(node.target)
      continue
    }
    for (const { type, to } of node.edges.values()) {
      if (to === undefined) continue
      const [dev, optional, peer] = [type === 'dev', type === 'optional' || type === 'peerOptional', type.startsWith('peer')]
      const unset = {
        extraneous: !own.extraneous && !(peer && optional),
        dev: !own.dev && !dev,
        optional: !own.optional && !optional,
        devOptional: !own.devOptional && !own.dev && !own.optional && !dev && !optional,
        peer: !own.peer && !peer,
      }
      const theirs = flags.get(to)
      const changed = FLAGS.filter((flag) => theirs[flag] && unset[flag])
      for (const flag of changed) theirs[flag] = false
      if (changed.length > 0) queue.push(to)
    }
  }
  for (const node of seen) {
    const own = flags.get(node)
    if (node.kind !== 'root' && own.devOptional && (own.dev || own.optional)) own.devOptional = false
  }
  return flags
}

// getBundler: the package whose tarball a node comes in, that of a node it
// is in first; else its parent, where that bundles it by name, or where
// what depends on it comes in the parent's tarball itself. `path` is
// shared down the walk, which npm ends where it comes round. A bundler
// lists what it bundles, so a node under none comes in none.
function bundlerOf(node, path = new Set()) {
  if (path.has(node)) return undefined
  path.add(node)
  const { parent } = node
  if (parent === undefined) return undefined
  const above = bundlerOf(parent, path)
  if (above !== undefined) return above
  if (parent.bundleDependencies?.includes(node.folder)) return parent
  for (const edge of node.edgesIn) if (bundlerOf(edge.from, path) === parent) return parent
  return undefined
}

function underBundler(node) {
  for (let parent = node.parent; parent !== undefined; parent = parent.parent) if (parent.bundleDependencies !== undefined) return true
  return false
}

// A package bundled in another's tarball comes from it, and from nothing
// else; the project's own it bundles are installed as any other.
function checkBundled(node, root) {
  const bundler = underBundler(node) ? bundlerOf(node) : undefined
  if (node.inBundle !== (bundler !== undefined)) {
    throw new LockfileError(bundler === undefined ? 'set, where nothing bundles it' : `expected true, as ${quote(bundler.location)} bundles it`, at(node.where, 'inBundle'))
  }
  const { resolution } = node
  if (bundler === undefined || bundler === root) {
    if (resolution === undefined) throw new LockfileError('expected where it comes from, resolved or an integrity', node.where)
  } else if (resolution !== undefined) {
    const written = resolution.type === 'git' || resolution.tarball !== undefined ? 'resolved' : 'integrity'
    throw new LockfileError(`npm takes it from the tarball of ${quote(bundler.location)}, and from nothing else`, at(node.where, written))
  }
}

// Each node's flags as npm sets them, and whether it comes in another's
// tarball.
export function checkFlags(nodes) {
  const flags = calcFlags(nodes)
  const root = nodes.get('')
  for (const node of nodes.values()) {
    if (node.kind === 'link') continue
    const own = flags.get(node)
    if (own.extraneous) throw new LockfileError('nothing installed leads to it, so npm takes it as extraneous, and prunes it', node.where)
    for (const flag of WRITTEN) {
      if (node.flags[flag] !== own[flag]) throw new LockfileError(`expected ${own[flag] ? 'true' : 'none'}, as npm sets it from what depends on it`, at(node.where, flag))
    }
    if (node.kind === 'package') checkBundled(node, root)
  }
}

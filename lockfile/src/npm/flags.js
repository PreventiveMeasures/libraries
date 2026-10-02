// What npm writes of how each node is depended on, as Arborist works it out
// from the tree (calcDepFlags, getBundler): flags npm leaves a dependency
// out by, under --omit, and which packages come in another's tarball.

import { LockfileError, at, quote } from '../error.js'
import { resolveParent } from './tree.js'

const FLAGS = ['dev', 'optional', 'devOptional', 'peer', 'extraneous']
const WRITTEN = ['dev', 'optional', 'devOptional', 'peer']

const initial = (nodes) => new Map([...nodes.values()].map((node) => [node, Object.fromEntries(FLAGS.map((flag) => [flag, node.kind !== 'root']))]))

// calcDepFlags, as npm 11.7 and later have it: each node starts with every
// flag but the project, and loses one wherever an edge without it leads to
// it from a node without it; an optional peer leaves it extraneous, and a
// node that is not leaves the nodes it is in not. A link takes what it
// leads to with it: from npm 11.18, by the flags it is without; before,
// `assign`, by setting it to its own, set or not, so that what it leads to
// may have a flag again. devOptional, the dependencies both of dev and of
// optional ones, is left set where either is.
function calcFlags(nodes, assign) {
  const flags = initial(nodes)
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
      if (assign) Object.assign(target, own)
      else for (const flag of changed) target[flag] = false
      if (assign || changed.length > 0 || !seen.has(node.target)) queue.push(node.target)
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

// treeverse's depth descent: a stack, from which each node is visited once,
// and its children pushed in order, so visited last first. `children` is
// given what the visit gave.
function descend(tree, visit, children) {
  const stack = [tree]
  const seen = new Set()
  while (stack.length > 0) {
    const node = stack.pop()
    if (seen.has(node)) continue
    seen.add(node)
    stack.push(...children(node, visit(node)))
  }
}

// calcDepFlags, as npm 9 to 11.6 have it: one walk from the project, which
// visits each node once, in the order of its edges, and unsets a flag of
// what an edge leads to where the node and the edge are without it, then of
// what that leads to by dependencies and peers but optional ones; and, of
// each node it visits without a flag, of the nodes it is in. A link sets
// what it leads to to its own, and is walked as that. Where a node's flags
// change once it is visited, the walk can leave what it leads to as it was.
function calcFlagsBefore(nodes) {
  const flags = initial(nodes)
  const root = nodes.get('')
  const resetParents = (node, flag) => {
    if (flags.get(node)[flag]) return
    for (let parent = resolveParent(node); parent !== undefined && flags.get(parent)[flag]; parent = resolveParent(parent)) flags.get(parent)[flag] = false
  }
  const unsetFlag = (start, flag) => {
    if (!flags.get(start)[flag]) return
    const unset = (node) => {
      flags.get(node).extraneous = false
      flags.get(node)[flag] = false
    }
    descend(start, (node) => {
      unset(node)
      if (node.kind === 'link') unset(node.target)
    }, (node) => [...(node.kind === 'link' ? node.target : node).edges.values()]
      .filter(({ type, to }) => to !== undefined && flags.get(to)[flag] && ((flag !== 'peer' && type === 'peer') || type === 'prod'))
      .map(({ to }) => to))
  }
  const step = (node) => {
    const own = flags.get(node)
    own.extraneous = false
    for (const flag of ['extraneous', 'dev', 'peer', 'devOptional', 'optional']) resetParents(node, flag)
    if (node.kind === 'link') {
      for (const flag of WRITTEN) flags.get(node.target)[flag] = own[flag]
      return step(node.target)
    }
    for (const { type, to } of node.edges.values()) {
      if (to === undefined) continue
      flags.get(to).extraneous = false
      const [dev, optional, peer] = [type === 'dev', type === 'optional' || type === 'peerOptional', type.startsWith('peer')]
      const unsetDevOptional = !own.devOptional && !own.dev && !own.optional && !dev && !optional
      if (!own.peer && !peer) unsetFlag(to, 'peer')
      if (unsetDevOptional) unsetFlag(to, 'devOptional')
      if (unsetDevOptional || (!own.dev && !dev)) unsetFlag(to, 'dev')
      if (unsetDevOptional || (!own.optional && !optional)) unsetFlag(to, 'optional')
    }
    return node
  }
  descend(root, step, (node, stepped) => [...stepped.edges.values()].map(({ to }) => to).filter((to) => to !== undefined))
  // npm writes devOptional where neither dev nor optional is.
  for (const own of flags.values()) if (own.dev || own.optional) own.devOptional = false
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

// The first node whose flags are not those `flags` gives it, and why.
function mismatch(nodes, flags) {
  for (const node of nodes.values()) {
    const own = flags.get(node)
    if (own.extraneous) return new LockfileError('nothing installed leads to it, so npm takes it as extraneous, and prunes it', node.where)
    if (node.kind === 'link') continue
    const flag = WRITTEN.find((name) => node.flags[name] !== own[name])
    if (flag !== undefined) return new LockfileError(`expected ${own[flag] ? 'true' : 'none'}, as npm sets it from what depends on it`, at(node.where, flag))
  }
  return undefined
}

// Each node's flags as npm sets them, all as one version of npm does, and
// whether it comes in another's tarball. Where none, the refusal is the
// latest version's.
export function checkFlags(nodes) {
  const error = mismatch(nodes, calcFlags(nodes, false))
  if (error !== undefined && mismatch(nodes, calcFlags(nodes, true)) !== undefined && mismatch(nodes, calcFlagsBefore(nodes)) !== undefined) throw error
  const root = nodes.get('')
  for (const node of nodes.values()) if (node.kind === 'package') checkBundled(node, root)
}

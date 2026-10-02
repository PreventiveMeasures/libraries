// The flags npm writes of how each node is depended on, which it leaves
// one out by under --omit, as Arborist's calcDepFlags works them out from
// the tree; in three ways, as npm's versions have had it.

import { LockfileError, at } from '../error.js'
import { FLAGS } from './entries.js'
import { packageOf, resolveParent } from './tree.js'

const ALL = [...FLAGS, 'extraneous']

// Every flag set but on the project, where none is.
const initial = (nodes) => new Map([...nodes.values()].map((node) => [node, Object.fromEntries(ALL.map((flag) => [flag, node.kind !== 'root']))]))

// resetParents: a flag a node is without, the nodes it is in are without.
function resetParents(flags, node, flag) {
  if (flags.get(node)[flag]) return
  for (let parent = resolveParent(node); parent !== undefined && flags.get(parent)[flag]; parent = resolveParent(parent)) flags.get(parent)[flag] = false
}

// What an edge's type is by Edge#dev, #optional and #peer.
const kinds = (type) => ({ dev: type === 'dev', optional: type === 'optional' || type === 'peerOptional', peer: type.startsWith('peer') })

// calcDepFlags, as npm 11.6.3 and later have it: each node starts with every
// flag but the project, and loses one wherever an edge without it leads to
// it from a node without it; an optional peer leaves it extraneous, and a
// node that is not leaves the nodes it is in not. A link takes what it
// leads to with it: from npm 11.18, by the flags it is without; before,
// `assign`, by setting it to its own, set or not, so that what it leads to
// may have a flag again.
function calcFlags(nodes, assign) {
  const flags = initial(nodes)
  const seen = new Set()
  const queue = [nodes.get('')]
  while (queue.length > 0) {
    const node = queue.pop()
    seen.add(node)
    const own = flags.get(node)
    resetParents(flags, node, 'extraneous')
    if (node.kind === 'link') {
      const target = flags.get(node.target)
      const changed = ALL.filter((flag) => target[flag] && !own[flag])
      if (assign) Object.assign(target, own)
      else for (const flag of changed) target[flag] = false
      if (assign || changed.length > 0 || !seen.has(node.target)) queue.push(node.target)
      continue
    }
    for (const { type, to } of node.edges.values()) {
      if (to === undefined) continue
      const { dev, optional, peer } = kinds(type)
      const unset = {
        extraneous: !own.extraneous && !(peer && optional),
        dev: !own.dev && !dev,
        optional: !own.optional && !optional,
        devOptional: !own.devOptional && !own.dev && !own.optional && !dev && !optional,
        peer: !own.peer && !peer,
      }
      const theirs = flags.get(to)
      const changed = ALL.filter((flag) => theirs[flag] && unset[flag])
      for (const flag of changed) theirs[flag] = false
      if (changed.length > 0) queue.push(to)
    }
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

// calcDepFlags, as npm 9 to 11.6.0 have it: one walk from the project, which
// visits each node once, in the order of its edges, and unsets a flag of
// what an edge leads to where the node and the edge are without it, then of
// what that leads to by dependencies and peers but optional ones; and, of
// each node it visits without a flag, of the nodes it is in. A link sets
// what it leads to to its own, and is walked as that. Where a node's flags
// change once it is visited, the walk can leave what it leads to as it was.
function calcFlagsBefore(nodes) {
  const flags = initial(nodes)
  const unsetFlag = (start, flag) => {
    if (!flags.get(start)[flag]) return
    const unset = (node) => Object.assign(flags.get(node), { extraneous: false, [flag]: false })
    descend(start, (node) => {
      unset(node)
      if (node.kind === 'link') unset(node.target)
    }, (node) => [...packageOf(node).edges.values()]
      .filter(({ type, to }) => to !== undefined && flags.get(to)[flag] && ((flag !== 'peer' && type === 'peer') || type === 'prod'))
      .map(({ to }) => to))
  }
  const step = (node) => {
    const own = flags.get(node)
    own.extraneous = false
    for (const flag of ALL) resetParents(flags, node, flag)
    if (node.kind === 'link') {
      for (const flag of FLAGS) flags.get(node.target)[flag] = own[flag]
      return step(node.target)
    }
    for (const { type, to } of node.edges.values()) {
      if (to === undefined) continue
      flags.get(to).extraneous = false
      const { dev, optional, peer } = kinds(type)
      if (!own.peer && !peer) unsetFlag(to, 'peer')
      if (!own.devOptional && !own.dev && !own.optional && !dev && !optional) unsetFlag(to, 'devOptional')
      if (!own.dev && !dev) unsetFlag(to, 'dev')
      if (!own.optional && !optional) unsetFlag(to, 'optional')
    }
    return node
  }
  descend(nodes.get(''), step, (node, stepped) => [...stepped.edges.values()].map(({ to }) => to).filter((to) => to !== undefined))
  return flags
}

// The first node whose flags are not those `flags` gives it, as npm writes
// them, and why: devOptional, of the dependencies both of dev and of
// optional ones, only where neither dev nor optional is. `npm` names the
// npm that sets them.
function mismatch(nodes, flags, npm) {
  for (const node of nodes.values()) {
    const own = flags.get(node)
    if (own.extraneous) return new LockfileError(`nothing installed leads to it, so ${npm} takes it as extraneous, and prunes it`, node.where)
    if (node.kind === 'link') continue
    const written = { ...own, devOptional: own.devOptional && !own.dev && !own.optional }
    const flag = FLAGS.find((name) => node.flags[name] !== written[name])
    if (flag !== undefined) return new LockfileError(`expected ${written[flag] ? 'true' : 'none'}, as ${npm} sets it from what depends on it`, at(node.where, flag))
  }
  return undefined
}

// The ways npm's versions work the flags out, the latest first: npm 11.18
// and later, npm 11.6.3 to 11.17, and npm 9 to 11.6.0. npm 11.6.1 and
// 11.6.2, which mark what a peer leads to peer whatever else leads to it,
// are not read here.
const VERSIONS = [(nodes) => calcFlags(nodes, false), (nodes) => calcFlags(nodes, true), calcFlagsBefore]

// The way an npm, 9 or later but 11.6.1 and 11.6.2, works the flags out.
function calcOf(npm) {
  const [major, minor, patch] = npm.split('.').map(Number)
  if (major > 11 || (major === 11 && minor >= 18)) return VERSIONS[0]
  return VERSIONS[major === 11 && (minor > 6 || (minor === 6 && patch >= 3)) ? 1 : 2]
}

// Each node's flags as npm sets them: all as `npm` does, where given; else
// as one version of npm does, and where none, the refusal is the latest
// version's.
export function checkFlags(nodes, npm) {
  const calc = npm === undefined ? VERSIONS[0] : calcOf(npm)
  const error = mismatch(nodes, calc(nodes), npm === undefined ? 'npm' : `npm ${npm}`)
  if (error !== undefined && (npm !== undefined || VERSIONS.slice(1).every((other) => mismatch(nodes, other(nodes), 'npm') !== undefined))) throw error
}

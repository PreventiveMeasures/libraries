// pnpm 12's own hoister (real-hoist, as of 12.21.0) of the tree hoisterTree (hoisted.js) makes: as @yarnpkg/nm's
// (nm-hoist.js), but for a cycle, whose edge back to a package on its path it cuts as it goes, each root hoisted
// onto until nothing moves. With autoInstallPeers alone, and no hoistingLimits or externalDependencies

import { DeptreeError } from '../error.js'
import { MAX_NODES, MAX_STEPS, depthFirst } from './nm-hoist.js'

// AbsorbDecision and ChildStep (absorption.rs), but for the peers and the
// borders.
const [FREE, DEFER, SAME_NODE, CONFLICT, PATH_SHADOW, USED_SHADOW] = ['free', 'defer', 'sameNode', 'conflict', 'pathShadow', 'usedShadow']
const [DROPPED, HOISTED, STAYED] = ['dropped', 'hoisted', 'stayed']

// Bounded as nm-hoist.js is, as a graph made to defeat it copies a node for each path through it; pnpm 12 has
// no bound. `stats` counts the steps and copies
function budgetOf({ maxSteps = MAX_STEPS, maxNodes = MAX_NODES, stats } = {}) {
  const counts = { steps: 0, nodes: 0 }
  const counter = (key, limit, what) => (n = 1) => {
    counts[key] += n
    if (stats !== undefined) stats[key] = counts[key]
    if (counts[key] > limit) throw new DeptreeError(`hoisting it ${what}, which is not supported`, 'lockfile')
  }
  return { step: counter('steps', maxSteps, `takes more than ${maxSteps} steps`), node: counter('nodes', maxNodes, `makes more than ${maxNodes} copies of packages`) }
}

// A node's dependencies as the crate's IndexSet keeps them: in the order added, a decoupled copy put in the
// place of what it copies (shift_remove_index, shift_insert), and those of a name found without a scan
class Edges {
  #slots = new Set()
  #slotOf = new Map()
  #byName = new Map()
  constructor(nodes = []) { for (const node of nodes) this.add(node) }
  get size() { return this.#slotOf.size }
  someNamed(name, test) { return this.#byName.get(name)?.some((slot) => test(slot.node)) ?? false }
  * [Symbol.iterator]() { for (const slot of this.#slots) yield slot.node }

  add(node) {
    if (this.#slotOf.has(node)) return
    this.#slotOf.set(node, { node })
    this.#slots.add(this.#slotOf.get(node))
    this.#byName.set(node.name, [...this.#byName.get(node.name) ?? [], this.#slotOf.get(node)])
  }

  delete(node) {
    const slot = this.#slotOf.get(node)
    this.#slots.delete(slot)
    this.#slotOf.delete(node)
    this.#byName.set(node.name, (this.#byName.get(node.name) ?? []).filter((other) => other !== slot))
  }

  replace(old, node) {
    const slot = this.#slotOf.get(old)
    slot.node = node
    this.#slotOf.delete(old)
    this.#slotOf.set(node, slot)
  }
}

// A result node's reference, the first of its BTreeSet, of which it has
// one, its node_ident; its locator; and whether two are of one package,
// same_locator (lib.rs).
const nodeIdent = (node) => node.references.values().next().value ?? ''
const nodeLocator = (node) => `${node.identName}@${nodeIdent(node)}`
const sameLocator = (left, right) => left.identName === right.identName && left.references.values().next().value === right.references.values().next().value

// The graph from `root`, each node made once, by `make`, and given the
// edges it has, in their order: copied depth first, shared as it shares.
function copied(root, make, budget) {
  const made = new Map([[root, make(root)]])
  depthFirst({ node: root, items: [...root.dependencies].values() }, (child, frame) => {
    budget.step()
    const seen = made.has(child)
    if (!seen) made.set(child, make(child))
    made.get(frame.node).dependencies.add(made.get(child))
    return seen ? undefined : { node: child, items: [...child.dependencies].values() }
  })
  return made.get(root)
}

// convert (tree.rs): the tree as result nodes, one for each node of it,
// coupled, to be copied before changed.
const convert = (tree, budget) => copied(tree, (node) => ({ name: node.name, identName: node.identName, references: new Set([node.reference]), dependencies: new Edges(), hoistedDependencies: new Map(), decoupled: false }), budget)

// decouple_child (lib.rs): a copy of `child` of its own in its place under `parent`, sharing what it depends
// on, unless it is one already
function decoupleChild(parent, child, budget) {
  if (child.decoupled) return child
  budget.node()
  budget.step(child.dependencies.size)
  const copy = { ...child, references: new Set(child.references), dependencies: new Edges(child.dependencies), hoistedDependencies: new Map(child.hoistedDependencies), decoupled: true }
  parent.dependencies.replace(child, copy)
  return copy
}

// build_hoist_ident_map (preferences.rs), yarn's buildPreferenceMap: by name, the idents that may take the
// root's slot, the root's own and its children's first, then by their dependents, most first, ties as found
function hoistIdentMapOf(root, budget) {
  const [preference, seen] = [new Map(), new Set([root])]
  depthFirst({ ident: nodeIdent(root), items: root.dependencies[Symbol.iterator]() }, (child, { ident }) => {
    budget.step()
    const key = `${child.name}\0${nodeIdent(child)}`
    if (!preference.has(key)) preference.set(key, { name: child.name, ident: nodeIdent(child), dependents: new Set() })
    preference.get(key).dependents.add(ident)
    if (seen.has(child)) return undefined
    seen.add(child)
    return { ident: nodeIdent(child), items: [...child.dependencies].values() }
  })
  const identMap = new Map([[root.name, [nodeIdent(root)]], ...[...root.dependencies].map((dep) => [dep.name, [nodeIdent(dep)]])])
  budget.step(preference.size)
  for (const { name, ident } of [...preference.values()].sort((a, b) => b.dependents.size - a.dependents.size)) {
    const idents = identMap.get(name) ?? identMap.set(name, []).get(name)
    if (!idents.includes(ident)) idents.push(ident)
  }
  return identMap
}

// is_preferred_ident (preferences.rs): whether a child's ident is the one
// its name prefers, as a name with none is taken to.
function isPreferredIdent(child, hoistIdentMap) {
  const preferred = hoistIdentMap.get(child.name)?.[0]
  return preferred === undefined || child.references.values().next().value === preferred
}

// get_used_dependencies (lib.rs): each name a node of the root's subtree
// had hoisted from it, which it resolves above the root, by what it was;
// the last found taking a name, a node's dependencies last first.
function usedOf(root, budget) {
  const [used, seen, pending] = [new Map(), new Set(), [root]]
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    budget.step()
    if (seen.has(node)) continue
    seen.add(node)
    for (const [name, dep] of node.hoistedDependencies) used.set(name, dep)
    for (const dep of node.dependencies) pending.push(dep)
  }
  return used
}

// The alias and locator is_cycle_edge (lib.rs) cuts an edge to where a node on the path, itself among them,
// has them; no two on a path share one, as such an edge is cut first
const edgeKey = (node) => `${node.name}\0${node.identName}\0${nodeIdent(node)}`

// path_shadowed (lib.rs): a package of the child's name, but another, below
// the root on the path.
function pathShadowed(child, path) {
  for (let i = 1; i < path.length; i++) if (path[i].dependencies.someNamed(child.name, (dep) => !sameLocator(dep, child))) return true
  return false
}

// absorb_decision (absorption.rs): the root's slot free (for the preferred ident, else defer), held by the same
// package (dropped) or by another (a conflict); a hoist or drop refused where it would shadow what the root's
// subtree resolves above it, or a nearer package of the name on the path
function absorbDecision(child, path, ctx) {
  const existing = ctx.rootIndex.get(child.name)
  const decision = existing === undefined ? (isPreferredIdent(child, ctx.hoistIdentMap) ? FREE : DEFER) : sameLocator(existing, child) ? SAME_NODE : CONFLICT
  if (decision !== FREE && decision !== SAME_NODE) return decision
  ctx.budget.step(path.length)
  if (ctx.used.has(child.name) && !sameLocator(ctx.used.get(child.name), child)) return USED_SHADOW
  return pathShadowed(child, path) ? PATH_SHADOW : decision
}

// apply_decision (absorption.rs): a free slot takes the child, moved there;
// a copy at the root drops it; the node keeps either as hoisted from it.
// Any other decision leaves it, for a later pass to try again.
function applyDecision(decision, child, node, { root, rootIndex }) {
  if (decision !== FREE && decision !== SAME_NODE) return STAYED
  node.dependencies.delete(child)
  node.hoistedDependencies.set(child.name, child)
  if (decision === SAME_NODE) return DROPPED
  root.dependencies.add(child)
  rootIndex.set(child.name, child)
  return HOISTED
}

// hoist_node_dependencies (lib.rs): each child of a node decided against the root, a cycle edge cut, then each
// that stayed walked, decoupled first. Whether an edge was moved, dropped or cut
function hoistNodeDependencies(start, ctx, wave) {
  let changed = false
  const [path, onPath] = [[ctx.root], new Set([edgeKey(ctx.root)])]
  const enter = (node) => {
    path.push(node)
    onPath.add(edgeKey(node))
    const stayed = []
    for (const child of [...node.dependencies]) {
      ctx.budget.step(path.length)
      const cut = onPath.has(edgeKey(child))
      if (cut) node.dependencies.delete(child)
      const step = cut ? DROPPED : applyDecision(absorbDecision(child, path, ctx), child, node, ctx)
      if (step === HOISTED) wave.push(child)
      if (step === STAYED) stayed.push(child)
      else changed = true
    }
    return { node, items: stayed.values() }
  }
  depthFirst(enter(start), (child, frame) => enter(decoupleChild(frame.node, child, ctx.budget)), () => onPath.delete(edgeKey(path.pop())))
  return changed
}

// hoist_graph (lib.rs): one pass in waves, each node moved to the root walked in the next, each that stays at
// once; a child cut where it is the root's package, else decoupled
function hoistGraph(ctx) {
  const { root, rootIndex, budget } = ctx
  let changed = false
  for (let next = [], wave = [...root.dependencies]; wave.length > 0; [wave, next] = [next, []]) {
    for (const edge of wave) {
      budget.step()
      const cut = edgeKey(edge) === edgeKey(root)
      if (cut) root.dependencies.delete(edge)
      else rootIndex.set(edge.name, decoupleChild(root, edge, budget))
      if (cut || hoistNodeDependencies(rootIndex.get(edge.name), ctx, next)) changed = true
    }
  }
  return changed
}

// hoist_into_root (lib.rs): passes of hoist_graph until one moves nothing and no name's ident shifts to its
// next, for a name nothing at the root holds; rootIndex keeps a name's last node, though its edge is cut
function hoistIntoRoot(root, used, budget) {
  const rootIndex = new Map([...root.dependencies].map((dep) => [dep.name, dep]))
  const ctx = { root, used, rootIndex, budget, hoistIdentMap: hoistIdentMapOf(root, budget) }
  for (let changed = true, shifted = true; changed || shifted;) {
    changed = hoistGraph(ctx)
    budget.step(ctx.hoistIdentMap.size)
    const shifting = [...ctx.hoistIdentMap].filter(([name, idents]) => idents.length > 1 && !rootIndex.has(name))
    for (const [, idents] of shifting) idents.shift()
    shifted = shifting.length > 0
  }
}

// hoist_to (lib.rs): the root hoisted onto, then each child left on it in
// turn, depth first, decoupled first, but one whose locator a root on the
// path has. Only the top root takes no names from above it.
function hoistTo(top, budget) {
  const onPath = new Set([nodeLocator(top)])
  const enter = (root, used, locator) => {
    hoistIntoRoot(root, used, budget)
    return { root, locator, items: [...root.dependencies].values() }
  }
  depthFirst(enter(top, new Map()), (child, frame) => {
    budget.step()
    if (onPath.has(nodeLocator(child))) return undefined
    onPath.add(nodeLocator(child))
    const root = decoupleChild(frame.root, child, budget)
    return enter(root, usedOf(root, budget), nodeLocator(child))
  }, ({ locator }) => onPath.delete(locator))
}

// nm_hoist (lib.rs): the tree converted, its root decoupled and hoisted onto from the top, then the result as
// HoisterResult has it, nodes shared as there, the root a copy of its own
function nmHoistWith(tree, budget) {
  const root = Object.assign(convert(tree, budget), { decoupled: true })
  hoistTo(root, budget)
  const top = copied(root, (node) => ({ name: node.name, identName: node.identName, references: new Set(node.references), dependencies: new Set() }), budget)
  return { ...top, references: new Set(top.references), dependencies: new Set(top.dependencies) }
}

// The hoist of hoisterTree's tree for pnpm 12, of nodes with a name, an identName, references and a Set of
// dependencies, in pnpm 12's order. `bounds` are `maxSteps`, `maxNodes` and `stats`
export const hoist12 = (tree, bounds) => nmHoistWith(tree, budgetOf(bounds))

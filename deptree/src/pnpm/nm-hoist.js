// The hoist of @yarnpkg/nm 4.0.5, which pnpm 9 and 10 bundle for the hoisted
// linker: each package is moved as near the root as it can go without
// shadowing a different one of its name for a package that needs that one.
// Step for step as it runs, with its recursions on stacks of their own, and
// its debug output and checks left out, which change nothing. pnpm sets no
// hoisting limits, hoist priorities or external soft links, which are left
// out too: the root alone is a hoist border, and nothing depends on it.

import { DeptreeError } from '../error.js'
import { REGULAR, WORKSPACE, buildPreferenceMap, depthFirst, getHoistIdentMap, getUsedDependencies, getZeroRoundUsedDependencies, hoistGraph, regularDependencies, walk } from './nm-hoist-graph.js'

export { REGULAR, WORKSPACE, depthFirst, reachable } from './nm-hoist-graph.js'

const makeLocator = (name, reference) => `${name}@${reference}`
const makeIdent = (name, reference) => {
  const hash = reference.indexOf('#')
  return makeLocator(name, hash >= 0 ? reference.slice(hash + 1) : reference)
}
const getIdentName = (locator) => locator.slice(0, locator.indexOf('@', 1))

// The steps hoisting may take, and the nodes of the tree it gives, past
// which it is refused: on a graph made to defeat it, the hoist walks each
// path through what it cannot hoist, and the tree has a copy of a package
// for each, of which there can be more than there is time or memory for.
const MAX_STEPS = 50_000_000
const MAX_NODES = 100_000

function counter(limit, what, stats) {
  let steps = 0
  return (count = 1) => {
    steps += count
    if (stats !== undefined) stats[what] = steps
    if (steps > limit) throw new DeptreeError(`hoisting it ${what}, which is not supported`, 'lockfile')
  }
}

// hoistTo of one node: its hoisting, until no name has another ident to try.
function hoistToNode(rootNodePath, parentShadowedNodes, options, flags, step) {
  const rootNode = rootNodePath.at(-1)
  step(rootNodePath.length)
  const preferenceMap = buildPreferenceMap(rootNode, step)
  step(preferenceMap.size)
  const hoistIdentMap = getHoistIdentMap(rootNode, preferenceMap)
  const usedDependencies = rootNodePath.length === 1 ? new Map() : options.fastLookupPossible ? getZeroRoundUsedDependencies(rootNodePath, step) : getUsedDependencies(rootNodePath, step)
  const hoistIdents = new Map([...hoistIdentMap].map(([name, idents]) => [name, idents[0]]))
  const shadowedNodes = new Map()
  let wasStateChanged
  do {
    const state = { rootNode, rootNodePath, usedDependencies, hoistIdents, parentShadowedNodes, shadowedNodes, options, step, seenNodes: new Set(), isGraphChanged: false, anotherRoundNeeded: false }
    hoistGraph(state)
    if (state.isGraphChanged) flags.isGraphChanged = true
    if (state.anotherRoundNeeded) flags.anotherRoundNeeded = true
    wasStateChanged = false
    step(hoistIdentMap.size)
    for (const [name, idents] of hoistIdentMap) {
      if (idents.length > 1 && !rootNode.dependencies.has(name)) {
        hoistIdents.delete(name)
        idents.shift()
        hoistIdents.set(name, idents[0])
        wasStateChanged = true
      }
    }
  } while (wasStateChanged)
  return shadowedNodes
}

// hoistTo: each node of the tree in turn becomes the root hoisted to, depth
// first along every path that does not come back to a package on it. The
// locators on the path are read by nothing else but the debug output.
function hoistTo(tree, options, step) {
  const flags = { anotherRoundNeeded: false, isGraphChanged: false }
  const locators = new Set([tree.locator])
  const enter = (path, parentShadowedNodes) => ({ path, shadowedNodes: hoistToNode(path, parentShadowedNodes, options, flags, step), items: regularDependencies(path.at(-1)) })
  depthFirst(enter([tree], new Map()), (dependency, frame) => {
    if (locators.has(dependency.locator)) return undefined
    locators.add(dependency.locator)
    return enter([...frame.path, dependency], frame.shadowedNodes)
  }, ({ path }) => locators.delete(path.at(-1).locator))
  return flags
}

// The working copy of the tree: a node per package node of the tree, shared
// where the tree shares it, and coupled then, so that hoisting copies it
// before it changes it.
function cloneTree(tree, step) {
  const workNodeOf = (node, dependencyKind) => ({
    name: node.name,
    references: new Set([node.reference]),
    locator: makeLocator(node.identName, node.reference),
    ident: makeIdent(node.identName, node.reference),
    dependencies: new Map(),
    originalDependencies: new Map(),
    hoistedDependencies: new Map(),
    peerNames: new Set(node.peerNames),
    decoupled: true,
    dependencyKind,
  })
  const treeCopy = workNodeOf(tree, WORKSPACE)
  const seenNodes = new Map([[tree, treeCopy]])
  const markNodeCoupled = (start) => walk(start, undefined, function* (node) {
    node.decoupled = false
    for (const dep of regularDependencies(node)) yield [dep]
  }, step)
  depthFirst({ workNode: treeCopy, items: tree.dependencies.values() }, (node, { workNode: parentNode }) => {
    step()
    const isSeen = seenNodes.has(node)
    if (!isSeen) seenNodes.set(node, workNodeOf(node, node.dependencyKind || REGULAR))
    const workNode = seenNodes.get(node)
    parentNode.dependencies.set(node.name, workNode)
    parentNode.originalDependencies.set(node.name, workNode)
    if (!isSeen) return { workNode, items: node.dependencies.values() }
    markNodeCoupled(workNode)
    return undefined
  })
  return treeCopy
}

// The hoisted tree, unfolded along each path into one of nodes with a name,
// an identName, references and dependencies, a node's peers left out.
function shrinkTree(tree, maxNodes, stats) {
  const step = counter(maxNodes, `makes a tree of more than ${maxNodes} packages`, stats)
  const treeCopy = { name: tree.name, identName: getIdentName(tree.locator), references: new Set(tree.references), dependencies: new Set() }
  const onPath = new Set([tree])
  depthFirst({ node: tree, result: treeCopy, items: regularDependencies(tree) }, (node, { node: parentWorkNode, result: parentNode }) => {
    step()
    const resultNode = parentWorkNode === node ? parentNode : { name: node.name, identName: getIdentName(node.locator), references: node.references, dependencies: new Set() }
    parentNode.dependencies.add(resultNode)
    if (onPath.has(node)) return undefined
    onPath.add(node)
    return { node, result: resultNode, items: regularDependencies(node) }
  }, ({ node }) => node !== tree && onPath.delete(node))
  return treeCopy
}

// `tree` is a node of `name`, `identName`, `reference`, `peerNames`,
// `dependencyKind` and a Set of `dependencies`, as pnpm's real-hoist makes
// it.
export function hoist(tree, { maxSteps = MAX_STEPS, maxNodes = MAX_NODES, stats } = {}) {
  const step = counter(maxSteps, `takes more than ${maxSteps} steps`, stats)
  const treeCopy = cloneTree(tree, step)
  const options = { fastLookupPossible: true }
  let anotherRoundNeeded
  do {
    const result = hoistTo(treeCopy, options, step)
    anotherRoundNeeded = result.anotherRoundNeeded || result.isGraphChanged
    options.fastLookupPossible = false
  } while (anotherRoundNeeded)
  return shrinkTree(treeCopy, maxNodes, stats)
}

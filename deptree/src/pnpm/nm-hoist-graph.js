// The hoisting of @yarnpkg/nm 4.0.5 to one root (nm-hoist.js): which of the
// packages below it move up to it, one pass at a time.

export const REGULAR = 0
export const WORKSPACE = 1

const YES = 0
const NO = 1
const DEPENDS = 2

const getAliasedLocator = (node) => `${node.name}@${node.locator}`

// Depth first, as pnpm recurses, on a stack: each item of a frame's `items`
// goes to `visit(item, frame)`, which gives the frame to go into, if any;
// each frame done goes to `leave`.
export function depthFirst(frame, visit, leave) {
  const stack = [frame]
  while (stack.length > 0) {
    const top = stack.at(-1)
    const { value, done } = top.items.next()
    if (done) {
      stack.pop()
      leave?.(top)
    } else {
      const next = visit(value, top)
      if (next !== undefined) stack.push(next)
    }
  }
}

// Depth first from `start`, each node once: `visit(node, extra)` runs as a
// node is reached, and yields the children to go on to and what each is
// reached with.
export function walk(start, extra, visit, step) {
  const seen = new Set()
  const enter = (node, given) => {
    step()
    if (seen.has(node)) return undefined
    seen.add(node)
    return { items: visit(node, given) }
  }
  depthFirst(enter(start, extra), (value) => enter(...value))
}

// What `starts` reach through `next`, but where `skip` says.
export function reachable(starts, next, skip = () => false) {
  const reached = new Set()
  const pending = [...starts]
  while (pending.length > 0) {
    const item = pending.pop()
    if (reached.has(item) || skip(item)) continue
    reached.add(item)
    pending.push(...next(item))
  }
  return reached
}

// A node's dependencies but its peers.
export function* regularDependencies(node) {
  for (const dep of node.dependencies.values()) if (!node.peerNames.has(dep.name)) yield dep
}

// The names used below the root: zero-round, each hoisted dependency's own;
// later, what each name a node had hoisted from it resolves to on the path.
export function getZeroRoundUsedDependencies(rootNodePath, step) {
  const used = new Map()
  walk(rootNodePath.at(-1), undefined, function* (node) {
    for (const dep of node.hoistedDependencies.values()) used.set(dep.name, dep)
    for (const dep of regularDependencies(node)) yield [dep]
  }, step)
  return used
}

export function getUsedDependencies(rootNodePath, step) {
  const used = new Map()
  walk(rootNodePath.at(-1), new Set(), function* (node, hidden) {
    for (const dep of node.hoistedDependencies.values()) {
      if (hidden.has(dep.name)) continue
      step(rootNodePath.length)
      for (const onPath of rootNodePath) {
        const resolved = onPath.dependencies.get(dep.name)
        if (resolved) used.set(resolved.name, resolved)
      }
    }
    const childrenHidden = new Set(node.dependencies.keys())
    for (const dep of regularDependencies(node)) yield [dep, childrenHidden]
  }, step)
  return used
}

function decoupleGraphNode(parent, node, step) {
  if (node.decoupled) return node
  step(node.dependencies.size + node.originalDependencies.size + node.hoistedDependencies.size + 1)
  const clone = {
    ...node,
    references: new Set(node.references),
    dependencies: new Map(node.dependencies),
    originalDependencies: new Map(node.originalDependencies),
    hoistedDependencies: new Map(node.hoistedDependencies),
    peerNames: new Set(node.peerNames),
    decoupled: true,
  }
  const selfDep = clone.dependencies.get(node.name)
  if (selfDep && selfDep.ident === clone.ident) clone.dependencies.set(node.name, clone)
  parent.dependencies.set(clone.name, clone)
  return clone
}

// Each package below `rootNode` by name and ident, with who depends on it,
// and as a peer, but the root's peers. pnpm sets no hoist priority.
export function buildPreferenceMap(rootNode, step) {
  const preferenceMap = new Map()
  const entryOf = (node) => {
    const key = `${node.name}@${node.ident}`
    if (!preferenceMap.has(key)) preferenceMap.set(key, { dependents: new Set(), peerDependents: new Set() })
    return preferenceMap.get(key)
  }
  walk(rootNode, undefined, function* (node) {
    for (const dep of node.dependencies.values()) {
      if (!node.peerNames.has(dep.name)) {
        entryOf(dep).dependents.add(node.ident)
        yield [dep]
      } else if (node !== rootNode) {
        entryOf(dep).peerDependents.add(node.ident)
      }
    }
  }, step)
  return preferenceMap
}

// By name, the idents to try at the root, the most wanted first.
export function getHoistIdentMap(rootNode, preferenceMap) {
  const identMap = new Map([[rootNode.name, [rootNode.ident]]])
  for (const dep of regularDependencies(rootNode)) identMap.set(dep.name, [dep.ident])
  const wanted = (key) => preferenceMap.get(key).dependents.size + preferenceMap.get(key).peerDependents.size
  const keyList = [...preferenceMap.keys()].sort((key1, key2) => wanted(key2) - wanted(key1))
  for (const key of keyList) {
    const name = key.slice(0, key.indexOf('@', 1))
    const ident = key.slice(name.length + 1)
    if (rootNode.peerNames.has(name)) continue
    let idents = identMap.get(name)
    if (!idents) {
      idents = []
      identMap.set(name, idents)
    }
    if (!idents.includes(ident)) idents.push(ident)
  }
  return identMap
}

// A node's dependencies but its peers, each after the peers it has among
// them.
function getSortedRegularDependencies(node, step) {
  step(node.dependencies.size + 1)
  const dependencies = new Set()
  const frameOf = (dep) => ({ dep, items: dep.peerNames.values() })
  for (const top of regularDependencies(node)) {
    const seenDeps = new Set([top])
    depthFirst(frameOf(top), (peerName) => {
      const peerDep = node.peerNames.has(peerName) ? undefined : node.dependencies.get(peerName)
      if (!peerDep || dependencies.has(peerDep) || seenDeps.has(peerDep)) return undefined
      seenDeps.add(peerDep)
      step()
      return frameOf(peerDep)
    }, ({ dep }) => dependencies.add(dep))
  }
  return dependencies
}

// Whether a node of `node`'s name on the path, other than it, shadows it,
// which the parent then records.
function isShadowed(nodePath, node, shadowedNodes) {
  for (let idx = nodePath.length - 1; idx >= 1; idx--) {
    const parentDep = nodePath[idx].dependencies.get(node.name)
    if (!parentDep || parentDep.ident === node.ident) continue
    const parentNode = nodePath.at(-1)
    if (!shadowedNodes.has(parentNode)) shadowedNodes.set(parentNode, new Set())
    shadowedNodes.get(parentNode).add(node.name)
    return true
  }
  return false
}

// The parent's packages `node`'s peers are, which have to go to the root
// before it, or null where a peer up the path is not the root's.
function peersDependOn(rootNode, nodePath, node) {
  const dependsOn = new Set()
  const checkList = new Set(node.peerNames)
  for (let idx = nodePath.length - 1; idx >= 1; idx--) {
    const parent = nodePath[idx]
    for (const name of checkList) {
      if (parent.peerNames.has(name) && parent.originalDependencies.has(name)) continue
      const parentDepNode = parent.dependencies.get(name)
      if (parentDepNode && rootNode.dependencies.get(name) !== parentDepNode) {
        if (idx !== nodePath.length - 1) return null
        dependsOn.add(parentDepNode)
      }
      checkList.delete(name)
    }
  }
  return dependsOn
}

// Whether `node` goes to the root, in the order the checks are made, as
// one shadowing it is recorded as it is found. One that waits for its peers
// to go first does so whatever its hoisted dependencies say.
function getNodeHoistInfo(rootNode, nodePath, node, usedDependencies, hoistIdents, shadowedNodes, fastLookupPossible) {
  const no = { isHoistable: NO }
  if (node.ident === nodePath.at(-1).ident || node.dependencyKind === WORKSPACE || rootNode.peerNames.has(node.name)) return no
  const usedDep = usedDependencies.get(node.name)
  if ((usedDep && usedDep.ident !== node.ident) || isShadowed(nodePath, node, shadowedNodes) || hoistIdents.get(node.name) !== node.ident) return no
  const dependsOn = peersDependOn(rootNode, nodePath, node)
  if (dependsOn === null) return no
  if (dependsOn.size > 0) return { isHoistable: DEPENDS, dependsOn }
  const used = (dep) => usedDependencies.get(dep.name) || rootNode.dependencies.get(dep.name)
  if (!fastLookupPossible && node.hoistedDependencies.values().some((dep) => used(dep)?.ident !== dep.ident)) return no
  return { isHoistable: YES }
}

// hoistGraph's hoistNodeDependencies, of one parent: what of its own it
// hoists to the root, and the children it could not hoist, to go on into.
function hoistNodeDependencies(state, nodePath, parentNode, newNodes) {
  const { rootNode, usedDependencies, hoistIdents, parentShadowedNodes, shadowedNodes, options, step } = state
  const fullPath = [rootNode, ...nodePath, parentNode]
  const dependantTree = new Map()
  const hoistInfos = new Map()
  for (const subDependency of getSortedRegularDependencies(parentNode, step)) {
    step(fullPath.length + subDependency.peerNames.size + subDependency.hoistedDependencies.size)
    const hoistInfo = getNodeHoistInfo(rootNode, fullPath, subDependency, usedDependencies, hoistIdents, shadowedNodes, options.fastLookupPossible)
    hoistInfos.set(subDependency, hoistInfo)
    if (hoistInfo.isHoistable === DEPENDS) {
      for (const node of hoistInfo.dependsOn) {
        const dependants = dependantTree.get(node.name) || new Set()
        dependants.add(subDependency.name)
        dependantTree.set(node.name, dependants)
      }
    }
  }
  // What cannot go, and what waits for it to.
  const unhoistable = [...hoistInfos].filter(([, hoistInfo]) => hoistInfo.isHoistable === NO).map(([node]) => node)
  const unhoistableNodes = reachable(unhoistable, (node) => [...dependantTree.get(node.name) ?? []].map((name) => parentNode.dependencies.get(name)))
  for (const node of hoistInfos.keys()) {
    if (unhoistableNodes.has(node)) continue
    state.isGraphChanged = true
    if (parentShadowedNodes.get(parentNode)?.has(node.name)) state.anotherRoundNeeded = true
    parentNode.dependencies.delete(node.name)
    parentNode.hoistedDependencies.set(node.name, node)
    const hoistedNode = rootNode.dependencies.get(node.name)
    if (hoistedNode) {
      for (const reference of node.references) hoistedNode.references.add(reference)
    } else if (rootNode.ident !== node.ident) {
      rootNode.dependencies.set(node.name, node)
      newNodes.add(node)
    }
  }
  return { unhoistableNodes, children: getSortedRegularDependencies(parentNode, step) }
}

// hoistNodeDependencies from `start` down, through what it cannot hoist,
// each parent seen while what is below it is.
function hoistFrom(state, start, aliasedRootNodePathLocators, newNodes) {
  const { seenNodes, step } = state
  const call = (nodePath, aliasedLocatorPath, parentNode) => {
    if (seenNodes.has(parentNode)) return undefined
    step(aliasedLocatorPath.length + 1)
    const nextAliasedLocatorPath = [...aliasedLocatorPath, getAliasedLocator(parentNode)]
    const { unhoistableNodes, children } = hoistNodeDependencies(state, nodePath, parentNode, newNodes)
    return { nodePath, nextAliasedLocatorPath, parentNode, unhoistableNodes, items: children.values() }
  }
  const into = (node, frame) => {
    step(frame.nextAliasedLocatorPath.length)
    if (!frame.unhoistableNodes.has(node) || frame.nextAliasedLocatorPath.includes(getAliasedLocator(node))) return undefined
    seenNodes.add(frame.parentNode)
    const next = call([...frame.nodePath, frame.parentNode], frame.nextAliasedLocatorPath, decoupleGraphNode(frame.parentNode, node, step))
    if (next === undefined) seenNodes.delete(frame.parentNode)
    return next
  }
  const first = call([], aliasedRootNodePathLocators, start)
  if (first === undefined) return
  depthFirst(first, into, ({ nodePath }) => {
    if (nodePath.length > 0) seenNodes.delete(nodePath.at(-1))
  })
}

// One pass of hoisting to the root of `rootNodePath`, from each package that
// newly reached it, down through what stays where it is.
export function hoistGraph(state) {
  const { rootNode, rootNodePath, step } = state
  let nextNewNodes = new Set(getSortedRegularDependencies(rootNode, step))
  const aliasedRootNodePathLocators = rootNodePath.map(getAliasedLocator)
  do {
    const newNodes = nextNewNodes
    nextNewNodes = new Set()
    for (const dep of newNodes) {
      if (dep.locator === rootNode.locator) continue
      hoistFrom(state, decoupleGraphNode(rootNode, dep, step), aliasedRootNodePathLocators, nextNewNodes)
    }
  } while (nextNewNodes.size > 0)
}

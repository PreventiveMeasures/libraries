// The hoisting of @yarnpkg/nm 4.0.5 to one root (nm-hoist.js): which of the
// packages below it move up to it, one pass at a time.

export const WORKSPACE = 1

const YES = 0
const NO = 1
const DEPENDS = 2

const getAliasedLocator = (node) => `${node.name}@${node.locator}`

// Depth first from `start`, each node once, on a stack: `visit(node, extra)`
// runs as a node is reached, and gives the children to go on to and what
// each is reached with.
function walk(start, extra, visit, step) {
  const seen = new Set()
  const stack = []
  const enter = (node, given) => {
    step()
    if (seen.has(node)) return
    seen.add(node)
    stack.push(visit(node, given))
  }
  enter(start, extra)
  while (stack.length > 0) {
    const { value, done } = stack.at(-1).next()
    if (done) stack.pop()
    else enter(...value)
  }
}

// The names used below the root: zero-round, each hoisted dependency's own;
// later, what each name a node had hoisted from it resolves to on the path.
export function getZeroRoundUsedDependencies(rootNodePath, step) {
  const used = new Map()
  walk(rootNodePath.at(-1), undefined, function* (node) {
    for (const dep of node.hoistedDependencies.values()) used.set(dep.name, dep)
    for (const dep of node.dependencies.values()) if (!node.peerNames.has(dep.name)) yield [dep]
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
        const reachable = onPath.dependencies.get(dep.name)
        if (reachable) used.set(reachable.name, reachable)
      }
    }
    const childrenHidden = new Set()
    for (const dep of node.dependencies.values()) childrenHidden.add(dep.name)
    for (const dep of node.dependencies.values()) if (!node.peerNames.has(dep.name)) yield [dep, childrenHidden]
  }, step)
  return used
}

function decoupleGraphNode(parent, node, step) {
  if (node.decoupled) return node
  step(node.dependencies.size + node.originalDependencies.size + node.hoistedDependencies.size + 1)
  const clone = {
    name: node.name,
    references: new Set(node.references),
    ident: node.ident,
    locator: node.locator,
    dependencies: new Map(node.dependencies),
    originalDependencies: new Map(node.originalDependencies),
    hoistedDependencies: new Map(node.hoistedDependencies),
    peerNames: new Set(node.peerNames),
    decoupled: true,
    isHoistBorder: node.isHoistBorder,
    hoistPriority: node.hoistPriority,
    dependencyKind: node.dependencyKind,
  }
  const selfDep = clone.dependencies.get(node.name)
  if (selfDep && selfDep.ident === clone.ident) clone.dependencies.set(node.name, clone)
  parent.dependencies.set(clone.name, clone)
  return clone
}

// Each package below `rootNode` by name and ident, with who depends on it.
export function buildPreferenceMap(rootNode, step) {
  const preferenceMap = new Map()
  const seen = new Set([rootNode])
  const entryOf = (node) => {
    const key = `${node.name}@${node.ident}`
    let entry = preferenceMap.get(key)
    if (!entry) {
      entry = { dependents: new Set(), peerDependents: new Set(), hoistPriority: 0 }
      preferenceMap.set(key, entry)
    }
    return entry
  }
  const stack = []
  const addDependent = (dependent, node) => {
    const isSeen = seen.has(node)
    entryOf(node).dependents.add(dependent.ident)
    if (isSeen) return
    seen.add(node)
    step()
    stack.push({ node, deps: node.dependencies.values() })
  }
  for (const dep of rootNode.dependencies.values()) {
    if (rootNode.peerNames.has(dep.name)) continue
    addDependent(rootNode, dep)
    while (stack.length > 0) {
      const { node, deps } = stack.at(-1)
      const { value: child, done } = deps.next()
      if (done) {
        stack.pop()
        continue
      }
      step()
      const entry = entryOf(child)
      entry.hoistPriority = Math.max(entry.hoistPriority, child.hoistPriority)
      if (node.peerNames.has(child.name)) entry.peerDependents.add(node.ident)
      else addDependent(node, child)
    }
  }
  return preferenceMap
}

// By name, the idents to try at the root, the most wanted first.
export function getHoistIdentMap(rootNode, preferenceMap) {
  const identMap = new Map([[rootNode.name, [rootNode.ident]]])
  for (const dep of rootNode.dependencies.values()) {
    if (!rootNode.peerNames.has(dep.name)) identMap.set(dep.name, [dep.ident])
  }
  const keyList = [...preferenceMap.keys()]
  keyList.sort((key1, key2) => {
    const entry1 = preferenceMap.get(key1)
    const entry2 = preferenceMap.get(key2)
    if (entry2.hoistPriority !== entry1.hoistPriority) return entry2.hoistPriority - entry1.hoistPriority
    return (entry2.dependents.size + entry2.peerDependents.size) - (entry1.dependents.size + entry1.peerDependents.size)
  })
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
  for (const top of node.dependencies.values()) {
    if (node.peerNames.has(top.name)) continue
    const seenDeps = new Set([top])
    const stack = [{ dep: top, peers: top.peerNames.values() }]
    while (stack.length > 0) {
      const { dep, peers } = stack.at(-1)
      const { value: peerName, done } = peers.next()
      if (done) {
        dependencies.add(dep)
        stack.pop()
        continue
      }
      if (node.peerNames.has(peerName)) continue
      const peerDep = node.dependencies.get(peerName)
      if (!peerDep || dependencies.has(peerDep) || seenDeps.has(peerDep)) continue
      seenDeps.add(peerDep)
      step()
      stack.push({ dep: peerDep, peers: peerDep.peerNames.values() })
    }
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

function getNodeHoistInfo(rootNode, nodePath, node, usedDependencies, hoistIdents, shadowedNodes, fastLookupPossible) {
  let dependsOn = new Set()
  const parentNode = nodePath.at(-1)
  let isHoistable = node.ident !== parentNode.ident
  if (isHoistable) isHoistable = node.dependencyKind !== WORKSPACE
  if (isHoistable) isHoistable = !rootNode.peerNames.has(node.name)
  if (isHoistable) {
    const usedDep = usedDependencies.get(node.name)
    isHoistable = (!usedDep || usedDep.ident === node.ident) && !isShadowed(nodePath, node, shadowedNodes)
  }
  if (isHoistable) isHoistable = hoistIdents.get(node.name) === node.ident
  if (isHoistable) {
    dependsOn = peersDependOn(rootNode, nodePath, node)
    isHoistable = dependsOn !== null
  }
  if (isHoistable && !fastLookupPossible) {
    for (const origDep of node.hoistedDependencies.values()) {
      const usedDep = usedDependencies.get(origDep.name) || rootNode.dependencies.get(origDep.name)
      if (!usedDep || origDep.ident !== usedDep.ident) {
        isHoistable = false
        break
      }
    }
  }
  if (dependsOn !== null && dependsOn.size > 0) return { isHoistable: DEPENDS, dependsOn }
  return { isHoistable: isHoistable ? YES : NO }
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
  const unhoistableNodes = new Set()
  for (const [start, hoistInfo] of hoistInfos) {
    if (hoistInfo.isHoistable !== NO) continue
    const pending = [start]
    while (pending.length > 0) {
      const node = pending.pop()
      if (unhoistableNodes.has(node)) continue
      unhoistableNodes.add(node)
      hoistInfos.set(node, { isHoistable: NO })
      for (const dependantName of dependantTree.get(node.name) || []) pending.push(parentNode.dependencies.get(dependantName))
    }
  }
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
  return { unhoistableNodes, children: [...getSortedRegularDependencies(parentNode, step)] }
}

// hoistNodeDependencies from `start` down, through what it cannot hoist, as
// pnpm recurses, on a stack.
function hoistFrom(state, start, aliasedRootNodePathLocators, newNodes) {
  const { seenNodes, step } = state
  const stack = []
  const call = (nodePath, aliasedLocatorPath, parentNode) => {
    if (seenNodes.has(parentNode)) return
    step(aliasedLocatorPath.length + 1)
    const nextAliasedLocatorPath = [...aliasedLocatorPath, getAliasedLocator(parentNode)]
    stack.push({ nodePath, nextAliasedLocatorPath, parentNode, ...hoistNodeDependencies(state, nodePath, parentNode, newNodes), i: 0, inside: false })
  }
  call([], aliasedRootNodePathLocators, start)
  while (stack.length > 0) {
    const frame = stack.at(-1)
    if (frame.inside) {
      seenNodes.delete(frame.parentNode)
      frame.inside = false
    }
    if (frame.i === frame.children.length) {
      stack.pop()
      continue
    }
    const node = frame.children[frame.i++]
    step(frame.nextAliasedLocatorPath.length)
    if (!frame.unhoistableNodes.has(node) || node.isHoistBorder || frame.nextAliasedLocatorPath.includes(getAliasedLocator(node))) continue
    seenNodes.add(frame.parentNode)
    frame.inside = true
    call([...frame.nodePath, frame.parentNode], frame.nextAliasedLocatorPath, decoupleGraphNode(frame.parentNode, node, step))
  }
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
      if (dep.locator === rootNode.locator || dep.isHoistBorder) continue
      hoistFrom(state, decoupleGraphNode(rootNode, dep, step), aliasedRootNodePathLocators, nextNewNodes)
    }
  } while (nextNewNodes.size > 0)
}

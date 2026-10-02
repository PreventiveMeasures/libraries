// The lockfile's tree as Arborist holds it, for optionalSet to walk.

import { DeptreeError, quote } from '../error.js'

const IN_NODE_MODULES = /^(?:(.+)\/)?node_modules\/(?:@[^/]+\/)?[^/]+$/u

function parentOf(location, nodes) {
  const found = IN_NODE_MODULES.exec(location)
  if (found !== null) return found[1] ?? ''
  const segments = location.split('/')
  while (segments.pop() !== undefined) {
    const dir = segments.join('/')
    if (dir === '' || nodes.get(dir)?.kind === 'importer') return dir
  }
  return ''
}

// A node's children by their names, folded, as npm's CaseInsensitiveMap
// holds them and the lockfile reader resolves an edge.
const childKey = (parent, name) => `${parent}\n${name.toLowerCase()}`

function childrenOf(nodes) {
  const children = new Map()
  for (const { location } of nodes.values()) {
    const found = IN_NODE_MODULES.exec(location)
    if (found !== null) children.set(childKey(found[1] ?? '', location.slice(location.lastIndexOf('node_modules/') + 'node_modules/'.length)), nodes.get(location))
  }
  return children
}

// The link an edge to `target` is met by, the first of its name up the tree,
// held to lead where the lockfile reader found it to.
function linkOf(from, name, target, { nodes, children, links }) {
  for (let location = from.location; location !== undefined; location = nodes.get(location).parent) {
    const node = children.get(childKey(location, name))
    if (node === undefined) continue
    if (node.kind !== 'link' || `link:${links[node.location]}` !== target) break
    return node
  }
  throw new DeptreeError(`its ${quote(name)} is not met by the link to ${quote(target.slice('link:'.length))} the lockfile reader found`, quote(from.location))
}

// Packages in lockfile order, which npm checks them in. npm reads the
// project's and workspaces' package.json in place of their entries.
export function graphOf(lockfile, manifests) {
  const nodes = new Map()
  const add = (location, kind, pkg) => nodes.set(location, { location, kind, pkg, parent: undefined, edgesOut: [], edgesIn: [] })
  add('', 'root', lockfile.importers['.'])
  for (const [dir, importer] of Object.entries(lockfile.importers)) if (dir !== '.') add(dir, 'importer', importer)
  for (const [location, pkg] of Object.entries(lockfile.packages)) add(location, 'package', pkg)
  for (const location of Object.keys(lockfile.links)) add(location, 'link', undefined)
  for (const node of nodes.values()) {
    if (node.kind !== 'root') node.parent = parentOf(node.location, nodes)
    node.manifest = node.kind === 'link' ? undefined : manifests.get(node.location || '.') ?? node.pkg
  }
  const tree = { nodes, children: childrenOf(nodes), links: lockfile.links }
  for (const node of nodes.values()) {
    for (const [name, { type, target }] of Object.entries(node.pkg?.edges ?? {})) {
      if (target === undefined) continue
      const to = target.startsWith('link:') ? linkOf(node, name, target, tree) : nodes.get(target)
      if (to === undefined) throw new DeptreeError(`its ${quote(name)} is met by ${quote(target)}, which the lockfile does not have`, quote(node.location))
      const edge = { type, optional: type === 'optional' || type === 'peerOptional', from: node, to }
      node.edgesOut.push(edge)
      to.edgesIn.push(edge)
    }
  }
  return nodes
}

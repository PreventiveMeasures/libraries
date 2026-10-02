// The lockfile's tree as Arborist holds it, for optionalSet to walk.

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

function linkOf(from, name, nodes) {
  for (let location = from.location; ; location = nodes.get(location).parent) {
    const node = nodes.get(location === '' ? `node_modules/${name}` : `${location}/node_modules/${name}`)
    if (node !== undefined) return node
  }
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
  for (const node of nodes.values()) {
    for (const [name, { type, target }] of Object.entries(node.pkg?.edges ?? {})) {
      if (target === undefined) continue
      const to = target.startsWith('link:') ? linkOf(node, name, nodes) : nodes.get(target)
      const edge = { type, optional: type === 'optional' || type === 'peerOptional', from: node, to }
      node.edgesOut.push(edge)
      to.edgesIn.push(edge)
    }
  }
  return nodes
}

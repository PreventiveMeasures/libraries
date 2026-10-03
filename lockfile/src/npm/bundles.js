// Which packages come in another's tarball, as Arborist's getBundler works
// it out from the tree: npm writes them inBundle, and fetches nothing of
// them but where the project bundles them.

import { LockfileError, at, quote } from '../error.js'

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
  return node.edgesIn.some((edge) => bundlerOf(edge.from, path) === parent) ? parent : undefined
}

const underBundler = ({ parent }) => parent !== undefined && (parent.bundleDependencies !== undefined || underBundler(parent))

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

export function checkBundles(nodes) {
  const root = nodes.get('')
  for (const node of nodes.values()) if (node.kind === 'package') checkBundled(node, root)
}

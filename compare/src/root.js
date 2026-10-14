// A path through the root two trees are lined up by (layout.js treeLayout),
// and what a view of them shows of it: a directory of the old tree as the new
// one lays it out, and the root as a heading reads it. Kept apart from what
// finds the root, so a view that is given its trees lined up loads none of that.

export function throughRoot(root, path) {
  if (!root) return path
  if (root.base === '') return `${root.other}${path}`
  return path.startsWith(root.base) ? path.slice(root.base.length) : null
}

// A path outside a root as one inside it reaches it.
export const outside = (root, path) => `${'../'.repeat(root.base.split('/').length - 1)}${path}`

export function layoutDir({ root, paths }, dir, files) {
  if (!root || dir === '.') return dir
  for (const file of files) {
    const to = paths.get(`${dir}/${file}`)
    if (to?.endsWith(`/${file}`)) return to.slice(0, -file.length - 1)
  }
  const to = throughRoot(root, `${dir}/`)
  return to === null ? outside(root, dir) : to.slice(0, -1) || '.'
}

export function rootLabel(root, prefix) {
  if (!root) return { prefix, from: null, to: null }
  const kept = prefix.startsWith(root.other) ? prefix : ''
  return { prefix: kept, from: `./${root.base}${kept.slice(root.other.length)}`, to: `./${kept || root.other}` }
}

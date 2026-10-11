// A tree that cannot be a tree: `path` is the name at fault as its entry
// spelled it, `tree` 'old' or 'new'. Wrong argument types stay TypeErrors.

export class CompareError extends Error {
  constructor(detail, path, tree) {
    const where = tree === undefined ? '' : ` in the ${tree} tree`
    super(path === undefined ? detail : `${detail}: ${JSON.stringify(path)}${where}`)
    this.name = 'CompareError'
    this.path = path
    this.tree = tree
  }
}

// What a tree that does not hold together is refused with: a name given
// twice, something under a file, a hard link to nothing. `path` is the name
// at fault, as the entry spelled it, and `tree` says which of the two trees
// holds it. An argument of the wrong type or range is a TypeError or a
// RangeError instead, as it is everywhere else.

export class CompareError extends Error {
  constructor(detail, path, tree) {
    super(path === undefined ? detail : `${detail}: ${JSON.stringify(path)}${tree === undefined ? '' : ` in the ${tree} tree`}`)
    this.name = 'CompareError'
    this.path = path
    this.tree = tree
  }
}

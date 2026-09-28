// Hand-written against package.js; a change to either belongs with the other.

export interface PackageRepoLink {
  // `owner/name`, by GitHub's own rules.
  github?: string
  // Where in that repo the package sits, `/`-separated, as the tree path
  // itself (a homepage URL's decoded); absent at its root, and whenever
  // `github` is.
  directory?: string
  // `https://github.com/<github>`, whenever there is a `github`.
  url?: string
}

// Read off `bugs`, `repository` and `homepage`, in that order, from a
// package.json or the registry's document for a version of one. Both
// fields absent where nothing in it names a GitHub repo; a throw only
// for something that is not an object at all.
export function getRepo(pkg: object): PackageRepoLink

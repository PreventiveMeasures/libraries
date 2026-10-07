// Hand-written against package.js; a change to either belongs with the other.

export interface PackageRepoLink {
  // `owner/name`, by GitHub's own rules.
  github?: string
  // Where in that repo the package sits, `/`-separated, as the tree path
  // itself (a homepage URL's decoded; a `repository.directory`'s `\` read
  // as `/`, its empty and `.` parts dropped); `''` at its root, where
  // `repository.directory` declares it (`./`, `/`, `/.`, `.`, `''`). Absent
  // where unknown: neither field names a directory in it (one with a `..`
  // part names none), and whenever `github` is absent.
  directory?: string
  // `https://github.com/<github>`, whenever there is a `github`.
  url?: string
}

// Read off `repository`, `bugs` and `homepage`, in that order, from a
// package.json or the registry's document for a version of one. Both
// fields absent where nothing in it names a GitHub repo; a throw only
// for something that is not an object at all.
export function getRepo(pkg: object): PackageRepoLink

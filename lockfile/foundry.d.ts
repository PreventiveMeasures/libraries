// Reads a foundry.lock. Throws a LockfileError for anything forge would not
// write, would read otherwise than other readers, or would not check out as
// the lockfile says, a short commit hash among it; and a TypeError for bad
// arguments.
export function parseFoundryLockfile(text: string, options?: FoundryOptions): FoundryLockfile

// Reads a .gitmodules. Throws a LockfileError for what git does not read,
// reads otherwise from one version or command to another, or ignores with a
// warning; for a path out of the repository, and for a URL that is not of a
// host, as a path or one relative to the superproject's remote is not.
export function parseGitmodules(text: string): Record<string, Gitmodule>

export interface FoundryOptions {
  // The .gitmodules of the repository the lockfile is in, as text. forge
  // records every submodule of the repository, so each has to be in the
  // lockfile, and each dependency a submodule; without it, no dependency
  // has a url.
  gitmodules?: string
  // The lockfile's directory, from the root of the repository, where
  // .gitmodules is: `.` by default.
  directory?: string
}

// `where` is a property path, into the result, `["lib/forge-std"].tag.rev`,
// or into gitmodules, by submodule name; undefined for a syntax error, whose
// message has the line.
export class LockfileError extends Error {
  constructor(detail: string, where?: string)
  where: string | undefined
}

// Each Record has a null prototype, and keeps the order of its source.

export interface FoundryLockfile {
  // By path from the lockfile's directory, as `git submodule status` there
  // gives it: `lib/forge-std`, or `../../lib/x` for a submodule of the
  // repository outside the project.
  dependencies: Record<string, FoundryDependency>
}

export interface FoundryDependency {
  // How it was pinned: to a tag, to a branch, which forge update moves it
  // along, or to a commit alone. forge checks out a submodule that is not at
  // `rev` by the name of the tag or branch, and a commit by `rev`.
  type: 'tag' | 'branch' | 'rev'
  // The tag's or branch's; undefined for a rev.
  name: string | undefined
  // The commit, its full hash.
  rev: string
  // As .gitmodules has it; undefined without gitmodules.
  url: string | undefined
}

export interface Gitmodule {
  // From the root of the repository.
  path: string
  // An http(s), ssh or git URL, or `user@host:path`.
  url: string
  // What `git submodule update --remote` follows: a branch, or `.` for the
  // superproject's own. forge install records a branch it checks out here.
  branch: string | undefined
}

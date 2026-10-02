// Reads a foundry.lock. Throws a LockfileError for anything forge would not
// write, would read otherwise than other readers, or would not check out as
// the lockfile says, a short commit hash among it; and a TypeError for bad
// arguments.
export function parseFoundryLockfile(text: string, options?: FoundryOptions): FoundryLockfile

// Reads a .gitmodules. Throws a LockfileError for what git does not read,
// reads otherwise from one version or command to another, or ignores with a
// warning; for a path out of the repository, and, unless checkUrls is
// false, for a URL that is not of a host, as a path or one relative to the
// superproject's remote is not.
export function parseGitmodules(text: string, options?: GitmodulesOptions): Record<string, Gitmodule>

export interface GitmodulesOptions {
  // Whether each submodule has a url, and of a host: true by default. False
  // takes a url as written, relative to the superproject's remote or a path
  // among them, and a submodule without one, which git reads but clones
  // only where the clone's own config has its url. A url git ignores,
  // starting with "-", is refused all the same, as is one with a space or a
  // control character in it, one with a host or a user git or ssh would
  // read as an option, and one that names a remote helper, which git uses
  // for a submodule only where told to.
  checkUrls?: boolean
}

// checkUrls, which needs gitmodules too, is for it as parseGitmodules reads it.
export interface FoundryOptions extends GitmodulesOptions {
  // The .gitmodules of the repository the lockfile is in, as text: each
  // dependency has to be a submodule it maps, and takes its url. A submodule
  // the lockfile does not record is not refused, as .gitmodules may keep a
  // section whose gitlink is gone, which git and forge pass over. Without
  // it, no dependency has a url.
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
  // As .gitmodules has it; undefined without gitmodules, or where it has
  // none, with checkUrls false.
  url: string | undefined
}

export interface Gitmodule {
  // From the root of the repository.
  path: string
  // An http(s), ssh or git URL, or `user@host:path`, an IPv6 host in
  // brackets. With checkUrls false, as written, and undefined where there
  // is none.
  url: string | undefined
  // What `git submodule update --remote` follows: a branch, or `.` for the
  // superproject's own. forge install records a branch it checks out here.
  branch: string | undefined
}

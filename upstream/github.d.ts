// Hand-written against github.js; a change to either belongs with the other.
//
// Every method checks its arguments hard before any request is built: an
// options object holding only the keys listed here, a repo that is
// `owner/name` by GitHub's rules, branches and tags that git would take,
// full commit shas and tree ids, paths with no empty, `.` or `..`
// component, titles and headlines on one line. A bad one is a rejection
// naming the method; nothing is sent. Every URL is built from checked,
// encoded segments and has to come back out of URL parsing unchanged.
// Redirects are refused, except the tarballs', so an answer is about the
// repo asked for. A response is read up to a size limit (64 MiB of JSON,
// 128 MiB of a file, 512 MiB of a tarball) and within a timeout (30
// seconds, 5 minutes for a tarball), and what it says goes into an error
// message escaped.

// `owner/name`.
export type RepoName = string

export interface ClientOptions {
  // `null` for an anonymous client, which reads public repositories
  // without anyone's credentials. Required either way.
  token: string | null
  userAgent?: string
}

export type PullRequestStatus = 'open' | 'draft' | 'closed' | 'merged'

// An entry of a directory, as git has it, `path` its name: a file
// (`100644`, `100755` executable) or a symlink (`120000`) is a blob, a
// directory (`040000`) a tree, a submodule (`160000`) the commit it is at.
export interface RepoDirEntry {
  path: string
  mode: '100644' | '100755' | '120000' | '040000' | '160000'
  type: 'blob' | 'tree' | 'commit'
  sha: string
}

// A failed request: `status` is the HTTP status GitHub answered with.
export class HttpError extends Error {
  name: 'HttpError'
  status: number
}

// Reads only.
export interface Client {
  // An advisory by its GHSA id. With `repo`, that repository's published
  // copy: the maintainer's latest text, there before GitHub reviews it,
  // and shaped as a repository advisory (`state`, `patched_versions`, no
  // `type`). Without `repo`, or with a repository gone, renamed or blocked
  // (301, 404, 410, 451), GitHub's global database, which has it only once
  // reviewed; any other failure throws. Refused unless it is the one asked
  // for, and published.
  getAdvisory(options: { ghsa: string; repo?: RepoName }): Promise<{ ghsa_id: string } & Record<string, any>>
  // GitHub's `{ permission, role_name, user }` for `username` on `repo`,
  // teams, organization and enterprise grants included.
  getCollaboratorPermission(options: { repo: RepoName; username: string }): Promise<{ permission: string; role_name?: string; user: { login: string; id: number } } & Record<string, any>>
  getCurrentUser(): Promise<any>
  // Refused unless GitHub answers with that pull request in that repo.
  getPullRequest(options: { repo: RepoName; number: number }): Promise<{ title: string; status: PullRequestStatus }>
  // GitHub's repository object, refused unless it is the repo asked for.
  getRepo(options: { repo: RepoName }): Promise<any>
  // A file's contents as text, at `ref` or the default branch. Refused for
  // a directory, a symlink or a submodule, unless the bytes hash to the
  // blob GitHub names for the path, and unless valid UTF-8.
  getRepoFile(options: { repo: RepoName; path: string; ref?: string }): Promise<string>
  // The head of `branch`, or of the default branch without one.
  getRepoHead(options: { repo: RepoName; branch?: string }): Promise<{ branch: string; oid: string }>
  // The commit `tag` names: GitHub's ref for exactly that tag, an annotated
  // one's tag object followed to the commit, through up to 8 tags of tags.
  // Refused for a tag on anything but a commit.
  getRepoTag(options: { repo: RepoName; tag: string }): Promise<{ tag: string; oid: string }>
  // The repo's gzipped tarball at the full commit `sha`, whole, in memory:
  // getRepoTreeTarball's for the tree GitHub names for that commit, asked
  // on every call, cached or not. So its top directory is named for the
  // tree, and files marked `export-subst` are as committed, not rewritten.
  getRepoTarball(options: { repo: RepoName; sha: string }): Promise<Uint8Array>
  // The id of the tree at `directory`, `/`-separated as npm's is, in the
  // full commit `sha`, or of its root without one: from the tree GitHub
  // names for the commit, down GitHub's listings a directory at a time,
  // each hashed back to its id. Refused where `directory` is none.
  getRepoTreeId(options: { repo: RepoName; sha: string; directory?: string }): Promise<string>
  // The gzipped tarball of a tree, the repo's own or any subdirectory's, by
  // its id, whole, in memory: GitHub's, its files under one top directory.
  // Its files are hashed back into git's tree and the id must be `tree`,
  // whether downloaded or read from setCacheDir's cache (npm.js), where it
  // is kept by the id alone, for good; a cached copy that does not match
  // throws. A tarball shows a submodule as an empty directory, leaves out
  // a subtree with no file in it, and has a file marked `eol=crlf` with
  // CRLF where git has LF, as a checkout writes it: the submodule's commit,
  // the subtrees and the blobs come from GitHub's listings of the trees,
  // asked only then, cached or not, a file is taken for one written with
  // CRLF only where the tree's own .gitattributes, read as git reads them
  // from a tree, have git write it so, and the id must still come out
  // `tree`. The bytes are GitHub's: the tree as a checkout with no
  // `core.autocrlf` writes it, the same for every repo. So GitHub's tarball
  // is refused for a tree with files marked `export-ignore`, which it
  // leaves out, or `ident`, `filter` or `working-tree-encoding` beside
  // `eol=crlf`, or `eol=crlf` on a file git has with both CRLF and LF, or
  // with CRLF from attributes not in the tree; for one whose .gitattributes
  // on the way hold what git versions read apart (see src/attributes.js);
  // and from a repo set to include Git LFS objects in archives, which
  // replace the pointers git has; that repo still gets a tree already
  // cached, pointers and all.
  getRepoTreeTarball(options: { repo: RepoName; tree: string }): Promise<Uint8Array>
  // The repository's published security advisories, as GitHub's
  // repository advisory objects: every page of 100, each found by the
  // cursor in the one before's Link header. More than 100 pages is an
  // error.
  listRepoAdvisories(options: { repo: RepoName }): Promise<any[]>
  // The entries of `directory` in the full commit `sha`, or of its root,
  // found as getRepoTreeId finds it: GitHub's listing, hashed back to the
  // tree's id, so none is left out or changed.
  listRepoDir(options: { repo: RepoName; sha: string; directory?: string }): Promise<RepoDirEntry[]>
  // Every page of the repo's tags, as GitHub lists them, each with the
  // commit GitHub names for it, an annotated tag's included, which
  // getRepoTag checks is one; more than `maxPages` (100 by default) pages
  // of 100 is an error, as is a tag with no commit.
  listRepoTags(options: { repo: RepoName; maxPages?: number }): Promise<{ tag: string; oid: string }[]>
  // Every page of `GET /user/repos`, as GitHub's repository objects; more
  // than `maxPages` (100 by default) pages of 100 is an error.
  listUserRepos(options?: { maxPages?: number }): Promise<any[]>
}

export function createClient(options: ClientOptions): Client

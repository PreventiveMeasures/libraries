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
  // The repo's gzipped tarball at the full commit `sha`, whole, in memory:
  // getRepoTreeTarball's for the tree GitHub names for that commit, asked
  // on every call, cached or not. The cache is one for both, so the top
  // directory may be named for the tree rather than the commit.
  getRepoTarball(options: { repo: RepoName; sha: string }): Promise<Uint8Array>
  // The gzipped tarball of a tree, the repo's own or any subdirectory's, by
  // its id, whole, in memory: GitHub's, its files under one top directory.
  // Its files are hashed back into git's tree and the id must be `tree`,
  // whether downloaded or read from setCacheDir's cache (npm.js), where it
  // is kept by the id alone, for good; a cached copy that does not match
  // throws. A tarball shows a submodule as an empty directory, and leaves
  // out a subtree with no file in it: the submodule's commit and the
  // subtrees come from GitHub's listings of the trees, asked only then, and
  // the id must still come out `tree`.
  getRepoTreeTarball(options: { repo: RepoName; tree: string }): Promise<Uint8Array>
  // The repository's published security advisories, as GitHub's
  // repository advisory objects. One page of 100: GitHub pages this list
  // by cursor, so a repository with a full page is refused.
  listRepoAdvisories(options: { repo: RepoName }): Promise<any[]>
  // Every page of `GET /user/repos`, as GitHub's repository objects; more
  // than `maxPages` (100 by default) pages of 100 is an error.
  listUserRepos(options?: { maxPages?: number }): Promise<any[]>
}

export function createClient(options: ClientOptions): Client

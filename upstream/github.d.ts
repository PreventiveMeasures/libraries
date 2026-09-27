// Hand-written against github.js; a change to either belongs with the other.
//
// Every method checks its arguments hard before any request is built:
// an options object holding only the keys listed here, a repo that is
// `owner/name` by GitHub's rules, branches and tags that git would take,
// full commit shas, paths with no empty, `.` or `..` component, titles
// and headlines on one line. A bad one is a rejection naming the method;
// nothing is sent. Every URL is built from checked, encoded segments and
// has to come back out of URL parsing unchanged. Redirects are refused,
// except the tarball's, so an answer is about the repo asked for. A
// response is read up to a size limit (64 MiB of JSON, 128 MiB of a file,
// 512 MiB of a tarball) and within a timeout (30 seconds, 5 minutes for a
// tarball), and what it says goes into an error message escaped.

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
  // An advisory from GitHub's global database, by its GHSA id. One a
  // maintainer published reaches that database only once GitHub has
  // reviewed it, 404 until then; with `repo`, a 404 falls back to that
  // repository's own published copy, which is shaped as a repository
  // advisory (`state`, `patched_versions`, no `type`). Refused unless it is
  // the one asked for, and published.
  getAdvisory(options: { ghsa: string; repo?: RepoName }): Promise<{ ghsa_id: string } & Record<string, any>>
  // GitHub's `{ permission, role_name, user }` for `username` on `repo`,
  // teams, organization and enterprise grants included.
  getCollaboratorPermission(options: { repo: RepoName; username: string }): Promise<{ permission: string; role_name?: string; user: { login: string; id: number } } & Record<string, any>>
  getCurrentUser(): Promise<any>
  // Refused unless GitHub answers with that pull request in that repo.
  getPullRequest(options: { repo: RepoName; number: number }): Promise<{ title: string; status: PullRequestStatus }>
  // GitHub's repository object, refused unless it is the repo asked for.
  getRepo(options: { repo: RepoName }): Promise<any>
  // A file's raw contents, at `ref` or the default branch; refused unless
  // they are valid UTF-8.
  getRepoFile(options: { repo: RepoName; path: string; ref?: string }): Promise<string>
  // The head of `branch`, or of the default branch without one.
  getRepoHead(options: { repo: RepoName; branch?: string }): Promise<{ branch: string; oid: string }>
  // The repo's gzipped tarball at the full commit `sha`, whole, in memory.
  getRepoTarball(options: { repo: RepoName; sha: string }): Promise<Uint8Array>
  // Every page of `GET /user/repos`, as GitHub's repository objects; more
  // than `maxPages` (100 by default) pages of 100 is an error.
  listUserRepos(options?: { maxPages?: number }): Promise<any[]>
}

export function createClient(options: ClientOptions): Client

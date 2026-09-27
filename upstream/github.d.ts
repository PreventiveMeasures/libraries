// Hand-written against github.js; a change to either belongs with the other.

// `owner/name`, which is how every call below names a repo.
export type RepoName = string

export interface ClientOptions {
  token: string
  userAgent?: string
}

export type CommitMessage = string | { headline: string; body?: string }

export interface Client {
  // Into the authenticated user's account, or the given organization.
  // Answers GitHub's repo object; `full_name` names the fork.
  forkRepo(options: { repo: RepoName; name?: string; organization?: string; defaultBranchOnly?: boolean }): Promise<any>
  // At `oid`, or at the head of the default branch without one.
  createBranch(options: { repo: RepoName; branch: string; oid?: string }): Promise<any>
  // A signed commit on an existing branch, through GraphQL
  // createCommitOnBranch. `expectedHeadOid` defaults to the branch head.
  createCommit(options: {
    repo: RepoName
    branch: string
    message: CommitMessage
    additions?: { path: string; contents: string | Uint8Array }[]
    deletions?: (string | { path: string })[]
    expectedHeadOid?: string
  }): Promise<{ oid: string; url: string }>
  // `head` is `owner:branch` for a pull request from a fork.
  createPR(options: { repo: RepoName; title: string; head: string; base: string; body?: string; draft?: boolean }): Promise<any>
  getCurrentUser(): Promise<any>
  // The head of `branch`, or of the default branch without one.
  getRepoHead(options: { repo: RepoName; branch?: string }): Promise<{ branch: string; oid: string }>
  // A file's raw contents as UTF-8, at `ref` or the default branch.
  getRepoFile(options: { repo: RepoName; path: string; ref?: string }): Promise<string>
  // The repo's gzipped tarball at `sha`, whole, in memory.
  getRepoTarball(options: { repo: RepoName; sha: string }): Promise<Uint8Array>
}

export function createClient(options: ClientOptions): Client

// A GraphQL response's `data`, or a throw carrying the status and body on
// a transport error, malformed JSON or an `errors` array.
export function parseGraphQLResponse(status: number, text: string): any

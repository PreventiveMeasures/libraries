// Hand-written against github/write.js; a change to either belongs with
// the other. Arguments are checked as github.d.ts describes.

import type { Client, RepoName } from '../github.js'

export { GitHubError } from '../github.js'

export interface WriteClientOptions {
  // Never anonymous.
  token: string
  userAgent?: string
}

export type CommitMessage = string | { headline: string; body?: string }

export interface WriteClient extends Client {
  // Into the authenticated user's account, or the given organization.
  // Answers GitHub's repo object; `full_name` names the fork.
  forkRepo(options: { repo: RepoName; name?: string; organization?: string; defaultBranchOnly?: boolean }): Promise<any>
  // At the full commit `oid`, or at the head of the default branch
  // without one.
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
}

export function createWriteClient(options: WriteClientOptions): WriteClient

// A GraphQL response's `data`, or a throw carrying the status and body on
// a transport error, malformed JSON or an `errors` array.
export function parseGraphQLResponse(status: number, text: string): any

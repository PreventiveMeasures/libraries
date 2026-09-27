import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'

import {
  assertBoolean, assertLine, assertLogin, assertOptional, assertOptions, assertPath, assertRef, assertRepo, assertRepoName,
  assertSha, assertText,
} from '../args.js'
import { send } from '../http.js'
import { api, bindMethods, call, clientHeaders } from './client.js'
import { getRepoHead, readMethods } from './read.js'

const CREATE_COMMIT_MUTATION = `mutation($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) {
    commit { oid url }
  }
}`

function toBase64(value, what) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8').toString('base64')
  assert.ok(value instanceof Uint8Array, `createCommit: ${what} must be a string or a Uint8Array, got ${typeof value}`)
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64')
}

function normalizeMessage(message) {
  if (typeof message === 'string') {
    assertLine('createCommit', 'message', message)
    return { headline: message }
  }
  assertOptions('createCommit', 'message', message, ['headline', 'body'])
  assertLine('createCommit', 'message.headline', message.headline)
  assertOptional(assertText, 'createCommit', 'message.body', message.body)
  return { headline: message.headline, ...(message.body && { body: message.body }) }
}

// Parse and validate a GitHub GraphQL response. Throws with the response
// status + body on transport errors, JSON parse failures, or `errors[]`
// in the body. Pulled out of `graphql()` so the (otherwise globalThis-
// .fetch-coupled) error paths can be unit-tested without a mock.
//
// Why this matters: the previous shape was
//   const json = await res.json().catch(() => null)
//   throw new Error(`GitHub GraphQL ${res.status}: ${JSON.stringify(json)}`)
// which silently swallowed the original parse error AND the response
// body — every transport failure ended up as `… 502: null` in logs,
// useless for diagnosing rate limits, HTML error pages, or invalid
// tokens. Reading the body as text first and surfacing it (truncated
// for sanity) gives operators something to look at.
export function parseGraphQLResponse(status, text) {
  if (status < 200 || status >= 300) {
    throw new Error(`GitHub GraphQL ${status}: ${text || '(empty body)'}`)
  }
  let json
  try { json = JSON.parse(text) } catch (err) {
    throw new Error(`GitHub GraphQL ${status}: malformed JSON response (${err.message}): ${text.slice(0, 200)}`, { cause: err })
  }
  if (json.errors) throw new Error(`GitHub GraphQL: ${JSON.stringify(json.errors)}`)
  return json.data
}

// The query is always one of the constants above, and the variables go
// as JSON beside it, never into its text.
async function graphql(headers, query, variables) {
  assert.equal(query, CREATE_COMMIT_MUTATION)
  const res = await send(api(['graphql']), { method: 'POST', headers, body: { query, variables } })
  return parseGraphQLResponse(res.status, await res.text())
}

// Fork the given repo into the authenticated user's account (or the given
// organization). Returns the forked repo object; `full_name` is the handle
// to use in subsequent calls.
async function forkRepo(headers, options) {
  assertOptions('forkRepo', 'options', options, ['repo', 'name', 'organization', 'defaultBranchOnly'])
  const { repo, name, organization, defaultBranchOnly } = options
  assertRepo('forkRepo', 'repo', repo)
  assertOptional(assertRepoName, 'forkRepo', 'name', name)
  assertOptional(assertLogin, 'forkRepo', 'organization', organization)
  assertOptional(assertBoolean, 'forkRepo', 'defaultBranchOnly', defaultBranchOnly)
  const body = { ...(name && { name }), ...(organization && { organization }), ...(defaultBranchOnly && { default_branch_only: true }) }
  return await call(headers, api(['repos', ...repo.split('/'), 'forks']), { method: 'POST', body })
}

// Create a new branch at the given commit OID. If `oid` is omitted, the
// repo's default branch head is used. Returns the created ref object.
async function createBranch(headers, options) {
  assertOptions('createBranch', 'options', options, ['repo', 'branch', 'oid'])
  const { repo, branch, oid } = options
  assertRepo('createBranch', 'repo', repo)
  assertRef('createBranch', 'branch', branch)
  assertOptional(assertSha, 'createBranch', 'oid', oid)
  const sha = oid ?? (await getRepoHead(headers, { repo })).oid
  return await call(headers, api(['repos', ...repo.split('/'), 'git', 'refs']), { method: 'POST', body: { ref: `refs/heads/${branch}`, sha } })
}

// Each path at most once across both lists: a commit that adds and
// deletes one path, or adds it twice, says two things about it.
function fileChanges(additions, deletions) {
  assert.ok(Array.isArray(additions), 'createCommit: additions must be an array')
  assert.ok(Array.isArray(deletions), 'createCommit: deletions must be an array')
  const seen = new Set()
  const once = (path, what) => {
    assertPath('createCommit', what, path)
    assert.ok(!seen.has(path), `createCommit: ${what} names ${JSON.stringify(path)} a second time`)
    seen.add(path)
    return path
  }
  return {
    additions: additions.map((addition, i) => {
      assertOptions('createCommit', `additions[${i}]`, addition, ['path', 'contents'])
      return { path: once(addition.path, `additions[${i}].path`), contents: toBase64(addition.contents, `additions[${i}].contents`) }
    }),
    deletions: deletions.map((deletion, i) => {
      if (typeof deletion === 'string') return { path: once(deletion, `deletions[${i}]`) }
      assertOptions('createCommit', `deletions[${i}]`, deletion, ['path'])
      return { path: once(deletion.path, `deletions[${i}].path`) }
    }),
  }
}

// Create a signed commit on the given branch via the GraphQL
// createCommitOnBranch mutation. The branch must already exist — use
// createBranch() first to create a new one. Every variable sent is one
// checked here: the repo, the branch, the message, each path, and the
// head — passed in, or read from the branch and checked as a sha there.
//
// additions: [{ path, contents: string | Uint8Array }]
// deletions: [{ path } | path]
// expectedHeadOid: if omitted, the current branch head is fetched first.
async function createCommit(headers, options) {
  assertOptions('createCommit', 'options', options, ['repo', 'branch', 'message', 'additions', 'deletions', 'expectedHeadOid'])
  const { repo, branch, message, additions = [], deletions = [], expectedHeadOid } = options
  assertRepo('createCommit', 'repo', repo)
  assertRef('createCommit', 'branch', branch)
  assertOptional(assertSha, 'createCommit', 'expectedHeadOid', expectedHeadOid)
  const fileChangesInput = fileChanges(additions, deletions)
  const messageInput = normalizeMessage(message)
  const oid = expectedHeadOid ?? (await getRepoHead(headers, { repo, branch })).oid
  const input = {
    branch: { repositoryNameWithOwner: repo, branchName: branch },
    message: messageInput,
    fileChanges: fileChangesInput,
    expectedHeadOid: oid,
  }
  const data = await graphql(headers, CREATE_COMMIT_MUTATION, { input })
  return data.createCommitOnBranch.commit
}

// Open a pull request. For cross-repo PRs (e.g. from a fork), pass
// `head` as `"owner:branch"`; for same-repo PRs, pass just the branch.
async function createPR(headers, options) {
  assertOptions('createPR', 'options', options, ['repo', 'title', 'body', 'head', 'base', 'draft'])
  const { repo, title, body, head, base, draft } = options
  assertRepo('createPR', 'repo', repo)
  assertLine('createPR', 'title', title)
  assertOptional(assertText, 'createPR', 'body', body)
  const colon = typeof head === 'string' ? head.indexOf(':') : -1
  if (colon === -1) {
    assertRef('createPR', 'head', head)
  } else {
    assertLogin('createPR', 'head owner', head.slice(0, colon))
    assertRef('createPR', 'head branch', head.slice(colon + 1))
  }
  assertRef('createPR', 'base', base)
  assertOptional(assertBoolean, 'createPR', 'draft', draft)
  const payload = { title, head, base, ...(body && { body }), ...(draft && { draft: true }) }
  return await call(headers, api(['repos', ...repo.split('/'), 'pulls']), { method: 'POST', body: payload })
}

// Everything the read client does, and the four calls that change
// something: fork, branch, commit, pull request. Never anonymous.
export function createWriteClient(options) {
  const headers = clientHeaders('createWriteClient', options, { anonymous: false })
  return bindMethods(headers, { ...readMethods, createBranch, createCommit, createPR, forkRepo })
}

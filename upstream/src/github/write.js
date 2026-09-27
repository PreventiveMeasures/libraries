import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'

import { assertBoolean, assertLogin, assertOptional, assertOptions, assertPath, assertRef, assertRepoName, assertSha, assertString, assertText, parseRepo } from './args.js'
import { getRepoHead, readMethods } from './read.js'
import { API, bindMethods, clientHeaders, request } from './request.js'

const CREATE_COMMIT_MUTATION = `mutation($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) {
    commit { oid url }
  }
}`

function toBase64(value) {
  if (Buffer.isBuffer(value)) return value.toString('base64')
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64')
  if (typeof value === 'string') return Buffer.from(value, 'utf8').toString('base64')
  assert.fail(`Unsupported file contents type: ${typeof value}`)
}

function normalizeMessage(message) {
  if (typeof message === 'string') {
    assertText('createCommit', 'message', message)
    return { headline: message }
  }
  assert.ok(message !== null && typeof message === 'object' && !Array.isArray(message), 'createCommit: message must be a string or { headline, body? }')
  assertOptions('createCommit', message, ['headline', 'body'])
  assertText('createCommit', 'message.headline', message.headline)
  assertOptional(assertString, 'createCommit', 'message.body', message.body)
  const out = { headline: message.headline }
  if (message.body) out.body = message.body
  return out
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

async function graphql(headers, query, variables) {
  const res = await fetch(`${API}/graphql`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  return parseGraphQLResponse(res.status, await res.text())
}

// Fork the given repo into the authenticated user's account (or the given
// organization). Returns the forked repo object; `full_name` is the handle
// to use in subsequent calls.
function forkRepo(headers, options) {
  assertOptions('forkRepo', options, ['repo', 'name', 'organization', 'defaultBranchOnly'])
  const { repo, name, organization, defaultBranchOnly } = options
  const { owner, name: srcName } = parseRepo('forkRepo', repo)
  assertOptional(assertRepoName, 'forkRepo', 'name', name)
  assertOptional(assertLogin, 'forkRepo', 'organization', organization)
  assertOptional(assertBoolean, 'forkRepo', 'defaultBranchOnly', defaultBranchOnly)
  const body = {}
  if (name) body.name = name
  if (organization) body.organization = organization
  if (defaultBranchOnly) body.default_branch_only = true
  return request(headers, 'POST', `/repos/${owner}/${srcName}/forks`, { body })
}

// Create a new branch at the given commit OID. If `oid` is omitted, the
// repo's default branch head is used. Returns the created ref object.
async function createBranch(headers, options) {
  assertOptions('createBranch', options, ['repo', 'branch', 'oid'])
  const { repo, branch, oid } = options
  const { owner, name } = parseRepo('createBranch', repo)
  assertRef('createBranch', 'branch', branch)
  assertOptional(assertSha, 'createBranch', 'oid', oid)
  const sha = oid ?? (await getRepoHead(headers, { repo })).oid
  return request(headers, 'POST', `/repos/${owner}/${name}/git/refs`, {
    body: { ref: `refs/heads/${branch}`, sha },
  })
}

function fileChanges(additions, deletions) {
  assert.ok(Array.isArray(additions), 'createCommit: additions must be an array')
  assert.ok(Array.isArray(deletions), 'createCommit: deletions must be an array')
  return {
    additions: additions.map((addition, i) => {
      assertOptions('createCommit', addition, ['path', 'contents'])
      assertPath('createCommit', `additions[${i}].path`, addition.path)
      return { path: addition.path, contents: toBase64(addition.contents) }
    }),
    deletions: deletions.map((deletion, i) => {
      if (typeof deletion !== 'string') assertOptions('createCommit', deletion, ['path'])
      const path = typeof deletion === 'string' ? deletion : deletion.path
      assertPath('createCommit', `deletions[${i}]`, path)
      return { path }
    }),
  }
}

// Create a signed commit on the given branch via the GraphQL
// createCommitOnBranch mutation. The branch must already exist — use
// createBranch() first to create a new one.
//
// additions: [{ path, contents: string | Buffer | Uint8Array }]
// deletions: [{ path } | path]
// expectedHeadOid: if omitted, the current branch head is fetched first.
async function createCommit(headers, options) {
  assertOptions('createCommit', options, ['repo', 'branch', 'message', 'additions', 'deletions', 'expectedHeadOid'])
  const { repo, branch, message, additions = [], deletions = [], expectedHeadOid } = options
  parseRepo('createCommit', repo)
  assertRef('createCommit', 'branch', branch)
  assertOptional(assertSha, 'createCommit', 'expectedHeadOid', expectedHeadOid)
  const changes = fileChanges(additions, deletions)
  const headline = normalizeMessage(message)
  const oid = expectedHeadOid ?? (await getRepoHead(headers, { repo, branch })).oid
  const input = {
    branch: { repositoryNameWithOwner: repo, branchName: branch },
    message: headline,
    fileChanges: changes,
    expectedHeadOid: oid,
  }
  const data = await graphql(headers, CREATE_COMMIT_MUTATION, { input })
  return data.createCommitOnBranch.commit
}

// Open a pull request. For cross-repo PRs (e.g. from a fork), pass
// `head` as `"owner:branch"`; for same-repo PRs, pass just the branch.
function createPR(headers, options) {
  assertOptions('createPR', options, ['repo', 'title', 'body', 'head', 'base', 'draft'])
  const { repo, title, body, head, base, draft } = options
  const { owner, name } = parseRepo('createPR', repo)
  assertText('createPR', 'title', title)
  assertOptional(assertString, 'createPR', 'body', body)
  const colon = typeof head === 'string' ? head.indexOf(':') : -1
  if (colon === -1) {
    assertRef('createPR', 'head', head)
  } else {
    assertLogin('createPR', 'head owner', head.slice(0, colon))
    assertRef('createPR', 'head branch', head.slice(colon + 1))
  }
  assertRef('createPR', 'base', base)
  assertOptional(assertBoolean, 'createPR', 'draft', draft)
  const payload = { title, head, base }
  if (body) payload.body = body
  if (draft) payload.draft = true
  return request(headers, 'POST', `/repos/${owner}/${name}/pulls`, { body: payload })
}

// Everything the read client does, and the four calls that change
// something: fork, branch, commit, pull request. Never anonymous.
export function createWriteClient(options) {
  const headers = clientHeaders('createWriteClient', options, { anonymous: false })
  return bindMethods(headers, { ...readMethods, createBranch, createCommit, createPR, forkRepo })
}

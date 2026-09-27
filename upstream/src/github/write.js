import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'

import {
  assertBoolean, assertLine, assertLogin, assertOptional, assertOptions, assertPath, assertRef, assertRepo, assertRepoName,
  assertSha, assertText, printable,
} from '../args.js'
import { readBody, send } from '../http.js'
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

// The body is read as text first, so a failure's message keeps it.
// Exported to test the error paths without a fetch mock.
export function parseGraphQLResponse(status, text) {
  if (status < 200 || status >= 300) {
    throw new Error(`GitHub GraphQL ${status}: ${printable(text.slice(0, 4096)) || '(empty body)'}`)
  }
  let json
  try { json = JSON.parse(text) } catch (err) {
    throw new Error(`GitHub GraphQL ${status}: malformed JSON response (${err.message}): ${printable(text.slice(0, 200))}`, { cause: err })
  }
  if (json.errors) throw new Error(`GitHub GraphQL: ${printable(JSON.stringify(json.errors))}`)
  return json.data
}

const GRAPHQL_BYTES = 1024 * 1024

// The query is always the constant; the variables travel as JSON beside
// it, never in its text.
async function graphql(headers, query, variables) {
  assert.equal(query, CREATE_COMMIT_MUTATION)
  const res = await send(api(['graphql']), { method: 'POST', headers, body: { query, variables }, as: 'json' })
  return parseGraphQLResponse(res.status, new TextDecoder().decode(await readBody(res, GRAPHQL_BYTES)))
}

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

async function createBranch(headers, options) {
  assertOptions('createBranch', 'options', options, ['repo', 'branch', 'oid'])
  const { repo, branch, oid } = options
  assertRepo('createBranch', 'repo', repo)
  assertRef('createBranch', 'branch', branch)
  assertOptional(assertSha, 'createBranch', 'oid', oid)
  const sha = oid ?? (await getRepoHead(headers, { repo })).oid
  return await call(headers, api(['repos', ...repo.split('/'), 'git', 'refs']), { method: 'POST', body: { ref: `refs/heads/${branch}`, sha } })
}

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

// A signed commit, through createCommitOnBranch; the branch must exist.
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

export function createWriteClient(options) {
  const headers = clientHeaders('createWriteClient', options, { anonymous: false })
  return bindMethods(headers, { ...readMethods, createBranch, createCommit, createPR, forkRepo })
}

import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'

import {
  assertArgs, assertBoolean, assertLine, assertLogin, assertPath, assertRef, assertRepo, assertRepoName, assertSha, assertText,
  optional, printable,
} from '../args.js'
import { readBody, send } from '../http.js'
import { api, bindMethods, call, clientHeaders, repoApi } from './client.js'
import { getRepoHead, readMethods } from './read.js'

const CREATE_COMMIT_MUTATION = `mutation($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) {
    commit { oid url }
  }
}`

function toBase64(value, what) {
  assert.ok(typeof value === 'string' || value instanceof Uint8Array, `createCommit: ${what} must be a string or a Uint8Array, got ${typeof value}`)
  return Buffer.from(value).toString('base64')
}

function commitMessage(message) {
  if (typeof message === 'string') {
    assertLine('createCommit', 'message', message)
    return { headline: message }
  }
  assertArgs('createCommit', message, { headline: assertLine, body: optional(assertText) }, 'message')
  return { headline: message.headline, ...(message.body && { body: message.body }) }
}

function fileChanges(additions = [], deletions = []) {
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
      assertArgs('createCommit', addition, { path: null, contents: null }, `additions[${i}]`)
      return { path: once(addition.path, `additions[${i}].path`), contents: toBase64(addition.contents, `additions[${i}].contents`) }
    }),
    deletions: deletions.map((deletion, i) => {
      if (typeof deletion === 'string') return { path: once(deletion, `deletions[${i}]`) }
      assertArgs('createCommit', deletion, { path: null }, `deletions[${i}]`)
      return { path: once(deletion.path, `deletions[${i}].path`) }
    }),
  }
}

function assertHead(method, what, head) {
  const colon = typeof head === 'string' ? head.indexOf(':') : -1
  if (colon === -1) return assertRef(method, what, head)
  assertLogin(method, `${what} owner`, head.slice(0, colon))
  assertRef(method, `${what} branch`, head.slice(colon + 1))
}

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

// A signed commit; the branch must already exist.
async function createCommitOnBranch(headers, input) {
  const res = await send(api(['graphql']), { method: 'POST', headers, body: { query: CREATE_COMMIT_MUTATION, variables: { input } }, as: 'json' })
  return parseGraphQLResponse(res.status, new TextDecoder().decode(await readBody(res, 1024 * 1024))).createCommitOnBranch.commit
}

async function forkRepo(headers, options) {
  assertArgs('forkRepo', options, { repo: assertRepo, name: optional(assertRepoName), organization: optional(assertLogin), defaultBranchOnly: optional(assertBoolean) })
  const { repo, name, organization, defaultBranchOnly } = options
  const body = { ...(name && { name }), ...(organization && { organization }), ...(defaultBranchOnly && { default_branch_only: true }) }
  return await call(headers, repoApi(repo, ['forks']), { method: 'POST', body })
}

async function createBranch(headers, options) {
  assertArgs('createBranch', options, { repo: assertRepo, branch: assertRef, oid: optional(assertSha) })
  const { repo, branch } = options
  const sha = options.oid ?? (await getRepoHead(headers, { repo })).oid
  return await call(headers, repoApi(repo, ['git', 'refs']), { method: 'POST', body: { ref: `refs/heads/${branch}`, sha } })
}

async function createCommit(headers, options) {
  assertArgs('createCommit', options, { repo: assertRepo, branch: assertRef, message: null, additions: null, deletions: null, expectedHeadOid: optional(assertSha) })
  const { repo, branch } = options
  const changes = fileChanges(options.additions, options.deletions)
  const message = commitMessage(options.message)
  const expectedHeadOid = options.expectedHeadOid ?? (await getRepoHead(headers, { repo, branch })).oid
  return await createCommitOnBranch(headers, { branch: { repositoryNameWithOwner: repo, branchName: branch }, message, fileChanges: changes, expectedHeadOid })
}

async function createPR(headers, options) {
  assertArgs('createPR', options, { repo: assertRepo, title: assertLine, body: optional(assertText), head: assertHead, base: assertRef, draft: optional(assertBoolean) })
  const { repo, title, body, head, base, draft } = options
  const payload = { title, head, base, ...(body && { body }), ...(draft && { draft: true }) }
  return await call(headers, repoApi(repo, ['pulls']), { method: 'POST', body: payload })
}

export const createWriteClient = (options) => bindMethods(clientHeaders('createWriteClient', options, false), { ...readMethods, forkRepo, createBranch, createCommit, createPR })

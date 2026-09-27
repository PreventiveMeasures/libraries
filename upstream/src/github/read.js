import assert from 'node:assert/strict'

import { assertArgs, assertLogin, assertNumber, assertPath, assertRef, assertRepo, assertSha, isSha, optional, sameName, show } from '../args.js'
import { encodeSegment } from '../http.js'
import { api, bindMethods, call, clientHeaders, repoApi } from './client.js'

const PER_PAGE = 100
// A server that keeps answering full pages isn't asked forever.
const MAX_PAGES = 100

const getCurrentUser = (headers) => call(headers, api(['user']))

async function listUserRepos(headers) {
  const repos = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await call(headers, api(['user', 'repos'], { per_page: PER_PAGE, page, sort: 'full_name' }))
    assert.ok(Array.isArray(body), `listUserRepos: expected an array for page ${page}`)
    repos.push(...body)
    if (body.length < PER_PAGE) return repos
  }
  assert.fail(`listUserRepos: more than ${MAX_PAGES} pages`)
}

async function getRepo(headers, options) {
  assertArgs('getRepo', options, { repo: assertRepo })
  const info = await call(headers, repoApi(options.repo))
  assert.ok(sameName(info?.full_name, options.repo), `getRepo: answered for ${show(info?.full_name)}, not ${options.repo}`)
  return info
}

export async function getRepoHead(headers, options) {
  assertArgs('getRepoHead', options, { repo: assertRepo, branch: optional(assertRef) })
  const { repo, branch } = options
  // Checked like a branch passed in: it goes into the next URL.
  const ref = branch ?? (await getRepo(headers, { repo })).default_branch
  assertRef('getRepoHead', 'default branch', ref)
  const data = await call(headers, repoApi(repo, ['git', 'ref', 'heads', encodeSegment(ref)]))
  assert.ok(isSha(data?.object?.sha), `getRepoHead: no commit sha for ${repo}@${ref}`)
  return { branch: ref, oid: data.object.sha }
}

async function getRepoFile(headers, options) {
  assertArgs('getRepoFile', options, { repo: assertRepo, path: assertPath, ref: optional(assertRef) })
  const { repo, path, ref } = options
  const url = repoApi(repo, ['contents', ...path.split('/').map(encodeSegment)], ref === undefined ? {} : { ref })
  return await call({ ...headers, Accept: 'application/vnd.github.raw' }, url, { as: 'text' })
}

// The one request that follows a redirect, to codeload.github.com. A full
// sha only, so the bytes are that commit's, not wherever a ref points now.
async function getRepoTarball(headers, options) {
  assertArgs('getRepoTarball', options, { repo: assertRepo, sha: assertSha })
  return await call(headers, repoApi(options.repo, ['tarball', options.sha]), { as: 'bytes', redirect: 'follow' })
}

async function getPullRequest(headers, options) {
  assertArgs('getPullRequest', options, { repo: assertRepo, number: assertNumber })
  const { repo, number } = options
  const pr = await call(headers, repoApi(repo, ['pulls', String(number)]))
  const base = pr?.base?.repo?.full_name
  assert.ok(pr?.number === number && sameName(base, repo), `getPullRequest: answered for ${show(base)}#${show(pr?.number)}, not ${repo}#${number}`)
  assert.ok(typeof pr.title === 'string' && pr.title.trim() !== '', `getPullRequest: ${repo}#${number} has no title`)
  assert.ok(['open', 'closed'].includes(pr.state) && typeof pr.merged === 'boolean', `getPullRequest: ${repo}#${number} has no state`)
  const status = pr.merged ? 'merged' : (pr.state === 'closed' ? 'closed' : (pr.draft === true ? 'draft' : 'open'))
  return { title: pr.title, status }
}

async function getCollaboratorPermission(headers, options) {
  assertArgs('getCollaboratorPermission', options, { repo: assertRepo, username: assertLogin })
  const { repo, username } = options
  const body = await call(headers, repoApi(repo, ['collaborators', username, 'permission']))
  const login = body?.user?.login
  assert.ok(typeof body?.permission === 'string' && sameName(login, username), `getCollaboratorPermission: answered for ${show(login)}, not ${username}`)
  return body
}

export const readMethods = { getCurrentUser, listUserRepos, getRepo, getRepoHead, getRepoFile, getRepoTarball, getPullRequest, getCollaboratorPermission }
export const createClient = (options) => bindMethods(clientHeaders('createClient', options, true), readMethods)

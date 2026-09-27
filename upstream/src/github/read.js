import assert from 'node:assert/strict'

import { assertLogin, assertNumber, assertOptional, assertOptions, assertPath, assertRef, assertRepo, assertSha, isSha, show } from '../args.js'
import { encodeSegment } from '../http.js'
import { api, bindMethods, call, clientHeaders } from './client.js'

const PER_PAGE = 100
// A server that keeps answering full pages isn't asked forever.
const MAX_PAGES = 100

function repoSegments(method, repo) {
  assertRepo(method, 'repo', repo)
  return repo.split('/')
}

const sameName = (a, b) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase()

async function getCurrentUser(headers) {
  return await call(headers, api(['user']))
}

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
  assertOptions('getRepo', 'options', options, ['repo'])
  const info = await call(headers, api(['repos', ...repoSegments('getRepo', options.repo)]))
  assert.ok(sameName(info?.full_name, options.repo), `getRepo: answered for ${show(info?.full_name)}, not ${options.repo}`)
  return info
}

async function getCollaboratorPermission(headers, options) {
  const method = 'getCollaboratorPermission'
  assertOptions(method, 'options', options, ['repo', 'username'])
  const repo = repoSegments(method, options.repo)
  assertLogin(method, 'username', options.username)
  const body = await call(headers, api(['repos', ...repo, 'collaborators', options.username, 'permission']))
  const login = body?.user?.login
  assert.ok(typeof body?.permission === 'string' && sameName(login, options.username), `${method}: answered for ${show(login)}, not ${options.username}`)
  return body
}

async function getPullRequest(headers, options) {
  assertOptions('getPullRequest', 'options', options, ['repo', 'number'])
  const { repo, number } = options
  const segments = repoSegments('getPullRequest', repo)
  assertNumber('getPullRequest', 'number', number)
  const pr = await call(headers, api(['repos', ...segments, 'pulls', String(number)]))
  const base = pr?.base?.repo?.full_name
  assert.ok(pr?.number === number && sameName(base, repo), `getPullRequest: answered for ${show(base)}#${show(pr?.number)}, not ${repo}#${number}`)
  assert.ok(typeof pr.title === 'string' && pr.title.trim() !== '', `getPullRequest: ${repo}#${number} has no title`)
  assert.ok(['open', 'closed'].includes(pr.state) && typeof pr.merged === 'boolean', `getPullRequest: ${repo}#${number} has no state`)
  let status = 'open'
  if (pr.merged) status = 'merged'
  else if (pr.state === 'closed') status = 'closed'
  else if (pr.draft === true) status = 'draft'
  return { title: pr.title, status }
}

export async function getRepoHead(headers, options) {
  assertOptions('getRepoHead', 'options', options, ['repo', 'branch'])
  const { repo, branch } = options
  const segments = repoSegments('getRepoHead', repo)
  assertOptional(assertRef, 'getRepoHead', 'branch', branch)
  // Checked like a branch passed in: it goes into the next URL.
  const ref = branch ?? (await getRepo(headers, { repo })).default_branch
  assertRef('getRepoHead', 'default branch', ref)
  const data = await call(headers, api(['repos', ...segments, 'git', 'ref', 'heads', encodeSegment(ref)]))
  assert.ok(isSha(data?.object?.sha), `getRepoHead: no commit sha for ${repo}@${ref}`)
  return { branch: ref, oid: data.object.sha }
}

async function getRepoFile(headers, options) {
  assertOptions('getRepoFile', 'options', options, ['repo', 'path', 'ref'])
  const { repo, path, ref } = options
  const segments = repoSegments('getRepoFile', repo)
  assertPath('getRepoFile', 'path', path)
  assertOptional(assertRef, 'getRepoFile', 'ref', ref)
  const url = api(['repos', ...segments, 'contents', ...path.split('/').map(encodeSegment)], ref === undefined ? {} : { ref })
  return await call({ ...headers, Accept: 'application/vnd.github.raw' }, url, { as: 'text' })
}

// The one request that follows a redirect, to codeload.github.com. A full
// sha only, so the bytes are that commit's, not wherever a ref points now.
async function getRepoTarball(headers, options) {
  assertOptions('getRepoTarball', 'options', options, ['repo', 'sha'])
  const segments = repoSegments('getRepoTarball', options.repo)
  assertSha('getRepoTarball', 'sha', options.sha)
  return await call(headers, api(['repos', ...segments, 'tarball', options.sha]), { as: 'bytes', redirect: 'follow' })
}

export const readMethods = {
  getCollaboratorPermission, getCurrentUser, getPullRequest, getRepo, getRepoFile, getRepoHead, getRepoTarball, listUserRepos,
}

export function createClient(options) {
  return bindMethods(clientHeaders('createClient', options, { anonymous: true }), readMethods)
}

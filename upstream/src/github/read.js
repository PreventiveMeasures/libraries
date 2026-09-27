import assert from 'node:assert/strict'

import { assertArgs, assertGhsa, assertLogin, assertNumber, assertPath, assertRef, assertRepo, assertSha, isSha, optional, sameName, show } from '../args.js'
import { encodeSegment } from '../http.js'
import { api, bindMethods, call, clientHeaders, repoApi } from './client.js'

const PER_PAGE = 100
const MAX_PAGES = 100

// A list of exactly `maxPages` full pages is whole only if the next is empty.
async function* pages(method, headers, pageUrl, maxPages = MAX_PAGES) {
  for (let page = 1; ; page++) {
    const body = await call(headers, pageUrl({ per_page: PER_PAGE, page }))
    assert.ok(Array.isArray(body), `${method}: expected an array for page ${page}`)
    assert.ok(page <= maxPages || body.length === 0, `${method}: more than ${maxPages} pages`)
    yield body
    if (body.length < PER_PAGE) return
  }
}

const paginate = async (...args) => (await Array.fromAsync(pages(...args))).flat()
const getCurrentUser = (headers) => call(headers, api(['user']))

// No default for `options`: bindMethods counts it to refuse extra arguments.
async function listUserRepos(headers, options) {
  assertArgs('listUserRepos', options === undefined ? {} : options, { maxPages: optional(assertNumber) })
  return await paginate('listUserRepos', headers, (paging) => api(['user', 'repos'], { ...paging, sort: 'full_name' }), options?.maxPages)
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

async function getAdvisory(headers, options) {
  assertArgs('getAdvisory', options, { ghsa: assertGhsa })
  const advisory = await call(headers, api(['advisories', options.ghsa]))
  assert.ok(advisory?.ghsa_id === options.ghsa, `getAdvisory: answered for ${show(advisory?.ghsa_id)}, not ${options.ghsa}`)
  return advisory
}

export const readMethods = { getCurrentUser, listUserRepos, getRepo, getRepoHead, getRepoFile, getRepoTarball, getPullRequest, getCollaboratorPermission, getAdvisory }
export const createClient = (options) => bindMethods(clientHeaders('createClient', options, true), readMethods)

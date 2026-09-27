import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

import { assertArgs, assertGhsa, assertLogin, assertNumber, assertPath, assertRef, assertRepo, assertSha, isSha, optional, sameName, show } from '../args.js'
import { decode, encodeSegment } from '../http.js'
import { api, bindMethods, call, clientHeaders, isGone, repoApi } from './client.js'

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

// GitHub's object for the path first: a directory, symlink or submodule is
// refused rather than read as a file's text. Up to 1 MB the object holds
// the content; past it, `encoding: none`, and the blob it names is read,
// which a push to the ref since cannot change. Either way the bytes must
// hash to that blob.
async function getRepoFile(headers, options) {
  assertArgs('getRepoFile', options, { repo: assertRepo, path: assertPath, ref: optional(assertRef) })
  const { repo, path, ref } = options
  const url = repoApi(repo, ['contents', ...path.split('/').map(encodeSegment)], ref === undefined ? {} : { ref })
  const file = await call(headers, url)
  assert.ok(file?.type === 'file' && file.path === path && Number.isSafeInteger(file.size) && isSha(file.sha), `getRepoFile: ${repo} has no file at ${show(path)}`)
  assert.ok(file.encoding === 'none' || (file.encoding === 'base64' && /^[\dA-Za-z+/=\n]*$/u.test(file.content ?? '')), `getRepoFile: unexpected encoding for ${show(path)}`)
  const bytes = file.encoding === 'none'
    ? await call({ ...headers, Accept: 'application/vnd.github.raw' }, repoApi(repo, ['git', 'blobs', file.sha]), { as: 'bytes' })
    : Buffer.from(file.content, 'base64')
  const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
  assert.ok(bytes.length === file.size && blob === file.sha, `getRepoFile: ${show(path)} came back as blob ${blob}, not ${file.sha}`)
  return decode(bytes, url)
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

// The repository's copy is the maintainer's latest text, there from the
// start; the global database has it only once GitHub has reviewed it, and
// is the fallback for a repository that is gone, not for one that failed.
async function getAdvisory(headers, options) {
  assertArgs('getAdvisory', options, { ghsa: assertGhsa, repo: optional(assertRepo) })
  const { ghsa, repo } = options
  const global = () => call(headers, api(['advisories', ghsa]))
  const advisory = await (repo === undefined ? global() : call(headers, repoApi(repo, ['security-advisories', ghsa])).catch((err) => {
    if (!isGone(err)) throw err
    return global()
  }))
  assert.ok(advisory?.ghsa_id === ghsa, `getAdvisory: answered for ${show(advisory?.ghsa_id)}, not ${ghsa}`)
  assert.ok(advisory.state === undefined || advisory.state === 'published', `getAdvisory: ${ghsa} is ${show(advisory.state)}, not published`)
  return advisory
}

// One page: GitHub pages this list by a cursor in the Link header, which
// `call` does not read, so a full page is refused rather than cut short.
async function listRepoAdvisories(headers, options) {
  assertArgs('listRepoAdvisories', options, { repo: assertRepo })
  const list = await call(headers, repoApi(options.repo, ['security-advisories'], { state: 'published', per_page: PER_PAGE }))
  assert.ok(Array.isArray(list), `listRepoAdvisories: expected an array for ${options.repo}`)
  assert.ok(list.length < PER_PAGE, `listRepoAdvisories: ${options.repo} has ${PER_PAGE} or more published advisories, more than a page`)
  return list
}

export const readMethods = { getCurrentUser, listUserRepos, getRepo, getRepoHead, getRepoFile, getRepoTarball, getPullRequest, getCollaboratorPermission, getAdvisory, listRepoAdvisories }
export const createClient = (options) => bindMethods(clientHeaders('createClient', options, true), readMethods)

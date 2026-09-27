import assert from 'node:assert/strict'

import { assertLogin, assertNumber, assertOptional, assertOptions, assertPath, assertRef, assertRepo, assertSha, isSha } from '../args.js'
import { encodeSegment } from '../http.js'
import { api, bindMethods, call, clientHeaders } from './client.js'

const PER_PAGE = 100
// A hundred pages is ten thousand repositories: past that, a server that
// keeps answering full pages is not one to keep asking.
const MAX_PAGES = 100

// `owner/name` checked and split, for a method's options: each half is
// then a path segment on its own.
function repoSegments(method, repo) {
  assertRepo(method, 'repo', repo)
  return repo.split('/')
}

const sameName = (a, b) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase()

async function getCurrentUser(headers) {
  return await call(headers, api(['user']))
}

// Every repository the authenticated user can list (`GET /user/repos`),
// all pages, as GitHub's repository objects. With a login token that
// carries no repository permissions, that is the user's public repos.
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

// The repository object, refused unless it is the repository asked for.
async function getRepo(headers, options) {
  assertOptions('getRepo', 'options', options, ['repo'])
  const info = await call(headers, api(['repos', ...repoSegments('getRepo', options.repo)]))
  assert.ok(sameName(info?.full_name, options.repo), `getRepo: answered for ${info?.full_name}, not ${options.repo}`)
  return info
}

// A user's effective permission on a repo — teams, organization and
// enterprise grants included — as GitHub's `{ permission, role_name, user }`.
// A 404 is thrown as one: no such repo, or no access to it with this token.
async function getCollaboratorPermission(headers, options) {
  const method = 'getCollaboratorPermission'
  assertOptions(method, 'options', options, ['repo', 'username'])
  const repo = repoSegments(method, options.repo)
  assertLogin(method, 'username', options.username)
  const body = await call(headers, api(['repos', ...repo, 'collaborators', options.username, 'permission']))
  const login = body?.user?.login
  assert.ok(typeof body?.permission === 'string' && sameName(login, options.username), `${method}: answered for ${login}, not ${options.username}`)
  return body
}

// `{ title, status }` for one pull request, status being `merged`,
// `closed`, `draft` or `open`, in that order. Refused unless the answer is
// that pull request in that repo: redirects are refused, and the body has
// to carry the same number and a base repo of the same name.
async function getPullRequest(headers, options) {
  assertOptions('getPullRequest', 'options', options, ['repo', 'number'])
  const { repo, number } = options
  const segments = repoSegments('getPullRequest', repo)
  assertNumber('getPullRequest', 'number', number)
  const pr = await call(headers, api(['repos', ...segments, 'pulls', String(number)]))
  const base = pr?.base?.repo?.full_name
  assert.ok(pr?.number === number && sameName(base, repo), `getPullRequest: answered for ${base}#${pr?.number}, not ${repo}#${number}`)
  assert.ok(typeof pr.title === 'string' && pr.title.trim() !== '', `getPullRequest: ${repo}#${number} has no title`)
  assert.ok(['open', 'closed'].includes(pr.state) && typeof pr.merged === 'boolean', `getPullRequest: ${repo}#${number} has no state`)
  let status = 'open'
  if (pr.merged) status = 'merged'
  else if (pr.state === 'closed') status = 'closed'
  else if (pr.draft === true) status = 'draft'
  return { title: pr.title, status }
}

// Return { branch, oid } for the head of the given branch. If branch is
// omitted, the repo's default branch is used — held to the same rule as a
// branch passed in, since it goes into the next request's path.
export async function getRepoHead(headers, options) {
  assertOptions('getRepoHead', 'options', options, ['repo', 'branch'])
  const { repo, branch } = options
  const segments = repoSegments('getRepoHead', repo)
  assertOptional(assertRef, 'getRepoHead', 'branch', branch)
  const ref = branch ?? (await getRepo(headers, { repo })).default_branch
  assertRef('getRepoHead', 'default branch', ref)
  const data = await call(headers, api(['repos', ...segments, 'git', 'ref', 'heads', encodeSegment(ref)]))
  assert.ok(isSha(data?.object?.sha), `getRepoHead: no commit sha for ${repo}@${ref}`)
  return { branch: ref, oid: data.object.sha }
}

// Fetch the raw contents of a file at the given ref (defaults to the
// repo's default branch). Returns the file body as a UTF-8 string.
async function getRepoFile(headers, options) {
  assertOptions('getRepoFile', 'options', options, ['repo', 'path', 'ref'])
  const { repo, path, ref } = options
  const segments = repoSegments('getRepoFile', repo)
  assertPath('getRepoFile', 'path', path)
  assertOptional(assertRef, 'getRepoFile', 'ref', ref)
  const url = api(['repos', ...segments, 'contents', ...path.split('/').map(encodeSegment)], ref === undefined ? {} : { ref })
  return await call({ ...headers, Accept: 'application/vnd.github.raw' }, url, { as: 'text' })
}

// Fetch the repo's tarball at the given commit into memory. Returns the
// gzipped tar as a Uint8Array. The one redirect followed: this API
// answers with one to codeload.github.com.
//
// A full commit sha and nothing else: the bytes are then the ones that
// commit holds, rather than whatever a branch or a tag pointed at when
// they were asked for.
async function getRepoTarball(headers, options) {
  assertOptions('getRepoTarball', 'options', options, ['repo', 'sha'])
  const segments = repoSegments('getRepoTarball', options.repo)
  assertSha('getRepoTarball', 'sha', options.sha)
  return await call(headers, api(['repos', ...segments, 'tarball', options.sha]), { as: 'bytes', redirect: 'follow' })
}

export const readMethods = {
  getCollaboratorPermission, getCurrentUser, getPullRequest, getRepo, getRepoFile, getRepoHead, getRepoTarball, listUserRepos,
}

// Reads only: nothing a client made here can change anything on GitHub.
// A client that writes comes from github/write.js.
export function createClient(options) {
  return bindMethods(clientHeaders('createClient', options, { anonymous: true }), readMethods)
}

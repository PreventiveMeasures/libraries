import assert from 'node:assert/strict'

import { assertLogin, assertNumber, assertOptional, assertOptions, assertPath, assertRef, assertSha, isSha, parseRepo } from './args.js'
import { API, GitHubError, bindMethods, clientHeaders, request } from './request.js'

const PER_PAGE = 100

function getCurrentUser(headers) {
  return request(headers, 'GET', '/user')
}

// Every repository the authenticated user can list (`GET /user/repos`),
// all pages, as GitHub's repository objects. With a login token that
// carries no repository permissions, that is the user's public repos.
async function listUserRepos(headers) {
  const repos = []
  for (let page = 1; ; page++) {
    const body = await request(headers, 'GET', `/user/repos?per_page=${PER_PAGE}&page=${page}&sort=full_name`)
    assert.ok(Array.isArray(body), `listUserRepos: expected an array for page ${page}`)
    repos.push(...body)
    if (body.length < PER_PAGE) return repos
  }
}

// The repository object, refused unless it is the repository asked for.
async function getRepo(headers, options) {
  assertOptions('getRepo', options, ['repo'])
  const { owner, name } = parseRepo('getRepo', options.repo)
  const info = await request(headers, 'GET', `/repos/${owner}/${name}`)
  const fullName = info?.full_name
  assert.ok(typeof fullName === 'string' && fullName.toLowerCase() === options.repo.toLowerCase(), `getRepo: answered for ${fullName}, not ${options.repo}`)
  return info
}

// A user's effective permission on a repo — teams, organization and
// enterprise grants included — as GitHub's `{ permission, role_name, user }`.
// A 404 is thrown as one: no such repo, or no access to it with this token.
async function getCollaboratorPermission(headers, options) {
  assertOptions('getCollaboratorPermission', options, ['repo', 'username'])
  const { owner, name } = parseRepo('getCollaboratorPermission', options.repo)
  assertLogin('getCollaboratorPermission', 'username', options.username)
  const body = await request(headers, 'GET', `/repos/${owner}/${name}/collaborators/${options.username}/permission`)
  const login = body?.user?.login
  assert.ok(typeof body?.permission === 'string' && typeof login === 'string' && login.toLowerCase() === options.username.toLowerCase(), `getCollaboratorPermission: answered for ${login}, not ${options.username}`)
  return body
}

// `{ title, status }` for one pull request, status being `merged`,
// `closed`, `draft` or `open`, in that order. Refused unless the answer is
// that pull request in that repo: request() refuses a redirect, and the
// body has to carry the same number and a base repo of the same name.
async function getPullRequest(headers, options) {
  assertOptions('getPullRequest', options, ['repo', 'number'])
  const { repo, number } = options
  const { owner, name } = parseRepo('getPullRequest', repo)
  assertNumber('getPullRequest', 'number', number)
  const pr = await request(headers, 'GET', `/repos/${owner}/${name}/pulls/${number}`)
  const base = pr?.base?.repo?.full_name
  assert.ok(pr?.number === number && typeof base === 'string' && base.toLowerCase() === repo.toLowerCase(), `getPullRequest: answered for ${base}#${pr?.number}, not ${repo}#${number}`)
  assert.ok(typeof pr.title === 'string' && pr.title.trim() !== '', `getPullRequest: ${repo}#${number} has no title`)
  assert.ok(['open', 'closed'].includes(pr.state) && typeof pr.merged === 'boolean', `getPullRequest: ${repo}#${number} has no state`)
  let status = 'open'
  if (pr.merged) status = 'merged'
  else if (pr.state === 'closed') status = 'closed'
  else if (pr.draft === true) status = 'draft'
  return { title: pr.title, status }
}

// Return { branch, oid } for the head of the given branch. If branch is
// omitted, the repo's default branch is used.
export async function getRepoHead(headers, options) {
  assertOptions('getRepoHead', options, ['repo', 'branch'])
  const { repo, branch } = options
  const { owner, name } = parseRepo('getRepoHead', repo)
  assertOptional(assertRef, 'getRepoHead', 'branch', branch)
  const ref = branch ?? (await getRepo(headers, { repo })).default_branch
  assertRef('getRepoHead', 'default branch', ref)
  const data = await request(headers, 'GET', `/repos/${owner}/${name}/git/ref/heads/${encodeURIComponent(ref)}`)
  assert.ok(isSha(data?.object?.sha), `getRepoHead: no commit sha for ${repo}@${ref}`)
  return { branch: ref, oid: data.object.sha }
}

// Fetch the raw contents of a file at the given ref (defaults to the
// repo's default branch). Returns the file body as a UTF-8 string.
async function getRepoFile(headers, options) {
  assertOptions('getRepoFile', options, ['repo', 'path', 'ref'])
  const { repo, path, ref } = options
  const { owner, name } = parseRepo('getRepoFile', repo)
  assertPath('getRepoFile', 'path', path)
  assertOptional(assertRef, 'getRepoFile', 'ref', ref)
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : ''
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  const url = `/repos/${owner}/${name}/contents/${encoded}${query}`
  const text = await request(headers, 'GET', url, { accept: 'application/vnd.github.raw' })
  assert.ok(typeof text === 'string', `Expected file contents, got ${typeof text}`)
  return text
}

// Fetch the repo's tarball at the given commit into memory. Returns the
// gzipped tar as a Uint8Array. Not through request(): that reads the
// body as text, which would mangle the bytes, and refuses redirects,
// while this API answers with one to codeload.github.com.
//
// A full commit sha and nothing else: the bytes are then the ones that
// commit holds, rather than whatever a branch or a tag pointed at when
// they were asked for.
async function getRepoTarball(headers, options) {
  assertOptions('getRepoTarball', options, ['repo', 'sha'])
  const { owner, name } = parseRepo('getRepoTarball', options.repo)
  assertSha('getRepoTarball', 'sha', options.sha)
  const path = `/repos/${owner}/${name}/tarball/${options.sha}`
  const res = await fetch(`${API}${path}`, { headers })
  if (!res.ok) throw new GitHubError(res.status, `GitHub GET ${path} ${res.status}: ${await res.text()}`)
  return new Uint8Array(await res.arrayBuffer())
}

export const readMethods = {
  getCollaboratorPermission, getCurrentUser, getPullRequest, getRepo, getRepoFile, getRepoHead, getRepoTarball, listUserRepos,
}

// Reads only: nothing a client made here can change anything on GitHub.
// A client that writes comes from github/write.js.
export function createClient(options) {
  return bindMethods(clientHeaders('createClient', options, { anonymous: true }), readMethods)
}

import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'

const API = 'https://api.github.com'
// No dots in the owner, which GitHub never allows in a login, and a name
// that is not `.` or `..`: either would be a dot segment in the request
// path, which URL parsing resolves, sending the request elsewhere.
const REPO_RE = /^[\w-]+\/(?!\.{1,2}$)[\w.-]+$/u

const CREATE_COMMIT_MUTATION = `mutation($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) {
    commit { oid url }
  }
}`

function parseRepo(repo) {
  assert.ok(typeof repo === 'string' && REPO_RE.test(repo), `Expected "owner/name", got: ${repo}`)
  const [owner, name] = repo.split('/')
  return { owner, name }
}

function toBase64(value) {
  if (Buffer.isBuffer(value)) return value.toString('base64')
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64')
  if (typeof value === 'string') return Buffer.from(value, 'utf8').toString('base64')
  assert.fail(`Unsupported file contents type: ${typeof value}`)
}

function normalizeMessage(message) {
  if (typeof message === 'string') return { headline: message }
  assert.ok(message && typeof message.headline === 'string', 'commit message requires a headline')
  const out = { headline: message.headline }
  if (message.body) out.body = message.body
  return out
}

async function request(headers, method, path, { body, accept } = {}) {
  const reqHeaders = { ...headers }
  if (accept) reqHeaders.Accept = accept
  const opts = { method, headers: reqHeaders }
  if (body !== undefined) {
    reqHeaders['Content-Type'] = 'application/json'
    opts.body = JSON.stringify(body)
  }
  const res = await fetch(`${API}${path}`, opts)
  const text = await res.text()
  if (!res.ok) throw new Error(`GitHub ${method} ${path} ${res.status}: ${text}`)
  if (!text) return null
  const contentType = res.headers.get('content-type') ?? ''
  return contentType.includes('application/json') ? JSON.parse(text) : text
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
function forkRepo(headers, { repo, name, organization, defaultBranchOnly }) {
  const { owner, name: srcName } = parseRepo(repo)
  const body = {}
  if (name) body.name = name
  if (organization) body.organization = organization
  if (defaultBranchOnly) body.default_branch_only = true
  return request(headers, 'POST', `/repos/${owner}/${srcName}/forks`, { body })
}

function getCurrentUser(headers) {
  return request(headers, 'GET', '/user')
}

// Return { branch, oid } for the head of the given branch. If branch is
// omitted, the repo's default branch is used.
async function getRepoHead(headers, { repo, branch } = {}) {
  const { owner, name } = parseRepo(repo)
  let ref = branch
  if (!ref) {
    const info = await request(headers, 'GET', `/repos/${owner}/${name}`)
    ref = info.default_branch
  }
  const data = await request(headers, 'GET', `/repos/${owner}/${name}/git/ref/heads/${encodeURIComponent(ref)}`)
  return { branch: ref, oid: data.object.sha }
}

// Fetch the raw contents of a file at the given ref (defaults to the
// repo's default branch). Returns the file body as a UTF-8 string.
async function getRepoFile(headers, { repo, path, ref }) {
  assert.ok(path, 'getRepoFile requires a path')
  const { owner, name } = parseRepo(repo)
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : ''
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  const url = `/repos/${owner}/${name}/contents/${encoded}${query}`
  const text = await request(headers, 'GET', url, { accept: 'application/vnd.github.raw' })
  assert.ok(typeof text === 'string', `Expected file contents, got ${typeof text}`)
  return text
}

// Fetch the repo's tarball at the given commit into memory. Returns the
// gzipped tar as a Uint8Array. Not through request(): that reads the
// body as text, which would mangle the bytes. The API answers with a
// redirect to codeload.github.com, which fetch follows.
//
// A commit sha, full or abbreviated, and nothing else: the bytes are
// then the ones that commit holds, rather than whatever a branch or a
// tag pointed at when they were asked for.
const SHA_RE = /^[\da-f]{4,64}$/iu

async function getRepoTarball(headers, { repo, sha }) {
  assert.ok(typeof sha === 'string' && SHA_RE.test(sha), `getRepoTarball requires a commit sha, got: ${sha}`)
  const { owner, name } = parseRepo(repo)
  const path = `/repos/${owner}/${name}/tarball/${encodeURIComponent(sha)}`
  const res = await fetch(`${API}${path}`, { headers })
  if (!res.ok) throw new Error(`GitHub GET ${path} ${res.status}: ${await res.text()}`)
  return new Uint8Array(await res.arrayBuffer())
}

// Create a new branch at the given commit OID. If `oid` is omitted, the
// repo's default branch head is used. Returns the created ref object.
async function createBranch(headers, { repo, branch, oid }) {
  assert.ok(branch, 'createBranch requires a branch name')
  const { owner, name } = parseRepo(repo)
  const sha = oid ?? (await getRepoHead(headers, { repo })).oid
  return request(headers, 'POST', `/repos/${owner}/${name}/git/refs`, {
    body: { ref: `refs/heads/${branch}`, sha },
  })
}

// Create a signed commit on the given branch via the GraphQL
// createCommitOnBranch mutation. The branch must already exist — use
// createBranch() first to create a new one.
//
// additions: [{ path, contents: string | Buffer | Uint8Array }]
// deletions: [{ path } | path]
// expectedHeadOid: if omitted, the current branch head is fetched first.
async function createCommit(headers, {
  repo, branch, message, additions = [], deletions = [], expectedHeadOid,
}) {
  assert.ok(branch, 'createCommit requires a branch')
  parseRepo(repo)
  const oid = expectedHeadOid ?? (await getRepoHead(headers, { repo, branch })).oid
  const input = {
    branch: { repositoryNameWithOwner: repo, branchName: branch },
    message: normalizeMessage(message),
    fileChanges: {
      additions: additions.map((a) => ({ path: a.path, contents: toBase64(a.contents) })),
      deletions: deletions.map((d) => (typeof d === 'string' ? { path: d } : { path: d.path })),
    },
    expectedHeadOid: oid,
  }
  const data = await graphql(headers, CREATE_COMMIT_MUTATION, { input })
  return data.createCommitOnBranch.commit
}

// Open a pull request. For cross-repo PRs (e.g. from a fork), pass
// `head` as `"owner:branch"`; for same-repo PRs, pass just the branch.
function createPR(headers, { repo, title, body, head, base, draft }) {
  assert.ok(title && head && base, 'createPR requires title, head, and base')
  const { owner, name } = parseRepo(repo)
  const payload = { title, head, base }
  if (body) payload.body = body
  if (draft) payload.draft = true
  return request(headers, 'POST', `/repos/${owner}/${name}/pulls`, { body: payload })
}

export function createClient({ token, userAgent = '@preventive/upstream' }) {
  assert.ok(token, 'Missing GitHub token')
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': userAgent,
  }
  return {
    forkRepo: (opts) => forkRepo(headers, opts),
    createBranch: (opts) => createBranch(headers, opts),
    createCommit: (opts) => createCommit(headers, opts),
    createPR: (opts) => createPR(headers, opts),
    getCurrentUser: () => getCurrentUser(headers),
    getRepoHead: (opts) => getRepoHead(headers, opts),
    getRepoFile: (opts) => getRepoFile(headers, opts),
    getRepoTarball: (opts) => getRepoTarball(headers, opts),
  }
}

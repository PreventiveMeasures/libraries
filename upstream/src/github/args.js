import assert from 'node:assert/strict'

// Hard checks on what the client is handed, run before any request is
// built. Every value that reaches a URL, a header or a request body has
// to be of the type and the shape GitHub gives it, so a typo'd option, a
// stray `..` or an object where a string belongs throws here, naming the
// method, rather than turning into a request for something else.

const hasControl = (value) => [...value].some((char) => char < ' ' || char === '\u007F')

// An options object, holding nothing but the keys the method reads: an
// option spelled wrong would otherwise be dropped without a word.
export function assertOptions(method, options, keys) {
  assert.ok(options !== null && typeof options === 'object' && !Array.isArray(options), `${method}: expected an options object`)
  for (const key of Object.keys(options)) assert.ok(keys.includes(key), `${method}: unknown option ${key}`)
}

export function assertNoArgs(method, args) {
  assert.equal(args.length, 0, `${method}: unexpected arguments`)
}

// A GitHub login — a user's, or an organization's, which follow the same
// rule: up to 39 letters, digits and single hyphens, neither leading nor
// trailing.
const isLogin = (value) => typeof value === 'string' && value.length <= 39 && /^[a-z\d](?:-?[a-z\d])*$/iu.test(value)

export function assertLogin(method, what, value) {
  assert.ok(isLogin(value), `${method}: ${what} is not a GitHub login: ${value}`)
}

// A repository name: up to 100 letters, digits, `.`, `_` and `-`, and not
// `.` or `..`, which URL parsing would resolve as a dot segment, sending
// the request elsewhere.
const isRepoName = (value) => typeof value === 'string' && value.length <= 100 && /^[\w.-]+$/u.test(value) && value !== '.' && value !== '..'

export function assertRepoName(method, what, value) {
  assert.ok(isRepoName(value), `${method}: ${what} is not a repository name: ${value}`)
}

// `owner/name`, which is how every call names a repo.
export function parseRepo(method, repo) {
  const [owner, name, ...rest] = typeof repo === 'string' ? repo.split('/') : []
  assert.ok(isLogin(owner) && isRepoName(name) && rest.length === 0, `${method}: expected "owner/name", got: ${repo}`)
  return { owner, name }
}

export function assertNumber(method, what, value) {
  assert.ok(Number.isSafeInteger(value) && value > 0, `${method}: ${what} is not a positive integer: ${value}`)
}

// A branch or tag name as `git check-ref-format --branch` takes one: no
// control characters, space or any of `~^:?*[\`, no `..` or `@{`, no
// empty or dot-led component and none ending `.lock`, not `@`, not led by
// `-`, not ending in `.`. The empty-component rule is also what keeps a
// leading, trailing or doubled `/` out. A full commit sha passes too.
const isRefName = (value) => typeof value === 'string' && value !== '' && value.length <= 255 && !hasControl(value)
  && !/[ ~^:?*[\\]/u.test(value) && !value.includes('..') && !value.includes('@{')
  && value !== '@' && !value.startsWith('-') && !value.endsWith('.')
  && value.split('/').every((part) => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'))

export function assertRef(method, what, value) {
  assert.ok(isRefName(value), `${method}: ${what} is not a branch or tag name: ${value}`)
}

// A full commit sha as git writes it: 40 lowercase hex digits, or 64 in a
// SHA-256 repository. Never abbreviated, which GitHub may read as
// ambiguous, and never a branch or tag, which can move.
export function isSha(value) {
  return typeof value === 'string' && /^(?:[\da-f]{40}|[\da-f]{64})$/u.test(value)
}

export function assertSha(method, what, value) {
  assert.ok(isSha(value), `${method}: ${what} is not a full commit sha: ${value}`)
}

// A path inside a repo: `/`-separated, no empty, `.` or `..` component,
// and no control characters.
export function assertPath(method, what, value) {
  const ok = typeof value === 'string' && value !== '' && value.length <= 4096 && !hasControl(value)
    && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  assert.ok(ok, `${method}: ${what} is not a path inside a repository: ${value}`)
}

export function assertText(method, what, value) {
  assert.ok(typeof value === 'string' && value.trim() !== '', `${method}: ${what} must be a non-empty string`)
}

export function assertOptional(assertion, method, what, value) {
  if (value !== undefined) assertion(method, what, value)
}

export function assertString(method, what, value) {
  assert.equal(typeof value, 'string', `${method}: ${what} must be a string`)
}

export function assertBoolean(method, what, value) {
  assert.equal(typeof value, 'boolean', `${method}: ${what} must be a boolean`)
}

// A header value: printable ASCII, and for a token no space either.
export function assertToken(method, value, anonymous) {
  if (anonymous && value === null) return
  const or = anonymous ? ', or null for anonymous access' : ''
  assert.ok(typeof value === 'string' && /^[!-~]+$/u.test(value), `${method}: token must be a non-empty string${or}`)
}

export function assertUserAgent(method, value) {
  assert.ok(typeof value === 'string' && value.trim() !== '' && /^[ -~]+$/u.test(value), `${method}: userAgent must be a non-empty printable string`)
}

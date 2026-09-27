import assert from 'node:assert/strict'

import { valid } from './semver.js'

// Hard checks on what the package is handed, run before any request is
// built: every value that reaches a URL, a header, a request body or a
// cache path has to be of the type and the shape the service gives it,
// so a typo'd option, a stray `..` or an object where a string belongs
// throws here, naming the method, rather than turning into a request for
// something else. One message shape throughout:
//
//   getRepo: repo must be "owner/name", got "a/b/c"

// C0 and C1 controls, and DEL.
const isControl = (char) => char < ' ' || (char >= '\u007F' && char <= '\u009F')

// Characters that reorder the text around them, which in a log line can
// make it read as something it does not say.
const isBidi = (char) => (char >= '\u202A' && char <= '\u202E') || (char >= '\u2066' && char <= '\u2069')

// Text from elsewhere — a response body, a name a service answered with —
// as it can go into an error message: every control and bidi character
// escaped, so a message says what it says and a terminal only prints it.
export function printable(text) {
  return [...String(text)].map((char) => (isControl(char) || isBidi(char) ? `\\u${char.codePointAt(0).toString(16).padStart(4, '0')}` : char)).join('')
}

// What a value was, for a message: a string quoted and escaped; anything
// else by its type.
export function show(value) {
  if (typeof value === 'string') return printable(JSON.stringify(value))
  if (value === null || ['undefined', 'number', 'boolean'].includes(typeof value)) return String(value)
  return typeof value
}

// An assertion for one format: `must` is what the message says a value
// has to be.
export const assertion = (must, predicate) => (method, what, value) => {
  assert.ok(predicate(value), `${method}: ${what} must be ${must}, got ${show(value)}`)
}

export function assertOptional(check, method, what, value) {
  if (value !== undefined) check(method, what, value)
}

// An options object: a plain one, holding nothing but the keys the
// method reads. An option spelled wrong would otherwise be dropped
// without a word, and one inherited from a prototype read without being
// checked for.
const isPlainObject = (value) => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))

export function assertOptions(method, what, options, keys) {
  assert.ok(isPlainObject(options), `${method}: ${what} must be an options object, got ${show(options)}`)
  for (const key of Reflect.ownKeys(options)) assert.ok(keys.includes(key), `${method}: unknown option ${what === 'options' ? '' : `${what}.`}${printable(String(key))}`)
}

export function assertNoArgs(method, args) {
  assert.equal(args.length, 0, `${method}: unexpected arguments`)
}

// A string that is well-formed UTF-16 — no lone surrogate, which
// encodeURIComponent would throw on and JSON would carry as an escape
// nothing on the other end reads — up to `max` long, with no control
// characters but those `allowed`.
const isString = (value, max, allowed = '') => typeof value === 'string' && value.length <= max && value.isWellFormed()
  && ![...value].some((char) => isControl(char) && !allowed.includes(char))

// ── plain values ──

export const assertBoolean = assertion('a boolean', (value) => typeof value === 'boolean')

export const assertNumber = assertion('a positive integer', (value) => Number.isSafeInteger(value) && value > 0)

// A title, a commit headline: one line, not blank, and not a novel.
export const assertLine = assertion('a non-empty single line', (value) => isString(value, 1024) && value.trim() !== '')

// A description, a commit body: any text up to GitHub's own limit on a
// body, with no control characters besides tabs and line breaks.
export const assertText = assertion('text with no control characters', (value) => isString(value, 65_536, '\t\n\r'))

// ── GitHub ──

// A GitHub login — a user's, or an organization's, which follow the same
// rule: up to 39 letters, digits and single hyphens, neither leading nor
// trailing.
const isLogin = (value) => typeof value === 'string' && value.length <= 39 && /^[a-z\d](?:-?[a-z\d])*$/iu.test(value)

// A repository name: up to 100 letters, digits, `.`, `_` and `-`, and not
// `.` or `..`, which URL parsing would resolve as a dot segment, sending
// the request elsewhere.
const isRepoName = (value) => typeof value === 'string' && value.length <= 100 && /^[\w.-]+$/u.test(value) && value !== '.' && value !== '..'

// `owner/name`, which is how every call names a repo.
export function isRepo(value) {
  const [owner, name, ...rest] = typeof value === 'string' ? value.split('/') : []
  return isLogin(owner) && isRepoName(name) && rest.length === 0
}

export const assertLogin = assertion('a GitHub login', isLogin)

export const assertRepoName = assertion('a repository name', isRepoName)

export const assertRepo = assertion('"owner/name"', isRepo)

// A branch or tag name as `git check-ref-format --branch` takes one: no
// control characters, space or any of `~^:?*[\`, no `..` or `@{`, no
// empty or dot-led component and none ending `.lock`, not `@`, not led by
// `-`, not ending in `.`. The empty-component rule is also what keeps a
// leading, trailing or doubled `/` out. A full commit sha passes too.
export const isRefName = (value) => isString(value, 255) && value !== ''
  && !/[ ~^:?*[\\]/u.test(value) && !value.includes('..') && !value.includes('@{')
  && value !== '@' && !value.startsWith('-') && !value.endsWith('.')
  && value.split('/').every((part) => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'))

export const assertRef = assertion('a branch or tag name', isRefName)

// A full commit sha as git writes it: 40 lowercase hex digits, or 64 in a
// SHA-256 repository. Never abbreviated, which GitHub may read as
// ambiguous, and never a branch or tag, which can move.
export const isSha = (value) => typeof value === 'string' && /^(?:[\da-f]{40}|[\da-f]{64})$/u.test(value)

export const assertSha = assertion('a full commit sha', isSha)

// A path inside a repo: `/`-separated, no empty, `.` or `..` component,
// no control characters, and nothing inside a `.git` — which is not in a
// repository's tree, and not a place a commit should reach.
const isRepoPath = (value) => isString(value, 4096) && value !== ''
  && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')

export const assertPath = assertion('a path inside a repository', isRepoPath)

// A header value: printable ASCII, and for a token no space either.
const isToken = (value) => typeof value === 'string' && /^[!-~]+$/u.test(value)

export const assertToken = assertion('a token', isToken)

export const assertTokenOrNull = assertion('a token, or null for anonymous access', (value) => value === null || isToken(value))

export const assertUserAgent = assertion('a printable user agent', (value) => typeof value === 'string' && value.trim() !== '' && /^[ -~]+$/u.test(value))

// ── npm ──

// A package name as npm takes one for a package it holds: up to 214
// characters; a scope of letters, digits, `.`, `_` and `-` (`@foo.bar`
// is one); a name of the same that does not start with a dot. Capitals
// are in, since existing packages have them (JSONStream). The special
// characters npm tolerates from long ago (`~'!()*`) are out.
export const isPackageName = (value) => typeof value === 'string' && value.length <= 214 && /^(?:@[\w.-]+\/)?[\w-][\w.-]*$/u.test(value)

export const assertPackageName = assertion('an npm package name', isPackageName)

// A version as the registry files it: a string that npm's semver.valid
// answers with unchanged. `v1.2.3` or `1.2.3+build` pass semver.valid but
// are not the version the registry files, and a space or a `/` in one
// would change the path it is requested at.
export const assertPackageVersion = assertion('an exact semver version', (value) => typeof value === 'string' && valid(value) === value)

// ── the filesystem ──

export const assertDirectoryPath = assertion('a directory path', (value) => isString(value, 4096) && value !== '')

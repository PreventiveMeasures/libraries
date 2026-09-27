import assert from 'node:assert/strict'

import { valid } from './semver.js'

const isControl = (char) => char < ' ' || (char >= '\u007F' && char <= '\u009F')

// Bidi controls can make a log line read as something it doesn't say.
const isBidi = (char) => (char >= '\u202A' && char <= '\u202E') || (char >= '\u2066' && char <= '\u2069')

// For remote text going into error messages.
export function printable(text) {
  return [...String(text)].map((char) => (isControl(char) || isBidi(char) ? `\\u${char.codePointAt(0).toString(16).padStart(4, '0')}` : char)).join('')
}

export function show(value) {
  if (typeof value === 'string') return printable(JSON.stringify(value))
  if (value === null || ['undefined', 'number', 'boolean'].includes(typeof value)) return String(value)
  return typeof value
}

export const assertion = (must, predicate) => (method, what, value) => {
  assert.ok(predicate(value), `${method}: ${what} must be ${must}, got ${show(value)}`)
}

export function assertOptional(check, method, what, value) {
  if (value !== undefined) check(method, what, value)
}

// A prototype's properties would be read as options without being checked.
const isPlainObject = (value) => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))

export function assertOptions(method, what, options, keys) {
  assert.ok(isPlainObject(options), `${method}: ${what} must be an options object, got ${show(options)}`)
  for (const key of Reflect.ownKeys(options)) assert.ok(keys.includes(key), `${method}: unknown option ${what === 'options' ? '' : `${what}.`}${printable(String(key))}`)
}

export function assertNoArgs(method, args) {
  assert.equal(args.length, 0, `${method}: unexpected arguments`)
}

// Lone surrogates make encodeURIComponent throw.
const isString = (value, max, allowed = '') => typeof value === 'string' && value.length <= max && value.isWellFormed()
  && ![...value].some((char) => isControl(char) && !allowed.includes(char))

export const assertBoolean = assertion('a boolean', (value) => typeof value === 'boolean')

export const assertNumber = assertion('a positive integer', (value) => Number.isSafeInteger(value) && value > 0)

export const assertLine = assertion('a non-empty single line', (value) => isString(value, 1024) && value.trim() !== '')

// 65,536 is GitHub's own limit on a body.
export const assertText = assertion('text with no control characters', (value) => isString(value, 65_536, '\t\n\r'))

const isLogin = (value) => typeof value === 'string' && value.length <= 39 && /^[a-z\d](?:-?[a-z\d])*$/iu.test(value)

// `.` and `..` would be dot segments in a URL path.
const isRepoName = (value) => typeof value === 'string' && value.length <= 100 && /^[\w.-]+$/u.test(value) && value !== '.' && value !== '..'

export function isRepo(value) {
  const [owner, name, ...rest] = typeof value === 'string' ? value.split('/') : []
  return isLogin(owner) && isRepoName(name) && rest.length === 0
}

export const assertLogin = assertion('a GitHub login', isLogin)

export const assertRepoName = assertion('a repository name', isRepoName)

export const assertRepo = assertion('"owner/name"', isRepo)

// `git check-ref-format --branch`; a full sha passes too.
export const isRefName = (value) => isString(value, 255) && value !== ''
  && !/[ ~^:?*[\\]/u.test(value) && !value.includes('..') && !value.includes('@{')
  && value !== '@' && !value.startsWith('-') && !value.endsWith('.')
  && value.split('/').every((part) => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'))

export const assertRef = assertion('a branch or tag name', isRefName)

// Full shas only: an abbreviation can be ambiguous, and a ref can move.
export const isSha = (value) => typeof value === 'string' && /^(?:[\da-f]{40}|[\da-f]{64})$/u.test(value)

export const assertSha = assertion('a full commit sha', isSha)

// `.git` is never in a repo's tree, and no commit should write into it.
const isRepoPath = (value) => isString(value, 4096) && value !== ''
  && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')

export const assertPath = assertion('a path inside a repository', isRepoPath)

const isToken = (value) => typeof value === 'string' && /^[!-~]+$/u.test(value)

export const assertToken = assertion('a token', isToken)

export const assertTokenOrNull = assertion('a token, or null for anonymous access', (value) => value === null || isToken(value))

export const assertUserAgent = assertion('a printable user agent', (value) => typeof value === 'string' && value.trim() !== '' && /^[ -~]+$/u.test(value))

// npm's rules for existing names: capitals allowed (JSONStream), the
// legacy `~'!()*` not.
export const isPackageName = (value) => typeof value === 'string' && value.length <= 214 && /^(?:@[\w.-]+\/)?[\w-][\w.-]*$/u.test(value)

export const assertPackageName = assertion('an npm package name', isPackageName)

// Exactly as semver.valid spells it: `v1.2.3` and `1.2.3+build` pass
// valid() but are not what the registry files.
export const assertPackageVersion = assertion('an exact semver version', (value) => typeof value === 'string' && valid(value) === value)

export const assertDirectoryPath = assertion('a directory path', (value) => isString(value, 4096) && value !== '')

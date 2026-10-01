import assert from 'node:assert/strict'

import { isExactVersion } from './semver.js'

const isControl = (char) => char < ' ' || (char >= '\u007F' && char <= '\u009F')
export const matches = (regex) => (value) => typeof value === 'string' && regex.test(value)
// Bidi controls can make a log line read as something it doesn't say.
const isBidi = (char) => (char >= '\u202A' && char <= '\u202E') || (char >= '\u2066' && char <= '\u2069')
// A prototype's properties would be read as options without being checked.
const isPlainObject = (value) => value != null && [Object.prototype, null].includes(Object.getPrototypeOf(value))
// Lone surrogates make encodeURIComponent throw.
const isString = (value, max, allowed = '') => typeof value === 'string' && value.length <= max && value.isWellFormed()
  && ![...value].some((char) => isControl(char) && !allowed.includes(char))
const isLogin = matches(/^(?=.{1,39}$)[a-z\d](?:-?[a-z\d])*$/iu)
const isRepoName = matches(/^(?!\.\.?$)[\w.-]{1,100}$/u)
// `.git` is never in a repo's tree, and no commit should write into it.
export const isRepoPath = (value) => isString(value, 4096) && value.split('/').every((part) => !['', '.', '..', '.git'].includes(part.toLowerCase()))
const BAD_REF = /^$|^@$|^-|[ ~^:?*[\\]|\.\.|@\{|^\/|\/$|\/\/|(?:^|\/)\.|\.lock(?:\/|$)|\.$/u // git check-ref-format, a rule per alternative
const isToken = matches(/^[!-~]+$/u)
// npm's rules for existing names: capitals allowed (JSONStream), the
// legacy `~'!()*` not.
// npm's rule: an unscoped name starts with neither `.`, `_` nor `-`.
const isPackageName = matches(/^(?=.{1,214}$)(?:@[\w.-]+\/[\w-]|[\dA-Za-z])[\w.-]*$/u)

export function printable(text) {
  return [...String(text)].map((char) => (isControl(char) || isBidi(char) ? `\\u${char.codePointAt(0).toString(16).padStart(4, '0')}` : char)).join('')
}

export function show(value) {
  if (typeof value === 'string') return printable(JSON.stringify(value))
  return value && (typeof value === 'object' || typeof value === 'function') ? typeof value : String(value)
}

export function isRepo(value) {
  const [owner, name, ...rest] = typeof value === 'string' ? value.split('/') : []
  return isLogin(owner) && isRepoName(name) && rest.length === 0
}

export const isStrings = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string')
export const sameName = (a, b) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase()
export const isRefName = (value) => isString(value, 255) && !BAD_REF.test(value)
export const isSha = matches(/^(?:[\da-f]{40}|[\da-f]{64})$/u)
export const isGhsa = matches(/^GHSA(?:-[\da-hj-km-np-tv-z]{4}){3}$/u)
export const assertion = (must, predicate) => (method, what, value) => assert.ok(predicate(value), `${method}: ${what} must be ${must}, got ${show(value)}`)
export const optional = (check) => (method, what, value) => value === undefined || check(method, what, value)

// A `null` in `spec` allows the key and leaves its check to the caller.
export function assertArgs(method, options, spec, name) {
  const label = (key) => printable(name ? `${name}.${String(key)}` : String(key))
  assert.ok(isPlainObject(options), `${method}: ${name ?? 'options'} must be an options object, got ${show(options)}`)
  for (const key of Reflect.ownKeys(options)) assert.ok(Object.hasOwn(spec, key), `${method}: unknown option ${label(key)}`)
  for (const [key, check] of Object.entries(spec)) check?.(method, label(key), options[key])
}

export const assertBoolean = assertion('a boolean', (value) => typeof value === 'boolean')
export const assertNumber = assertion('a positive integer', (value) => Number.isSafeInteger(value) && value > 0)
export const assertLine = assertion('a non-empty single line', (value) => isString(value, 1024) && value.trim() !== '')
// 65,536 is GitHub's own limit on a body.
export const assertText = assertion('text with no control characters', (value) => isString(value, 65_536, '\t\n\r'))
export const assertDirectoryPath = assertion('a directory path', (value) => isString(value, 4096) && value !== '')
export const assertLogin = assertion('a GitHub login', isLogin)
export const assertRepoName = assertion('a repository name', isRepoName)
export const assertRepo = assertion('"owner/name"', isRepo)
export const assertRef = assertion('a branch or tag name', isRefName)
export const assertSha = assertion('a full commit sha', isSha)
export const isTreeId = matches(/^[\da-f]{40}$/u)
export const assertTreeId = assertion('a full tree id', isTreeId)
export const assertPath = assertion('a path inside a repository', isRepoPath)
export const assertToken = assertion('a token', isToken)
export const assertTokenOrNull = assertion('a token, or null for anonymous access', (value) => value === null || isToken(value))
export const assertUserAgent = assertion('a printable user agent', matches(/^[ -~]*[!-~][ -~]*$/u))
export const assertPackageName = assertion('an npm package name', isPackageName)
export const assertPackageVersion = assertion('an exact semver version', isExactVersion)
export const assertGhsa = assertion('a GHSA id', isGhsa)
export const assertCrateName = assertion('a crate name', matches(/^[A-Za-z][\w-]{0,63}$/u))
export const assertCrateVersion = assertion('a semver version', matches(/^(?=.{5,256}$)(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*))*)?(?:\+[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?$/u))
// As Cargo.lock and soldeer.lock write a checksum.
export const assertSha256 = assertion('a sha256 in lowercase hex', matches(/^[\da-f]{64}$/u))

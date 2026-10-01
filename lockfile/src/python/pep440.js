// PEP 440: a version in any spelling packaging reads, the normal form
// packaging and uv write it in, which versions are equal, and the
// specifiers of a requirement or a requires-python. No whitespace around a
// version is taken, which packaging would strip.

import { LockfileError, quote } from '../error.js'

const NUMBER = '[0-9]+'
const PRE = `[-_.]?(alpha|a|beta|b|preview|pre|c|rc)[-_.]?(${NUMBER})?`
const POST = `-(${NUMBER})|[-_.]?(post|rev|r)[-_.]?(${NUMBER})?`
const DEV = `[-_.]?dev[-_.]?(${NUMBER})?`
const LOCAL = '[a-z0-9]+(?:[-_.][a-z0-9]+)*'
const VERSION = new RegExp(`^v?(?:(${NUMBER})!)?(${NUMBER}(?:\\.${NUMBER})*)(?:${PRE})?(?:${POST})?(?:(${DEV}))?(?:\\+(${LOCAL}))?$`, 'iu')

const PRE_KINDS = { __proto__: null, alpha: 'a', a: 'a', beta: 'b', b: 'b', preview: 'rc', pre: 'rc', c: 'rc', rc: 'rc' }

// A number in a version, without the leading zeros it may be written with.
const int = (digits) => digits.replace(/^0+(?=\d)/u, '')

// The parts of a version, or undefined for what packaging does not read.
export function parseVersion(text) {
  const m = VERSION.exec(text)
  if (m === null) return undefined
  const [, epoch, release, preKind, preNumber, postImplicit, postKind, postNumber, dev, devNumber, local] = m
  return {
    epoch: int(epoch ?? '0'),
    release: release.split('.').map(int),
    pre: preKind === undefined ? undefined : `${PRE_KINDS[preKind.toLowerCase()]}${int(preNumber ?? '0')}`,
    post: postImplicit === undefined && postKind === undefined ? undefined : int(postImplicit ?? postNumber ?? '0'),
    dev: dev === undefined ? undefined : int(devNumber ?? '0'),
    local: local?.toLowerCase().split(/[-_.]/u).map((part) => (/^\d+$/u.test(part) ? int(part) : part)),
  }
}

function format({ epoch, release, pre, post, dev, local }, withEpoch) {
  let text = withEpoch || epoch !== '0' ? `${epoch}!` : ''
  text += release.join('.')
  if (pre !== undefined) text += pre
  if (post !== undefined) text += `.post${post}`
  if (dev !== undefined) text += `.dev${dev}`
  if (local !== undefined) text += `+${local.join('.')}`
  return text
}

// The normal form, as str(packaging.version.Version) and uv write it.
export const normalVersion = (parsed) => format(parsed, false)

// Equal versions have one key: trailing zeros of the release do not count.
export function versionKey(parsed) {
  const release = [...parsed.release]
  while (release.length > 1 && release.at(-1) === '0') release.pop()
  return format({ ...parsed, release }, true)
}

export function checkVersion(value, where) {
  if (parseVersion(value) === undefined) throw new LockfileError(`${quote(value)} is not a version`, where)
  return value
}

// A version in the normal form, as uv writes every one.
export function checkNormalVersion(value, where) {
  const parsed = parseVersion(value)
  if (parsed === undefined) throw new LockfileError(`${quote(value)} is not a version`, where)
  if (normalVersion(parsed) !== value) throw new LockfileError(`${quote(value)} is not a version in normal form, ${quote(normalVersion(parsed))}`, where)
  return value
}

// What each operator takes after it, as packaging's Specifier reads it: a
// local version only after == and !=, a prefix with .* only there too, two
// release numbers at least after ~=, and anything but spaces after ===.
const PREFIX = /^v?(?:[0-9]+!)?[0-9]+(?:\.[0-9]+)*\.\*$/iu
const OPERATOR = /^(===|~=|==|!=|<=|>=|<|>)[ \t]*(.*)$/su

function isClause(clause) {
  const m = OPERATOR.exec(clause)
  if (m === null) return false
  const [, operator, version] = m
  if (operator === '===') return /^[^\s;)]+$/u.test(version)
  if ((operator === '==' || operator === '!=') && PREFIX.test(version)) return true
  const parsed = parseVersion(version)
  if (parsed === undefined) return false
  if (operator === '~=' && parsed.release.length < 2) return false
  return parsed.local === undefined || operator === '==' || operator === '!='
}

// A list of specifiers a comma apart, spaces and tabs around each: what a
// requires-python and a requirement's version take. Not empty.
export function checkSpecifiers(value, where) {
  const clauses = value.split(',').map((clause) => clause.replace(/^[ \t]+|[ \t]+$/gu, ''))
  if (!clauses.every(isClause)) throw new LockfileError(`${quote(value)} is not a list of version specifiers`, where)
  return value
}

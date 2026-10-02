// PEP 440: a version in any spelling packaging reads, the normal form
// packaging and uv write it in, which versions are equal, and the
// specifiers of a requirement or a requires-python. No whitespace around a
// version is taken, which packaging would strip. A check takes a value of
// a TOML lockfile, and refuses anything but a string as its readers do.

import { LockfileError, quote } from '../error.js'
import { checker } from '../toml/shape.js'

const NUMBER = '[0-9]+'
const PRE = `[-_.]?(alpha|a|beta|b|preview|pre|c|rc)[-_.]?(${NUMBER})?`
const POST = `-(${NUMBER})|[-_.]?(post|rev|r)[-_.]?(${NUMBER})?`
const DEV = `[-_.]?dev[-_.]?(${NUMBER})?`
const LOCAL = '[a-z0-9]+(?:[-_.][a-z0-9]+)*'
const VERSION = new RegExp(`^v?(?:(${NUMBER})!)?(${NUMBER}(?:\\.${NUMBER})*)(?:${PRE})?(?:${POST})?(?:(${DEV}))?(?:\\+(${LOCAL}))?$`, 'iu')

const PRE_KINDS = { __proto__: null, alpha: 'a', a: 'a', beta: 'b', b: 'b', preview: 'rc', pre: 'rc', c: 'rc', rc: 'rc' }

// A number in a version, without the leading zeros it may be written with.
const int = (digits) => digits.replace(/^0+(?=\d)/u, '')

// The parts of a version, or undefined for what packaging does not read,
// and for any that is not ASCII, which uv does not read: VERSION's
// case-insensitive letters would take `ſ` for `s` and the Kelvin sign for
// `k`.
export function parseVersion(text) {
  const m = /^[\0-\u007F]*$/u.test(text) ? VERSION.exec(text) : null
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

// The normal form, as str(packaging.version.Version) and uv write it.
export function normalVersion({ epoch, release, pre, post, dev, local }) {
  let text = epoch === '0' ? '' : `${epoch}!`
  text += release.join('.')
  if (pre !== undefined) text += pre
  if (post !== undefined) text += `.post${post}`
  if (dev !== undefined) text += `.dev${dev}`
  if (local !== undefined) text += `+${local.join('.')}`
  return text
}

// Equal versions have one key: trailing zeros of the release do not count.
export function versionKey(parsed) {
  let end = parsed.release.length
  while (end > 1 && parsed.release[end - 1] === '0') end--
  return normalVersion({ ...parsed, release: parsed.release.slice(0, end) })
}

// The key of a version known to be one.
export const versionKeyOf = (version) => versionKey(parseVersion(version))

export const checkVersion = checker((text) => parseVersion(text) !== undefined, 'a version')

// A version in the normal form, as uv writes every one.
export function checkNormalVersion(value, where) {
  const normal = normalVersion(parseVersion(checkVersion(value, where)))
  if (normal !== value) throw new LockfileError(`${quote(value)} is not a version in normal form, ${quote(normal)}`, where)
  return value
}

// Spaces and tabs off both ends, in time linear in the length, which
// /[ \t]+$/ is not: it starts over from each blank of a run.
export function trimBlanks(text) {
  let [start, end] = [0, text.length]
  while (start < end && (text[start] === ' ' || text[start] === '\t')) start++
  while (end > start && (text[end - 1] === ' ' || text[end - 1] === '\t')) end--
  return text.slice(start, end)
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
  return parsed !== undefined && (operator !== '~=' || parsed.release.length >= 2) && (parsed.local === undefined || operator === '==' || operator === '!=')
}

// A list of specifiers a comma apart, spaces and tabs around each: what a
// requires-python and a requirement's version take. Not empty.
export const isSpecifiers = (text) => text.split(',').every((clause) => isClause(trimBlanks(clause)))

export const checkSpecifiers = checker(isSpecifiers, 'a list of version specifiers')

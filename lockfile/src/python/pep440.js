// PEP 440 versions and specifiers as packaging reads them, no whitespace
// around a version. A check takes a TOML value, refusing anything but a string.

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

// Undefined for what packaging doesn't read, and anything not ASCII: the
// case-insensitive regex would take the long s for `s`, Kelvin for `k`.
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

// packaging's Version sort key: a dev-only release before pre-releases,
// which sort by their letters; a local version after the public one.
function orderKey({ epoch, release, pre, post, dev, local }) {
  let end = release.length
  while (end > 1 && release[end - 1] === '0') end--
  const [, kind, number] = /^(\D+)(\d+)$/u.exec(pre ?? '') ?? []
  return [
    [BigInt(epoch)],
    release.slice(0, end).map(BigInt),
    pre === undefined ? [post === undefined && dev !== undefined ? 0 : 2] : [1, kind, BigInt(number)],
    post === undefined ? [0] : [1, BigInt(post)],
    dev === undefined ? [1] : [0, BigInt(dev)],
    local === undefined ? [0] : [1, ...local.map((part) => (/^\d+$/u.test(part) ? [1, BigInt(part)] : [0, part]))],
  ]
}

function compareKeys(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const order = Array.isArray(a[i]) ? compareKeys(a[i], b[i]) : (a[i] < b[i] ? -1 : (a[i] > b[i] ? 1 : 0))
    if (order !== 0) return order
  }
  return Math.sign(a.length - b.length)
}

export const compareVersions = (a, b) => compareKeys(orderKey(parseVersion(a)), orderKey(parseVersion(b)))

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

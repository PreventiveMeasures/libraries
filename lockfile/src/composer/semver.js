// composer/semver 3, as Composer 2 reads versions and constraints with it:
// VersionParser's normalize, normalizeBranch, parseNumericAliasPrefix,
// parseStability and parseConstraints, and the constraints they make, with
// how one matches another. Ported regex for regex, each as PCRE reads it:
// `\s` is ASCII's whitespace and `.` anything but a line feed. A version or
// a constraint with a control character in it is refused before any of
// this, where PCRE's `$` would read a line end at the end otherwise.

import { LONG_MAX, compareVersions, empty, lower, trim, versionCompare } from './php.js'

const MODIFIER = '[._-]?(?:(stable|beta|b|RC|alpha|a|patch|pl|p)((?:[.-]?\\d+)*)?)?([.-]?dev)?'
const STABILITIES = 'stable|RC|beta|alpha|dev'
const S = '[\\t\\n\\v\\f\\r ]'
const NOT_S = '[^\\t\\n\\v\\f\\r ]'
const WORD = '[^,\\t\\n\\v\\f\\r ]'

export const DEFAULT_BRANCH_ALIAS = '9999999-dev'

// Caseless as PCRE is without /u, of ASCII alone: JavaScript's `iu` takes
// ſ for s and the Kelvin sign for k, as `i` alone does not. The ones
// written out below have no s, k or class of letters, which alone ſ and
// the Kelvin sign fold into.
const regex = (source, flags = '') => new RegExp(source, flags || 'u')

const AS = regex(`^(${WORD}+) +as +(${WORD}+)$`)
const FLAG = regex(`@(?:${STABILITIES})$`, 'i')
const BUILD = regex(`^([^,\\t\\n\\v\\f\\r +]+)\\+${NOT_S}+$`)
const CLASSICAL = regex(`^v?(\\d{1,5})(\\.\\d+)?(\\.\\d+)?(\\.\\d+)?${MODIFIER}$`, 'i')
const DATE = regex(`^v?(\\d{4}(?:[.:-]?\\d{2}){1,6}(?:[.:-]?\\d{1,3}){0,2})${MODIFIER}$`, 'i')
const DEV = /^([^\n]*?)[.-]?dev$/iu
const BRANCH = /^v?(\d+)(\.(?:\d+|[xX*]))?(\.(?:\d+|[xX*]))?(\.(?:\d+|[xX*]))?$/iu
const NUMERIC_PREFIX = /^((?:\d+\.)*\d+)(?:\.x)?-dev$/iu
const STABILITY = regex(`${MODIFIER}(?:\\+[^\\n]*)?$`, 'i')

function expandStability(stability) {
  const lowered = lower(stability)
  return { a: 'alpha', b: 'beta', p: 'patch', pl: 'patch', rc: 'RC' }[lowered] ?? lowered
}

export function parseStability(input) {
  const version = input.replace(/#[^\n]+$/u, '')
  if (version.startsWith('dev-') || version.endsWith('-dev')) return 'dev'
  const match = STABILITY.exec(lower(version))
  if (!empty(match[3])) return 'dev'
  if (match[1] === 'beta' || match[1] === 'b') return 'beta'
  if (match[1] === 'alpha' || match[1] === 'a') return 'alpha'
  if (match[1] === 'rc') return 'RC'
  return 'stable'
}

export function normalizeBranch(input) {
  const name = trim(input)
  const match = BRANCH.exec(name)
  if (match === null) return `dev-${name}`
  let version = ''
  for (let i = 1; i < 5; i++) version += match[i] === undefined ? '.x' : match[i].replaceAll('*', 'x').replaceAll('X', 'x')
  return `${version.replaceAll('x', '9999999')}-dev`
}

// A `2.1.` of `2.1.x-dev` or `2.1-dev`; undefined of anything else.
export function parseNumericAliasPrefix(branch) {
  const match = NUMERIC_PREFIX.exec(branch)
  return match === null ? undefined : `${match[1]}.`
}

// The normal form, or undefined where Composer throws.
export function normalize(input) {
  let version = trim(input)
  let match = AS.exec(version)
  if (match !== null) version = match[1]
  match = FLAG.exec(version)
  if (match !== null) version = version.slice(0, version.length - match[0].length)
  if (version === 'master' || version === 'trunk' || version === 'default') version = `dev-${version}`
  if (/^dev-/iu.test(version)) return `dev-${version.slice(4)}`
  match = BUILD.exec(version)
  if (match !== null) version = match[1]
  let index
  if ((match = CLASSICAL.exec(version)) !== null) {
    version = `${match[1]}${empty(match[2]) ? '.0' : match[2]}${empty(match[3]) ? '.0' : match[3]}${empty(match[4]) ? '.0' : match[4]}`
    index = 5
  } else if ((match = DATE.exec(version)) !== null) {
    version = match[1].replaceAll(/\D/gu, '.')
    index = 2
  }
  if (index !== undefined) {
    if (!empty(match[index])) {
      if (match[index] === 'stable') return version
      const number = match[index + 1]
      version += `-${expandStability(match[index])}${(number ?? '').replace(/^[.-]+/u, '')}`
    }
    if (!empty(match[index + 2])) version += '-dev'
    return version
  }
  match = DEV.exec(version)
  if (match !== null) {
    const normalized = normalizeBranch(match[1])
    if (!normalized.includes('dev-')) return normalized
  }
  return undefined
}

// The constraints: `[op, version]` for one, `{ all }` for anything, and
// `{ multi, conjunctive }` for several.
const OPS = { '=': '==', '==': '==', '<': '<', '<=': '<=', '>': '>', '>=': '>=', '<>': '!=', '!=': '!=' }

const constraint = (operator, version) => ({ operator: OPS[operator], version })
const ALL = Object.freeze({ all: true })

export const constraintString = (c) => {
  if (c.all) return '*'
  if (c.multi !== undefined) return `[${c.multi.map(constraintString).join(c.conjunctive ? ' ' : ' || ')}]`
  return `${c.operator} ${c.version}`
}

// One more at `position`, the parts after it 0; a part PHP reads past an
// integer is refused here, as Composer would write it as a float.
function manipulate(groups, position, increment = 0) {
  const parts = [...groups]
  for (let i = 4; i > 0; i--) {
    if (i > position) parts[i] = '0'
    else if (i === position && increment !== 0) {
      const next = BigInt(parts[i]) + BigInt(increment)
      if (next > LONG_MAX) return undefined
      parts[i] = String(next)
    }
  }
  return `${parts[1] ?? ''}.${parts[2] ?? ''}.${parts[3] ?? ''}.${parts[4] ?? ''}`
}

const VERSION = `v?(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:\\.(\\d+))?(?:${MODIFIER}|\\.([xX*][.-]?dev))(?:\\+${NOT_S}+)?`
const CONSTRAINT_FLAG = regex(`^(${WORD}*?)@(${STABILITIES})$`, 'i')
const REF = /^(dev-[^,\t\n\v\f\r @]+?|[^,\t\n\v\f\r @]+?\.x-dev)#[^\n]+$/iu
const WILDCARD = /^(v)?[xX*](\.[xX*])*$/iu
const TILDE = regex(`^~>?${VERSION}$`, 'i')
const CARET = regex(`^\\^${VERSION}($)`, 'i')
const X_RANGE = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.[xX*])+$/u
const HYPHEN = regex(`^(${VERSION}) +- +(${VERSION})($)`, 'i')
const BASIC = regex(`^(<>|!=|>=?|<=?|==?)?${S}*([^\\n]*)`)
const MODIFIED = regex(`-${MODIFIER}$`)
const set = (value) => value !== undefined && value !== ''

// `~` and `^`: from the version as written to below the next at `position`.
function bounded(text, match, position) {
  const suffix = empty(match[5]) && empty(match[7]) && empty(match[8]) ? '-dev' : ''
  const low = normalize(`${text}${suffix}`.slice(1))
  const high = manipulate(match, position, 1)
  return low === undefined || high === undefined ? undefined : [constraint('>=', low), constraint('<', `${high}-dev`)]
}

function parseOne(input) {
  let text = input
  let match = AS.exec(text)
  if (match !== null) text = match[1]
  let stabilityModifier
  match = CONSTRAINT_FLAG.exec(text)
  if (match !== null) {
    text = match[1] === '' ? '*' : match[1]
    if (match[2] !== 'stable') stabilityModifier = match[2]
  }
  match = REF.exec(text)
  if (match !== null) text = match[1]
  match = WILDCARD.exec(text)
  if (match !== null) return !empty(match[1]) || !empty(match[2]) ? [constraint('>=', '0.0.0.0-dev')] : [ALL]

  if ((match = TILDE.exec(text)) !== null) {
    if (text.startsWith('~>')) return undefined
    let position = set(match[4]) ? 4 : set(match[3]) ? 3 : set(match[2]) ? 2 : 1
    if (!empty(match[8])) position++
    return bounded(text, match, Math.max(1, position - 1))
  }

  if ((match = CARET.exec(text)) !== null) {
    return bounded(text, match, match[1] !== '0' || !set(match[2]) ? 1 : match[2] !== '0' || !set(match[3]) ? 2 : 3)
  }

  if ((match = X_RANGE.exec(text)) !== null) {
    const position = set(match[3]) ? 3 : set(match[2]) ? 2 : 1
    const low = `${manipulate(match, position)}-dev`
    const high = manipulate(match, position, 1)
    if (high === undefined) return undefined
    if (low === '0.0.0.0-dev') return [constraint('<', `${high}-dev`)]
    return [constraint('>=', low), constraint('<', `${high}-dev`)]
  }

  if ((match = HYPHEN.exec(text)) !== null) {
    const lowSuffix = empty(match[6]) && empty(match[8]) && empty(match[9]) ? '-dev' : ''
    const from = normalize(match[1])
    const to = normalize(match[10])
    if (from === undefined || to === undefined) return undefined
    const bottom = constraint('>=', `${from}${lowSuffix}`)
    if ((set(match[12]) && set(match[13])) || !empty(match[15]) || !empty(match[17]) || !empty(match[18])) return [bottom, constraint('<=', to)]
    const high = manipulate(['', match[11], match[12], match[13], match[14]], set(match[12]) ? 2 : 1, 1)
    if (high === undefined) return undefined
    return [bottom, constraint('<', `${high}-dev`)]
  }

  match = BASIC.exec(text)
  let version = normalize(match[2])
  if (version === undefined && match[2].endsWith('-dev') && /^[0-9a-zA-Z\-./]+$/u.test(match[2])) version = normalize(`dev-${match[2].slice(0, -4)}`)
  if (version === undefined) return undefined
  const operator = match[1] || '='
  if (operator !== '==' && operator !== '=' && !empty(stabilityModifier) && parseStability(version) === 'stable') {
    version += `-${stabilityModifier}`
  } else if ((operator === '<' || operator === '>=') && !MODIFIED.test(lower(match[2])) && !match[2].startsWith('dev-')) {
    version += '-dev'
  }
  return [constraint(operator, version)]
}

const OR = regex(`${S}*\\|\\|?${S}*`)
const AND = /(?<!^|as|[=>< ,]) *(?<!-)[, ](?!-) *(?!,|as|$)/u

// Contiguous ranges of a disjunction as one: [>= 1 < 2] || [>= 2 < 3] as
// [>= 1 < 3].
function optimize(constraints) {
  let left = constraints[0]
  const merged = []
  let optimized = false
  const isRange = (c) => c.multi !== undefined && c.conjunctive && c.multi.length === 2
  for (const right of constraints.slice(1)) {
    const [left0, left1, right0, right1] = isRange(left) && isRange(right) ? [...left.multi, ...right.multi].map(constraintString) : []
    if (left0?.startsWith('>=') && left1.startsWith('<') && right0.startsWith('>=') && right1.startsWith('<') && left1.slice(2) === right0.slice(3)) {
      optimized = true
      left = { multi: [left.multi[0], right.multi[1]], conjunctive: true }
    } else {
      merged.push(left)
      left = right
    }
  }
  if (!optimized) return undefined
  merged.push(left)
  return merged
}

function create(constraints) {
  if (constraints.length === 1) return constraints[0]
  const optimized = optimize(constraints)
  if (optimized?.length === 1) return optimized[0]
  return { multi: optimized ?? constraints, conjunctive: false }
}

// What Composer makes of a constraint, or undefined where it throws.
export function parseConstraints(text) {
  const groups = []
  for (const or of trim(text).split(OR)) {
    const parts = or.split(AND)
    const constraints = []
    for (const part of parts) {
      const parsed = parseOne(part)
      if (parsed === undefined) return undefined
      constraints.push(...parsed)
    }
    groups.push(constraints.length === 1 ? constraints[0] : { multi: constraints, conjunctive: true })
  }
  return create(groups)
}

// Constraint::versionCompare: a branch, `dev-…`, is equal to itself alone,
// and comparable to no other version.
function compareBranches(a, b, operator) {
  const aBranch = a.startsWith('dev-')
  const bBranch = b.startsWith('dev-')
  if (operator === '!=' && (aBranch || bBranch)) return a !== b
  if (aBranch && bBranch) return operator === '==' && a === b
  if (aBranch || bBranch) return false
  return versionCompare(a, b, operator)
}

const noEqual = (operator) => operator.replaceAll('=', '')

// Constraint::matchSpecific: whether two intervals meet.
function matchSpecific(self, provider) {
  const isEqual = self.operator === '=='
  const isNotEqual = self.operator === '!='
  const providerEqual = provider.operator === '=='
  const providerNotEqual = provider.operator === '!='
  if (isNotEqual || providerNotEqual) {
    if (isNotEqual && !providerNotEqual && !providerEqual && provider.version.startsWith('dev-')) return false
    if (providerNotEqual && !isNotEqual && !isEqual && self.version.startsWith('dev-')) return false
    if (!isEqual && !providerEqual) return true
    return compareBranches(provider.version, self.version, '!=')
  }
  if (self.operator !== '==' && noEqual(self.operator) === noEqual(provider.operator)) {
    return !(self.version.startsWith('dev-') || provider.version.startsWith('dev-'))
  }
  const [version1, version2, operator] = isEqual ? [self.version, provider.version, provider.operator] : [provider.version, self.version, self.operator]
  if (compareBranches(version1, version2, operator)) {
    return !(provider.operator === noEqual(provider.operator) && self.operator !== noEqual(self.operator) && compareVersions(provider.version, self.version) === 0)
  }
  return false
}

// ConstraintInterface::matches, each kind as composer/semver turns it.
export function matches(self, provider) {
  if (self.all || provider.all) return true
  if (self.multi !== undefined) {
    if (!self.conjunctive) return self.multi.some((c) => matches(provider, c))
    if (provider.multi !== undefined && !provider.conjunctive) return matches(provider, self)
    return self.multi.every((c) => matches(provider, c))
  }
  if (provider.multi !== undefined) return matches(provider, self)
  return matchSpecific(self, provider)
}

// Whether a version, normalized, is in what a constraint allows.
export const allows = (c, version) => matches(c, constraint('==', version))

export const exactly = (version) => constraint('==', version)

// Versions and version requirements as cargo reads them, by the semver
// crate's rules (1.0): a requirement is comparators joined by commas, each
// an operator (`^` where none is written) and a version that may stop short
// of its patch or end in a wildcard. A number past 2^53 is refused, where
// the crate reads up to 2^64.

import { LockfileError, quote } from '../error.js'

const NUMBER = '(0|[1-9]\\d*)'
const PART = `(?:([*Xx])|${NUMBER})`
const IDENTIFIER = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][\\dA-Za-z-]*)'
const COMPARATOR = new RegExp(
  `(>=|<=|>|<|=|~|\\^)? *${NUMBER}(?:\\.${PART}(?:\\.${PART})?)?` +
  `(?:-(${IDENTIFIER}(?:\\.${IDENTIFIER})*))?(\\+[\\dA-Za-z-]+(?:\\.[\\dA-Za-z-]+)*)? *(,)? *`,
  'uy',
)
const OPS = { __proto__: null, '>=': 'GreaterEq', '<=': 'LessEq', '>': 'Greater', '<': 'Less', '=': 'Exact', '~': 'Tilde', '^': 'Caret' }
const MAX_COMPARATORS = 32

function number(text, fail) {
  const value = Number(text)
  if (!Number.isSafeInteger(value)) fail(`${text} is past 2^53`)
  return value
}

// An empty list is `*`, which takes any version but a pre-release.
export function parseRequirement(text, where) {
  const fail = (why) => {
    throw new LockfileError(`${quote(text)} is not a version requirement: ${why}`, where)
  }
  const start = text.length - text.replace(/^ +/u, '').length
  if (/^[*Xx]/u.test(text.slice(start))) {
    if (/^[*Xx] *$/u.test(text.slice(start))) return []
    fail('a wildcard is only a requirement alone')
  }
  const comparators = []
  COMPARATOR.lastIndex = start
  for (;;) {
    const at = COMPARATOR.lastIndex
    const m = COMPARATOR.exec(text)
    if (m === null) fail(`unexpected ${at < text.length ? quote(text[at]) : 'end'}`)
    const [, op, major, minorWild, minor, patchWild, patch, pre, build, comma] = m
    if (minorWild !== undefined && patch !== undefined) fail('a wildcard is only followed by another')
    if ((pre !== undefined || build !== undefined) && patch === undefined) fail('only a full version takes a pre-release or build')
    const wild = minorWild !== undefined || patchWild !== undefined
    comparators.push({
      op: op === undefined ? (wild ? 'Wildcard' : 'Caret') : OPS[op],
      major: number(major, fail),
      minor: minor === undefined ? undefined : number(minor, fail),
      patch: patch === undefined ? undefined : number(patch, fail),
      pre: pre === undefined ? [] : pre.split('.'),
    })
    if (comma === undefined) {
      if (COMPARATOR.lastIndex !== text.length) fail(`unexpected ${quote(text[COMPARATOR.lastIndex])}`)
      return comparators
    }
    if (comparators.length === MAX_COMPARATORS) fail(`more than ${MAX_COMPARATORS} comparators`)
  }
}

// `version` is exact SemVer, as isVersion holds it.
export function parseVersion(version) {
  const [, major, minor, patch, pre] = /^(\d+)\.(\d+)\.(\d+)(?:-([^+]*))?/u.exec(version)
  return { major: Number(major), minor: Number(minor), patch: Number(patch), pre: pre === undefined ? [] : pre.split('.') }
}

// No pre-release is above any; numeric identifiers are below the rest.
function comparePre(a, b) {
  if (a.length === 0 || b.length === 0) return b.length - a.length
  for (let i = 0; i < a.length; i++) {
    if (i === b.length) return 1
    const [x, y] = [a[i], b[i]]
    const [xn, yn] = [/^\d+$/u.test(x), /^\d+$/u.test(y)]
    if (xn !== yn) return xn ? -1 : 1
    if (xn && x.length !== y.length) return x.length - y.length
    if (x !== y) return x < y ? -1 : 1
  }
  return a.length === b.length ? 0 : -1
}

const samePre = (a, b) => a.length === b.length && a.every((part, i) => part === b[i])

function exact(c, v) {
  return v.major === c.major && (c.minor === undefined || v.minor === c.minor) && (c.patch === undefined || v.patch === c.patch) && samePre(v.pre, c.pre)
}

// Where the version is above the comparator: 1, below: -1, and 0 where the
// comparator stops short of what tells them apart.
function order(c, v) {
  if (v.major !== c.major) return Math.sign(v.major - c.major)
  if (c.minor === undefined) return 0
  if (v.minor !== c.minor) return Math.sign(v.minor - c.minor)
  if (c.patch === undefined) return 0
  if (v.patch !== c.patch) return Math.sign(v.patch - c.patch)
  return Math.sign(comparePre(v.pre, c.pre))
}

function caret(c, v) {
  if (v.major !== c.major) return false
  if (c.minor === undefined) return true
  if (c.patch === undefined) return c.major > 0 ? v.minor >= c.minor : v.minor === c.minor
  if (c.major > 0) {
    if (v.minor !== c.minor) return v.minor > c.minor
  } else if (c.minor > 0) {
    if (v.minor !== c.minor) return false
  } else if (v.minor !== c.minor || v.patch !== c.patch) {
    return false
  }
  if (v.patch !== c.patch) return v.patch > c.patch
  return comparePre(v.pre, c.pre) >= 0
}

function tilde(c, v) {
  if (v.major !== c.major || (c.minor !== undefined && v.minor !== c.minor)) return false
  if (c.patch !== undefined && v.patch !== c.patch) return v.patch > c.patch
  return comparePre(v.pre, c.pre) >= 0
}

const MATCH = {
  __proto__: null,
  Exact: exact,
  Wildcard: exact,
  Greater: (c, v) => order(c, v) > 0,
  GreaterEq: (c, v) => exact(c, v) || order(c, v) > 0,
  Less: (c, v) => order(c, v) < 0,
  LessEq: (c, v) => exact(c, v) || order(c, v) < 0,
  Tilde: tilde,
  Caret: caret,
}

// A pre-release is taken only where a comparator names that version's
// major, minor and patch with a pre-release of its own.
export function matches(comparators, version) {
  if (!comparators.every((c) => MATCH[c.op](c, version))) return false
  return version.pre.length === 0 || comparators.some((c) => c.major === version.major && c.minor === version.minor && c.patch === version.patch && c.pre.length > 0)
}

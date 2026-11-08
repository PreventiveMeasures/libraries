import { compareVersions, parseVersion } from '@preventive/lockfile/pep440.js'

import { assertion, matches } from '../args.js'

// PEP 440 versions, read and ordered as packaging does by
// @preventive/lockfile, and GitHub's ranges of them.
export { compareVersions }

// 256 at most, as a gem's is, before any regex runs.
export const isVersion = (text) => typeof text === 'string' && text.length <= 256 && parseVersion(text) !== undefined
export const assertPypiVersion = assertion('a PEP 440 version', isVersion)
// PEP 508's: letters, digits and `-_.` inside.
export const assertPypiName = assertion('a Python package name', matches(/^(?=.{1,255}$)[\dA-Za-z](?:[\w.-]*[\dA-Za-z])?$/u))

// PEP 503's: any case, and a run of `-`, `_` and `.` one `-`.
export const normalName = (name) => name.toLowerCase().replaceAll(/[-_.]+/gu, '-')

const PART = /^\s*(<=|>=|==|<|>|=)?\s*(\S+)\s*$/u
const OPERATORS = {
  __proto__: null,
  '=': (cmp) => cmp === 0,
  '==': (cmp) => cmp === 0,
  '<': (cmp) => cmp < 0,
  '<=': (cmp) => cmp <= 0,
  '>': (cmp) => cmp > 0,
  '>=': (cmp) => cmp >= 0,
}

// Each `[operator, version]` of GitHub's `>= 1.0, < 1.2.6`; undefined where
// a part isn't one, or the range is too long to be one, before any regex.
function requirementsOf(text) {
  if (text.length > 1024) return undefined
  const parts = text.split(',').map((part) => PART.exec(part))
  if (parts.some((match) => match === null || !isVersion(match[2]))) return undefined
  return parts.map(([, operator = '=', against]) => [operator, against])
}

// A test of a range, every part of it met as PEP 440 orders versions: a
// pre-release is in a range around it, as it is for every ecosystem here.
export function readRange(text) {
  const parts = requirementsOf(text)
  return parts && ((version) => parts.every(([operator, against]) => OPERATORS[operator](compareVersions(version, against))))
}

// A range of lower bounds alone, with the one version that fixed it above
// each of them, ends below that version; any other is as given, as a gem's.
export function boundRange(range, patched) {
  if (!isVersion(patched)) return range
  if (range.trim() === '') return `< ${patched}`
  const open = requirementsOf(range)?.every(([operator, against]) => (operator === '>=' || operator === '>') && compareVersions(against, patched) < 0)
  return open ? `${range.trim()}, < ${patched}` : range
}

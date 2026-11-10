import { compareVersions, parseVersion } from '@preventive/lockfile/pep440.js'

import { assertion, matches } from '../args.js'

// PEP 440 versions, by @preventive/lockfile, and GitHub's ranges of them.
export { compareVersions }

// 256 at most, before any regex runs.
export const isVersion = (text) => typeof text === 'string' && text.length <= 256 && parseVersion(text) !== undefined
export const assertPypiVersion = assertion('a PEP 440 version', isVersion)
// PEP 508's: letters, digits and `-_.` inside.
export const assertPypiName = assertion('a Python package name', matches(/^(?=.{1,255}$)[\dA-Za-z](?:[\w.-]*[\dA-Za-z])?$/u))

// PEP 503's: any case, and a run of `-`, `_` and `.` one `-`.
export const normalName = (name) => name.toLowerCase().replaceAll(/[-_.]+/gu, '-')

const PART = /^\s*(<=|>=|<|>|=)?\s*(\S+)\s*$/u
const OPERATORS = {
  __proto__: null,
  '=': (cmp) => cmp === 0,
  '<': (cmp) => cmp < 0,
  '<=': (cmp) => cmp <= 0,
  '>': (cmp) => cmp > 0,
  '>=': (cmp) => cmp >= 0,
}

// Undefined where a part isn't an operator and a version, or the range is
// over 1,024 characters.
function requirementsOf(text) {
  if (text.length > 1024) return undefined
  const parts = text.split(',').map((part) => PART.exec(part))
  if (parts.some((match) => match === null || !isVersion(match[2]))) return undefined
  return parts.map(([, operator = '=', against]) => [operator, against])
}

// A pre-release is in a range around it, as for every ecosystem here.
export function readRange(text) {
  const parts = requirementsOf(text)
  return parts && ((version) => parts.every(([operator, against]) => OPERATORS[operator](compareVersions(version, against))))
}

// Lower bounds alone end below the one patched version above them; any
// other range is as given.
export function boundRange(range, patched) {
  if (!isVersion(patched)) return range
  if (range.trim() === '') return `< ${patched}`
  const open = requirementsOf(range)?.every(([operator, against]) => (operator === '>=' || operator === '>') && compareVersions(against, patched) < 0)
  return open ? `${range.trim()}, < ${patched}` : range
}

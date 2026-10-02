// What changes the tree between the npm releases supported. `reuse` is npm
// 10's ci, building on the tree it loaded the lockfile into: lockfile flags
// as written, optional packages left out after their directories are made,
// an unmet optional peer resolved again, a workspace's prepare script run.

import { DeptreeError, quote } from '../error.js'

const SUPPORTED = [[[10, 9, 3], [10, 9, 9]], [[11, 11, 1], [11, 21, 0]]]

const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
const show = ([from, to]) => (compare(from, to) === 0 ? from.join('.') : `${from.join('.')} to ${to.join('.')}`)

export function profileOf(npm) {
  const version = /^(\d+)\.(\d+)\.(\d+)$/u.exec(npm)?.slice(1).map(Number)
  if (version === undefined || !SUPPORTED.some(([from, to]) => compare(version, from) >= 0 && compare(version, to) <= 0)) {
    throw new DeptreeError(`npm ${quote(npm)} is not supported: only ${SUPPORTED.map(show).join(', and ')}`, 'host.npm')
  }
  const since = (bound) => compare(version, bound) >= 0
  return { npm, reuse: version[0] === 10, ratio: version[0] === 10 ? since([10, 9, 9]) : since([11, 18, 0]), inert: since([11, 13, 0]), allowScripts: since([11, 16, 0]) }
}

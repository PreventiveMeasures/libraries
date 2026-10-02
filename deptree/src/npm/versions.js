// The npm releases buildNpmTree builds for, and what of each changes the
// tree. `reuse` is npm 10's ci, which builds on the tree it loaded the
// lockfile into: it takes the lockfile's flags as written, leaves out an
// optional package the host cannot run only once it has made directories
// for it, and runs a workspace's prepare script even with --ignore-scripts.
// `ratio` is whether its tar gives up on a tarball that inflates too far,
// as tar 7.5.19 and later do.

import { DeptreeError, quote } from '../error.js'

const SUPPORTED = [[[10, 9, 9], [10, 9, 9]], [[11, 12, 0], [11, 21, 0]]]
const RATIO = [11, 18, 0]

const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
const show = ([from, to]) => (compare(from, to) === 0 ? from.join('.') : `${from.join('.')} to ${to.join('.')}`)

export function profileOf(npm) {
  const version = /^(\d+)\.(\d+)\.(\d+)$/u.exec(npm)?.slice(1).map(Number)
  if (version === undefined || !SUPPORTED.some(([from, to]) => compare(version, from) >= 0 && compare(version, to) <= 0)) {
    throw new DeptreeError(`npm ${quote(npm)} is not supported: only ${SUPPORTED.map(show).join(', and ')}`, 'host.npm')
  }
  return { npm, reuse: version[0] === 10, ratio: version[0] === 10 || compare(version, RATIO) >= 0 }
}

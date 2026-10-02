// The npm releases buildNpmTree builds for, and what of each changes the
// tree. `reuse` is npm 10's ci, which builds on the tree it loaded the
// lockfile into: it takes the lockfile's flags as written, leaves out an
// optional package the host cannot run only once it has made directories
// for it, resolves again an optional peer the lockfile does not meet, and
// runs a workspace's prepare script even with --ignore-scripts. `ratio` is
// whether its tar, 7.5.19 or later, gives up on a tarball that inflates too
// far; `inert` whether an optional package's set passes over what an
// earlier one's left out; `allowScripts` whether it reads the root
// package.json's allowScripts.

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

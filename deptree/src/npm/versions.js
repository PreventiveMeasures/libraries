// The npm releases buildNpmTree builds for, and what of each changes the
// tree. `reuse` is npm 10's ci, which builds on the tree it loaded the
// lockfile into: it takes the lockfile's flags as written, leaves out an
// optional package the host cannot run only once it has made directories
// for it, and runs a workspace's prepare script even with --ignore-scripts.
// `ratio` is whether its tar gives up on a tarball that inflates too far.

import { DeptreeError, quote } from '../error.js'

const PROFILES = [
  { from: [10, 9, 9], to: [10, 9, 9], reuse: true, ratio: true },
  { from: [11, 12, 0], to: [11, 21, 0], reuse: false, ratio: false },
]

const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

export function profileOf(npm) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(npm)
  const version = match?.slice(1).map(Number)
  const profile = version && PROFILES.find(({ from, to }) => compare(version, from) >= 0 && compare(version, to) <= 0)
  if (profile === undefined) throw new DeptreeError(`npm ${quote(npm)} is not supported: only ${PROFILES.map(({ from, to }) => `${from.join('.')} to ${to.join('.')}`).join(', ')}`, 'host.npm')
  return { npm, reuse: profile.reuse, ratio: profile.ratio }
}

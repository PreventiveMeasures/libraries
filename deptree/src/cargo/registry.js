// The packages `cargo vendor` copies into vendor/, each from its .crate:
// every one of the lockfile's but a path package, which is in the project
// already. Each is fetched from crates.io and unpacked as cargo unpacks it.

import { parseVersion } from '@preventive/lockfile/rust-semver.js'
import { getCrate } from '@preventive/upstream/cargo.js'
import { eachConcurrently } from '../concurrent.js'
import { DeptreeError, quote } from '../error.js'
import { vendorCrate } from './crate.js'

// As Cargo.lock names crates.io, however cargo reaches its index.
const CRATES_IO = 'registry+https://github.com/rust-lang/crates.io-index'

export const about = (key) => `packages[${quote(key)}]`

const sign = (a, b) => (a === b ? 0 : a < b ? -1 : 1)

// The semver crate's order of two versions the lockfile reader has read, but
// for build metadata, which crates.io takes no two versions apart by: a
// pre-release before its release, its identifiers digits before others and
// digits by their value.
function compareVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)]
  for (const part of ['major', 'minor', 'patch']) if (x[part] !== y[part]) return sign(x[part], y[part])
  if (x.pre === '' || y.pre === '') return sign(x.pre === '', y.pre === '')
  const [ids1, ids2] = [x.pre.split('.'), y.pre.split('.')]
  for (let i = 0; i < Math.min(ids1.length, ids2.length); i++) {
    const [p, q] = [ids1[i], ids2[i]]
    const [digits1, digits2] = [/^\d+$/u.test(p), /^\d+$/u.test(q)]
    if (digits1 !== digits2) return digits1 ? -1 : 1
    const order = (digits1 && sign(p.length, q.length)) || sign(p, q)
    if (order !== 0) return order
  }
  return sign(ids1.length, ids2.length)
}

// vendor.rs: the greatest version of a name has a directory of the name
// alone, and any other `<name>-<version>`.
export function vendoredPackages(lock) {
  const crates = []
  for (const [key, pkg] of Object.entries(lock.packages)) {
    if (pkg.source === undefined) continue
    if (pkg.source.startsWith('git+')) throw new DeptreeError('a git dependency, which cargo vendor checks out with git, is not supported', about(key))
    if (pkg.source !== CRATES_IO) throw new DeptreeError('a package from a registry other than crates.io is not supported', about(key))
    crates.push({ key, name: pkg.name, version: pkg.version, checksum: pkg.checksum })
  }
  const greatest = new Map()
  for (const { name, version } of crates) {
    const other = greatest.get(name)
    const order = other === undefined ? 1 : compareVersions(version, other)
    if (order === 0) throw new DeptreeError(`${quote(version)} and ${quote(other)} differ only in build metadata, which cargo vendors one of`, about(`${name} ${version}`))
    if (order > 0) greatest.set(name, version)
  }
  for (const crate of crates) crate.directory = crate.version === greatest.get(crate.name) ? crate.name : `${crate.name}-${crate.version}`
  return crates
}

// A few at a time; what each holds, by its key.
export async function fetchCrates(crates, comment) {
  const vendored = new Map()
  await eachConcurrently(crates, async (crate) => {
    vendored.set(crate.key, await vendorCrate(await getCrate(crate.name, crate.version, crate.checksum), crate, comment, about(crate.key)))
  }, ({ key }) => about(key))
  return vendored
}

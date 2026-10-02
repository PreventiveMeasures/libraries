import { parseVersion } from '../crate/semver.js'
import { LockfileError, quote } from '../error.js'
import { string } from '../toml/shape.js'

export { array, boolean, checkListedOnce, entries, kind, refuse, string, strings, table, tableOf } from '../toml/shape.js'

// As cargo takes names, less what is not ASCII.
export function checkCrateName(value, where) {
  if (!/^[A-Z_a-z][\w-]*$/u.test(string(value, where))) throw new LockfileError(`${quote(value)} is not a package name`, where)
  return value
}

export function checkCrateVersion(value, where) {
  if (parseVersion(string(value, where)) === undefined) throw new LockfileError(`${quote(value)} is not a version`, where)
  return value
}

export function checkFeature(value, where) {
  if (!/^\w[\w+.-]*$/u.test(string(value, where))) throw new LockfileError(`${quote(value)} is not a feature name`, where)
  return value
}

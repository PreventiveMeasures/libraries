import { parseVersion } from '../crate/semver.js'
import { checker } from '../toml/shape.js'

export { array, boolean, checkListedOnce, entries, kind, refuse, string, strings, table, tableOf } from '../toml/shape.js'

// As cargo takes names, less what is not ASCII.
export const checkCrateName = checker((text) => /^[A-Z_a-z][\w-]*$/u.test(text), 'a package name')
export const checkCrateVersion = checker((text) => parseVersion(text) !== undefined, 'a version')
export const checkFeature = checker((text) => /^\w[\w+.-]*$/u.test(text), 'a feature name')

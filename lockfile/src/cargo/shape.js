import { parseVersion } from '../crate/semver.js'
import { matching } from '../toml/shape.js'

export { array, boolean, entries, kind, refuse, string, strings, table } from '../toml/shape.js'

// As cargo takes names, less what is not ASCII.
export const checkCrateName = matching((name) => /^[A-Z_a-z][\w-]*$/u.test(name), 'a package name')
export const checkCrateVersion = matching((version) => parseVersion(version) !== undefined, 'a version')
export const checkFeature = matching((name) => /^\w[\w+.-]*$/u.test(name), 'a feature name')

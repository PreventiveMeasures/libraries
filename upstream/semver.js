// The semver front door of @preventive/upstream, reached as
// `@preventive/upstream/semver.js`: npm's own semver, borrowed from the
// npm that ships beside node rather than installed, for matching
// advisory ranges, ordering versions and validating them.
export { compareVersions, isExactVersion, satisfies, semverAvailable, valid } from './src/semver.js'

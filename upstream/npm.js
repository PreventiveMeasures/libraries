// The npm front door of @preventive/upstream, reached as
// `@preventive/upstream/npm.js`: which GitHub repo a published package
// lives in, with an optional disk cache, and npm's own semver borrowed
// from the Node install for matching advisory ranges.
export { setCacheDir } from './src/cache.js'
export { getGitHub, readPackageRepoCache, resolvePackageRepos, writePackageRepoCache } from './src/npm/repos.js'
export { compareVersions, isExactVersion, satisfies, semverAvailable } from './src/npm/semver.js'

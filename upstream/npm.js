// The npm front door of @preventive/upstream, reached as
// `@preventive/upstream/npm.js`: which GitHub repo a published package
// lives in, and a published version's tarball checked against its
// integrity, both through an optional disk cache.
export { setCacheDir } from './src/cache.js'
export { getGitHub, readPackageRepoCache, resolvePackageRepos, writePackageRepoCache } from './src/npm/repos.js'
export { getTarball } from './src/npm/tarball.js'

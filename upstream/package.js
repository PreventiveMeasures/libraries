// The package.json front door of @preventive/upstream, reached as
// `@preventive/upstream/package.js`: which GitHub repo a package's own
// metadata names, and where in it the package sits, with no request
// made. npm.js's getGitHub is this over the registry's document.
export { getRepo } from './src/package.js'

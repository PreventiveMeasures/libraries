// The git front door of @preventive/upstream, reached as
// `@preventive/upstream/git.js`: which commit a directory is checked out
// at, where in its repository it sits, and its GitHub repo, read off
// `.git` without running git.
export { findGitCheckout } from './src/git.js'

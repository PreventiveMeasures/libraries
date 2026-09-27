// The GitHub front door of @preventive/upstream, reached as
// `@preventive/upstream/github.js`: a read-only client — the repo itself,
// its head, a file, its tarball, a pull request, a user's permission on
// it, the authenticated user and their repos. Nothing a client made here
// can change anything on GitHub; github/write.js has the one that can.
// Every argument is checked hard before any request is built.
export { createClient } from './src/github/read.js'
export { GitHubError } from './src/github/request.js'

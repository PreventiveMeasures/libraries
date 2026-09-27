// The GitHub front door of @preventive/upstream, reached as
// `@preventive/upstream/github.js`: a token-authenticated client for the
// few REST and GraphQL calls it takes to read a repo — its head, a file,
// its tarball — and to fork it, branch it, commit to it and open a pull
// request.
export { createClient, parseGraphQLResponse } from './src/github.js'

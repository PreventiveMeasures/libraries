// The writing half of @preventive/upstream's GitHub client, reached as
// `@preventive/upstream/github/write.js`: everything github.js reads, and
// the calls that change something — fork a repo, branch it, commit to it,
// open a pull request. A separate front door so that a caller that only
// reads never holds a client that can write.
export { createWriteClient, parseGraphQLResponse } from '../src/github/write.js'
export { HttpError } from '../src/http.js'

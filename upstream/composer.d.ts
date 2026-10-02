// Hand-written against composer.js; a change to either belongs with the
// other.
//
// The cache is setCacheDir's (npm.js).

export { HttpError } from './npm.js'

// A package's dist as composer.lock records it, whole, in memory: the file
// at `url`, held to `shasum`, the sha1 in hex Composer holds it to, which
// is all that is checked of it — whether downloaded, before it is cached,
// or read from setCacheDir's cache, where it is kept by the sha1 alone and
// one that does not match throws. A cached file that matches is answered
// with no request at all. `url` is one of the two kinds of dist a lockfile
// records a sha1 for: a release zip on drupal.org,
// https://ftp.drupal.org/files/projects/<name>.zip, or GitHub's zipball of
// a commit, https://api.github.com/repos/<owner>/<repo>/zipball/<sha>, its
// redirect to codeload.github.com followed and nothing else, asked with no
// credentials. Anything else, a malformed shasum among it, is refused
// before any request.
export function getDist(url: string, shasum: string): Promise<Uint8Array>

// What getDist takes `url` as, without fetching it: `redirect`, whether its
// redirect is followed, and of a GitHub zipball its `repo` and `commit`;
// null for any URL getDist refuses.
export function readDistUrl(url: string): { redirect: 'manual' | 'follow'; repo?: string; commit?: string } | null

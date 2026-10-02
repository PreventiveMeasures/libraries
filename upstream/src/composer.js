import assert from 'node:assert/strict'

import { isRepo, isSha1, show } from './args.js'
import { verifiedDownload } from './download.js'
import { repoApi } from './github/client.js'
import { DRUPAL_FTP, buildUrl } from './http.js'

const DIR = 'composer/dists' // No expiry: each is kept by the sha1 it was held to.
const PROJECT_ZIP = /^(?=.{5,255}$)[\dA-Za-z][\w.+-]*\.zip$/u

// The two places a dist is downloaded from with a sha1 to hold it to:
// drupal.org's releases, and GitHub's zipball of a commit, which redirects
// to codeload.github.com, its `repo` and `commit` read off it. Each built
// again from its parts, so the URL is one buildUrl makes, with nothing else
// in it; null for any other.
export function readDistUrl(url) {
  const drupal = /^https:\/\/ftp\.drupal\.org\/files\/projects\/([^/]+)$/u.exec(url)
  if (drupal && PROJECT_ZIP.test(drupal[1]) && buildUrl(DRUPAL_FTP, ['files', 'projects', drupal[1]]) === url) return { redirect: 'manual' }
  const github = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/zipball\/([^/]+)$/u.exec(url)
  if (github && isRepo(github[1]) && isSha1(github[2]) && repoApi(github[1], ['zipball', github[2]]) === url) return { redirect: 'follow', repo: github[1], commit: github[2] }
  return null
}

// composer.lock's dist of a package, by its URL and the sha1 it records,
// which Composer holds the file to; nothing else is checked of it.
export async function getDist(url, shasum) {
  const dist = readDistUrl(url)
  assert.ok(dist !== null, `getDist: url must be a release zip on ftp.drupal.org or a GitHub zipball of a commit, got ${show(url)}`)
  assert.ok(isSha1(shasum), `getDist: shasum must be a sha1 in lowercase hex, got ${show(shasum)}`)
  return await verifiedDownload({ method: 'getDist', dir: DIR, what: shasum, ext: 'zip', algorithm: 'sha1', expected: shasum, locate: () => url, options: { redirect: dist.redirect } })
}

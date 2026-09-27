import assert from 'node:assert/strict'

import { assertion, isRepo, sameName } from './args.js'
import { githubRepoOfUrl } from './remote.js'

// Deliberately narrow: the tracker must be exactly the repo's `/issues` page.
const bugsRegex = /^https?:\/\/github\.com\/(?<repo>[\w-]+\/[\w-]+)\/issues$/u
// npm's `owner/name` shorthand means GitHub. No dots in the owner, so a
// domain (`srvx.h3.dev/srvx`) isn't read as one; another forge's prefix
// (`gitlab:`) can't match.
const shorthandRegex = /^(?:github:)?(?<repo>[\w-]+\/[\w.-]+)$/u
// The repo's page, or a `/tree/<ref>/<directory>` into it. The ref is one
// segment, so a branch with a `/` would read as part of the directory;
// homepages name main, master or HEAD in practice.
const homepageRegex = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(?<repo>[\w-]+\/[\w.-]+?)(?:\.git)?(?:\/|\/tree\/[^/]+\/(?<directory>.+))?$/iu
// No leading dot, so no `.` or `..`: this goes into github.com links.
const segmentRegex = /^[\w-][\w.-]*$/u
const str = (value) => (typeof value === 'string' ? value : '')
// `bugs` and `repository` are each either the URL itself or `{ url }`.
const urlOf = (field) => str(field?.url ?? field)
// npm appends `#readme` to the homepage it fills in.
const homepageUrl = (homepage) => str(homepage).trim().split(/[?#]/u)[0]
const repoIn = (regex, text) => regex.exec(text)?.groups.repo

const repositoryRepo = (url) => repoIn(shorthandRegex, url) ?? githubRepoOfUrl(url)

function repoSubdirectory(value) {
  const trimmed = str(value).trim().replace(/^(?:\.\/|\/)+/u, '').replace(/\/+$/u, '')
  return trimmed && trimmed.split('/').every((segment) => segmentRegex.test(segment)) ? trimmed : undefined
}

export const isRepoDirectory = (value) => typeof value === 'string' && (value === '' || repoSubdirectory(value) === value)
export const assertRepoDirectory = assertion('a path inside the repository', isRepoDirectory)

// bugs, then repository, then homepage; a candidate that isn't
// `owner/name` by GitHub's rules falls through to the next.
export function getRepo(pkg) {
  assert.ok(pkg && typeof pkg === 'object' && !Array.isArray(pkg), 'getRepo: expected a package.json object')
  const { bugs, repository } = pkg
  const declared = repositoryRepo(urlOf(repository))
  const homepage = homepageRegex.exec(homepageUrl(pkg.homepage))?.groups
  const github = [repoIn(bugsRegex, urlOf(bugs)), declared, homepage?.repo].find(isRepo)
  if (github === undefined) return {}
  // `repository.directory` first, then the homepage's, each only where it
  // is about the same repo.
  const directory = ((declared === undefined || sameName(declared, github)) && repoSubdirectory(repository?.directory))
    || (sameName(homepage?.repo, github) && repoSubdirectory(homepage.directory))
  return { github, ...(directory && { directory }), url: `https://github.com/${github}` }
}

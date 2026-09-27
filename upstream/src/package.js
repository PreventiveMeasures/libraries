import assert from 'node:assert/strict'

import { assertion, isRepo, sameName } from './args.js'
import { githubRepoOfUrl } from './remote.js'

// Deliberately narrow: the tracker must be exactly the repo's `/issues` page.
const bugsRegex = /^https?:\/\/github\.com\/(?<repo>[\w-]+\/[\w-]+)\/issues$/u
// npm's `owner/name` shorthand means GitHub. No dots in the owner, so a
// domain (`srvx.h3.dev/srvx`) isn't read as one; another forge's prefix
// (`gitlab:`) can't match.
const shorthandRegex = /^(?:github:)?(?<repo>[\w-]+\/[\w.-]+)$/u
const homepageRepoRegex = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(?<repo>[\w-]+\/[\w.-]+?)(?:\.git)?(?:\/|\/tree\/[^/]+\/.+)?$/iu
// The ref is one segment, so a branch with a `/` would read as part of the
// directory; homepages name main, master or HEAD in practice.
const homepageTreeRegex = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(?<repo>[\w-]+\/[\w.-]+)\/tree\/[^/]+\/(?<directory>.+)$/iu
// No leading dot, so no `.` or `..`: this goes into github.com links.
const segmentRegex = /^[\w-][\w.-]*$/u
const str = (value) => (typeof value === 'string' ? value : '')
// `bugs` and `repository` are each either the URL itself or `{ url }`.
const urlOf = (field) => str(field?.url ?? field)
// npm appends `#readme` to the homepage it fills in.
const homepageUrl = (homepage) => str(homepage).trim().split(/[?#]/u)[0]
const repoIn = (regex, text) => regex.exec(text)?.groups.repo

function repositoryRepo(repository) {
  const url = urlOf(repository)
  return repoIn(shorthandRegex, url) ?? githubRepoOfUrl(url)
}

function repoSubdirectory(value) {
  const trimmed = str(value).trim().replace(/^(?:\.\/|\/)+/u, '').replace(/\/+$/u, '')
  return trimmed && trimmed.split('/').every((segment) => segmentRegex.test(segment)) ? trimmed : undefined
}

// `repository.directory` first, then a homepage `/tree/<ref>/<path>`, each
// only where it is about the same repo.
function repoDirectory(repository, homepage, github) {
  const declared = repositoryRepo(repository)
  const directory = (declared === undefined || sameName(declared, github)) && repoSubdirectory(repository?.directory)
  if (directory) return directory
  const tree = homepageTreeRegex.exec(homepageUrl(homepage))?.groups
  return tree && sameName(tree.repo, github) ? repoSubdirectory(tree.directory) : undefined
}

export const isRepoDirectory = (value) => typeof value === 'string' && (value === '' || repoSubdirectory(value) === value)
export const assertRepoDirectory = assertion('a path inside the repository', isRepoDirectory)

// bugs, then repository, then homepage; a candidate that isn't
// `owner/name` by GitHub's rules falls through to the next.
export function getRepo(pkg) {
  assert.ok(pkg && typeof pkg === 'object' && !Array.isArray(pkg), 'getRepo: expected a package.json object')
  const { bugs, homepage, repository } = pkg
  const github = [repoIn(bugsRegex, urlOf(bugs)), repositoryRepo(repository), repoIn(homepageRepoRegex, homepageUrl(homepage))].find(isRepo)
  if (github === undefined) return {}
  const directory = repoDirectory(repository, homepage, github)
  return { github, ...(directory && { directory }), url: `https://github.com/${github}` }
}

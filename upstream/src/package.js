import assert from 'node:assert/strict'

import { assertion, isRepo, sameName } from './args.js'
import { githubRepoOfUrl } from './remote.js'

const bugsRegex = /^https?:\/\/(?i:github\.com)\/(?<repo>[\w-]+\/[\w.-]+)\/issues\/?$/u
// npm's `owner/name` shorthand means GitHub. No dots in the owner, so a
// domain (`srvx.h3.dev/srvx`) isn't read as one; another forge's prefix
// (`gitlab:`) can't match.
const shorthandRegex = /^(?:github:)?(?<repo>[\w-]+\/[\w.-]+)$/u
// The ref is one segment: a branch with a `/` reads as part of the directory.
const homepageRegex = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(?<repo>[\w-]+\/[\w.-]+?)(?:\.git)?(?:\/(?:tree\/[^/]+(?:\/(?<directory>.*))?)?)?$/iu
const segmentRegex = /^[\w-][\w.-]*$/u // No leading dot, so no `.` or `..` in a github.com link.
const str = (value) => (typeof value === 'string' ? value : '')
const urlOf = (field) => str(field?.url ?? field)
const homepageUrl = (homepage) => str(homepage).trim().split(/[?#]/u)[0] // npm appends `#readme`.
const repoIn = (regex, text) => regex.exec(text)?.groups.repo

const repositoryRepo = (url) => repoIn(shorthandRegex, url) ?? githubRepoOfUrl(url)

function repoSubdirectory(value) {
  const trimmed = str(value).trim().replace(/^(?:\.\/|\/)+/u, '').replace(/\/+$/u, '')
  return trimmed && trimmed.split('/').every((segment) => segmentRegex.test(segment)) ? trimmed : undefined
}

export const isRepoDirectory = (value) => typeof value === 'string' && (value === '' || repoSubdirectory(value) === value)
export const assertRepoDirectory = assertion('a path inside the repository', isRepoDirectory)

export function getRepo(pkg) {
  assert.ok(pkg && typeof pkg === 'object' && !Array.isArray(pkg), 'getRepo: expected a package.json object')
  const { bugs, repository } = pkg
  const declared = repositoryRepo(urlOf(repository))
  const homepage = homepageRegex.exec(homepageUrl(pkg.homepage))?.groups
  const github = [repoIn(bugsRegex, urlOf(bugs)), declared, homepage?.repo].find(isRepo)
  if (github === undefined) return {}
  const directory = (sameName(declared, github) && repoSubdirectory(repository?.directory))
    || (sameName(homepage?.repo, github) && repoSubdirectory(homepage.directory))
  return { github, ...(directory && { directory }), url: `https://github.com/${github}` }
}

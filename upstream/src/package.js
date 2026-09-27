import assert from 'node:assert/strict'

import { assertion, isRepo } from './args.js'
import { githubRepoOfUrl } from './remote.js'

// Deliberately narrow: the tracker must be exactly the repo's `/issues` page.
const githubRegex = /^https:\/\/github.com\/[\w-]+\/[\w-]+$/u

// npm's `owner/name` shorthand means GitHub. No dots in the owner, so a
// domain (`srvx.h3.dev/srvx`) isn't read as one; another forge's prefix
// (`gitlab:`) can't match.
const shorthandRegex = /^(?:github:)?(?<repo>[\w-]+\/[\w.-]+)$/u

function bugsRepo(bugs) {
  // A package.json may carry `bugs` as the URL itself; the registry has `{ url }`.
  const tracker = typeof bugs === 'string' ? bugs : bugs?.url
  if (typeof tracker !== 'string') return undefined
  const issues = tracker.replace(/^http:/u, 'https:')
  const url = issues.replace(/\/issues$/u, '')
  if (issues !== `${url}/issues` || !githubRegex.test(url)) return undefined
  return url.replace('https://github.com/', '')
}

function repositoryRepo(repository) {
  const url = typeof repository === 'string' ? repository : repository?.url
  if (typeof url !== 'string') return undefined
  return shorthandRegex.exec(url)?.groups.repo ?? githubRepoOfUrl(url)
}

// The ref is one segment, so a branch with a `/` would read as part of the
// directory; homepages name main, master or HEAD in practice.
const homepageTreeRegex = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(?<repo>[\w-]+\/[\w.-]+)\/tree\/[^/]+\/(?<directory>.+)$/iu

const homepageRepoRegex = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(?<repo>[\w-]+\/[\w.-]+?)(?:\.git)?(?:\/|\/tree\/[^/]+\/.+)?$/iu

// npm appends `#readme` to the homepage it fills in.
const homepageUrl = (homepage) => (typeof homepage === 'string' ? homepage.trim().split(/[?#]/u)[0] : '')

function homepageRepo(homepage) {
  return homepageRepoRegex.exec(homepageUrl(homepage))?.groups.repo
}

// No leading dot, so no `.` or `..`: this goes into github.com links.
const segmentRegex = /^[\w-][\w.-]*$/u

function repoSubdirectory(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().replace(/^(?:\.\/|\/)+/u, '').replace(/\/+$/u, '')
  if (!trimmed) return undefined
  const segments = trimmed.split('/')
  return segments.every((segment) => segmentRegex.test(segment)) ? segments.join('/') : undefined
}

// GitHub names are case-insensitive.
const sameRepo = (a, b) => a.toLowerCase() === b.toLowerCase()

// `repository.directory` first, then a homepage `/tree/<ref>/<path>`, each
// only where it is about the same repo.
function repoDirectory(repository, homepage, github) {
  const declared = repositoryRepo(repository)
  if (declared === undefined || sameRepo(declared, github)) {
    const directory = repoSubdirectory(typeof repository === 'string' ? undefined : repository?.directory)
    if (directory) return directory
  }
  const tree = homepageTreeRegex.exec(homepageUrl(homepage))
  if (!tree || !sameRepo(tree.groups.repo, github)) return undefined
  return repoSubdirectory(tree.groups.directory)
}

export const isRepoDirectory = (value) => typeof value === 'string' && (value === '' || repoSubdirectory(value) === value)

export const assertRepoDirectory = assertion('a path inside the repository', isRepoDirectory)

// bugs, then repository, then homepage; a candidate that isn't
// `owner/name` by GitHub's rules falls through to the next.
export function getRepo(pkg) {
  assert.ok(pkg !== null && typeof pkg === 'object' && !Array.isArray(pkg), 'getRepo: expected a package.json object')
  const { bugs, homepage, repository } = pkg
  const github = [bugsRepo(bugs), repositoryRepo(repository), homepageRepo(homepage)].find(isRepo)
  if (github === undefined) return {}
  const directory = repoDirectory(repository, homepage, github)
  return { github, ...(directory && { directory }), url: `https://github.com/${github}` }
}

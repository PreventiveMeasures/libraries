import assert from 'node:assert/strict'

import { assertion, isRepo, isRepoPath, sameName } from './args.js'
import { githubRepoOfUrl, withoutDotGit } from './remote.js'

const bugsRegex = /^(?i:https?:\/\/github\.com)(?::\d{1,5})?\/(?<repo>[\w-]+\/[\w.-]+)\/issues\/?$/u
// npm's `owner/name` shorthand means GitHub. No dots in the owner, so a
// domain (`srvx.h3.dev/srvx`) isn't read as one; another forge's prefix
// (`gitlab:`) can't match.
const shorthandRegex = /^(?:github:)?(?<repo>[\w-]+\/[\w.-]+)$/u
// The ref is one segment: a branch with a `/` reads as part of the directory.
const homepageRegex = /^(?:https?:\/\/)?(?:www\.)?github\.com(?::\d{1,5})?\/(?<repo>[\w-]+\/[\w.-]+?)(?:\.git)?(?:\/(?:tree\/[^/]+(?:\/(?<directory>.*))?)?)?$/iu
const str = (value) => (typeof value === 'string' ? value : '')
// Read past the whitespace around it, as `homepage` is.
const urlOf = (field) => str(field?.url ?? field).trim()
const homepageUrl = (homepage) => str(homepage).trim().split(/[?#]/u)[0] // npm appends `#readme`.
// Every trailing `.git` dropped, as the URLs' are: no answer ends in one
// (the npm repo cache refuses one).
const repoIn = (regex, text) => withoutDotGit(regex.exec(text)?.groups.repo)
// A URL's path spells a tree path percent-encoded; one that does not decode names none.
function decodePath(path = '') {
  try {
    return decodeURIComponent(path)
  } catch {}
}

// npm lets a repository name a commit-ish after `#`; it is not part of the repo.
function repositoryRepo(url) {
  const repo = url.replace(/#.*$/su, '')
  return repoIn(shorthandRegex, repo) ?? githubRepoOfUrl(repo)
}

// Spaces are kept: git allows them at either end of a name.
function repoSubdirectory(value) {
  const path = str(value).replace(/^(?:\.\/|\/)+/u, '').replace(/\/+$/u, '')
  return isRepoPath(path) ? path : undefined // No empty, `.`, `..` or `.git` part: a path inside the repo.
}

// `repository.directory` is a path its author may write with Windows' `\`.
// A tree path is `/`-separated: a `\` is a name's own only in a homepage's
// (`%5C`), which is the path itself. One of nothing but `/` and `.` parts
// (`./`, `/`, `/.`, `.`, `''`) declares the repo's root, `''`; a package.json
// that declares none says nothing of where in the repo it sits.
function declaredDirectory(value) {
  if (typeof value !== 'string') return undefined
  const path = value.replaceAll('\\', '/')
  return path.split('/').every((part) => part === '' || part === '.') ? '' : repoSubdirectory(path)
}

export const isRepoDirectory = (value) => typeof value === 'string' && (value === '' || repoSubdirectory(value) === value)
export const assertRepoDirectory = assertion('a path inside the repository', isRepoDirectory)

export function getRepo(pkg) {
  assert.ok(pkg && typeof pkg === 'object' && !Array.isArray(pkg), 'getRepo: expected a package.json object')
  const { bugs, repository } = pkg
  const declared = repositoryRepo(urlOf(repository))
  const homepage = homepageRegex.exec(homepageUrl(pkg.homepage))?.groups
  const homepageRepo = withoutDotGit(homepage?.repo)
  // `repository` first: it is the field a publisher maintains, where a
  // `bugs` tracker can be left pointing at a former owner or misspelt.
  const github = [declared, repoIn(bugsRegex, urlOf(bugs)), homepageRepo].find(isRepo)
  if (github === undefined) return {}
  const directory = (sameName(declared, github) ? declaredDirectory(repository?.directory) : undefined)
    ?? (sameName(homepageRepo, github) ? repoSubdirectory(decodePath(homepage.directory)) : undefined)
  return { github, ...(directory !== undefined && { directory }), url: `https://github.com/${github}` }
}

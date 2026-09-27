import assert from 'node:assert/strict'

import { isRepo } from './args.js'
import { githubRepoOfUrl } from './remote.js'

// Which GitHub repo a package's own metadata names, and where in that
// repo the package sits — read off a package.json, or the registry's
// document for one, with no request made. The npm lookup (npm.js) is
// this, over the registry's `latest` document for a name.

// What `bugs.url` has to look like once its `/issues` suffix is off.
// Deliberately narrow (no dots), because this is matched against a URL a
// registry document supplied rather than one an operator typed.
const githubRegex = /^https:\/\/github.com\/[\w-]+\/[\w-]+$/u

// npm's repository shorthand: a bare `owner/name` means GitHub — it is
// what `npm init` writes and what npm itself resolves against
// github.com, and a package can carry it while pointing `homepage` at a
// docs domain of its own (`{ homepage: 'https://srvx.h3.dev',
// repository: { url: 'h3js/srvx' } }` → `h3js/srvx`).
//
// Nothing else is read as one. A host in front of the slug
// (`gitlab:owner/name`) names a different forge and cannot match — the
// `:` is outside the character class — and a value that looks like a
// DOMAIN is not an owner at all. Dots in the first segment are the
// tell, so the owner is matched without them while the repo name keeps
// them: `socket.io` is a repo, `srvx.h3.dev` is a host.
const shorthandRegex = /^(?:github:)?(?<repo>[\w-]+\/[\w.-]+)$/u

// `owner/name` off the issue tracker, which is the field that names the
// repo outright: `bugs.url` is the repo's `/issues` page, so dropping
// that suffix IS the repo — but only when the link is a GitHub one and
// only when it really carried the suffix, since a tracker somewhere
// else answers a different question. Undefined rather than a throw when
// it doesn't hold: the shorthand below gets its turn. Read on its own:
// the tracker names the repo whether or not a homepage is set.
//
// A package.json may carry `bugs` as the URL itself, where the registry
// has it as `{ url }`; both are read.
function bugsRepo(bugs) {
  const tracker = typeof bugs === 'string' ? bugs : bugs?.url
  if (typeof tracker !== 'string') return undefined
  const issues = tracker.replace(/^http:/u, 'https:')
  const url = issues.replace(/\/issues$/u, '')
  if (issues !== `${url}/issues` || !githubRegex.test(url)) return undefined
  return url.replace('https://github.com/', '')
}

// `repository` is a string as often as it is `{ url }`, and both spell
// a repo the same ways: the shorthand above, or a URL (githubRepoOfUrl,
// in src/remote.js). A `directory` beside it (a monorepo's
// subpath) says where in the repo the package lives, not which repo it
// is, so it changes nothing here.
function repositoryRepo(repository) {
  const url = typeof repository === 'string' ? repository : repository?.url
  if (typeof url !== 'string') return undefined
  return shorthandRegex.exec(url)?.groups.repo ?? githubRepoOfUrl(url)
}

// A `homepage` that points INTO the repo, which is where a package that
// never set `repository.directory` still says where it lives:
// `https://github.com/PreventiveMeasures/libraries/tree/main/diff`. The
// ref is one segment, so a branch with a `/` in its name would read as
// part of the path — homepage refs are `main` / `master` / `HEAD` in
// practice, and there is nothing in the URL that could tell the two
// apart anyway.
const homepageTreeRegex = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(?<repo>[\w-]+\/[\w.-]+)\/tree\/[^/]+\/(?<directory>.+)$/iu

// The same, or the repo's own page: `https://github.com/acme/app`, which
// is what npm fills `homepage` in with from `repository`. Query and
// fragment off first: npm's own convention hangs `#readme` on the end of
// exactly these URLs.
const homepageRepoRegex = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(?<repo>[\w-]+\/[\w.-]+?)(?:\.git)?(?:\/|\/tree\/[^/]+\/.+)?$/iu

const homepageUrl = (homepage) => (typeof homepage === 'string' ? homepage.trim().split(/[?#]/u)[0] : '')

function homepageRepo(homepage) {
  return homepageRepoRegex.exec(homepageUrl(homepage))?.groups.repo
}

// One path segment of a directory inside a repo. `.` and `..` are
// excluded by the leading class — a segment has to start with something
// that is not a dot — because this value is spliced into a github.com
// URL, and a traversal in it points at a path the package was never in.
const segmentRegex = /^[\w-][\w.-]*$/u

function repoSubdirectory(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().replace(/^(?:\.\/|\/)+/u, '').replace(/\/+$/u, '')
  if (!trimmed) return undefined
  const segments = trimmed.split('/')
  return segments.every((segment) => segmentRegex.test(segment)) ? segments.join('/') : undefined
}

// Where in the repo the package's own code sits — what makes a link to a
// monorepo package land on the package instead of on a tree of hundreds
// of them. Packages spell it two ways:
//
//   "repository": { "url": "…/babel.git", "directory": "packages/babel-core" }
//   "homepage":   "https://github.com/…/libraries/tree/main/diff"
//
// npm's `directory` first, it being the field meant for this; the
// homepage's `/tree/<ref>/<path>` after, for the packages that never set
// `directory` and say it there instead — `@preventive/diff` does exactly
// that. A package at the repo root has neither and gets nothing:
// `directory` is ABSENT at the root rather than empty.
//
// Either source is read only where it is talking about the repo that was
// resolved. `repository.directory` is a path inside the repo
// `repository.url` names, and a homepage path one inside the repo in its
// own URL, so where either names something else it is dropped rather
// than spliced into a link it was never a path in.
function repoDirectory(repository, homepage, github) {
  const declared = repositoryRepo(repository)
  if (declared === undefined || declared === github) {
    const directory = repoSubdirectory(typeof repository === 'string' ? undefined : repository?.directory)
    if (directory) return directory
  }
  const tree = homepageTreeRegex.exec(homepageUrl(homepage))
  if (!tree || tree.groups.repo.toLowerCase() !== github.toLowerCase()) return undefined
  return repoSubdirectory(tree.groups.directory)
}

// A `directory` as repoDirectory answers one: empty for the repo root.
export const isRepoDirectory = (value) => typeof value === 'string' && (value === '' || repoSubdirectory(value) === value)

// `{ github?, directory?, url? }` for a package.json, or the registry's
// document for a version of one: `github` is `owner/name`, `directory`
// where in that repo the package sits, absent at its root, and `url` the
// repo's page. All absent where nothing in it names a GitHub repo.
//
// The tracker first, because most packages carry one and npm fills it
// in; `repository` after, spelled any of the ways above, for the ones
// that point `bugs` at a site of their own; the homepage last, for a
// package that names its repo nowhere else. Whichever answers has to be
// `owner/name` by GitHub's own rules too — the patterns above are looser
// about owners, and a `..` for a name would be a traversal in every link
// made from it.
export function getRepo(pkg) {
  assert.ok(pkg !== null && typeof pkg === 'object' && !Array.isArray(pkg), 'getRepo: expected a package.json object')
  const { bugs, homepage, repository } = pkg
  const github = [bugsRepo(bugs), repositoryRepo(repository), homepageRepo(homepage)].find(isRepo)
  if (github === undefined) return {}
  const directory = repoDirectory(repository, homepage, github)
  return { github, ...(directory && { directory }), url: `https://github.com/${github}` }
}

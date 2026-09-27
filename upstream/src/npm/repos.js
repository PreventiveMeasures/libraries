import assert from 'node:assert/strict'

import { assertBoolean, assertOptional, assertOptions, assertPackageName, assertRepo, isRepo } from '../args.js'
import { readCacheJSON, writeCacheJSON } from '../cache.js'
import { NPM_REGISTRY, buildUrl, request } from '../http.js'
import { githubRepoOfUrl } from '../remote.js'

// Which GitHub repo a published npm package's code lives in, and where in
// that repo the package sits — the lookup, and the disk cache that keeps a
// caller from asking twice.

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

// The three fields of a package's registry document that can name a
// repo. `latest` rather than the full packument: this is metadata about
// the project, not about a version, and the full document is megabytes
// of version history to answer a one-line question.
async function getShortInfo(name) {
  const json = await request(buildUrl(NPM_REGISTRY, [...name.split('/'), 'latest']), { as: 'json' })
  assert.ok(json?.name === name, `getGitHub: the registry answered for ${json?.name}, not ${name}`)
  const { bugs, homepage, repository } = json
  return { bugs, homepage, repository }
}

// `owner/name` off the issue tracker, which is the field that names the
// repo outright: `bugs.url` is the repo's `/issues` page, so dropping
// that suffix IS the repo — but only when the link is a GitHub one and
// only when it really carried the suffix, since a tracker somewhere
// else answers a different question. Undefined rather than a throw when
// it doesn't hold: the shorthand below gets its turn. Read on its own:
// the tracker names the repo whether or not a homepage is set.
function bugsRepo(bugs) {
  if (typeof bugs?.url !== 'string') return undefined
  const issues = bugs.url.replace(/^http:/u, 'https:')
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
function repoDirectory(repository, homepage, repo) {
  const declared = repositoryRepo(repository)
  if (declared === undefined || declared === repo) {
    const directory = repoSubdirectory(typeof repository === 'string' ? undefined : repository?.directory)
    if (directory) return directory
  }
  const tree = homepageTreeRegex.exec(homepageUrl(homepage))
  if (!tree || tree.groups.repo.toLowerCase() !== repo.toLowerCase()) return undefined
  return repoSubdirectory(tree.groups.directory)
}

// The tracker first, because most packages carry one and npm fills it
// in; `repository` after, spelled any of the ways above, for the ones
// that point `bugs` at a site of their own; the homepage last, for a
// package that names its repo nowhere else. Whichever answers has to be
// `owner/name` by GitHub's own rules too — the patterns above are looser
// about owners, and a `..` for a name would be a traversal in every link
// made from it.
export async function getGitHub(name) {
  assertPackageName('getGitHub', 'name', name)
  const { bugs, homepage, repository } = await getShortInfo(name)
  const repo = [bugsRepo(bugs), repositoryRepo(repository), homepageRepo(homepage)].find(isRepo)
  assert.ok(repo, `getGitHub: no GitHub repo for ${name}`)
  // Absent rather than undefined at the repo root.
  const directory = repoDirectory(repository, homepage, repo)
  return { repo, ...(directory && { directory }), url: `https://github.com/${repo}` }
}

// The answer above, kept on disk between runs, when setCacheDir has named
// a place for it: one `<name>.json` per package under npm/repos.
//
// It is one registry request per package, for something that barely
// moves: which repo a published package's metadata points at. A caller
// resolving a middling dependency tree spends hundreds of them
// re-reading what its last run already read, and one that cannot reach
// the network cannot spend them at all.
const DIR = 'npm/repos'

// A month. The link is published metadata rather than a fact about an
// install, so it goes stale only when a package is transferred or its
// repo renamed — and a renamed GitHub repo still resolves through the
// redirect, which makes a month-old answer a working link rather than a
// wrong one.
const TTL_MS = 30 * 24 * 60 * 60 * 1000

// The stored `{ repo, directory }`, or null for anything that is not
// one: no cache, no entry, a stale entry, a half-written file, an entry
// from an older or a future format. Every answer but a usable record is
// a miss, which costs a request — or, for a caller that cannot make one,
// the link.
//
// `directory` has to be a STRING, empty for a package at the repo root,
// and an entry without the key at all is one written before the field
// existed. That distinction is the whole reason it is written
// unconditionally: read leniently, an old entry would answer with a repo
// and no directory, and every monorepo package would quietly link to the
// root of its repo for a month rather than simply being looked up again.
//
// Held to the formats a lookup answers in, so what comes off disk is no
// less checked than what came off the registry.
const isDirectory = (value) => typeof value === 'string' && (value === '' || repoSubdirectory(value) === value)

export async function readPackageRepoCache(name) {
  assertPackageName('readPackageRepoCache', 'name', name)
  const entry = await readCacheJSON(DIR, `${name}.json`)
  if (!entry || typeof entry !== 'object' || typeof entry.at !== 'number') return null
  if (Date.now() - entry.at > TTL_MS) return null
  if (entry.name !== name || !isRepo(entry.repo) || !isDirectory(entry.directory)) return null
  return { repo: entry.repo, ...(entry.directory && { directory: entry.directory }) }
}

// Only a RESOLVED slug is ever passed here. A lookup that failed is not
// an answer: a 404, a rate limit, a network blip and a package that has
// simply not published a repo link all fail the same way, and filing
// that as a result would turn a minute of registry trouble into a month
// of packages with no link on them. False where the cache could not be
// written; never a throw.
export async function writePackageRepoCache(name, repo, directory = '') {
  assertPackageName('writePackageRepoCache', 'name', name)
  assertRepo('writePackageRepoCache', 'repo', repo)
  assert.ok(isDirectory(directory), `writePackageRepoCache: directory must be a path inside the repository, got ${JSON.stringify(directory)}`)
  return await writeCacheJSON(DIR, `${name}.json`, { at: Date.now(), name, repo, directory })
}

// Best-effort npm → GitHub repo lookup for a set of package names.
// Returns `{ github }` for each one, or `{ github, directory }` for a
// package published out of a monorepo. Fail-soft: a package without a
// resolvable npm/GitHub link is just absent from the map.
//
// Disk first, for every name, before anything is asked of the registry:
// the answer barely moves (see the cache above) and one run's package
// set overlaps the last run's almost entirely. `cachedOnly` stops there:
// the cache is the whole lookup, and a name it does not hold goes
// without a link rather than reaching for the network.
//
// Only a resolved slug is written back, because only that is an answer;
// see writePackageRepoCache on why a failure is not cached. A name that
// is not one is not a lookup that failed, though: every name is checked
// before anything is read, and one bad one throws for the lot.
export async function resolvePackageRepos(packageNames, options = {}) {
  assert.ok(typeof packageNames?.[Symbol.iterator] === 'function' && typeof packageNames !== 'string', 'resolvePackageRepos: packageNames must be an iterable of names')
  assertOptions('resolvePackageRepos', 'options', options, ['cachedOnly'])
  assertOptional(assertBoolean, 'resolvePackageRepos', 'cachedOnly', options.cachedOnly)
  const names = [...new Set(packageNames)]
  for (const name of names) assertPackageName('resolvePackageRepos', 'name', name)
  const repos = new Map()
  const stamp = (github, directory) => ({ github, ...(directory && { directory }) })
  await Promise.all(names.map(async (name) => {
    const stored = await readPackageRepoCache(name)
    if (stored) {
      repos.set(name, stamp(stored.repo, stored.directory))
      return
    }
    if (options.cachedOnly) return
    try {
      const { repo, directory } = await getGitHub(name)
      repos.set(name, stamp(repo, directory))
      await writePackageRepoCache(name, repo, directory)
    } catch {
      // Fail-soft per the comment above: a package that resolves to no
      // repo is simply absent from the map.
    }
  }))
  return repos
}

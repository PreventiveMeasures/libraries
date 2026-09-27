import assert from 'node:assert/strict'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { cacheDir } from '../cache.js'
import { REGISTRY, assertPackageName } from './registry.js'

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
  assertPackageName(name)
  const res = await fetch(`${REGISTRY}/${name}/latest`)
  assert.ok(res.ok, `Failed to fetch ${name} from npm: ${res.status}`)
  const json = await res.json()
  assert.equal(json.name, name)
  const { bugs, homepage, repository } = json
  return { name, bugs, homepage, repository }
}

// `owner/name` off the issue tracker, which is the field that names the
// repo outright: `bugs.url` is the repo's `/issues` page, so dropping
// that suffix IS the repo — but only when the link is a GitHub one and
// only when it really carried the suffix, since a tracker somewhere
// else answers a different question. Undefined rather than a throw when
// it doesn't hold: the shorthand below gets its turn.
function bugsRepo(bugs, homepage) {
  if (!bugs?.url || !homepage) return undefined
  const issues = String(bugs.url).replace(/^http:/u, 'https:')
  const url = issues.replace(/\/issues$/u, '')
  //if (homepage !== `${url}#readme`) return undefined
  if (issues !== `${url}/issues` || !githubRegex.test(url)) return undefined
  return url.replace('https://github.com/', '')
}

// The same repo spelled as a URL, which is what most packages carry:
// `git+https://github.com/acme/widget.git`, `git://github.com/…`, a
// plain `https://github.com/…`, `git+ssh://git@github.com/…`, and the
// scp-like `git@github.com:acme/widget.git`. A `.git` suffix and a
// trailing slash are npm's noise rather than part of the name.
//
// `github.com` has to be the HOST here, not a path segment or the start
// of a longer name: the scheme and the optional `user@` are matched
// explicitly, so neither `https://evil.example/github.com/a/b` nor
// `https://github.com.evil.example/a/b` can pass for a GitHub URL and
// point the package at a repo it never came from.
const gitUrlRegex = /^(?:git\+)?(?:https?|git|ssh):\/\/(?:[^@/]*@)?github\.com\/(?<repo>[\w-]+\/[\w.-]+?)(?:\.git)?\/?$/u
const scpRegex = /^(?:git\+ssh:\/\/)?git@github\.com:(?<repo>[\w-]+\/[\w.-]+?)(?:\.git)?$/u

// `repository` is a string as often as it is `{ url }`, and both spell
// a repo the same three ways. A `directory` beside it (a monorepo's
// subpath) says where in the repo the package lives, not which repo it
// is, so it changes nothing here.
function repositoryRepo(repository) {
  const url = typeof repository === 'string' ? repository : repository?.url
  if (typeof url !== 'string') return undefined
  return (shorthandRegex.exec(url) ?? gitUrlRegex.exec(url) ?? scpRegex.exec(url))?.groups.repo
}

// A `homepage` that points INTO the repo, which is where a package that
// never set `repository.directory` still says where it lives:
// `https://github.com/PreventiveMeasures/libraries/tree/main/diff`. The
// ref is one segment, so a branch with a `/` in its name would read as
// part of the path — homepage refs are `main` / `master` / `HEAD` in
// practice, and there is nothing in the URL that could tell the two
// apart anyway.
const homepageTreeRegex = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(?<repo>[\w-]+\/[\w.-]+)\/tree\/[^/]+\/(?<directory>.+)$/iu

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
  // Query and fragment off first: npm's own convention hangs `#readme`
  // on the end of exactly these URLs.
  const tree = typeof homepage === 'string' ? homepageTreeRegex.exec(homepage.trim().split(/[?#]/u)[0]) : null
  if (!tree || tree.groups.repo.toLowerCase() !== repo.toLowerCase()) return undefined
  return repoSubdirectory(tree.groups.directory)
}

// The tracker first, because most packages carry one and npm fills it
// in; the `repository` shorthand for the ones that point `homepage` and
// `bugs` at a site of their own.
export async function getGitHub(name) {
  const { bugs, homepage, repository } = await getShortInfo(name)
  const repo = bugsRepo(bugs, homepage) ?? repositoryRepo(repository)
  assert.ok(repo, `No GitHub repo for ${name}`)
  // Absent rather than undefined at the repo root.
  const directory = repoDirectory(repository, homepage, repo)
  return { repo, ...(directory && { directory }), url: `https://github.com/${repo}` }
}

// The answer above, kept on disk between runs, when setCacheDir has named
// a place for it.
//
// It is one registry request per package, for something that barely
// moves: which repo a published package's metadata points at. A caller
// resolving a middling dependency tree spends hundreds of them
// re-reading what its last run already read, and one that cannot reach
// the network cannot spend them at all.
//
// Filed under the registry that answered: what a record means is a
// property of who was asked, so the next thing read from an API of its
// own belongs beside this one rather than in a heap at the cache root. A
// function, not a constant: the cache root is set at startup, which is
// after this module is evaluated. Null while there is no cache.
const dir = () => (cacheDir() === undefined ? null : join(cacheDir(), 'npm', 'repos'))

// A month. The link is published metadata rather than a fact about an
// install, so it goes stale only when a package is transferred or its
// repo renamed — and a renamed GitHub repo still resolves through the
// redirect, which makes a month-old answer a working link rather than a
// wrong one.
const TTL_MS = 30 * 24 * 60 * 60 * 1000

// Through encodeURIComponent: the `/` in a scoped name (`@scope/pkg`)
// would otherwise be a directory, and a name that came from a caller is
// not trusted enough to interpolate into a path as it stands.
const entryPath = (name) => join(dir(), `${encodeURIComponent(name)}.json`)

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
export async function readPackageRepoCache(name) {
  if (dir() === null) return null
  try {
    const entry = JSON.parse(await readFile(entryPath(name), 'utf8'))
    if (!entry || typeof entry !== 'object' || typeof entry.at !== 'number') return null
    if (Date.now() - entry.at > TTL_MS) return null
    if (typeof entry.repo !== 'string' || !entry.repo || typeof entry.directory !== 'string') return null
    return { repo: entry.repo, ...(entry.directory && { directory: entry.directory }) }
  } catch {
    return null
  }
}

let tmpSeq = 0

// Written through a temp name and renamed into place, so a killed
// process cannot leave a truncated file that a later run would read as
// the repo. A cache that cannot be written at all — none set, a
// read-only directory, a full disk — is a slower next run, not a failed
// one, so nothing here throws.
//
// Only a RESOLVED slug is ever passed here. A lookup that failed is not
// an answer: a 404, a rate limit, a network blip and a package that has
// simply not published a repo link all fail the same way, and filing
// that as a result would turn a minute of registry trouble into a month
// of packages with no link on them.
export async function writePackageRepoCache(name, repo, directory = '') {
  if (dir() === null) return false
  const path = entryPath(name)
  const tmp = `${path}.${process.pid}.${++tmpSeq}.tmp`
  try {
    await mkdir(dir(), { recursive: true })
    await writeFile(tmp, JSON.stringify({ at: Date.now(), name, repo, directory: directory ?? '' }))
    await rename(tmp, path)
  } catch {
    return false
  }
  return true
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
// see writePackageRepoCache on why a failure is not cached.
export async function resolvePackageRepos(packageNames, { cachedOnly = false } = {}) {
  const repos = new Map()
  const stamp = (github, directory) => ({ github, ...(directory && { directory }) })
  await Promise.all([...packageNames].map(async (name) => {
    const stored = await readPackageRepoCache(name)
    if (stored) {
      repos.set(name, stamp(stored.repo, stored.directory))
      return
    }
    if (cachedOnly) return
    try {
      const { repo, directory } = await getGitHub(name)
      if (repo) {
        repos.set(name, stamp(repo, directory))
        await writePackageRepoCache(name, repo, directory)
      }
    } catch {
      // Fail-soft per the comment above: a package that resolves to no
      // repo is simply absent from the map.
    }
  }))
  return repos
}

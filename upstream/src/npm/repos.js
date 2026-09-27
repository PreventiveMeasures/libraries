import assert from 'node:assert/strict'

import { assertBoolean, assertOptional, assertOptions, assertPackageName, assertRepo, isRepo } from '../args.js'
import { readCacheJSON, writeCacheJSON } from '../cache.js'
import { NPM_REGISTRY, buildUrl, request } from '../http.js'
import { getRepo, isRepoDirectory } from '../package.js'

// Which GitHub repo a published npm package's code lives in, and where in
// that repo the package sits — the lookup, and the disk cache that keeps a
// caller from asking twice. What counts as naming a repo is getRepo's
// (src/package.js); this is where the document it reads comes from.

// The three fields of a package's registry document that can name a
// repo. `latest` rather than the full packument: this is metadata about
// the project, not about a version, and the full document is megabytes
// of version history to answer a one-line question.
async function getShortInfo(name) {
  const json = await request(buildUrl(NPM_REGISTRY, [...name.split('/'), 'latest']), { as: 'json' })
  assert.ok(json?.name === name, `getGitHub: the registry answered for ${json?.name}, not ${name}`)
  return json
}

// `{ github, directory?, url }` for a published package, or a throw
// where its metadata names no GitHub repo.
export async function getGitHub(name) {
  assertPackageName('getGitHub', 'name', name)
  const link = getRepo(await getShortInfo(name))
  assert.ok(link.github, `getGitHub: no GitHub repo for ${name}`)
  return link
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

// The stored `{ github, directory }`, or null for anything that is not
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
export async function readPackageRepoCache(name) {
  assertPackageName('readPackageRepoCache', 'name', name)
  const entry = await readCacheJSON(DIR, `${name}.json`)
  if (!entry || typeof entry !== 'object' || typeof entry.at !== 'number') return null
  if (Date.now() - entry.at > TTL_MS) return null
  if (entry.name !== name || !isRepo(entry.github) || !isRepoDirectory(entry.directory)) return null
  return { github: entry.github, ...(entry.directory && { directory: entry.directory }) }
}

// Only a RESOLVED slug is ever passed here. A lookup that failed is not
// an answer: a 404, a rate limit, a network blip and a package that has
// simply not published a repo link all fail the same way, and filing
// that as a result would turn a minute of registry trouble into a month
// of packages with no link on them. False where the cache could not be
// written; never a throw.
export async function writePackageRepoCache(name, github, directory = '') {
  assertPackageName('writePackageRepoCache', 'name', name)
  assertRepo('writePackageRepoCache', 'github', github)
  assert.ok(isRepoDirectory(directory), `writePackageRepoCache: directory must be a path inside the repository, got ${JSON.stringify(directory)}`)
  return await writeCacheJSON(DIR, `${name}.json`, { at: Date.now(), name, github, directory })
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
      repos.set(name, stamp(stored.github, stored.directory))
      return
    }
    if (options.cachedOnly) return
    try {
      const { github, directory } = await getGitHub(name)
      repos.set(name, stamp(github, directory))
      await writePackageRepoCache(name, github, directory)
    } catch {
      // Fail-soft per the comment above: a package that resolves to no
      // repo is simply absent from the map.
    }
  }))
  return repos
}

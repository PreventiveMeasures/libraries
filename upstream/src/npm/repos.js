import assert from 'node:assert/strict'

import { assertArgs, assertBoolean, assertPackageName, assertRepo, isRepo, optional, show } from '../args.js'
import { readCacheJSON, writeCacheJSON } from '../cache.js'
import { NPM_REGISTRY, buildUrl, request } from '../http.js'
import { assertRepoDirectory, getRepo, isRepoDirectory } from '../package.js'
import { pool } from '../pool.js'

const DIR = 'npm/repos'
const TTL_MS = 30 * 24 * 60 * 60 * 1000 // A link only moves on a transfer or rename, and GitHub redirects those.
const CONCURRENCY = 8

export async function getGitHub(name) {
  assertPackageName('getGitHub', 'name', name)
  // `latest`, not the full packument, which is megabytes of version history.
  const json = await request(buildUrl(NPM_REGISTRY, [...name.split('/'), 'latest']), { as: 'json' })
  assert.ok(json?.name === name, `getGitHub: the registry answered for ${show(json?.name)}, not ${name}`)
  const link = getRepo(json)
  assert.ok(link.github, `getGitHub: no GitHub repo for ${name}`)
  return link
}

// An entry without `directory` predates the field: a miss, not a package
// at the repo root.
export async function readPackageRepoCache(name) {
  assertPackageName('readPackageRepoCache', 'name', name)
  const entry = await readCacheJSON(DIR, `${name}.json`)
  const fresh = typeof entry?.at === 'number' && Date.now() - entry.at <= TTL_MS
  if (!fresh || entry.name !== name || !isRepo(entry.github) || !isRepoDirectory(entry.directory)) return null
  return { github: entry.github, ...(entry.directory && { directory: entry.directory }) }
}

// Only resolved repos are cached: a 404, a rate limit and a package with
// no repo link fail alike.
export async function writePackageRepoCache(name, github, directory = '') {
  assertPackageName('writePackageRepoCache', 'name', name)
  assertRepo('writePackageRepoCache', 'github', github)
  assertRepoDirectory('writePackageRepoCache', 'directory', directory)
  return await writeCacheJSON(DIR, `${name}.json`, { at: Date.now(), name, github, directory })
}

export async function resolvePackageRepos(packageNames, options = {}) {
  assert.ok(typeof packageNames?.[Symbol.iterator] === 'function' && typeof packageNames !== 'string', 'resolvePackageRepos: packageNames must be an iterable of names')
  assertArgs('resolvePackageRepos', options, { cachedOnly: optional(assertBoolean) })
  const names = [...new Set(packageNames)]
  for (const name of names) assertPackageName('resolvePackageRepos', 'name', name)
  const repos = new Map()
  const lookUp = async (name) => {
    const stored = await readPackageRepoCache(name)
    if (stored || options.cachedOnly) return stored && repos.set(name, stored)
    const { github, directory } = await getGitHub(name)
    repos.set(name, { github, ...(directory && { directory }) })
    await writePackageRepoCache(name, github, directory)
  }
  await pool(names, CONCURRENCY, (name) => lookUp(name).catch(() => {}))
  return repos
}

import assert from 'node:assert/strict'

import { assertArgs, assertBoolean, assertPackageName, assertRepo, isRepo, optional, show } from '../args.js'
import { readRecord, writeRecord } from '../cache.js'
import { NPM_REGISTRY, buildUrl, isNotFound, recover, request } from '../http.js'
import { assertRepoDirectory, getRepo, isRepoDirectory } from '../package.js'
import { pool } from '../pool.js'

const DIR = 'npm/repos'
const CONCURRENCY = 8

// `latest`, not the full packument, which is megabytes of version history.
async function fetchRepo(method, name) {
  const json = await request(buildUrl(NPM_REGISTRY, [...name.split('/'), 'latest']), { as: 'json' })
  assert.ok(json?.name === name, `${method}: the registry answered for ${show(json?.name)}, not ${name}`)
  return getRepo(json)
}

export async function getGitHub(name) {
  assertPackageName('getGitHub', 'name', name)
  const link = await fetchRepo('getGitHub', name)
  assert.ok(link.github, `getGitHub: no GitHub repo for ${name}`)
  return link
}

// An entry without `directory` predates the field: a miss, not a package
// at the repo root.
export async function readPackageRepoCache(name) {
  assertPackageName('readPackageRepoCache', 'name', name)
  const entry = await readRecord(DIR, name)
  if (!isRepo(entry?.github) || !isRepoDirectory(entry.directory)) return null
  return { github: entry.github, ...(entry.directory && { directory: entry.directory }) }
}

// Only resolved repos are cached: a 404, a rate limit and a package with
// no repo link fail alike.
export async function writePackageRepoCache(name, github, directory = '') {
  assertPackageName('writePackageRepoCache', 'name', name)
  assertRepo('writePackageRepoCache', 'github', github)
  assertRepoDirectory('writePackageRepoCache', 'directory', directory)
  return await writeRecord(DIR, name, { github, directory })
}

export async function resolvePackageRepos(packageNames, options = {}) {
  assert.ok(typeof packageNames?.[Symbol.iterator] === 'function' && typeof packageNames !== 'string', 'resolvePackageRepos: packageNames must be an iterable of names')
  assertArgs('resolvePackageRepos', options, { cachedOnly: optional(assertBoolean) })
  const names = [...new Set(packageNames)]
  for (const name of names) assertPackageName('resolvePackageRepos', 'name', name)
  const found = await pool(names, CONCURRENCY, (name) => (options.cachedOnly ? readPackageRepoCache(name) : lookUpPackageRepo(name)).catch(() => null))
  return new Map(names.flatMap((name, i) => (found[i] ? [[name, found[i]]] : [])))
}

// Through the cache. Null for a package the registry does not have, or
// one naming no GitHub repo; any other failure throws.
export async function lookUpPackageRepo(name) {
  const stored = await readPackageRepoCache(name)
  if (stored) return stored
  const { github, directory } = await fetchRepo('lookUpPackageRepo', name).catch(recover(isNotFound, {}))
  if (!github) return null
  await writePackageRepoCache(name, github, directory)
  return { github, ...(directory && { directory }) }
}

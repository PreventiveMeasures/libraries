import assert from 'node:assert/strict'

import { assertNames, assertPackageName, assertRepo, isRepo } from '../args.js'
import { readRecord, writeRecord } from '../cache.js'
import { isNotFound, recover } from '../http.js'
import { assertRepoDirectory, getRepo, isRepoDirectory } from '../package.js'
import { pool } from '../pool.js'
import { getDocument } from './registry.js'

const DIR = 'npm/repos'
const CONCURRENCY = 8
// Stamped on each entry, and raised when getRepo would answer differently:
// 2 is `repository` taking precedence over `bugs`; 3 the shorthand dropping
// a `.git`, URLs read past whitespace, and `repository.directory`'s `\` read
// as `/`.
const VERSION = 3

// A slug a lookup gives: getRepo answers no repo ending in `.git`, the
// suffix it drops (withoutDotGit; `.GIT` it keeps, and so does this).
const isLookedUpRepo = (github) => isRepo(github) && !github.endsWith('.git')

// `latest`, not the full packument, which is megabytes of version history.
const fetchRepo = async (method, name) => getRepo(await getDocument(method, name, 'latest'))

export async function getGitHub(name) {
  assertPackageName('getGitHub', 'name', name)
  const link = await fetchRepo('getGitHub', name)
  assert.ok(link.github, `getGitHub: no GitHub repo for ${name}`)
  return link
}

// An entry under another VERSION was resolved by other rules, and may
// name a repo getRepo no longer would (a stale tracker's, or a shorthand's
// with its `.git`): a miss, as is one naming a repo or a directory no
// lookup gives, or without `directory`, which would read as a package at
// the repo root.
export async function readPackageRepoCache(name) {
  assertPackageName('readPackageRepoCache', 'name', name)
  const entry = await readRecord(DIR, name)
  if (entry?.v !== VERSION || !isLookedUpRepo(entry.github) || !isRepoDirectory(entry.directory)) return null
  return { github: entry.github, ...(entry.directory && { directory: entry.directory }) }
}

// Only resolved repos are cached: a 404, a rate limit and a package with
// no repo link fail alike.
export async function writePackageRepoCache(name, github, directory = '') {
  assertPackageName('writePackageRepoCache', 'name', name)
  assertRepo('writePackageRepoCache', 'github', github)
  assertRepoDirectory('writePackageRepoCache', 'directory', directory)
  return await writeRecord(DIR, name, { v: VERSION, github, directory })
}

export async function resolvePackageRepos(packageNames, options = {}) {
  const names = assertNames('resolvePackageRepos', 'packageNames', packageNames, options, assertPackageName)
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

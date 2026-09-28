import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'

import { isRepo, show } from '../args.js'
import { readCacheJSON, writeCacheJSON } from '../cache.js'
import { CRATES_API, HttpError, PACKAGIST_REPO, buildUrl, request } from '../http.js'
import { lookUpPackageRepo } from '../npm/repos.js'
import { pool } from '../pool.js'
import { githubRepoOfUrl } from '../remote.js'

const TTL_MS = 30 * 24 * 60 * 60 * 1000
const CRATES_PER_REQUEST = 100
const CRATES_PACE_MS = 1000 // crates.io asks for a request a second at most, and a user agent.
const USER_AGENT = '@preventive/upstream (https://github.com/PreventiveMeasures/libraries)'
const PACKAGES_AT_ONCE = 8

// Name → its GitHub repo, or null where the registry has no such package
// or it names no GitHub repo; any other failure throws. Only a repo found
// is cached, for a month.
async function cachedRepos(dir, names, fetchMissing) {
  const repos = new Map()
  for (const name of names) {
    const entry = await readCacheJSON(dir, `${name}.json`)
    const age = typeof entry?.at === 'number' ? Date.now() - entry.at : Number.NaN
    if (age >= 0 && age <= TTL_MS && entry.name === name && isRepo(entry.github)) repos.set(name, entry.github)
  }
  const missing = names.filter((name) => !repos.has(name))
  for (const [name, github] of await fetchMissing(missing)) {
    repos.set(name, github)
    if (github) await writeCacheJSON(dir, `${name}.json`, { at: Date.now(), name, github })
  }
  return repos
}

// A crate crates.io leaves out of its answer is one it does not have.
async function fetchCrates(names) {
  const found = new Map(names.map((name) => [name, null]))
  for (let i = 0; i < names.length; i += CRATES_PER_REQUEST) {
    if (i > 0) await sleep(CRATES_PACE_MS)
    const chunk = names.slice(i, i + CRATES_PER_REQUEST)
    const url = buildUrl(CRATES_API, ['api', 'v1', 'crates'], { 'ids[]': chunk, per_page: CRATES_PER_REQUEST })
    const answer = await request(url, { as: 'json', headers: { 'User-Agent': USER_AGENT } })
    assert.ok(Array.isArray(answer?.crates), 'advisories: expected a list of crates from crates.io')
    for (const crate of answer.crates) {
      assert.ok(chunk.includes(crate?.id), `advisories: crates.io answered for ${show(crate?.id)}, which was not asked`)
      found.set(crate.id, githubRepoOfUrl(crate.repository) ?? null)
    }
  }
  return found
}

async function fetchEach(names, fetch) {
  const found = await pool(names, PACKAGES_AT_ONCE, fetch)
  return new Map(names.map((name, i) => [name, found[i]]))
}

// The first version in Packagist's file is its latest, in full.
async function fetchComposerRepo(name) {
  const [vendor, pkg] = name.split('/')
  const answer = await request(buildUrl(PACKAGIST_REPO, ['p2', vendor, `${pkg}.json`]), { as: 'json' }).catch((err) => {
    if (err instanceof HttpError && err.status === 404) return null
    throw err
  })
  if (answer === null) return null
  const versions = Object.hasOwn(answer?.packages ?? {}, name) ? answer.packages[name] : undefined
  assert.ok(Array.isArray(versions), `advisories: Packagist answered without ${name}`)
  return githubRepoOfUrl(versions[0]?.source?.url) ?? null
}

export const crateRepos = (names) => cachedRepos('cargo/repos', names, fetchCrates)
export const composerRepos = (names) => cachedRepos('composer/repos', names, (missing) => fetchEach(missing, fetchComposerRepo))
export const npmRepos = (names) => fetchEach(names, async (name) => (await lookUpPackageRepo(name))?.github ?? null)

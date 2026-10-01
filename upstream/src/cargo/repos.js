import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'

import { assertArgs, assertBoolean, assertCrateName, isRepo, optional, show } from '../args.js'
import { readRecord, writeRecord } from '../cache.js'
import { CRATES_API, buildUrl, request } from '../http.js'
import { chunks } from '../pool.js'
import { githubRepoOfUrl } from '../remote.js'

const DIR = 'cargo/repos'
const PER_REQUEST = 100
const PACE_MS = 1000 // crates.io asks for a request a second at most, and a user agent.
const USER_AGENT = '@preventive/upstream (https://github.com/PreventiveMeasures/libraries)'

// One request for up to a hundred crates: each name → the GitHub repo its
// `repository` names, or null where it names none. A crate crates.io
// leaves out of its answer is one it does not have, null too.
async function askCrates(method, names) {
  const url = buildUrl(CRATES_API, ['api', 'v1', 'crates'], { 'ids[]': names, per_page: PER_REQUEST })
  const answer = await request(url, { as: 'json', headers: { 'User-Agent': USER_AGENT } })
  assert.ok(Array.isArray(answer?.crates), `${method}: expected a list of crates from crates.io`)
  const found = new Map(names.map((name) => [name, null]))
  for (const crate of answer.crates) {
    assert.ok(names.includes(crate?.id), `${method}: crates.io answered for ${show(crate?.id)}, which was not asked`)
    found.set(crate.id, githubRepoOfUrl(crate.repository) ?? null)
  }
  return found
}

// Name → its GitHub repo, or null where crates.io has no such crate or it
// names no GitHub repo, through the cache: only a repo found is cached,
// for a month. A failed request throws, or with `soft` leaves its names
// out; `cachedOnly` asks nothing.
export async function lookUpCrateRepos(method, names, { soft = false, cachedOnly = false } = {}) {
  const repos = new Map()
  for (const name of names) {
    const entry = await readRecord(DIR, name)
    if (isRepo(entry?.github)) repos.set(name, entry.github)
  }
  if (cachedOnly) return repos
  for (const [i, chunk] of chunks(names.filter((name) => !repos.has(name)), PER_REQUEST).entries()) {
    if (i > 0) await sleep(PACE_MS)
    const answer = await askCrates(method, chunk).catch((error) => {
      if (soft) return new Map()
      throw error
    })
    for (const [name, github] of answer) {
      repos.set(name, github)
      if (github) await writeRecord(DIR, name, { github })
    }
  }
  return repos
}

export async function resolveCrateRepos(crateNames, options = {}) {
  assert.ok(typeof crateNames?.[Symbol.iterator] === 'function' && typeof crateNames !== 'string', 'resolveCrateRepos: crateNames must be an iterable of names')
  assertArgs('resolveCrateRepos', options, { cachedOnly: optional(assertBoolean) })
  const names = [...new Set(crateNames)]
  for (const name of names) assertCrateName('resolveCrateRepos', 'name', name)
  const repos = await lookUpCrateRepos('resolveCrateRepos', names, { soft: true, cachedOnly: options.cachedOnly })
  return new Map(names.flatMap((name) => (repos.get(name) ? [[name, { github: repos.get(name) }]] : [])))
}

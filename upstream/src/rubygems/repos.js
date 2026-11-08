import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'

import { show } from '../args.js'
import { addRepos, readRepos } from '../cache.js'
import { RUBYGEMS, buildUrl, isNotFound, recover, request } from '../http.js'
import { pool } from '../pool.js'
import { githubRepoOfUrl } from '../remote.js'

const DIR = 'rubygems/repos'
const GEMS_AT_ONCE = 4
const PACE_MS = 100 // rubygems.org's API takes 10 requests a second from one address.

// When the next request may start: one every PACE_MS, whichever call asks.
let nextAt = 0
async function paced() {
  const now = Date.now()
  const at = Math.max(now, nextAt)
  nextAt = at + PACE_MS
  if (at > now) await sleep(at - now)
}

// A page in a repository's tree, as a gem's link often is (rails'
// https://github.com/rails/rails/tree/v8.1.4.1/actionpack), names that
// repository.
const TREE_PAGE = /^(?<repo>(?i:https?:\/\/github\.com)\/[\w-]+\/[\w.-]+)\/(?:tree|blob)\//u
const repoOfLink = (url) => githubRepoOfUrl(url) ?? githubRepoOfUrl(TREE_PAGE.exec(typeof url === 'string' ? url : '')?.groups.repo)

// The GitHub repo a gem names: its `source_code_uri`, the gemspec's
// metadata's or else what its owners set on rubygems.org, then its
// `homepage_uri`, each a repository's URL or a page in its tree. Null
// where it names none, or rubygems.org has no such gem.
async function fetchGemRepo(method, name) {
  await paced()
  const answer = await request(buildUrl(RUBYGEMS, ['api', 'v1', 'gems', `${name}.json`]), { as: 'json' }).catch(recover(isNotFound, null))
  if (answer === null) return null
  assert.ok(answer?.name === name, `${method}: rubygems.org answered for ${show(answer?.name)}, not ${name}`)
  return [answer.source_code_uri, answer.homepage_uri].map(repoOfLink).find((repo) => repo !== undefined) ?? null
}

// Name -> its GitHub repo, or null where rubygems.org has no such gem or
// it names no GitHub repo, through the cache, or a `cache` store
// (readRecord): only a repo found is kept, for a month. A failed request
// throws.
export async function lookUpGemRepos(method, names, { cache } = {}) {
  const repos = await readRepos(DIR, names, cache)
  const missing = names.filter((name) => !repos.has(name))
  const found = await pool(missing, GEMS_AT_ONCE, (name) => fetchGemRepo(method, name))
  await addRepos(DIR, repos, new Map(missing.map((name, i) => [name, found[i]])), cache)
  return repos
}
